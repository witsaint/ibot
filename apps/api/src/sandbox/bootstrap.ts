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
 *  - **Setup-step software** (`bot_setup_steps`) → apt/pip/npm/cmd/download, replayed in `ord`
 *    order. Re-run on every bootstrap: a fresh box has none of it, and the commands are naturally
 *    idempotent (apt/pip re-install cleanly).
 *  - **Box-local MCP servers** → installed + started as in-box processes; the agent reaches them
 *    server-side over the gateway at `getHost(port)`. Started here so they survive a rebuild.
 *
 * What deliberately does NOT land in the box: skill playbooks (injected into the system prompt
 * server-side), MCP connection config, and any secret value (resolved server-side, injected via
 * the `envs` channel — see `../secrets/`). The box never holds a plaintext credential at rest.
 */
import type { Database } from "@i-bot/db";
import { botMcpServers, botSetupSteps, skills as skillsTable } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import type { BotSetupStep, McpServer, Skill } from "@i-bot/types";
import { and, asc, eq, or } from "drizzle-orm";

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

/** Everything a bot needs materialized, gathered from the DB (the ledger). */
export interface BotDefs {
  skills: Skill[];
  setupSteps: BotSetupStep[];
  mcpServers: McpServer[];
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
 * Gather a bot's definitions from the DB: its applicable skills (bot-owned + public), its setup
 * steps (in `ord` order), and its ENABLED box-local MCP servers. Read-only; the caller renders
 * the result with `bootstrapBot`.
 */
export async function gatherBotDefs(db: Database, botId: string): Promise<BotDefs> {
  const [skillRows, stepRows, mcpRows] = await Promise.all([
    // bot-scoped skills for this bot, plus public ones available to everyone
    db.query.skills.findMany({
      where: or(
        and(eq(skillsTable.scope, "bot"), eq(skillsTable.ownerRef, botId)),
        eq(skillsTable.scope, "public"),
      ),
    }),
    db.query.botSetupSteps.findMany({
      where: eq(botSetupSteps.botId, botId),
      orderBy: [asc(botSetupSteps.ord)],
    }),
    db.query.botMcpServers.findMany({
      where: and(eq(botMcpServers.botId, botId), eq(botMcpServers.enabled, true)),
    }),
  ]);
  return {
    skills: skillRows as unknown as Skill[],
    setupSteps: stepRows as unknown as BotSetupStep[],
    mcpServers: mcpRows as unknown as McpServer[],
  };
}

export interface BootstrapOptions {
  logger?: Logger;
  /** per-command wall-clock cap (ms). Default 60s. */
  stepTimeoutMs?: number;
  /** health-poll interval for box-local MCP (ms). Default 1s. */
  healthIntervalMs?: number;
  /** max health-poll attempts before giving up on a box-local MCP. Default 20. */
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

  /* eslint-disable no-await-in-loop */ // sequential against one box, on purpose (see provision.ts)

  // 1) skill glue-files → /root/.ibot/skills/<id>/<path>
  for (const skill of defs.skills) {
    if (skill.files.length === 0) continue;
    const ok = await renderSkillFiles(target, skill, { stepTimeoutMs });
    if (ok) skillsRendered++;
    else log?.warn({ botId, skillId: skill.id }, "skill file render failed");
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
    const started = await startBoxMcp(target, mcp, opts);
    if (started) boxMcp.push(started);
    else
      log?.warn({ botId, mcpId: mcp.id, name: mcp.name }, "box-local MCP failed to become healthy");
  }

  /* eslint-enable no-await-in-loop */

  log?.info(
    { botId, skillsRendered, setupStepsApplied, setupStepsFailed, boxMcp: boxMcp.length },
    "bootstrap complete",
  );
  return { skillsRendered, setupStepsApplied, setupStepsFailed, boxMcp };
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
 * Install (idempotently) and start a box-local MCP server, then poll its health path until it
 * answers or attempts run out. Returns the endpoint the server-side resolver dials, or null if it
 * never came up. The process is launched with `nohup … &` (same pattern as the cdp-proxy) so it
 * outlives the shell session.
 */
async function startBoxMcp(
  target: BootstrapTarget,
  mcp: McpServer,
  opts: BootstrapOptions,
): Promise<StartedBoxMcp | null> {
  const spec = mcp.boxLocal!;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stepTimeoutMs = opts.stepTimeoutMs ?? 60_000;
  const interval = opts.healthIntervalMs ?? 1_000;
  const attempts = opts.healthAttempts ?? 20;

  /* eslint-disable no-await-in-loop */
  // install steps (idempotent — re-run cleanly on a rebuilt box)
  for (const cmd of spec.install) {
    const res = await target.run(cmd, { timeoutMs: stepTimeoutMs });
    if (res.exitCode !== 0) return null; // install failed → don't try to start
  }

  // start detached; a log file aids debugging without holding the session open
  const logFile = `${IBOT_ROOT}/mcp/${mcp.id}.log`;
  await target.run(
    `mkdir -p ${shq(`${IBOT_ROOT}/mcp`)} && nohup ${spec.start} > ${shq(logFile)} 2>&1 &`,
    { timeoutMs: 10_000 },
  );

  // poll health on the in-box port
  const healthUrl = `http://127.0.0.1:${spec.port}${spec.health}`;
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
