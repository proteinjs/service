import { Serializer } from '@proteinjs/serializer';
import { Logger } from '@proteinjs/util';

export class ServiceClient {
  private logger = new Logger(this.constructor.name, 'info', 2000);

  constructor(private servicePath: string) {}

  async send(...args: any[]): Promise<any> {
    const serializedArgs = Serializer.serialize(args);
    this.logger.info(`Sending service request: ${this.servicePath}, args:\n${serializedArgs}`);
    const serializedReturn = await this._send(this.servicePath, serializedArgs);
    this.logger.info(`Received service response: ${this.servicePath}, return:\n${serializedReturn}`);
    return Serializer.deserialize(serializedReturn);
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
    if (response.status != 200)
      throw new Error(`Failed to process service request: ${absoluteUrl}, error: ${response.statusText}`);

    const body = await response.json();
    if (body.error) throw new Error(body.error);

    return body.serializedReturn;
  }
}
