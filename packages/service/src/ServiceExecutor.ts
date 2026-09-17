import { randomBytes } from 'crypto';
import { Interface, Method } from '@proteinjs/reflection';
import { Service } from './Service';
import { Logger } from '@proteinjs/logger';
import { Serializer } from '@proteinjs/serializer';
import { ServiceAuth } from './ServiceAuth';
import { isVoidReturnType } from './isVoidReturnType';

/**
 * An error whose message is safe to send to the client verbatim. ServiceRouter puts it in the
 * response body with `status` (400 unless the error names another); any other error type is
 * masked as 'Internal server error'.
 */
export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** The HTTP statuses a refusal may answer with; 400 when the refusal names none. */
export type ServiceRefusalStatus = 400 | 403 | 404 | 422;

/**
 * A service method's deliberate "no": the caller asked for something the method will not do — a
 * record that is absent or outside their reach, an action they may not take, an argument the
 * method rejects. The message is the answer and crosses the wire verbatim (ServiceRouter answers
 * with `status`). Nothing failed, so ServiceExecutor logs a refusal as a warning with no stack
 * instead of an error entry — a log pipeline that files error entries as incident reports never
 * sees a refusal.
 *
 * Name-tagged rather than relying on `instanceof`: the prototype chain is unreliable across
 * package compile targets (the same reason ServiceRouter checks `name` for ServiceError). A
 * subclass keeps the name; its identity is its message.
 */
export class ServiceRefusal extends Error {
  constructor(
    message: string,
    public readonly status: ServiceRefusalStatus = 400
  ) {
    super(message);
    this.name = 'ServiceRefusal';
  }
}

export const isServiceRefusal = (error: unknown): error is ServiceRefusal =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'ServiceRefusal';

/**
 * Log shape contract: service args and returns are user content (chat/thought text joined to
 * user identity), and info level is what ships to Cloud Logging — so info entries carry the
 * summary envelope only (method identity, requestId, durationMs, and payload SHAPES: types,
 * counts, byte sizes). Full arg/return dumps live at debug (`LOG_LEVEL=debug` to turn on),
 * correlated to their info entries by requestId. No env flag re-routes payload contents to info.
 */
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
    const requestId = randomBytes(4).toString('hex');
    const startTime = Date.now();
    this.logger.info({
      message: `Calling`,
      obj: { functionName: this.serviceMethodName, requestId, args: this.describeArgs(deserializedArgs) },
    });
    this.logger.debug({
      message: `Calling (args)`,
      obj: { functionName: this.serviceMethodName, requestId, args: deserializedArgs },
    });
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
        Promise.resolve(method(...deserializedArgs)).catch((error: any) =>
          this.logThrow(error, requestId, startTime, true)
        );
      } else {
        _return = await method(...deserializedArgs);
      }
    } catch (error: any) {
      this.logThrow(error, requestId, startTime, false);
      if (isServiceRefusal(error)) {
        // The refusal's own status rides to the router; the message is the answer.
        throw new ServiceError(error.message, error.status);
      }
      // Services throw plain-words errors deliberately; the message is the user-facing contract.
      // The stack stays server-side (logged above).
      throw new ServiceError(error instanceof Error ? error.message : String(error));
    }

    if (isVoidReturnType(this.method)) {
      this.logger.info({
        message: `Returning (void)`,
        obj: { functionName: this.serviceMethodName, requestId, durationMs: Date.now() - startTime, return: 'void' },
      });
      return undefined;
    }

    const serializedReturn = Serializer.serialize(_return);
    this.logger.info({
      message: `Returning`,
      obj: {
        functionName: this.serviceMethodName,
        requestId,
        durationMs: Date.now() - startTime,
        return: this.describeValue(_return),
      },
    });
    this.logger.debug({
      message: `Returning (value)`,
      obj: { functionName: this.serviceMethodName, requestId, return: _return },
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
   * A throw from the service method, by kind: a refusal (ServiceRefusal) is the method's answer,
   * so it is logged as a warning with the envelope and its status — no stack, and never an error
   * entry; anything else is a failure and keeps the error entry with the error and its stack.
   */
  private logThrow(error: any, requestId: string, startTime: number, detached: boolean) {
    const phase = detached ? ' (doNotAwait, after the client response)' : '';
    const obj = { functionName: this.serviceMethodName, requestId, durationMs: Date.now() - startTime };
    if (isServiceRefusal(error)) {
      this.logger.warn({ message: `Refused${phase}: ${error.message}`, obj: { ...obj, status: error.status } });
      return;
    }
    this.logger.error({ message: `Failed${phase}`, error, obj });
  }

  /** One shape summary per argument. */
  private describeArgs(args: any[]): string[] {
    return args.map((arg) => this.describeValue(arg));
  }

  /**
   * A payload-free shape description: type, element/key counts, and serialized byte size.
   * Never values, key names, or any other content — these summaries are all that may reach
   * info-level logs.
   */
  private describeValue(value: any): string {
    if (value === null) {
      return 'null';
    }

    if (value === undefined) {
      return 'undefined';
    }

    if (Array.isArray(value)) {
      return `Array(${value.length} items, ${this.byteSize(value)})`;
    }

    if (typeof value === 'string') {
      return `string(${Buffer.byteLength(value, 'utf8')}B)`;
    }

    if (typeof value === 'object') {
      const className = value.constructor?.name ?? 'Object';
      return `${className}(${Object.keys(value).length} keys, ${this.byteSize(value)})`;
    }

    // number, boolean, bigint, function, symbol: the type alone — a value can be user content.
    return typeof value;
  }

  private byteSize(value: any): string {
    try {
      return `${Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')}B`;
    } catch {
      // Circular or otherwise unserializable — the size is not worth a throw.
      return '?B';
    }
  }
}
