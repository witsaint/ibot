/**
 * Conversations + the chat endpoints. A chat turn is where the platform's "hands" meet its
 * "voice": it resolves the bot's live sandbox handle, then runs an agent turn while the model
 * drives the box.
 *
 * Concurrency model (see SandboxManager): a bot has ONE foreground voice (the live chat turn, or
 * a proactive turn the agent runs to relay a task result) PLUS up to a cap of detached tasks that
 * run alongside it. GUI-driving runs serialize on an exclusive desktop lease; pure-shell tasks run
 * in parallel. So the routes gate three different things, not one slot:
 *   - foreground (POST .../messages): `tryAcquireForeground` — a second foreground turn 409s, but
 *     background tasks never block chat.
 *   - steer (POST .../steer): inject into the LIVE foreground turn; 409 `not_running` (→ client
 *     sends a normal message, starting a fresh turn) when no foreground voice is live.
 *   - tasks (POST .../jobs): `launchTask` registers a detached run; 409 only at the task cap.
 *   - events (GET .../events): a per-conversation SSE stream pushing task/run lifecycle (replaces
 *     the old 2.5s poll).
 *
 * Isolation: owner-of-bot on every route; a conversation is reached only via its bot, so
 * `message → conversation → bot → owner` holds. The user message is persisted before the run
 * starts; a foreground/background run's assistant output is persisted by the run loop, while a
 * subagent's result is relayed back by the JobManager.
 */
import { randomUUID } from "node:crypto";
import type { SandboxHandle } from "@i-bot/core";
import {
  agentJobs,
  bots,
  conversations,
  messages as messagesTable,
  userModelCredentials,
} from "@i-bot/db";
import type { MessagePart } from "@i-bot/types";
import { type UIMessage, validateUIMessages } from "ai";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppBindings, AppContext } from "../context.js";
import type { ModelCredential } from "../agent/model.js";
import { runAgentStream } from "../agent/run.js";
import { decryptSecret } from "../crypto.js";
import { assertOwnerOfBot } from "../middleware/auth.js";

/**
 * Resolve the bot OWNER's own model credential (decrypt just-in-time). Multi-tenant: the
 * platform never lends its key — a user with no stored key can't run the agent loop.
 * Returns null when the owner hasn't configured one → the route answers 503.
 */
async function ownerCredential(
  c: Context<AppBindings>,
  ownerId: string,
): Promise<ModelCredential | null> {
  const { db } = c.get("ctx");
  const row = await db.query.userModelCredentials.findFirst({
    where: eq(userModelCredentials.userId, ownerId),
    columns: { apiKeyCiphertext: true, baseUrl: true },
  });
  if (!row) return null;
  return { apiKey: decryptSecret(row.apiKeyCiphertext), baseURL: row.baseUrl };
}

/** Load a conversation and assert (via its bot) the session user owns it. */
async function ownedConversation(
  c: Context<AppBindings>,
  conversationId: string,
): Promise<{ id: string; botId: string } | null> {
  const { db } = c.get("ctx");
  const convo = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, botId: true },
  });
  if (!convo) return null;
  const owned = await assertOwnerOfBot(c, convo.botId);
  if (!owned) return null;
  return convo;
}

const SendMessage = z.object({
  /** the new user message as UIMessage parts (text + optional file parts) */
  parts: z.array(z.object({ type: z.string() }).passthrough()),
});

/** A resolved turn: everything a run needs, gathered before any write. */
interface ResolvedTurn {
  botId: string;
  ownerId: string;
  systemPrompt: string;
  modelId: string;
  temperature: number | null;
  credential: ModelCredential;
  handle: SandboxHandle;
}

/**
 * Gather the inputs a turn needs (bot, owner credential, live handle) with no side effects.
 * On any failure returns a ready-to-send error `Response` (404 / 503 / 409) instead — the
 * caller returns it directly. This runs BEFORE claiming the run slot so a failed resolve
 * never leaves the bot marked busy.
 */
async function resolveTurn(
  c: Context<AppBindings>,
  botId: string,
): Promise<{ ok: true; turn: ResolvedTurn } | { ok: false; res: Response }> {
  const ctx = c.get("ctx");
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot) return { ok: false, res: c.json({ error: "bot not found" }, 404) };

  const credential = await ownerCredential(c, bot.ownerId);
  if (!credential) {
    return {
      ok: false,
      res: c.json({ error: "no_model_key", message: "请先在设置里录入你的模型 API Key" }, 503),
    };
  }

  let handle: SandboxHandle;
  try {
    handle = await ctx.sandboxes.getHandle(botId);
  } catch (err) {
    return {
      ok: false,
      res: c.json(
        { error: "sandbox not ready", detail: err instanceof Error ? err.message : String(err) },
        409,
      ),
    };
  }

  return {
    ok: true,
    turn: {
      botId,
      ownerId: bot.ownerId,
      systemPrompt: bot.systemPrompt,
      modelId: bot.model,
      temperature: bot.temperature,
      credential,
      handle,
    },
  };
}

