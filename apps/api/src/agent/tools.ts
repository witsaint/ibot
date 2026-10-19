/**
 * The bot's hands: AI SDK tools that wrap `@i-bot/core`'s executors against ONE live
 * sandbox handle. Browser tools (CDP) are the preferred path for web work — fast, stable,
 * coordinate-free; desktop tools (xdotool/scrot) are the fallback for system dialogs,
 * native fields, and captchas (AGENTS.md). The browser session is created lazily on first
 * browser action and reused for the run; `dispose()` closes it without killing the box.
 *
 * Each tool returns a compact JSON-able result (`{ ok, text?, error? }`). Screenshots come
 * back as base64; `toModelOutput` turns that into an actual image content block so the vision
 * model SEES the frame (a plain result would serialize the base64 as text — huge and unusable).
 * The UI's live noVNC preview is the independent, always-on view of what the box is doing.
 */
import {
  type BrowserSession,
  connectBrowser,
  executeDesktopAction,
  type SandboxHandle,
} from "@i-bot/core";
import type { Database } from "@i-bot/db";
import { botMcpServers, skills as skillsTable } from "@i-bot/db";
import {
  A2uiMessage,
  BrowserAction,
  DesktopAction,
  HandoffKind,
  RunCommand,
  Skill,
} from "@i-bot/types";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  guardSecretReadback,
  interpolateSecrets,
  referencedSecretNames,
} from "../secrets/interpolate.js";
import { resolveSecretValues } from "../secrets/vault.js";
import { renderSkillFiles } from "../sandbox/bootstrap.js";
import { localPluginIdFor } from "../plugins/repository.js";
import { validateA2uiMessages } from "./a2ui-validate.js";

/**
 * The tenant context (db + the bot this run drives). Powers two things that must be scoped to one
 * tenant: resolving `{{secrets.NAME}}` in run_command, and persisting a skill from `save_skill`.
 */
export interface TenantWiring {
  db: Database;
  botId: string;
}

/**
 * Turn a tool result into what the model receives. When the result carries a base64
 * screenshot, emit a `content` output with a real image `file` part (so Anthropic sees the
 * pixels) plus a short text line for the other fields; otherwise fall through to JSON.
 *
 * A base64 PNG is thousands of chars; `pruneHistoryForModel` replaces older ones with a short
 * placeholder string. The length guard means a pruned/omitted screenshot is sent as JSON text
 * (cheap) rather than mis-decoded as image bytes.
 */
