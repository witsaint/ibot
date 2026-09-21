/**
 * Client-side wall-clock timeout for SDK/network awaits.
 *
 * Why this exists: the sandbox SDK's `commands.run({ timeoutMs })` bounds the *in-box
 * process*, not the *client transport*. If the gateway↔envd stream is silently severed
 * (connection not closed, just no more bytes), the client Promise never settles — and a
 * provision/connect await hangs forever. That is the "stuck on 'provisioning' for hours,
 * never errors" failure: no throw means the caller's catch (which flips the row to `kill`)
 * never runs, and the dedupe gate keyed on that Promise never clears.
 *
 * `withTimeout` races the work against a real timer, so a dead transport surfaces as a
 * `TimeoutError` the caller can handle instead of an unbounded hang. It does not cancel the
 * underlying work (there's no cancellation token through the SDK) — it stops *waiting* on it;
 * the loser is left to settle and be ignored. `unref()` keeps the timer from holding the
 * event loop open.
 */

/** A wrapped await exceeded its client-side wall-clock budget (a hang, not a rejection). */
export class TimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`"${label}" timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Resolve/reject with `work`, but reject with `TimeoutError` if it doesn't settle within
 * `timeoutMs`. `label` names the operation in the error. A non-positive `timeoutMs` disables
 * the guard (returns `work` untouched) — used to make the wall-clock opt-out testable.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    // don't let a pending guard keep the process alive if everything else is done
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}
