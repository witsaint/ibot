/**
 * Bot CRUD + sandbox lifecycle. Every route is authenticated (requireAuth mounts upstream)
 * and every route touching a specific bot runs the owner-of-bot check first — no query
 * trusts a bot id it didn't resolve through `bots.ownerId → session user`.
 */
import { bots } from "@i-bot/db";
import { SecretKind } from "@i-bot/types";
import { Hono } from "hono";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppBindings } from "../context.js";
import { assertOwnerOfBot } from "../middleware/auth.js";
import { ensureBotPlugins } from "../plugins/builtin.js";
import { botPluginsHandler } from "./plugins.js";
import { deleteSecret, isValidSecretName, listSecrets, putSecret } from "../secrets/vault.js";

/** Body for a bot-scoped secret (mirrors the user-scoped one in settings). */
const PutSecret = z.object({
  kind: SecretKind,
  value: z.string().min(1).max(8000),
  headerName: z.string().min(1).max(120).optional(),
});

const CreateBot = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).nullable().optional(),
  avatar: z.string().max(500).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  model: z.string().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  /** sandbox egress channel: true = public (clean IP), false = internal, null = inherit fleet default. */
  sandboxPublic: z.boolean().nullable().optional(),
});

// Update allows the create fields (all optional) plus `pinned` — the right-click Pin/Unpin
// toggle writes through the same PATCH. `sortOrder` is NOT settable here; the whole-list
// order is written atomically via PATCH /reorder so indices never collide.
const UpdateBot = CreateBot.partial().extend({
  pinned: z.boolean().optional(),
});

