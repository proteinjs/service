import { createHash } from 'crypto';

/** The identity of one declared read on the server: the caller, the method, and the call's arguments. */
export type ReadScope = {
  /** The caller's identity (an email), empty when the request carries none. */
  principal: string;
  /** The method, as `<package>/<Service>.<method>`. */
  servicePath: string;
  /** The request body — the serialized arguments, as the request carried them. */
  body: string;
};

/**
 * The server's seat for methods the client declared `'read'` (see the client's
 * `DECLARED_READ_HEADER`): identical reads from one caller that arrive while one of them is RUNNING
 * share that run.
 *
 * Why: a client abandons a declared read whose response headers have not arrived inside its
 * first-contact bound and redelivers it as a fresh request, while the server runs the abandoned
 * delivery to the end — nothing cancels it, by design: cancelling would discard the work done so
 * far and the redelivery would start from zero, so a read that takes longer than the bound would
 * never finish at all. Unjoined, such a read ran once per delivery: the same document composed
 * three or four times on one process, each run slowing the others, and the first delivery that
 * happened to finish inside the bound was the one answered. Joined, a redelivery takes the run
 * already going and receives its answer when it settles: the work is done once, and the answer
 * lands as early as it can. Two identical reads a page makes at once share a run the same way.
 *
 * THE INVARIANT — the one piece of state this seat holds, and all of it:
 *
 * - An entry exists exactly while its run is in flight: recorded when the run starts, dropped the
 *   moment the run settles, success or failure alike. Never a result cache, never a lifetime, never
 *   a memo of a settled promise. A call that arrives after the run settled runs the method anew; a
 *   failed run is not served to anyone who arrives after it failed.
 * - A joined caller gets exactly what the running caller gets — the same promise, so the same value
 *   or the same rejection.
 * - Only a declared read joins, and only one from the same caller with the same method and the same
 *   arguments (hashed; the body itself is not kept). A write never coalesces: the client declares no
 *   write a read, and the executor consults this seat for declared reads only.
 * - The seat is one server process's. A deployment of several processes behind one address joins a
 *   redelivery only when the address routes it to the same process; a redelivery landing elsewhere
 *   runs the method there. Accepted: joining costs nothing, and a process that would have run the
 *   same read two or three times runs it once.
 */
export class InProcessReadCoalescer {
  private readonly inFlight = new Map<string, Promise<any>>();

  /**
   * The run in flight for the scope, joined — or `run` started and recorded until it settles.
   * `joined` says which, for the log line of the delivery that joined.
   */
  join<T>(scope: ReadScope, run: () => Promise<T>): { settled: Promise<T>; joined: boolean } {
    const id = InProcessReadCoalescer.idOf(scope);
    const running = this.inFlight.get(id);
    if (running) {
      return { settled: running, joined: true };
    }
    const settled = run();
    const forget = () => {
      this.inFlight.delete(id);
    };
    settled.then(forget, forget);
    this.inFlight.set(id, settled);
    return { settled, joined: false };
  }

  /** The runs in flight right now. */
  get size(): number {
    return this.inFlight.size;
  }

  private static idOf(scope: ReadScope): string {
    const argsHash = createHash('sha256').update(scope.body, 'utf8').digest('hex');
    return JSON.stringify([scope.principal, scope.servicePath, argsHash]);
  }
}
