/**
 * Install / enable / uninstall — the seam between the two planes.
 *
 * A plugin install is two different things happening in two places, and the honest model is to keep
 * them separate rather than pretend they're one transaction:
 *
 *  - **Control plane** (here, synchronous, pure data): validate the manifest, upsert the `plugins`
 *    row, create the install, and materialize per-bot rows. This is what "installed" means, and it
 *    always succeeds or always fails as a unit.
 *  - **Execution plane** (the bot's sandbox): render `${PLUGIN_ROOT}`, run setup steps, start bridged
 *    MCP servers. This can only happen for a bot whose box is UP, and it can partially fail for
 *    reasons that have nothing to do with the plugin (a cold box, a slow `npx` download).
 *
 * So an install result is per-bot and three-valued — `ready`, `pending` (no live box; the next
 * bootstrap does it) or `failed` (with a reason) — instead of one flat ✓. A plugin that is ready on
 * one bot and pending on another is a normal, honest state, not an error.
 */
import type { Database } from "@i-bot/db";
import { bots as botsTable, pluginInstalls } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import type { PluginManifest, PluginSource } from "@i-bot/types";
import { and, eq } from "drizzle-orm";
import {
  type BootstrapTarget,
  bootstrapBot,
  gatherBotDefs,
  type StartedBoxMcp,
  stopBoxMcp,
} from "../sandbox/bootstrap.js";
import { hashManifest, normalizeManifest } from "./manifest.js";
import { dematerializePluginForBot, materializePluginForBot } from "./materialize.js";
import {
  ensureInstall,
  type InstallRow,
  listInstallsForOwner,
  type PluginRow,
  upsertPlugin,
} from "./repository.js";

/** How a bot's box ended up after an install touched it. */
export type BoxState = "ready" | "pending" | "failed";

export interface BotInstallStatus {
  botId: string;
  state: BoxState;
  /** why it failed, or why it's pending */
  reason?: string;
  /** box-local MCP servers that came up for this bot (bridged stdio included) */
  boxMcp?: StartedBoxMcp[];
}

export interface InstallResult {
  plugin: PluginRow;
  install: InstallRow;
  /** secrets the plugin references that this owner hasn't stored yet */
  missingSecrets: string[];
  bots: BotInstallStatus[];
}

/**
 * How `installPlugin` reaches a bot's live box. Deliberately an interface rather than the
 * `SandboxManager` itself: install must work with no box at all (returning `pending`), and a narrow
 * seam keeps this module testable without a sandbox provider.
 */
export interface BoxAccess {
  /** a live handle, or null when the bot's box isn't up. MUST NOT provision one. */
  handleFor(botId: string): Promise<BootstrapTarget | null>;
  /** tell the manager which box-local MCP endpoints are live, so the next run can dial them */
  registerBoxMcp?(botId: string, endpoints: StartedBoxMcp[]): void;
}

export interface InstallOptions {
  db: Database;
  ownerId: string;
  ownerType?: "user" | "org";
  manifest: PluginManifest;
  source?: PluginSource;
  /** null = every bot this owner has, now and later */
  enabledBots?: string[] | null;
  config?: Record<string, unknown>;
  box?: BoxAccess;
  logger?: Logger;
}

/** The bots an install applies to: the listed ones, or all of the owner's. */
async function targetBots(
  db: Database,
  ownerId: string,
  enabledBots: string[] | null | undefined,
): Promise<string[]> {
  const rows = await db.query.bots.findMany({
    where: eq(botsTable.ownerId, ownerId),
    columns: { id: true },
  });
  const owned = new Set(rows.map((r) => r.id));
  // Filter the requested list against ownership rather than trusting it: a bot id in a request body
  // is caller-supplied, and materializing into someone else's bot is exactly the leak to avoid.
  if (enabledBots) return enabledBots.filter((id) => owned.has(id));
  return [...owned];
}

/** Secret names a manifest needs that the owner hasn't stored. */
async function findMissingSecrets(
  db: Database,
  botIds: string[],
  manifest: PluginManifest,
): Promise<string[]> {
  const needed = new Set(manifest.requiredSecrets);
  for (const server of manifest.mcpServers) {
    for (const value of [
      ...Object.values(server.env ?? {}),
      ...Object.values(server.headers ?? {}),
    ]) {
      for (const m of value.matchAll(/\{\{\s*secrets\.([A-Za-z0-9_]{1,120})\s*\}\}/g)) {
        needed.add(m[1]!);
      }
    }
  }
  if (needed.size === 0 || botIds.length === 0) return [...needed];

  // Resolution is tenant-scoped per bot; a secret present for ANY target bot counts as present (the
  // vault resolves bot → owner, so an owner-level secret answers for all of them).
  const { resolveSecretValues } = await import("../secrets/vault.js");
  const found = await resolveSecretValues(db, botIds[0]!, [...needed]).catch(() => ({}));
  return [...needed].filter((name) => !(name in found));
}

