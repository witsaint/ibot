/**
 * Skills: the "record → experience" endpoints. A bot's action trace is already persisted in
 * `messages`, so turning a finished conversation into a reusable skill is three steps the UI drives:
 *
 *   1. POST /skills/analyze { conversationId }  → distill the trace into a DRAFT (no write). Uses
 *      the bot OWNER's model credential — the platform never lends its key.
 *   2. POST /skills { botId, ...draft }          → publish the reviewed draft as a bot-scoped Skill.
 *   3. GET  /skills?botId= / DELETE /skills/:id   → list / remove a bot's skills.
 *
 * And the HUMAN-session variant, for a person driving the desktop through noVNC (whose input leaves
 * no tool trace — see agent/recording.ts):
 *
 *   4. POST /skills/recording/:botId/start|stop|status|discard → drive the on-box sampler.
 *   5. POST /skills/recording/:botId/analyze → pull the frames back and distill them (owner's
 *      vision model) into the same DRAFT shape; the client then reviews and publishes via step 2.
 *
 * Isolation: every route resolves ownership through `bots.ownerId → session user` before touching
 * anything — a conversation via its bot, a skill via its bot-scoped ownerRef. requireAuth is mounted
 * upstream (see server.ts) so `userId` is always present.
 */
import { bots, conversations, skills as skillsTable } from "@i-bot/db";
import { SkillDraft } from "@i-bot/types";
import { type Context, Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppBindings } from "../context.js";
import { distillSkillDraft } from "../agent/distill.js";
import { resolveModel } from "../agent/model.js";
import {
  discardRecording,
  distillRecording,
  pullRecording,
  recordingStatus,
  startRecording,
  stopRecording,
} from "../agent/recording.js";
import { loadHistory, ownerCredentialFor } from "../agent/resolve.js";
import { assertOwnerOfBot } from "../middleware/auth.js";
import {
  callableSkills,
  dedupeSkillsByPrecedence,
  resolvePluginsForBot,
} from "../plugins/resolve.js";
import { localPluginIdFor } from "../plugins/repository.js";

/**
 * Config-driven failures for this router: one code → { status, message } table instead of scattering
 * `c.json({ error, message }, status)` literals across handlers. The machine `error` code stays stable
 * for the client to branch on; the Chinese `message` (what the user actually sees) lives here, in one
 * place, alongside the context that makes it accurate. Matches the {error, message} shape the rest of
 * the API already returns (see settings.ts / chat.ts / bots.ts).
 */
const FAIL = {
  not_found: { status: 404, message: "找不到对应的资源,可能已被删除。" },
  bot_id_required: { status: 400, message: "缺少 botId 参数。" },
  invalid_body: { status: 400, message: "请求参数不合法。" },
  no_model_key: {
    status: 503,
    message: "还没配置模型密钥,无法分析。请先在设置里保存模型 API Key。",
  },
  nothing_to_analyze: { status: 422, message: "这段对话里没有可提炼的操作。" },
  analysis_failed: { status: 502, message: "分析失败,请重试。" },
  sandbox_not_ready: { status: 409, message: "桌面还没启动,无法录制。" },
  recorder_failed: { status: 502, message: "录制器没有响应,请重试。" },
  empty_recording: { status: 422, message: "这段录制里没有可分析的操作。" },
} as const;

type FailCode = keyof typeof FAIL;

/** Emit a configured failure. `extra` merges in per-call detail (e.g. Zod `issues`) without leaving
 * the table. */
function fail(c: Context<AppBindings>, code: FailCode, extra?: Record<string, unknown>) {
  const { status, message } = FAIL[code];
  return c.json({ error: code, message, ...extra }, status);
}

const AnalyzeBody = z.object({ conversationId: z.string().uuid() });

/** Publish body: the reviewed draft plus the bot it belongs to. */
const PublishBody = SkillDraft.extend({ botId: z.string().uuid() });

