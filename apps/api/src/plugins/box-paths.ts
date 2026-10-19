/**
 * Where a plugin lands INSIDE the bot's box, and the placeholder rewrite that makes an imported
 * bundle's own paths point at it.
 *
 * ## The layout
 *
 * ```
 * /root/.ibot/                        IBOT_ROOT — the rebuildable cache (DB is the ledger)
 *   skills/<skillId>/…                skill glue-files (P0, unchanged)
 *   mcp/<serverId>.log                a box-local MCP server's stdout (unchanged)
 *   plugins/<sanitized key>/          PLUGIN_ROOT — a plugin's carried files, re-rendered from the DB
 *     .ibot-plugin.json               the marker: {key, version, contentHash, materializedAt}
 *     data/                           PLUGIN_DATA — the plugin's own writable state
 * ```
 *
 * Two properties this split buys:
 *
 *  - **`PLUGIN_ROOT` is disposable.** Everything under it except `data/` comes from
 *    `plugins.manifest.files`, so a box rebuild re-renders it byte-for-byte. Nothing a user cares
 *    about is stored only there — the same rule as skills.
 *  - **`PLUGIN_DATA` is not.** A bridged MCP server with a local cache or sqlite file writes there.
 *    It is created but never cleared by materialization, so re-rendering a plugin (an upgrade, a
 *    fresh box, a recovery) doesn't throw away its state. It is still box-local and therefore
 *    ultimately expendable: anything that must survive a rebuild belongs in Postgres.
 *
 * ## The rewrite
 *
 * A Claude Code plugin refers to its own directory as `${CLAUDE_PLUGIN_ROOT}` (and a project dir as
 * `${CLAUDE_PROJECT_DIR}`). Those are the ONLY thing standing between a community bundle's commands
 * and ours, so `rewritePlaceholders` maps them onto the paths above. It is a plain string
 * substitution over declared command text — the platform does not run any of it; the box does.
 */
import { sanitizePluginKey } from "@i-bot/types";
import { IBOT_ROOT } from "../sandbox/bootstrap.js";

/** Marker file that makes re-materializing a plugin a no-op when nothing changed. */
export const PLUGIN_MARKER = ".ibot-plugin.json";

/** A plugin's root inside the box: its carried files, re-rendered from the DB on every bootstrap. */
export function pluginDir(pluginKey: string): string {
  return `${IBOT_ROOT}/plugins/${sanitizePluginKey(pluginKey)}`;
}

/** A plugin's writable state dir. Created by materialization, never cleared by it. */
export function pluginDataDir(pluginKey: string): string {
  return `${pluginDir(pluginKey)}/data`;
}

/** What the box writes to remember a materialized plugin. */
export interface PluginMarker {
  key: string;
  version: string;
  /** `plugins.content_hash` — the whole reason the marker exists: it decides "already done?" */
  contentHash: string;
  materializedAt: string;
}

/**
 * Substitute a plugin's own path placeholders in a declared command/arg. Supports both `${X}` and
 * `$X` forms, since community bundles use each.
 *
 * `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` → the plugin's dir, `CLAUDE_PLUGIN_DATA`/`PLUGIN_DATA` → its
 * data dir, and `CLAUDE_PROJECT_DIR` → the plugin dir as well: in Claude Code that is the user's
 * checkout, and a box has no single equivalent, so pointing it at the plugin's own root is the
 * reading that keeps a command inside the sandbox instead of writing somewhere arbitrary.
 */
export function rewritePlaceholders(text: string, pluginKey: string): string {
  const root = pluginDir(pluginKey);
  const data = pluginDataDir(pluginKey);
  const map: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: root,
    PLUGIN_ROOT: root,
    CLAUDE_PLUGIN_DATA: data,
    PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: root,
  };
  let out = text;
  for (const [name, value] of Object.entries(map)) {
    // `${NAME}` first, then a bare `$NAME` not followed by another name character.
    out = out.replaceAll(`\${${name}}`, value);
    out = out.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"), value);
  }
  return out;
}

/** True when a string still references a placeholder we don't map (so the importer can report it). */
export function unknownPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\$\{?(CLAUDE_[A-Z0-9_]+)\}?/g)) {
    const name = m[1]!;
    if (name !== "CLAUDE_PLUGIN_ROOT" && name !== "CLAUDE_PLUGIN_DATA" && name !== "CLAUDE_PROJECT_DIR") {
      found.add(name);
    }
  }
  return [...found];
}
