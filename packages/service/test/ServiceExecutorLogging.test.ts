/**
 * Service log shape: service args and returns are user content (chat/thought text joined to
 * user identity), and info level is what ships to Cloud Logging — in prod that was ~300k
 * entries/day of full row payloads + user emails, and in dev the same dumps fueled an OOM
 * (8.35M log lines in 43 min). Contract under test:
 *
 *  1. Info-level entries NEVER carry payload contents — not arg values, not return values,
 *     not email-shaped strings — in any environment, under any env flag (the old
 *     DETAILED_SERVICE_LOGS re-route is gone; setting it must change nothing). The summary
 *     envelope stays: functionName, requestId, durationMs, and payload shapes
 *     (types/counts/byte sizes).
 *  2. Full arg/return dumps live at debug, correlated to their info entries by requestId.
 *  3. Failure paths (awaited and doNotAwait-detached) log error entries with the envelope and
 *     the error — no payloads.
 *  4. An expected outcome (ExpectedServiceOutcome: gone, not shared, already done) is a refusal
 *     the service designed for, not a failure: it logs ONE warn entry with the envelope and the
 *     outcome's message, no stack and no error entry, and still crosses the wire as a
 *     ServiceError with the same message.
 */

import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ExpectedServiceOutcome, ServiceError, ServiceExecutor } from '../src/ServiceExecutor';

type ExecutorInternals = {
  logger: Logger;
};

const SECRET_ARG = 'user-chat-text-in-args-7d1f';
const SECRET_EMAIL = 'jane.doe-7d1f@example.com';
const SECRET_RETURN = 'private-thought-content-in-return-9c4e';
const SECRETS = [SECRET_ARG, SECRET_EMAIL, SECRET_RETURN];

// A non-void return type, so the executor's `Returning` (return-payload) path runs.
const stringReturnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;

