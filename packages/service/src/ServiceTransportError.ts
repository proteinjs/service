/**
 * A service call whose answer was never read. Either the call produced NO response — the
 * transport rejected the request (the network refused it before it was sent, or the connection
 * died under it), or a declared method's first-contact watchdog found no response headers inside
 * its bound and abandoned the request — or the response's headers arrived and its BODY did not:
 * the connection died or stopped carrying bytes after the headers, inside the body's own bound.
 *
 * `reachedServer` tells the two apart. False: contact was never confirmed — what the server made
 * of the request is UNKNOWN, not known to have been dropped. True: the server answered (its
 * headers are the proof it handled the call) and the answer was lost on the way back. `answered`
 * is false on every transport error — the field names, beside `reachedServer`, the second of the
 * two questions a caller has (did it get there; did its answer get here). A response read in
 * full, of any status, is never this error: the server's answer is the caller's to read.
 *
 * `attempts` counts the deliveries the client made before giving up (the redelivery series of a
 * declared method stamps it); `stalled` says a watchdog abandoned the last request rather than
 * the transport rejecting it. Read by shape ({@link ServiceTransportError.is}), so an error thrown
 * through a duplicate copy of this package is still one.
 */
export class ServiceTransportError extends Error {
  private static readonly NAME = 'ServiceTransportError';
  /** The service path the request was for (`/service/<package>/<Service>/<method>`). */
  readonly servicePath: string;
  /** False: contact was never confirmed. True: the response headers arrived (see the class doc). */
  readonly reachedServer: boolean;
  /** Always false: the answer was not read in full (see the class doc). */
  readonly answered: boolean;
  /** True when a watchdog (first contact, or the body's) abandoned the request; false when the transport rejected it. */
  readonly stalled: boolean;
  /** The deliveries made before this error was thrown — the redelivery loop stamps it. */
  attempts: number;
  /** What the transport threw, when it threw (absent for a stall). */
  readonly cause?: unknown;
  /** The status a proxy answered with in the server's place (see {@link ServiceTransportError.unserved}); absent otherwise. */
  readonly status?: number;

  constructor(
    message: string,
    options: {
      servicePath: string;
      reachedServer: boolean;
      stalled: boolean;
      attempts?: number;
      cause?: unknown;
      status?: number;
    }
  ) {
    super(message);
    this.name = ServiceTransportError.NAME;
    Object.setPrototypeOf(this, ServiceTransportError.prototype);
    this.servicePath = options.servicePath;
    this.reachedServer = options.reachedServer;
    this.answered = false;
    this.stalled = options.stalled;
    this.attempts = options.attempts ?? 1;
    this.cause = options.cause;
    this.status = options.status;
  }

  /**
   * A proxy in front of the server answered in its place — a 502, 503 or 504 with no server answer
   * in the body — so no server process handled the request. Contact with the SERVER was never
   * confirmed (`reachedServer` false); the proxy's status rides as `status`.
   */
  static unserved(servicePath: string, status: number, statusText: string): ServiceTransportError {
    return new ServiceTransportError(
      `No server answered ${servicePath}: a proxy in front of it replied ${status} ${statusText} with no server answer in it`,
      { servicePath, reachedServer: false, stalled: false, status }
    );
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

  /**
   * The response headers arrived and the body did not: the body's bound abandoned the read
   * (`stalled`, with `boundMs`), or the connection died under it (`cause`).
   */
  static answerLost(
    servicePath: string,
    options: { stalled: boolean; boundMs?: number; cause?: unknown }
  ): ServiceTransportError {
    const why = options.stalled
      ? `its body did not finish arriving within ${options.boundMs} ms of its headers`
      : `the connection died under its body: ${ServiceTransportError.messageOf(options.cause)}`;
    return new ServiceTransportError(`The server answered ${servicePath} but the answer was lost — ${why}`, {
      servicePath,
      reachedServer: true,
      stalled: options.stalled,
      cause: options.cause,
    });
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
