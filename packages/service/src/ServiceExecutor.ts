import { randomBytes } from 'crypto';
import { Interface, Method } from '@proteinjs/reflection';
import { AuthenticatedUserRepo, getAuthenticatedUserRepo } from '@proteinjs/user-auth';
import { Service } from './Service';
import { Logger } from '@proteinjs/logger';
import { Serializer } from '@proteinjs/serializer';
import { ServiceAuth } from './ServiceAuth';
import { isVoidReturnType } from './isVoidReturnType';
import { ServiceRefusal } from './ServiceRefusal';
import { IdempotencyLedger, InProcessIdempotencyLedger } from './IdempotencyLedger';
import { InProcessReadCoalescer } from './ReadCoalescer';

/** What a request carries beside its body that the executor reads. */
export type ServiceExecutionOptions = {
  /** The client-minted key of a call declared idempotent (see the client's `IDEMPOTENCY_KEY_HEADER`); absent otherwise. */
  idempotencyKey?: string;
  /**
   * True when the client declared the delivery a read (see the client's `DECLARED_READ_HEADER`):
   * identical reads from one caller that arrive while one is running share that run (see
   * `InProcessReadCoalescer`). Absent for every other request — a write never coalesces.
   */
  declaredRead?: boolean;
  /**
   * The request's id as the server minted it and echoed it on the response (`X-Request-Id`), so the
   * executor's lines carry the id every other line of the request carries — the load balancer's
   * line, the server's Started/Finished pair and the method's own lines join on it. A host that
   * minted no id hands none, and the executor mints one of its own for its lines.
   */
  requestId?: string;
};

/**
 * The environment flag a deployment sets on a server process that runs beside other processes of
 * the same deployment (several replicas behind one address): `SERVICE_MULTI_PROCESS=true`. Read
 * once, when the executor loads. Under it the in-process idempotency ledger is not a ledger at all —
 * a replay landing on another process finds no record — so a keyed request is refused until a
 * shared ledger is registered (see {@link ServiceExecutor.execute}). Unset, the process is taken to
 * be the only one, and the in-process ledger serves.
 */
export const MULTI_PROCESS_ENV = 'SERVICE_MULTI_PROCESS';

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
 * Log shape contract: service args and returns are user content (chat/thought text joined to
 * user identity), and info level is what ships to Cloud Logging — so info entries carry the
 * summary envelope only (method identity, requestId, durationMs, and payload SHAPES: types,
 * counts, byte sizes). Full arg/return dumps live at debug (`LOG_LEVEL=debug` to turn on),
 * correlated to their info entries by requestId. No env flag re-routes payload contents to info.
 * A thrown `ServiceRefusal` (a refusal made on purpose) is a WARN entry with its status, never an
 * ERROR; every other thrown error is a failure, logged at ERROR.
 *
 * The answer is serialized ONCE. The `Returning` line's byte count is read off the string the
 * serializer produced — never a second pass over the value — and the string itself is what the
 * router writes as the body (see `ServiceRouter`). A large document answer once crossed three
 * serialization passes on the event loop per return; it crosses one.
 */
export class ServiceExecutor {
  /**
   * The one ledger every executor records idempotent calls in — in-process until a deployment of
   * several server processes registers the ledger they share (see {@link setIdempotencyLedger}).
   */
  private static idempotencyLedger: IdempotencyLedger = new InProcessIdempotencyLedger();

  /**
   * The one seat every executor joins declared reads through: a process's own, by design (see
   * `InProcessReadCoalescer` — it holds runs in flight and nothing else, so there is nothing to share).
   */
  private static readCoalescer = new InProcessReadCoalescer();

  /** Whether this process declared itself one of several ({@link MULTI_PROCESS_ENV}) — read once, at load. */
  private static multiProcess: boolean = ServiceExecutor.declaredMultiProcess(process.env);

  /** The caller's identity for the ledger's scope — the same repo every auth gate reads. */
  private static userRepo?: AuthenticatedUserRepo;

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

  /**
   * ONE slot by design: one ledger per server. A deployment that runs several server processes
   * registers a ledger they share, so a redelivered idempotent call lands once whichever process
   * the replay reaches; the default is the in-process ledger (one process).
   */
  static setIdempotencyLedger(ledger: IdempotencyLedger): void {
    ServiceExecutor.idempotencyLedger = ledger;
  }

