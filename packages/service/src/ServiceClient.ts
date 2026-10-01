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
 * inferred from a method's name:
 *
 * - `'read'`: the method reads and answers; a second delivery returns the same truth and costs
 *   the server nothing it would not have done. The client bounds the call's first contact
 *   ({@link READ_CONTACT_TIMEOUT_MS}) and redelivers a transport failure once; a server's answer
 *   — a value or a verdict of any status — is never redelivered.
 * - a number: the earlier shape — the delivery is retried that many times after ANY failure, a
 *   server's verdict included, one second apart. Kept for the methods declared with it.
 *
 * Undeclared (the default): one delivery, no first-contact bound. A method that may be doing long
 * work on the server before it answers, or applying a change a second delivery would apply again,
 * must stay undeclared.
 */
export type ServiceMethodRetry = 'read' | number;

/**
 * The first-contact bound for a method declared a read: when no response headers have arrived
 * inside it, the request is abandoned and the call rejects with a {@link ServiceTransportError}
 * (`reachedServer: false`, `stalled: true`) — after the one redelivery below.
 *
 * Why 15 s: a read answers in one round trip — the server runs its query and replies, hundreds of
 * milliseconds end to end on a healthy path, and a serving path's own latency alerting fires well
 * under this (a consuming application alerts at a p95 of 2 s). A request with no headers after 15 s
 * is not waiting on a slow server; it is sitting in a client-side connection that has stopped
 * carrying bytes — a phone's pooled connection was observed holding a read for three minutes before
 * the browser gave up on it, the surface behind the read blank the whole time. 15 s is also the
 * first-contact bound a consuming application's streaming send already uses, so a client keeps one
 * first-contact clock. Declared reads only: abandoning a method that may legitimately answer after
 * long work would report an unconfirmed delivery for work the server was doing.
 */
export const READ_CONTACT_TIMEOUT_MS = 15_000;

/**
 * The pause before a declared read's one redelivery. Short because the redelivery is blind — a
 * read has no evidence channel to consult before trying again, and a surface is empty meanwhile.
 */
export const READ_REDELIVERY_DELAY_MS = 1_000;

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
      return this.deliverRead(args);
    }
    if (typeof this.retry === 'number' && this.retry > 0) {
      return this.deliverWithRetries(args, this.retry);
    }
    return this.deliver(args);
  }

  /**
   * A method declared a read: delivered under the first-contact bound; a transport failure — the
   * watchdog abandoning a stalled request, or the transport rejecting it outright — is redelivered
   * ONCE, after {@link READ_REDELIVERY_DELAY_MS}, as a fresh request. A second failure is the
   * caller's, its `attempts` stamped. A response of any status is never redelivered: the server
   * answered.
   */
  private async deliverRead(args: any[]): Promise<any> {
    try {
      return await this.deliver(args, READ_CONTACT_TIMEOUT_MS);
    } catch (error) {
      if (!ServiceTransportError.is(error)) {
        throw error;
      }
      await ServiceClient.pause(READ_REDELIVERY_DELAY_MS);
      try {
        return await this.deliver(args, READ_CONTACT_TIMEOUT_MS);
      } catch (redeliveryError) {
        if (ServiceTransportError.is(redeliveryError)) {
          redeliveryError.attempts = 2;
        }
        throw redeliveryError;
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
  private async deliver(args: any[], contactTimeoutMs?: number): Promise<any> {
    const serializedArgs = Serializer.serialize(args);
    const requestNumber = ServiceClient.requestCounter;
    ServiceClient.requestCounter++;
    console.groupCollapsed(`[#${requestNumber}] Sending service request: ${this.servicePath}, args:`);
    console.log(args);
    console.groupEnd();
    const serializedReturn = await this._send(this.servicePath, serializedArgs, contactTimeoutMs);
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
   * before.
   */
  private async _send(absoluteUrl: string, serializedArgs: string, contactTimeoutMs?: number) {
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

  private static pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
