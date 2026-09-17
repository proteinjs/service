/**
 * The unknown-service-path record. A request for a service path this server does not register
 * is, far more often than a defect, a build skew between the caller and the server: a rollout
 * in progress (the caller's bundle is newer than the pod that answered), a stale tab (older,
 * calling a renamed or removed service), or — the one real defect shape — a client build that
 * calls a service its own server build never registered. Which one it is turns on comparing the
 * caller's declared build version (the `x-client-version` header ServiceClient attaches) with the
 * server's (`ServerBuildVersion`). Contract under test:
 *
 *  1. The response is unchanged: 404 `{ error: 'Unable to find service matching path: <path>' }`.
 *  2. Exactly ONE log entry per unknown path, carrying the facts as `obj`: path, clientVersion,
 *     serverVersion — never only the path.
 *  3. Severity by class: a caller newer or older than the server is WARN (expected, transient or
 *     stale); the same version, or versions that cannot be ordered (absent, not a release
 *     version), is ERROR — the caller declares a service this server build does not register.
 *  4. One fixed message per class, so the record groups by class rather than by path.
 */

import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';

type RouterInternals = {
  serviceExecutorMap: { [path: string]: ServiceExecutor };
  logger: Logger;
  serverBuildVersion: () => string | undefined;
};

const SERVED_PATH = '/service/@test/test/TestService/doThing';
const UNKNOWN_PATH = '/service/@test/test/TestService/renamedElsewhere';

// A non-void return type, so a served call's return crosses the wire (proves the path executed).
const stringReturnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;

