/**
 * A service call that produced NO response. The transport rejected the request — the network
 * refused it before it was sent, or the connection died under it — or, for a method declared a
 * read, the first-contact watchdog found no response headers inside its bound and abandoned the
 * request. What the server made of the request is UNKNOWN: `reachedServer` is false because
 * contact was never confirmed, not because the request is known to have been dropped. A response
 * of any status is never this error: the server answered, and its answer is the caller's to read.
 *
 * `attempts` counts the deliveries the client made before giving up (a declared read's one
 * redelivery makes it 2); `stalled` says the watchdog abandoned the request rather than the
 * transport rejecting it. Read by shape ({@link ServiceTransportError.is}), so an error thrown
 * through a duplicate copy of this package is still one.
 */
export class ServiceTransportError extends Error {
  private static readonly NAME = 'ServiceTransportError';
  /** The service path the request was for (`/service/<package>/<Service>/<method>`). */
  readonly servicePath: string;
  /** False: contact was never confirmed (see the class doc). */
  readonly reachedServer: boolean;
  /** True when the first-contact watchdog abandoned the request; false when the transport rejected it. */
  readonly stalled: boolean;
  /** The deliveries made before this error was thrown — the redelivery loop stamps it. */
  attempts: number;
  /** What the transport threw, when it threw (absent for a stall). */
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { servicePath: string; reachedServer: boolean; stalled: boolean; attempts?: number; cause?: unknown }
  ) {
    super(message);
    this.name = ServiceTransportError.NAME;
    Object.setPrototypeOf(this, ServiceTransportError.prototype);
    this.servicePath = options.servicePath;
    this.reachedServer = options.reachedServer;
    this.stalled = options.stalled;
    this.attempts = options.attempts ?? 1;
    this.cause = options.cause;
  }

  /** The first-contact watchdog abandoned the request: no response headers inside `boundMs`. */
  static stalled(servicePath: string, boundMs: number): ServiceTransportError {
    return new ServiceTransportError(
      `No response from ${servicePath} within ${boundMs} ms — the request may never have left this client`,
      { servicePath, reachedServer: false, stalled: true }
    );
  }

  /** The transport rejected the request outright (a network error, a refused or reset connection). */
  static failed(servicePath: string, cause: unknown): ServiceTransportError {
    return new ServiceTransportError(
      `Could not reach the server for ${servicePath}: ${ServiceTransportError.messageOf(cause)}`,
      { servicePath, reachedServer: false, stalled: false, cause }
    );
  }

  /** Whether `error` is a transport error: the error's name and its `reachedServer` flag. */
  static is(error: unknown): error is ServiceTransportError {
    const candidate = error as { name?: unknown; reachedServer?: unknown } | null | undefined;
    return candidate?.name === ServiceTransportError.NAME && typeof candidate.reachedServer === 'boolean';
  }

  /**
   * Did this call die before contact was confirmed? The one question a surface asks before it
   * offers a retry in place of what it could not load.
   */
  static isNotReached(error: unknown): boolean {
    return ServiceTransportError.is(error) && error.reachedServer === false;
  }

  private static messageOf(cause: unknown): string {
    if (cause instanceof Error) {
      return cause.message;
    }
    return String(cause);
  }
}