function toModelOutput({ output }: { output: unknown }) {
  const res = (output ?? {}) as {
    ok?: boolean;
    text?: string;
    error?: string;
    screenshot?: string;
  };
  const shot = res.screenshot;
  if (typeof shot === "string" && shot.length > 1024) {
    const summary = {
      ok: res.ok,
      ...(res.text ? { text: res.text } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
    return {
      type: "content" as const,
      value: [
        { type: "text" as const, text: JSON.stringify(summary) },
        {
          type: "file" as const,
          data: { type: "data" as const, data: shot },
          mediaType: "image/png",
        },
      ],
    };
  }
  return { type: "json" as const, value: (output ?? null) as never };
}

/**
 * Anthropic's Messages API rejects a tool `input_schema` whose root is `oneOf`/`anyOf`/
 * `allOf` ("does not support … at the top level"). `BrowserAction`/`DesktopAction` are
 * zod discriminated unions, which render as a top-level `oneOf`. Wrapping each in a
 * single-field object nests the `oneOf` under `properties.action` (allowed) while keeping
 * the schema root a plain object. The model calls e.g. `browser_action({ action: {...} })`.
 */
const BrowserActionInput = z.object({ action: BrowserAction });
const DesktopActionInput = z.object({ action: DesktopAction });

/** Holds the lazily-connected browser session so tools reuse one CDP connection. */
class BrowserLease {
  #handle: SandboxHandle;
  #session: BrowserSession | null = null;
  #connecting: Promise<BrowserSession> | null = null;

  constructor(handle: SandboxHandle) {
    this.#handle = handle;
  }

  async get(): Promise<BrowserSession> {
    if (this.#session) return this.#session;
    if (!this.#connecting) {
      this.#connecting = connectBrowser(this.#handle).then((s) => {
        this.#session = s;
        return s;
      });
    }
    return this.#connecting;
  }

  async dispose(): Promise<void> {
    const s = this.#session;
    this.#session = null;
    this.#connecting = null;
    if (s) await s.close().catch(() => {});
  }
}

/**
 * Memoizes this run's hold on the exclusive GUI lease. All three GUI tools (browser/desktop/
 * screenshot) drive the SAME box, so a run acquires the lease once — on its first GUI tool call —
 * and reuses that token for every later GUI action, releasing it only when the run settles. If no
 * `acquireGui` is wired (e.g. unit tests, or a run that never touches the GUI), it's a no-op and
 * tools run unguarded. `acquire` may reject (human control / lease timeout); the GUI tools surface
 * that as a refusal envelope rather than throwing into the model loop.
 */
class GuiGate {
  #acquire?: (requester: string) => Promise<symbol>;
  #release?: (token: symbol) => void;
  #requester: string;
  #token: symbol | null = null;
  #pending: Promise<symbol> | null = null;

  constructor(
    requester: string,
    acquire?: (requester: string) => Promise<symbol>,
    release?: (token: symbol) => void,
  ) {
    this.#requester = requester;
    this.#acquire = acquire;
    this.#release = release;
  }

  /** Ensure this run holds the lease (acquiring once, then reusing). No-op without `acquire`. */
  async ensure(): Promise<void> {
    if (!this.#acquire || this.#token) return;
    if (!this.#pending) {
      this.#pending = this.#acquire(this.#requester).then((t) => {
        this.#token = t;
        return t;
      });
    }
    await this.#pending;
  }

  /** Release the lease if held (called after the browser lease is disposed). */
  release(): void {
    if (this.#token && this.#release) this.#release(this.#token);
    this.#token = null;
    this.#pending = null;
  }
}

export interface SandboxTools {
  tools: ToolSet;
  /** End-of-run cleanup: close the browser session (if any), THEN release the GUI lease so the
   *  next holder inherits a clean Chrome. Leaves the box running. */
  dispose(): Promise<void>;
}

/** Which tools a run gets. `full` = the interactive/desktop set; `concurrent-safe` = shell only. */
export type ToolMode = "full" | "concurrent-safe";

/**
 * The platform's own primitives — every tool `buildSandboxTools` can produce, with the note the UI
 * and the plugin layer show for it. This is the vocabulary an agent's tool allowlist is validated
 * against, and the content of the `@ibot/core` builtin plugin's `providedTools`.
 *
 * It lives HERE, next to the implementations, because it has to stay in step with them; a test
 * asserts the two match, so adding a tool without listing it fails rather than drifting silently.
 * Which of these a given run actually gets still depends on `mode` and what the caller wired
 * (`spawnTask`, `onHandoff`, `tenant`).
 */
export const CORE_TOOLS: readonly { name: string; description: string }[] = [
  {
    name: "browser_action",
    description: "Drive Chrome over CDP — the preferred path for web work.",
  },
  {
    name: "desktop_action",
    description: "Raw mouse/keyboard on the Linux desktop (the fallback).",
  },
  { name: "screenshot", description: "Capture the whole desktop as a PNG." },
  {
    name: "render_ui",
    description: "Draw an interactive A2UI panel (the escape hatch for cards).",
  },
  { name: "run_command", description: "A root shell in the box — the one concurrency-safe tool." },
  { name: "save_skill", description: "Record a reusable procedure into the bot's local plugin." },
  { name: "bind_mcp", description: "Register a remote MCP server for this bot (next turn)." },
  { name: "spawn_task", description: "Run independent work in the background and keep chatting." },
  { name: "request_handoff", description: "Pause the turn for something only the human can do." },
];

export interface SandboxToolsOptions {
  /**
   * `full` (default): browser + desktop + screenshot + render_ui + run_command — the interactive
   * chat turn and any desktop-driving task. `concurrent-safe`: run_command only — a detached task
   * that must run in parallel with others (no GUI tool, since those all contend for the one box).
   */
  mode?: ToolMode;
  /**
   * True while a human holds the desktop. When set, every GUI tool (browser/desktop/screenshot)
   * is refused so the human and the agent don't drive the single display `:0` at once. Checked
   * per action (not per run) so releasing control mid-run frees the agent on its next step.
   */
  isHumanInControl?: () => boolean;
  /**
   * Acquire the bot's exclusive GUI lease for this run (returns a token). Wired for GUI-capable
   * runs so concurrent runs serialize on the single box; omitted for shell-only tasks and unit
   * tests. May reject on human control or lease-wait timeout.
   */
  acquireGui?: (requester: string) => Promise<symbol>;
  /** Release the GUI lease token this run acquired. Paired with `acquireGui`. */
  releaseGui?: (token: symbol) => void;
  /**
   * Spawn a detached task that runs concurrently with this (foreground) turn. Wired ONLY for the
   * interactive foreground turn — a subagent can't nest further tasks in v1. Returns the new
   * task's id immediately (the task runs in the background and relays its result back later), or
   * an error string if the bot is at its task cap.
   */
  spawnTask?: (
    goal: string,
    needsDesktop: boolean,
  ) => Promise<{ taskId: string } | { error: string }>;
  /**
   * Called when the model invokes `request_handoff` — it's genuinely blocked on something only the
   * human can do (a login, an OTP, a secret not in the vault, a choice, a captcha it can't clear).
   * Wiring this ADDS the `request_handoff` tool; combined with the run loop's `hasToolCall` stop
   * condition, calling it ends the turn cleanly and the caller flips the bot to "awaiting human" +
   * publishes a `needs_human` event. Omitted for subagent/background runs, which bubble a block
   * back as prose instead (see jobs.ts). The `reason` is the plain ask, `kind` classifies it.
   */
  onHandoff?: (payload: { reason: string; kind: HandoffKind }) => void;
  /** Working directory to scope `run_command` into (a task's own dir). Defaults to the box's cwd. */
  workdir?: string;
  /**
   * The tenant context (db + botId). Enables `{{secrets.NAME}}` resolution in `run_command` (each
   * placeholder resolved tenant-scoped, rewritten to an env-var reference, value handed to the box
   * over the `envs` channel — never spliced into the command string) AND the `save_skill` tool
   * (persist a skill for this bot + render its files into the box for same-turn use). When omitted,
   * secret placeholders are left untouched and `save_skill` is not offered. Present on real runs,
   * omitted in unit tests that don't exercise either.
   */
  tenant?: TenantWiring;
}

/** Build the toolset bound to a live handle. Call `dispose()` when the run ends. */
export function buildSandboxTools(
  handle: SandboxHandle,
  opts: SandboxToolsOptions = {},
): SandboxTools {
  const mode: ToolMode = opts.mode ?? "full";
  const lease = new BrowserLease(handle);
  const humanHolds = opts.isHumanInControl ?? (() => false);
  const gui = new GuiGate(handle.id, opts.acquireGui, opts.releaseGui);

  // Uniform refusal when a human holds the desktop — every GUI tool renders on the one display,
  // so takeover blocks all of them (browser + desktop + screenshot), not just keyboard/mouse.
  const humanRefusal = {
    ok: false as const,
    error:
      "A human currently controls the desktop. Desktop, browser, and screenshot are disabled " +
      "until they release control — wait and try again shortly.",
  };

  const tools: ToolSet = {};

  if (mode === "full") {
    tools.browser_action = tool({
      description:
        "Drive the sandbox's Chrome over CDP. PREFERRED for any web task: navigate, click, " +
        "fill, read the DOM, wait for a selector, or screenshot. Coordinate-free and stable. " +
        "Pass the action object under `action`.",
      inputSchema: BrowserActionInput,
      toModelOutput,
      async execute({ action }) {
        if (humanHolds()) return humanRefusal;
        await gui.ensure(); // serialize on the shared box; may reject → surfaced below
        const session = await lease.get();
        return session.execute(action);
      },
    });

    tools.desktop_action = tool({
      description:
        "Control the raw Linux desktop with mouse/keyboard (xdotool) and screenshots (scrot). " +
        "Use ONLY when the browser tool can't reach it: OS dialogs, native password fields, " +
        "slider captchas, non-browser apps. Coordinates are screen pixels. " +
        "Pass the action object under `action`.",
      inputSchema: DesktopActionInput,
      toModelOutput,
      async execute({ action }) {
        if (humanHolds()) return humanRefusal;
        await gui.ensure();
        return executeDesktopAction(handle, action);
      },
    });

    tools.screenshot = tool({
      description: "Capture a PNG screenshot of the whole desktop and return it (base64).",
      inputSchema: DesktopAction.options[0], // { type: "screenshot" }
      toModelOutput,
      async execute() {
        if (humanHolds()) return humanRefusal;
        await gui.ensure();
        const bytes = await handle.screenshot();
        return { ok: true, screenshot: Buffer.from(bytes).toString("base64") };
      },
    });

    tools.render_ui = renderUiTool;
  }

  // run_command is available in EVERY mode — it's the one concurrency-safe primitive (envd
  // parallel shell sessions), and the foreground turn wants it too (installs, scripts, file ops).
  tools.run_command = buildRunCommandTool(handle, opts.workdir, opts.tenant);

  // save_skill needs the tenant context (persist for this bot) + the handle (render files now).
  // Available in every mode with a tenant — a task can codify what it just figured out.
  if (opts.tenant) tools.save_skill = buildSaveSkillTool(handle, opts.tenant);

  // bind_mcp registers a remote MCP server for the bot (persist only — takes effect next turn, since
  // the toolset is fixed at run start). Needs the tenant context; available in every mode.
  if (opts.tenant) tools.bind_mcp = buildBindMcpTool(opts.tenant);

  // spawn_task only when the caller wired it (the interactive foreground turn). A subagent can't
  // nest further tasks in v1.
  if (opts.spawnTask) tools.spawn_task = buildSpawnTaskTool(opts.spawnTask);

  // request_handoff only when the caller wired onHandoff (the foreground / proactive-relay voice).
  // A subagent/background run doesn't get it — it bubbles a block back as prose (see jobs.ts).
  if (opts.onHandoff) tools.request_handoff = buildRequestHandoffTool(opts.onHandoff);

  return {
    tools,
    dispose: async () => {
      // Order matters: close the CDP/browser session FIRST, then release the GUI lease, so the
      // next holder never inherits a half-open Chrome from the previous run.
      await lease.dispose();
      gui.release();
    },
  };
}

/**
 * `run_command` — run a shell command in the sandbox as root over envd (parallel shell sessions).
 * This is the ONLY tool safe to run concurrently with other tasks: it doesn't touch the browser or
 * the display, so many can run at once. Same trust boundary as the existing xdotool path (the box
 * already runs the desktop stack as root, tenant-isolated). Output is truncated to keep the model
 * context bounded.
 */
// Default wall-clock cap when the model omits `timeoutMs`. Set explicitly (rather than falling
// through to the SDK's own 60s default) so the behaviour is legible here and the timeout message
// can name the actual number. A genuinely long job should carry a bigger `timeoutMs` or, better,
// run via spawn_task — see the timeout branch below.
const DEFAULT_RUN_TIMEOUT_MS = 45_000;

function buildRunCommandTool(handle: SandboxHandle, workdir?: string, secrets?: TenantWiring) {
  const OUT_CAP = 8000;
  const trunc = (s: string) =>
    s.length > OUT_CAP ? `${s.slice(0, OUT_CAP)}\n…[truncated ${s.length - OUT_CAP} chars]` : s;
  return tool({
    description:
      "Run a shell command in the sandbox (bash, as root). Use for anything that isn't GUI work: " +
      "installing packages, running scripts, processing files, git, curl, build/test commands. " +
      "This runs independently of the desktop, so it's the right tool for long or background-style " +
      "work. Reference a stored credential as {{secrets.NAME}} (e.g. a bearer token in a curl " +
      "header) — it's injected into the command's environment at run time; you never see or handle " +
      "the value, and it never appears in the command text or output. Returns exit code, stdout, " +
      "and stderr (truncated if large).",
    inputSchema: RunCommand,
    toModelOutput,
    async execute({ command, timeoutMs }) {
      let toRun = command;
      let env: Record<string, string> | undefined;

      if (secrets) {
        // Guard the MODEL-AUTHORED command before injecting: refuse any attempt to read the
        // environment back out (env/printenv//proc/environ, or naming an IBOT_SECRET_ var
        // directly) — otherwise an injected secret could be echoed into stdout and the transcript.
        const blocked = guardSecretReadback(command);
        if (blocked) {
          return {
            ok: false as const,
            error:
              `Refused: this command reads the process environment (${blocked}), which could leak ` +
              "an injected secret. Reference secrets only via {{secrets.NAME}} inside the command " +
              "that consumes them; don't print the environment.",
          };
        }
        // Resolve {{secrets.NAME}} → env-var references + a separate value map (tenant-scoped).
        const interp = await interpolateSecrets(secrets.db, secrets.botId, command);
        toRun = interp.command;
        if (Object.keys(interp.env).length > 0) env = interp.env;
      }

      // Scope into the task's working dir when one is set (best-effort — ignore if it's absent).
      const scoped = workdir ? `cd ${JSON.stringify(workdir)} 2>/dev/null; ${toRun}` : toRun;
      // Cap explicitly at our own default when the model didn't ask for one, so the number is known
      // (not the SDK's hidden 60s) and the timeout guidance below can name it.
      const effectiveTimeout = timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      try {
        const res = await handle.run(scoped, {
          timeoutMs: effectiveTimeout,
          ...(env ? { env } : {}),
        });
        return {
          ok: res.exitCode === 0,
          exitCode: res.exitCode,
          stdout: trunc(res.stdout),
          stderr: trunc(res.stderr),
        };
      } catch (err) {
        const msg = (err as Error).message;
        // A timeout is the common "stuck install" case: steer the model to the right fix instead of
        // just surfacing the raw SDK error, which it tends to retry verbatim.
        if (/time?d?\s*out|timeout/i.test(msg)) {
          const secs = Math.round(effectiveTimeout / 1000);
          return {
            ok: false as const,
            error:
              `Command timed out (>${secs}s). If this is an install, build, or other long task, ` +
              `run it via spawn_task so it doesn't block the conversation — or retry with a larger ` +
              `timeoutMs (up to 600000). For package installs, also pass a non-interactive flag ` +
              `(e.g. DEBIAN_FRONTEND=noninteractive apt-get install -y …) so it can't hang on a prompt.`,
          };
        }
        return { ok: false as const, error: msg };
      }
    },
  });
}

/** What the model provides to save a skill. Mirrors the persist-able fields of the `Skill` contract
 *  (no id/scope/owner — those are set server-side to this bot). */
const SaveSkillInput = z.object({
  name: z.string().min(1).max(120).describe("Short, human-readable skill name."),
  description: z.string().min(1).describe("When to use this skill — used to match it to a task."),
  playbook: z.string().min(1).describe("The reusable step-by-step procedure, in natural language."),
  files: z
    .array(
      z.object({
        path: z.string().min(1).describe("Relative path under the skill's dir, e.g. bin/send.sh"),
        content: z.string().describe("File contents (code/scripts only — no binaries)."),
        mode: z.string().optional().describe("chmod mode, e.g. 755 for an executable."),
      }),
    )
    .default([])
    .describe("Glue scripts to save WITH the skill so it reconstructs after a sandbox rebuild."),
  secretRefs: z
    .array(z.string())
    .default([])
    .describe("Names of stored credentials the skill uses, referenced as {{secrets.NAME}}."),
});

/**
 * `save_skill` — record a reusable procedure this bot has learned. Persists it to the DB (the
 * durable ledger, so it survives a sandbox rebuild) and renders its files into the box immediately,
 * so the skill is usable THIS turn. Use it after you work out how to do something the bot will do
 * again — a login flow, a report script, an API call sequence. Reference any credentials as
 * {{secrets.NAME}} in the files/playbook; never hard-code a secret value into a skill.
 */
function buildSaveSkillTool(handle: SandboxHandle, tenant: TenantWiring) {
  return tool({
    description:
      "Save a reusable procedure ('skill') this bot has learned so it can repeat it later. Persists " +
      "to the durable store (survives sandbox rebuilds) and installs the skill's files into the " +
      "sandbox right away for same-turn use. Provide a name, a description of when to use it, a " +
      "natural-language playbook, and any glue scripts as files. Reference credentials as " +
      "{{secrets.NAME}}, never literal secret values.",
    inputSchema: SaveSkillInput,
    // files/secretRefs default at the schema, but default here too so the tool is correct even if
    // handed unparsed input (e.g. a direct call): `files.length` must never see `undefined`.
    async execute({ name, description, playbook, files = [], secretRefs = [] }) {
      try {
        // Everything a bot records belongs to its `local` plugin — the one editable bundle, and what
        // "export my experience as a plugin" later reads. Null when the bot has none yet (a bot that
        // predates plugins, until the backfill runs): a skill without a plugin id is still a working
        // skill, so this never blocks the save.
        const pluginId = await localPluginIdFor(tenant.db, tenant.botId).catch(() => null);
        const [row] = await tenant.db
          .insert(skillsTable)
          .values({
            scope: "bot",
            ownerRef: tenant.botId,
            name,
            description,
            playbook,
            files,
            secretRefs,
            pluginId,
          })
          .returning({ id: skillsTable.id });
        const skillId = row!.id;

        // Render the files into the box now → the skill is usable this turn via run_command.
        // Validate through the contract so the persisted + rendered shapes match exactly.
        const parsed = Skill.safeParse({
          id: skillId,
          scope: "bot",
          ownerRef: tenant.botId,
          name,
          description,
          playbook,
          files,
          secretRefs,
          createdAt: new Date().toISOString(),
        });
        if (parsed.success && files.length > 0) {
          await renderSkillFiles(handle, parsed.data);
        }
        return {
          ok: true as const,
          skillId,
          text: `Saved skill "${name}"${files.length ? ` with ${files.length} file(s) in the sandbox` : ""}.`,
        };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  });
}

/** What the model provides to bind a remote MCP server. stdio isn't offered — it can't run on the
 *  platform host (that's what box-local MCP, provisioned separately, is for). */
const BindMcpInput = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .describe("Short name for this MCP server (used to namespace its tools)."),
  transport: z
    .enum(["http", "sse"])
    .describe("Remote transport: 'http' (Streamable HTTP) or 'sse'."),
  url: z.string().url().describe("The MCP server endpoint URL."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Auth headers. Reference stored credentials as {{secrets.NAME}} — NEVER a literal token. " +
        "The reference is resolved server-side at connect; the stored config holds no secret value.",
    ),
  toolFilter: z
    .array(z.string())
    .optional()
    .describe("Optional allowlist of tool names to expose from this server; omit to expose all."),
});

/**
 * `bind_mcp` — register a remote MCP (Model Context Protocol) server for this bot so its tools become
 * available. Takes effect NEXT turn (the current turn's toolset is already fixed). Auth goes in
 * `headers` as {{secrets.NAME}} references — the stored config never holds a plaintext credential;
 * the value is resolved from the vault server-side when the server is dialed. stdio servers aren't
 * supported (they'd run on the platform host); a server that must run "locally" belongs in the bot's
 * sandbox as a box-local server, configured out of band.
 */
function buildBindMcpTool(tenant: TenantWiring) {
  return tool({
    description:
      "Register a remote MCP server (Streamable HTTP or SSE) so this bot can use its tools. Takes " +
      "effect on the NEXT turn. Put auth in headers as {{secrets.NAME}} references (never a literal " +
      "token) — they're resolved server-side at connect and the stored config keeps no secret value.",
    inputSchema: BindMcpInput,
    async execute({ name, transport, url, headers, toolFilter }) {
      try {
        // Validate any referenced secrets exist for this bot now, so the model gets immediate
        // feedback instead of a silently-dropped header at connect time next turn.
        const refNames = headers ? referencedSecretNames(Object.values(headers).join("\n")) : [];
        const present = refNames.length
          ? await resolveSecretValues(tenant.db, tenant.botId, refNames)
          : {};
        const missing = refNames.filter((n) => !(n in present));

        // Same as save_skill: a server the bot bound itself belongs to its `local` plugin.
        const pluginId = await localPluginIdFor(tenant.db, tenant.botId).catch(() => null);
        const [row] = await tenant.db
          .insert(botMcpServers)
          .values({
            botId: tenant.botId,
            name,
            transport,
            url,
            headers: headers ?? null,
            toolFilter: toolFilter ?? null,
            enabled: true,
            pluginId,
          })
          .returning({ id: botMcpServers.id });

        return {
          ok: true as const,
          mcpId: row!.id,
          text:
            `Bound MCP server "${name}" (${transport}). Its tools will be available next turn.` +
            (missing.length
              ? ` WARNING: referenced secrets not found: ${missing.join(", ")} — store them first.`
              : ""),
          ...(missing.length ? { missingSecrets: missing } : {}),
        };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  });
}

/**
 * `spawn_task` — start a detached task that runs CONCURRENTLY while you keep talking to the user.
 * Returns the task id right away (it does NOT block on the task). The task runs its own agent loop
 * headlessly; when it finishes, its result is relayed back to you as a message so you can tell the
 * user. Use it for anything long or independent — a build, a scrape, a multi-step script — so the
 * conversation isn't frozen while it runs. Set `needs_desktop:true` only if the task must drive the
 * browser/desktop (those serialize on the one screen); leave it false for pure shell work so it
 * runs truly in parallel.
 */
const SpawnTaskInput = z.object({
  goal: z
    .string()
    .min(1)
    .describe("A self-contained description of what the task should accomplish."),
  needs_desktop: z
    .boolean()
    .default(false)
    .describe("True only if the task must use the browser/desktop; false for shell-only work."),
});

function buildSpawnTaskTool(
  spawnTask: (
    goal: string,
    needsDesktop: boolean,
  ) => Promise<{ taskId: string } | { error: string }>,
) {
  return tool({
    description:
      "Start a background task that runs concurrently while you keep chatting with the user. " +
      "Returns immediately with a task id — you do NOT wait for it. When it completes, its result " +
      "comes back to you as a message so you can report it. " +
      "ALWAYS use this (not run_command) for work that can run for minutes: package installs " +
      "(apt/dpkg/pip/npm i), builds/compiles, large downloads, scrapes, or any multi-step script. " +
      "Running those inline with run_command freezes the conversation and hits the ~45s command " +
      "timeout. `needs_desktop:true` only when the task must drive the browser/desktop (those " +
      "serialize on the one screen); false for pure shell work so it runs truly in parallel.",
    inputSchema: SpawnTaskInput,
    // Tiny ack — the taskId matters, the mechanics don't need re-feeding each turn.
    toModelOutput: ({ output }) => {
      const o = (output ?? {}) as { taskId?: string; error?: string };
      return {
        type: "json" as const,
        value: (o.error ? { ok: false, error: o.error } : { ok: true, taskId: o.taskId }) as never,
      };
    },
    async execute({ goal, needs_desktop }) {
      const res = await spawnTask(goal, needs_desktop);
      if ("error" in res) return { ok: false as const, error: res.error };
      return { ok: true as const, taskId: res.taskId };
    },
  });
}

/** What the model provides to hand off to the human. `reason` is the plain ask (what to do);
 *  `kind` classifies the block so the UI can label the pause. */
const RequestHandoffInput = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      "What the human must do, in plain language (e.g. 'log into Gmail so I can continue').",
    ),
  kind: HandoffKind.describe(
    "Classify the block: login | otp | secret | choice | captcha | other.",
  ),
});