  /**
   * Runs the method on the request's body. A request carrying an idempotency key runs through the
   * ledger: once per (caller, method, key) inside the key's lifetime, a replay answered with the
   * recorded result — a redelivered call declared idempotent lands once.
   *
   * On a process that declared itself one of several ({@link MULTI_PROCESS_ENV}) while the
   * registered ledger is still the in-process one, a keyed request is REFUSED — a 501 answer, an
   * error log entry, the method never run. The in-process ledger cannot see another process's
   * record, so running the method would be deduplication by luck; the refusal fails loudly where a
   * silent duplicate would otherwise wait for its first multi-process redelivery.
   *
   * A request the client declared a read joins a run of the same read already in flight for the
   * same caller, when there is one (see `InProcessReadCoalescer`), and runs the method otherwise.
   * Every other request runs the method.
   */
  async execute(requestBody: any, options: ServiceExecutionOptions = {}): Promise<any> {
    const key = options.idempotencyKey;
    if (key !== undefined && key !== '') {
      if (ServiceExecutor.multiProcess && ServiceExecutor.idempotencyLedger instanceof InProcessIdempotencyLedger) {
        this.logger.error({
          message: 'Refused: keyed call without a shared idempotency ledger',
          obj: { functionName: this.serviceMethodName, status: 501 },
        });
        throw new ServiceRefusal(
          501,
          `This server cannot deduplicate a keyed call: it runs as one of several processes (${MULTI_PROCESS_ENV}) and no shared idempotency ledger is registered (ServiceExecutor.setIdempotencyLedger), so a redelivery could run the method again on another process — the call was not run.`
        );
      }
      const scope = {
        principal: ServiceExecutor.principal(),
        servicePath: `${this._interface.qualifiedName}.${this.method.name}`,
        key,
      };
      return ServiceExecutor.idempotencyLedger.once(scope, () => this.run(requestBody, options.requestId));
    }
    if (options.declaredRead === true) {
      return this.joinOrRun(requestBody, options.requestId);
    }
    return this.run(requestBody, options.requestId);
  }

  /**
   * A declared read: the run in flight for the same caller, method and arguments is joined — this
   * delivery logs its own `Calling` and `Returning` lines, marked `coalesced`, and settles exactly as
   * the run it joined settles — or the method runs and is recorded in flight until it settles.
   */
  private async joinOrRun(requestBody: any, handedRequestId: string | undefined): Promise<any> {
    const scope = {
      principal: ServiceExecutor.principal(),
      servicePath: `${this._interface.qualifiedName}.${this.method.name}`,
      body: typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody),
    };
    const { settled, joined } = ServiceExecutor.readCoalescer.join(scope, () => this.run(requestBody, handedRequestId));
    if (!joined) {
      return settled;
    }

