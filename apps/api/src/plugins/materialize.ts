/**
 * Materialization: a plugin's declarations → per-bot rows in the three tables the runtime already
 * reads (`skills`, `bot_mcp_servers`, `bot_setup_steps`), each stamped with `plugin_id`.
 *
 * This is still the CONTROL plane — it writes rows and nothing else. The box knows nothing until
 * `bootstrapBot` reads those rows back (or the incremental path in `manager.ts` does). Keeping it
 * that way is what lets an install succeed while a bot's sandbox is cold: the rows are the durable
 * truth, and the box catches up whenever it next comes online.
 *
 * ## The one real translation: stdio → a bridged box-local server
 *
 * A community MCP server is usually `stdio` — a command the host spawns. We refuse to spawn one on
 * the platform (that would put an untrusted subprocess outside every tenant boundary), but the bot's
 * own box is exactly the right place, so the row we write is an ordinary box-local one:
 *
 *   transport: "http"
 *   boxLocal: { start: "node /opt/ibot-mcp-bridge.js --port <p> --cwd <PLUGIN_ROOT> -- <cmd> <args>",
 *               port: <p>, health: "/health", path: "/mcp" }
 *
 * `startBoxMcp`, `gatherBotDefs` and `connectBotMcpTools` then need no changes whatsoever — the
 * entire stdio ecosystem arrives through a row shape the runtime has supported since before plugins.
 *
 * The port is allocated PER BOT here rather than in the manifest, because a manifest is shared
 * content: the same `@acme/crm` row serves every tenant that installs it, and one tenant's port
 * assignment has no business being in it.
 */
import type { Database } from "@i-bot/db";
import { botMcpServers, botSetupSteps, skills as skillsTable } from "@i-bot/db";
import { MCP_BRIDGE_PATH, MCP_BRIDGE_PORT_BASE } from "@i-bot/core";
import type { PluginManifest } from "@i-bot/types";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { pluginDir } from "./box-paths.js";

/** The header the bridge checks. Mirrors `MCP_BRIDGE_JS`'s own constant. */
export const BRIDGE_TOKEN_HEADER = "x-ibot-bridge";

/** Shell-safe single-quote wrap (same discipline as bootstrap/provision). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface MaterializeResult {
  skills: number;
  mcpServers: number;
  setupSteps: number;
  /** ports assigned to bridged stdio servers, for the caller's log/preview */
  bridgedPorts: number[];
}

/**
 * The next free bridge port for a bot: one above the highest it already uses, floored at the base.
 *
 * Counting from the bot's OWN rows (not a global counter) keeps ports stable per box and means two
 * bots can hold the same port — which is correct, since each binds inside its own sandbox.
 */
export async function nextBridgePort(db: Database, botId: string): Promise<number> {
  const rows = await db.query.botMcpServers.findMany({
    where: eq(botMcpServers.botId, botId),
    columns: { boxLocal: true },
  });
  let max = MCP_BRIDGE_PORT_BASE - 1;
  for (const row of rows) {
    const port = (row.boxLocal as { port?: number } | null)?.port;
    if (typeof port === "number" && port >= MCP_BRIDGE_PORT_BASE && port > max) max = port;
  }
  return max + 1;
}

/**
 * The package an `npx` command would fetch, or null when the command isn't npx (or the package can't
 * be read off argv). Follows npx's own convention: the first argument that isn't a flag or a flag's
 * value is the package spec.
 */