export const skillsRoutes = new Hono<AppBindings>()
  // ---------- list a bot's skills ----------
  .get("/", async (c) => {
    const botId = c.req.query("botId");
    if (!botId) return fail(c, "bot_id_required");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return fail(c, "not_found");

    const { db } = c.get("ctx");
    const rows = await db.query.skills.findMany({
      where: and(eq(skillsTable.scope, "bot"), eq(skillsTable.ownerRef, botId)),
      orderBy: [desc(skillsTable.createdAt)],
    });
    const resolved = await resolvePluginsForBot(db, botId);
    return c.json({ skills: dedupeSkillsByPrecedence(callableSkills(rows, resolved), resolved) });
  })

  // ---------- analyze a conversation into a draft (no write) ----------
  .post("/analyze", async (c) => {
    const body = AnalyzeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return fail(c, "invalid_body", { issues: body.error.issues });

    const { db } = c.get("ctx");
    // conversation → bot → owner: resolve the bot first, then the standard owner-of-bot gate.
    const convo = await db.query.conversations.findFirst({
      where: eq(conversations.id, body.data.conversationId),
      columns: { id: true, botId: true },
    });
    if (!convo) return fail(c, "not_found");
    const owned = await assertOwnerOfBot(c, convo.botId);
    if (!owned) return fail(c, "not_found");

    const bot = await db.query.bots.findFirst({ where: eq(bots.id, convo.botId) });
    if (!bot) return fail(c, "not_found");

    // The owner's own model does the distillation (never the platform key).
    const credential = await ownerCredentialFor(db, bot.ownerId);
    if (!credential) return fail(c, "no_model_key");

    const history = await loadHistory(db, convo.id);
    try {
      const model = resolveModel(credential, bot.model);
      const draft = await distillSkillDraft(model, history);
      return c.json({ draft });
    } catch (err) {
      if (err instanceof Error && err.message === "empty_trace") {
        return fail(c, "nothing_to_analyze");
      }
      console.error("[skills.analyze] distill failed", err);
      return fail(c, "analysis_failed");
    }
  })

  // ---------- human-session recording (a person driving the desktop) ----------
  // Start/stop/status/discard are thin shells over /opt/ibot-recorder.sh on the bot's box. They
  // need a LIVE handle (an active sandbox) — 409 otherwise, same as chat does.
  .post("/recording/:botId/:action{start|stop|status|discard}", async (c) => {
    const botId = c.req.param("botId");
    const action = c.req.param("action");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return fail(c, "not_found");

    const { sandboxes: mgr } = c.get("ctx");
    let handle;
    try {
      handle = await mgr.getHandle(botId);
    } catch {
      return fail(c, "sandbox_not_ready");
    }
    try {
      switch (action) {
        case "start": {
          await startRecording(handle);
          return c.json({ recording: true, frames: 0 });
        }
        case "stop": {
          const { frames } = await stopRecording(handle);
          return c.json({ recording: false, frames });
        }
        case "discard": {
          await discardRecording(handle);
          return c.json({ recording: false, frames: 0 });
        }
        default: {
          return c.json(await recordingStatus(handle));
        }
      }
    } catch (err) {
      console.error(`[skills.recording.${action}]`, err);
      return fail(c, "recorder_failed");
    }
  })

  // Pull the recorded frames back from the box and distill them into a draft. Stops the recorder
  // first if it's still running (pressing "analyze" IS the stop). The recording stays on the box
  // until the client discards it (after publish/cancel) so a failed analysis can be retried.
  .post("/recording/:botId/analyze", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return fail(c, "not_found");

    const { db, sandboxes: mgr } = c.get("ctx");
    const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
    if (!bot) return fail(c, "not_found");
    const credential = await ownerCredentialFor(db, bot.ownerId);
    if (!credential) return fail(c, "no_model_key");

    let handle;
    try {
      handle = await mgr.getHandle(botId);
    } catch {
      return fail(c, "sandbox_not_ready");
    }
    try {
      await stopRecording(handle);
      const rec = await pullRecording(handle);
      if (rec.frames.length === 0) return fail(c, "empty_recording");
      const model = resolveModel(credential, bot.model);
      const draft = await distillRecording(model, rec);
      return c.json({ draft, frames: rec.frames.length, durationMs: rec.durationMs });
    } catch (err) {
      if (err instanceof Error && err.message === "empty_recording") {
        return fail(c, "empty_recording");
      }
      console.error("[skills.recording.analyze] distill failed", err);
      return fail(c, "analysis_failed");
    }
  })

  // ---------- publish a reviewed draft as a bot skill ----------
  .post("/", async (c) => {
    const body = PublishBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return fail(c, "invalid_body", { issues: body.error.issues });

    const { botId, name, description, playbook, steps, secretRefs } = body.data;
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return fail(c, "not_found");

    const { db } = c.get("ctx");
    // A published recording lands in the bot's `local` plugin, the same bundle `save_skill` writes
    // to — so "record → experience" and "the agent learned it" produce one editable, exportable set.
    // Null when the bot has no local plugin yet; the skill is still valid without one.
    const pluginId = await localPluginIdFor(db, botId).catch(() => null);
    const [row] = await db
      .insert(skillsTable)
      .values({
        scope: "bot",
        ownerRef: botId,
        name,
        description,
        playbook,
        steps,
        secretRefs,
        pluginId,
      })
      .returning();
    return c.json({ skill: row }, 201);
  })

  // ---------- delete a bot skill ----------
  .delete("/:skillId", async (c) => {
    const skillId = c.req.param("skillId");
    const { db } = c.get("ctx");
    // skill → its bot ownerRef → owner. Only bot-scoped skills are deletable here; public/org
    // skills aren't owned by a single user via this path.
    const skill = await db.query.skills.findFirst({
      where: eq(skillsTable.id, skillId),
      columns: { id: true, scope: true, ownerRef: true },
    });
    if (!skill || skill.scope !== "bot" || !skill.ownerRef) {
      return fail(c, "not_found");
    }
    const owned = await assertOwnerOfBot(c, skill.ownerRef);
    if (!owned) return fail(c, "not_found");

    await db.delete(skillsTable).where(eq(skillsTable.id, skillId));
    return c.body(null, 204);
  });
