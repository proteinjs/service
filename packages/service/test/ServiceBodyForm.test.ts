import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import {
  DECLARED_READ_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  SERIALIZED_RETURN_MEDIA_TYPE,
  ServiceClient,
  ServiceMethodRetry,
} from '../src/ServiceClient';

/**
 * The answer's form on the wire, negotiated per request so either side may be the older one for a
 * release: a client that names {@link SERIALIZED_RETURN_MEDIA_TYPE} in its `Accept` receives the
 * serialized text as the whole body under that type; a client that does not receives the envelope
 * (`{ serializedReturn }`) under application/json. The client reads both. The server's request id
 * (the response header the server set) is handed to the executor so its lines carry it; a host
 * that set none leaves the executor to mint its own.
 */

type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor } };
type ExecutorInternals = { logger: Logger };

const SERVICE_PATH = '/service/@test/test/TestService/doThing';

const createRouter = (service: Service, returnTypeName = 'Promise<string>') => {
  const returnType = { name: returnTypeName } as unknown as TypeAliasDeclaration;
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

const request = (router: ServiceRouter, headers: { [name: string]: string }, requestId?: string): Promise<Sent> => {
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
    getHeader: (name: string) => (name === 'X-Request-Id' ? requestId : undefined),
  };
  return router
    .onRequest({ path: SERVICE_PATH, body: Serializer.serialize(['a']), headers }, response)
    .then(() => sent);
};

const echo = {
  serviceMetadata: { auth: { public: true } },
  doThing: async (arg: string) => ({ got: arg }),
} as unknown as Service;

describe('the router: the form the client asked for', () => {
  it('an Accept naming the serialized form: the body is the serialized text itself, under that type', async () => {
    const { router } = createRouter(echo);
    const sent = await request(router, { accept: SERIALIZED_RETURN_MEDIA_TYPE });
    expect(sent).toEqual({ type: SERIALIZED_RETURN_MEDIA_TYPE, body: Serializer.serialize({ got: 'a' }) });
  });

  it('no such Accept (an earlier client): the envelope, as it always was', async () => {
    const { router } = createRouter(echo);
    const sent = await request(router, { accept: '*/*' });
    expect(sent).toEqual({ body: { serializedReturn: Serializer.serialize({ got: 'a' }) } });
  });

  it('an undefined return under the serialized form: an empty body', async () => {
    const { router } = createRouter({
      serviceMetadata: { auth: { public: true } },
      doThing: async () => undefined,
    } as unknown as Service);
    const sent = await request(router, { accept: SERIALIZED_RETURN_MEDIA_TYPE });
    expect(sent).toEqual({ type: SERIALIZED_RETURN_MEDIA_TYPE, body: '' });
  });

  it('a void method under the serialized form: an empty body too', async () => {
    const { router } = createRouter(
      { serviceMetadata: { auth: { public: true } }, doThing: async () => undefined } as unknown as Service,
      'Promise<void>'
    );
    const sent = await request(router, { accept: SERIALIZED_RETURN_MEDIA_TYPE });
    expect(sent).toEqual({ type: SERIALIZED_RETURN_MEDIA_TYPE, body: '' });
  });

  it('a verdict rides as { error } under its status whichever form was asked for', async () => {
    const { router } = createRouter({
      serviceMetadata: { auth: { public: true } },
      doThing: async () => {
        throw new Error('no such document');
      },
    } as unknown as Service);
    expect(await request(router, { accept: SERIALIZED_RETURN_MEDIA_TYPE })).toEqual({
      status: 400,
      body: { error: 'no such document' },
    });
    expect(await request(router, { accept: '*/*' })).toEqual({ status: 400, body: { error: 'no such document' } });
  });
});

