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