export function npxPackage(command: string, args: readonly string[]): string | null {
  if (command !== "npx" && !command.endsWith("/npx")) return null;
  // `-p/--package` NAMES the package explicitly, and the bare arg after it is the binary to run from
  // it — so when this form is used, its value is what to fetch, not the first bare argument.
  const named = new Set(["-p", "--package"]);
  // Other flags that consume the next argument, which must not be read as the package.
  const takesValue = new Set(["-c", "--call", "-w", "--workspace"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (named.has(arg)) return args[i + 1] ?? null;
    if (takesValue.has(arg)) {
      i++; // skip its value
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Build the box-local spec that runs a stdio MCP server behind the bridge.
 *
 * The command carries no secret: `{{secrets.NAME}}` in the declared `env` is resolved at bootstrap
 * time and injected over `handle.run`'s env channel, and the bridge's auth token travels the same
 * way. What lands in the DB and in `ps` is the command text only.
 */
export function bridgeSpec(input: {
  pluginKey: string;
  command: string;
  args: readonly string[];
  port: number;
}): { install: string[]; start: string; port: number; health: string; path: string } {
  const cwd = pluginDir(input.pluginKey);
  const parts = [
    "node",
    MCP_BRIDGE_PATH,
    "--port",
    String(input.port),
    "--cwd",
    shq(cwd),
    "--",
    shq(input.command),
    ...input.args.map(shq),
  ];
  const install = [
    // The plugin dir must exist before the bridge chdirs into it; a plugin with no carried files
    // still needs its data dir. Idempotent.
    `mkdir -p ${shq(`${cwd}/data`)}`,
  ];
  // Pre-fetch an npx-run server into the npm cache. `npx -y <pkg>` downloads on FIRST run, which for
  // something like @modelcontextprotocol/server-filesystem is tens of seconds — long enough that the
  // bridge is listening while its child is still fetching. Doing it as an install step moves that
  // cost to install time, where the user is already waiting and a slow step is honest. `|| true`: a
  // pre-warm that fails (offline, private registry) must not fail the install — the server still
  // works, it just starts cold.
  const pkg = npxPackage(input.command, input.args);
  if (pkg) install.push(`npm cache add ${shq(pkg)} > /dev/null 2>&1 || true`);

  return {
    install,
    start: parts.join(" "),
    port: input.port,
    health: "/health",
    path: "/mcp",
  };
}

/**
 * Write one plugin's declarations as rows for one bot. Idempotent per (bot, plugin): existing rows
 * for this `plugin_id` are removed first, so re-materializing after an upgrade replaces rather than
 * duplicates.
 *
 * Deliberately NOT a transaction over the box: rows land first and the box is reconciled separately
 * (`bootstrapBot`, or the incremental path on install). A crash between the two leaves rows whose box
 * state is stale, which the next bootstrap fixes — the opposite order would leave a box holding
 * processes no row accounts for.
 */
export async function materializePluginForBot(
  db: Database,
  input: { botId: string; pluginId: string; manifest: PluginManifest },
): Promise<MaterializeResult> {
  const { botId, pluginId, manifest } = input;

  await dematerializePluginForBot(db, { botId, pluginId });

  const result: MaterializeResult = {
    skills: 0,
    mcpServers: 0,
    setupSteps: 0,
    bridgedPorts: [],
  };

  // 1) skills → rows. The playbook is prompt text (never written to the box); `files` are the glue
  //    scripts bootstrap renders under the skill's own dir.
  if (manifest.skills.length > 0) {
    const rows = manifest.skills.map((skill) => ({
      scope: "bot" as const,
      ownerRef: botId,
      name: skill.name,
      description: skill.description,
      playbook: skill.playbook,
      files: skill.files,
      secretRefs: skill.secretRefs,
      pluginId,
    }));
    await db.insert(skillsTable).values(rows);
    result.skills = rows.length;
  }

  // 2) setup steps → rows, keeping declaration order as `ord` (they're replayed in it).
  if (manifest.setupSteps.length > 0) {
    const rows = manifest.setupSteps.map((step, i) => ({
      botId,
      ord: i,
      kind: step.kind,
      spec: step.spec,
      pluginId,
    }));
    await db.insert(botSetupSteps).values(rows);
    result.setupSteps = rows.length;
  }

  // 3) MCP servers → rows. Remote ones pass through; stdio becomes a bridged box-local server.
  if (manifest.mcpServers.length > 0) {
    let port = await nextBridgePort(db, botId);
    const rows = manifest.mcpServers.map((server) => {
      const base = {
        botId,
        name: server.name,
        toolFilter: server.toolFilter ?? null,
        pluginId,
      };
      if (server.transport === "stdio" && server.command) {
        const spec = bridgeSpec({
          pluginKey: manifest.key,
          command: server.command,
          args: server.args,
          port: port++,
        });
        result.bridgedPorts.push(spec.port);
        return {
          ...base,
          // The row is an ordinary box-local HTTP server — that's the whole trick.
          transport: "http" as const,
          command: null,
          args: null,
          url: null,
          // A random per-server token, checked by the bridge and sent by the platform's MCP client.
          // The bridge port is gateway-exposed (it has to be, to be reachable at all), so host
          // secrecy alone would be the only thing guarding `tools/call`.
          headers: { [BRIDGE_TOKEN_HEADER]: randomBytes(24).toString("base64url") },
          // The declared stdio env travels to the bridge process, secrets and all, at bootstrap.
          env: server.env ?? null,
          boxLocal: spec,
        };
      }
      return {
        ...base,
        transport: server.transport,
        command: null,
        args: null,
        url: server.url ?? null,
        headers: server.headers ?? null,
        env: null,
        boxLocal: null,
      };
    });
    await db.insert(botMcpServers).values(rows);
    result.mcpServers = rows.length;
  }

  return result;
}

/**
 * Remove a plugin's rows for one bot. Used before re-materializing, when a plugin is disabled for a
 * bot, and on uninstall.
 *
 * `plugin_id` has `onDelete: cascade`, so deleting the PLUGIN row cleans up automatically — but
 * disabling a plugin for one bot doesn't delete anything, which is exactly why this exists. The
 * box-side counterpart (stopping bridge processes, removing the plugin dir) is the caller's job,
 * since it needs a live handle.
 */
export async function dematerializePluginForBot(
  db: Database,
  input: { botId: string; pluginId: string },
): Promise<{ ports: number[] }> {
  const { botId, pluginId } = input;

  // Read the ports before deleting: the caller needs them to kill the bridge processes, and after
  // the delete there is nothing left to learn them from.
  const mcpRows = await db.query.botMcpServers.findMany({
    where: and(eq(botMcpServers.botId, botId), eq(botMcpServers.pluginId, pluginId)),
    columns: { boxLocal: true },
  });
  const ports = mcpRows
    .map((r) => (r.boxLocal as { port?: number } | null)?.port)
    .filter((p): p is number => typeof p === "number");

  await Promise.all([
    db
      .delete(skillsTable)
      .where(and(eq(skillsTable.ownerRef, botId), eq(skillsTable.pluginId, pluginId))),
    db
      .delete(botSetupSteps)
      .where(and(eq(botSetupSteps.botId, botId), eq(botSetupSteps.pluginId, pluginId))),
    db
      .delete(botMcpServers)
      .where(and(eq(botMcpServers.botId, botId), eq(botMcpServers.pluginId, pluginId))),
  ]);

  return { ports };
}
