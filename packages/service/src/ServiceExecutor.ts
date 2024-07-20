import { Interface, Method } from '@proteinjs/reflection';
import { Service } from './Service';
import { Logger } from '@proteinjs/util';
import { Serializer } from '@proteinjs/serializer';
import { ServiceAuth } from './ServiceAuth';
import { isVoidReturnType } from './isVoidReturnType';

export class ServiceExecutor {
  private logger: Logger;
  public deserializedArgs: any;
  constructor(
    public service: Service,
    private _interface: Interface,
    private method: Method
  ) {
    this.logger = new Logger(`${_interface.name}.${method.name}`, undefined, 2500);
  }

  async execute(requestBody: any): Promise<any> {
    const method = this.service[this.method.name].bind(this.service);
    const deserializedArgs = Serializer.deserialize(requestBody);
    this.logger.info(`Executing with args:\n${JSON.stringify(deserializedArgs, null, 2)}`);
    if (!ServiceAuth.canRunService(this.service, this.method, deserializedArgs)) {
      const error = `User not authorized to run service: ${this._interface.name}.${this.method.name}`;
      throw new Error(error);
    }

    let _return: any;
    try {
      if (this.service.serviceMetadata?.doNotAwait) {
        method(...deserializedArgs);
      } else {
        _return = await method(...deserializedArgs);
      }
    } catch (error: any) {
      this.logger.error(`Failed with args:\n${JSON.stringify(requestBody, null, 2)}`);
      throw error;
    }

    if (isVoidReturnType(this.method)) {
      this.logger.info(`Returning: (void)`);
      return undefined;
    }

    const serializedReturn = Serializer.serialize(_return);
    this.logger.info(`Returning:\n${JSON.stringify(_return, null, 2)}`);
    return serializedReturn;
  }
}
