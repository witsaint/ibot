/**
 * What a bot can actually do right now: `core ∪ enabled builtin ∪ enabled installed (for this bot) ∪
 * its own local`. This is the one function the run loop, the per-bot API snapshot and the composer
 * menu all read, so "what capability does this bot have" has a single answer everywhere.
 *
 * Precedence is `local > installed > builtin` — the closer a capability is to the user, the more
 * authoritative. It matters for NAME collisions only: two plugins declaring a skill called "Deploy"
 * resolve to one, the user's own. Tool names never collide (they're namespaced by plugin key), so
 * precedence doesn't apply to them.
 *
 * `@ibot/core` is special in exactly one way: its install can't be switched off (the nine primitives
 * are the agent, not an add-on). That's enforced here rather than trusting `enabled` to stay true.
 */
import type { Database } from "@i-bot/db";
import type { PluginManifest, PluginSource } from "@i-bot/types";
import { agentToolName } from "./manifest.js";
import { RENDER_CARD_TOOL, templateId } from "./ui-templates.js";
import { botOwnerId, listInstallsForOwner } from "./repository.js";

/** The plugin key whose install is mandatory — it declares the platform's own primitives. */
export const CORE_PLUGIN_KEY = "@ibot/core";

/** One plugin that is live for a bot, in precedence order. */
export interface ResolvedPlugin {
  pluginId: string;
  installId: string;
  key: string;
  version: string;
  source: PluginSource;
  displayName: string;
  description: string;
  manifest: PluginManifest;
  /** the owner's answers to `manifest.userConfig` */
  config: Record<string, unknown>;
}

/** The bot's effective capability set. */
export interface ResolvedPlugins {
  /** live plugins, ordered `builtin` → `installed` → `local` (lowest precedence first) */
  plugins: ResolvedPlugin[];
  byKey: Map<string, ResolvedPlugin>;
  /** every tool name the plugin layer contributes this turn (`ui__…`, `agent__…`) */
  toolNames: Set<string>;
  /** platform tool names declared by builtins — the vocabulary an agent allowlist is checked against */
  providedToolNames: Set<string>;
}

/** Sort weight: a later source wins a name collision. */
const SOURCE_RANK: Record<PluginSource, number> = { builtin: 0, installed: 1, local: 2 };

/**
 * Resolve the plugins live for one bot. Never throws on missing data — a bot with no owner (deleted
 * mid-flight) or no installs resolves to an empty set, which degrades the run to the nine primitives
 * rather than failing it.
 */
export async function resolvePluginsForBot(db: Database, botId: string): Promise<ResolvedPlugins> {
  const ownerId = await botOwnerId(db, botId);
  if (!ownerId) return emptyResolution();

  const rows = await listInstallsForOwner(db, ownerId);
  const live = rows.filter(({ install, plugin }) => {
    // core is always on, regardless of what the enabled flag says.
    if (plugin.key === CORE_PLUGIN_KEY) return true;
    if (!install.enabled) return false;
    // null = all of the owner's bots (including ones created after the install).
    return install.enabledBots === null || install.enabledBots.includes(botId);
  });

  const plugins: ResolvedPlugin[] = live
    .map(({ install, plugin }) => ({
      pluginId: plugin.id,
      installId: install.id,
      key: plugin.key,
      version: plugin.version,
      source: plugin.source,
      displayName: plugin.displayName,
      description: plugin.description,
      manifest: plugin.manifest,
      config: install.config,
    }))
    // Stable order: by source rank, then key. Callers rely on "last wins" for name collisions, so
    // the ordering has to be deterministic rather than whatever the query returned.
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.key.localeCompare(b.key));

  const toolNames = new Set<string>();
  const providedToolNames = new Set<string>();
  for (const p of plugins) {
    // Every card template is reached through the ONE `render_card` tool, so templates add a single
    // name however many of them there are — the model's tool list doesn't grow with installs.
    if (p.manifest.ui.length > 0) toolNames.add(RENDER_CARD_TOOL);
    for (const agent of p.manifest.agents) toolNames.add(agentToolName(p.key, agent.name));
    // Only a builtin may declare platform-provided tools (the importer strips it elsewhere); guard
    // here too so a hand-written row can't widen an agent's allowlist by assertion.
    if (p.source === "builtin") {
      for (const t of p.manifest.providedTools) providedToolNames.add(t.name);
    }
  }

  return { plugins, byKey: new Map(plugins.map((p) => [p.key, p])), toolNames, providedToolNames };
}

function emptyResolution(): ResolvedPlugins {
  return {
    plugins: [],
    byKey: new Map(),
    toolNames: new Set(),
    providedToolNames: new Set(),
  };
}

