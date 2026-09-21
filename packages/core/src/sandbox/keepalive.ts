/**
 * Sandbox keepalive. The gateway reclaims a box at its TTL; some channels also
 * silently clamp a requested TTL to something shorter. So we renew on an interval
 * that must be well below the *real* granted window, and after each renew we re-read
 * `endAt` to confirm the window actually moved forward (a 204 from the timeout call
 * does NOT prove it took).
 *
 * Two rules from hard experience (see the ppio-sandbox-aiproxy skill):
 *  - The keepalive interval must NOT share a lock with any long-running task, or the
 *    box is reclaimed mid-task. This loop is deliberately independent.
 *  - Verify via `endAt`, never trust the renew call's status alone.
 */
import type { Logger } from "@i-bot/logger";

/** The subset of the SDK instance keepalive needs — keeps this unit testable. */
export interface Renewable {
  /** control-plane timeout renew (ms). Returns 204; does not prove the window moved. */
  setTimeout(timeoutMs: number): Promise<void>;
  /** read back the authoritative window end. */
  getInfo(): Promise<{ endAt: Date }>;
}

export interface RenewResult {
  /** granted window from now, in ms, as read back from `endAt`. */
  grantedMs: number;
  /** absolute end, ms since epoch. */
  endAtMs: number;
}

/**
 * Renew once and read back the granted window. Exported for testing and for a
 * caller that wants a single verified renew. `now` is injectable for deterministic tests.
 */
export async function renewOnce(
  instance: Renewable,
  ttlMs: number,
  now: () => number = Date.now,
): Promise<RenewResult> {
  await instance.setTimeout(ttlMs);
  const info = await instance.getInfo();
  const endAtMs = info.endAt.getTime();
  return { grantedMs: endAtMs - now(), endAtMs };
}

export interface KeepaliveOptions {
  instance: Renewable;
  /** how often to renew (ms). Pick well below the real granted window. */
  intervalMs: number;
  /** TTL to request on each renew (ms). */
  ttlMs: number;
  logger?: Logger;
  /** called if a renew throws (transport failure); loop continues. */
  onError?: (err: unknown) => void;
  /** now() injection for tests. */
  now?: () => number;
}

/**
 * Independent renew loop. `start()` schedules; `stop()` clears. Satisfies the
 * `Stoppable` the handle depends on. Renews never overlap (in-flight guard) and a
 * failed renew is logged, not thrown — a transient control-plane blip must not crash
 * the process.
 */
export class Keepalive {
  #instance: Renewable;
  #intervalMs: number;
  #ttlMs: number;
  #logger: Logger | undefined;
  #onError: ((err: unknown) => void) | undefined;
  #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;

  constructor(opts: KeepaliveOptions) {
    this.#instance = opts.instance;
    this.#intervalMs = opts.intervalMs;
    this.#ttlMs = opts.ttlMs;
    this.#logger = opts.logger;
    this.#onError = opts.onError;
    this.#now = opts.now ?? Date.now;
  }

  /** Begin renewing. The timer is unref'd so it never by itself keeps the process alive. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Run one renew now (also used by tests). Skips if a renew is already in flight. */
  async #tick(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      const { grantedMs } = await renewOnce(this.#instance, this.#ttlMs, this.#now);
      // If the granted window is smaller than the next interval, the box may be
      // reclaimed before we renew again — the channel likely clamped the TTL.
      if (grantedMs < this.#intervalMs) {
        this.#logger?.warn(
          { grantedMs, intervalMs: this.#intervalMs },
          "sandbox keepalive: granted window is shorter than the renew interval; box may be reclaimed early",
        );
      }
    } catch (err) {
      this.#logger?.error({ err }, "sandbox keepalive renew failed");
      this.#onError?.(err);
    } finally {
      this.#inFlight = false;
    }
  }
}
