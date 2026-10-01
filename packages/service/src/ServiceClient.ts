import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Debouncer } from '@proteinjs/util';
import { isVoidReturnType } from './isVoidReturnType';
import { ServiceTransportError } from './ServiceTransportError';

/** See {@link ServiceClient.setDefaultHeadersProvider}. */
export type ServiceRequestHeadersProvider = () => { [headerName: string]: string };

/** The transport options a {@link ServiceRequestInitProvider} may set per request. */
export type ServiceRequestInit = {
  /**
   * Ask the browser to keep the request alive past the page's teardown (`fetch`'s
   * `keepalive`): a request dispatched while the page is hiding or unloading still reaches
   * the server. Browsers cap the bytes in flight under keepalive (64 KiB in Chromium), so the
   * client honours the ask only while the body and its own keepalive bytes already in flight
   * fit the budget ({@link KEEPALIVE_BUDGET_BYTES}); a request over it goes as an ordinary
   * request. Either way a request is sent ONCE — a keepalive request the transport rejects is
   * never re-sent (see {@link ServiceClient.send}).
   */
  keepalive?: boolean;
};

/** See {@link ServiceClient.setRequestInitProvider}. */
export type ServiceRequestInitProvider = (request: {
  /** The service path the request is for (`/service/<package>/<Service>/<method>`). */
  servicePath: string;
  /** The serialized request body's length in bytes. */
  bodyBytes: number;
}) => ServiceRequestInit;

/**
 * How the client may retry a method — the declarer's assertion at the service factory, never
 * inferred from a method's name. Whatever the declaration, the client redelivers ONLY a delivery
 * whose answer was not read: the transport rejected the request, a watchdog abandoned it (first
 * contact, or the body after the headers — {@link RESPONSE_BODY_TIMEOUT_MS}), the connection died
 * under the body, or a proxy answered in the server's place (a 502 / 503 / 504 with no server
 * answer in it). A server's answer of any status, read in full, is never redelivered — the server
 * decided, and a transient fault there is the server's own to retry.
 *
 * - `'read'`: the method reads and answers; a second delivery returns the same truth. Each delivery
 *   is bounded by the first-contact watchdog ({@link READ_CONTACT_TIMEOUT_MS}); a delivery that
 *   produced no response is redelivered as a fresh request under the jittered exponential series
 *   ({@link REDELIVERY_BASE_MS}, {@link REDELIVERY_CAP_MS}) inside the budget
 *   ({@link REDELIVERY_BUDGET}) and the total bound ({@link REDELIVERY_TOTAL_BOUND_MS}); after the
 *   last, the call rejects with a {@link ServiceTransportError} carrying `attempts` and the last cause.
 * - `{ idempotent: true }`: the method writes, and a redelivery must not apply it twice — so the
 *   client mints one idempotency key per call and sends it on every delivery of that call
 *   ({@link IDEMPOTENCY_KEY_HEADER}); the server runs the method once per key and answers a replay
 *   with the recorded result (see `IdempotencyLedger`). Delivered under the same series, budget,
 *   total bound and body bound as a read, but with NO first-contact watchdog by default: a
 *   transport rejection redelivers, while a request still waiting for its headers waits — the
 *   server does not cancel a method a client abandons, so abandoning a write that honestly takes
 *   long would replay it CONCURRENTLY with the run still going. A method whose run time is known
 *   opts in with `contactTimeoutMs` (set from a measured upper bound of the method's own run, not a
 *   guess), and a delivery with no headers inside it is abandoned and redelivered under the key.
 *   The ledger's scope is the server's: in-process by default, so a deployment of several server
 *   processes registers a shared ledger (see `ServiceExecutor.setIdempotencyLedger`) before
 *   declaring a method idempotent — a multi-process server with the in-process ledger refuses a
 *   keyed call (see `MULTI_PROCESS_ENV`).
 * - a number: the earlier grammar — the delivery is retried that many times after ANY failure, a
 *   server's verdict included, one second apart. Kept only for the methods already declared with
 *   it; a method whose redelivery is safe declares `'read'` or `{ idempotent: true }` instead, and
 *   the numeric arm is removed once no declaration uses it.
 *
 * Undeclared (the default): one delivery, no bound of any kind, no redelivery. A method that may
 * be doing long work on the server before it answers, or applying a change a second delivery would
 * apply again, stays undeclared. A declared method is never debounced (the factory refuses the pair:
 * see {@link ServiceClient.refuseDebouncedDeclaration}).
 */
