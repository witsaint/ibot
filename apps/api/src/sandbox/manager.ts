/**
 * The bot ↔ sandbox lifecycle manager. Bridges persisted `sandboxes` rows to live
 * `@i-bot/core` handles and keeps a process-local registry so a bot reuses one live
 * box (1:1) instead of re-provisioning per request.
 *
 * Boundaries (deliberate):
 * - Tenant isolation is NOT here — routes run the owner-of-bot check before calling us.
 *   The manager trusts the botId it's given (same contract as `@i-bot/core`'s provider).
 * - Persistence IS here (core stays DB-free): we write `provider_sandbox_id`, `provider_meta`,
 *   and `state` transitions so a later process can `connect()` from the row alone.
 * - Provisioning (~90s) runs in the background; `state` on the row is the single source of
 *   truth the UI polls (`create` → `active`, or `error`). We never block a request on it.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@i-bot/db";
import { bots, sandboxes } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import {
  type ConnectSandboxRequest,
  type CreateSandboxRequest,
  DESKTOP,
  parseProviderMeta,
  PpioSandboxProvider,
  type SandboxConfig,
  SandboxGoneError,
  type SandboxHandle,
  streamUrl,
  withTimeout,
} from "@i-bot/core";
import type { SandboxInfo, SandboxState } from "@i-bot/types";
import { eq, inArray } from "drizzle-orm";
import { bootstrapBot, gatherBotDefs, type StartedBoxMcp } from "./bootstrap.js";
import { GuiLease, type GuiLeaseToken } from "./gui-lease.js";

export interface SandboxManagerDeps {
  db: Database;
  sandboxConfig: SandboxConfig;
  logger: Logger;
}

/** The one interactive "voice" a bot has: a live user chat turn, or a proactive turn the agent
 * runs itself to relay a finished task's result back into the conversation. Only one at a time —
 * a new user message mid-turn still steers the existing one; it doesn't open a second voice. */
export interface ForegroundSlot {
  source: "user" | "proactive";
  startedAt: number;
}

/** A detached task run holding a spot in the bot's task registry (capped, see MAX_CONCURRENT_TASKS). */
export interface TaskSlot {
  /** the `agent_jobs` row id */
  jobId: string;
  kind: "background" | "subagent";
  /** true if the task drives the desktop (contends for the GUI lease); false = pure `run_command`. */
  needsDesktop: boolean;
  /** the goal/instruction, kept for the status strip and result framing */
  goal: string;
  startedAt: number;
}

/** How many detached tasks a single bot may run at once. */
export const MAX_CONCURRENT_TASKS = 3;

/**
 * Hard ceiling on how long an entry may sit in the `#provisioning` dedupe map (ms). The
 * provider's own awaits are all bounded now (see `withTimeout` in core), so a provision/recover
 * settles well within this. This is defence-in-depth: if some future unbounded await slips in,
 * the gate still clears instead of wedging the bot forever (the "stuck on provisioning for hours,
 * every poll and Restart a no-op" failure). Comfortably above the provider's own budgets
 * (create 120s + provision 360s ≈ 8min worst case) so it never fires on a healthy-but-slow box.
 */
const PROVISION_GATE_TIMEOUT_MS = 15 * 60_000;

/** A live snapshot of what's active on a bot, for the SSE `run.state` event and `/jobs/active`. */
export interface RunStateSnapshot {
  foreground: boolean;
  taskCount: number;
  gui: "free" | "agent" | "human";
  queueDepth: number;
  /** the bot is paused waiting for the human (a run called `request_handoff` and hasn't resumed) */
  awaitingHuman: boolean;
}

/** What a route needs to render the workspace: live routing + preview, never secrets. */
export interface BotSandboxView {
  /** the `sandboxes` row id */
  id: string;
  botId: string;
  state: SandboxState;
  /** view-only noVNC preview URL, or null until the box is reachable */
  streamUrl: string | null;
  screen: { width: number; height: number };
  /** true when a live in-process handle is held (box is warm) */
  live: boolean;
  /**
   * Why the last lifecycle attempt (provision / restart / revive) failed, if it did — a short
   * human-readable line the UI shows next to "Session ended" so a failed restart isn't silent.
   * Null when the last attempt succeeded or none has failed. Process-local (see `#lastError`).
   */
  error: string | null;
}

