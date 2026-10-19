/**
 * Plugin read endpoints.
 *
 * P1 ships the two READS the rest of the system needs to become visible:
 *   GET /plugins                 — the caller's installs, with what each plugin contributes
 *   GET /plugins/:pluginId       — one plugin in full (its manifest)
 *   GET /bots/:botId/plugins     — mounted from bots.ts: the effective capability snapshot for a bot,
 *                                  i.e. exactly what `resolvePluginsForBot` hands the run loop
 *
 * P3 adds the write side:
 *   POST   /plugins/inspect        — read a directory into a manifest and report what it WOULD do,
 *                                    including every command that would run in a box. Nothing is
 *                                    stored and nothing is executed.
 *   POST   /plugins/install        — install from a directory (control plane) and materialize into
 *                                    the owner's bots (execution plane, per-bot status)
 *   PATCH  /plugins/:pluginId      — enable/disable, or change which bots it applies to
 *   DELETE /plugins/:pluginId      — uninstall: rows removed, box processes stopped, dir deleted
 *
 * "Install" is deliberately not one boolean. The control-plane half either fully succeeds or fully
 * fails; the execution half is per-bot and can be `pending` simply because a sandbox is cold. The
 * response says which, per bot, rather than flattening it into a ✓ that would be a lie for a bot
 * whose box hasn't run the setup steps yet.
 *
 * Isolation: every read filters on the session user as the install owner. A `plugins` row is shared
 * content with no tenant data, so it's safe to return — but only to someone who has it installed,
 * which is why the detail route resolves through the caller's installs rather than by id alone.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AppContext } from "../context.js";
import { importPluginDirectory, inspectManifest } from "../plugins/import-dir.js";
import {
  type BoxAccess,
  installPlugin,
  setPluginBots,
  uninstallPlugin,
} from "../plugins/install.js";
import { agentToolName, ManifestError } from "../plugins/manifest.js";
import { RENDER_CARD_TOOL, templateId } from "../plugins/ui-templates.js";
import { listInstallsForOwner } from "../plugins/repository.js";
import { CORE_PLUGIN_KEY, resolvePluginsForBot } from "../plugins/resolve.js";
import { assertOwnerOfBot } from "../middleware/auth.js";
import { pluginInstalls } from "@i-bot/db";
import { and, eq } from "drizzle-orm";

const FAIL = {
  not_found: { status: 404, message: "找不到这个插件,可能已被卸载。" },
  bad_request: { status: 400, message: "请求参数不对。" },
  invalid_manifest: { status: 422, message: "这个插件包没通过校验,详情见 issues。" },
  locked: { status: 409, message: "核心插件不能卸载或停用。" },
  import_failed: { status: 400, message: "读不出这个目录,确认路径对不对。" },
} as const;

type FailCode = keyof typeof FAIL;

function fail(c: Context<AppBindings>, code: FailCode, extra?: Record<string, unknown>) {
  const { status, message } = FAIL[code];
  return c.json({ error: code, message, ...extra }, status);
}

/**
 * Adapt the sandbox manager to the narrow seam `installPlugin` needs.
 *
 * `handleFor` must NOT provision: installing a plugin is not a reason to spin up a box (that's a
 * minutes-long, billable operation the user didn't ask for). A cold box yields `pending`, and the
 * plugin lands the next time the bot actually starts — which is what bootstrap is for.
 */
function boxAccess(ctx: AppContext): BoxAccess {
  return {
    async handleFor(botId) {
      try {
        return await ctx.sandboxes.getHandle(botId);
      } catch {
        return null; // not active → pending, never an install failure
      }
    },
    registerBoxMcp(botId, endpoints) {
      ctx.sandboxes.registerBoxMcp(botId, endpoints);
    },
  };
}

const InstallBody = z.object({
  /** a plugin directory on the API host — the builtin/dev path. Zip + git URL come later. */
  dir: z.string().min(1),
  key: z.string().min(1).max(160).optional(),
  version: z.string().min(1).max(40).optional(),
  /** null / omitted = every bot this owner has, now and later */
  enabledBots: z.array(z.string()).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  enabledBots: z.array(z.string()).nullable().optional(),
});

/**
 * The one-line summary the UI shows on a plugin card: how many of each thing it brings. Counting
 * happens here (not in the client) so every surface — settings list, detail header, install preview —
 * agrees on what "3 skills · 1 MCP" means.
 */