/**
 * The skills a bot's model should SEE, after plugin visibility is applied.
 *
 * Two filters, both keyed on the skill's `pluginId`:
 *  - `hidden` declarations are dropped. A hidden skill still exists as a row (a hook or an agent can
 *    reference it by name) but must not enter the model's skill list.
 *  - a row whose plugin is no longer live is dropped. Rows are removed when a plugin is disabled, but
 *    a row can outlive that removal (an offline sandbox, a failed dematerialize), and a disabled
 *    plugin must stop contributing to the prompt immediately either way.
 *
 * Rows with no `pluginId` (written before plugins existed, or added ad hoc) always pass — they belong
 * to no plugin, so no plugin can hide them.
 *
 * A command skill is included only for a matching explicit user invocation.
 * Pure so it can be unit-tested without a DB.
 */
/** Available commands have one deterministic winner, following plugin precedence. */
export function commandSkill(resolved: ResolvedPlugins, command: string) {
  for (const plugin of [...resolved.plugins].reverse()) {
    const skill = plugin.manifest.skills.find((s) => !s.hidden && s.command === command);
    if (skill) return { pluginId: plugin.pluginId, skill };
  }
  return undefined;
}

/** Menu entries include manual skills; their playbooks remain excluded from normal runs. */
export function callableSkills<T extends { name: string; pluginId?: string | null }>(
  rows: T[],
  resolved: ResolvedPlugins,
): (T & { command?: string })[] {
  const byId = new Map(resolved.plugins.map((p) => [p.pluginId, p]));
  return rows.flatMap((row) => {
    if (!row.pluginId) return [row];
    const plugin = byId.get(row.pluginId);
    if (!plugin) return [];
    const decl = plugin.manifest.skills.find(
      (s) => s.name.trim().toLowerCase() === row.name.trim().toLowerCase(),
    );
    if (decl?.hidden) return [];
    if (decl?.command) {
      if (commandSkill(resolved, decl.command)?.pluginId !== row.pluginId) return [];
      return [{ ...row, command: decl.command }];
    }
    return [row];
  });
}

export function visibleSkills<T extends { name: string; pluginId?: string | null }>(
  rows: T[],
  resolved: ResolvedPlugins,
  command?: string,
): T[] {
  return callableSkills(rows, resolved).filter((row) => !row.command || row.command === command);
}

/**
 * Deduplicate same-named skills by precedence. `rows` must already be filtered by `visibleSkills`;
 * `resolved.plugins` is in ascending precedence order, so the LAST row wins for a given name. A row
 * with no plugin (the user's own ad-hoc skill) outranks everything — nothing is closer to the user.
 *
 * Pure. Order of the returned rows follows the input.
 */
export function dedupeSkillsByPrecedence<T extends { name: string; pluginId?: string | null }>(
  rows: T[],
  resolved: ResolvedPlugins,
): T[] {
  const rank = new Map(resolved.plugins.map((p, i) => [p.pluginId, i]));
  // No plugin = the user's own row: rank above every plugin.
  const rankOf = (row: T) =>
    row.pluginId ? (rank.get(row.pluginId) ?? -1) : Number.MAX_SAFE_INTEGER;

  const winners = new Map<string, T>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    const current = winners.get(key);
    if (!current || rankOf(row) >= rankOf(current)) winners.set(key, row);
  }
  const kept = new Set(winners.values());
  return rows.filter((row) => kept.has(row));
}

/**
 * A short "## Installed plugins" section for the system prompt: what the bot has, and which tools
 * came from where — so the model knows a capability exists and can tell the user which plugin it's
 * using. Returns "" when no live plugin contributes anything nameable, which keeps the prompt free of
 * a section that would just say "core" (its primitives are already described at length).
 */
export function composePluginNotes(resolved: ResolvedPlugins, command?: string): string {
  const lines: string[] = [];
  for (const p of resolved.plugins) {
    const contributions: string[] = [];
    const visible = p.manifest.skills.filter(
      (s) =>
        !s.hidden &&
        (!s.command ||
          (s.command === command && commandSkill(resolved, s.command)?.pluginId === p.pluginId)),
    );
    if (visible.length) contributions.push(`skills: ${visible.map((s) => s.name).join(", ")}`);
    // Template ids, not tool names — they're all called through `render_card`, whose own description
    // lists them with their inputs.
    const cards = p.manifest.ui.map((u) => templateId(p.key, u.name));
    if (cards.length) contributions.push(`cards: ${cards.join(", ")}`);
    const agentTools = p.manifest.agents.map((a) => agentToolName(p.key, a.name));
    if (agentTools.length) contributions.push(`experts: ${agentTools.join(", ")}`);
    const mcp = p.manifest.mcpServers.map((s) => `mcp__${s.name}__*`);
    if (mcp.length) contributions.push(`tools: ${mcp.join(", ")}`);
    if (contributions.length === 0) continue;
    lines.push(`- **${p.displayName}** — ${contributions.join("; ")}`);
  }
  if (lines.length === 0) return "";
  return (
    "## Installed plugins\n" +
    "These capabilities come from plugins installed on this bot. When you use one, you can name it " +
    "to the user.\n\n" +
    lines.join("\n")
  );
}
