/**
 * Plugin persistence: the `plugins` / `plugin_installs` rows, plus the two "make sure this exists"
 * helpers the rest of the system leans on (`ensureLocalPlugin`, `upsertPlugin`).
 *
 * Everything here is idempotent by design. Sync-on-boot, a repeated install, the backfill script and
 * a bot created twice in a race all call the same functions, so each one either finds the existing
 * row or creates it — never duplicates. `unique(key, version)` and
 * `unique(plugin_id, owner_type, owner_id)` are what make that reliable under concurrency, rather
 * than a read-then-write check.
 *
 * Tenant isolation: an install belongs to an owner, and every read here filters on that owner. A
 * plugin row itself is shared content (the same `@ibot/ui` row serves everyone) and carries no
 * tenant data, which is why it has no owner column.
 */
import type { Database } from "@i-bot/db";
import { bots, pluginInstalls, plugins as pluginsTable } from "@i-bot/db";
import {
  LOCAL_PLUGIN_VERSION,
  localPluginKey,
  type PluginManifest,
  type PluginSource,
} from "@i-bot/types";
import { and, eq, inArray } from "drizzle-orm";
import { hashManifest } from "./manifest.js";

/** A stored plugin row as the repository returns it (manifest already typed). */
export interface PluginRow {
  id: string;
  key: string;
  version: string;
  source: PluginSource;
  displayName: string;
  description: string;
  manifest: PluginManifest;
  contentHash: string;
}

/** A stored install row. `enabledBots: null` = every bot this owner has, now and later. */
export interface InstallRow {
  id: string;
  pluginId: string;
  ownerType: "user" | "org";
  ownerId: string;
  enabled: boolean;
  enabledBots: string[] | null;
  config: Record<string, unknown>;
}

const PLUGIN_COLUMNS = {
  id: true,
  key: true,
  version: true,
  source: true,
  displayName: true,
  description: true,
  manifest: true,
  contentHash: true,
} as const;

/**
 * Insert a plugin, or update it in place when `(key, version)` already exists. An `installed`
 * upgrade arrives as a NEW version (so the old row survives for rollback); re-publishing the SAME
 * version — what a builtin sync does on every boot, and what editing a `local` plugin does — updates
 * the existing row's manifest. `contentHash` is recomputed here, never trusted from the caller.
 */
