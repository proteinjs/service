import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { READ_CONTACT_TIMEOUT_MS, REDELIVERY_BASE_MS, ServiceClient, ServiceMethodRetry } from '../src/ServiceClient';
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

const verdictResponse = () => ({
  status: 500,
  statusText: 'Internal Server Error',
  json: async () => ({ error: 'the server declined' }),
});

/** A transport that never answers: its promise settles only when the request is abandoned (its signal aborts). */
const neverAnswers = () =>
  jest.fn(
    (request: any) =>
      new Promise((unused, reject) => {
        request.init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        );
      })
  );

const sentRequests = (): any[] => (global.fetch as jest.Mock).mock.calls.map(([request]) => request);

/** The call's outcome, readable without awaiting it — a pending call must read as pending. */
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

describe('the first-contact watchdog — a method declared a read', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a read whose transport never answers is abandoned at the bound and redelivered as a fresh request', async () => {
    global.fetch = neverAnswers() as any;
    const outcome = track(createClient('read').send('a'));

    await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS - 1);
    expect(outcome.state).toBe('pending');
    expect(sentRequests()).toHaveLength(1);
    expect(sentRequests()[0].init.signal.aborted).toBe(false);

    // The bound: the first request is abandoned — and the redelivery is owed, not yet the error.
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()[0].init.signal.aborted).toBe(true);
    expect(outcome.state).toBe('pending');

    // The pause (the series' first, under its base), then a fresh request carrying the same body
    // under its own watchdog. The series' end is ServiceClientRetryPolicy's to pin.
    await jest.advanceTimersByTimeAsync(REDELIVERY_BASE_MS);
    expect(sentRequests()).toHaveLength(2);
    expect(sentRequests()[1]).not.toBe(sentRequests()[0]);
    expect(sentRequests()[1].init.body).toBe(Serializer.serialize(['a']));
    expect(sentRequests()[1].init.signal.aborted).toBe(false);
    expect(outcome.state).toBe('pending');
  });

  it('a read answered inside the bound resolves, and the watchdog is cleared', async () => {
    global.fetch = jest.fn(() => new Promise((resolve) => setTimeout(() => resolve(okResponse()), 100))) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(100);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('a declared read redelivers a transport failure', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rejected by the network once and answered on the redelivery: the value, two requests', async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      })
      .mockImplementationOnce(async () => okResponse()) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_BASE_MS);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
    expect(sentRequests()).toHaveLength(2);
    expect(sentRequests()[1].init.body).toBe(Serializer.serialize(['a']));
  });

  it('a server verdict is never redelivered: one request, the verdict is the caller’s', async () => {
    global.fetch = jest.fn(async () => verdictResponse()) as any;
    await expect(createClient('read').send('a')).rejects.toThrow('the server declined');
    expect(sentRequests()).toHaveLength(1);
  });
});

describe('a method not declared a read', () => {
  it('never redelivers a transport failure: one request, the rejection is the caller’s', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as any;
    await expect(createClient().send('a')).rejects.toThrow('Failed to fetch');
    expect(sentRequests()).toHaveLength(1);
  });

  it('its transport failure is typed: reachedServer false, one attempt, not a stall, the cause kept', async () => {
    const cause = new TypeError('Failed to fetch');
    global.fetch = jest.fn(async () => {
      throw cause;
    }) as any;
    const error = await createClient()
      .send('a')
      .catch((caught: unknown) => caught);
    expect(ServiceTransportError.is(error)).toBe(true);
    expect(error).toMatchObject({
      reachedServer: false,
      stalled: false,
      attempts: 1,
      servicePath: SERVICE_PATH,
      cause,
    });
  });

  it('has no first-contact bound: a call that may be doing long work on the server is never abandoned', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = neverAnswers() as any;
      const outcome = track(createClient().send('a'));
      await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS * 4);
      expect(outcome.state).toBe('pending');
      expect(sentRequests()).toHaveLength(1);
      // The request carries a signal (the body bound arms it once headers arrive), never pulled here.
      expect(sentRequests()[0].init.signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a per-method count keeps its earlier contract: the delivery is retried after any failure, a verdict included', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn(async () => verdictResponse()) as any;
      const outcome = track(createClient(2).send('a'));
      await jest.advanceTimersByTimeAsync(2_000);
      expect(outcome.state).toBe('rejected');
      expect(outcome.error.message).toBe('the server declined');
      expect(sentRequests()).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ServiceTransportError.is reads the shape', () => {
  it('an instance from another copy of this package — the name and the flag — is one', () => {
    const fromAnotherCopy = Object.assign(new Error('no response'), {
      name: 'ServiceTransportError',
      reachedServer: false,
    });
    expect(ServiceTransportError.is(fromAnotherCopy)).toBe(true);
    expect(ServiceTransportError.isNotReached(fromAnotherCopy)).toBe(true);
    expect(ServiceTransportError.is(new Error('ServiceTransportError'))).toBe(false);
    expect(ServiceTransportError.is(undefined)).toBe(false);
  });
});