export type ServiceMethodRetry = 'read' | { idempotent: true; contactTimeoutMs?: number } | number;

/**
 * The first-contact bound for a declared method: when no response headers have arrived inside it,
 * the request is abandoned (its signal aborted, so the browser drops the stalled transfer and the
 * redelivery is a fresh request) and the delivery counts as having produced no response.
 *
 * Why 15 s: a read answers in one round trip — the server runs its query and replies, hundreds of
 * milliseconds end to end on a healthy path, and a serving path's own latency alerting fires well
 * under this (a consuming application alerts at a p95 of 2 s). A request with no headers after 15 s
 * is not waiting on a slow server; it is sitting in a client-side connection that has stopped
 * carrying bytes — a phone's pooled connection was observed holding a read for three minutes before
 * the browser gave up on it, the surface behind the read blank the whole time. 15 s is also the
 * first-contact bound a consuming application's streaming send already uses, so a client keeps one
 * first-contact clock. Declared methods only: abandoning a method that may legitimately answer after
 * long work would report an unconfirmed delivery for work the server was doing.
 */
export const READ_CONTACT_TIMEOUT_MS = 15_000;

/**
 * The body's bound, for a redeliverable delivery (a declared read; a keyed write): once the response
 * headers have arrived, the body must finish arriving inside it, or the request is abandoned (the
 * same signal aborted — the browser drops the read) and the delivery counts as a lost answer
 * ({@link ServiceTransportError.answerLost}: `reachedServer: true, answered: false`), redelivered
 * under the series — a read is pure; a keyed write replays under its key. The server composes a
 * service answer in full before it sends the headers, so the body is one document following them at
 * once; a body still arriving 30 s after its headers is sitting in a connection that stopped
 * carrying bytes, not waiting on the server. 30 s rather than the first-contact 15 s: a large answer
 * on the slowest link a page is used on (a few hundred kbit/s) is a few megabytes in 30 s — more
 * than any one service answer — so an honest slow download is never abandoned. Declared methods
 * only, like every bound here: an undeclared method's request carries no signal and reads its body
 * as it always did — every retry behaviour is a method's own opt-in.
 */
export const RESPONSE_BODY_TIMEOUT_MS = 30_000;

/**
 * The redeliveries after the first delivery — four deliveries at most. The series below needs
 * three pauses (1 s, 2 s, 4 s) to be a series at all, and together they span the few seconds a
 * phone's network handoff takes — the failure a blind redelivery can ride out. Past four, more
 * blind tries are the person's call (a retry they ask for), not the client's.
 */
export const REDELIVERY_BUDGET = 3;

/**
 * The pause before the n-th redelivery (n from 0) is drawn uniformly from
 * [0, min({@link REDELIVERY_CAP_MS}, {@link REDELIVERY_BASE_MS} × 2^n)] — full jitter: the
 * exponential growth so a server coming back is not met by every waiting client at once, the random
 * draw so clients that failed together do not retry together. The base is 1 s: a redelivery is blind
 * (there is no evidence to consult before trying again) and a surface is empty meanwhile, so the
 * first pause is short.
 */
export const REDELIVERY_BASE_MS = 1_000;

/**
 * No pause is longer than 4 s: an empty surface past that reads as broken, and under the
 * per-delivery watchdog a longer pause only spends the total bound waiting instead of trying.
 */
export const REDELIVERY_CAP_MS = 4_000;

/**
 * A redelivery leaves only while less than this has passed since the first delivery left (its own
 * pause counted — checked before the pause and again after it, since a page suspended under the
 * pause resumes with the clock minutes on). Three stalled deliveries at the watchdog's 15 s fit inside it — the one case that
 * takes long: the first fresh request after a stall usually lands (the stall was one dead
 * connection), a second stall says the link itself is down, and a third 15-s wait is the last a
 * person reads as "it tried" rather than "it hung". The longest a call can take is the bound plus
 * one watchdog — a redelivery that left just inside the bound and stalled: under a minute on the
 * first-contact clock, a little over it when the body's bound ({@link RESPONSE_BODY_TIMEOUT_MS})
 * is the one that fires. Every delivery whose answer was not read within the budget and the bound
 * rejects with the typed error.
 */
export const REDELIVERY_TOTAL_BOUND_MS = 45_000;