/**
 * Install a plugin for an owner and materialize it into their bots.
 *
 * Idempotent: re-installing the same version updates the plugin row and re-materializes rows (the
 * materializer deletes this plugin's previous rows first), so a repeated install converges rather
 * than duplicating. An existing install's `enabled`/`enabledBots` choice is preserved — a user who
 * switched something off does not get it switched back on by a reinstall.
 */
export async function installPlugin(opts: InstallOptions): Promise<InstallResult> {
  const { db, ownerId, logger } = opts;
  const source = opts.source ?? "installed";

  // Re-normalize even for an already-normalized manifest: this is the boundary, and the guards
  // (plaintext credentials, network tampering, file limits) must run on whatever arrives here.
  const manifest = normalizeManifest(opts.manifest, {
    source: source === "local" ? "local" : source,
  });

  const plugin = await upsertPlugin(db, { manifest, source });
  const { install } = await ensureInstall(db, {
    pluginId: plugin.id,
    ownerId,
    ownerType: opts.ownerType ?? "user",
    enabledBots: opts.enabledBots ?? null,
    ...(opts.config ? { config: opts.config } : {}),
  });

  // An existing install may point at an older version row; repoint it so the new content is what's live.
  if (install.pluginId !== plugin.id) {
    await db
      .update(pluginInstalls)
      .set({ pluginId: plugin.id })
      .where(eq(pluginInstalls.id, install.id));
    install.pluginId = plugin.id;
  }

  const botIds = await targetBots(db, ownerId, install.enabledBots);
  const missingSecrets = await findMissingSecrets(db, botIds, manifest);

  const statuses: BotInstallStatus[] = [];
  for (const botId of botIds) {
    // Sequential: each iteration writes rows for one bot and then talks to that bot's box. Running
    // them in parallel would interleave port allocation reads (`nextBridgePort` counts existing rows).
    // eslint-disable-next-line no-await-in-loop
    await materializePluginForBot(db, { botId, pluginId: plugin.id, manifest });
    // eslint-disable-next-line no-await-in-loop
    statuses.push(await reconcileBox(db, botId, opts.box, logger));
  }

  logger?.info(
    { plugin: plugin.key, version: plugin.version, bots: botIds.length, missingSecrets },
    "plugin installed",
  );
  return { plugin, install, missingSecrets, bots: statuses };
}

/**
 * Bring one bot's box in line with its rows, if it has a live box.
 *
 * This re-runs the WHOLE bootstrap rather than just the new plugin's part. It costs one marker `cat`
 * per already-materialized plugin (and setup steps that are idempotent by construction), and in
 * exchange there is exactly one code path that renders a box — so an incremental install can't drift
 * from what a fresh box gets.
 */
async function reconcileBox(
  db: Database,
  botId: string,
  box: BoxAccess | undefined,
  logger: Logger | undefined,
): Promise<BotInstallStatus> {
  if (!box) return { botId, state: "pending", reason: "no sandbox access in this context" };

  let target: BootstrapTarget | null = null;
  try {
    target = await box.handleFor(botId);
  } catch (err) {
    return { botId, state: "pending", reason: (err as Error).message };
  }
  if (!target) {
    return { botId, state: "pending", reason: "sandbox is not running — will apply on next start" };
  }

  try {
    const defs = await gatherBotDefs(db, botId);
    const result = await bootstrapBot(target, db, botId, defs, ...(logger ? [{ logger }] : []));
    box.registerBoxMcp?.(botId, result.boxMcp);
    if (result.pluginsFailed > 0) {
      return { botId, state: "failed", reason: "plugin files failed to render", boxMcp: result.boxMcp };
    }
    if (result.setupStepsFailed > 0) {
      return {
        botId,
        state: "failed",
        reason: `${result.setupStepsFailed} setup step(s) failed — see bot_setup_steps.last_error`,
        boxMcp: result.boxMcp,
      };
    }
    return { botId, state: "ready", boxMcp: result.boxMcp };
  } catch (err) {
    return { botId, state: "failed", reason: (err as Error).message };
  }
}

export interface UninstallOptions {
  db: Database;
  ownerId: string;
  ownerType?: "user" | "org";
  pluginId: string;
  box?: BoxAccess;
  logger?: Logger;
}

