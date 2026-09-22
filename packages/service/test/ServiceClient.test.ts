import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { ServiceClient } from '../src/ServiceClient';

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

  it('re-sends once WITHOUT keepalive when the browser refuses the keepalive request (the in-flight cap)', async () => {
    const json = async () => ({ serializedReturn: Serializer.serialize('ok') });
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch: keepalive request exceeds the in-flight limit');
      })
      .mockImplementationOnce(async () => ({ status: 200, statusText: 'OK', json })) as any;
    ServiceClient.setRequestInitProvider(() => ({ keepalive: true }));
    await expect(createClient().send('a')).resolves.toBe('ok');
    const inits = sentInits();
    expect(inits).toHaveLength(2);
    expect(inits[0].keepalive).toBe(true);
    expect(inits[1].keepalive).toBeUndefined();
    expect(inits[1].body).toBe(Serializer.serialize(['a']));
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
