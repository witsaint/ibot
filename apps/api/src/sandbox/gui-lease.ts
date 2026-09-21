/**
 * The exclusive desktop/GUI lease for a bot's single sandbox.
 *
 * Every GUI tool — `browser_action` (CDP to the one Chrome), `desktop_action` and `screenshot`
 * (the one X display `:0`) — drives the SAME physical box. Two agent runs touching it at once
 * corrupt each other (one run's browser `dispose()` closes the other's CDP; two xdotool streams
 * fight over `:0`). So GUI access is serialized through this lease: at most one holder per bot,
 * others wait FIFO. Non-GUI work (`run_command` over envd's parallel shell sessions) never takes
 * the lease and runs truly concurrently — that's what makes "keep chatting while a task runs"
 * possible.
 *
 * Human takeover has priority over the agent. `isHumanInControl` (owned by the manager, toggled
 * when the user grabs the desktop in the UI) short-circuits `acquire` and, on `handleHumanTakeover`,
 * rejects everyone currently queued so no agent run is stuck waiting behind a human who may hold
 * the desktop indefinitely. The holder is left alone — it finishes its in-flight action and
 * releases; the per-call human gate in the tools stops it from starting another.
 *
 * In-process only (the chat turn, the task runs, and the control toggle all live in one process).
 * A restart clears every lease, which fails open — no run is in flight after a restart.
 */
import type { Logger } from "@i-bot/logger";

/** Thrown by `acquire` when the wait exceeds the timeout — the caller may retry later. */
export class GuiLeaseTimeoutError extends Error {
  constructor(botId: string, waitedMs: number) {
    super(`gui lease wait timed out for bot ${botId} after ${waitedMs}ms`);
    this.name = "GuiLeaseTimeoutError";
  }
}

/** Thrown by `acquire` (or to a queued waiter) when a human holds the desktop. */
export class HumanControlError extends Error {
  constructor(botId: string) {
    super(`a human holds the desktop for bot ${botId}`);
    this.name = "HumanControlError";
  }
}

/** An opaque grant. A holder passes its token back to `release`; a stale token is a no-op. */
export type GuiLeaseToken = symbol;

interface Holder {
  token: GuiLeaseToken;
  requester: string;
  since: number;
}

interface Waiter {
  token: GuiLeaseToken;
  requester: string;
  enqueuedAt: number;
  resolve: (token: GuiLeaseToken) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GuiLeaseDeps {
  /** true while a human holds the desktop for this bot — the lease yields to them. */
  isHumanInControl: (botId: string) => boolean;
  logger: Logger;
}

/** Default max time a run will wait for the lease before giving up (retry-able). */
export const DEFAULT_GUI_LEASE_TIMEOUT_MS = 90_000;

export class GuiLease {
  #isHumanInControl: (botId: string) => boolean;
  #logger: Logger;
  #holders = new Map<string, Holder>();
  #waiters = new Map<string, Waiter[]>();

  constructor(deps: GuiLeaseDeps) {
    this.#isHumanInControl = deps.isHumanInControl;
    this.#logger = deps.logger;
  }

  /**
   * Acquire the bot's GUI lease. Resolves immediately with a token if free, otherwise waits
   * FIFO until the current holder releases (or the timeout fires → `GuiLeaseTimeoutError`).
   * Rejects immediately with `HumanControlError` if a human already holds the desktop.
   */
  acquire(
    botId: string,
    requester: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<GuiLeaseToken> {
    if (this.#isHumanInControl(botId)) {
      return Promise.reject(new HumanControlError(botId));
    }

    if (!this.#holders.has(botId)) {
      const token = Symbol(`gui:${botId}:${requester}`);
      this.#holders.set(botId, { token, requester, since: Date.now() });
      return Promise.resolve(token);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_GUI_LEASE_TIMEOUT_MS;
    return new Promise<GuiLeaseToken>((resolve, reject) => {
      const token = Symbol(`gui:${botId}:${requester}`);
      const timer = setTimeout(() => {
        this.#removeWaiter(botId, token);
        reject(new GuiLeaseTimeoutError(botId, timeoutMs));
      }, timeoutMs);
      // Node timers keep the event loop alive; a pending GUI wait shouldn't hold the process open.
      timer.unref?.();
      const waiter: Waiter = { token, requester, enqueuedAt: Date.now(), resolve, reject, timer };
      const q = this.#waiters.get(botId);
      if (q) q.push(waiter);
      else this.#waiters.set(botId, [waiter]);
    });
  }

  /**
   * Release the lease. No-op unless `token` matches the current holder (guards against a stale
   * token from an already-superseded run). Promotes the next FIFO waiter, unless a human has
   * since taken the desktop — then everyone queued is rejected.
   */
  release(botId: string, token: GuiLeaseToken): void {
    const holder = this.#holders.get(botId);
    if (!holder || holder.token !== token) return; // stale / not the holder
    this.#holders.delete(botId);
    this.#promoteNext(botId);
  }

  /**
   * A human just took the desktop. Reject every queued agent waiter (they'd otherwise wait
   * behind a human who may hold control indefinitely). The current holder is untouched — it
   * releases on its own; the per-call human gate stops it starting another GUI action.
   */
  handleHumanTakeover(botId: string): void {
    this.#rejectWaiters(botId, new HumanControlError(botId));
  }

  /** Lease snapshot for the UI status strip. Does not account for human control (manager does). */
  state(botId: string): { held: boolean; queueDepth: number } {
    return {
      held: this.#holders.has(botId),
      queueDepth: this.#waiters.get(botId)?.length ?? 0,
    };
  }

  /** Tear down a bot's lease entirely (destroy / detach): reject waiters, drop the holder. */
  clear(botId: string, err: Error): void {
    this.#rejectWaiters(botId, err);
    this.#holders.delete(botId);
  }

  // ---------- internals ----------

  /** Promote the next waiter to holder, or leave the lease free if none / human took over. */
  #promoteNext(botId: string): void {
    const q = this.#waiters.get(botId);
    if (!q || q.length === 0) return;

    // A human grabbing the desktop between release and promotion outranks the queue.
    if (this.#isHumanInControl(botId)) {
      this.#rejectWaiters(botId, new HumanControlError(botId));
      return;
    }

    const next = q.shift()!;
    if (q.length === 0) this.#waiters.delete(botId);
    clearTimeout(next.timer);
    this.#holders.set(botId, { token: next.token, requester: next.requester, since: Date.now() });
    next.resolve(next.token);
  }

  /** Remove a specific waiter (used when its own timeout fires). */
  #removeWaiter(botId: string, token: GuiLeaseToken): void {
    const q = this.#waiters.get(botId);
    if (!q) return;
    const idx = q.findIndex((w) => w.token === token);
    if (idx === -1) return;
    clearTimeout(q[idx]!.timer);
    q.splice(idx, 1);
    if (q.length === 0) this.#waiters.delete(botId);
  }

  /** Reject and clear every queued waiter for a bot. */
  #rejectWaiters(botId: string, err: Error): void {
    const q = this.#waiters.get(botId);
    if (!q) return;
    this.#waiters.delete(botId);
    for (const w of q) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    if (q.length > 0) {
      this.#logger.debug({ botId, count: q.length, err: err.name }, "gui lease waiters rejected");
    }
  }
}
