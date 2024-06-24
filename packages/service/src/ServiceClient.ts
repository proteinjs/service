import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Logger } from '@proteinjs/util';
import { isVoidReturnType } from './isVoidReturnType';
import { Debouncer } from './Debouncer';

export class ServiceClient {
  private static requestCounter = 1;
  private logger = new Logger(this.constructor.name, 'info', 2000);

  constructor(
    private servicePath: string,
    private serviceMethod: Method,
    private debouncer?: Debouncer
  ) {}

  async send(...args: any[]): Promise<any> {
    const sendRequest = async () => {
      const serializedArgs = Serializer.serialize(args);
      const requestNumber = ServiceClient.requestCounter;
      ServiceClient.requestCounter++;
      console.groupCollapsed(`[#${requestNumber}] Sending service request: ${this.servicePath}, args:`);
      console.log(serializedArgs);
      console.groupEnd();
      const serializedReturn = await this._send(this.servicePath, serializedArgs);
      console.groupCollapsed(
        `[#${requestNumber}] Received service response: ${this.servicePath}, return:${isVoidReturnType(this.serviceMethod) ? ' (void)' : ''}`
      );
      console.log(serializedReturn);
      console.groupEnd();

      return Serializer.deserialize(serializedReturn);
    };

    if (this.debouncer) {
      this.debouncer.debounce(sendRequest);
    } else {
      return sendRequest();
    }
  }

  private async _send(absoluteUrl: string, serializedArgs: string) {
    const request = new Request(absoluteUrl, {
      method: 'POST',
      body: serializedArgs,
      redirect: 'follow',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const response = await fetch(request);
    if (response.status != 200) {
      throw new Error(`Failed to process service request: ${absoluteUrl}, error: ${response.statusText}`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error);
    }

    return body.serializedReturn;
  }
}