/**
 * `request_handoff` — pause the turn and hand off to the human. Call this ONLY when you're genuinely
 * blocked on something only they can do (a login, an OTP/2FA, a secret not in the vault, a choice
 * only they know, a captcha you've actually attempted and can't clear). Write the plain-language ask
 * as normal prose FIRST (so the user sees what you need), THEN call this in the same turn: it ends
 * your turn cleanly and flags the chat that you're waiting. When the human has done the step and
 * sends a message, you pick up with the full context. Do NOT call it to merely confirm or to watch —
 * only when you truly can't proceed alone.
 */
function buildRequestHandoffTool(
  onHandoff: (payload: { reason: string; kind: HandoffKind }) => void,
) {
  return tool({
    description:
      "Pause the turn and hand off to the human when you're GENUINELY blocked on something only " +
      "they can do — a login, an OTP/2FA code, a secret that isn't in the vault, a choice only they " +
      "know, or a human-verification challenge you've actually attempted and can't clear. Write the " +
      "plain-language ask as prose FIRST so they see what you need, THEN call this: it ends your " +
      "turn cleanly and flags the chat that you're waiting. You'll resume with full context when " +
      "they reply. Don't call it just to confirm, to watch, or when you can find the answer yourself.",
    inputSchema: RequestHandoffInput,
    // Tiny ack — the turn is ending; nothing to re-feed the model.
    toModelOutput: () => ({ type: "json" as const, value: { ok: true } as never }),
    execute({ reason, kind }) {
      onHandoff({ reason, kind });
      return {
        ok: true as const,
        text: "Handoff requested — the turn will pause so the human can step in.",
      };
    },
  });
}