export class SandboxManager {
  #db: Database;
  #provider: PpioSandboxProvider;
  #config: SandboxConfig;
  #logger: Logger;
  /** botId → live handle. At most one per bot (1:1). */
  #handles = new Map<string, SandboxHandle>();
  /** botId → in-flight provision promise, so concurrent calls dedupe. */
  #provisioning = new Map<string, Promise<void>>();
  /** botId → last liveness-probe timestamp (ms), to throttle reconcile-on-read. */
  #lastProbe = new Map<string, number>();
  /**
   * botId → a human currently holds the desktop. Set when the user takes control in the
   * UI; while true the agent's `desktop_action` is refused so the human and the bot don't
   * fight over the single display `:0`. Process-local (the chat turn and the control toggle
   * run in the same process); a restart clears it, which fails open — acceptable since the
   * UI re-asserts control on mount.
   */
  #humanControl = new Set<string>();
  /**
   * botId → the bot's foreground/relay voice paused after calling `request_handoff` — it's blocked
   * on something only the human can do. Set by the run's `onHandoff`; CLEARED whenever a foreground
   * voice is next acquired (any source), which is the real "the human responded / we're moving
   * again" signal — clearing only on `"user"` would strand it after a proactive relay turn. Drives
   * the `awaitingHuman` bit in `runState`, so the UI shows "waiting for you" instead of a busy
   * spinner. Process-local (like `#humanControl`/`#foreground`); a restart clears it (fails open).
   */
  #awaitingHuman = new Set<string>();
  /**
   * botId → the bot's one interactive foreground voice, if a turn is live. A live user chat turn
   * OR a proactive turn (the agent relaying a finished task) claims it; a bot has at most one at a
   * time. This is what a new user message checks: foreground live → steer it; foreground idle →
   * start a fresh turn. Detached tasks do NOT take this — they run concurrently (see `#tasks`).
   * Process-local; a restart clears it (nothing is streaming after a restart).
   */
  #foreground = new Map<string, ForegroundSlot>();
  /**
   * botId → its live detached tasks, keyed by jobId. Capped at MAX_CONCURRENT_TASKS. Non-GUI
   * tasks run truly in parallel; GUI tasks serialize through `#guiLease`. Process-local — orphaned
   * `running` rows from a crashed process are reconciled to `error` at boot, not tracked here.
   */
  #tasks = new Map<string, Map<string, TaskSlot>>();
  /**
   * The exclusive desktop/GUI lease. Any run touching the browser/`:0`/screenshot acquires it
   * first (lazily, on its first GUI tool call) and holds it for the whole run; others wait FIFO.
   * Human takeover outranks the queue. See `./gui-lease.ts`. Constructed in the constructor (needs
   * `#logger` + `#humanControl`, so it can't be a field initializer — those run before the body).
   */
  #guiLease: GuiLease;
  /**
   * botId → why its last lifecycle attempt (provision / restart / revive) failed. Set when a
   * background op gives up, cleared when one starts or succeeds, and surfaced through `getView`
   * so a failed restart shows a reason instead of silently bouncing back to "Session ended".
   * Process-local (the failing op and the poll that reads it are in the same process); a restart
   * clears it — acceptable, the user just retries.
   */
  #lastError = new Map<string, string>();
  /**
   * botId → messages queued to be injected INTO the bot's in-flight foreground turn at the next
   * model↔tool step boundary. Two things ride this queue, both "a message to hand the running
   * loop next": (1) a user's mid-run `/steer`, and (2) a finished task's result relayed back (see
   * `deliverTaskResult`). The run's `prepareStep` drains it via `injectSteer` — one mechanism for
   * both. Un-drained entries survive a foreground release (a proactive flush picks them up); only
   * `destroy`/`detachAll` clear them. Process-local.
   */
  #steerQueue = new Map<string, string[]>();
  /**
   * botId → the box-local MCP endpoints that came up during the last bootstrap (see `./bootstrap`).
   * The agent-run resolver reads this to wire an MCP client per endpoint. Re-populated on every
   * `#provision`/`#recover` (a rebuilt box re-renders its definitions from the DB ledger).
   * Process-local; empty until the first bootstrap for a bot in this process.
   */
  #boxMcp = new Map<string, StartedBoxMcp[]>();

