/**
 * The request envelope: a service call's body is the serialized args array the client sends and
 * nothing else is a call. A body of any other shape — a scanner's probe, a form post the body
 * parser leaves as `{}`, a bare string, an object with an `args` field — is refused at the door
 * BEFORE the call log, the ledger and the auth gate: a 400 with a plain reason, ONE warn entry
 * naming the operation and the body's SHAPE (its type and top-level key names, capped — never its
 * contents), no error entry (a probe is not this server's failure), the method never run, nothing
 * thrown out of the router. A valid envelope is served exactly as before, and the check is "an
 * array" and nothing more: arity and element types stay the method's own business.
 */

import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import { InProcessIdempotencyLedger } from '../src/IdempotencyLedger';

type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor }; logger: Logger };
type ExecutorInternals = { logger: Logger };
type ExecutorStatics = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  idempotencyLedger: InProcessIdempotencyLedger;
};

const SERVICE_PATH = '/service/@test/test/TestService/ping';
const REFUSAL = 'request body is not a service call envelope';

/** The router with one registered no-arg method, both loggers captured, the method's runs counted. */
const createDoor = () => {
  let runs = 0;
  const service = {
    serviceMetadata: { auth: { public: true } },
    ping: async () => {
      runs++;
      return 'pong';
    },
  } as unknown as Service;
  const returnType = { name: 'Promise<string>' } as unknown as TypeAliasDeclaration;
  const method = new Method('ping', returnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  const executor = new ServiceExecutor(service, _interface, method);
  const entries: Log[] = [];
  const capturing = (name: string) =>
    new Logger({ name, logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter });
  (executor as unknown as ExecutorInternals).logger = capturing('TestService.ping');
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = { [SERVICE_PATH]: executor };
  (router as unknown as RouterInternals).logger = capturing('ServiceRouter');
  return { router, entries, runs: () => runs };
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

/** One request to the door with the body exactly as given (the parser's value, or the raw text). */
const post = async (router: ServiceRouter, body: any, key?: string) => {
  const { response, sent } = createResponse();
  const headers = key === undefined ? {} : { 'idempotency-key': key };
  await expect(router.onRequest({ path: SERVICE_PATH, body, headers }, response)).resolves.toBeUndefined();
  return sent;
};

const atLevel = (entries: Log[], logLevel: Log['logLevel']) => entries.filter((entry) => entry.logLevel === logLevel);
const entryText = (entry: Log) => JSON.stringify({ ...entry, error: entry.error?.message });

beforeEach(() => {
  (ServiceExecutor as unknown as ExecutorStatics).userRepo = {
    getUser: () => ({ email: 'caller@example.com', roles: [] }),
  };
  (ServiceExecutor as unknown as ExecutorStatics).idempotencyLedger = new InProcessIdempotencyLedger();
});

describe('a body that is not the service call envelope', () => {
  const probes: [string, any][] = [
    ['an empty object (a form post the body parser left as {})', {}],
    ['a bare string that is not JSON', 'probe'],
    ['a string of broken JSON', '{not json'],
    ['a string of a JSON object', '{"args":["x"]}'],
    ['an object with args as a string', { args: 'x' }],
    ['an object with args null', { args: null }],
    ['null', null],
    ['undefined (no body at all)', undefined],
    ['a number', 42],
  ];

  it.each(probes)('%s is refused 400 with the plain reason, the method never run', async (_label, body) => {
    const { router, runs } = createDoor();

    const sent = await post(router, body);

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: REFUSAL });
    expect(runs()).toBe(0);
  });

  it.each(probes)('%s is logged ONCE at warn, never at error, and never reaches the call log', async (_label, body) => {
    const { router, entries } = createDoor();

    await post(router, body);

    expect(atLevel(entries, 'error')).toEqual([]);
    expect(entries.filter((entry) => entry.message === 'Calling')).toEqual([]);
    const warnings = atLevel(entries, 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].obj?.functionName).toBe('TestService.ping');
    expect(warnings[0].obj?.status).toBe(400);
    expect(typeof warnings[0].obj?.body).toBe('string');
  });

  it('names the body shape by type and top-level keys, never its contents', async () => {
    const { router, entries } = createDoor();

    await post(router, { username: 'scanner-login-7f3a', password: 'scanner-secret-7f3a' });

    const [warning] = atLevel(entries, 'warn');
    expect(warning.obj?.body).toContain('Object');
    expect(warning.obj?.body).toContain('username');
    expect(warning.obj?.body).toContain('password');
    expect(entryText(warning)).not.toContain('scanner-login-7f3a');
    expect(entryText(warning)).not.toContain('scanner-secret-7f3a');
  });

  it('caps the shape of a large body and keeps a string body out of the log', async () => {
    const { router, entries } = createDoor();
    const wide: { [key: string]: number } = {};
    for (let i = 0; i < 500; i++) {
      wide[`probe-key-${i}`] = i;
    }
    const text = 'x'.repeat(100_000);

    await post(router, wide);
    await post(router, text);

    const warnings = atLevel(entries, 'warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[0].obj?.body.length).toBeLessThanOrEqual(200);
    expect(warnings[1].obj?.body).toMatch(/^string\(100000B\)/);
    expect(warnings[1].obj?.body.length).toBeLessThanOrEqual(200);
    expect(entryText(warnings[1])).not.toContain('xxxxxxxx');
  });

  it('under an idempotency key is refused before the ledger: a valid replay of the key is served', async () => {
    const { router, runs, entries } = createDoor();

    const refused = await post(router, {}, 'key-7f3a');
    const served = await post(router, Serializer.serialize([]), 'key-7f3a');

    expect(refused.status).toBe(400);
    expect(served.status).toBeUndefined();
    expect(served.body).toEqual({ serializedReturn: Serializer.serialize('pong') });
    expect(runs()).toBe(1);
    expect(atLevel(entries, 'error')).toEqual([]);
  });
});

describe('a body that is the service call envelope', () => {
  const envelopes: [string, any][] = [
    ['the serialized args text', Serializer.serialize([])],
    ['the parsed args array', []],
    ['more args than the method declares', ['extra', { more: true }]],
    ['the serialized text of more args than the method declares', Serializer.serialize(['extra', 2])],
  ];

  it.each(envelopes)('%s is served, with no warn entry and the call log unchanged', async (_label, body) => {
    const { router, runs, entries } = createDoor();

    const sent = await post(router, body);

    expect(sent.status).toBeUndefined();
    expect(sent.body).toEqual({ serializedReturn: Serializer.serialize('pong') });
    expect(runs()).toBe(1);
    expect(atLevel(entries, 'warn')).toEqual([]);
    expect(atLevel(entries, 'error')).toEqual([]);
    const calling = entries.find((entry) => entry.message === 'Calling');
    expect(calling?.obj?.functionName).toBe('TestService.ping');
    expect(calling?.obj?.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(Array.isArray(calling?.obj?.args)).toBe(true);
  });
});
