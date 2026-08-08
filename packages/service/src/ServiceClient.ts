import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Debouncer } from '@proteinjs/util';
import { isVoidReturnType } from './isVoidReturnType';

/** See {@link ServiceClient.setDefaultHeadersProvider}. */
export type ServiceRequestHeadersProvider = () => { [headerName: string]: string };

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
    const request = new Request(absoluteUrl, {
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
