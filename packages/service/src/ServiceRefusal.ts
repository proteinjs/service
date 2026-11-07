/** The statuses a deliberate refusal answers with. */
export type ServiceRefusalStatus = 400 | 403 | 404 | 409 | 501;

/**
 * A refusal a service operation throws ON PURPOSE — the caller may not have this, or it does not
 * exist for them, or it conflicts with what is there, or this server as deployed cannot do it — as
 * opposed to a failure. It carries the HTTP status the router answers with and a message that is
 * safe for the wire (the caller reads it verbatim, in the same `{ error: <message> }` body every
 * thrown error gets).
 *
 * `ServiceExecutor` logs a refusal at WARN with its status and the operation's name — never as a
 * failure — and `ServiceRouter` answers with its status. Every other thrown error stays a failure:
 * logged at ERROR and answered 400. The one refusal the executor itself makes (a keyed call on a
 * multi-process server with no shared ledger, 501) it logs at ERROR: that one is a deployment's
 * misconfiguration, not a caller's.
 *
 * On the far side of the wire `ServiceClient` throws the refusal again ({@link ServiceRefusal.fromWire}):
 * an answer in the router's shape under a refusal's status is a `ServiceRefusal` with that status and
 * message, so a caller tells the server's verdict about the thing (gone, not theirs, in conflict,
 * not doable here) from a failure by shape alone — a 400 excepted, since the router answers every
 * wrapped failure 400 too.
 *
 * Read by shape ({@link ServiceRefusal.is}), so a refusal thrown through a duplicate copy of this
 * package is still one.
 */
export class ServiceRefusal extends Error {
  private static readonly NAME = 'ServiceRefusal';
  private static readonly STATUSES: readonly ServiceRefusalStatus[] = [400, 403, 404, 409, 501];
  /**
   * The statuses a client may read a refusal from on the wire: every refusal status but 400. The
   * router answers a deliberate 400 and the executor's wrapping of ANY thrown error (`ServiceError`)
   * with the same status and the same `{ error }` body, so a 400 on the wire is not known to be a
   * refusal; the client keeps it the plain error it always was.
   */
  private static readonly WIRE_STATUSES: readonly ServiceRefusalStatus[] = [403, 404, 409, 501];
  readonly status: ServiceRefusalStatus;

  /**
   * @param status - 400 (the request cannot be done as asked), 403 (the caller may not), 404 (not
   *        there for this caller — the answer that leaks nothing about existence), 409 (it
   *        conflicts with what is there) or 501 (this server as deployed cannot do it).
   * @param message - What the caller reads; safe for the wire.
   */
  constructor(status: ServiceRefusalStatus, message: string) {
    super(message);
    this.name = ServiceRefusal.NAME;
    Object.setPrototypeOf(this, ServiceRefusal.prototype);
    this.status = status;
  }

  /** Whether `error` is a refusal: the refusal's name and one of its statuses. */
  static is(error: unknown): error is ServiceRefusal {
    const candidate = error as { name?: unknown; status?: unknown } | null | undefined;
    return (
      candidate?.name === ServiceRefusal.NAME &&
      ServiceRefusal.STATUSES.includes(candidate.status as ServiceRefusalStatus)
    );
  }

  /**
   * The refusal a server's answer carries, for the client: `status` the answer's, when it is one a
   * refusal alone answers with ({@link ServiceRefusal.WIRE_STATUSES}), and `message` the router's
   * `{ error }` body — else undefined, and the client reads the answer as it always did (a plain
   * error carrying the message). Only for an answer in the router's shape: a proxy's page under
   * the same status is nobody's refusal.
   */
  static fromWire(status: number, message: string): ServiceRefusal | undefined {
    const refusalStatus = ServiceRefusal.WIRE_STATUSES.find((candidate) => candidate === status);
    return refusalStatus === undefined ? undefined : new ServiceRefusal(refusalStatus, message);
  }
}