const createExecutor = () => {
  const service = { serviceMetadata: { auth: { public: true } }, doThing: async () => 'ok' } as unknown as Service;
  const method = new Method('doThing', stringReturnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  return new ServiceExecutor(service, _interface, method);
};

/** A router serving one path, with an injected server build version and a capturing logger. */
const createRouter = (serverVersion: string | undefined) => {
  const router = new ServiceRouter();
  const internals = router as unknown as RouterInternals;
  internals.serviceExecutorMap = { [SERVED_PATH]: createExecutor() };
  internals.serverBuildVersion = () => serverVersion;
  const entries: Log[] = [];
  internals.logger = new Logger({
    name: 'ServiceRouter',
    logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
  });
  return { router, entries };
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

/** POST an unknown path with the given client build header (omitted when undefined). */
const askUnknownPath = async (serverVersion: string | undefined, clientVersion: string | undefined) => {
  const { router, entries } = createRouter(serverVersion);
  const { response, sent } = createResponse();
  await router.onRequest(
    {
      path: UNKNOWN_PATH,
      body: Serializer.serialize([]),
      headers: clientVersion === undefined ? {} : { 'x-client-version': clientVersion },
    },
    response
  );
  return { entries, sent };
};

const diagnosisEntries = (entries: Log[]) =>
  entries.filter((entry) => entry.logLevel === 'warn' || entry.logLevel === 'error');

describe('unknown service path: the 404 body is unchanged', () => {
  it('answers 404 with the path-bearing error message whatever the versions are', async () => {
    for (const [serverVersion, clientVersion] of [
      ['1.26.0', '1.27.0'],
      ['1.27.0', '1.26.0'],
      ['1.27.0', '1.27.0'],
      ['1.27.0', undefined],
      [undefined, undefined],
    ] as [string | undefined, string | undefined][]) {
      const { sent } = await askUnknownPath(serverVersion, clientVersion);
      expect(sent.status).toBe(404);
      expect(sent.body).toEqual({ error: `Unable to find service matching path: ${UNKNOWN_PATH}` });
    }
  });

  it('a served path executes and leaves no diagnosis entry behind', async () => {
    const { router, entries } = createRouter('1.27.0');
    const { response, sent } = createResponse();
    await router.onRequest(
      { path: SERVED_PATH, body: Serializer.serialize([]), headers: { 'x-client-version': '1.26.0' } },
      response
    );
    expect(sent.status).toBeUndefined();
    expect(sent.body).toEqual({ serializedReturn: Serializer.serialize('ok') });
    expect(diagnosisEntries(entries)).toEqual([]);
  });
});

describe('unknown service path: one entry, the facts in obj, severity by class', () => {
  it('client newer than the server (a rollout in progress): ONE warn, no error', async () => {
    const { entries } = await askUnknownPath('1.26.0', '1.27.0');
    const diagnosis = diagnosisEntries(entries);
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].logLevel).toBe('warn');
    expect(diagnosis[0].obj).toEqual({ path: UNKNOWN_PATH, clientVersion: '1.27.0', serverVersion: '1.26.0' });
    expect(diagnosis[0].message).toMatch(/newer/);
  });

  it('client older than the server (a stale client): ONE warn, no error', async () => {
    const { entries } = await askUnknownPath('1.27.0', '1.26.0');
    const diagnosis = diagnosisEntries(entries);
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].logLevel).toBe('warn');
    expect(diagnosis[0].obj).toEqual({ path: UNKNOWN_PATH, clientVersion: '1.26.0', serverVersion: '1.27.0' });
    expect(diagnosis[0].message).toMatch(/older/);
  });

  it('orders release versions numerically, not lexically (1.9.0 is older than 1.27.0)', async () => {
    const { entries } = await askUnknownPath('1.27.0', '1.9.0');
    expect(diagnosisEntries(entries)[0].message).toMatch(/older/);
    const newer = await askUnknownPath('1.9.0', '1.27.0');
    expect(diagnosisEntries(newer.entries)[0].message).toMatch(/newer/);
  });

  it('same version on both sides (the client calls a service this build never registered): ONE error', async () => {
    const { entries } = await askUnknownPath('1.27.0', '1.27.0');
    const diagnosis = diagnosisEntries(entries);
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].logLevel).toBe('error');
    expect(diagnosis[0].obj).toEqual({ path: UNKNOWN_PATH, clientVersion: '1.27.0', serverVersion: '1.27.0' });
    expect(diagnosis[0].message).toMatch(/same version/);
  });

  it('no client build version declared: ONE error carrying the absence', async () => {
    const { entries } = await askUnknownPath('1.27.0', undefined);
    const diagnosis = diagnosisEntries(entries);
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].logLevel).toBe('error');
    expect(diagnosis[0].obj).toEqual({ path: UNKNOWN_PATH, clientVersion: undefined, serverVersion: '1.27.0' });
    expect(diagnosis[0].message).toMatch(/cannot be ordered/);
  });

  it('a client build that is not a release version (a machine client stamped with a build id): ONE error, verbatim', async () => {
    const { entries } = await askUnknownPath('1.27.0', 'a1b2c3d');
    const diagnosis = diagnosisEntries(entries);
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].logLevel).toBe('error');
    expect(diagnosis[0].obj).toEqual({ path: UNKNOWN_PATH, clientVersion: 'a1b2c3d', serverVersion: '1.27.0' });
    expect(diagnosis[0].message).toMatch(/cannot be ordered/);
  });

  it('a server that declares no build version: ONE error carrying the absence', async () => {
    const { entries } = await askUnknownPath(undefined, '1.27.0');
    const diagnosis = diagnosisEntries(entries);
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].logLevel).toBe('error');
    expect(diagnosis[0].obj).toEqual({ path: UNKNOWN_PATH, clientVersion: '1.27.0', serverVersion: undefined });
  });

  it('one fixed message per class: the path lives in obj, never in the message', async () => {
    const messages = new Set<string>();
    for (const [serverVersion, clientVersion] of [
      ['1.26.0', '1.27.0'],
      ['1.27.0', '1.26.0'],
      ['1.27.0', '1.27.0'],
      ['1.27.0', undefined],
    ] as [string | undefined, string | undefined][]) {
      const { entries } = await askUnknownPath(serverVersion, clientVersion);
      const [entry] = diagnosisEntries(entries);
      expect(entry.message).not.toContain(UNKNOWN_PATH);
      messages.add(entry.message as string);
    }
    expect(messages.size).toBe(4);
  });
});
