/**
 * The identity of one idempotent call on the server: the caller, the method, and the key the
 * client minted for the call (sent on every delivery of it — see the client's `IDEMPOTENCY_KEY_HEADER`).
 */
export type IdempotencyScope = {
  /** The caller's identity (an email), empty when the request carries none. */
  principal: string;
  /** The method, as `<package>/<Service>.<method>`. */
  servicePath: string;
  /** The client-minted key. */
  key: string;
};

/**
 * The server's seat for methods declared idempotent: a method runs once per
 * {@link IdempotencyScope} inside the key's lifetime, and a replay — a redelivery of the same call,
 * arriving after the run or while it is still in flight — settles to the same result as the run,
 * a value or a failure alike. The replayed failure is the run's own: a server verdict the client
 * already received once is what it receives again.
 */
export interface IdempotencyLedger {
  /** The scope's recorded result, or `run`'s — recorded under the scope for every later replay. */
  once<T>(scope: IdempotencyScope, run: () => Promise<T>): Promise<T>;
}

/**
 * How long a recorded result is kept. The client's whole redelivery series ends within a minute of
 * its first delivery (the total bound plus one first-contact watchdog), and a replay can only arrive
 * inside that series — two minutes holds every replay with the series' own length to spare. After it
 * the key is forgotten, and a call made later under the same key runs the method again.
 */
export const IDEMPOTENCY_KEY_TTL_MS = 120_000;

/**
 * The ledger in the server's own memory — the scope of ONE server process. A deployment that runs
 * several processes behind one address registers a ledger they share
 * (`ServiceExecutor.setIdempotencyLedger`): in this one, a replay that lands on another process
 * finds no record and runs the method again.
 *
 * In-flight runs are held as their promise, so a replay that arrives before the run settles waits
 * for it instead of starting a second one. Expired records are dropped as new calls arrive.
 */
export class InProcessIdempotencyLedger implements IdempotencyLedger {
  private readonly records = new Map<string, { settled: Promise<any>; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = IDEMPOTENCY_KEY_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  once<T>(scope: IdempotencyScope, run: () => Promise<T>): Promise<T> {
    this.forgetExpired();
    const id = InProcessIdempotencyLedger.idOf(scope);
    const held = this.records.get(id);
    if (held) {
      return held.settled;
    }
    const settled = run();
    this.records.set(id, { settled, expiresAt: this.now() + this.ttlMs });
    return settled;
  }

  /** The records held — expired ones included until the next call drops them. */
  get size(): number {
    return this.records.size;
  }

  private forgetExpired(): void {
    const now = this.now();
    const expired: string[] = [];
    this.records.forEach((record, id) => {
      if (record.expiresAt <= now) {
        expired.push(id);
      }
    });
    for (const id of expired) {
      this.records.delete(id);
    }
  }

  private static idOf(scope: IdempotencyScope): string {
    return JSON.stringify([scope.principal, scope.servicePath, scope.key]);
  }
}
