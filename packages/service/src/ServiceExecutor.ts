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
    this.logger.info({ message: `Calling`, obj: this.callLogContext(deserializedArgs) });
    if (!ServiceAuth.canRunService(this.service, this.method, deserializedArgs)) {
      throw new ServiceError(`User not authorized to run service: ${this._interface.name}.${this.method.name}`);
    }

    let _return: any;
    try {
      if (this.doNotAwait()) {
        // Fire-and-forget: the client gets its response immediately and nobody ever awaits this
        // promise, so the executor terminally owns its rejections — unobserved, they are unhandled
        // promise rejections and node kills the server process. Log with method identity and drop.
        // Synchronous throws happen before the dispatch detaches and still propagate to the catch
        // below (ServiceError -> 400).
        Promise.resolve(method(...deserializedArgs)).catch((error: any) => {
          this.logger.error({
            message: `Failed (doNotAwait, after the client response)`,
            error,
            obj: this.callLogContext(deserializedArgs),
          });
        });
      } else {
        _return = await method(...deserializedArgs);
      }
    } catch (error: any) {
      this.logger.error({
        message: `Failed`,
        error,
        obj: this.callLogContext(deserializedArgs),
      });
      // Services throw plain-words errors deliberately; the message is the user-facing contract.
      // The stack stays server-side (logged above).
      throw new ServiceError(error instanceof Error ? error.message : String(error));
    }

    if (isVoidReturnType(this.method)) {
      this.logger.info({
        message: `Returning (void)`,
        obj: { functionName: this.serviceMethodName, return: 'void' },
      });
      return undefined;
    }

    const serializedReturn = Serializer.serialize(_return);
    this.logger.info({
      message: `Returning`,
      obj: this.shouldLogArgsAndReturn()
        ? { functionName: this.serviceMethodName, return: _return }
        : { functionName: this.serviceMethodName },
    });
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

  /**
   * Log context for a call-shaped entry (Calling / Failed). Args ride along only when verbose
   * logging is on: service args and returns are user content (chat/thought text joined to user
   * identity), and in prod they must never reach Cloud Logging — prod entries carry the
   * metadata envelope (method identity, and the error on failures) only.
   */
  private callLogContext(deserializedArgs: any[]) {
    return this.shouldLogArgsAndReturn()
      ? { functionName: this.serviceMethodName, args: deserializedArgs }
      : { functionName: this.serviceMethodName };
  }

  /** Verbose args/return logging is dev-only, unless DETAILED_SERVICE_LOGS is explicitly set. */
  private shouldLogArgsAndReturn() {
    return EnvInfo.isDev() || !!process.env.DETAILED_SERVICE_LOGS;
  }
}