describe("the router: the server's request id", () => {
  it("the id the server echoed on the response is the id on the method's Calling and Returning lines", async () => {
    const { router, entries } = createRouter(echo);
    await request(router, { accept: SERIALIZED_RETURN_MEDIA_TYPE }, 'req-0123456789abcdef');
    const ids = entries.filter((entry) => entry.logLevel === 'info').map((entry) => entry.obj.requestId);
    expect(ids).toEqual(['req-0123456789abcdef', 'req-0123456789abcdef']);
  });

  it('a host that set none: the executor mints one of its own, the same on both lines', async () => {
    const { router, entries } = createRouter(echo);
    await request(router, { accept: SERIALIZED_RETURN_MEDIA_TYPE });
    const ids = entries.filter((entry) => entry.logLevel === 'info').map((entry) => entry.obj.requestId);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(ids[1]).toBe(ids[0]);
  });
});

describe('the client: what it sends and what it reads', () => {
  beforeAll(() => {
    global.Request = class {
      constructor(
        public url: string,
        public init: any
      ) {}
    } as any;
  });

  const createClient = (retry?: ServiceMethodRetry) => {
    const method = new Method('doThing', undefined, true, false, false, false, 'public', []);
    return new ServiceClient(SERVICE_PATH, method, undefined, retry);
  };
  const sentInit = () => (global.fetch as jest.Mock).mock.calls[0][0].init;
  const answer = (contentType: string, body: string) => async () => ({
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': contentType }),
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  it('every request names the serialized form in its Accept', async () => {
    global.fetch = jest.fn(answer(SERIALIZED_RETURN_MEDIA_TYPE, Serializer.serialize('ok'))) as any;
    await createClient().send('a');
    expect(sentInit().headers.Accept).toBe(SERIALIZED_RETURN_MEDIA_TYPE);
  });

  it('a declared read carries the declared-read header; an undeclared call and a keyed write do not', async () => {
    global.fetch = jest.fn(answer(SERIALIZED_RETURN_MEDIA_TYPE, Serializer.serialize('ok'))) as any;
    await createClient('read').send('a');
    expect(sentInit().headers[DECLARED_READ_HEADER]).toBe('true');
    expect(sentInit().headers[IDEMPOTENCY_KEY_HEADER]).toBeUndefined();

    global.fetch = jest.fn(answer(SERIALIZED_RETURN_MEDIA_TYPE, Serializer.serialize('ok'))) as any;
    await createClient().send('a');
    expect(sentInit().headers[DECLARED_READ_HEADER]).toBeUndefined();

    global.fetch = jest.fn(answer(SERIALIZED_RETURN_MEDIA_TYPE, Serializer.serialize('ok'))) as any;
    await createClient({ idempotent: true }).send('a');
    expect(sentInit().headers[DECLARED_READ_HEADER]).toBeUndefined();
    expect(typeof sentInit().headers[IDEMPOTENCY_KEY_HEADER]).toBe('string');
  });

  it('the serialized form: the body is the value', async () => {
    global.fetch = jest.fn(
      answer(`${SERIALIZED_RETURN_MEDIA_TYPE}; charset=utf-8`, Serializer.serialize({ rows: [1, 2, 3] }))
    ) as any;
    await expect(createClient().send('a')).resolves.toEqual({ rows: [1, 2, 3] });
  });

  it('the serialized form, an empty body: an undefined return', async () => {
    global.fetch = jest.fn(answer(SERIALIZED_RETURN_MEDIA_TYPE, '')) as any;
    await expect(createClient().send('a')).resolves.toBeUndefined();
  });

  it("an earlier server's envelope under application/json: the value, as it always was", async () => {
    global.fetch = jest.fn(
      answer(
        'application/json; charset=utf-8',
        JSON.stringify({ serializedReturn: Serializer.serialize({ rows: [1] }) })
      )
    ) as any;
    await expect(createClient().send('a')).resolves.toEqual({ rows: [1] });
  });

  it("an earlier server's envelope with no return: undefined", async () => {
    global.fetch = jest.fn(answer('application/json; charset=utf-8', '{}')) as any;
    await expect(createClient().send('a')).resolves.toBeUndefined();
  });
});