/** The request header carrying a method's idempotency key — one key per call, the same on every delivery. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The bytes a page may have in flight under `keepalive` at once — the browser's own cap (64 KiB
 * in Chromium, counted across the page). The client counts its own keepalive request bodies
 * against it and sets `keepalive` on a request only while the body and the bytes already in
 * flight fit; a request over the budget goes as an ordinary request instead. A request the
 * browser refused at the cap used to be re-sent without keepalive, but the refusal and a
 * connection dying under the request throw the same TypeError, so the re-send was a second
 * delivery of a request the server may already have handled — it is gone, and the budget is
 * counted here, before the request leaves.
 */
export const KEEPALIVE_BUDGET_BYTES = 64 * 1024;

/**
 * The request-init provider slot lives on the global object, not in module scope: per-package
 * installs can put several live copies of this module in one page (a package's nested
 * node_modules hosts its own), and a page-lifecycle owner setting the slot on one copy while
 * the db layer's service clients dispatch through another would be a silent no-op. One slot,
 * one page — the same anchoring reflection's SourceRepository uses.
 */
const REQUEST_INIT_PROVIDER_GLOBAL_KEY = '__proteinjs_service_requestInitProvider';

/** The keepalive bytes in flight, on the same global slot and for the same reason: the browser's cap is the page's, not a module copy's. */
const KEEPALIVE_IN_FLIGHT_GLOBAL_KEY = '__proteinjs_service_keepaliveBytesInFlight';

/**
 * The statuses a proxy in front of the server answers with when no server answered — a load
 * balancer's "bad gateway", "unavailable", "gateway timeout". One of these WITHOUT the router's
 * body (`{ error: <message> }`) came from the proxy, not from a server process: for a redeliverable
 * method it is a transport failure ({@link ServiceTransportError.unserved}); an undeclared method
 * reads it as a verdict, as it always has.
 */
const PROXY_STATUSES: readonly number[] = [502, 503, 504];

/** How one delivery is made — set by the method's declared retry (see {@link ServiceMethodRetry}). */
type Delivery = {
  /** Whether a delivery whose answer was not read may be sent again (a read; a keyed write). */
  redeliverable: boolean;
  /** The first-contact bound, when the delivery has one. */
  contactTimeoutMs?: number;
  /** The call's own headers (an idempotency key). */
  headers?: { [headerName: string]: string };
};

const getGlobal = (): any => (typeof window !== 'undefined' ? window : globalThis);

export class ServiceClient {
  private static requestCounter = 1;

  /** The jitter's draw in [0, 1) — the one source of randomness in the redelivery series. */
  private static random: () => number = Math.random;

  /**
   * Ambient client-context headers attached to every service request this client sends.
   *
   * Some request context is transport-level, not argument-level: it describes the CLIENT
   * CONNECTION issuing the call, not the call itself — e.g. the socket.io connection id the
   * issuing browser tab currently holds, which server-side emitters use to mark events as
   * self-originated so the authoring tab can drop its own echo. Threading that through every
   * service method signature (and through generic layers like the db service or the
   * transaction runner, whose APIs must stay transport-agnostic) would smear one concept
   * across every call site; a request header carries it once, here, at the one place every
   * service call already flows through.
   *
   * ONE slot by design: there is one owner of client-context headers per app (the module that
   * owns the client's ambient identity — e.g. @n3xah/util-common's OriginSocketContext).
   * Reserved headers (Content-Type) always win over provider-supplied ones.
   */
  private static defaultHeadersProvider: ServiceRequestHeadersProvider | undefined;

  static setDefaultHeadersProvider(provider: ServiceRequestHeadersProvider | undefined): void {
    ServiceClient.defaultHeadersProvider = provider;
  }

  /**
   * Ambient transport options for every service request this client sends — the request-init
   * twin of {@link setDefaultHeadersProvider}. Some transport state describes the CLIENT PAGE,
   * not the call: a page that is hiding or unloading must have every request it dispatches
   * outlive it (`keepalive`), or the writes it queued die with it. The provider is consulted
   * per request, at dispatch, with the service path and the body size, so an owner can decide
   * per request; the browser's keepalive cap is the client's own to count
   * ({@link KEEPALIVE_BUDGET_BYTES}), so an owner asks for keepalive and the client sets it
   * while the budget allows.
   *
   * ONE slot by design: one owner of page lifecycle per app. Reserved init fields (method,
   * body, headers, credentials, redirect) always win over provider-supplied ones.
   */
  static setRequestInitProvider(provider: ServiceRequestInitProvider | undefined): void {
    getGlobal()[REQUEST_INIT_PROVIDER_GLOBAL_KEY] = provider;
  }

