import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import {
  READ_CONTACT_TIMEOUT_MS,
  REDELIVERY_BUDGET,
  REDELIVERY_CAP_MS,
  REQUEST_ID_HEADER,
  RESPONSE_BODY_TIMEOUT_MS,
  ServiceClient,
  ServiceMethodRetry,
} from '../src/ServiceClient';

/**
 * The client reports every redelivery it makes: one WARN line per redelivery — the method, which
 * delivery leaves next of how many, why the last was abandoned (a first-contact timeout, the
 * body's timeout, or the network), the milliseconds since the first delivery left, and the
 * server's request id when the lost answer's headers had named one. A page that ships its warnings
 * to the server reports a redelivery storm where it starts.
 */

type ClientStatics = { random: () => number; logger: Logger };

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

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => ({ serializedReturn: Serializer.serialize('ok') }),
});

/** No headers, ever — the read settles only when the request's signal aborts. */
const neverAnswers = (request: any) =>
  new Promise((unused, reject) => {
    request.init.signal?.addEventListener('abort', () => reject(abortError()));
  });

/** Headers at once, naming the server's request id; a body that never finishes. */
const headersThenHangingBody = (request: any) =>
  Promise.resolve({
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json', [REQUEST_ID_HEADER]: 'req-0123456789abcdef' }),
    json: () =>
      new Promise((unused, reject) => {
        request.init.signal?.addEventListener('abort', () => reject(abortError()));
      }),
  });

const warnings = (entries: Log[]) => entries.filter((entry) => entry.logLevel === 'warn');

describe('the redelivery line', () => {
  let entries: Log[];
  beforeEach(() => {
    jest.useFakeTimers();
    entries = [];
    (ServiceClient as unknown as ClientStatics).random = () => 0.5;
    (ServiceClient as unknown as ClientStatics).logger = new Logger({
      name: 'ServiceClient',
      logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    (ServiceClient as unknown as ClientStatics).random = Math.random;
    (ServiceClient as unknown as ClientStatics).logger = new Logger({ name: 'ServiceClient' });
  });

  it('a first-contact timeout: the method, the next delivery of four, the reason, the elapsed ms', async () => {
    global.fetch = jest.fn().mockImplementationOnce(neverAnswers).mockImplementationOnce(okResponse) as any;
    const call = createClient('read').send('a');
    await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS + REDELIVERY_CAP_MS);
    await expect(call).resolves.toBe('ok');

    expect(warnings(entries)).toHaveLength(1);
    const line = warnings(entries)[0];
    expect(line.loggerName).toBe('ServiceClient');
    expect(line.message).toBe('Redelivering');
    expect(line.obj).toEqual({
      servicePath: SERVICE_PATH,
      attempt: 2,
      of: REDELIVERY_BUDGET + 1,
      reason: 'first-contact timeout',
      elapsedMs: READ_CONTACT_TIMEOUT_MS,
    });
  });

  it("a body timeout: the reason names the body, and the line carries the server's request id for the lost answer", async () => {
    global.fetch = jest.fn().mockImplementationOnce(headersThenHangingBody).mockImplementationOnce(okResponse) as any;
    const call = createClient('read').send('a');
    await jest.advanceTimersByTimeAsync(RESPONSE_BODY_TIMEOUT_MS + REDELIVERY_CAP_MS);
    await expect(call).resolves.toBe('ok');

    expect(warnings(entries)).toHaveLength(1);
    expect(warnings(entries)[0].obj).toEqual({
      servicePath: SERVICE_PATH,
      attempt: 2,
      of: REDELIVERY_BUDGET + 1,
      reason: 'body timeout',
      elapsedMs: RESPONSE_BODY_TIMEOUT_MS,
      requestId: 'req-0123456789abcdef',
    });
  });

  it('the network: one line per redelivery, counting up the series', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(okResponse) as any;
    const call = createClient('read').send('a');
    await jest.advanceTimersByTimeAsync(2 * REDELIVERY_CAP_MS);
    await expect(call).resolves.toBe('ok');

    expect(warnings(entries).map((line) => line.obj)).toEqual([
      { servicePath: SERVICE_PATH, attempt: 2, of: 4, reason: 'network', elapsedMs: 0 },
      { servicePath: SERVICE_PATH, attempt: 3, of: 4, reason: 'network', elapsedMs: 500 },
    ]);
  });

  it('a delivery answered first time: no line', async () => {
    global.fetch = jest.fn(okResponse) as any;
    await expect(createClient('read').send('a')).resolves.toBe('ok');
    expect(warnings(entries)).toEqual([]);
  });
});
