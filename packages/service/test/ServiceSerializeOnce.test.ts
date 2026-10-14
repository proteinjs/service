import * as http from 'http';
import express from 'express';
import bodyParser from 'body-parser';
import { Interface, Method, TypeAliasDeclaration } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Service } from '../src/Service';
import { ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';
import { SERIALIZED_RETURN_MEDIA_TYPE, ServiceClient } from '../src/ServiceClient';
import { documentBody } from './fixture/documentBody';

/**
 * A service answer is serialized ONCE. The server composes the answer on its event loop, and a
 * large document — a few megabytes — was passing through three `JSON.stringify` calls per answer:
 * the serializer's own, a second over the value for the log line's byte count, and a third by the
 * web framework over an envelope object wrapping the serialized string (which also re-escaped
 * every quote and line break in it). Each pass held the loop for the whole document, and every
 * other request on the process waited.
 *
 * Read as OUTCOMES through a real route: an express application with the router mounted, a real
 * HTTP request, the real client parsing the answer. The count of `JSON.stringify` calls the answer
 * cost is the one spy here (the executor's own serialization is the one allowed); the bytes on the
 * wire and the value the client reads are the rest.
 */

type RouterInternals = { serviceExecutorMap: { [path: string]: ServiceExecutor } };

const SERVICE_PATH = '/service/@test/test/DocumentService/getDocument';
const DOCUMENT_BYTES = 2_600_000;

const document = documentBody(DOCUMENT_BYTES);

const createRouter = (service: Service) => {
  const returnType = { name: 'Promise<DocumentBody>' } as unknown as TypeAliasDeclaration;
  const method = new Method('getDocument', returnType, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'DocumentService', [], [method]);
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = {
    [SERVICE_PATH]: new ServiceExecutor(service, _interface, method),
  };
  return router;
};

type Server = { port: number; close: () => Promise<void> };

/** The router on a real express application, the way the server mounts it: a JSON body parser ahead of it. */
const listen = (router: ServiceRouter): Promise<Server> =>
  new Promise((resolve) => {
    const app = express();
    app.use(bodyParser.json({ limit: '100mb' }));
    app.post('/service/*', (request, response) => {
      void router.onRequest(request, response);
    });
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

/** One POST over a real socket; the body collected as the bytes that crossed the wire. */
const post = (
  port: number,
  requestPath: string,
  body: string,
  headers: { [name: string]: string } = {}
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })
        );
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.end(body);
  });

const documentService = {
  serviceMetadata: { auth: { public: true } },
  getDocument: async () => document,
} as unknown as Service;

describe('a large document answer crosses the server once', () => {
  let server: Server;
  const realFetch = global.fetch;
  const realRequest = global.Request;

  beforeAll(async () => {
    server = await listen(createRouter(documentService));
  });

  afterAll(async () => {
    await server.close();
    global.fetch = realFetch;
    global.Request = realRequest;
  });

  it('the document is at least 2.6 MB of compact JSON', () => {
    expect(JSON.stringify(document).length).toBeGreaterThanOrEqual(DOCUMENT_BYTES);
  });

  it("JSON.stringify runs ONCE per answer — the serializer's own pass — and the body IS that string", async () => {
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      const answer = await post(server.port, SERVICE_PATH, Serializer.serialize([]), {
        Accept: SERIALIZED_RETURN_MEDIA_TYPE,
      });
      expect(answer.status).toBe(200);
      const passesOverTheDocument = stringify.mock.results.filter(
        (result) => typeof result.value === 'string' && result.value.length >= DOCUMENT_BYTES
      ).length;
      expect(passesOverTheDocument).toBe(1);
      expect(answer.headers['content-type']).toContain(SERIALIZED_RETURN_MEDIA_TYPE);
      expect(answer.body.toString('utf8')).toBe(Serializer.serialize(document));
    } finally {
      stringify.mockRestore();
    }
  });

  it('an earlier client (no Accept for the bare form) still receives the envelope it reads', async () => {
    const answer = await post(server.port, SERVICE_PATH, Serializer.serialize([]));
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('application/json');
    const envelope = JSON.parse(answer.body.toString('utf8'));
    expect(Object.keys(envelope)).toEqual(['serializedReturn']);
    expect(Serializer.deserialize(envelope.serializedReturn)).toEqual(document);
    // The envelope costs the framework's own pass over the string: more bytes than the bare form.
    expect(answer.body.length).toBeGreaterThan(Buffer.byteLength(Serializer.serialize(document), 'utf8'));
  });

  it('the real client reads the whole document back from the real route', async () => {
    // The client builds `new Request(path, init)` for a path-relative url; here the request goes to the
    // test server's origin on the platform's own fetch.
    global.Request = class {
      constructor(
        public url: string,
        public init: any
      ) {}
    } as any;
    global.fetch = ((request: { url: string; init: RequestInit }) =>
      realFetch(`http://127.0.0.1:${server.port}${request.url}`, request.init)) as any;
    const method = new Method('getDocument', undefined, true, false, false, false, 'public', []);
    const client = new ServiceClient(SERVICE_PATH, method);
    const read = await client.send();
    expect(read).toEqual(document);
  });
});
