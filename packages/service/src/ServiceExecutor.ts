import { Interface, Method } from '@proteinjs/reflection';
import { Service } from './Service';
import { Logger } from '@proteinjs/logger';
import { Serializer } from '@proteinjs/serializer';
import { ServiceAuth } from './ServiceAuth';
import { isVoidReturnType } from './isVoidReturnType';
import { EnvInfo } from '@proteinjs/server-api';

/**
 * An error whose message is safe to send to the client verbatim. ServiceRouter puts it in the
 * response body; any other error type is masked as 'Internal server error'.
 */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

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
      throw new ServiceError(`User not authorized to run service: ${this._interface.name}.${this.method.name}`);
    }

    let _return: any;
    try {
      if (this.doNotAwait()) {
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
      // Services throw plain-words errors deliberately; the message is the user-facing contract.
      // The stack stays server-side (logged above).
      throw new ServiceError(error instanceof Error ? error.message : String(error));
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

  private doNotAwait() {
    if (this.service.serviceMetadata?.doNotAwait) {
      return true;
    }

    if (this.service.serviceMetadata?.doNotAwaitMethod) {
      const methodDoNotAwait = this.service.serviceMetadata?.doNotAwaitMethod[this.method.name];
      return typeof methodDoNotAwait === 'boolean' ? methodDoNotAwait : false;
    }

    return false;
  }

  private shouldLogArgsAndReturn() {
    return !EnvInfo.isDev() || process.env.DETAILED_SERVICE_LOGS;
  }
}
