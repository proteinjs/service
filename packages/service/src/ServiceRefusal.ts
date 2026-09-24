/** The statuses a deliberate refusal answers with. */
export type ServiceRefusalStatus = 400 | 403 | 404 | 409;

/**
 * A refusal a service operation throws ON PURPOSE — the caller may not have this, or it does not
 * exist for them, or it conflicts with what is there — as opposed to a failure. It carries the HTTP
 * status the router answers with and a message that is safe for the wire (the caller reads it
 * verbatim, in the same `{ error: <message> }` body every thrown error gets).
 *
 * `ServiceExecutor` logs a refusal at WARN with its status and the operation's name — never as a
 * failure — and `ServiceRouter` answers with its status. Every other thrown error stays a failure:
 * logged at ERROR and answered 400.
 *
 * Read by shape ({@link ServiceRefusal.is}), so a refusal thrown through a duplicate copy of this
 * package is still one.
 */
export class ServiceRefusal extends Error {
  private static readonly NAME = 'ServiceRefusal';
  private static readonly STATUSES: readonly ServiceRefusalStatus[] = [400, 403, 404, 409];
  readonly status: ServiceRefusalStatus;

  /**
   * @param status - 400 (the request cannot be done as asked), 403 (the caller may not), 404 (not
   *        there for this caller — the answer that leaks nothing about existence) or 409 (it
   *        conflicts with what is there).
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
}
