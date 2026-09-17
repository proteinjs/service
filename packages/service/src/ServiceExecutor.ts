import { randomBytes } from 'crypto';
import { Interface, Method } from '@proteinjs/reflection';
import { Service } from './Service';
import { Logger } from '@proteinjs/logger';
import { Serializer } from '@proteinjs/serializer';
import { ServiceAuth } from './ServiceAuth';
import { isVoidReturnType } from './isVoidReturnType';

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

/**
 * A designed outcome of a service call that the service reports by throwing: the record is gone
 * or not shared with the caller, the action was already taken, the request is declined in the
 * caller's own words. The client renders it and nothing is broken — so it is not an error report.
 * Throw it (or a subclass) from a service method: ServiceExecutor writes the refusal at warn with
 * its usual envelope and the outcome's message, never a stack, and rethrows it as a ServiceError so
 * the message crosses the wire exactly like any other service throw. A plain Error stays a failure
 * and keeps its error entry with the stack.
 *
 * Recognized by name, never by prototype (an Error subclass does not keep its prototype chain
 * across every compile target and bundler): a subclass must leave the name as it is.
 */
export class ExpectedServiceOutcome extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectedServiceOutcome';
  }
}

export const isExpectedServiceOutcome = (error: unknown): error is ExpectedServiceOutcome =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ExpectedServiceOutcome';

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
        Promise.resolve(method(...deserializedArgs)).catch((error: any) => {
          this.logFailure(error, requestId, startTime, ' (doNotAwait, after the client response)');
        });
      } else {
        _return = await method(...deserializedArgs);
      }
    } catch (error: any) {
      this.logFailure(error, requestId, startTime);
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
   * The log entry for a throw out of the service method. An expected outcome (see
   * {@link ExpectedServiceOutcome}) is a refusal the service designed for — it is written at warn
   * with the envelope and the outcome's message, never a stack: an error entry reports something
   * broken, and nothing is. Anything else is a failure and keeps its error entry with the stack.
   */
  private logFailure(error: any, requestId: string, startTime: number, suffix = '') {
    const obj = { functionName: this.serviceMethodName, requestId, durationMs: Date.now() - startTime };
    if (isExpectedServiceOutcome(error)) {
      this.logger.warn({ message: `Refused${suffix}`, obj: { ...obj, outcome: error.message } });
      return;
    }

    this.logger.error({ message: `Failed${suffix}`, error, obj });
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
