import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { ServiceClient } from '../src/ServiceClient';
import { ClientBuildVersion, CLIENT_BUILD_VERSION_HEADER } from '../src/ClientBuildVersion';

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
 * Every service request declares the caller's build: the one fact a server needs to tell a
 * rollout-in-progress or a stale bundle from a real unknown-path defect (see ServiceRouter). The
 * version is installed once by the app (ClientBuildVersion.set) and attached by the transport
 * itself, so no header provider has to remember it — and none can override it.
 */
describe('ServiceClient client build version header', () => {
  const sentHeaders = () => {
    const request = (global.fetch as jest.Mock).mock.calls[0][0] as { init: { headers: Record<string, string> } };
    return request.init.headers;
  };

  afterEach(() => {
    ClientBuildVersion.set(undefined);
    ServiceClient.setDefaultHeadersProvider(undefined);
  });

  it('attaches x-client-version once the app installed its build version', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    ClientBuildVersion.set('1.27.0');

    await createClient().send();

    expect(sentHeaders()[CLIENT_BUILD_VERSION_HEADER]).toBe('1.27.0');
    expect(sentHeaders()['Content-Type']).toBe('application/json');
  });

  it('sends no version header until one is installed (fail closed, never a placeholder)', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });

    await createClient().send();

    expect(Object.keys(sentHeaders())).not.toContain(CLIENT_BUILD_VERSION_HEADER);
  });

  it('the installed version wins over a default-headers provider that names the same header', async () => {
    stubFetch({ status: 200, statusText: 'OK', body: { serializedReturn: Serializer.serialize('ok') } });
    ClientBuildVersion.set('1.27.0');
    ServiceClient.setDefaultHeadersProvider(() => ({ [CLIENT_BUILD_VERSION_HEADER]: 'spoofed', 'x-other': 'kept' }));

    await createClient().send();

    expect(sentHeaders()[CLIENT_BUILD_VERSION_HEADER]).toBe('1.27.0');
    expect(sentHeaders()['x-other']).toBe('kept');
  });
});