/** Body for PATCH /reorder: the caller's full bot-id list in the desired within-tier order. */
const ReorderBots = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export const botsRoutes = new Hono<AppBindings>()
  // ---------- list my bots ----------
  .get("/", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const rows = await db.query.bots.findMany({
      where: eq(bots.ownerId, userId),
      // pinned first, then the persisted within-tier order, then most-recently-updated as a
      // stable tiebreaker for bots that share a sortOrder (e.g. all-0 before any drag).
      orderBy: [desc(bots.pinned), asc(bots.sortOrder), desc(bots.updatedAt)],
    });
    return c.json({ bots: rows });
  })

  // ---------- create a bot ----------
  .post("/", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const body = CreateBot.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);

    const [row] = await db
      .insert(bots)
      .values({
        ownerId: userId,
        name: body.data.name,
        description: body.data.description ?? null,
        avatar: body.data.avatar ?? null,
        systemPrompt: body.data.systemPrompt ?? "",
        model: body.data.model ?? "pa/claude-opus-5-ppinfra",
        temperature: body.data.temperature ?? null,
        // null (unset) = inherit the fleet default at box-create time; a concrete bool is an override.
        sandboxPublic: body.data.sandboxPublic ?? null,
        status: "creating",
      })
      .returning();

    // Give the new bot its capability baseline: the owner's builtin installs (so a brand-new signup
    // doesn't wait for a restart to have core) plus this bot's own `local` plugin — the bundle its
    // recorded skills will land in. Awaited so the first turn already resolves a complete set; it
    // never throws, so a failure here degrades to the nine primitives instead of failing the create.
    const { logger } = c.get("ctx");
    await ensureBotPlugins(db, {
      botId: row!.id,
      ownerId: userId,
      botName: row!.name,
      logger,
    });
    return c.json({ bot: row }, 201);
  })

  // ---------- reorder my bots (drag-to-reorder persistence) ----------
  // Declared BEFORE /:botId so "reorder" isn't captured as a bot id. Writes each bot's sortOrder
  // to its index in `ids`. Ownership is enforced in one batch: every id must resolve to a bot the
  // caller owns, or the whole request 404s (never a partial write). Pinned/unpinned tiers share
  // the index space — the list route sorts pinned-first, so order within each tier is preserved.
  .patch("/reorder", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const body = ReorderBots.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);

    const { ids } = body.data;
    if (new Set(ids).size !== ids.length) {
      return c.json({ error: "duplicate ids" }, 400);
    }

    // Batch ownership check: fetch the caller's bots among the submitted ids; every id must be
    // present, or someone slipped in a bot they don't own.
    const owned = await db.query.bots.findMany({
      where: (b, { and, eq: eqOp }) => and(eqOp(b.ownerId, userId), inArray(b.id, ids)),
      columns: { id: true },
    });
    if (owned.length !== ids.length) {
      return c.json({ error: "not found" }, 404);
    }

    // Write every index in one transaction so the rail never reads a half-applied order.
    await db.transaction(async (tx) => {
      await Promise.all(
        ids.map((id, index) => tx.update(bots).set({ sortOrder: index }).where(eq(bots.id, id))),
      );
    });
    return c.body(null, 204);
  })

  // ---------- get one bot (+ its sandbox view) ----------
  .get("/:botId", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { db, sandboxes: mgr } = c.get("ctx");
    const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
    const sandbox = await mgr.getView(botId);
    return c.json({ bot, sandbox });
  })

  // ---------- update a bot ----------
  .patch("/:botId", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const body = UpdateBot.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);

    const { db } = c.get("ctx");
    const [row] = await db
      .update(bots)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(bots.id, botId))
      .returning();
    return c.json({ bot: row });
  })

  // ---------- delete a bot (cascades to sandbox/conversations) ----------
  .delete("/:botId", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { db, sandboxes: mgr } = c.get("ctx");
    await mgr.destroy(botId).catch(() => {});
    await db.delete(bots).where(eq(bots.id, botId));
    return c.body(null, 204);
  })

  // ---------- provision / ensure the sandbox ----------
  .post("/:botId/sandbox", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { sandboxes: mgr } = c.get("ctx");
    const view = await mgr.ensureSandbox(botId);
    return c.json({ sandbox: view });
  })

  // ---------- poll sandbox status (UI polls this until state=active) ----------
  .get("/:botId/sandbox", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { sandboxes: mgr } = c.get("ctx");
    const view = await mgr.getView(botId);
    if (!view) return c.json({ sandbox: null });
    return c.json({ sandbox: view });
  })

  // ---------- tear down the sandbox ----------
  .delete("/:botId/sandbox", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { sandboxes: mgr } = c.get("ctx");
    await mgr.destroy(botId);
    return c.body(null, 204);
  })

  // ---------- desktop control arbitration (human takeover) ----------
  // The UI calls this when the user takes/releases control of the live desktop. While held,
  // the agent's desktop_action is refused server-side so the two don't fight over display :0.
  .put("/:botId/sandbox/control", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const body = z.object({ held: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);

    const { sandboxes: mgr } = c.get("ctx");
    mgr.setHumanControl(botId, body.data.held);
    return c.json({ held: body.data.held });
  })

  // ---------- this bot's effective capability set ----------
  // The same resolution the run loop performs, so the composer menu offers exactly what the model
  // can call. Handler lives in routes/plugins.ts; mounted here to keep bot ownership checks together.
  .get("/:botId/plugins", botPluginsHandler)

  // ---------- bot-scoped secrets (this bot only) ----------
  // Back `{{secrets.NAME}}` for a single bot. Owner-gated; write-only value (never returned);
  // reads expose only name/kind/hint. A bot-scoped secret shadows a user-scoped one of the same
  // name when the agent resolves it.
  .get("/:botId/secrets", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { db } = c.get("ctx");
    const secrets = await listSecrets(db, { ownerType: "bot", botId });
    return c.json({ secrets });
  })

  .put("/:botId/secrets/:name", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const name = c.req.param("name");
    if (!isValidSecretName(name)) {
      return c.json(
        { error: "invalid name", message: "名称只能包含字母、数字、下划线，长度 ≤120" },
        400,
      );
    }
    const parsed = PutSecret.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    const { db } = c.get("ctx");
    const secret = await putSecret(db, {
      owner: { ownerType: "bot", botId },
      name,
      kind: parsed.data.kind,
      value: parsed.data.value,
      headerName: parsed.data.headerName,
    });
    return c.json({ secret });
  })

  .delete("/:botId/secrets/:name", async (c) => {
    const botId = c.req.param("botId");
    const owned = await assertOwnerOfBot(c, botId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const { db } = c.get("ctx");
    await deleteSecret(db, { ownerType: "bot", botId }, c.req.param("name"));
    return c.body(null, 204);
  });