/**
 * Remove an install: drop the per-bot rows, then stop the processes and delete the directory in each
 * live box. Rows first — if the box step fails, the next bootstrap won't restart anything (no rows to
 * read from), whereas the reverse order could leave rows whose processes we already killed.
 *
 * The `plugins` row itself stays: another owner may have it installed, and keeping it makes
 * reinstalling free. GC of unreferenced plugin rows is a separate concern.
 */
export async function uninstallPlugin(
  opts: UninstallOptions,
): Promise<{ bots: { botId: string; stopped: number[] }[] }> {
  const { db, ownerId, pluginId, box, logger } = opts;

  const install = await db.query.pluginInstalls.findFirst({
    where: and(
      eq(pluginInstalls.pluginId, pluginId),
      eq(pluginInstalls.ownerType, opts.ownerType ?? "user"),
      eq(pluginInstalls.ownerId, ownerId),
    ),
  });
  if (!install) throw new Error("plugin is not installed for this owner");

  const plugin = await db.query.plugins.findFirst({
    where: (t, { eq: is }) => is(t.id, pluginId),
    columns: { key: true },
  });

  const botIds = await targetBots(db, ownerId, install.enabledBots as string[] | null);
  const out: { botId: string; stopped: number[] }[] = [];

  for (const botId of botIds) {
    // eslint-disable-next-line no-await-in-loop
    const { ports } = await dematerializePluginForBot(db, { botId, pluginId });
    out.push({ botId, stopped: ports });
    if (!box) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const target = await box.handleFor(botId);
      if (!target) continue; // cold box: nothing is running, and the dir goes with the box
      // eslint-disable-next-line no-await-in-loop
      await stopBoxMcp(
        target,
        { ports, ...(plugin?.key ? { pluginKey: plugin.key } : {}) },
        ...(logger ? [{ logger }] : []),
      );
    } catch (err) {
      logger?.warn(
        { botId, pluginId, err: (err as Error).message },
        "uninstall: box cleanup failed (rows are gone; box will settle on rebuild)",
      );
    }
  }

  await db.delete(pluginInstalls).where(eq(pluginInstalls.id, install.id));
  logger?.info({ pluginId, bots: botIds.length }, "plugin uninstalled");
  return { bots: out };
}

/**
 * Change which of an owner's bots a plugin is enabled for. Newly-enabled bots get materialized;
 * newly-disabled ones get their rows and box state removed.
 *
 * `enabledBots: null` means "all of this owner's bots, now and later" — including ones created
 * afterwards, which is why it's stored as null rather than expanded into a list.
 */
export async function setPluginBots(opts: {
  db: Database;
  ownerId: string;
  ownerType?: "user" | "org";
  pluginId: string;
  enabledBots: string[] | null;
  box?: BoxAccess;
  logger?: Logger;
}): Promise<{ bots: BotInstallStatus[] }> {
  const { db, ownerId, pluginId, enabledBots, box, logger } = opts;
  const ownerType = opts.ownerType ?? "user";

  const installs = await listInstallsForOwner(db, ownerId, ownerType);
  const found = installs.find((i) => i.plugin.id === pluginId);
  if (!found) throw new Error("plugin is not installed for this owner");

  const before = new Set(await targetBots(db, ownerId, found.install.enabledBots));
  const after = new Set(await targetBots(db, ownerId, enabledBots));

  await db
    .update(pluginInstalls)
    .set({ enabledBots })
    .where(eq(pluginInstalls.id, found.install.id));

  const statuses: BotInstallStatus[] = [];
  for (const botId of after) {
    if (before.has(botId)) continue; // already materialized
    // eslint-disable-next-line no-await-in-loop
    await materializePluginForBot(db, { botId, pluginId, manifest: found.plugin.manifest });
    // eslint-disable-next-line no-await-in-loop
    statuses.push(await reconcileBox(db, botId, box, logger));
  }
  for (const botId of before) {
    if (after.has(botId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const { ports } = await dematerializePluginForBot(db, { botId, pluginId });
    if (!box) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const target = await box.handleFor(botId);
      // eslint-disable-next-line no-await-in-loop
      if (target) await stopBoxMcp(target, { ports, pluginKey: found.plugin.key }, ...(logger ? [{ logger }] : []));
    } catch (err) {
      logger?.warn({ botId, pluginId, err: (err as Error).message }, "disable: box cleanup failed");
    }
  }

  return { bots: statuses };
}

/** Re-export so callers don't need the repository for the common "what changed?" check. */
export { hashManifest };
