import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import {
  IDEMPOTENCY_KEY_HEADER,
  REDELIVERY_CAP_MS,
  RESPONSE_BODY_TIMEOUT_MS,
  ServiceClient,
  ServiceMethodRetry,
} from '../src/ServiceClient';
import { ServiceTransportError } from '../src/ServiceTransportError';

/**
 * The response's body is read under its own bound, on the same abort signal as the request: a
 * connection that dies or stops carrying bytes AFTER the headers is a transport failure of the
 * body stage — the server answered (its headers prove it handled the call), the answer never
 * arrived — typed `reachedServer: true, answered: false`. A redeliverable method redelivers it
 * (a read is pure; a keyed write replays under its key); an undeclared method surfaces it once.
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

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  json: async () => ({ serializedReturn: Serializer.serialize('ok') }),
});

/** Headers at once; a body that never finishes — its read settles only when the request's signal aborts. */
const headersThenHangingBody = (request: any) =>
  Promise.resolve({
    status: 200,
    statusText: 'OK',
    json: () =>
      new Promise((unused, reject) => {
        request.init.signal?.addEventListener('abort', () => reject(abortError()));
      }),
  });

/** Headers at once; the connection dies under the body. */
const headersThenDeadBody = () =>
  Promise.resolve({
    status: 200,
    statusText: 'OK',
    json: async () => {
      throw new TypeError('Load failed');
    },
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

describe('the body bound', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (ServiceClient as unknown as ClientInternals).random = () => 0.5;
  });
  afterEach(() => {
    jest.useRealTimers();
    (ServiceClient as unknown as ClientInternals).random = Math.random;
  });

  it('is its own clock: 30 s from the headers', () => {
    expect(RESPONSE_BODY_TIMEOUT_MS).toBe(30_000);
  });

  it('a declared read whose body never arrives: abandoned at the bound, redelivered as a fresh request, the value from the redelivery', async () => {
    global.fetch = jest.fn().mockImplementationOnce(headersThenHangingBody).mockImplementationOnce(okResponse) as any;
    const outcome = track(createClient('read').send('a'));

    await jest.advanceTimersByTimeAsync(RESPONSE_BODY_TIMEOUT_MS - 1);
    expect(outcome.state).toBe('pending');
    expect(sentRequests()).toHaveLength(1);
    expect(sentRequests()[0].init.signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()[0].init.signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(sentRequests()).toHaveLength(2);
    expect(sentRequests()[1].init.body).toBe(Serializer.serialize(['a']));
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('an undeclared method whose body never arrives: the typed error at the bound — reached the server, not answered, stalled — surfaced once', async () => {
    global.fetch = jest.fn(headersThenHangingBody) as any;
    const outcome = track(createClient().send('a'));

    await jest.advanceTimersByTimeAsync(RESPONSE_BODY_TIMEOUT_MS);
    expect(outcome.state).toBe('rejected');
    expect(ServiceTransportError.is(outcome.error)).toBe(true);
    expect(outcome.error).toMatchObject({
      reachedServer: true,
      answered: false,
      stalled: true,
      attempts: 1,
      servicePath: SERVICE_PATH,
    });
    expect(ServiceTransportError.isNotReached(outcome.error)).toBe(false);
    expect(sentRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(RESPONSE_BODY_TIMEOUT_MS);
    expect(sentRequests()).toHaveLength(1);
  });

  it('a declared read whose body dies under it: redelivered at once as a fresh request', async () => {
    global.fetch = jest.fn().mockImplementationOnce(headersThenDeadBody).mockImplementationOnce(okResponse) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(sentRequests()).toHaveLength(2);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
  });

  it('an undeclared method whose body dies under it: the typed error with the cause, once', async () => {
    global.fetch = jest.fn(headersThenDeadBody) as any;
    const outcome = track(createClient().send('a'));
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toMatchObject({ reachedServer: true, answered: false, stalled: false, attempts: 1 });
    expect(outcome.error.cause).toBeInstanceOf(TypeError);
    expect(sentRequests()).toHaveLength(1);
  });

  it('a keyed write whose body never arrives: redelivered under the same key', async () => {
    global.fetch = jest.fn().mockImplementationOnce(headersThenHangingBody).mockImplementationOnce(okResponse) as any;
    const outcome = track(createClient({ idempotent: true }).send('a'));
    await jest.advanceTimersByTimeAsync(RESPONSE_BODY_TIMEOUT_MS + REDELIVERY_CAP_MS);
    expect(sentRequests()).toHaveLength(2);
    const keys = sentRequests().map((request) => request.init.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys[1]).toBe(keys[0]);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
  });

  it('a body answered inside the bound resolves and leaves no timer behind', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        json: () =>
          new Promise((resolve) => setTimeout(() => resolve({ serializedReturn: Serializer.serialize('ok') }), 100)),
      })
    ) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(100);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a 200 whose body is not JSON stays what it was: the parse error, not a transport error', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      })
    ) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(SyntaxError);
    expect(sentRequests()).toHaveLength(1);
  });
});

describe('the typed error’s shape', () => {
  it('an answer lost after the headers: reachedServer true, answered false; an instance from another copy without the field is still one', () => {
    const lost = ServiceTransportError.answerLost(SERVICE_PATH, { stalled: true, boundMs: 30_000 });
    expect(lost).toMatchObject({ reachedServer: true, answered: false, stalled: true, attempts: 1 });
    expect(ServiceTransportError.is(lost)).toBe(true);
    expect(ServiceTransportError.isNotReached(lost)).toBe(false);
    const older = Object.assign(new Error('no response'), { name: 'ServiceTransportError', reachedServer: false });
    expect(ServiceTransportError.is(older)).toBe(true);
  });
});