function summarize(manifest: {
  skills: { hidden: boolean }[];
  mcpServers: unknown[];
  agents: unknown[];
  ui: unknown[];
  setupSteps: unknown[];
  hooks: unknown[];
  providedTools: unknown[];
}) {
  return {
    // hidden skills are real but invisible to the model; counting them would overstate the plugin.
    skills: manifest.skills.filter((s) => !s.hidden).length,
    hiddenSkills: manifest.skills.filter((s) => s.hidden).length,
    mcpServers: manifest.mcpServers.length,
    agents: manifest.agents.length,
    cards: manifest.ui.length,
    setupSteps: manifest.setupSteps.length,
    hooks: manifest.hooks.length,
    tools: manifest.providedTools.length,
  };
}

export const pluginsRoutes = new Hono<AppBindings>()
  // ---------- preview: what would this plugin do? ----------
  // Separate from install ON PURPOSE. The whole security story is that a user sees every command
  // that will run in their box BEFORE agreeing to it, so the preview has to be callable without
  // side effects: this route reads files, builds a manifest, and stores nothing.
  .post("/inspect", async (c) => {
    const body = InstallBody.pick({ dir: true, key: true, version: true }).safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) return fail(c, "bad_request", { issues: body.error.issues });

    try {
      const manifest = await importPluginDirectory(body.data.dir, {
        ...(body.data.key ? { key: body.data.key } : {}),
        ...(body.data.version ? { version: body.data.version } : {}),
      });
      return c.json({ inspection: inspectManifest(manifest), manifest });
    } catch (err) {
      if (err instanceof ManifestError) {
        return fail(c, "invalid_manifest", { issues: err.issues });
      }
      return fail(c, "import_failed", { detail: (err as Error).message });
    }
  })

  // ---------- install ----------
  .post("/install", async (c) => {
    const ctx = c.get("ctx");
    const userId = c.get("userId");
    const body = InstallBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return fail(c, "bad_request", { issues: body.error.issues });

    let manifest;
    try {
      manifest = await importPluginDirectory(body.data.dir, {
        ...(body.data.key ? { key: body.data.key } : {}),
        ...(body.data.version ? { version: body.data.version } : {}),
      });
    } catch (err) {
      if (err instanceof ManifestError) return fail(c, "invalid_manifest", { issues: err.issues });
      return fail(c, "import_failed", { detail: (err as Error).message });
    }

    try {
      const result = await installPlugin({
        db: ctx.db,
        ownerId: userId,
        manifest,
        source: "installed",
        enabledBots: body.data.enabledBots ?? null,
        ...(body.data.config ? { config: body.data.config } : {}),
        box: boxAccess(ctx),
        logger: ctx.logger,
      });
      return c.json({
        plugin: {
          pluginId: result.plugin.id,
          key: result.plugin.key,
          version: result.plugin.version,
          displayName: result.plugin.displayName,
          summary: summarize(result.plugin.manifest),
        },
        installId: result.install.id,
        // Surfaced rather than fatal: the plugin is installed, and the parts that need a secret
        // fail with a clear reason until the user stores it.
        missingSecrets: result.missingSecrets,
        // Per-bot, three-valued. A plugin ready on one bot and pending on another is normal.
        bots: result.bots,
        ignored: manifest.ignored,
      });
    } catch (err) {
      if (err instanceof ManifestError) return fail(c, "invalid_manifest", { issues: err.issues });
      throw err;
    }
  })

  // ---------- enable / disable / retarget ----------
  .patch("/:pluginId", async (c) => {
    const ctx = c.get("ctx");
    const userId = c.get("userId");
    const pluginId = c.req.param("pluginId");
    const body = PatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return fail(c, "bad_request", { issues: body.error.issues });

    const rows = await listInstallsForOwner(ctx.db, userId);
    const found = rows.find(({ plugin }) => plugin.id === pluginId);
    if (!found) return fail(c, "not_found");
    // Core carries the nine primitives' declarations; without it a bot has no tools at all.
    if (found.plugin.key === CORE_PLUGIN_KEY && body.data.enabled === false) {
      return fail(c, "locked");
    }

    if (body.data.enabled !== undefined) {
      await ctx.db
        .update(pluginInstalls)
        .set({ enabled: body.data.enabled })
        .where(
          and(eq(pluginInstalls.id, found.install.id), eq(pluginInstalls.ownerId, userId)),
        );
    }

    let bots: Awaited<ReturnType<typeof setPluginBots>>["bots"] = [];
    if (body.data.enabledBots !== undefined) {
      const result = await setPluginBots({
        db: ctx.db,
        ownerId: userId,
        pluginId,
        enabledBots: body.data.enabledBots,
        box: boxAccess(ctx),
        logger: ctx.logger,
      });
      bots = result.bots;
    }

    return c.json({
      ok: true,
      enabled: body.data.enabled ?? found.install.enabled,
      enabledBots: body.data.enabledBots ?? found.install.enabledBots,
      bots,
    });
  })

  // ---------- uninstall ----------
  .delete("/:pluginId", async (c) => {
    const ctx = c.get("ctx");
    const userId = c.get("userId");
    const pluginId = c.req.param("pluginId");

    const rows = await listInstallsForOwner(ctx.db, userId);
    const found = rows.find(({ plugin }) => plugin.id === pluginId);
    if (!found) return fail(c, "not_found");
    if (found.plugin.key === CORE_PLUGIN_KEY) return fail(c, "locked");

    const result = await uninstallPlugin({
      db: ctx.db,
      ownerId: userId,
      pluginId,
      box: boxAccess(ctx),
      logger: ctx.logger,
    });
    return c.json({ ok: true, ...result });
  })

  // ---------- my installed plugins ----------
  .get("/", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const rows = await listInstallsForOwner(db, userId);

    const items = rows
      .map(({ install, plugin }) => ({
        installId: install.id,
        pluginId: plugin.id,
        key: plugin.key,
        version: plugin.version,
        source: plugin.source,
        displayName: plugin.displayName,
        description: plugin.description,
        enabled: install.enabled,
        /** null = every bot this user owns, now and later */
        enabledBots: install.enabledBots,
        /** core can't be switched off — the UI renders its toggle as locked rather than guessing */
        locked: plugin.key === CORE_PLUGIN_KEY,
        requiredSecrets: plugin.manifest.requiredSecrets,
        summary: summarize(plugin.manifest),
      }))
      // builtin first (the platform's own), then installed, then the per-bot local bundles.
      .sort(
        (a, b) =>
          sourceRank(a.source) - sourceRank(b.source) || a.displayName.localeCompare(b.displayName),
      );

    return c.json({ plugins: items });
  })

  // ---------- one plugin in full ----------
  .get("/:pluginId", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const pluginId = c.req.param("pluginId");
    // Resolve through the caller's own installs: not-installed and not-existing are the same 404, so
    // the endpoint never confirms the existence of a plugin this user has nothing to do with.
    const rows = await listInstallsForOwner(db, userId);
    const found = rows.find(({ plugin }) => plugin.id === pluginId);
    if (!found) return fail(c, "not_found");

    const { plugin, install } = found;
    return c.json({
      plugin: {
        pluginId: plugin.id,
        key: plugin.key,
        version: plugin.version,
        source: plugin.source,
        displayName: plugin.displayName,
        description: plugin.description,
        contentHash: plugin.contentHash,
        manifest: plugin.manifest,
        summary: summarize(plugin.manifest),
      },
      install: {
        installId: install.id,
        enabled: install.enabled,
        enabledBots: install.enabledBots,
        config: install.config,
        locked: plugin.key === CORE_PLUGIN_KEY,
      },
    });
  });

