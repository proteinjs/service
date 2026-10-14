import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import { DECLARED_READ_HEADER, IDEMPOTENCY_KEY_HEADER, SERIALIZED_RETURN_MEDIA_TYPE } from '../src/ServiceClient';
import { InProcessReadCoalescer } from '../src/ReadCoalescer';
import { InProcessIdempotencyLedger } from '../src/IdempotencyLedger';

/**
 * The server's half of the declared-read class: identical reads from one caller that arrive while
 * one is RUNNING share that run. Read as OUTCOMES through the real router: how many times the
 * method ran, what each answer carried, and what the seat holds afterwards.
 *
 * The invariant under test (see `InProcessReadCoalescer`): an entry lives exactly while its run is
 * in flight — a call arriving after settlement runs anew, a failed run is served to no one who
 * arrives after it failed; a joined caller gets exactly what the runner gets, a value or a
 * rejection; only a declared read joins, and only one from the same caller with the same method and
 * arguments; a write never coalesces.
 */

type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor } };
type ExecutorStatics = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  readCoalescer: InProcessReadCoalescer;
};
type ExecutorInternals = { logger: Logger };

const SERVICE_PATH = '/service/@test/test/TestService/doThing';

/** A service whose runs are held open until the test releases them, in the order they began, counting them. */
const heldService = () => {
  let runs = 0;
  const held: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const service = {
    serviceMetadata: { auth: { public: true } },
    doThing: async (arg: string) => {
      runs++;
      const run = runs;
      return new Promise<string>((resolve, reject) => {
        held.push({ resolve: (value) => resolve(`${value} ${arg} #${run}`), reject });
      });
    },
  } as unknown as Service;
  return {
    service,
    runs: () => runs,
    release: (value = 'read') => held.shift()!.resolve(value),
    fail: (error: Error) => held.shift()!.reject(error),
  };
};

const createRouter = (service: Service) => {
  const returnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;
  const method = new Method('doThing', returnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const router = new ServiceRouter();
  const executor = new ServiceExecutor(service, _interface, method);
  const entries: Log[] = [];
  (executor as unknown as ExecutorInternals).logger = new Logger({
    name: 'TestService.doThing',
    logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
  });
  (router as unknown as RouterInternals).serviceExecutorMap = { [SERVICE_PATH]: executor };
  return { router, entries };
};

type Sent = { status?: number; type?: string; body?: any };

/** One request to the router, as a server reads it (header names lower-cased); the answer as sent. */
const request = (
  router: ServiceRouter,
  args: any[],
  options: { declaredRead?: boolean; key?: string; requestId?: string } = {}
): Promise<Sent> => {
  const sent: Sent = {};
  const response: any = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    type(mediaType: string) {
      sent.type = mediaType;
      return response;
    },
    send(body: any) {
      sent.body = body;
      return response;
    },
    getHeader: () => options.requestId,
  };
  const headers: { [name: string]: string } = { accept: SERIALIZED_RETURN_MEDIA_TYPE };
  if (options.declaredRead) {
    headers[DECLARED_READ_HEADER.toLowerCase()] = 'true';
  }
  if (options.key !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] = options.key;
  }
  return router.onRequest({ path: SERVICE_PATH, body: Serializer.serialize(args), headers }, response).then(() => sent);
};

const setCaller = (email: string) => {
  (ServiceExecutor as unknown as ExecutorStatics).userRepo = { getUser: () => ({ email, roles: [] }) };
};

const seat = () => (ServiceExecutor as unknown as ExecutorStatics).readCoalescer;

