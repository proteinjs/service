import { Interface, Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceError, ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';

type RouterInternals = {
  serviceExecutorMap: { [path: string]: ServiceExecutor };
};

type ExecutorInternals = {
  logger: Logger;
};

const createExecutor = (service: Service, methodName: string) => {
  const method = new Method(methodName, undefined, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  return new ServiceExecutor(service, _interface, method);
};

const createRouter = (servicePath: string, executor: ServiceExecutor) => {
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = { [servicePath]: executor };
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

describe('service error transport', () => {
  it('preserves the thrown message on the wire when a service method fails', async () => {
    const service = {
      serviceMetadata: { auth: { public: true } },
      doThing: async () => {
        throw new Error('Release blocked: workspace has uncommitted changes');
      },
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    await router.onRequest(
      { path: '/service/@test/test/TestService/doThing', body: Serializer.serialize([]) },
      response
    );

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'Release blocked: workspace has uncommitted changes' });
  });

  it('preserves non-Error throws as their string form', async () => {
    const service = {
      serviceMetadata: { auth: { public: true } },
      doThing: async () => {
        throw 'plain string refusal';
      },
    } as unknown as Service;
    const executor = createExecutor(service, 'doThing');

    await expect(executor.execute(Serializer.serialize([]))).rejects.toThrow(new ServiceError('plain string refusal'));
  });

  it('sends the authorization refusal message to the client', async () => {
    const service = {
      serviceMetadata: { auth: { canAccess: () => false } },
      doThing: async () => 'never reached',
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    await router.onRequest(
      { path: '/service/@test/test/TestService/doThing', body: Serializer.serialize([]) },
      response
    );

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'User not authorized to run service: TestService.doThing' });
  });

  it('masks non-ServiceError failures as a 500 internal server error', async () => {
    const service = {
      serviceMetadata: { auth: { public: true } },
      doThing: async () => 'never reached',
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    // malformed request body makes Serializer.deserialize throw outside the executor's service-call catch
    await router.onRequest({ path: '/service/@test/test/TestService/doThing', body: '{not json' }, response);

    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: 'Internal server error' });
  });
});

/**
 * doNotAwait services are dispatched fire-and-forget: the executor invokes the method WITHOUT
 * await (the client response is already decided) and nobody ever awaits the returned promise.
 * The executor is therefore the terminal owner of that promise's rejections — an unobserved
 * rejection is an unhandled promise rejection, and node's default kills the whole server
 * process (the MigrationRunner crash class, db 84c6d425).
 */
describe('doNotAwait dispatch containment', () => {
  const createCapturingLogger = () => {
    const entries: Log[] = [];
    const logger = new Logger({
      name: 'TestService.doThing',
      logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
    });
    return { logger, entries };
  };

  it('terminally observes a doNotAwait rejection: logged with method identity, never unhandled', async () => {
    const service = {
      serviceMetadata: { auth: { public: true }, doNotAwait: true },
      doThing: async () => {
        throw new Error('detached failure after the client response');
      },
    } as unknown as Service;
    const executor = createExecutor(service, 'doThing');
    const { logger, entries } = createCapturingLogger();
    (executor as unknown as ExecutorInternals).logger = logger;

    // The client response does not carry the failure — execute resolves.
    await expect(executor.execute(Serializer.serialize([]))).resolves.toBeUndefined();
    // The detached rejection settles after the microtask queue drains; flush macrotasks so the
    // terminal catch has written its log entry. Pre-fix the rejection instead ESCAPES: jest
    // surfaces it as a test failure here, and outside a test harness it kills the node process
    // (demonstrated red 2026-08-11 via a plain-node harness: exit 1, ERR_UNHANDLED_REJECTION).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const errorEntry = entries.find((entry) => entry.logLevel === 'error');
    expect(errorEntry?.error?.message).toBe('detached failure after the client response');
    expect(errorEntry?.obj?.functionName).toBe('TestService.doThing');
  });

  it('still surfaces a synchronous throw from a doNotAwait method as a ServiceError 400', async () => {
    const service = {
      serviceMetadata: { auth: { public: true }, doNotAwait: true },
      doThing: () => {
        throw new Error('knowable before dispatch');
      },
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    await router.onRequest(
      { path: '/service/@test/test/TestService/doThing', body: Serializer.serialize([]) },
      response
    );

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'knowable before dispatch' });
  });

  it('responds without awaiting the method — the fire-and-forget contract', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let settled = false;
    const service = {
      serviceMetadata: { auth: { public: true }, doNotAwait: true },
      doThing: async () => {
        await gate;
        settled = true;
      },
    } as unknown as Service;
    const executor = createExecutor(service, 'doThing');

    await expect(executor.execute(Serializer.serialize([]))).resolves.toBeUndefined();
    expect(settled).toBe(false);
    release();
    await gate;
  });
});
