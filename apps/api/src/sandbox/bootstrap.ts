/**
 * Bootstrap a bot's box from the DB ledger. The sandbox is NOT reliably persistent (the gateway
 * disables template build + snapshots, forces a ~24h pause/resume, and reclaims a box whose
 * keepalive lapses), so the DB is the source of truth and `/root/.ibot/` is a rebuildable cache we
 * re-render on every fresh box or recovery. This runs AFTER the desktop provision, against a live
 * handle, and is idempotent — safe to re-run on a warm box.
 *
 * What lands in the box (and only this):
 *  - **Skill glue-files** → `/root/.ibot/skills/<skillId>/<path>`. The agent executes these via
 *    `run_command` (e.g. `bash /root/.ibot/skills/<id>/send.sh`). Content lives in the DB
 *    (`skills.files`), so a skill fully reconstructs after a rebuild — no binary blobs, just code.
 *  - **Plugin directories** → `/root/.ibot/plugins/<key>/` (= `${PLUGIN_ROOT}`), the files an
 *    installed plugin carries, guarded by a content-hash marker so an unchanged plugin costs one
 *    `cat`. Its `data/` subdir is the plugin's own writable state and is never cleared.
 *  - **Setup-step software** (`bot_setup_steps`) → apt/pip/npm/cmd/download, replayed in `ord`
 *    order. Re-run on every bootstrap: a fresh box has none of it, and the commands are naturally
 *    idempotent (apt/pip re-install cleanly).
 *  - **Box-local MCP servers** → installed + started as in-box processes; the agent reaches them
 *    server-side over the gateway at `getHost(port)`. Started here so they survive a rebuild. A
 *    plugin's `stdio` server is one of these: its `start` runs the in-box bridge (see
 *    `plugins/materialize.ts`), which is why nothing in this file knows what stdio is.
 *
 * What deliberately does NOT land in the box: skill playbooks (injected into the system prompt
 * server-side), MCP connection config, and any secret value (resolved server-side, injected via
 * the `envs` channel — see `../secrets/`). The box never holds a plaintext credential at rest.
 */
import type { Database } from "@i-bot/db";
import { botMcpServers, botSetupSteps, plugins, skills as skillsTable } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import type { BotSetupStep, McpServer, PluginManifest, Skill } from "@i-bot/types";
import { and, asc, eq, inArray } from "drizzle-orm";
import { PLUGIN_MARKER, pluginDataDir, pluginDir, type PluginMarker } from "../plugins/box-paths.js";
import { interpolateSecrets } from "../secrets/interpolate.js";

/** Root of the rebuildable cache inside the box. */
export const IBOT_ROOT = "/root/.ibot";

/** The slice of a handle bootstrap needs (keeps the unit test tiny — mirrors ProvisionTarget). */
export interface BootstrapTarget {
  run(
    command: string,
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  getHost(port: number): string;
}

/** One plugin's carried files, with the hash that decides whether the box already has them. */
export interface PluginPayload {
  pluginId: string;
  key: string;
  version: string;
  contentHash: string;
  files: PluginManifest["files"];
}

/** Everything a bot needs materialized, gathered from the DB (the ledger). */
export interface BotDefs {
  skills: Skill[];
  setupSteps: BotSetupStep[];
  mcpServers: McpServer[];
  plugins: PluginPayload[];
}

/** A box-local MCP server that came up, with the URL the server-side resolver connects to. */
export interface StartedBoxMcp {
  id: string;
  name: string;
  /** gateway URL the agent's MCP client dials (`getHost(port)`) */
  url: string;
}

export interface BootstrapResult {
  skillsRendered: number;
  setupStepsApplied: number;
  setupStepsFailed: number;
  /** plugin directories rendered (excluding ones already at the right content hash) */
  pluginsRendered: number;
  pluginsSkipped: number;
  pluginsFailed: number;
  boxMcp: StartedBoxMcp[];
}

/** Shell-safe single-quote wrap (same discipline as provision.ts). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Absolute dir a skill's files are rendered under. */
export function skillDir(skillId: string): string {
  return `${IBOT_ROOT}/skills/${skillId}`;
}

/**
 * Materialize a skill's glue-files into the box under `skillDir(skill.id)`, each via base64→base64
 * -d (the handle exposes only `run`), applying `chmod` when a mode is set. Returns true if every
 * file wrote cleanly. Shared by `bootstrapBot` (whole-box render) and `save_skill` (render one
 * freshly-saved skill so it's usable the same turn). A skill with no files is a trivial success.
 */
export async function renderSkillFiles(
  target: BootstrapTarget,
  skill: Skill,
  opts: { stepTimeoutMs?: number } = {},
): Promise<boolean> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 60_000;
  const dir = skillDir(skill.id);
  /* eslint-disable no-await-in-loop */
  for (const f of skill.files) {
    // paths are DB-authored and relative; join under the skill dir and create parents.
    const abs = `${dir}/${f.path}`;
    const b64 = Buffer.from(f.content, "utf8").toString("base64");
    const write = await target.run(
      `mkdir -p "$(dirname ${shq(abs)})" && printf %s ${shq(b64)} | base64 -d > ${shq(abs)}` +
        (f.mode ? ` && chmod ${shq(f.mode)} ${shq(abs)}` : ""),
      { timeoutMs: stepTimeoutMs },
    );
    if (write.exitCode !== 0) return false;
  }
  /* eslint-enable no-await-in-loop */
  return true;
}