/**
 * `render_ui` — draw an interactive panel in the chat for the human (A2UI protocol,
 * https://a2ui.org). Unlike the browser/desktop tools it does NOT touch the sandbox: it just
 * passes the A2UI messages through as its output. They ride the UI Message Stream and the web
 * client renders them with `@a2ui/web_core` against a fixed component catalog (so the model can
 * only reference pre-approved components — never inject markup). A human interaction (button
 * click, form submit) comes back as a normal user message, so the model reacts to it like any
 * other turn.
 *
 * `toModelOutput` returns only a tiny ack — NOT the messages echoed back — so a rendered panel
 * costs almost nothing in later turns' context (same token discipline as the screenshot pruning
 * above). The verbatim messages still persist in the stored tool part for the UI to re-render.
 */
const RenderUiInput = z.object({
  /**
   * A2UI v0.9 protocol messages, in order. Typically: one `createSurface`
   * (`{version:"v0.9", createSurface:{surfaceId, catalogId}}`), then `updateComponents`
   * (`{version:"v0.9", updateComponents:{surfaceId, components:[{id, component, children?/child?,
   * ...props}]}}`) defining a flat adjacency list of components, then `updateDataModel`
   * (`{version:"v0.9", updateDataModel:{surfaceId, path:"/", value:{...}}}`) supplying the data
   * components bind to via `{path:"/field"}`. Interactive components carry an `action`
   * (`{event:{name, context}}`) whose fired name/context returns to you as a user message.
   */
  messages: z.array(A2uiMessage).min(1),
});

