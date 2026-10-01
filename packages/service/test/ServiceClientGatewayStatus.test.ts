import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { IDEMPOTENCY_KEY_HEADER, REDELIVERY_CAP_MS, ServiceClient, ServiceMethodRetry } from '../src/ServiceClient';
import { ServiceTransportError } from '../src/ServiceTransportError';

/**
 * A 502, 503 or 504 whose body is not the router's JSON shape (`{ error: <message> }`) came from
 * a proxy in front of the server — a load balancer answering for a backend that did not answer —
 * so no server process handled the request. For a redeliverable method that is a transport
 * failure (reachedServer false, the proxy's status carried), redelivered under the series; an
 * undeclared method keeps the verdict rule and reads the status as the server's answer. The same
 * status with the router's body IS the server's verdict, for every method.
 */

type ClientInternals = { random: () => number };

beforeAll(() => {
  global.Request = class {
    constructor(
      public url: string,
      public init: any
    ) {}
  } as any;
});

const SERVICE_PATH = '/service/@test/test/TestService/doThing';

const createClient = (retry?: ServiceMethodRetry) => {
  const method = new Method('doThing', undefined, true, false, false, false, 'public', []);
  return new ServiceClient(SERVICE_PATH, method, undefined, retry);
};

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  json: async () => ({ serializedReturn: Serializer.serialize('ok') }),
});

/** A proxy's answer: the status, an HTML body. */
const proxyAnswer = (status: number, statusText: string) => async () => ({
  status,
  statusText,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON');
  },
});

/** A proxy's answer that happens to be JSON, but not the router's shape. */
const proxyJsonAnswer = (status: number, statusText: string) => async () => ({
  status,
  statusText,
  json: async () => ({ message: 'upstream connect error' }),
});

/** The server's own answer under that status: the router's `{ error }` body. */
const routerAnswer = (status: number, statusText: string, error: string) => async () => ({
  status,
  statusText,
  json: async () => ({ error }),
});

const sentRequests = (): any[] => (global.fetch as jest.Mock).mock.calls.map(([request]) => request);

const track = (promise: Promise<any>) => {
  const outcome: { state: 'pending' | 'resolved' | 'rejected'; value?: any; error?: any } = { state: 'pending' };
  promise.then(
    (value) => {
      outcome.state = 'resolved';
      outcome.value = value;
    },
    (error) => {
      outcome.state = 'rejected';
      outcome.error = error;
    }
  );
  return outcome;
};

describe('a proxy answering for the server (502 / 503 / 504, no router body)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (ServiceClient as unknown as ClientInternals).random = () => 0.5;
  });
  afterEach(() => {
    jest.useRealTimers();
    (ServiceClient as unknown as ClientInternals).random = Math.random;
  });

  it('a declared read: a 503 with an HTML body is redelivered; the redelivery answers', async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(proxyAnswer(503, 'Service Unavailable'))
      .mockImplementationOnce(okResponse) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(sentRequests()).toHaveLength(2);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
  });

  it('a declared read: a 502 whose body is JSON but not the router’s is redelivered too', async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(proxyJsonAnswer(502, 'Bad Gateway'))
      .mockImplementationOnce(okResponse) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(sentRequests()).toHaveLength(2);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
  });

  it('a declared read: a 502 carrying the router’s body is the server’s verdict — never redelivered', async () => {
    global.fetch = jest.fn(routerAnswer(502, 'Bad Gateway', 'the upstream the method called is down')) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error.message).toBe('the upstream the method called is down');
    expect(ServiceTransportError.is(outcome.error)).toBe(false);
    expect(sentRequests()).toHaveLength(1);
  });

  it('a declared read: a 500 with an HTML body is a verdict — only 502 / 503 / 504 are a proxy’s', async () => {
    global.fetch = jest.fn(proxyAnswer(500, 'Internal Server Error')) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error.message).toBe(
      `Failed to process service request: ${SERVICE_PATH}, error: Internal Server Error`
    );
    expect(ServiceTransportError.is(outcome.error)).toBe(false);
    expect(sentRequests()).toHaveLength(1);
  });

  it('an undeclared method keeps the verdict rule: a 503 with an HTML body is the caller’s, once', async () => {
    global.fetch = jest.fn(proxyAnswer(503, 'Service Unavailable')) as any;
    const outcome = track(createClient().send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error.message).toBe(
      `Failed to process service request: ${SERVICE_PATH}, error: Service Unavailable`
    );
    expect(ServiceTransportError.is(outcome.error)).toBe(false);
    expect(sentRequests()).toHaveLength(1);
  });

  it('a declared read answered by the proxy on every delivery: four deliveries, then the typed error carrying the status', async () => {
    global.fetch = jest.fn(proxyAnswer(504, 'Gateway Timeout')) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS * 3);
    expect(sentRequests()).toHaveLength(4);
    expect(outcome.state).toBe('rejected');
    expect(ServiceTransportError.isNotReached(outcome.error)).toBe(true);
    expect(outcome.error).toMatchObject({
      reachedServer: false,
      answered: false,
      stalled: false,
      attempts: 4,
      status: 504,
      servicePath: SERVICE_PATH,
    });
  });

  it('a keyed write: a 503 with an HTML body is redelivered under the same key', async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(proxyAnswer(503, 'Service Unavailable'))
      .mockImplementationOnce(okResponse) as any;
    const outcome = track(createClient({ idempotent: true }).send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(sentRequests()).toHaveLength(2);
    const keys = sentRequests().map((request) => request.init.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys[1]).toBe(keys[0]);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
  });
});