/**
 * Materialize one plugin's carried files into `${PLUGIN_ROOT}`, skipping the work when the box
 * already holds this exact content.
 *
 * The marker (`.ibot-plugin.json`) holds the plugin's `content_hash`, so the check is one `cat`
 * against a value the DB already has — no per-file comparison, and no hashing in the box. On a
 * mismatch the directory is REPLACED (`rm -rf` then re-render) rather than merged, because a stale
 * file from a previous version is invisible: nothing lists what should no longer be there. `data/` is
 * preserved across that replacement — it is the plugin's own state, not our render output.
 *
 * Returns true when the box ends up holding this version's files.
 */
export async function renderPluginFiles(
  target: BootstrapTarget,
  plugin: PluginPayload,
  opts: { stepTimeoutMs?: number } = {},
): Promise<{ ok: boolean; skipped: boolean }> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 60_000;
  const dir = pluginDir(plugin.key);
  const dataDir = pluginDataDir(plugin.key);
  const markerPath = `${dir}/${PLUGIN_MARKER}`;

  // Already materialized at this content hash? Then there is nothing to do.
  const existing = await target.run(`cat ${shq(markerPath)} 2>/dev/null`, { timeoutMs: 10_000 });
  if (existing.exitCode === 0) {
    try {
      const marker = JSON.parse(existing.stdout) as PluginMarker;
      if (marker.contentHash === plugin.contentHash) return { ok: true, skipped: true };
    } catch {
      // unparseable marker → treat as absent and re-render
    }
  }

  // Replace the render output, keep the plugin's data. `find … -mindepth 1` deletes the contents of
  // the dir except `data`, which `-prune` keeps whole.
  const reset =
    `mkdir -p ${shq(dir)} ${shq(dataDir)} && ` +
    `find ${shq(dir)} -mindepth 1 -maxdepth 1 -name data -prune -o -exec rm -rf {} +`;
  const cleaned = await target.run(reset, { timeoutMs: stepTimeoutMs });
  if (cleaned.exitCode !== 0) return { ok: false, skipped: false };

  /* eslint-disable no-await-in-loop */ // sequential against one box, on purpose
  for (const file of plugin.files) {
    // A declared path is relative and must stay inside the plugin's dir: `..` in a manifest would
    // otherwise write anywhere in the box. Rejecting is right — a legitimate plugin has no reason to.
    if (file.path.includes("..") || file.path.startsWith("/")) return { ok: false, skipped: false };
    const abs = `${dir}/${file.path}`;
    // Both encodings go through base64 -d: the handle exposes only `run`, so `utf8` content is
    // re-encoded here rather than being interpolated into a shell string (where a quote or a newline
    // in a carried script would break the command).
    const b64 =
      file.encoding === "base64"
        ? file.content
        : Buffer.from(file.content, "utf8").toString("base64");
    const write = await target.run(
      `mkdir -p "$(dirname ${shq(abs)})" && printf %s ${shq(b64)} | base64 -d > ${shq(abs)}` +
        (file.mode ? ` && chmod ${shq(file.mode)} ${shq(abs)}` : ""),
      { timeoutMs: stepTimeoutMs },
    );
    if (write.exitCode !== 0) return { ok: false, skipped: false };
  }
  /* eslint-enable no-await-in-loop */

  // The marker goes last: written only after every file landed, so an interrupted render re-runs
  // next time instead of being mistaken for a complete one.
  const marker: PluginMarker = {
    key: plugin.key,
    version: plugin.version,
    contentHash: plugin.contentHash,
    materializedAt: new Date().toISOString(),
  };
  const markerB64 = Buffer.from(JSON.stringify(marker), "utf8").toString("base64");
  const wrote = await target.run(
    `printf %s ${shq(markerB64)} | base64 -d > ${shq(markerPath)}`,
    { timeoutMs: 10_000 },
  );
  return { ok: wrote.exitCode === 0, skipped: false };
}