const renderUiTool = tool({
  description:
    "Render an interactive UI panel in the chat for the human, using the A2UI protocol " +
    "(declarative JSON, https://a2ui.org). Use this when a form, choices, a summary card, or " +
    "any structured/clickable surface serves the human better than prose — e.g. collecting " +
    "several fields at once, offering options to pick, or laying out a result. For plain replies " +
    "just write prose; don't wrap everything in a panel.\n\n" +
    "Pass A2UI v0.9 `messages` in order:\n" +
    "1. createSurface: {version:'v0.9', createSurface:{surfaceId, catalogId}}.\n" +
    "2. updateComponents: {version:'v0.9', updateComponents:{surfaceId, components:[...]}} — a " +
    "FLAT adjacency list. Each component is {id, component, ...props}; children are referenced by " +
    "id string, NEVER inlined. Exactly ONE component MUST have id 'root' — it's the top-level " +
    "container the surface mounts (usually a Column or Card). Without a 'root' the panel never " +
    "renders.\n" +
    "3. updateDataModel: {version:'v0.9', updateDataModel:{surfaceId, path:'/', value:{...}}} — the " +
    "data that components bind to via {path:'/field'}.\n\n" +
    "Component prop contracts (basic catalog — schemas are STRICT, unknown props are rejected):\n" +
    "• Text {text, variant?} — variant ∈ h1|h2|h3|h4|h5|caption|body (NOT 'heading'/'title'). No " +
    "'label'. `body` (the default) renders markdown — bold, lists, links, inline code — so a " +
    "short formatted paragraph is one Text, not a Column of many.\n" +
    "• Button {child, variant?, action?} — `child` is the ID of a Text (or Icon) component for the " +
    "label; there is NO 'label' prop. variant ∈ default|primary|borderless.\n" +
    "• TextField {label, value?, variant?} — `value` binds via {path:'/field'}; variant ∈ " +
    "shortText|longText|number|obscured. There is NO 'placeholder' prop (use `label`).\n" +
    "• CheckBox {label, value} • Slider {label?, max, value, min?} • DateTimeInput {value, " +
    "enableDate?, enableTime?, label?}.\n" +
    "• ChoicePicker {options:[{label, value}], value, label?, variant?} — variant ∈ " +
    "multipleSelection|mutuallyExclusive; `value` binds a string array.\n" +
    "• Row/Column/List {children:[...ids], justify?, align?} — `children` is an array of component " +
    "id strings.\n" +
    "• Card {child} • Tabs {tabs:[{title, child}]} • Modal {trigger, content} • Divider {axis?} — " +
    "these reference children by id.\n" +
    "• Image {url, description?, fit?, variant?} • Icon {name} • Video {url} • AudioPlayer {url}.\n\n" +
    "Interactive components (Button, inputs) take an action {event:{name, context}} — when the " +
    "human interacts, its name + context come back to you as a user message to act on. Bind input " +
    "values into the data model so submits carry their state.\n\n" +
    "UPDATING a panel in place (e.g. after the human submits a form, or to show a result on the " +
    "same card): call render_ui again REUSING the same surfaceId, and send ONLY the delta — " +
    "updateComponents (to change/add components) and/or updateDataModel (to change bound data), " +
    "with NO createSurface and NO need to restate 'root'. The existing card mutates in place. Use " +
    "a NEW surfaceId only when you mean to draw a SEPARATE new card. First render of a surface " +
    "still needs createSurface + a 'root'.\n\n" +
    "The panel is validated against the catalog before it renders: if a component's props are " +
    "wrong, or a NEW surface (createSurface) is missing its 'root', the tool returns " +
    "{ok:false, errors:[...]} with the exact field issues — read them and re-send a corrected " +
    "`messages` in the same turn.",
  inputSchema: RenderUiInput,
  // Keep the model's echo tiny — a valid panel is for the human, not re-fed to the model. On a
  // rejected panel, surface the per-component errors so the model can self-correct THIS turn
  // (otherwise the human just sees a stuck `[Loading root...]` and the model never learns why).
  toModelOutput: ({ output }) => {
    const out = output as { ok?: boolean; errors?: unknown } | null;
    if (out && out.ok === false) {
      return { type: "json" as const, value: { ok: false, errors: out.errors ?? [] } as never };
    }
    return { type: "json" as const, value: { ok: true, rendered: true } as never };
  },
  // No sandbox side effect. Validate against the render catalog first (mirrors the client), and
  // only pass the messages through when they'd actually render — a rejected panel returns errors
  // and NO `a2ui`, so the client never receives a batch it would silently drop.
  execute({ messages }) {
    const result = validateA2uiMessages(messages);
    if (!result.ok) {
      return { ok: false as const, errors: result.errors };
    }
    return { ok: true as const, a2ui: messages };
  },
});
