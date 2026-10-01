import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import {
  IDEMPOTENCY_KEY_HEADER,
  READ_CONTACT_TIMEOUT_MS,
  REDELIVERY_BASE_MS,
  REDELIVERY_BUDGET,
  REDELIVERY_CAP_MS,
  REDELIVERY_TOTAL_BOUND_MS,
  ServiceClient,
  ServiceMethodRetry,
} from '../src/ServiceClient';
import { ServiceTransportError } from '../src/ServiceTransportError';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';

/**
 * The client's retry policy by class (see ServiceMethodRetry): a declared read is redelivered under
 * a jittered exponential series inside a budget and a total bound; a method declared idempotent is
 * redelivered the same way under one key per call that the server dedupes on; a server's answer of
 * any status is never redelivered; an undeclared method is delivered once. Every outcome below is
 * read off the transport (the requests that left, their bodies, headers and signals) and the call's
 * settlement — with fake timers and the jitter's draw seeded, so every pause is a number.
 */

type ClientInternals = { random: () => number };
type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor } };
type ExecutorStatics = { userRepo?: { getUser: () => { email: string; roles: string[] } } };

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

/** Seeds the jitter: every pause becomes `draw` × its ceiling. */
const seedJitter = (draw: number) => {
  (ServiceClient as unknown as ClientInternals).random = () => draw;
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

const rejectsAtOnce = async () => {
  throw new TypeError('Failed to fetch');
};

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

/** A real router over one executor for `service`, the way the server wires a service method (one that answers a value). */
const createServer = (service: Service): ServiceRouter => {
  const returnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;
  const method = new Method('doThing', returnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = {
    [SERVICE_PATH]: new ServiceExecutor(service, _interface, method),
  };
  return router;
};

/**
 * A transport that hands every request to the server (the body and the headers, lower-cased as a
 * server reads them) and returns the server's answer — except for the first `dropAnswers`
 * requests, whose answer is lost on the way back: the server handled them, the client never heard.
 */
const transportTo = (router: ServiceRouter, dropAnswers: number) =>
  jest.fn(async (request: any) => {
    const headers: { [name: string]: string } = {};
    for (const name of Object.keys(request.init.headers ?? {})) {
      headers[name.toLowerCase()] = request.init.headers[name];
    }
    const sent: { status?: number; body?: any } = {};
    const response: any = {
      status(code: number) {
        sent.status = code;
        return response;
      },
      send(body: any) {
        sent.body = body;
        return response;
      },
    };
    await router.onRequest({ path: request.url, body: request.init.body, headers }, response);
    if (dropAnswers-- > 0) {
      throw new TypeError('Failed to fetch');
    }
    return { status: sent.status ?? 200, statusText: 'OK', json: async () => sent.body };
  });

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a declared read — the backoff series', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    (ServiceClient as unknown as ClientInternals).random = Math.random;
  });

  it('the series: base 1 s doubling to the 4 s cap, three redeliveries, a 45 s bound', () => {
    expect(REDELIVERY_BASE_MS).toBe(1_000);
    expect(REDELIVERY_CAP_MS).toBe(4_000);
    expect(REDELIVERY_BUDGET).toBe(3);
    expect(REDELIVERY_TOTAL_BOUND_MS).toBe(45_000);
    expect(READ_CONTACT_TIMEOUT_MS).toBe(15_000);
  });

  it('rejected by the transport twice and answered on the third delivery: the value, three requests, the pauses of the series', async () => {
    seedJitter(0.5); // the pauses: 500 ms, then 1000 ms
    global.fetch = jest
      .fn()
      .mockImplementationOnce(rejectsAtOnce)
      .mockImplementationOnce(rejectsAtOnce)
      .mockImplementationOnce(async () => okResponse()) as any;
    const outcome = track(createClient('read').send('a'));

    await jest.advanceTimersByTimeAsync(499);
    expect(sentRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()).toHaveLength(2);
    expect(sentRequests()[1].init.body).toBe(Serializer.serialize(['a']));

    await jest.advanceTimersByTimeAsync(999);
    expect(sentRequests()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()).toHaveLength(3);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejected on every delivery: four deliveries at the pauses 1 s, 2 s, 4 s (the cap), then the typed error with attempts 4', async () => {
    seedJitter(1); // every pause at its ceiling
    global.fetch = jest.fn(rejectsAtOnce) as any;
    const outcome = track(createClient('read').send('a'));

    await jest.advanceTimersByTimeAsync(999);
    expect(sentRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(sentRequests()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(3_999);
    expect(sentRequests()).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()).toHaveLength(4);
    expect(outcome.state).toBe('rejected');
    expect(ServiceTransportError.isNotReached(outcome.error)).toBe(true);
    expect(outcome.error).toMatchObject({
      reachedServer: false,
      stalled: false,
      attempts: 4,
      servicePath: SERVICE_PATH,
    });
    expect(outcome.error.cause).toBeInstanceOf(TypeError);

    await jest.advanceTimersByTimeAsync(REDELIVERY_TOTAL_BOUND_MS);
    expect(sentRequests()).toHaveLength(4);
  });

  it('stalled on every delivery: three deliveries inside the total bound, then the typed error (stalled, attempts 3) — a fourth never leaves', async () => {
    seedJitter(0.5); // the pauses: 500 ms, 1000 ms, 2000 ms
    global.fetch = neverAnswers() as any;
    const outcome = track(createClient('read').send('a'));

    // The first delivery stalls at the watchdog; the second leaves after the first pause.
    await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS);
    expect(sentRequests()[0].init.signal.aborted).toBe(true);
    expect(sentRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(500);
    expect(sentRequests()).toHaveLength(2);
    expect(sentRequests()[1].init.signal.aborted).toBe(false);

    // The second stalls at 30.5 s; the third leaves at 31.5 s — still inside the bound.
    await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS + 1_000);
    expect(sentRequests()).toHaveLength(3);
    expect(outcome.state).toBe('pending');

    // The third stalls at 46.5 s: past the bound, the call rejects at once — no pause, no fourth.
    await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toMatchObject({ reachedServer: false, stalled: true, attempts: 3 });
    expect(sentRequests()).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(REDELIVERY_TOTAL_BOUND_MS);
    expect(sentRequests()).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the bound is re-checked after the pause: a pause the page slept through (the clock 200 s on when the timer fires) sends nothing more', async () => {
    seedJitter(1); // the first pause: 1 s
    global.fetch = jest.fn(rejectsAtOnce) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(0);
    expect(sentRequests()).toHaveLength(1);
    expect(outcome.state).toBe('pending');

    // The page is suspended during the pause (a phone backgrounded); on resume the wall clock has
    // moved 200 s and the overdue pause timer fires at once.
    jest.setSystemTime(Date.now() + 200_000);
    await jest.advanceTimersByTimeAsync(REDELIVERY_BASE_MS);
    expect(sentRequests()).toHaveLength(1);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toMatchObject({ reachedServer: false, stalled: false, attempts: 1 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the jitter draws the whole pause: a draw of 0 redelivers at once', async () => {
    seedJitter(0);
    global.fetch = jest
      .fn()
      .mockImplementationOnce(rejectsAtOnce)
      .mockImplementationOnce(async () => okResponse()) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(0);
    expect(sentRequests()).toHaveLength(2);
    expect(outcome).toMatchObject({ state: 'resolved', value: 'ok' });
  });

  it('a server verdict is never redelivered: one request, the verdict is the caller’s, at once', async () => {
    global.fetch = jest.fn(async () => verdictResponse()) as any;
    const outcome = track(createClient('read').send('a'));
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error.message).toBe('the server declined');
    expect(ServiceTransportError.is(outcome.error)).toBe(false);
    expect(sentRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(REDELIVERY_TOTAL_BOUND_MS);
    expect(sentRequests()).toHaveLength(1);
  });
});