/**
 * Gather a bot's definitions from the DB: its skills, its setup steps (in `ord` order), its ENABLED
 * box-local MCP servers, and the plugins whose files need to be in the box. Read-only; the caller
 * renders the result with `bootstrapBot`.
 *
 * The skill filter is a single owner-scoped `AND` — deliberately NOT `… OR scope='public'`. A
 * `public` skill row has no owner column, so that branch would render another tenant's skill FILES
 * into this bot's box. (The same unfiltered branch was removed from `loadBotSkills`, which feeds the
 * system prompt; this is the file-rendering half of it.) Tenant isolation has to be a SQL `WHERE`,
 * not a filter applied afterwards, so nothing downstream can forget it.
 */
export async function gatherBotDefs(db: Database, botId: string): Promise<BotDefs> {
  const [skillRows, stepRows, mcpRows] = await Promise.all([
    db.query.skills.findMany({
      where: and(eq(skillsTable.scope, "bot"), eq(skillsTable.ownerRef, botId)),
    }),
    db.query.botSetupSteps.findMany({
      where: eq(botSetupSteps.botId, botId),
      orderBy: [asc(botSetupSteps.ord)],
    }),
    db.query.botMcpServers.findMany({
      where: and(eq(botMcpServers.botId, botId), eq(botMcpServers.enabled, true)),
    }),
  ]);

  // The plugins to materialize are exactly those that produced this bot's rows — derived from the
  // rows themselves rather than re-resolving installs, so the box can never hold files for a plugin
  // whose rows were already removed (disable, uninstall, downgrade).
  const pluginIds = [
    ...new Set(
      [...skillRows, ...stepRows, ...mcpRows]
        .map((r) => (r as { pluginId?: string | null }).pluginId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const pluginRows = pluginIds.length
    ? await db.query.plugins.findMany({
        where: inArray(plugins.id, pluginIds),
        columns: { id: true, key: true, version: true, contentHash: true, manifest: true },
      })
    : [];

  return {
    skills: skillRows as unknown as Skill[],
    setupSteps: stepRows as unknown as BotSetupStep[],
    mcpServers: mcpRows as unknown as McpServer[],
    plugins: pluginRows.map((row) => ({
      pluginId: row.id,
      key: row.key,
      version: row.version,
      contentHash: row.contentHash,
      files: (row.manifest as PluginManifest).files ?? [],
    })),
  };
}

export interface BootstrapOptions {
  logger?: Logger;
  /** per-command wall-clock cap (ms). Default 60s. */
  stepTimeoutMs?: number;
  /** health-poll interval for box-local MCP (ms). Default 1s. */
  healthIntervalMs?: number;
  /**
   * Max health-poll attempts before giving up on a box-local MCP. Default 60 (≈60s).
   *
   * Sized for a cold `npx -y <server>`: the bridge only reports healthy once its child ANSWERS, and
   * on a cache miss npm can spend most of a minute fetching before the server reads stdin. Giving up
   * early is the expensive mistake — it hands the run loop no endpoint at all, when waiting a few
   * more seconds would have produced a working one.
   */
  healthAttempts?: number;
  /** sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Render a bot's definitions into a live box. Idempotent. Returns a summary plus the box-local MCP
 * endpoints that came up (the server-side resolver dials these). A failing setup step or MCP is
 * recorded and skipped — bootstrap never throws on a single bad definition, so one broken skill
 * can't stop the box from coming up.
 */
export async function bootstrapBot(
  target: BootstrapTarget,
  db: Database,
  botId: string,
  defs: BotDefs,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 60_000;
  const log = opts.logger;

  let skillsRendered = 0;
  let setupStepsApplied = 0;
  let setupStepsFailed = 0;
  let pluginsRendered = 0;
  let pluginsSkipped = 0;
  let pluginsFailed = 0;

  /* eslint-disable no-await-in-loop */ // sequential against one box, on purpose (see provision.ts)

  // 1) skill glue-files → /root/.ibot/skills/<id>/<path>
  for (const skill of defs.skills) {
    if (skill.files.length === 0) continue;
    const ok = await renderSkillFiles(target, skill, { stepTimeoutMs });
    if (ok) skillsRendered++;
    else log?.warn({ botId, skillId: skill.id }, "skill file render failed");
  }

  // 1b) plugin directories → ${PLUGIN_ROOT}. BEFORE setup steps and MCP, both of which may run a
  //     script the plugin carries. A failure here is recorded and skipped: one bad plugin must not
  //     stop the others, and the box is still usable without it.
  for (const plugin of defs.plugins) {
    const { ok, skipped } = await renderPluginFiles(target, plugin, { stepTimeoutMs });
    if (!ok) {
      pluginsFailed++;
      log?.warn({ botId, plugin: plugin.key }, "plugin file render failed");
    } else if (skipped) pluginsSkipped++;
    else pluginsRendered++;
  }

  // 2) setup steps in ord order — replayed every bootstrap (a fresh box has none of the software).
  for (const step of defs.setupSteps) {
    const cmd = setupStepCommand(step);
    if (!cmd) {
      log?.warn({ botId, stepId: step.id, kind: step.kind }, "unknown setup step kind, skipping");
      continue;
    }
    const res = await target.run(cmd, { timeoutMs: stepTimeoutMs });
    const applied = res.exitCode === 0;
    if (applied) setupStepsApplied++;
    else setupStepsFailed++;
    await db
      .update(botSetupSteps)
      .set({
        status: applied ? "applied" : "failed",
        lastError: applied
          ? null
          : (res.stderr || res.stdout || `exit ${res.exitCode}`).slice(-400),
        appliedAt: applied ? new Date() : null,
      })
      .where(eq(botSetupSteps.id, step.id));
    if (!applied) log?.warn({ botId, stepId: step.id }, "setup step failed");
  }

  // 3) box-local MCP servers: install (idempotent) → start (nohup) → poll health.
  const boxMcp: StartedBoxMcp[] = [];
  for (const mcp of defs.mcpServers) {
    if (!mcp.boxLocal) continue;
    const started = await startBoxMcp(target, mcp, { ...opts, db, botId });
    if (started) boxMcp.push(started);
    else
      log?.warn({ botId, mcpId: mcp.id, name: mcp.name }, "box-local MCP failed to become healthy");
  }

  /* eslint-enable no-await-in-loop */

  log?.info(
    {
      botId,
      skillsRendered,
      setupStepsApplied,
      setupStepsFailed,
      pluginsRendered,
      pluginsSkipped,
      pluginsFailed,
      boxMcp: boxMcp.length,
    },
    "bootstrap complete",
  );
  return {
    skillsRendered,
    setupStepsApplied,
    setupStepsFailed,
    pluginsRendered,
    pluginsSkipped,
    pluginsFailed,
    boxMcp,
  };
}

/** Build the shell command for a setup step from its kind + spec. Returns null for an unknown kind. */
export function setupStepCommand(step: BotSetupStep): string | null {
  const spec = step.spec as Record<string, unknown>;
  const pkg = typeof spec.pkg === "string" ? spec.pkg : "";
  switch (step.kind) {
    case "apt":
      return `DEBIAN_FRONTEND=noninteractive apt-get install -y ${shq(pkg)}`;
    case "pip":
      return `pip3 install ${shq(pkg)}`;
    case "npm":
      return `npm install -g ${shq(pkg)}`;
    case "cmd":
      return typeof spec.run === "string" ? spec.run : null;
    case "download": {
      const url = typeof spec.url === "string" ? spec.url : "";
      const dest = typeof spec.dest === "string" ? spec.dest : "";
      if (!url || !dest) return null;
      return `mkdir -p "$(dirname ${shq(dest)})" && curl -fsSL ${shq(url)} -o ${shq(dest)}`;
    }
    default:
      return null;
  }
}

/**
 * Resolve the environment a box-local MCP server's process needs.
 *
 * Two things travel this channel, and neither may appear in the command string:
 *
 *  - the server's declared `env`, whose `{{secrets.NAME}}` values are resolved tenant-scoped from
 *    the vault. The process (and, for a bridged stdio server, its child) reads them from its own
 *    environment — which is the same level of access the model already has via `run_command`, and is
 *    the intended use: a server calling an API with its own token.
 *  - for a bridged server, the bridge's auth token, stored in the row's `headers` because the
 *    platform's MCP client sends it as a request header.
 *
 * A referenced secret with no value is reported so the caller can log it — the server usually still
 * starts, and failing to connect with a clear reason beats not starting with none.
 */
async function resolveBoxMcpEnv(
  db: Database,
  botId: string,
  mcp: McpServer,
): Promise<{ env: Record<string, string>; missing: string[] }> {
  const env: Record<string, string> = {};
  const missing: string[] = [];

  // Each entry resolves independently, so they go together rather than one round trip at a time.
  const entries = Object.entries(mcp.env ?? {});
  const resolvedAll = await Promise.all(
    entries.map(async ([key, raw]) => {
      // Reuse the shell interpolator's resolution, then keep the VALUE (not the `$VAR` reference):
      // this map IS the env, so a reference here would just be a literal `$IBOT_SECRET_X` string.
      const resolved = await interpolateSecrets(db, botId, raw);
      let value = raw;
      for (const [varName, secret] of Object.entries(resolved.env)) {
        const name = varName.replace(/^IBOT_SECRET_/, "");
        value = value.replace(new RegExp(`\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`, "g"), secret);
      }
      return { key, value, missing: resolved.missing };
    }),
  );
  for (const entry of resolvedAll) {
    env[entry.key] = entry.value;
    missing.push(...entry.missing);
  }

  // The bridge reads its token from IBOT_BRIDGE_TOKEN; the platform sends the same value as a header.
  const token = mcp.headers?.["x-ibot-bridge"];
  if (token) env.IBOT_BRIDGE_TOKEN = token;

  return { env, missing };
}

/**
 * Install (idempotently) and start a box-local MCP server, then poll its health path until it
 * answers or attempts run out. Returns the endpoint the server-side resolver dials, or null if it
 * never came up. The process is launched with `nohup … &` (same pattern as the cdp-proxy) so it
 * outlives the shell session.
 *
 * Idempotent in the way that matters after a pause/resume: if something is already listening on the
 * port and healthy, the existing process is left alone rather than a second one started beside it.
 */
async function startBoxMcp(
  target: BootstrapTarget,
  mcp: McpServer,
  opts: BootstrapOptions & { db?: Database; botId?: string },
): Promise<StartedBoxMcp | null> {
  const spec = mcp.boxLocal!;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stepTimeoutMs = opts.stepTimeoutMs ?? 60_000;
  const interval = opts.healthIntervalMs ?? 1_000;
  const attempts = opts.healthAttempts ?? 60;
  const healthUrl = `http://127.0.0.1:${spec.port}${spec.health}`;

  // Already up (warm box, or a resume that kept processes alive)? Don't start a second one — the
  // port is taken and the duplicate would die immediately, or worse, fight over it.
  const alive = await target.run(
    `curl -fsS -o /dev/null -w '%{http_code}' ${shq(healthUrl)} 2>/dev/null`,
    { timeoutMs: 10_000 },
  );
  if (alive.exitCode === 0 && /^2\d\d$/.test(alive.stdout.trim())) {
    return { id: mcp.id, name: mcp.name, url: target.getHost(spec.port) };
  }

  // Secrets + bridge token for the process environment (never the command string).
  let env: Record<string, string> = {};
  if (opts.db && opts.botId) {
    const resolved = await resolveBoxMcpEnv(opts.db, opts.botId, mcp);
    env = resolved.env;
    if (resolved.missing.length > 0) {
      opts.logger?.warn(
        { mcpId: mcp.id, name: mcp.name, missing: resolved.missing },
        "box-local MCP references secrets that aren't in the vault",
      );
    }
  }

  /* eslint-disable no-await-in-loop */
  // install steps (idempotent — re-run cleanly on a rebuilt box)
  for (const cmd of spec.install) {
    const res = await target.run(cmd, { timeoutMs: stepTimeoutMs });
    if (res.exitCode !== 0) return null; // install failed → don't try to start
  }

  // start detached, in its OWN command. Three details here are each load-bearing, and getting any of
  // them wrong makes the launch hang until `timeoutMs` and report a failure for a server that is in
  // fact running:
  //   - the `mkdir` is a separate run. `mkdir … && nohup … &` backgrounds the whole LIST, so bash
  //     forks a subshell that waits on the child — and that subshell holds envd's stdout pipe open.
  //   - all three fds are redirected. A background child that inherits envd's stdout/stderr keeps
  //     the pipe open for as long as it lives, so envd never sees EOF; `< /dev/null` likewise stops
  //     the child from holding stdin.
  //   - `setsid` + no trailing shell work means nothing is left in the session to wait on.
  const logFile = `${IBOT_ROOT}/mcp/${mcp.id}.log`;
  await target.run(`mkdir -p ${shq(`${IBOT_ROOT}/mcp`)}`, { timeoutMs: 10_000 });
  await target.run(`setsid ${spec.start} < /dev/null > ${shq(logFile)} 2>&1 &`, {
    timeoutMs: 10_000,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });

  // poll health on the in-box port
  for (let i = 0; i < attempts; i++) {
    const res = await target.run(
      `curl -fsS -o /dev/null -w '%{http_code}' ${shq(healthUrl)} 2>/dev/null`,
      { timeoutMs: 10_000 },
    );
    const code = res.stdout.trim();
    if (res.exitCode === 0 && /^2\d\d$/.test(code)) {
      return { id: mcp.id, name: mcp.name, url: target.getHost(spec.port) };
    }
    if (i < attempts - 1) await sleep(interval);
  }
  /* eslint-enable no-await-in-loop */
  return null; // never healthy
}

/**
 * Stop the bridge/box-local MCP processes listening on `ports`, and remove a plugin's directory when
 * one is named. The counterpart to materialization: called when a plugin is disabled for a bot or
 * uninstalled, so the box stops holding processes and files no DB row accounts for.
 *
 * The kill is by port, which is precise: the port is in the bridge's own argv, and two bots can hold
 * the same port without ambiguity because each box is separate.
 *
 * Two shell details, both of which caused real failures before being written down:
 *
 *  1. Every `pkill` is its OWN `handle.run`, never combined with a launch in one command — a launch
 *     that matches the same pattern gets killed by it.
 *  2. The pattern is written `[i]bot-…` rather than `ibot-…`. `pkill -f` matches full argv, and the
 *     argv of the very shell running the pkill CONTAINS the pattern as a literal string, so the plain
 *     form kills its own shell: the kill lands but the trailing `exit 0` never runs, and the call
 *     reports a signal instead of success. The bracket is a no-op to the regex and stops the literal
 *     from matching itself. (Verified in a live box: `pgrep -fc 'ibot-mcp-bridge'` answered 1 with no
 *     bridge running at all; the bracketed form answered 0.)
 */
export async function stopBoxMcp(
  target: BootstrapTarget,
  input: { ports: readonly number[]; pluginKey?: string },
  opts: { logger?: Logger } = {},
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const port of input.ports) {
    // `-f` matches the full argv; the bridge's contains both the script name and `--port <n>`. The
    // `[i]` keeps this command's own shell from matching — see the note above.
    const res = await target.run(
      `pkill -f ${shq(`[i]bot-mcp-bridge.*--port ${port}`)}; exit 0`,
      { timeoutMs: 10_000 },
    );
    opts.logger?.debug({ port, exitCode: res.exitCode }, "stopped box-local MCP");
  }
  /* eslint-enable no-await-in-loop */

  // The plugin dir goes last, and only after its processes are gone — removing it from under a
  // running server (its cwd) would leave a process working in a deleted directory.
  if (input.pluginKey) {
    await target.run(`rm -rf ${shq(pluginDir(input.pluginKey))}`, { timeoutMs: 30_000 });
  }
}