export async function upsertPlugin(
  db: Database,
  input: { manifest: PluginManifest; source: PluginSource },
): Promise<PluginRow> {
  const { manifest, source } = input;
  const contentHash = hashManifest(manifest);
  const values = {
    key: manifest.key,
    version: manifest.version,
    source,
    displayName: manifest.displayName,
    description: manifest.description,
    author: manifest.author ?? null,
    homepage: manifest.homepage ?? null,
    manifest,
    contentHash,
    requires: manifest.requires,
    requiredSecrets: manifest.requiredSecrets,
  };
  const [row] = await db
    .insert(pluginsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [pluginsTable.key, pluginsTable.version],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row as PluginRow;
}

/** Look up one plugin by its stable key and version. */
export async function findPlugin(
  db: Database,
  key: string,
  version: string,
): Promise<PluginRow | null> {
  const row = await db.query.plugins.findFirst({
    where: and(eq(pluginsTable.key, key), eq(pluginsTable.version, version)),
    columns: PLUGIN_COLUMNS,
  });
  return (row as PluginRow | undefined) ?? null;
}

/**
 * Ensure an owner has an installation of a plugin. Idempotent: an existing install is returned
 * untouched (so a boot-time sync never re-enables something the user deliberately switched off, and
 * never overwrites their `enabledBots` choice). Only `pluginId` is repointed, which is how an upgrade
 * moves an install to a new version row.
 */
export async function ensureInstall(
  db: Database,
  input: {
    pluginId: string;
    ownerType?: "user" | "org";
    ownerId: string;
    enabled?: boolean;
    enabledBots?: string[] | null;
    config?: Record<string, unknown>;
  },
): Promise<{ install: InstallRow; created: boolean }> {
  const ownerType = input.ownerType ?? "user";
  const existing = await db.query.pluginInstalls.findFirst({
    where: and(
      eq(pluginInstalls.pluginId, input.pluginId),
      eq(pluginInstalls.ownerType, ownerType),
      eq(pluginInstalls.ownerId, input.ownerId),
    ),
  });
  if (existing) return { install: existing as InstallRow, created: false };

  const [row] = await db
    .insert(pluginInstalls)
    .values({
      pluginId: input.pluginId,
      ownerType,
      ownerId: input.ownerId,
      enabled: input.enabled ?? true,
      enabledBots: input.enabledBots ?? null,
      config: input.config ?? {},
    })
    // A concurrent caller may have won the race between the read above and this insert; the unique
    // index turns that into a no-op update rather than a thrown duplicate. `created` is then a
    // harmless overcount — the row exists either way, which is all a caller acts on.
    .onConflictDoUpdate({
      target: [pluginInstalls.pluginId, pluginInstalls.ownerType, pluginInstalls.ownerId],
      set: { pluginId: input.pluginId },
    })
    .returning();
  return { install: row as InstallRow, created: true };
}

/** Repoint an install at a different version row of the same plugin (the upgrade/rollback step). */
export async function repointInstall(
  db: Database,
  installId: string,
  pluginId: string,
): Promise<void> {
  await db.update(pluginInstalls).set({ pluginId }).where(eq(pluginInstalls.id, installId));
}

/**
 * Every bot has exactly one `local` plugin: the only editable bundle, where that bot's recorded
 * skills, `save_skill` calls and hand-written entries live. Created with the bot (and by the backfill
 * for bots that predate plugins), enabled for that one bot only.
 *
 * It is NOT versioned — a local plugin is edited in place at `0.0.0-local`, so `upsertPlugin` updates
 * the same row every time rather than accumulating versions.
 */
export async function ensureLocalPlugin(
  db: Database,
  input: { botId: string; ownerId: string; botName?: string },
): Promise<{ plugin: PluginRow; install: InstallRow }> {
  const key = localPluginKey(input.botId);
  const existing = await findPlugin(db, key, LOCAL_PLUGIN_VERSION);
  const plugin =
    existing ??
    (await upsertPlugin(db, {
      source: "local",
      manifest: {
        key,
        version: LOCAL_PLUGIN_VERSION,
        displayName: input.botName ? `${input.botName} · 本地能力` : "本地能力",
        description:
          "这个 bot 自己录制或保存下来的能力。唯一可以直接编辑的插件——skills、MCP 都写在这里。",
        defaultEnabled: true,
        skills: [],
        mcpServers: [],
        agents: [],
        ui: [],
        providedTools: [],
        setupSteps: [],
        hooks: [],
        files: [],
        requires: [],
        requiredSecrets: [],
        userConfig: {},
        ignored: [],
      },
    }));

  const { install } = await ensureInstall(db, {
    pluginId: plugin.id,
    ownerId: input.ownerId,
    enabledBots: [input.botId],
  });
  return { plugin, install };
}

/**
 * The local plugin id for a bot, or null when it has none yet. Used by the write paths
 * (`save_skill`, `bind_mcp`, skill publish) to stamp `plugin_id` on the row they create. They must
 * not FAIL when it's missing — a skill saved without a plugin id is still a working skill — so this
 * returns null rather than creating one on a hot path.
 */
export async function localPluginIdFor(db: Database, botId: string): Promise<string | null> {
  const row = await db.query.plugins.findFirst({
    where: and(
      eq(pluginsTable.key, localPluginKey(botId)),
      eq(pluginsTable.version, LOCAL_PLUGIN_VERSION),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

/** Every install belonging to an owner, with its plugin row joined. Enabled and disabled alike. */
export async function listInstallsForOwner(
  db: Database,
  ownerId: string,
  ownerType: "user" | "org" = "user",
): Promise<{ install: InstallRow; plugin: PluginRow }[]> {
  const installs = await db.query.pluginInstalls.findMany({
    where: and(eq(pluginInstalls.ownerType, ownerType), eq(pluginInstalls.ownerId, ownerId)),
  });
  if (installs.length === 0) return [];

  const pluginRows = await db.query.plugins.findMany({
    where: inArray(
      pluginsTable.id,
      installs.map((i) => i.pluginId),
    ),
    columns: PLUGIN_COLUMNS,
  });
  const byId = new Map(pluginRows.map((p) => [p.id, p as PluginRow]));
  return installs.flatMap((install) => {
    const plugin = byId.get(install.pluginId);
    // A dangling install can't happen (FK + cascade), but a narrowed read is cheaper than an assert.
    return plugin ? [{ install: install as InstallRow, plugin }] : [];
  });
}

/** The owner of a bot, or null when the bot is gone. */
export async function botOwnerId(db: Database, botId: string): Promise<string | null> {
  const row = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    columns: { ownerId: true },
  });
  return row?.ownerId ?? null;
}