describe('a method declared idempotent — one key per call, the server runs it once', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = {
      getUser: () => ({ email: 'user@test.local', roles: [] }),
    };
  });
  afterEach(() => {
    jest.useRealTimers();
    (ServiceClient as unknown as ClientInternals).random = Math.random;
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = undefined;
  });

  it('the first answer lost on the way back, the redelivery carries the same key: the method ran once, the client has its value', async () => {
    seedJitter(0.5);
    let runs = 0;
    const router = createServer({
      serviceMetadata: { auth: { public: true } },
      doThing: async (arg: string) => {
        runs++;
        return `wrote ${arg} (#${runs})`;
      },
    } as unknown as Service);
    global.fetch = transportTo(router, 1) as any;

    const outcome = track(createClient({ idempotent: true }).send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_CAP_MS);

    expect(outcome).toMatchObject({ state: 'resolved', value: 'wrote a (#1)' });
    expect(runs).toBe(1);
    expect(sentRequests()).toHaveLength(2);
    const keys = sentRequests().map((request) => request.init.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys[0]).toMatch(UUID_SHAPE);
    expect(keys[1]).toBe(keys[0]);
  });

  it('every call mints its own key', async () => {
    global.fetch = jest.fn(async () => okResponse()) as any;
    const client = createClient({ idempotent: true });
    await client.send('a');
    await client.send('b');
    const keys = sentRequests().map((request) => request.init.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys[0]).toMatch(UUID_SHAPE);
    expect(keys[1]).toMatch(UUID_SHAPE);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a server verdict is never redelivered: one request, the verdict is the caller’s', async () => {
    global.fetch = jest.fn(async () => verdictResponse()) as any;
    const outcome = track(createClient({ idempotent: true }).send('a'));
    await jest.advanceTimersByTimeAsync(REDELIVERY_TOTAL_BOUND_MS);
    expect(outcome.state).toBe('rejected');
    expect(outcome.error.message).toBe('the server declined');
    expect(sentRequests()).toHaveLength(1);
  });

  it('a read carries no key', async () => {
    global.fetch = jest.fn(async () => okResponse()) as any;
    await createClient('read').send('a');
    expect(sentRequests()[0].init.headers[IDEMPOTENCY_KEY_HEADER]).toBeUndefined();
  });

  it('a keyed delivery has no first-contact watchdog by default: a transport that never answers is waited on, not abandoned', async () => {
    global.fetch = neverAnswers() as any;
    const outcome = track(createClient({ idempotent: true }).send('a'));
    await jest.advanceTimersByTimeAsync(20_000);
    expect(outcome.state).toBe('pending');
    expect(sentRequests()).toHaveLength(1);
    expect(sentRequests()[0].init.signal.aborted).toBe(false);
  });

  it('the per-method opt-in: { idempotent: true, contactTimeoutMs } bounds first contact at that number, then redelivers under the same key', async () => {
    seedJitter(0.5); // the first pause: 500 ms
    global.fetch = neverAnswers() as any;
    const outcome = track(createClient({ idempotent: true, contactTimeoutMs: 15_000 }).send('a'));
    await jest.advanceTimersByTimeAsync(15_000 - 1);
    expect(sentRequests()[0].init.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(sentRequests()[0].init.signal.aborted).toBe(true);
    expect(outcome.state).toBe('pending');
    await jest.advanceTimersByTimeAsync(500);
    expect(sentRequests()).toHaveLength(2);
    const keys = sentRequests().map((request) => request.init.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys[1]).toBe(keys[0]);
    expect(outcome.state).toBe('pending');
  });
});

describe('a method not declared', () => {
  it('a write is delivered once: the transport’s rejection is the caller’s, typed, nothing redelivered', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn(rejectsAtOnce) as any;
      const outcome = track(createClient().send('a'));
      await jest.advanceTimersByTimeAsync(REDELIVERY_TOTAL_BOUND_MS);
      expect(outcome.state).toBe('rejected');
      expect(outcome.error).toMatchObject({ reachedServer: false, stalled: false, attempts: 1 });
      expect(sentRequests()).toHaveLength(1);
      expect(sentRequests()[0].init.headers[IDEMPOTENCY_KEY_HEADER]).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
