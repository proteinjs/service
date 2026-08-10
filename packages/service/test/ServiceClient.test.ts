import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { BACKGROUND_REQUEST_HEADER, ServiceClient } from '../src/ServiceClient';

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

/**
 * The background-request marker (ONE owner of the header, here in the client fetch layer):
 * requests issued inside a `markBackground` scope carry BACKGROUND_REQUEST_HEADER so server-side
 * dev tooling (the serve-package request-activity hold) can tell timer-driven chatter from real
 * user activity. The scope is synchronous by design — sampled at send() entry.
 */
describe('ServiceClient background request marking', () => {
  const sentHeaders = (callIndex = 0) =>
    ((global.fetch as jest.Mock).mock.calls[callIndex][0] as { init: { headers: Record<string, string> } }).init
      .headers;

  beforeEach(() => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
  });

  it('a send issued inside markBackground carries the marker; one outside does not', async () => {
    await ServiceClient.markBackground(() => createClient().send());
    expect(sentHeaders(0)[BACKGROUND_REQUEST_HEADER]).toBe('1');

    await createClient().send();
    expect(sentHeaders(1)[BACKGROUND_REQUEST_HEADER]).toBeUndefined();
  });

  it('the scope ends when the callback returns — later sends are unmarked even while a marked one is in flight', async () => {
    let marked: Promise<any> | undefined;
    ServiceClient.markBackground(() => {
      marked = createClient().send();
    });
    const unmarked = createClient().send();
    await Promise.all([marked, unmarked]);
    expect(sentHeaders(0)[BACKGROUND_REQUEST_HEADER]).toBe('1');
    expect(sentHeaders(1)[BACKGROUND_REQUEST_HEADER]).toBeUndefined();
  });

  it('the scope is released when the callback throws', async () => {
    expect(() =>
      ServiceClient.markBackground(() => {
        throw new Error('tick failed');
      })
    ).toThrow('tick failed');
    await createClient().send();
    expect(sentHeaders(0)[BACKGROUND_REQUEST_HEADER]).toBeUndefined();
  });
});
