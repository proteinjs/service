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
   * the server. Browsers cap the bytes in flight under keepalive (64 KiB in Chromium); a
   * request the cap refuses is re-sent once without it (see {@link ServiceClient.send}).
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
 * that produced no response (the transport rejected the request, or the first-contact watchdog
 * abandoned it): a server's answer of any status is never redelivered — the server decided, and a
 * transient fault there is the server's own to retry.
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
 *   with the recorded result (see `IdempotencyLedger`). Delivered under the same watchdog, series,
 *   budget and bound as a read. The ledger's scope is the server's: in-process by default, so a
 *   deployment of several server processes registers a shared ledger (see
 *   `ServiceExecutor.setIdempotencyLedger`) before declaring a method idempotent.
 * - a number: the earlier grammar — the delivery is retried that many times after ANY failure, a
 *   server's verdict included, one second apart. Kept only for the methods already declared with
 *   it; a method whose redelivery is safe declares `'read'` or `{ idempotent: true }` instead, and
 *   the numeric arm is removed once no declaration uses it.
 *
 * Undeclared (the default): one delivery, no first-contact bound, no redelivery. A method that may
 * be doing long work on the server before it answers, or applying a change a second delivery would
 * apply again, stays undeclared.
 */
export type ServiceMethodRetry = 'read' | { idempotent: true } | number;

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
 * pause counted). Three stalled deliveries at the watchdog's 15 s fit inside it — the one case that
 * takes long: the first fresh request after a stall usually lands (the stall was one dead
 * connection), a second stall says the link itself is down, and a third 15-s wait is the last a
 * person reads as "it tried" rather than "it hung". The longest a call can take is the bound plus
 * one watchdog — a redelivery that left just inside the bound and stalled: under a minute. Every
 * delivery that produced no response within the budget and the bound rejects with the typed error.
 */
export const REDELIVERY_TOTAL_BOUND_MS = 45_000;

/** The request header carrying a method's idempotency key — one key per call, the same on every delivery. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The request-init provider slot lives on the global object, not in module scope: per-package
 * installs can put several live copies of this module in one page (a package's nested
 * node_modules hosts its own), and a page-lifecycle owner setting the slot on one copy while
 * the db layer's service clients dispatch through another would be a silent no-op. One slot,
 * one page — the same anchoring reflection's SourceRepository uses.
 */
const REQUEST_INIT_PROVIDER_GLOBAL_KEY = '__proteinjs_service_requestInitProvider';

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
   * per request (e.g. keepalive only under the browser's in-flight cap).
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

  constructor(
    private servicePath: string,
    private serviceMethod: Method,
    private debouncer?: Debouncer,
    private retry?: ServiceMethodRetry
  ) {}

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
      return this.deliverUnderPolicy(args, undefined);
    }
    if (typeof this.retry === 'object' && this.retry !== null && this.retry.idempotent === true) {
      return this.deliverUnderPolicy(args, ServiceClient.mintIdempotencyKey());
    }
    if (typeof this.retry === 'number' && this.retry > 0) {
      return this.deliverWithRetries(args, this.retry);
    }
    return this.deliver(args);
  }

  /**
   * The policy for a declared method: every delivery under the first-contact watchdog; a delivery
   * that produced no response is redelivered as a fresh request after a jittered exponential pause,
   * while the budget and the total bound allow; a response of any status is never redelivered. The
   * last transport error carries the count of deliveries made. An idempotent method's key rides
   * every delivery of the call.
   */
  private async deliverUnderPolicy(args: any[], idempotencyKey: string | undefined): Promise<any> {
    const headers = idempotencyKey === undefined ? undefined : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey };
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deliver(args, READ_CONTACT_TIMEOUT_MS, headers);
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
        return await this.deliver(args);
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        await ServiceClient.pause(1000);
      }
    }
  }

  /** One delivery: serialize, send, deserialize — logged under its request number. */
  private async deliver(
    args: any[],
    contactTimeoutMs?: number,
    headers?: { [headerName: string]: string }
  ): Promise<any> {
    const serializedArgs = Serializer.serialize(args);
    const requestNumber = ServiceClient.requestCounter;
    ServiceClient.requestCounter++;
    console.groupCollapsed(`[#${requestNumber}] Sending service request: ${this.servicePath}, args:`);
    console.log(args);
    console.groupEnd();
    const serializedReturn = await this._send(this.servicePath, serializedArgs, contactTimeoutMs, headers);
    const deserializedReturn = Serializer.deserialize(serializedReturn);
    console.groupCollapsed(
      `[#${requestNumber}] Received service response: ${this.servicePath}, return:${isVoidReturnType(this.serviceMethod) ? ' (void)' : ''}`
    );
    console.log(deserializedReturn);
    console.groupEnd();

    return deserializedReturn;
  }

  /**
   * The request on the wire. With `contactTimeoutMs`, the first-contact watchdog: the request is
   * abandoned (its signal aborted — the browser drops the stalled transfer, so a redelivery is a
   * fresh request) when no response headers have arrived inside the bound. A request that produced
   * no response — the watchdog fired, or the transport rejected it — throws a
   * {@link ServiceTransportError}; a response of any status is the server's answer and is read as
   * before. `headers` are the call's own (an idempotency key), set after the ambient provider's and
   * under the reserved ones.
   */
  private async _send(
    absoluteUrl: string,
    serializedArgs: string,
    contactTimeoutMs?: number,
    headers?: { [headerName: string]: string }
  ) {
    const provided = ServiceClient.requestInitProvider()?.({
      servicePath: absoluteUrl,
      bodyBytes: ServiceClient.utf8ByteLength(serializedArgs),
    });
    const watchdog = contactTimeoutMs === undefined ? undefined : new AbortController();
    const init = (keepalive: boolean): RequestInit => ({
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
    });
    const keepalive = provided?.keepalive === true;
    let stalled = false;
    const timer =
      watchdog &&
      setTimeout(() => {
        stalled = true;
        watchdog.abort();
      }, contactTimeoutMs);
    let response: Response;
    try {
      response = await this.firstContact(absoluteUrl, init, keepalive);
    } catch (error) {
      throw stalled
        ? ServiceTransportError.stalled(absoluteUrl, contactTimeoutMs as number)
        : ServiceTransportError.failed(absoluteUrl, error);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (response.status != 200) {
      throw new Error(await this.errorMessage(response, absoluteUrl));
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }

    return body.serializedReturn;
  }

  /** The fetch that produces the response, with the ONE named fallback (the keepalive cap). */
  private async firstContact(
    absoluteUrl: string,
    init: (keepalive: boolean) => RequestInit,
    keepalive: boolean
  ): Promise<Response> {
    try {
      return await fetch(new Request(absoluteUrl, init(keepalive)));
    } catch (error) {
      // The ONE named fallback: the browser refuses a keepalive request over its in-flight cap
      // with a TypeError before anything is sent. The request is re-sent as an ordinary one —
      // the write is not lost to the cap. Any other failure (a network error) is the caller's.
      if (!keepalive || !(error instanceof TypeError)) {
        throw error;
      }
      return fetch(new Request(absoluteUrl, init(false)));
    }
  }

  /**
   * The server puts the thrown error's message in the response body ({ error: message }).
   * Older servers send no message in the body; fall back to statusText for those.
   */
  private async errorMessage(response: Response, absoluteUrl: string): Promise<string> {
    try {
      const body = await response.json();
      if (typeof body?.error === 'string' && body.error) {
        return body.error;
      }
    } catch (parseError) {
      // body was not JSON; fall through to statusText
    }

    return `Failed to process service request: ${absoluteUrl}, error: ${response.statusText}`;
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