  private static requestInitProvider(): ServiceRequestInitProvider | undefined {
    return getGlobal()[REQUEST_INIT_PROVIDER_GLOBAL_KEY];
  }

  /**
   * A method with a retry declaration is never debounced: the debouncer runs the call later and
   * hands the caller nothing, so the call's value and the typed transport error the declaration
   * exists to deliver would reach no one. Refused here, where the two meet — by the constructor,
   * and by the service factory as soon as it is handed both configs (at the consumer's module
   * load, before any service is made). `method` names the method for the message.
   */
  static refuseDebouncedDeclaration(method: string, debounced: boolean, retry: ServiceMethodRetry | undefined): void {
    if (debounced && ServiceClient.isDeclared(retry)) {
      throw new Error(
        `${method}: a method with a retry declaration cannot be debounced — the debouncer runs the call later and hands its result and its typed transport error to no one. Declare the retry or the debounce, not both.`
      );
    }
  }

  constructor(
    private servicePath: string,
    private serviceMethod: Method,
    private debouncer?: Debouncer,
    private retry?: ServiceMethodRetry
  ) {
    ServiceClient.refuseDebouncedDeclaration(servicePath, debouncer !== undefined, retry);
  }

  async send(...args: any[]): Promise<any> {
    const execute = () => this.executeWithRetry(args);
    if (this.debouncer) {
      return this.debouncer.debounce(execute, args);
    } else {
      return execute();
    }
  }

  /** The delivery under the method's declared retry (see {@link ServiceMethodRetry}). */
  private executeWithRetry(args: any[]): Promise<any> {
    if (this.retry === 'read') {
      return this.deliverUnderPolicy(args, undefined, READ_CONTACT_TIMEOUT_MS);
    }
    if (typeof this.retry === 'object' && this.retry !== null && this.retry.idempotent === true) {
      return this.deliverUnderPolicy(args, ServiceClient.mintIdempotencyKey(), this.retry.contactTimeoutMs);
    }
    if (typeof this.retry === 'number' && this.retry > 0) {
      return this.deliverWithRetries(args, this.retry);
    }
    return this.deliver(args, { redeliverable: false });
  }