const createExecutor = (service: Service, methodName: string, logLevel?: 'debug') => {
  const method = new Method(methodName, stringReturnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const executor = new ServiceExecutor(service, _interface, method);
  const entries: Log[] = [];
  const logger = new Logger({
    name: 'TestService.doThing',
    logLevel,
    logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
  });
  (executor as unknown as ExecutorInternals).logger = logger;
  return { executor, entries };
};

/** Run an echoing service call (secrets in args and return) and capture every log entry. */
const runSuccessfulCall = async (logLevel?: 'debug') => {
  const service = {
    serviceMetadata: { auth: { public: true } },
    doThing: async (_message: string, _row: { email: string }) => ({
      email: SECRET_EMAIL,
      content: SECRET_RETURN,
    }),
  } as unknown as Service;
  const { executor, entries } = createExecutor(service, 'doThing', logLevel);
  await executor.execute(Serializer.serialize([SECRET_ARG, { email: SECRET_EMAIL, body: SECRET_ARG }]));
  return entries;
};

/** Run a failing service call (secrets in args) and capture every log entry. */
const runFailingCall = async (logLevel?: 'debug') => {
  const service = {
    serviceMetadata: { auth: { public: true } },
    doThing: async (_message: string, _row: { email: string }) => {
      throw new Error('service failed');
    },
  } as unknown as Service;
  const { executor, entries } = createExecutor(service, 'doThing', logLevel);
  await expect(
    executor.execute(Serializer.serialize([SECRET_ARG, { email: SECRET_EMAIL, body: SECRET_ARG }]))
  ).rejects.toThrow('service failed');
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
  const { executor, entries } = createExecutor(service, 'doThing');
  await executor.execute(Serializer.serialize([SECRET_ARG]));
  // The detached rejection settles after the microtask queue drains; flush macrotasks so the
  // terminal catch has written its log entry.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return entries;
};

const entryText = (entry: Log) => JSON.stringify({ ...entry, error: entry.error?.message });
const textAtLevel = (entries: Log[], logLevel: Log['logLevel']) =>
  entries
    .filter((entry) => entry.logLevel === logLevel)
    .map(entryText)
    .join('\n');

afterEach(() => {
  delete process.env.DETAILED_SERVICE_LOGS;
});

describe('info level: summary envelope only, zero payload contents', () => {
  it('logs no arg/return values and no email-shaped strings on success', async () => {
    const entries = await runSuccessfulCall();
    const infoText = textAtLevel(entries, 'info');
    for (const secret of SECRETS) {
      expect(infoText).not.toContain(secret);
    }
  });

  it('carries the summary envelope: functionName, requestId, durationMs, payload shapes', async () => {
    const entries = await runSuccessfulCall();
    const calling = entries.find((e) => e.message === 'Calling');
    const returning = entries.find((e) => e.message === 'Returning');
    expect(calling?.obj?.functionName).toBe('TestService.doThing');
    expect(calling?.obj?.requestId).toMatch(/^[0-9a-f]{8}$/);
    // Shapes, not contents: one summary per arg (a string and a 2-key object).
    expect(calling?.obj?.args).toEqual([
      expect.stringMatching(/^string\(\d+B\)$/),
      expect.stringMatching(/^Object\(2 keys, \d+B\)$/),
    ]);
    expect(returning?.obj?.functionName).toBe('TestService.doThing');
    expect(returning?.obj?.requestId).toBe(calling?.obj?.requestId);
    expect(typeof returning?.obj?.durationMs).toBe('number');
    expect(returning?.obj?.return).toMatch(/^Object\(2 keys, \d+B\)$/);
  });

  it('no env flag re-routes payloads to info (DETAILED_SERVICE_LOGS is dead)', async () => {
    process.env.DETAILED_SERVICE_LOGS = 'true';
    const entries = await runSuccessfulCall();
    const infoText = textAtLevel(entries, 'info');
    for (const secret of SECRETS) {
      expect(infoText).not.toContain(secret);
    }
  });

  it('info entries stay payload-free even when debug logging is on', async () => {
    const entries = await runSuccessfulCall('debug');
    const infoText = textAtLevel(entries, 'info');
    for (const secret of SECRETS) {
      expect(infoText).not.toContain(secret);
    }
  });
});

describe('debug level: full arg/return dumps, requestId-correlated', () => {
  it('logs arg and return contents at debug', async () => {
    const entries = await runSuccessfulCall('debug');
    const debugText = textAtLevel(entries, 'debug');
    for (const secret of SECRETS) {
      expect(debugText).toContain(secret);
    }
  });

  it('debug dumps share the requestId of their info entries', async () => {
    const entries = await runSuccessfulCall('debug');
    const calling = entries.find((e) => e.message === 'Calling');
    const callingArgs = entries.find((e) => e.message === 'Calling (args)');
    const returningValue = entries.find((e) => e.message === 'Returning (value)');
    expect(callingArgs?.logLevel).toBe('debug');
    expect(returningValue?.logLevel).toBe('debug');
    expect(callingArgs?.obj?.requestId).toBe(calling?.obj?.requestId);
    expect(returningValue?.obj?.requestId).toBe(calling?.obj?.requestId);
  });

  it('at the default level, debug dumps are not written at all', async () => {
    const entries = await runSuccessfulCall();
    expect(entries.filter((e) => e.logLevel === 'debug')).toEqual([]);
  });
});

describe('failure paths: envelope + error, no payloads', () => {
  it('awaited failure: error entry has method identity and the error, no arg contents', async () => {
    const entries = await runFailingCall();
    const errorEntry = entries.find((entry) => entry.logLevel === 'error');
    expect(errorEntry?.error?.message).toBe('service failed');
    expect(errorEntry?.obj?.functionName).toBe('TestService.doThing');
    for (const secret of SECRETS) {
      expect(entryText(errorEntry as Log)).not.toContain(secret);
    }
  });

  it('doNotAwait detached failure: error entry has method identity and the error, no arg contents', async () => {
    const entries = await runDetachedFailingCall();
    const errorEntry = entries.find((entry) => entry.logLevel === 'error');
    expect(errorEntry?.error?.message).toBe('detached failure');
    expect(errorEntry?.obj?.functionName).toBe('TestService.doThing');
    expect(entryText(errorEntry as Log)).not.toContain(SECRET_ARG);
  });

  it('failing call with debug on: args still reach debug (the repro path stays debuggable)', async () => {
    const entries = await runFailingCall('debug');
    expect(textAtLevel(entries, 'debug')).toContain(SECRET_ARG);
    expect(textAtLevel(entries, 'info')).not.toContain(SECRET_ARG);
  });
});

describe('expected outcomes: one warn entry with the envelope, no error entry, the message still crosses', () => {
  const OUTCOME = 'Nothing here is shared with you';

  /** Run a call whose service reports an expected outcome, and capture every log entry. */
  const runRefusedCall = async (outcome: Error, doNotAwait = false) => {
    const service = {
      serviceMetadata: { auth: { public: true }, doNotAwait },
      doThing: async (_message: string) => {
        throw outcome;
      },
    } as unknown as Service;
    const { executor, entries } = createExecutor(service, 'doThing');
    const call = executor.execute(Serializer.serialize([SECRET_ARG]));
    if (doNotAwait) {
      await call;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      await expect(call).rejects.toThrow(new ServiceError(outcome.message));
    }
    return entries;
  };

  it('logs the refusal at warn with the envelope and the outcome, never at error, never a stack', async () => {
    const entries = await runRefusedCall(new ExpectedServiceOutcome(OUTCOME));
    expect(entries.filter((entry) => entry.logLevel === 'error')).toEqual([]);
    const refused = entries.filter((entry) => entry.logLevel === 'warn');
    expect(refused).toHaveLength(1);
    expect(refused[0].message).toBe('Refused');
    expect(refused[0].obj?.functionName).toBe('TestService.doThing');
    expect(refused[0].obj?.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof refused[0].obj?.durationMs).toBe('number');
    expect(refused[0].obj?.outcome).toBe(OUTCOME);
    expect(refused[0].error).toBeUndefined();
    expect(entryText(refused[0])).not.toContain(SECRET_ARG);
  });

  it('recognizes a subclass by its name tag, not its prototype', async () => {
    class NotShared extends ExpectedServiceOutcome {
      constructor() {
        super(OUTCOME);
      }
    }
    const entries = await runRefusedCall(new NotShared());
    expect(entries.filter((entry) => entry.logLevel === 'error')).toEqual([]);
    expect(entries.filter((entry) => entry.logLevel === 'warn').map((entry) => entry.obj?.outcome)).toEqual([OUTCOME]);
  });

  it('a detached (doNotAwait) expected outcome is a warn entry too, marked as after the response', async () => {
    const entries = await runRefusedCall(new ExpectedServiceOutcome(OUTCOME), true);
    expect(entries.filter((entry) => entry.logLevel === 'error')).toEqual([]);
    const refused = entries.filter((entry) => entry.logLevel === 'warn');
    expect(refused).toHaveLength(1);
    expect(refused[0].message).toBe('Refused (doNotAwait, after the client response)');
    expect(refused[0].obj?.outcome).toBe(OUTCOME);
  });

  it('a plain Error is still a failure: an error entry with the stack, no warn entry', async () => {
    const entries = await runFailingCall();
    expect(entries.filter((entry) => entry.logLevel === 'warn')).toEqual([]);
    const failed = entries.filter((entry) => entry.logLevel === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toBe('Failed');
    expect(failed[0].error?.message).toBe('service failed');
  });
});