/** Lets the executor reach the held method (its awaits before the call) before the test moves on. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const answer = (sent: Sent) => Serializer.deserialize(sent.body);

describe('two identical declared reads from one caller, the second while the first runs', () => {
  beforeEach(() => {
    setCaller('reader@test.local');
    (ServiceExecutor as unknown as ExecutorStatics).readCoalescer = new InProcessReadCoalescer();
  });
  afterEach(() => {
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = undefined;
  });

  it('run the method once and both receive the one answer; the seat is empty once it settled', async () => {
    const held = heldService();
    const { router, entries } = createRouter(held.service);

    const first = request(router, ['doc'], { declaredRead: true });
    await settle();
    const second = request(router, ['doc'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(1);
    expect(seat().size).toBe(1);

    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(answer(a)).toBe('read doc #1');
    expect(answer(b)).toBe('read doc #1');
    expect(held.runs()).toBe(1);
    expect(seat().size).toBe(0);

    // The run's own lines and the joined delivery's, told apart by the flag.
    const returning = entries.filter((entry) => entry.message === 'Returning');
    expect(returning.map((entry) => entry.obj.coalesced)).toEqual([false, true]);
    expect(returning[1].obj.bytes).toBe(Buffer.byteLength(a.body, 'utf8'));
    expect(entries.find((entry) => entry.message === 'Calling (joined a run in flight)')?.obj.coalesced).toBe(true);
  });

  it('a redelivery of an abandoned read joins the run still going: one run, the redelivery gets its answer', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    // The first delivery: the client abandoned it, the server runs it to the end regardless.
    const abandoned = request(router, ['doc'], { declaredRead: true });
    await settle();
    const redelivery = request(router, ['doc'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(1);

    held.release();
    expect(answer(await redelivery)).toBe('read doc #1');
    expect(answer(await abandoned)).toBe('read doc #1');
    expect(held.runs()).toBe(1);
  });

  it('a call arriving after the run settled runs the method anew — no result is kept', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const first = request(router, ['doc'], { declaredRead: true });
    await settle();
    held.release();
    expect(answer(await first)).toBe('read doc #1');
    expect(seat().size).toBe(0);

    const later = request(router, ['doc'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(2);
    held.release();
    expect(answer(await later)).toBe('read doc #2');
  });

  it('a failed run: the joined caller gets the same failure, the seat is empty, and a later call runs anew', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const first = request(router, ['doc'], { declaredRead: true });
    await settle();
    const joined = request(router, ['doc'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(1);

    held.fail(new Error('the read failed'));
    const [a, b] = await Promise.all([first, joined]);
    expect(a).toMatchObject({ status: 400, body: { error: 'the read failed' } });
    expect(b).toMatchObject({ status: 400, body: { error: 'the read failed' } });
    expect(seat().size).toBe(0);

    const later = request(router, ['doc'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(2);
    held.release();
    expect(answer(await later)).toBe('read doc #2');
  });
});

describe('what never joins', () => {
  beforeEach(() => {
    setCaller('reader@test.local');
    (ServiceExecutor as unknown as ExecutorStatics).readCoalescer = new InProcessReadCoalescer();
    ServiceExecutor.setIdempotencyLedger(new InProcessIdempotencyLedger());
  });
  afterEach(() => {
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = undefined;
    ServiceExecutor.setIdempotencyLedger(new InProcessIdempotencyLedger());
  });

  it('the same read from another caller runs on its own', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const first = request(router, ['doc'], { declaredRead: true });
    await settle();
    setCaller('other@test.local');
    const other = request(router, ['doc'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(2);
    expect(seat().size).toBe(2);

    held.release();
    held.release();
    const [a, b] = await Promise.all([first, other]);
    expect(answer(a)).toBe('read doc #1');
    expect(answer(b)).toBe('read doc #2');
    expect(seat().size).toBe(0);
  });

  it('a read of other arguments runs on its own', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const first = request(router, ['doc-a'], { declaredRead: true });
    await settle();
    const other = request(router, ['doc-b'], { declaredRead: true });
    await settle();
    expect(held.runs()).toBe(2);

    held.release();
    held.release();
    await Promise.all([first, other]);
  });

  it('an undeclared call with the same arguments never joins a read: it runs', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const read = request(router, ['doc'], { declaredRead: true });
    await settle();
    const undeclared = request(router, ['doc']);
    await settle();
    expect(held.runs()).toBe(2);
    expect(seat().size).toBe(1);

    held.release();
    held.release();
    await Promise.all([read, undeclared]);
  });

  it('a write never coalesces: two identical undeclared calls are two runs', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const first = request(router, ['row']);
    await settle();
    const second = request(router, ['row']);
    await settle();
    expect(held.runs()).toBe(2);
    expect(seat().size).toBe(0);

    held.release('wrote');
    held.release('wrote');
    const [a, b] = await Promise.all([first, second]);
    expect(answer(a)).toBe('wrote row #1');
    expect(answer(b)).toBe('wrote row #2');
  });

  it('a keyed write takes the ledger, not the seat: a replay is answered from the record, a different key runs', async () => {
    const held = heldService();
    const { router } = createRouter(held.service);

    const first = request(router, ['row'], { key: 'key-1' });
    await settle();
    const replay = request(router, ['row'], { key: 'key-1' });
    const other = request(router, ['row'], { key: 'key-2' });
    await settle();
    expect(held.runs()).toBe(2);
    expect(seat().size).toBe(0);

    held.release('wrote');
    held.release('wrote');
    const [a, b, c] = await Promise.all([first, replay, other]);
    expect(answer(a)).toBe('wrote row #1');
    expect(answer(b)).toBe('wrote row #1');
    expect(answer(c)).toBe('wrote row #2');
  });
});