function sourceRank(source: string): number {
  return source === "builtin" ? 0 : source === "installed" ? 1 : 2;
}

/**
 * `GET /bots/:botId/plugins` — the bot's EFFECTIVE capability set, the same resolution the run loop
 * performs. The composer's plugin menu reads this, so what the user is offered and what the model can
 * actually call come from one function rather than two lists that drift.
 *
 * Exported as a handler (not a router) so it mounts on the existing `/bots` router, keeping bot
 * ownership checks where all the other bot-scoped routes do theirs.
 */
export async function botPluginsHandler(c: Context<AppBindings>) {
  const botId = c.req.param("botId") ?? "";
  const owned = botId ? await assertOwnerOfBot(c, botId) : false;
  if (!owned) return c.json({ error: "not_found", message: FAIL.not_found.message }, 404);

  const { db } = c.get("ctx");
  const resolved = await resolvePluginsForBot(db, botId);
  return c.json({
    plugins: resolved.plugins.map((p) => ({
      pluginId: p.pluginId,
      key: p.key,
      version: p.version,
      source: p.source,
      displayName: p.displayName,
      description: p.description,
      summary: summarize(p.manifest),
      // What the model can actually call this turn, already namespaced — the menu inserts these
      // verbatim rather than re-deriving a naming scheme on the client. A card is called as
      // `render_card({template: templateId})`, so what the client needs is the template id.
      cards: p.manifest.ui.map((u) => ({
        name: u.name,
        description: u.description,
        tool: RENDER_CARD_TOOL,
        templateId: templateId(p.key, u.name),
        input: u.input,
      })),
      agents: p.manifest.agents.map((a) => ({
        name: a.name,
        description: a.description,
        tool: agentToolName(p.key, a.name),
      })),
      skills: p.manifest.skills
        .filter((s) => !s.hidden)
        .map((s) => ({ name: s.name, description: s.description })),
    })),
    toolNames: [...resolved.toolNames],
  });
}