    const requestId = ServiceExecutor.requestId(handedRequestId);
    const startTime = Date.now();
    this.logger.info({
      message: `Calling (joined a run in flight)`,
      obj: { functionName: this.serviceMethodName, requestId, coalesced: true },
    });
    let serializedReturn: string | undefined;
    try {
      serializedReturn = await settled;
    } catch (error: any) {
      // The run's own failure or refusal was logged by the run; this delivery's line names its share.
      this.logger.warn({
        message: `Failed (joined a run in flight)`,
        obj: { functionName: this.serviceMethodName, requestId, durationMs: Date.now() - startTime, coalesced: true },
      });
      throw error;
    }
    this.logger.info({
      message: `Returning`,
      obj: {
        functionName: this.serviceMethodName,
        requestId,
        durationMs: Date.now() - startTime,
        bytes: ServiceExecutor.byteLength(serializedReturn),
        coalesced: true,
      },
    });
    return serializedReturn;
  }

  private async run(requestBody: any, handedRequestId: string | undefined): Promise<any> {
    const method = this.service[this.method.name].bind(this.service);
    const deserializedArgs = Serializer.deserialize(requestBody);
    const requestId = ServiceExecutor.requestId(handedRequestId);
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
          if (ServiceRefusal.is(error)) {
            // The same refusal, settled after the client's answer: the log is all it reaches.
            this.logRefusal(error, requestId, startTime);
            return;
          }
          this.logger.error({
            message: `Failed (doNotAwait, after the client response)`,
            error,
            obj: { functionName: this.serviceMethodName, requestId, durationMs: Date.now() - startTime },
          });
        });
      } else {
        _return = await method(...deserializedArgs);
      }
    } catch (error: any) {
      if (ServiceRefusal.is(error)) {
        // A refusal the operation made on purpose, not a failure: the router answers with its
        // status and message.
        this.logRefusal(error, requestId, startTime);
        throw error;
      }

      this.logger.error({
        message: `Failed`,
        error,
        obj: { functionName: this.serviceMethodName, requestId, durationMs: Date.now() - startTime },
      });
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

    const serializeStart = Date.now();
    const serializedReturn: string | undefined = Serializer.serialize(_return);
    const serializeMs = Date.now() - serializeStart;
    this.logger.info({
      message: `Returning`,
      obj: {
        functionName: this.serviceMethodName,
        requestId,
        durationMs: Date.now() - startTime,
        serializeMs,
        bytes: ServiceExecutor.byteLength(serializedReturn),
        coalesced: false,
        return: this.describeReturn(_return, serializedReturn),
      },
    });
    this.logger.debug({
      message: `Returning (value)`,
      obj: { functionName: this.serviceMethodName, requestId, return: _return },
    });
    return serializedReturn;
  }

  /** The caller's email, read through the registered user repo; empty when no repo is registered. */
  private static principal(): string {
    if (!ServiceExecutor.userRepo) {
      ServiceExecutor.userRepo = getAuthenticatedUserRepo();
    }
    return ServiceExecutor.userRepo?.getUser().email ?? '';
  }

  /** The id the host minted for the request; one of the executor's own when the host minted none. */
  private static requestId(handed: string | undefined): string {
    return handed ?? randomBytes(4).toString('hex');
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
   * A refusal's one log entry, whichever path settled it (awaited, or detached after the client's
   * answer): WARN, with its status and the operation's name — never the arguments, nor the message
   * (a refusal names what it refused, often an argument).
   */
  private logRefusal(refusal: ServiceRefusal, requestId: string, startTime: number): void {
    this.logger.warn({
      message: `Refused`,
      obj: {
        functionName: this.serviceMethodName,
        requestId,
        status: refusal.status,
        durationMs: Date.now() - startTime,
      },
    });
  }

  /** One shape summary per argument. */
  private describeArgs(args: any[]): string[] {
    return args.map((arg) => this.describeValue(arg));
  }

  /**
   * A payload-free shape description: type and element/key counts, a string's byte size. Never
   * values, key names, or any other content — these summaries are all that may reach info-level
   * logs. An object's or array's byte size is not measured here: that would be a serialization
   * pass of its own over the value.
   */
  private describeValue(value: any): string {
    if (value === null) {
      return 'null';
    }

    if (value === undefined) {
      return 'undefined';
    }

    if (Array.isArray(value)) {
      return `Array(${value.length} items)`;
    }

    if (typeof value === 'string') {
      return `string(${Buffer.byteLength(value, 'utf8')}B)`;
    }

    if (typeof value === 'object') {
      const className = value.constructor?.name ?? 'Object';
      return `${className}(${Object.keys(value).length} keys)`;
    }

    // number, boolean, bigint, function, symbol: the type alone — a value can be user content.
    return typeof value;
  }

  /**
   * The return's shape description, with the byte size of the answer as it leaves — read off the
   * serialized string the answer IS, never a second serialization of the value.
   */
  private describeReturn(value: any, serialized: string | undefined): string {
    const bytes = `${ServiceExecutor.byteLength(serialized)}B`;
    if (value === null) {
      return 'null';
    }

    if (value === undefined) {
      return 'undefined';
    }

    if (Array.isArray(value)) {
      return `Array(${value.length} items, ${bytes})`;
    }

    if (typeof value === 'string') {
      return `string(${bytes})`;
    }

    if (typeof value === 'object') {
      const className = value.constructor?.name ?? 'Object';
      return `${className}(${Object.keys(value).length} keys, ${bytes})`;
    }

    return typeof value;
  }

  /** The bytes a serialized answer puts on the wire (UTF-8); none for an answer with no text. */
  private static byteLength(serialized: string | undefined): number {
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  }

  /** The flag's reading: `true` or `1` declares the process one of several; anything else does not. */
  private static declaredMultiProcess(env: { [name: string]: string | undefined }): boolean {
    const value = env[MULTI_PROCESS_ENV]?.trim().toLowerCase();
    return value === 'true' || value === '1';
  }
}