/** Persist the just-sent user message, bump the conversation, and return the full UI history. */
async function persistUserAndLoadHistory(
  ctx: AppContext,
  conversationId: string,
  parts: MessagePart[],
): Promise<UIMessage[]> {
  await ctx.db.insert(messagesTable).values({ conversationId, role: "user", parts });
  await ctx.db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  const rows = await ctx.db.query.messages.findMany({
    where: eq(messagesTable.conversationId, conversationId),
    orderBy: [asc(messagesTable.createdAt)],
  });
  return validateUIMessages({
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role === "system" ? "assistant" : r.role,
      parts: r.parts,
    })) as unknown as UIMessage[],
  });
}

/** Push the bot's current run-state snapshot to the conversation's SSE listeners (best-effort). */
function publishRunState(ctx: AppContext, botId: string, conversationId: string): void {
  const s = ctx.sandboxes.runState(botId);
  ctx.events.publish(conversationId, {
    type: "run.state",
    foreground: s.foreground,
    taskCount: s.taskCount,
    gui: s.gui,
    queueDepth: s.queueDepth,
    awaitingHuman: s.awaitingHuman,
  });
}

/** A short plain-text summary of a user message, for the job row's `instruction`. */
function instructionFromParts(parts: MessagePart[]): string {
  return parts
    .filter((p): p is MessagePart & { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim()
    .slice(0, 500);
}

export const chatRoutes = new Hono<AppBindings>()
  // ---------- list a bot's conversations ----------
  .get("/bots/:botId/conversations", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { db } = c.get("ctx");
    const rows = await db.query.conversations.findMany({
      where: eq(conversations.botId, botId),
      orderBy: [desc(conversations.updatedAt)],
    });
    return c.json({ conversations: rows });
  })

  // ---------- create a conversation ----------
  .post("/bots/:botId/conversations", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const title = typeof body?.title === "string" ? body.title.slice(0, 200) : null;

    const { db } = c.get("ctx");
    const [row] = await db.insert(conversations).values({ botId, title }).returning();
    return c.json({ conversation: row }, 201);
  })

  // ---------- read a conversation's messages ----------
  .get("/conversations/:conversationId/messages", async (c) => {
    const conversationId = c.req.param("conversationId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { db } = c.get("ctx");
    const rows = await db.query.messages.findMany({
      where: eq(messagesTable.conversationId, conversationId),
      orderBy: [asc(messagesTable.createdAt)],
    });
    return c.json({ messages: rows });
  })

  // ---------- send a message + stream the agent turn (FOREGROUND) ----------
  .post("/conversations/:conversationId/messages", async (c) => {
    const conversationId = c.req.param("conversationId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const ctx = c.get("ctx");
    const parsed = SendMessage.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    const resolved = await resolveTurn(c, owned.botId);
    if (!resolved.ok) return resolved.res;
    const { turn } = resolved;

    // Claim the bot's foreground voice BEFORE any write. Busy = another foreground/proactive turn
    // is already streaming → 409, persist nothing. Background tasks do NOT block this.
    if (!ctx.sandboxes.tryAcquireForeground(owned.botId, "user")) {
      return c.json({ error: "busy", message: "这个 bot 正在回复中,请等它说完或先停止" }, 409);
    }

    let history: UIMessage[];
    try {
      history = await persistUserAndLoadHistory(
        ctx,
        conversationId,
        parsed.data.parts as MessagePart[],
      );
    } catch (err) {
      ctx.sandboxes.releaseForeground(owned.botId); // never strand the voice on a pre-run failure
      throw err;
    }

    publishRunState(ctx, owned.botId, conversationId);

    return runAgentStream({
      credential: turn.credential,
      db: ctx.db,
      handle: turn.handle,
      botId: owned.botId,
      conversationId,
      systemPrompt: turn.systemPrompt,
      modelId: turn.modelId,
      temperature: turn.temperature,
      history,
      mode: "full",
      // the bot's box-local MCP endpoints (started by bootstrap) so the run can dial them
      boxMcpEndpoints: ctx.sandboxes.boxMcpEndpoints(owned.botId),
      logger: ctx.logger,
      // gate the GUI tools while a human holds this bot's desktop
      isHumanInControl: () => ctx.sandboxes.isHumanInControl(owned.botId),
      // serialize GUI use on the one box (concurrent tasks contend for the same lease)
      acquireGui: (r) => ctx.sandboxes.acquireGui(owned.botId, r),
      releaseGui: (t) => ctx.sandboxes.releaseGui(owned.botId, t),
      // let the agent spawn detached tasks that run while it keeps chatting
      spawnTask: (goal, needsDesktop) =>
        ctx.jobs.launchTask({
          botId: owned.botId,
          conversationId,
          kind: "subagent",
          needsDesktop,
          goal,
          run: {
            credential: turn.credential,
            db: ctx.db,
            handle: turn.handle,
            botId: owned.botId,
            conversationId,
            systemPrompt: turn.systemPrompt,
            modelId: turn.modelId,
            temperature: turn.temperature,
            boxMcpEndpoints: ctx.sandboxes.boxMcpEndpoints(owned.botId),
            logger: ctx.logger,
            // a self-contained subagent: seed it with just its goal (its steps stay off-transcript)
            history: [
              { id: randomUUID(), role: "user", parts: [{ type: "text", text: goal }] },
            ] as unknown as UIMessage[],
          },
        }),
      // inject any mid-run steering / relayed task results at each step boundary
      drainSteer: () => ctx.sandboxes.drainSteer(owned.botId),
      // the model called request_handoff — it's blocked on the human. Flag the bot as awaiting the
      // human and push a needs_human event so the UI shows a paused state (not a busy spinner). The
      // flag clears when the next foreground turn is acquired (the user's reply resumes the run).
      onHandoff: (p) => {
        ctx.sandboxes.setAwaitingHuman(owned.botId, true);
        ctx.events.publish(conversationId, {
          type: "needs_human",
          reason: p.reason,
          kind: p.kind,
        });
        publishRunState(ctx, owned.botId, conversationId);
      },
      // release the voice when the turn settles, then flush any task result that raced the last step
      onSettled: () => {
        ctx.sandboxes.releaseForeground(owned.botId);
        ctx.jobs.flushPendingRelay(owned.botId, conversationId);
        publishRunState(ctx, owned.botId, conversationId);
      },
    });
  })

  // ---------- steer the IN-FLIGHT turn (mid-run message) ----------
  // Inject a user message into the run already holding this bot's slot, instead of opening a
  // second turn (which single-flight would 409). The running loop's prepareStep drains it at the
  // next step boundary. If no run is active (race: it just finished), 409 `not_running` so the
  // client falls back to a normal send. The message IS persisted (real user message, real
  // timestamp) so the transcript records what the user said mid-run.
  .post("/conversations/:conversationId/steer", async (c) => {
    const conversationId = c.req.param("conversationId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const ctx = c.get("ctx");
    const parsed = SendMessage.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    // Only steer a LIVE foreground turn — that's the loop whose prepareStep drains the queue. If
    // none is live (idle, or only background tasks running), 409 so the client sends a normal
    // message instead, which starts a fresh foreground turn.
    if (!ctx.sandboxes.foregroundActive(owned.botId)) {
      return c.json(
        { error: "not_running", message: "现在没有正在进行的回复,请直接发送消息" },
        409,
      );
    }

    const parts = parsed.data.parts as MessagePart[];
    const text = instructionFromParts(parts);
    if (!text) return c.json({ error: "empty", message: "消息为空" }, 400);

    // Persist as a normal user message (verbatim parts) so the transcript is truthful, then
    // enqueue the plain text for injection into the running loop.
    await ctx.db.insert(messagesTable).values({ conversationId, role: "user", parts });
    await ctx.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    ctx.sandboxes.enqueueSteer(owned.botId, text);

    return c.json({ ok: true as const }, 202);
  })

  // ---------- kick off a human-initiated BACKGROUND task ----------
  .post("/conversations/:conversationId/jobs", async (c) => {
    const conversationId = c.req.param("conversationId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const ctx = c.get("ctx");
    const parsed = SendMessage.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    const resolved = await resolveTurn(c, owned.botId);
    if (!resolved.ok) return resolved.res;
    const { turn } = resolved;

    const parts = parsed.data.parts as MessagePart[];
    // Persist the human's kickoff message so it shows in the transcript, then load history for the
    // detached run. (A background job persists its assistant output like a foreground turn.)
    const history = await persistUserAndLoadHistory(ctx, conversationId, parts);

    // launchTask does the cap check + row insert + detached run. 409 only when at the task cap —
    // an in-flight foreground turn or other tasks do NOT block a new background task.
    const launched = await ctx.jobs.launchTask({
      botId: owned.botId,
      conversationId,
      kind: "background",
      needsDesktop: true, // a human background job may drive the desktop (unchanged from before)
      goal: instructionFromParts(parts),
      run: {
        credential: turn.credential,
        db: ctx.db,
        handle: turn.handle,
        botId: owned.botId,
        conversationId,
        systemPrompt: turn.systemPrompt,
        modelId: turn.modelId,
        temperature: turn.temperature,
        boxMcpEndpoints: ctx.sandboxes.boxMcpEndpoints(owned.botId),
        logger: ctx.logger,
        history,
      },
    });
    if ("error" in launched) {
      return c.json({ error: "busy", message: "并发任务已达上限,请等一个任务完成后再试" }, 409);
    }

    return c.json({ jobId: launched.taskId, status: "running" as const }, 202);
  })

  // ---------- poll the active/latest background task for a conversation (SSE-backed now) ----------
  .get("/conversations/:conversationId/jobs/active", async (c) => {
    const conversationId = c.req.param("conversationId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const ctx = c.get("ctx");
    const [job] = await ctx.db.query.agentJobs.findMany({
      where: eq(agentJobs.conversationId, conversationId),
      orderBy: [desc(agentJobs.createdAt)],
      limit: 1,
    });
    // `running` is true when the bot is doing anything for this conversation — a live foreground
    // voice OR any detached task. `job` is the latest task row (terminal status / error / result).
    const state = ctx.sandboxes.runState(owned.botId);
    return c.json({
      job: job ?? null,
      running: state.foreground || state.taskCount > 0,
      state,
    });
  })

  // ---------- live conversation events (SSE — replaces the 2.5s job poll) ----------
  .get("/conversations/:conversationId/events", async (c) => {
    const conversationId = c.req.param("conversationId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const ctx = c.get("ctx");
    return streamSSE(c, async (stream) => {
      let open = true;
      const pending: unknown[] = [];
      let wake: (() => void) | null = null;
      const unsub = ctx.events.subscribe(conversationId, (ev) => {
        pending.push(ev);
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        wake?.();
      });

      try {
        // Send a run.state snapshot immediately so a just-connected (or reconnected) client is in
        // sync without waiting for the next lifecycle change.
        const s = ctx.sandboxes.runState(owned.botId);
        await stream.writeSSE({
          data: JSON.stringify({
            type: "run.state",
            foreground: s.foreground,
            taskCount: s.taskCount,
            gui: s.gui,
            queueDepth: s.queueDepth,
            awaitingHuman: s.awaitingHuman,
          }),
        });

        // A long-lived SSE pump: `open` flips to false in stream.onAbort / disconnect, and each
        // frame must be written in order, so the awaits are inherently sequential (not batchable).
        /* eslint-disable no-await-in-loop, no-unmodified-loop-condition -- see above */
        while (open) {
          while (pending.length > 0 && open) {
            await stream.writeSSE({ data: JSON.stringify(pending.shift()) });
          }
          if (!open) break;
          // Wait for the next event, or a ~15s heartbeat (keeps proxies from idling the stream).
          await new Promise<void>((resolve) => {
            wake = resolve;
            const timer = setTimeout(() => {
              wake = null;
              resolve();
            }, 15_000);
            if (typeof timer.unref === "function") timer.unref();
          });
          wake = null;
          if (open && pending.length === 0) {
            await stream.writeSSE({ event: "ping", data: "" });
          }
        }
        /* eslint-enable no-await-in-loop, no-unmodified-loop-condition */
      } finally {
        unsub();
      }
    });
  })

  // ---------- cancel a running background job ----------
  .post("/conversations/:conversationId/jobs/:jobId/cancel", async (c) => {
    const conversationId = c.req.param("conversationId");
    const jobId = c.req.param("jobId");
    const owned = await ownedConversation(c, conversationId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const ctx = c.get("ctx");
    // Confirm the job belongs to this conversation before touching it (isolation).
    const job = await ctx.db.query.agentJobs.findFirst({
      where: eq(agentJobs.id, jobId),
      columns: { id: true, conversationId: true, status: true },
    });
    if (!job || job.conversationId !== conversationId) return c.json({ error: "not found" }, 404);
    if (job.status !== "running") return c.json({ jobId, status: job.status });

    ctx.jobs.cancel(jobId); // aborts the loop; the run's finalize writes status=canceled
    return c.json({ jobId, status: "canceling" as const });
  });
