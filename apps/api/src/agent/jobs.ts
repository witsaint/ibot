/**
 * Detached agent runs and the machinery that relays their results back into the conversation.
 *
 * A "task" is any run that isn't the live foreground chat turn: a human-initiated `background`
 * job, or a `subagent` the foreground agent spawned via `spawn_task`. Many can run at once (up to
 * the per-bot cap); GUI-driving tasks serialize on the exclusive desktop lease, pure-shell tasks
 * run truly in parallel.
 *
 * Ownership split:
 *   - The route (foreground) or the `spawn_task` closure resolves the run config, then calls
 *     `launchTask`. `launchTask` registers the task (cap check), inserts its `agent_jobs` row,
 *     creates its working dir, and fires the detached run.
 *   - This manager owns the detached execution: the abort registry (cancel), flipping the row to
 *     its terminal state, releasing the task registration, and — for a subagent — relaying the
 *     final answer back into the conversation.
 *
 * Result relay (the point of the whole thing): a subagent's steps stay OUT of the transcript
 * (`onComplete` instead of the default persist). When it finishes, `deliverTaskResult` frames the
 * answer and enqueues it on the bot's steer/relay queue. If the foreground voice is live, the
 * running loop drains it at its next step boundary (the agent "hears" the result mid-conversation);
 * if idle, a proactive turn is started to speak it. Either way the user learns the outcome without
 * having watched the task.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@i-bot/db";
import { agentJobs } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import type { AgentJobKind } from "@i-bot/types";
import { eq } from "drizzle-orm";
import type { ConversationEventBus } from "../events/bus.js";
import { loadHistory, resolveBotRunConfig } from "./resolve.js";
import { type RunAgentArgs, runAgentToCompletion } from "./run.js";
import type { SandboxManager } from "../sandbox/manager.js";

export interface JobManagerDeps {
  db: Database;
  logger: Logger;
  sandboxes: SandboxManager;
  events: ConversationEventBus;
}

/**
 * What `launchTask` needs. `run` is the resolved run config MINUS the fields this manager supplies
 * itself (abort/settle/completion/mode/gui/workdir): the caller provides credential + persona +
 * handle + history; the manager wires concurrency.
 */
export interface LaunchTaskArgs {
  botId: string;
  conversationId: string;
  kind: AgentJobKind;
  /** true = drives the browser/desktop (takes the GUI lease); false = pure shell, runs in parallel */
  needsDesktop: boolean;
  /** the task's goal — used for the row's instruction and to frame its relayed result */
  goal: string;
  run: Omit<
    RunAgentArgs,
    "abortSignal" | "onSettled" | "onComplete" | "mode" | "acquireGui" | "releaseGui" | "workdir"
  >;
}

export class JobManager {
  #db: Database;
  #logger: Logger;
  #sandboxes: SandboxManager;
  #events: ConversationEventBus;
  /** jobId → its abort controller, present only while the task is running. */
  #running = new Map<string, AbortController>();

  constructor(deps: JobManagerDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
    this.#sandboxes = deps.sandboxes;
    this.#events = deps.events;
  }

