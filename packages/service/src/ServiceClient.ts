import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Debouncer } from '@proteinjs/util';
import { isVoidReturnType } from './isVoidReturnType';

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
    private retryCount: number = 0
  ) {}

  async send(...args: any[]): Promise<any> {
    const sendRequest = async () => {
      const serializedArgs = Serializer.serialize(args);
      const requestNumber = ServiceClient.requestCounter;
      ServiceClient.requestCounter++;
      console.groupCollapsed(`[#${requestNumber}] Sending service request: ${this.servicePath}, args:`);
      console.log(args);
      console.groupEnd();
      const serializedReturn = await this._send(this.servicePath, serializedArgs);
      const deserializedReturn = Serializer.deserialize(serializedReturn);
      console.groupCollapsed(
        `[#${requestNumber}] Received service response: ${this.servicePath}, return:${isVoidReturnType(this.serviceMethod) ? ' (void)' : ''}`
      );
      console.log(deserializedReturn);
      console.groupEnd();

      return deserializedReturn;
    };

    const executeWithRetry = async (fn: () => Promise<any>) => {
      const maxAttempts = 1 + this.retryCount;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (error) {
          if (attempt === maxAttempts - 1) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay before retry
        }
      }
    };

    const executeRequest = this.retryCount > 0 ? executeWithRetry : (fn: () => Promise<any>) => fn();

    if (this.debouncer) {
      return this.debouncer.debounce(() => executeRequest(sendRequest), args);
    } else {
      return executeRequest(sendRequest);
    }
  }

  private async _send(absoluteUrl: string, serializedArgs: string) {
    const provided = ServiceClient.requestInitProvider()?.({
      servicePath: absoluteUrl,
      bodyBytes: serializedArgs.length,
    });
    const init = (keepalive: boolean): RequestInit => ({
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
    let response: Response;
    try {
      response = await fetch(new Request(absoluteUrl, init(keepalive)));
    } catch (error) {
      // The ONE named fallback: the browser refuses a keepalive request over its in-flight cap
      // with a TypeError before anything is sent. The request is re-sent as an ordinary one —
      // the write is not lost to the cap. Any other failure (a network error) is the caller's.
      if (!keepalive || !(error instanceof TypeError)) {
        throw error;
      }
      response = await fetch(new Request(absoluteUrl, init(false)));
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
}
