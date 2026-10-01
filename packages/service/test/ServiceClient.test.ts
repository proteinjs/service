import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { KEEPALIVE_BUDGET_BYTES, ServiceClient } from '../src/ServiceClient';
import { ServiceTransportError } from '../src/ServiceTransportError';

// Node's Request rejects the relative service paths a browser resolves against the page origin
beforeAll(() => {
  global.Request = class {
    constructor(
      public url: string,
      public init: any
    ) {}
  } as any;
});

const createClient = () => {
  const method = new Method('doThing', undefined, true, false, false, false, 'public', []);
  return new ServiceClient('/service/@test/test/TestService/doThing', method);
};

const stubFetch = (response: { status: number; statusText: string; body?: any; json?: () => Promise<any> }) => {
  const json = response.json ?? (async () => response.body);
  global.fetch = jest.fn(async () => ({ status: response.status, statusText: response.statusText, json })) as any;
};

describe('ServiceClient error parsing', () => {
  it('throws the server message from the response body on non-200 responses', async () => {
    stubFetch({
      status: 400,
      statusText: 'Bad Request',
      body: { error: 'Release blocked: workspace has uncommitted changes' },
    });

    await expect(createClient().send()).rejects.toThrow('Release blocked: workspace has uncommitted changes');
  });

  it('falls back to statusText when the body carries no message (older servers)', async () => {
    stubFetch({ status: 400, statusText: 'Bad Request', body: {} });

    await expect(createClient().send()).rejects.toThrow(
      'Failed to process service request: /service/@test/test/TestService/doThing, error: Bad Request'
    );
  });

  it('falls back to statusText when the body is not JSON', async () => {
    stubFetch({
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(createClient().send()).rejects.toThrow(
      'Failed to process service request: /service/@test/test/TestService/doThing, error: Bad Gateway'
    );
  });

  it('returns the deserialized value on 200 responses', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });

    await expect(createClient().send()).resolves.toBe('ok');
  });
});

describe('ServiceClient request-init provider (keepalive)', () => {
  const sentInits = (): any[] => (global.fetch as jest.Mock).mock.calls.map(([request]) => request.init);

  afterEach(() => ServiceClient.setRequestInitProvider(undefined));

  it('sends no keepalive when no provider is set', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    await createClient().send('a');
    expect(sentInits()[0].keepalive).toBeUndefined();
  });

  it('marks the request keepalive when the provider says so, consulted with the path and body size', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    const provider = jest.fn(() => ({ keepalive: true }));
    ServiceClient.setRequestInitProvider(provider);
    await createClient().send('a');
    expect(sentInits()[0].keepalive).toBe(true);
    expect(provider).toHaveBeenCalledWith({
      servicePath: '/service/@test/test/TestService/doThing',
      bodyBytes: Serializer.serialize(['a']).length,
    });
  });

  it('bodyBytes is the UTF-8 byte length of the body — what the browser counts against its keepalive cap — not its code-unit length', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    const provider = jest.fn(() => ({ keepalive: false }));
    ServiceClient.setRequestInitProvider(provider);
    const arg = 'café — naïve 😀 日本語';
    await createClient().send(arg);
    const body = Serializer.serialize([arg]);
    // The premise: this body is longer in bytes than in UTF-16 code units.
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
    expect(provider).toHaveBeenCalledWith({
      servicePath: '/service/@test/test/TestService/doThing',
      bodyBytes: Buffer.byteLength(body, 'utf8'),
    });
  });

  it('the provider never overrides the reserved init (method, body, credentials, headers)', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    ServiceClient.setRequestInitProvider(() => ({ keepalive: true, method: 'GET', credentials: 'omit' }) as any);
    await createClient().send('a');
    const init = sentInits()[0];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(Serializer.serialize(['a']));
  });

  it('a keepalive request the transport rejects leaves exactly one request on the wire: the typed error, nothing re-sent', async () => {
    // "Load failed" is what a dying connection throws — the same TypeError as the browser's cap
    // refusal. A re-send here would be a second delivery of a request the server may have handled.
    global.fetch = jest.fn(async () => {
      throw new TypeError('Load failed');
    }) as any;
    ServiceClient.setRequestInitProvider(() => ({ keepalive: true }));
    const error = await createClient()
      .send('a')
      .catch((caught: unknown) => caught);
    expect(ServiceTransportError.is(error)).toBe(true);
    expect(error).toMatchObject({ reachedServer: false, attempts: 1 });
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(sentInits()[0].keepalive).toBe(true);
  });

  it('the keepalive budget is the browser’s in-flight cap: 64 KiB', () => {
    expect(KEEPALIVE_BUDGET_BYTES).toBe(64 * 1024);
  });

  it('a body over the budget is sent once, without keepalive — the browser would refuse it and the write would be lost', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    ServiceClient.setRequestInitProvider(() => ({ keepalive: true }));
    const large = 'x'.repeat(KEEPALIVE_BUDGET_BYTES);
    await expect(createClient().send(large)).resolves.toBe('ok');
    expect(sentInits()).toHaveLength(1);
    expect(sentInits()[0].keepalive).toBeUndefined();
    expect(sentInits()[0].body).toBe(Serializer.serialize([large]));
  });

  it('the budget counts the client’s own keepalive bytes in flight: a request that would overrun it goes without keepalive, and the room comes back when one settles', async () => {
    const pending: Array<(response: any) => void> = [];
    global.fetch = jest.fn(() => new Promise((resolve) => pending.push(resolve))) as any;
    ServiceClient.setRequestInitProvider(() => ({ keepalive: true }));
    const okResponse = () => ({
      status: 200,
      statusText: 'OK',
      json: async () => ({ serializedReturn: Serializer.serialize('ok') }),
    });
    // Two bodies of 40 KiB: the first fits; the second would put 80 KiB in flight.
    const body = 'y'.repeat(40 * 1024);
    const first = createClient().send(body);
    const second = createClient().send(body);
    await Promise.resolve();
    expect(sentInits()).toHaveLength(2);
    expect(sentInits()[0].keepalive).toBe(true);
    expect(sentInits()[1].keepalive).toBeUndefined();

    // The first settles: its bytes leave the count, and a third request of the same size fits again.
    pending[0](okResponse());
    await expect(first).resolves.toBe('ok');
    const third = createClient().send(body);
    await Promise.resolve();
    expect(sentInits()).toHaveLength(3);
    expect(sentInits()[2].keepalive).toBe(true);

    pending[1](okResponse());
    pending[2](okResponse());
    await expect(second).resolves.toBe('ok');
    await expect(third).resolves.toBe('ok');
  });

  it('a network failure on an ordinary request is the caller’s — never re-sent', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as any;
    await expect(createClient().send('a')).rejects.toThrow('Failed to fetch');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('the slot is one per page: a provider set through one module copy is read by another', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    ServiceClient.setRequestInitProvider(() => ({ keepalive: true }));
    let OtherCopy: typeof ServiceClient | undefined;
    jest.isolateModules(() => {
      // A second live copy of the module (a nested install) — same page, same slot.
      OtherCopy = require('../src/ServiceClient').ServiceClient;
    });
    expect(OtherCopy).toBeDefined();
    expect(OtherCopy).not.toBe(ServiceClient);
    const method = new Method('doThing', undefined, true, false, false, false, 'public', []);
    await new OtherCopy!('/service/@test/test/TestService/doThing', method).send('a');
    expect(sentInits()[0].keepalive).toBe(true);
  });
});
