import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import { IDEMPOTENCY_KEY_TTL_MS, InProcessIdempotencyLedger } from '../src/IdempotencyLedger';

/**
 * The server's half of the idempotent class: a request carrying an idempotency key runs its method
 * once per (caller, method, key) inside the key's lifetime; a replay — after the run or while it is
 * still in flight — is answered with the recorded result, a value or the failure alike. Read as
 * OUTCOMES through the real router: how many times the method ran, and what each response carried.
 */

type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor } };
type ExecutorStatics = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  idempotencyLedger: InProcessIdempotencyLedger;
};

const SERVICE_PATH = '/service/@test/test/TestService/doThing';

const createRouter = (service: Service) => {
  const returnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;
  const method = new Method('doThing', returnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = {
    [SERVICE_PATH]: new ServiceExecutor(service, _interface, method),
  };
  return router;
};

const createResponse = () => {
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
  return { response, sent };
};

/** One request to the router: the serialized args, and the key as a server reads a header (lower-cased). */
const request = async (router: ServiceRouter, args: any[], key?: string) => {
  const { response, sent } = createResponse();
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

const setCaller = (email: string) => {
  (ServiceExecutor as unknown as ExecutorStatics).userRepo = { getUser: () => ({ email, roles: [] }) };
};

/** A counting service: its answer names the run so two runs are told apart on the wire. */
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

describe('a request carrying an idempotency key', () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    setCaller('user@test.local');
    ServiceExecutor.setIdempotencyLedger(new InProcessIdempotencyLedger(IDEMPOTENCY_KEY_TTL_MS, () => clock));
  });
  afterEach(() => {
    (ServiceExecutor as unknown as ExecutorStatics).userRepo = undefined;
    ServiceExecutor.setIdempotencyLedger(new InProcessIdempotencyLedger());
  });

  it('runs the method once: the replay is answered with the recorded result', async () => {
    const { service, runs } = countingService();
    const router = createRouter(service);

    const first = await request(router, ['a'], 'k1');
    const replay = await request(router, ['a'], 'k1');

    expect(runs()).toBe(1);
    expect(first.body).toEqual({ serializedReturn: Serializer.serialize('a #1') });
    expect(replay.body).toEqual(first.body);
    expect(replay.status).toBeUndefined();
  });

  it('a different key is a different call: the method runs again', async () => {
    const { service, runs } = countingService();
    const router = createRouter(service);
    await request(router, ['a'], 'k1');
    const second = await request(router, ['a'], 'k2');
    expect(runs()).toBe(2);
    expect(second.body).toEqual({ serializedReturn: Serializer.serialize('a #2') });
  });

  it('no key: every request runs the method, as before', async () => {
    const { service, runs } = countingService();
    const router = createRouter(service);
    await request(router, ['a']);
    await request(router, ['a']);
    expect(runs()).toBe(2);
  });

  it('a replay that arrives while the first run is in flight waits for that run: one run, one answer twice', async () => {
    let release!: (value: string) => void;
    let runs = 0;
    const router = createRouter({
      serviceMetadata: { auth: { public: true } },
      doThing: () => {
        runs++;
        return new Promise<string>((resolve) => (release = resolve));
      },
    } as unknown as Service);

    const first = request(router, ['a'], 'k1');
    const replay = request(router, ['a'], 'k1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
    release('done');
    const [firstSent, replaySent] = await Promise.all([first, replay]);
    expect(runs).toBe(1);
    expect(firstSent.body).toEqual({ serializedReturn: Serializer.serialize('done') });
    expect(replaySent.body).toEqual(firstSent.body);
  });

  it('a failed run is replayed as the same failure: one run, the same 400 twice', async () => {
    let runs = 0;
    const router = createRouter({
      serviceMetadata: { auth: { public: true } },
      doThing: async () => {
        runs++;
        throw new Error('the record is locked');
      },
    } as unknown as Service);

    const first = await request(router, ['a'], 'k1');
    const replay = await request(router, ['a'], 'k1');
    expect(runs).toBe(1);
    expect(first).toEqual({ status: 400, body: { error: 'the record is locked' } });
    expect(replay).toEqual(first);
  });

  it('keys are scoped to the caller: another caller’s same key is another call', async () => {
    const { service, runs } = countingService();
    const router = createRouter(service);
    await request(router, ['a'], 'k1');
    setCaller('other@test.local');
    const other = await request(router, ['a'], 'k1');
    expect(runs()).toBe(2);
    expect(other.body).toEqual({ serializedReturn: Serializer.serialize('a #2') });
  });

  it('a key past its lifetime is forgotten: the method runs again', async () => {
    const { service, runs } = countingService();
    const router = createRouter(service);
    await request(router, ['a'], 'k1');
    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    await request(router, ['a'], 'k1');
    expect(runs()).toBe(1);
    clock += 1;
    const late = await request(router, ['a'], 'k1');
    expect(runs()).toBe(2);
    expect(late.body).toEqual({ serializedReturn: Serializer.serialize('a #2') });
  });

  it('the lifetime is two minutes — the client’s whole redelivery series, with its own length to spare', () => {
    expect(IDEMPOTENCY_KEY_TTL_MS).toBe(120_000);
  });
});