  /**
   * Start a detached task. Returns immediately with `{ taskId }` (the run proceeds in the
   * background) or `{ error }` if the bot is at its task cap. On success the caller can report the
   * id (a `spawn_task` ack, or a `/jobs` 202). The task registers, inserts its row, makes its
   * working dir, and finalizes itself (row + registration) when it settles.
   */
  async launchTask(args: LaunchTaskArgs): Promise<{ taskId: string } | { error: string }> {
    const jobId = randomUUID();

    // Cap check FIRST (atomic) — never insert a row we can't run.
    const reg = this.#sandboxes.tryRegisterTask(args.botId, {
      jobId,
      kind: args.kind,
      needsDesktop: args.needsDesktop,
      goal: args.goal,
    });
    if (!reg.ok) {
      return {
        error: `at task capacity — wait for a running task to finish before starting another`,
      };
    }

    try {
      await this.#db.insert(agentJobs).values({
        id: jobId,
        botId: args.botId,
        conversationId: args.conversationId,
        status: "running",
        kind: args.kind,
        needsDesktop: args.needsDesktop,
        instruction: args.goal.slice(0, 500),
      });
    } catch (err) {
      this.#sandboxes.unregisterTask(args.botId, jobId); // roll back the registration
      this.#logger.error({ jobId, err: errMessage(err) }, "failed to insert task row");
      return { error: "could not start the task (row insert failed)" };
    }

    this.#events.publish(args.conversationId, {
      type: "task.started",
      taskId: jobId,
      kind: args.kind,
      goal: args.goal,
      needsDesktop: args.needsDesktop,
    });
    this.#publishRunState(args.botId, args.conversationId);

    const controller = new AbortController();
    this.#running.set(jobId, controller);
    void this.#drive(jobId, args, controller);
    return { taskId: jobId };
  }

  /**
   * Cancel a running task: abort the model loop; finalize writes the row `canceled`. Progress
   * already persisted to `messages` (a background job) is kept. No-op if the task isn't running
   * in this process. Returns true if a running task was aborted.
   */
  cancel(jobId: string): boolean {
    const controller = this.#running.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * If a bot has queued relay/steer messages but no live foreground voice, start a proactive turn
   * to speak them. Called after a task result is enqueued and when a foreground turn settles (a
   * result that raced the final step must not be stranded). Atomic on `tryAcquireForeground`: if a
   * foreground turn is already live it's a no-op — that loop drains the queue itself.
   */
  flushPendingRelay(botId: string, conversationId: string): void {
    if (!this.#sandboxes.hasPendingSteer(botId)) return;
    if (!this.#sandboxes.tryAcquireForeground(botId, "proactive")) return; // a live turn will drain it
    void this.#runProactive(botId, conversationId);
  }

  /**
   * Reconcile orphaned tasks at boot. Any row still `running` was owned by a worker that no longer
   * exists, so it can never finish — flip it to `error`. Covers every kind (same query). Runs once
   * at startup; safe on an empty table.
   */
  async reclaimOrphans(): Promise<void> {
    const stuck = await this.#db.query.agentJobs.findMany({
      where: eq(agentJobs.status, "running"),
      columns: { id: true },
    });
    if (stuck.length === 0) return;
    await this.#db
      .update(agentJobs)
      .set({
        status: "error",
        error: "interrupted by a server restart",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentJobs.status, "running"));
    this.#logger.warn({ count: stuck.length }, "reclaimed orphaned tasks on boot");
  }

  // ---------- internals ----------

  /** Drive one task's run to completion, then finalize. Fire-and-forget from `launchTask`. */
  async #drive(jobId: string, args: LaunchTaskArgs, controller: AbortController): Promise<void> {
    const { botId, needsDesktop, kind } = args;

    // A task's file work is scoped to its own dir (best-effort — `run_command` cd's into it).
    const workdir = `/root/tasks/${jobId}`;
    try {
      await args.run.handle.run(`mkdir -p ${workdir}`, { timeoutMs: 10_000 });
    } catch {
      /* non-fatal — run_command's cd is guarded with `2>/dev/null` */
    }

    // GUI-driving tasks take the exclusive lease + full toolset; pure-shell tasks get run_command
    // only and never touch the lease (true parallelism). Human takeover gates the GUI either way.
    const guiWiring: Partial<RunAgentArgs> = needsDesktop
      ? {
          mode: "full",
          acquireGui: (r) => this.#sandboxes.acquireGui(botId, r),
          releaseGui: (t) => this.#sandboxes.releaseGui(botId, t),
          isHumanInControl: () => this.#sandboxes.isHumanInControl(botId),
        }
      : { mode: "concurrent-safe" };

    // A subagent's steps stay out of the transcript — its final text is relayed instead. A
    // background (human) job persists normally, like a foreground turn.
    const completion: Partial<RunAgentArgs> =
      kind === "subagent"
        ? { onComplete: (finalText) => this.#deliverTaskResult(args, jobId, finalText) }
        : {};

    await runAgentToCompletion({
      ...args.run,
      workdir,
      ...guiWiring,
      ...completion,
      abortSignal: controller.signal,
      onSettled: (outcome, error) => {
        if (outcome === "error" && !controller.signal.aborted) {
          this.#logger.error({ jobId, botId, kind, err: errMessage(error) }, "task run errored");
        }
      },
    })
      .then(() => this.#finalize(args, jobId, controller))
      .catch((err) => {
        this.#logger.error({ jobId, err: errMessage(err) }, "task run threw");
        return this.#finalize(args, jobId, controller, err);
      });
  }

  /**
   * A subagent finished: frame its answer, write it to the row, and enqueue it on the bot's relay
   * queue. Then flush — if the foreground voice is idle, start a proactive turn to speak it; if a
   * turn is live, that loop drains it at its next step boundary. Called from the run's `onComplete`.
   */
  async #deliverTaskResult(args: LaunchTaskArgs, jobId: string, finalText: string): Promise<void> {
    const { botId, conversationId, goal } = args;
    const shortId = jobId.slice(0, 8);
    const body = finalText.trim() || "(the task finished without a text answer)";
    // Tag the relayed message so the agent can attribute it (ordering + provenance) when several
    // tasks finish close together.
    const framed = `[task ${shortId} result] (goal: ${goal})\n${body}`;

    await this.#db
      .update(agentJobs)
      .set({ result: body.slice(0, 4000), updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId))
      .catch((err) => {
        this.#logger.error({ jobId, err: errMessage(err) }, "task result write failed");
      });

    this.#sandboxes.enqueueSteer(botId, framed);
    this.#events.publish(conversationId, {
      type: "task.done",
      taskId: jobId,
      summary: body.slice(0, 280),
    });
    // No-op if a foreground turn is live (it drains the queue); starts a proactive turn if idle.
    this.flushPendingRelay(botId, conversationId);
  }

  /**
   * Speak the bot's queued relay messages when no user turn is live: a headless foreground turn,
   * seeded with the conversation history, that drains the queue at its first step (via drainSteer)
   * so the model reacts to the task result(s) and persists a normal assistant message.
   */
  async #runProactive(botId: string, conversationId: string): Promise<void> {
    const resolved = await resolveBotRunConfig(this.#db, this.#sandboxes, botId);
    if (!resolved.ok) {
      // Can't run right now (no key / sandbox down). Release the voice and leave the relay queued;
      // a later task result or a user message will trigger another flush.
      this.#sandboxes.releaseForeground(botId);
      this.#logger.warn(
        { botId, reason: resolved.reason },
        "proactive relay turn could not resolve",
      );
      return;
    }

    try {
      const history = await loadHistory(this.#db, conversationId);
      await runAgentToCompletion({
        credential: resolved.config.credential,
        db: this.#db,
        handle: resolved.config.handle,
        botId,
        conversationId,
        systemPrompt: resolved.config.systemPrompt,
        modelId: resolved.config.modelId,
        temperature: resolved.config.temperature,
        history,
        mode: "full",
        boxMcpEndpoints: this.#sandboxes.boxMcpEndpoints(botId),
        logger: this.#logger,
        isHumanInControl: () => this.#sandboxes.isHumanInControl(botId),
        acquireGui: (r) => this.#sandboxes.acquireGui(botId, r),
        releaseGui: (t) => this.#sandboxes.releaseGui(botId, t),
        // drain the relay/steer queue (the task result seeded it, plus any user steer) at each step
        drainSteer: () => this.#sandboxes.drainSteer(botId),
        // a relay turn can also legitimately conclude it's blocked on the human — same wiring as
        // the foreground route so the pause is observable (parity).
        onHandoff: (p) => {
          this.#sandboxes.setAwaitingHuman(botId, true);
          this.#events.publish(conversationId, {
            type: "needs_human",
            reason: p.reason,
            kind: p.kind,
          });
          this.#publishRunState(botId, conversationId);
        },
        onSettled: () => {
          this.#sandboxes.releaseForeground(botId);
          // A result that arrived during this turn but after its last step → flush once more.
          this.flushPendingRelay(botId, conversationId);
        },
      });
      // The assistant message is persisted by the run's onFinish — tell the client to re-sync.
      this.#events.publish(conversationId, { type: "message.ready" });
      this.#publishRunState(botId, conversationId);
    } catch (err) {
      this.#sandboxes.releaseForeground(botId);
      this.#logger.error({ botId, err: errMessage(err) }, "proactive relay turn threw");
    }
  }

  /**
   * Terminal transition, once per task: write the row's final status, drop the abort controller,
   * release the task registration (and, for a subagent, the GUI lease is released by the run's
   * dispose), and publish the lifecycle event.
   */
  async #finalize(
    args: LaunchTaskArgs,
    jobId: string,
    controller: AbortController,
    thrown?: unknown,
  ): Promise<void> {
    this.#running.delete(jobId);
    this.#sandboxes.unregisterTask(args.botId, jobId);

    const status = controller.signal.aborted ? "canceled" : thrown ? "error" : "done";
    await this.#db
      .update(agentJobs)
      .set({
        status,
        error: status === "error" ? errMessage(thrown).slice(0, 500) : null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentJobs.id, jobId))
      .catch((err) => {
        this.#logger.error({ jobId, err: errMessage(err) }, "task finalize write failed");
      });

    if (status === "done") {
      // A background job's assistant output is in the transcript now → nudge a re-sync. A subagent
      // already published task.done from deliverTaskResult (and its result rides the relay queue).
      if (args.kind === "background") {
        this.#events.publish(args.conversationId, { type: "message.ready" });
      }
    } else {
      this.#events.publish(args.conversationId, {
        type: "task.error",
        taskId: jobId,
        error: status === "canceled" ? "canceled" : errMessage(thrown).slice(0, 280),
      });
    }
    this.#publishRunState(args.botId, args.conversationId);
  }

  /** Publish the bot's current run-state snapshot to the conversation's SSE listeners. */
  #publishRunState(botId: string, conversationId: string): void {
    const s = this.#sandboxes.runState(botId);
    this.#events.publish(conversationId, {
      type: "run.state",
      foreground: s.foreground,
      taskCount: s.taskCount,
      gui: s.gui,
      queueDepth: s.queueDepth,
      awaitingHuman: s.awaitingHuman,
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}
