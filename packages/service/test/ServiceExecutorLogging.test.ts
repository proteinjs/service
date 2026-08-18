/**
 * Prod service logs must not carry user content (the log-gate leak): service args and returns
 * are user content — chat/thought text joined to user identity — and with the original gate
 * polarity (`!EnvInfo.isDev() || DETAILED_SERVICE_LOGS`) PROD logged full payloads into Cloud
 * Logging while dev was the quiet one.
 *
 * Contract under test:
 *  1. Prod-shaped env (isDev false, no DETAILED_SERVICE_LOGS): NO payload path survives —
 *     not the success args/return, not the failure args, not the doNotAwait failure args.
 *     The metadata envelope (Calling/Returning/Failed, method identity, error info) stays.
 *  2. Dev keeps the verbose debugging path (args + returns logged).
 *  3. DETAILED_SERVICE_LOGS explicitly set restores verbose logging in prod shape.
 */

// Switchable EnvInfo: these tests exercise both dev- and prod-shaped environments. (The real
// EnvInfo.isDev() needs a GlobalDataStorage implementation that only exists in a running app.)
let mockIsDev = true;
jest.mock('@proteinjs/server-api', () => ({
  EnvInfo: { isDev: () => mockIsDev },
}));

import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';

type ExecutorInternals = {
  logger: Logger;
};

const SECRET_ARG = 'user-chat-text-in-args-7d1f';
const SECRET_RETURN = 'private-thought-content-in-return-9c4e';

// A non-void return type, so the executor's `Returning` (return-payload) path runs.
const stringReturnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;

const createExecutor = (service: Service, methodName: string) => {
  const method = new Method(methodName, stringReturnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  return new ServiceExecutor(service, _interface, method);
};

const createCapturingLogger = () => {
  const entries: Log[] = [];
  const logger = new Logger({
    name: 'TestService.doThing',
    logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
  });
  return { logger, entries };
};

/** Run an echoing service call (SECRET_ARG in, SECRET_RETURN out) and capture every log entry. */
const runSuccessfulCall = async () => {
  const service = {
    serviceMetadata: { auth: { public: true } },
    doThing: async (_message: string) => SECRET_RETURN,
  } as unknown as Service;
  const executor = createExecutor(service, 'doThing');
  const { logger, entries } = createCapturingLogger();
  (executor as unknown as ExecutorInternals).logger = logger;
  await executor.execute(Serializer.serialize([SECRET_ARG]));
  return entries;
};

/** Run a failing service call (SECRET_ARG in) and capture every log entry. */
const runFailingCall = async () => {
  const service = {
    serviceMetadata: { auth: { public: true } },
    doThing: async (_message: string) => {
      throw new Error('service failed');
    },
  } as unknown as Service;
  const executor = createExecutor(service, 'doThing');
  const { logger, entries } = createCapturingLogger();
  (executor as unknown as ExecutorInternals).logger = logger;
  await expect(executor.execute(Serializer.serialize([SECRET_ARG]))).rejects.toThrow('service failed');
  return entries;
};

/** Run a doNotAwait call whose detached promise rejects, and capture every log entry. */
const runDetachedFailingCall = async () => {
  const service = {
    serviceMetadata: { auth: { public: true }, doNotAwait: true },
    doThing: async (_message: string) => {
      throw new Error('detached failure');
    },
  } as unknown as Service;
  const executor = createExecutor(service, 'doThing');
  const { logger, entries } = createCapturingLogger();
  (executor as unknown as ExecutorInternals).logger = logger;
  await executor.execute(Serializer.serialize([SECRET_ARG]));
  // The detached rejection settles after the microtask queue drains; flush macrotasks so the
  // terminal catch has written its log entry.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return entries;
};

const allLoggedText = (entries: Log[]) =>
  entries.map((entry) => JSON.stringify({ ...entry, error: entry.error?.message })).join('\n');

afterEach(() => {
  mockIsDev = true;
  delete process.env.DETAILED_SERVICE_LOGS;
});

describe('prod-shaped env (isDev false, DETAILED_SERVICE_LOGS unset): metadata only', () => {
  beforeEach(() => {
    mockIsDev = false;
    delete process.env.DETAILED_SERVICE_LOGS;
  });

  it('logs NO args and NO return content on success — the envelope stays', async () => {
    const entries = await runSuccessfulCall();
    const logged = allLoggedText(entries);
    expect(logged).not.toContain(SECRET_ARG);
    expect(logged).not.toContain(SECRET_RETURN);
    // The metadata envelope survives: the call and its return are visible with method identity.
    expect(entries.some((e) => e.message === 'Calling' && e.obj?.functionName === 'TestService.doThing')).toBe(true);
    expect(entries.some((e) => e.message === 'Returning' && e.obj?.functionName === 'TestService.doThing')).toBe(true);
  });

  it('logs NO args on failure — error info and method identity stay', async () => {
    const entries = await runFailingCall();
    expect(allLoggedText(entries)).not.toContain(SECRET_ARG);
    const errorEntry = entries.find((entry) => entry.logLevel === 'error');
    expect(errorEntry?.error?.message).toBe('service failed');
    expect(errorEntry?.obj?.functionName).toBe('TestService.doThing');
  });

  it('logs NO args on a doNotAwait detached failure — error info and method identity stay', async () => {
    const entries = await runDetachedFailingCall();
    expect(allLoggedText(entries)).not.toContain(SECRET_ARG);
    const errorEntry = entries.find((entry) => entry.logLevel === 'error');
    expect(errorEntry?.error?.message).toBe('detached failure');
    expect(errorEntry?.obj?.functionName).toBe('TestService.doThing');
  });
});

describe('dev keeps the verbose debugging path', () => {
  beforeEach(() => {
    mockIsDev = true;
    delete process.env.DETAILED_SERVICE_LOGS;
  });

  it('logs args and return content', async () => {
    const entries = await runSuccessfulCall();
    const logged = allLoggedText(entries);
    expect(logged).toContain(SECRET_ARG);
    expect(logged).toContain(SECRET_RETURN);
  });

  it('logs args on failure', async () => {
    const entries = await runFailingCall();
    expect(allLoggedText(entries)).toContain(SECRET_ARG);
  });
});

describe('DETAILED_SERVICE_LOGS explicitly set: verbose logging in prod shape', () => {
  beforeEach(() => {
    mockIsDev = false;
    process.env.DETAILED_SERVICE_LOGS = 'true';
  });

  it('logs args and return content', async () => {
    const entries = await runSuccessfulCall();
    const logged = allLoggedText(entries);
    expect(logged).toContain(SECRET_ARG);
    expect(logged).toContain(SECRET_RETURN);
  });
});
