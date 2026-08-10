import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Debouncer } from '@proteinjs/util';
import { isVoidReturnType } from './isVoidReturnType';

/** See {@link ServiceClient.setDefaultHeadersProvider}. */
export type ServiceRequestHeadersProvider = () => { [headerName: string]: string };

/**
 * Header marking a service request as BACKGROUND: machine-initiated (a timer tick, a reconnect
 * probe, a telemetry flush) rather than caused by a person doing something. Attached by
 * {@link ServiceClient.markBackground} — the one owner of the marker in the client fetch layer.
 * Server-side dev tooling reads it to tell machine chatter from real activity (e.g. the
 * serve-package request-activity hold, which must not treat a merely-open tab's polls as a
 * reason to defer restarts); production servers ignore it.
 */
export const BACKGROUND_REQUEST_HEADER = 'x-background-request';

export class ServiceClient {
  private static requestCounter = 1;

  /**
   * Depth of the currently-executing {@link markBackground} scope. A synchronous counter is
   * race-free in single-threaded JS: it is >0 exactly while a marked callback's SYNCHRONOUS
   * code runs, so a user-initiated request can never interleave into the scope and get
   * mis-marked.
   */
  private static backgroundDepth = 0;

  /**
   * Run `fn` as BACKGROUND work: every service request ISSUED during its synchronous execution
   * carries {@link BACKGROUND_REQUEST_HEADER}. Wrap the body of the timer/reconnect callback —
   * the source of periodicity — not each call site inside it.
   *
   * The scope is deliberately synchronous: it ends when `fn` returns, NOT when a promise it
   * returns settles, so issue the request in the callback's synchronous prologue. Calling a
   * service method counts — the marker is sampled at {@link send} entry (before any await), so
   * a debounced or retried send stays marked even though its fetch runs later.
   */
  static markBackground<T>(fn: () => T): T {
    ServiceClient.backgroundDepth++;
    try {
      return fn();
    } finally {
      ServiceClient.backgroundDepth--;
    }
  }

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

  constructor(
    private servicePath: string,
    private serviceMethod: Method,
    private debouncer?: Debouncer,
    private retryCount: number = 0
  ) {}

  async send(...args: any[]): Promise<any> {
    // Sampled at call time, before any await: the markBackground scope is synchronous, and a
    // debounced/retried send must keep the marking of the moment it was issued.
    const background = ServiceClient.backgroundDepth > 0;
    const sendRequest = async () => {
      const serializedArgs = Serializer.serialize(args);
      const requestNumber = ServiceClient.requestCounter;
      ServiceClient.requestCounter++;
      console.groupCollapsed(`[#${requestNumber}] Sending service request: ${this.servicePath}, args:`);
      console.log(args);
      console.groupEnd();
      const serializedReturn = await this._send(this.servicePath, serializedArgs, background);
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

  private async _send(absoluteUrl: string, serializedArgs: string, background: boolean) {
    const request = new Request(absoluteUrl, {
      method: 'POST',
      body: serializedArgs,
      redirect: 'follow',
      credentials: 'same-origin',
      headers: {
        // Provider-supplied client-context headers first so reserved headers always win.
        ...(ServiceClient.defaultHeadersProvider ? ServiceClient.defaultHeadersProvider() : {}),
        ...(background ? { [BACKGROUND_REQUEST_HEADER]: '1' } : {}),
        'Content-Type': 'application/json',
      },
    });
    const response = await fetch(request);
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