  /**
   * The policy for a declared method: every delivery under the first-contact watchdog when the
   * method has one (`contactTimeoutMs` — a read's is {@link READ_CONTACT_TIMEOUT_MS}; a keyed write
   * has none unless it opted in) and under the body bound; a delivery whose answer was not read is
   * redelivered as a fresh request after a jittered exponential pause, while the budget and the
   * total bound allow; a response of any status is never redelivered. The last transport error
   * carries the count of deliveries made. An idempotent method's key rides every delivery of the call.
   */
  private async deliverUnderPolicy(
    args: any[],
    idempotencyKey: string | undefined,
    contactTimeoutMs: number | undefined
  ): Promise<any> {
    const headers = idempotencyKey === undefined ? undefined : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey };
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deliver(args, { redeliverable: true, contactTimeoutMs, headers });
      } catch (error) {
        if (!ServiceTransportError.is(error)) {
          throw error;
        }
        error.attempts = attempt;
        if (attempt > REDELIVERY_BUDGET) {
          throw error;
        }
        const pause = ServiceClient.redeliveryPause(attempt - 1);
        if (Date.now() + pause - startedAt >= REDELIVERY_TOTAL_BOUND_MS) {
          throw error;
        }
        await ServiceClient.pause(pause);
        // Checked again on the far side of the pause: a timer fires late when the page was
        // suspended under it (a phone backgrounded mid-series resumes with the clock minutes on),
        // and a redelivery that leaves then is past the bound by any clock but the timer's.
        if (Date.now() - startedAt >= REDELIVERY_TOTAL_BOUND_MS) {
          throw error;
        }
      }
    }
  }

  /**
   * The per-method count: the delivery is retried `retries` times after ANY failure — a server's
   * verdict included — one second apart.
   */
  private async deliverWithRetries(args: any[], retries: number): Promise<any> {
    const maxAttempts = 1 + retries;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.deliver(args, { redeliverable: false });
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        await ServiceClient.pause(1000);
      }
    }
  }

  /** One delivery: serialize, send, deserialize — logged under its request number. */
  private async deliver(args: any[], delivery: Delivery): Promise<any> {
    const serializedArgs = Serializer.serialize(args);
    const requestNumber = ServiceClient.requestCounter;
    ServiceClient.requestCounter++;
    console.groupCollapsed(`[#${requestNumber}] Sending service request: ${this.servicePath}, args:`);
    console.log(args);
    console.groupEnd();
    const serializedReturn = await this._send(this.servicePath, serializedArgs, delivery);
    const deserializedReturn = Serializer.deserialize(serializedReturn);
    console.groupCollapsed(
      `[#${requestNumber}] Received service response: ${this.servicePath}, return:${isVoidReturnType(this.serviceMethod) ? ' (void)' : ''}`
    );
    console.log(deserializedReturn);
    console.groupEnd();

    return deserializedReturn;
  }

  /**
   * The request on the wire — sent ONCE. A redeliverable delivery rides one abort signal from first
   * contact through the body: with `contactTimeoutMs`, the first-contact watchdog abandons the
   * request (its signal aborted — the browser drops the stalled transfer, so a redelivery is a fresh
   * request) when no response headers have arrived inside the bound, and once the headers have
   * arrived the body's own bound ({@link RESPONSE_BODY_TIMEOUT_MS}) takes over the same signal. A
   * request whose answer was not read — the transport rejected it, a watchdog fired, or the
   * connection died under the body — throws a {@link ServiceTransportError} (`reachedServer` false
   * before the headers, true after); a response read in full, of any status, is the server's
   * answer and is read as before. An undeclared method's request carries no signal and no bound,
   * and reads its body as it always did; only the transport's own rejection is typed for it.
   * A 502 / 503 / 504 with no server answer in its body is a proxy's, not the server's: a transport
   * failure for a redeliverable delivery ({@link ServiceTransportError.unserved}), a verdict for any
   * other. The delivery's `headers` are the call's own (an idempotency key), set after the ambient
   * provider's and under the reserved ones. The provider's keepalive ask is honoured inside the
   * page's budget ({@link KEEPALIVE_BUDGET_BYTES}), counted here before the request leaves.
   */
  private async _send(absoluteUrl: string, serializedArgs: string, delivery: Delivery) {
    const { contactTimeoutMs, headers } = delivery;
    const bodyBytes = ServiceClient.utf8ByteLength(serializedArgs);
    const provided = ServiceClient.requestInitProvider()?.({ servicePath: absoluteUrl, bodyBytes });
    const keepalive =
      provided?.keepalive === true && bodyBytes + ServiceClient.keepaliveBytesInFlight() <= KEEPALIVE_BUDGET_BYTES;
    // A redeliverable delivery is bounded (first contact, then the body) on one signal; an
    // undeclared method's request carries none — no bound of any kind, as it always was.
    const watchdog = delivery.redeliverable ? new AbortController() : undefined;
    const init: RequestInit = {
      ...(watchdog ? { signal: watchdog.signal } : {}),
      ...(keepalive ? { keepalive: true } : {}),
      method: 'POST',
      body: serializedArgs,
      redirect: 'follow',
      credentials: 'same-origin',
      headers: {
        // Provider-supplied client-context headers first so reserved headers always win.
        ...(ServiceClient.defaultHeadersProvider ? ServiceClient.defaultHeadersProvider() : {}),
        ...(headers ?? {}),
        'Content-Type': 'application/json',
      },
    };
    let stalled = false;
    const contactTimer =
      watchdog && contactTimeoutMs !== undefined
        ? setTimeout(() => {
            stalled = true;
            watchdog.abort();
          }, contactTimeoutMs)
        : undefined;
    if (keepalive) {
      ServiceClient.addKeepaliveBytesInFlight(bodyBytes);
    }
    let response: Response;
    try {
      response = await fetch(new Request(absoluteUrl, init));
    } catch (error) {
      throw stalled
        ? ServiceTransportError.stalled(absoluteUrl, contactTimeoutMs as number)
        : ServiceTransportError.failed(absoluteUrl, error);
    } finally {
      if (contactTimer) {
        clearTimeout(contactTimer);
      }
      if (keepalive) {
        ServiceClient.addKeepaliveBytesInFlight(-bodyBytes);
      }
    }

    // The headers are here: the server handled the call. For a redeliverable delivery the body's
    // bound arms the same signal; an undeclared method reads its body as it always did.
    const bodyTimer =
      watchdog &&
      setTimeout(() => {
        stalled = true;
        watchdog.abort();
      }, RESPONSE_BODY_TIMEOUT_MS);
    try {
      if (response.status != 200) {
        const verdict = await this.readVerdict(response, absoluteUrl);
        if (delivery.redeliverable && !verdict.fromServer && PROXY_STATUSES.includes(response.status)) {
          throw ServiceTransportError.unserved(absoluteUrl, response.status, response.statusText);
        }
        throw new Error(verdict.message);
      }
      const body = delivery.redeliverable
        ? await this.readAnswer(response, absoluteUrl, () => stalled)
        : await response.json();
      if (body.error) {
        throw new Error(body.error);
      }
      return body.serializedReturn;
    } finally {
      if (bodyTimer) {
        clearTimeout(bodyTimer);
      }
    }
  }

  /**
   * The answer's body. A read the body's bound abandoned, or that the connection died under (the
   * transport's TypeError), is a lost answer — typed, so a redeliverable method may redeliver it.
   * A body that arrived but is not JSON stays the parse error it always was: the server answered.
   */
  private async readAnswer(response: Response, absoluteUrl: string, bodyStalled: () => boolean): Promise<any> {
    try {
      return await response.json();
    } catch (error) {
      if (bodyStalled()) {
        throw ServiceTransportError.answerLost(absoluteUrl, { stalled: true, boundMs: RESPONSE_BODY_TIMEOUT_MS });
      }
      if (error instanceof TypeError) {
        throw ServiceTransportError.answerLost(absoluteUrl, { stalled: false, cause: error });
      }
      throw error;
    }
  }

  /**
   * A non-200 response's verdict. The server puts the thrown error's message in the response body
   * ({ error: message }) — the router's shape, `fromServer` true. A body that is not that shape
   * (older servers sent no message; a proxy's page is not JSON at all) is read as the status text,
   * `fromServer` false.
   */
  private async readVerdict(
    response: Response,
    absoluteUrl: string
  ): Promise<{ fromServer: boolean; message: string }> {
    try {
      const body = await response.json();
      if (typeof body?.error === 'string' && body.error) {
        return { fromServer: true, message: body.error };
      }
    } catch (parseError) {
      // body was not JSON; fall through to statusText
    }

    return {
      fromServer: false,
      message: `Failed to process service request: ${absoluteUrl}, error: ${response.statusText}`,
    };
  }

  /** Whether `retry` declares anything: a read, an idempotent write, or a positive count. */
  private static isDeclared(retry: ServiceMethodRetry | undefined): boolean {
    if (retry === 'read') {
      return true;
    }
    if (typeof retry === 'object' && retry !== null && retry.idempotent === true) {
      return true;
    }
    return typeof retry === 'number' && retry > 0;
  }

  /** The n-th redelivery's pause: full jitter over the capped exponential series (see {@link REDELIVERY_BASE_MS}). */
  private static redeliveryPause(n: number): number {
    const ceiling = Math.min(REDELIVERY_CAP_MS, REDELIVERY_BASE_MS * Math.pow(2, n));
    return Math.floor(ServiceClient.random() * ceiling);
  }

  private static pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * A key no two calls share: 16 random bytes in the UUID (version 4) layout, from the platform's
   * random source — available in every page, secure context or not, and in node.
   */
  private static mintIdempotencyKey(): string {
    const bytes = new Uint8Array(16);
    getGlobal().crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 0x10 ? '0' : '') + bytes[i].toString(16);
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** The page's keepalive bytes in flight (every module copy counts on the one slot). */
  private static keepaliveBytesInFlight(): number {
    const held = getGlobal()[KEEPALIVE_IN_FLIGHT_GLOBAL_KEY];
    return typeof held === 'number' ? held : 0;
  }

  /** A keepalive request leaving (its body's bytes) or settling (the same bytes, negated). */
  private static addKeepaliveBytesInFlight(delta: number): void {
    getGlobal()[KEEPALIVE_IN_FLIGHT_GLOBAL_KEY] = Math.max(0, ServiceClient.keepaliveBytesInFlight() + delta);
  }

  /**
   * The bytes `fetch` puts on the wire for a string body (UTF-8) — what a browser counts
   * against its keepalive in-flight cap. A string's `length` is its UTF-16 code units, which
   * undercounts every non-ASCII character (up to 3×). Counted here, with no environment
   * dependency (jsdom test environments have no TextEncoder).
   */
  private static utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        // A surrogate pair: one 4-byte character across two code units.
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }
}
