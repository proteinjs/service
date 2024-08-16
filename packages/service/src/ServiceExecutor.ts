import { Interface, Method } from '@proteinjs/reflection';
import { Service } from './Service';
import { Logger } from '@proteinjs/logger';
import { Serializer } from '@proteinjs/serializer';
import { ServiceAuth } from './ServiceAuth';
import { isVoidReturnType } from './isVoidReturnType';
import { EnvInfo } from '@proteinjs/server-api';

export class ServiceExecutor {
  private logger: Logger;
  public deserializedArgs: any;
  private serviceMethodName: string;
  constructor(
    public service: Service,
    private _interface: Interface,
    private method: Method
  ) {
    this.serviceMethodName = `${_interface.name}.${method.name}`;
    this.logger = new Logger({ name: this.serviceMethodName });
  }

  async execute(requestBody: any): Promise<any> {
    const method = this.service[this.method.name].bind(this.service);
    const deserializedArgs = Serializer.deserialize(requestBody);
    if (this.shouldLogArgsAndReturn()) {
      this.logger.info({ message: `Calling`, obj: { functionName: this.serviceMethodName, args: deserializedArgs } });
    }
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
      this.logger.error({
        message: `Failed`,
        error,
        obj: { functionName: this.serviceMethodName, args: deserializedArgs },
      });
      throw error;
    }

    if (isVoidReturnType(this.method)) {
      if (this.shouldLogArgsAndReturn()) {
        this.logger.info({
          message: `Returning (void)`,
          obj: { functionName: this.serviceMethodName, return: 'void' },
        });
      }
      return undefined;
    }

    const serializedReturn = Serializer.serialize(_return);
    if (this.shouldLogArgsAndReturn()) {
      this.logger.info({ message: `Returning`, obj: { functionName: this.serviceMethodName, return: _return } });
    }
    return serializedReturn;
  }

  private shouldLogArgsAndReturn() {
    return !EnvInfo.isDev() || process.env.DETAILED_SERVICE_LOGS;
  }
}
