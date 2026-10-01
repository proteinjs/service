import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { MULTI_PROCESS_ENV, ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import { IdempotencyLedger, IdempotencyScope, InProcessIdempotencyLedger } from '../src/IdempotencyLedger';

/**
 * The in-process idempotency ledger is the scope of ONE server process: a replay that lands on
 * another process finds no record and runs the method again. So a deployment of several processes
 * declares itself (one environment flag, read when the executor loads), and under that declaration
 * the executor REFUSES a keyed request while the registered ledger is still the in-process one —
 * a 501 answer and an error log entry, the method never run — rather than deduplicate by luck.
 * A registered shared ledger lifts the refusal; without the declaration a single process keeps
 * its in-process ledger as before. Read as OUTCOMES through the real router: whether the method
 * ran, what the response carried, what was logged.
 */

type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor } };
type ExecutorInternals = { logger: Logger };
type ExecutorStatics = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  multiProcess: boolean;
};

const SERVICE_PATH = '/service/@test/test/TestService/doThing';

const createRouter = (service: Service, Executor = ServiceExecutor, Router = ServiceRouter) => {
  const returnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;
  const method = new Method('doThing', returnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const executor = new Executor(service, _interface, method);
  const entries: Log[] = [];
  (executor as unknown as ExecutorInternals).logger = new Logger({
    name: 'TestService.doThing',
    logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
  });
  const router = new Router();
  (router as unknown as RouterInternals).serviceExecutorMap = { [SERVICE_PATH]: executor };
  return { router, entries };
};

/** One request to the router: the serialized args, and the key as a server reads a header (lower-cased). */
const request = async (router: ServiceRouter, args: any[], key?: string) => {
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
  await router.onRequest(
    {
      path: SERVICE_PATH,
      body: Serializer.serialize(args),
      headers: key === undefined ? {} : { 'idempotency-key': key },
    },
    response
  );
  return sent;
};

const countingService = () => {
  let runs = 0;
  const service = {
    serviceMetadata: { auth: { public: true } },
    doThing: async (arg: string) => {
      runs++;
      return `${arg} #${runs}`;
    },
  } as unknown as Service;
  return { service, runs: () => runs };
};

/** A ledger that is not the in-process one — the shape a deployment registers for its processes to share. */
class SharedLedgerStub implements IdempotencyLedger {
  readonly seen: IdempotencyScope[] = [];
  once<T>(scope: IdempotencyScope, run: () => Promise<T>): Promise<T> {
    this.seen.push(scope);
    return run();
  }
}

const setMultiProcess = (declared: boolean) => {
  (ServiceExecutor as unknown as ExecutorStatics).multiProcess = declared;
};

describe('a keyed request on a server that declares it runs as one of several processes', () => {
  beforeEach(() => {
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = {
      getUser: () => ({ email: 'user@test.local', roles: [] }),
    };
    ServiceExecutor.setIdempotencyLedger(new InProcessIdempotencyLedger());
  });
  afterEach(() => {
    setMultiProcess(false);
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = undefined;
    ServiceExecutor.setIdempotencyLedger(new InProcessIdempotencyLedger());
  });

  it('with the in-process ledger: refused with a 501 and an error log entry — the method never runs', async () => {
    setMultiProcess(true);
    const { service, runs } = countingService();
    const { router, entries } = createRouter(service);

    const sent = await request(router, ['a'], 'k1');

    expect(runs()).toBe(0);
    expect(sent.status).toBe(501);
    expect(typeof sent.body?.error).toBe('string');
    expect(sent.body.error).toContain('shared idempotency ledger');
    const refused = entries.find((entry) => entry.logLevel === 'error');
    expect(refused?.message).toBe('Refused: keyed call without a shared idempotency ledger');
    expect(refused?.obj).toMatchObject({ functionName: 'TestService.doThing', status: 501 });
  });

  it('without the declaration: the in-process ledger serves as before — the method runs once and the replay is answered', async () => {
    setMultiProcess(false);
    const { service, runs } = countingService();
    const { router } = createRouter(service);

    const first = await request(router, ['a'], 'k1');
    const replay = await request(router, ['a'], 'k1');

    expect(runs()).toBe(1);
    expect(first.body).toEqual({ serializedReturn: Serializer.serialize('a #1') });
    expect(replay.body).toEqual(first.body);
  });

  it('with a registered shared ledger: the keyed request runs once through it', async () => {
    setMultiProcess(true);
    const shared = new SharedLedgerStub();
    ServiceExecutor.setIdempotencyLedger(shared);
    const { service, runs } = countingService();
    const { router, entries } = createRouter(service);

    const sent = await request(router, ['a'], 'k1');

    expect(runs()).toBe(1);
    expect(sent.body).toEqual({ serializedReturn: Serializer.serialize('a #1') });
    expect(shared.seen).toEqual([
      { principal: 'user@test.local', servicePath: '@test/test/TestService.doThing', key: 'k1' },
    ]);
    expect(entries.filter((entry) => entry.logLevel === 'error')).toEqual([]);
  });

  it('an unkeyed request is never refused: it runs whatever the ledger', async () => {
    setMultiProcess(true);
    const { service, runs } = countingService();
    const { router } = createRouter(service);

    const sent = await request(router, ['a']);

    expect(runs()).toBe(1);
    expect(sent.body).toEqual({ serializedReturn: Serializer.serialize('a #1') });
  });

  it('the declaration is one environment flag, read once when the executor loads', async () => {
    const before = process.env[MULTI_PROCESS_ENV];
    process.env[MULTI_PROCESS_ENV] = 'true';
    let Fresh: { ServiceExecutor: typeof ServiceExecutor; ServiceRouter: typeof ServiceRouter } | undefined;
    try {
      jest.isolateModules(() => {
        Fresh = {
          ServiceExecutor: require('../src/ServiceExecutor').ServiceExecutor,
          ServiceRouter: require('../src/ServiceRouter').ServiceRouter,
        };
      });
    } finally {
      if (before === undefined) {
        delete process.env[MULTI_PROCESS_ENV];
      } else {
        process.env[MULTI_PROCESS_ENV] = before;
      }
    }
    expect(Fresh).toBeDefined();
    (Fresh!.ServiceExecutor as unknown as ExecutorStatics).userRepo = {
      getUser: () => ({ email: 'user@test.local', roles: [] }),
    };
    const { service, runs } = countingService();
    const { router } = createRouter(service, Fresh!.ServiceExecutor, Fresh!.ServiceRouter);

    // The flag is gone from the environment by now: the load-time read is what counts.
    const sent = await request(router, ['a'], 'k1');
    expect(runs()).toBe(0);
    expect(sent.status).toBe(501);
  });
});
