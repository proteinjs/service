/**
 * A REFUSAL IS NOT A FAILURE. A service operation that refuses on purpose — "File <id> is not
 * available to anyone but its owner" — was logged at ERROR by the executor, once per look, exactly
 * like a crash, and answered 400 whatever it meant. A `ServiceRefusal` carries its own status
 * (400 / 403 / 404 / 409): the router answers with that status and the same `{ error }` body, and
 * the executor logs it at WARN with the status and the operation's name — never the arguments.
 * Every other thrown error keeps ERROR + 400.
 *
 * Asserted through the router's front door (the status and body a client receives) and the
 * executor's log writer (the level and fields of every entry the call wrote).
 */
import { Interface, Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import { ServiceRefusal, ServiceRefusalStatus } from '../src/ServiceRefusal';

type RouterInternals = {
  serviceExecutorMap: { [path: string]: ServiceExecutor };
};

type ExecutorInternals = {
  logger: Logger;
};

const SERVICE_PATH = '/service/@test/test/TestService/readFile';
const SECRET_ARG = 'file-id-in-args-51c2';

/** A router whose one executor runs `readFile`, which throws `thrown`; every log entry the call writes is captured. */
const routerThrowing = (thrown: unknown) => {
  const service = {
    serviceMetadata: { auth: { public: true } },
    readFile: async (_fileId: string) => {
      throw thrown;
    },
  } as unknown as Service;
  const method = new Method('readFile', undefined, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const executor = new ServiceExecutor(service, _interface, method);
  const entries: Log[] = [];
  (executor as unknown as ExecutorInternals).logger = new Logger({
    name: 'TestService.readFile',
    logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
  });
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = { [SERVICE_PATH]: executor };
  return { router, entries };
};

/** One call through the router: what the client receives. */
const call = async (router: ServiceRouter) => {
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
  await router.onRequest({ path: SERVICE_PATH, body: Serializer.serialize([SECRET_ARG]) }, response);
  return sent;
};

const entryText = (entry: Log) => JSON.stringify({ ...entry, error: entry.error?.message });

describe('a refusal is answered with its own status', () => {
  it.each([400, 403, 404, 409] as ServiceRefusalStatus[])(
    'a %s refusal reaches the client as that status, in the same { error } body',
    async (status) => {
      const { router } = routerThrowing(new ServiceRefusal(status, `File f-1 is not available (${status})`));

      const sent = await call(router);

      expect(sent.status).toBe(status);
      expect(sent.body).toEqual({ error: `File f-1 is not available (${status})` });
    }
  );

  it('a refusal thrown through another copy of the package (read by its shape) is answered the same', async () => {
    const fromAnotherCopy = Object.assign(new Error('File f-2 is not available to anyone but its owner'), {
      name: 'ServiceRefusal',
      status: 404,
    });
    const { router } = routerThrowing(fromAnotherCopy);

    const sent = await call(router);

    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: 'File f-2 is not available to anyone but its owner' });
  });
});

describe('a refusal is logged at WARN, never as a failure', () => {
  it('one WARN entry with the status and the operation name; no ERROR entry; no argument anywhere', async () => {
    // A refusal names what it refused — here the argument itself, as a file door's does.
    const { router, entries } = routerThrowing(new ServiceRefusal(404, `File ${SECRET_ARG} is not available`));

    const sent = await call(router);

    expect(sent.body).toEqual({ error: `File ${SECRET_ARG} is not available` });

    expect(entries.filter((entry) => entry.logLevel === 'error')).toEqual([]);
    const warnings = entries.filter((entry) => entry.logLevel === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].obj?.functionName).toBe('TestService.readFile');
    expect(warnings[0].obj?.status).toBe(404);
    expect(warnings[0].obj?.requestId).toMatch(/^[0-9a-f]{8}$/);
    for (const entry of entries) {
      expect(entryText(entry)).not.toContain(SECRET_ARG);
    }
  });
});

describe('everything else stays a failure', () => {
  it('a status outside the refusal statuses is a failure: ERROR, and answered 400', async () => {
    const notARefusal = Object.assign(new Error('upstream exploded'), { name: 'ServiceRefusal', status: 500 });
    const { router, entries } = routerThrowing(notARefusal);

    const sent = await call(router);

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'upstream exploded' });
    expect(entries.filter((entry) => entry.logLevel === 'error')).toHaveLength(1);
    expect(entries.filter((entry) => entry.logLevel === 'warn')).toEqual([]);
  });

  it('a plain thrown error: ERROR, and answered 400 with its message', async () => {
    const { router, entries } = routerThrowing(new Error('File f-4 is not available'));

    const sent = await call(router);

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'File f-4 is not available' });
    expect(entries.filter((entry) => entry.logLevel === 'error')).toHaveLength(1);
    expect(entries.filter((entry) => entry.logLevel === 'warn')).toEqual([]);
  });
});