  constructor(deps: SandboxManagerDeps) {
    this.#db = deps.db;
    this.#config = deps.sandboxConfig;
    this.#logger = deps.logger;
    this.#provider = new PpioSandboxProvider({ config: deps.sandboxConfig, logger: deps.logger });
    this.#guiLease = new GuiLease({
      isHumanInControl: (id) => this.#humanControl.has(id),
      logger: deps.logger,
    });
  }

  /**
   * Kick off provisioning for a bot if it has no sandbox yet. Returns immediately with
   * the row in `create` state; the box comes up in the background (~90s). Idempotent:
   * a second call while provisioning is in flight returns the existing row.
   */
  async ensureSandbox(botId: string): Promise<BotSandboxView> {
    const existing = await this.#db.query.sandboxes.findFirst({
      where: eq(sandboxes.botId, botId),
    });

    if (existing) {
      // Already have a row. If it's down (`kill`), RECOVER it: reconnect to the SAME box
      // and re-run the idempotent provision to restart any in-box services a crash or the
      // ~24h pause/resume killed — disk/env/installed software survive. Only if the gateway
      // has actually reclaimed the box (SandboxGoneError) does recover fall back to a fresh
      // create (content lost). Flip to `resume` so the UI shows the booting state, not the
      // "session ended" restart prompt, while the reconnect runs (~a few s, or ~90s if a
      // pause/resume wiped the stack and the launch steps must re-run).
      if (existing.state === "kill") {
        // A user clicked Restart. Clear any stale failure and recover with `createFreshOnFail`:
        // if reconnect to the old box fails for ANY reason (not just a clean SandboxGoneError —
        // a reclaimed box usually surfaces as an unreachable runtime probe, NOT NotFound), fall
        // back to a fresh box. This is what stops the "restart bounces straight back to Session
        // ended" loop. The user already accepted losing this box's content by reaching `kill`.
        this.#lastError.delete(botId);
        await this.#db
          .update(sandboxes)
          .set({ state: "resume", updatedAt: new Date() })
          .where(eq(sandboxes.id, existing.id));
        await this.#startRecover(botId, existing.id, { createFreshOnFail: true });
        return this.#view(
          existing.id,
          botId,
          "resume",
          existing.providerSandboxId,
          existing.providerMeta,
        );
      }
      return this.#view(
        existing.id,
        botId,
        existing.state,
        existing.providerSandboxId,
        existing.providerMeta,
      );
    }

    // Create the row FIRST (state=create) — this trips the 1:1 bot_id unique constraint
    // and is what the owner-of-bot check gated. Then provision in the background.
    const rowId = randomUUID();
    await this.#db.insert(sandboxes).values({
      id: rowId,
      botId,
      provider: "ppio",
      templateId: DESKTOP.key,
      state: "create",
    });
    this.#lastError.delete(botId); // fresh start — no stale failure
    await this.#startProvision(botId, rowId);
    return {
      id: rowId,
      botId,
      state: "create",
      streamUrl: null,
      screen: DESKTOP.screen,
      live: false,
      error: null,
    };
  }

  /**
   * Current view for a bot's sandbox (for status polling). Null if none exists.
   *
   * Reconcile-on-read: a box's gateway TTL (as low as 1h) can reclaim it while our row
   * still says `active`, leaving the UI pointed at a dead preview ("can't connect"). When
   * a row claims `active`, we probe the preview; a definitive gone signal (502/404 — the
   * gateway reached the address but the box isn't there) flips the row to `kill`, so the
   * UI shows "off" and the user can restart (ensureSandbox re-provisions from `kill`).
   * Ambiguous failures (timeout, network) are NOT treated as dead — we never false-kill a
   * merely-slow box. Throttled per bot so status polling doesn't hammer the gateway.
   */
  async getView(botId: string): Promise<BotSandboxView | null> {
    const row = await this.#db.query.sandboxes.findFirst({ where: eq(sandboxes.botId, botId) });
    if (!row) return null;

    // Self-heal a row stranded in `create`/`resume` (process died mid-provision, or the old hang):
    // re-kick provision/recover so the desktop actually gets built instead of the UI spinning
    // forever. No-op when the box is warm or an op is already running.
    this.#healIfStranded(row);

    if (row.state === "active" && row.providerSandboxId && row.providerMeta) {
      const dead = await this.#probeDead(botId, row.providerSandboxId, row.providerMeta);
      if (dead) {
        // The preview port isn't serving — but that means "in-box services are down", NOT
        // necessarily "the box is gone". A crash or the ~24h pause/resume kills the desktop
        // stack while the box itself keeps running on the gateway. So AUTO-REVIVE: flip to
        // `resume` and reconnect to the SAME box (restarts the stack, content intact). Only
        // if connect proves the box is truly reclaimed does recover create a fresh one. The
        // user doesn't even have to click Restart — the desktop heals itself on the next poll.
        this.#logger.warn(
          { botId, rowId: row.id },
          "sandbox preview down — auto-reviving (reconnect same box)",
        );
        await this.#db
          .update(sandboxes)
          .set({ state: "resume", updatedAt: new Date() })
          .where(eq(sandboxes.id, row.id));
        // Auto-revive stays conservative: reconnect to the SAME box (restart the stack, content
        // intact). It does NOT create a fresh box on an ambiguous failure — that's reserved for a
        // deliberate user Restart, so an automatic probe never silently discards a maybe-live box.
        await this.#startRecover(botId, row.id, { createFreshOnFail: false });
        return this.#view(row.id, botId, "resume", row.providerSandboxId, row.providerMeta);
      }
    }

    return this.#view(row.id, botId, row.state, row.providerSandboxId, row.providerMeta);
  }

  /**
   * Re-arm keepalive for every box that was `active` when a previous process exited.
   * The gateway reclaims a box at its TTL (as low as 1h) unless something keeps renewing
   * it; that renewal lives on the in-process handle and is lost on restart. So on boot we
   * reconnect each active box (which restarts its keepalive) and reconcile any that are
   * already gone to `kill`. Runs in the background — never blocks serving. Idempotent: a
   * box already held (warm) is skipped.
   *
   * This is what lets a bot's desktop survive a deploy / crash / dev hot-reload: as long
   * as a new process comes up within the last granted window (~1h) and re-arms, the box
   * keeps living instead of coasting to reclamation.
   */
  async rearmActive(): Promise<void> {
    const rows = await this.#db.query.sandboxes.findMany({ where: eq(sandboxes.state, "active") });
    const armable = rows.filter((r) => r.providerSandboxId && r.providerMeta);
    if (armable.length === 0) return;
    this.#logger.info({ count: armable.length }, "re-arming keepalive for active sandboxes");

    // Sequential on purpose: each reconnect re-runs the desktop provision over the
    // control plane; a Promise.all here would be a thundering herd on boot when a tenant
    // has many active boxes. Boot latency doesn't matter — this runs in the background.
    /* eslint-disable no-await-in-loop */
    for (const row of armable) {
      if (this.#handles.has(row.botId)) continue; // already warm
      try {
        await this.#reconnect(row.botId, row.id, row.providerSandboxId!, row.providerMeta!);
        this.#logger.info({ botId: row.botId, rowId: row.id }, "sandbox keepalive re-armed");
      } catch (err) {
        // Reconnect failed. Only reconcile to `kill` on a DEFINITIVE gone signal (502/404
        // from the preview) — a transient control-plane blip must not wipe a live box's
        // row. An ambiguous failure is left as-is; getView will probe again lazily.
        const gone = await this.#goneCheck(row.providerSandboxId!, row.providerMeta!);
        if (gone) {
          this.#logger.warn(
            { botId: row.botId, rowId: row.id, err: (err as Error).message },
            "active sandbox gone on boot — marking kill",
          );
          await this.#markKilled(row.botId, row.id);
        } else {
          this.#logger.warn(
            { botId: row.botId, rowId: row.id, err: (err as Error).message },
            "could not re-arm sandbox (ambiguous) — leaving row, will retry on read",
          );
        }
      }
    }
    /* eslint-enable no-await-in-loop */

    // Also pick up rows stranded in `create`/`resume` by a process that died mid-provision (or
    // the old unbounded hang): re-kick them so their desktop finishes building on boot instead of
    // waiting for the next status poll. `#healIfStranded` is a no-op for anything already warm or
    // in flight, so this is safe to run unconditionally.
    const stranded = await this.#db.query.sandboxes.findMany({
      where: inArray(sandboxes.state, ["create", "resume"]),
    });
    for (const row of stranded) this.#healIfStranded(row);
  }

  /**
   * Throttled liveness probe for status polling: at most one probe per bot per 15s,
   * else trust the row. Delegates the actual gone-check to `#goneCheck`.
   */
  async #probeDead(
    botId: string,
    providerSandboxId: string,
    providerMeta: unknown,
  ): Promise<boolean> {
    const now = Date.now();
    const last = this.#lastProbe.get(botId) ?? 0;
    if (now - last < 15_000) return false; // throttled — trust the row
    this.#lastProbe.set(botId, now);
    return this.#goneCheck(providerSandboxId, providerMeta);
  }

  /**
   * Is the box definitively gone? Returns true ONLY on a definitive gone signal (HTTP
   * 502/404 from the gateway — it reached the address but the box isn't there).
   * Timeouts/network errors → false (treat as alive; a slow box must not be killed).
   * Unthrottled — callers that need throttling wrap it (`#probeDead`).
   */
  async #goneCheck(providerSandboxId: string, providerMeta: unknown): Promise<boolean> {
    let url: string;
    try {
      url = streamUrl(
        providerSandboxId,
        parseProviderMeta(providerMeta as Record<string, unknown>),
      );
    } catch {
      return false; // can't build a URL → not a definitive-dead signal
    }
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(4000) });
      return res.status === 502 || res.status === 404;
    } catch {
      return false; // timeout / network — ambiguous, never false-kill
    }
  }

  /**
   * Reconnect to a persisted box, restart its keepalive (the provider's `connect` arms
   * a fresh keepalive), register the handle, and write back routing meta if the provider
   * refreshed it. The write-back guards the ~24h pause/resume case: if the SDK hands back
   * a new composite id / domain, the persisted row must follow or `streamUrl` points at a
   * stale host. Shared by `getHandle` (lazy, on a chat turn) and `rearmActive` (on boot).
   */
  async #reconnect(
    botId: string,
    rowId: string,
    providerSandboxId: string,
    providerMeta: unknown,
  ): Promise<SandboxHandle> {
    const req: ConnectSandboxRequest = {
      sandboxRowId: rowId,
      providerSandboxId,
      meta: providerMeta as Record<string, unknown>,
    };
    const handle = await this.#provider.connect(req);
    this.#handles.set(botId, handle);

    // Persist refreshed routing if it moved (new clientId after resume, etc.).
    if (handle.providerSandboxId !== providerSandboxId) {
      await this.#db
        .update(sandboxes)
        .set({
          providerSandboxId: handle.providerSandboxId,
          providerMeta: handle.meta,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sandboxes.id, rowId));
    }
    return handle;
  }

  /**
   * Re-render a bot's skills/setup-steps/box-local-MCP from the DB ledger into a live box. Called
   * after a fresh provision and after a recovery (the box's disk/processes may be fresh — a rebuild
   * wiped them, or an infra pause/resume killed the in-box processes). Idempotent and best-effort:
   * a failure here NEVER fails the box coming up — the desktop is already usable; skills/MCP are an
   * enrichment. The box-local MCP endpoints it starts are stored for the agent-run resolver.
   */
  async #bootstrap(botId: string, handle: SandboxHandle): Promise<void> {
    try {
      const defs = await gatherBotDefs(this.#db, botId);
      const result = await bootstrapBot(handle, this.#db, botId, defs, { logger: this.#logger });
      this.#boxMcp.set(botId, result.boxMcp);
    } catch (err) {
      this.#logger.warn(
        { botId, err: (err as Error).message },
        "bootstrap failed (box is up; skills/MCP not fully rendered) — will retry on next recovery",
      );
    }
  }

  /** The box-local MCP endpoints that came up for a bot (empty if none / not yet bootstrapped). */
  boxMcpEndpoints(botId: string): StartedBoxMcp[] {
    return this.#boxMcp.get(botId) ?? [];
  }

  /** Mark a bot's box dead: drop the handle, flip the row to `kill`, idle the bot. */
  async #markKilled(botId: string, rowId: string): Promise<void> {
    // detach() BEFORE dropping the reference, or the handle's keepalive loop keeps ticking
    // against a box that's gone — that's the source of the endless `SandboxNotFoundError`
    // renew spam in the log after a box dies. detach() stops the timer without a control-plane
    // call (the box is already gone); it's idempotent, so a handle-less bot is a safe no-op.
    this.#handles.get(botId)?.detach();
    this.#handles.delete(botId);
    await this.#db
      .update(sandboxes)
      .set({ state: "kill", updatedAt: new Date() })
      .where(eq(sandboxes.id, rowId));
    await this.#db
      .update(bots)
      .set({ status: "idle", updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

  /**
   * Get a live handle for a bot, reconnecting from the persisted row if the box is warm
   * but not held in this process (e.g. after a restart). Throws if the sandbox isn't
   * `active` yet — callers should provision + poll first.
   */
  async getHandle(botId: string): Promise<SandboxHandle> {
    const held = this.#handles.get(botId);
    if (held) return held;

    const row = await this.#db.query.sandboxes.findFirst({ where: eq(sandboxes.botId, botId) });
    if (!row) throw new Error(`no sandbox for bot ${botId} — provision first`);
    if (row.state !== "active" || !row.providerSandboxId || !row.providerMeta) {
      throw new Error(`sandbox for bot ${botId} is not active (state=${row.state})`);
    }

    return this.#reconnect(botId, row.id, row.providerSandboxId, row.providerMeta);
  }

  /**
   * Desktop control arbitration. While a human holds control, the agent's `desktop_action`
   * is refused (`isHumanInControl` gates the tool) so the two don't drive `:0` at once.
   * Idempotent; browser actions (CDP, a separate channel) are unaffected.
   */
  setHumanControl(botId: string, held: boolean): void {
    if (held) {
      this.#humanControl.add(botId);
      // Don't let agent GUI runs sit queued behind a human who may hold the desktop indefinitely.
      this.#guiLease.handleHumanTakeover(botId);
    } else {
      this.#humanControl.delete(botId);
    }
  }

  isHumanInControl(botId: string): boolean {
    return this.#humanControl.has(botId);
  }

  /**
   * Mark (or clear) that the bot is paused waiting for the human — set from a run's `onHandoff`
   * when the model calls `request_handoff`. Surfaced via `runState().awaitingHuman`. It's cleared
   * automatically the next time a foreground voice is acquired (see `tryAcquireForeground`); this
   * setter is the explicit set on handoff and a manual clear if ever needed. Idempotent.
   */
  setAwaitingHuman(botId: string, held: boolean): void {
    if (held) this.#awaitingHuman.add(botId);
    else this.#awaitingHuman.delete(botId);
  }

  /** Is the bot paused waiting for the human (a run called `request_handoff` and hasn't resumed)? */
  awaitingHuman(botId: string): boolean {
    return this.#awaitingHuman.has(botId);
  }

  // ---------- foreground voice ----------

  /**
   * Atomically claim the bot's one foreground voice. Returns true on success, false if a
   * foreground turn (user or proactive) is already live. Single-threaded event loop → the
   * check-then-set has no interleaving window. Caller MUST `releaseForeground` when it settles.
   * Detached tasks do NOT go through here.
   */
  tryAcquireForeground(botId: string, source: ForegroundSlot["source"]): boolean {
    if (this.#foreground.has(botId)) return false;
    this.#foreground.set(botId, { source, startedAt: Date.now() });
    // A new foreground voice (user message, or a proactive relay) is the "we're moving again"
    // signal — clear any awaiting-human pause for ANY source. Clearing only on "user" would leave
    // it stuck true after a proactive turn that settles without re-blocking (the stuck-on bug). A
    // turn that's still genuinely blocked re-sets it via onHandoff.
    this.#awaitingHuman.delete(botId);
    return true;
  }

  /** Release the foreground voice. Does NOT clear the steer queue — un-drained relay/steer is
   *  meant to survive so a proactive flush can pick it up (see `hasPendingSteer`). Idempotent. */
  releaseForeground(botId: string): void {
    this.#foreground.delete(botId);
  }

  /** The live foreground turn for a bot, or null if none. */
  foreground(botId: string): ForegroundSlot | null {
    return this.#foreground.get(botId) ?? null;
  }

  /** Is a foreground turn (user or proactive) live right now? */
  foregroundActive(botId: string): boolean {
    return this.#foreground.has(botId);
  }

  // ---------- task registry ----------

  /**
   * Register a detached task, if under the per-bot cap. Returns `{ ok: true }` on success, or
   * `{ ok: false, reason: "cap" }` when MAX_CONCURRENT_TASKS are already running. Atomic
   * (single-threaded). Caller MUST `unregisterTask` when the task settles.
   */
  tryRegisterTask(
    botId: string,
    slot: Omit<TaskSlot, "startedAt">,
  ): { ok: true } | { ok: false; reason: "cap" } {
    const tasks = this.#tasks.get(botId);
    if (tasks && tasks.size >= MAX_CONCURRENT_TASKS) return { ok: false, reason: "cap" };
    const entry: TaskSlot = { ...slot, startedAt: Date.now() };
    if (tasks) tasks.set(slot.jobId, entry);
    else this.#tasks.set(botId, new Map([[slot.jobId, entry]]));
    return { ok: true };
  }

  /** Remove a task from the registry. Idempotent. */
  unregisterTask(botId: string, jobId: string): void {
    const tasks = this.#tasks.get(botId);
    if (!tasks) return;
    tasks.delete(jobId);
    if (tasks.size === 0) this.#tasks.delete(botId);
  }

  /** The bot's live tasks (empty array if none). */
  activeTasks(botId: string): TaskSlot[] {
    const tasks = this.#tasks.get(botId);
    return tasks ? Array.from(tasks.values()) : [];
  }

  /** How many tasks are live for the bot. */
  taskCount(botId: string): number {
    return this.#tasks.get(botId)?.size ?? 0;
  }

  // ---------- GUI lease ----------

  /**
   * Acquire the bot's exclusive GUI lease (for a run about to touch the browser/`:0`/screenshot).
   * Resolves with a token when free; waits FIFO otherwise; rejects on human control or timeout.
   * The token must be passed back to `releaseGui`.
   */
  acquireGui(
    botId: string,
    requester: string,
    opts?: { timeoutMs?: number },
  ): Promise<GuiLeaseToken> {
    return this.#guiLease.acquire(botId, requester, opts ?? {});
  }

  /** Release the GUI lease held under `token` (no-op if it's not the current holder). */
  releaseGui(botId: string, token: GuiLeaseToken): void {
    this.#guiLease.release(botId, token);
  }

  // ---------- run state snapshot ----------

  /** A snapshot of everything active on the bot, for the SSE `run.state` event / `/jobs/active`. */
  runState(botId: string): RunStateSnapshot {
    const lease = this.#guiLease.state(botId);
    const gui = this.#humanControl.has(botId) ? "human" : lease.held ? "agent" : "free";
    return {
      foreground: this.#foreground.has(botId),
      taskCount: this.taskCount(botId),
      gui,
      queueDepth: lease.queueDepth,
      awaitingHuman: this.#awaitingHuman.has(botId),
    };
  }

  // ---------- steer / relay queue ----------

  /**
   * Queue a message to be injected into the bot's in-flight foreground turn at the next step
   * boundary. Used both for a user's mid-run `/steer` and for a finished task's relayed result
   * (`deliverTaskResult`) — the running loop's `prepareStep` drains it the same way for both.
   * Caller confirms a foreground turn is live (or starts a proactive one) — this only appends.
   */
  enqueueSteer(botId: string, text: string): void {
    const q = this.#steerQueue.get(botId);
    if (q) q.push(text);
    else this.#steerQueue.set(botId, [text]);
  }

  /**
   * Take and clear the bot's pending steer/relay messages. Called by the run at each step
   * boundary; returns `[]` on the common no-steer step (cheap, allocation-free path).
   */
  drainSteer(botId: string): string[] {
    const q = this.#steerQueue.get(botId);
    if (!q || q.length === 0) return [];
    this.#steerQueue.delete(botId);
    return q;
  }

  /** True if messages are queued for the bot but no foreground turn is live to drain them —
   *  the signal to flush them with a proactive turn (see `deliverTaskResult`). */
  hasPendingSteer(botId: string): boolean {
    return (this.#steerQueue.get(botId)?.length ?? 0) > 0;
  }

  /** Tear down a bot's sandbox (control plane + registry + row state). Idempotent. */
  async destroy(botId: string): Promise<void> {
    this.#humanControl.delete(botId);
    this.#awaitingHuman.delete(botId);
    this.#foreground.delete(botId);
    this.#tasks.delete(botId);
    this.#guiLease.clear(botId, new Error(`sandbox for bot ${botId} destroyed`));
    this.#steerQueue.delete(botId);
    this.#lastError.delete(botId);
    this.#boxMcp.delete(botId);
    const handle = this.#handles.get(botId);
    if (handle) {
      await handle.destroy();
      this.#handles.delete(botId);
    }
    await this.#db
      .update(sandboxes)
      .set({ state: "kill", updatedAt: new Date() })
      .where(eq(sandboxes.botId, botId));
  }

  /**
   * Detach every live handle for a graceful shutdown: stop each keepalive loop but
   * DO NOT kill the boxes. They keep running on their current grant so the next
   * process (`rearmActive`) can reconnect and re-arm keepalive. This is the fix for
   * "the desktop disappears after a restart" — the old behaviour killed every box on
   * SIGTERM (and thus on every dev hot-reload). Does not touch DB state.
   */
  detachAll(): void {
    for (const h of this.#handles.values()) h.detach();
    this.#handles.clear();
    // A lease may be held by a foreground run OR a task — clear for the union of both.
    const leased = new Set<string>([...this.#foreground.keys(), ...this.#tasks.keys()]);
    for (const botId of leased) {
      this.#guiLease.clear(botId, new Error("process detaching all sandboxes"));
    }
    this.#foreground.clear();
    this.#tasks.clear();
    this.#steerQueue.clear();
    this.#awaitingHuman.clear();
  }

  // ---------- internals ----------

  /**
   * Re-kick a row stranded mid-lifecycle (`create` / `resume`) that has NO warm handle and NO
   * in-flight op. This is the orphan gap: if the process that started a provision died (deploy,
   * crash, the old unbounded hang), the row keeps saying `create`/`resume` forever — `rearmActive`
   * only re-arms `active` rows and `getView`'s auto-revive only fires on `active` rows, so nothing
   * ever picks it back up and the UI spins on "provisioning the desktop" indefinitely. Idempotent
   * and cheap: skips when the box is warm or an op is already in flight (the dedupe gate). Routes
   * by what routing exists — a row that never got a box provisions fresh; one with a persisted box
   * recovers (reconnect same box, content intact; fresh only if truly gone).
   */
  #healIfStranded(row: {
    id: string;
    botId: string;
    state: SandboxState;
    providerSandboxId: string | null;
    providerMeta: unknown;
  }): void {
    if (row.state !== "create" && row.state !== "resume") return;
    if (this.#handles.has(row.botId) || this.#provisioning.has(row.botId)) return; // warm or in-flight
    if (row.providerSandboxId && row.providerMeta) {
      this.#logger.warn(
        { botId: row.botId, rowId: row.id, state: row.state },
        "sandbox stranded mid-lifecycle with routing — re-kicking recover (reconnect same box)",
      );
      void this.#startRecover(row.botId, row.id, { createFreshOnFail: false });
    } else {
      this.#logger.warn(
        { botId: row.botId, rowId: row.id, state: row.state },
        "sandbox stranded mid-lifecycle with no routing — re-kicking fresh provision",
      );
      void this.#startProvision(row.botId, row.id);
    }
  }

  /** Start (or reuse) a background provision. Dedupes on botId. */
  async #startProvision(botId: string, rowId: string): Promise<void> {
    if (this.#provisioning.has(botId)) return;
    // Backstop the stored promise so the gate ALWAYS clears (see PROVISION_GATE_TIMEOUT_MS): a
    // gate keyed on a never-settling promise wedges the bot forever. On the timeout branch the
    // underlying work is abandoned (left to settle and be ignored) and the entry is released.
    const p = withTimeout(
      this.#provision(botId, rowId),
      PROVISION_GATE_TIMEOUT_MS,
      "provision-gate",
    ).finally(() => this.#provisioning.delete(botId));
    this.#provisioning.set(botId, p);
    // do not await — background
    p.catch(() => {});
  }

  /**
   * Start (or reuse) a background RECOVER. Shares the `#provisioning` dedupe gate with
   * `#startProvision` — the two never race for one bot (both mean "a box op is in flight").
   * So a burst of status polls that each trip auto-revive only kicks one recover.
   *
   * `createFreshOnFail` distinguishes the two callers: a deliberate user Restart (true) always
   * lands on a working box, creating a fresh one if reconnect fails; automatic revive (false)
   * stays conservative and never discards a maybe-live box on an ambiguous failure.
   */
  async #startRecover(
    botId: string,
    rowId: string,
    opts: { createFreshOnFail: boolean },
  ): Promise<void> {
    if (this.#provisioning.has(botId)) return;
    // Same backstop as #startProvision: bound the stored promise so the gate can't wedge.
    const p = withTimeout(
      this.#recover(botId, rowId, opts),
      PROVISION_GATE_TIMEOUT_MS,
      "recover-gate",
    ).finally(() => this.#provisioning.delete(botId));
    this.#provisioning.set(botId, p);
    // do not await — background
    p.catch(() => {});
  }

  /**
   * Revive a bot's box WITHOUT losing its content: reconnect to the SAME persisted
   * `providerSandboxId` and re-run the idempotent provision (a healthy box → cheap
   * no-op checks; a pause/resume-wiped box → the launch steps restart the stack — the
   * installed packages, files, and browser profile are all still on disk). This is the
   * whole point of "restart the kept-alive box, don't create a new one".
   *
   * Fallback ladder:
   * - reconnect works → revived in place, content intact (the common, best case).
   * - box GONE (`SandboxGoneError`: the gateway reclaimed it at its TTL — truly deleted): create
   *   a FRESH box. Content is unavoidably lost; there's nothing left to reconnect to.
   * - any OTHER error (unreachable runtime probe / transient control-plane / network): a reclaimed
   *   box usually surfaces HERE, not as a clean SandboxGoneError — the control-plane connect
   *   succeeds but the runtime probe 502s. So the handling splits on `createFreshOnFail`:
   *     - user Restart (true): create a fresh box. The user explicitly asked for a working desktop
   *       and already accepted losing this one (they're restarting from `kill`). This is the fix
   *       for "Restart bounces straight back to Session ended" — the old code marked `kill` here.
   *     - auto-revive (false): do NOT recreate (would nuke a maybe-live box). Record the reason and
   *       mark `kill` so the UI offers Restart (which then reconnects, or creates fresh, next time).
   */
  async #recover(
    botId: string,
    rowId: string,
    opts: { createFreshOnFail: boolean },
  ): Promise<void> {
    const row = await this.#db.query.sandboxes.findFirst({ where: eq(sandboxes.id, rowId) });
    if (!row) return; // row vanished (e.g. bot deleted) — nothing to recover

    // No routing to reconnect with → there was never a live box; provision fresh.
    if (!row.providerSandboxId || !row.providerMeta) {
      await this.#provision(botId, rowId);
      return;
    }

    try {
      // #reconnect connects to the same box, re-arms keepalive, re-runs provision, and
      // writes back refreshed routing if the composite id moved after a resume.
      const handle = await this.#reconnect(botId, rowId, row.providerSandboxId, row.providerMeta);
      await this.#db
        .update(sandboxes)
        .set({ state: "active", lastActiveAt: new Date(), updatedAt: new Date() })
        .where(eq(sandboxes.id, rowId));
      await this.#db
        .update(bots)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(bots.id, botId));
      this.#lastError.delete(botId); // recovered — clear any prior failure reason
      this.#logger.info(
        { botId, rowId },
        "sandbox revived (reconnected to existing box — content intact)",
      );
      // Re-render the ledger: an infra pause/resume kills in-box processes (box-local MCP), and a
      // fresh box has no skill files — bootstrap is idempotent so a warm box just re-affirms them.
      await this.#bootstrap(botId, handle);
    } catch (err) {
      if (err instanceof SandboxGoneError) {
        this.#logger.warn(
          { botId, rowId },
          "sandbox gone on revive (gateway reclaimed it) — creating a FRESH box (previous content lost)",
        );
        await this.#provision(botId, rowId);
        return;
      }
      if (opts.createFreshOnFail) {
        // User Restart, reconnect failed (a reclaimed box usually lands here, not as a clean
        // SandboxGoneError). Create a fresh box so Restart actually restarts instead of bouncing.
        this.#logger.warn(
          { botId, rowId, err: (err as Error).message },
          "sandbox restart: reconnect failed — creating a FRESH box (user-initiated)",
        );
        await this.#provision(botId, rowId);
        return;
      }
      // Auto-revive ambiguous failure — do NOT recreate (would discard a maybe-live box). Record
      // the reason, leave the box on the gateway, mark `kill` so the user can Restart.
      this.#lastError.set(botId, "无法自动恢复桌面,请点击重启。");
      this.#logger.warn(
        { botId, rowId, err: (err as Error).message },
        "sandbox revive failed (ambiguous) — leaving box, marking kill; Restart will retry reconnect",
      );
      await this.#markKilled(botId, rowId);
    }
  }

  async #provision(botId: string, rowId: string): Promise<void> {
    // Resolve the egress channel for THIS box from the bot's preference (true=public, false=internal,
    // null=inherit the fleet default). The chosen slug is passed to create and stamped into the box's
    // meta, so every later reconnect returns to the same backend even if the toggle changes.
    const bot = await this.#db.query.bots.findFirst({
      where: eq(bots.id, botId),
      columns: { sandboxPublic: true },
    });
    const channelSlug = this.#config.channelSlugFor(bot?.sandboxPublic ?? null);
    const req: CreateSandboxRequest = {
      sandboxRowId: rowId,
      botId,
      templateKey: DESKTOP.key,
      longRunning: true,
      channelSlug,
    };
    try {
      const handle = await this.#provider.create(req);
      this.#handles.set(botId, handle);
      await this.#db
        .update(sandboxes)
        .set({
          state: "active",
          providerSandboxId: handle.providerSandboxId,
          providerMeta: handle.meta,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sandboxes.id, rowId));
      await this.#db
        .update(bots)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(bots.id, botId));
      this.#lastError.delete(botId); // provisioned cleanly — clear any prior failure reason
      this.#logger.info({ botId, rowId }, "sandbox provisioned + active");
      // Render the DB ledger (skills / setup steps / box-local MCP) into the fresh box.
      await this.#bootstrap(botId, handle);
    } catch (err) {
      this.#logger.error({ botId, rowId, err: (err as Error).message }, "sandbox provision failed");
      // Surface a reason to the UI so a failed start/restart isn't silent. Keep it short and
      // non-secret — the raw provider message can carry gateway detail we don't want in the UI.
      this.#lastError.set(botId, "启动桌面失败,请稍后重试。");
      await this.#db
        .update(sandboxes)
        .set({ state: "kill", updatedAt: new Date() })
        .where(eq(sandboxes.id, rowId));
      await this.#db
        .update(bots)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(bots.id, botId));
    }
  }

  /** Build the UI-facing view, deriving the preview URL from persisted routing meta. */
  #view(
    id: string,
    botId: string,
    state: SandboxState,
    providerSandboxId: string | null,
    providerMeta: unknown,
  ): BotSandboxView {
    let preview: string | null = null;
    if (providerSandboxId && providerMeta && typeof providerMeta === "object") {
      try {
        preview = streamUrl(
          providerSandboxId,
          parseProviderMeta(providerMeta as Record<string, unknown>),
        );
      } catch {
        preview = null;
      }
    }
    return {
      id,
      botId,
      state,
      streamUrl: preview,
      screen: DESKTOP.screen,
      live: this.#handles.has(botId),
      error: this.#lastError.get(botId) ?? null,
    };
  }

  /** Expose the SandboxInfo shape for the domain contract when needed. */
  toSandboxInfo(view: BotSandboxView): SandboxInfo {
    return {
      sandboxId: view.id,
      state: view.state,
      streamUrl: view.streamUrl,
      screen: view.screen,
    };
  }
}
