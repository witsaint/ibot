/**
 * The importer: a plugin DIRECTORY → a `PluginManifest`.
 *
 * This is the compatibility layer with the Claude Code plugin ecosystem, and it is deliberately the
 * only place that knows that ecosystem's file layout exists. It READS files and parses frontmatter /
 * JSON. It does not execute anything — not a setup step, not an MCP command, not a hook — and it
 * can't: everything executable a bundle carries comes out the other side as DATA in the manifest,
 * and only ever runs later inside the owning bot's own sandbox.
 *
 * ## What maps to what
 *
 * | source                        | becomes                                                      |
 * |-------------------------------|--------------------------------------------------------------|
 * | `.claude-plugin/plugin.json`  | identity (`key`, `version`, `displayName`, author, homepage)  |
 * | `skills/<n>/SKILL.md`         | `skills[]` — frontmatter + body as playbook, siblings as files|
 * | `agents/<n>.md`               | `agents[]` — frontmatter + body as prompt, tools remapped     |
 * | `.mcp.json`, `mcpServers`     | `mcpServers[]` — stdio kept as stdio, translated at materialize|
 * | `hooks/hooks.json`            | `hooks[]` — command hooks run in the box                      |
 * | `commands/*.md`               | ignored (a chat has no slash commands) and reported           |
 * | anything else                 | `files[]`, materialized into `${PLUGIN_ROOT}`                 |
 *
 * ## The two translations that matter
 *
 * **Paths.** A community bundle refers to its own directory as `${CLAUDE_PLUGIN_ROOT}`. Every command
 * string is rewritten to our box layout (`box-paths.ts`), so a plugin's scripts resolve without the
 * author knowing anything about us.
 *
 * **Tool names.** An agent's `tools` allowlist is written against Claude Code's tools (`Bash`,
 * `Read`, `WebFetch`…). Ours are different and fewer, so names are mapped onto their nearest
 * equivalent and anything with no equivalent is DROPPED and reported — never passed through, because
 * an unknown name in an allowlist would silently widen or narrow what an agent can do.
 *
 * Everything the importer can't represent lands in `manifest.ignored[]`, which is what the install
 * preview shows the user. A bundle that half-imported silently would be worse than one that failed.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { PLUGIN_LIMITS, type PluginManifest } from "@i-bot/types";
import { rewritePlaceholders, unknownPlaceholders } from "./box-paths.js";
import { ManifestError, normalizeManifest } from "./manifest.js";

/** Files we never carry into a box: VCS metadata, dependency trees, build junk, editor state. */
const SKIP_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

/** Extensions carried as base64 rather than utf8 (anything we can't assume is text). */
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".so",
  ".dylib",
  ".wasm",
]);

/**
 * Claude Code tool names → ours. `Bash` is the obvious one; the file tools all collapse onto
 * `run_command` because that IS how a box reads and writes files for us. A name with no equivalent
 * is dropped rather than guessed.
 */
const TOOL_MAP: Record<string, string> = {
  Bash: "run_command",
  BashOutput: "run_command",
  Read: "run_command",
  Write: "run_command",
  Edit: "run_command",
  MultiEdit: "run_command",
  NotebookEdit: "run_command",
  Glob: "run_command",
  Grep: "run_command",
  LS: "run_command",
  WebFetch: "browser_action",
  WebSearch: "browser_action",
  Task: "spawn_task",
  TodoWrite: "update_plan",
};

export interface ImportOptions {
  /** overrides the key derived from `plugin.json`/the directory name */
  key?: string;
  /** overrides the version; defaults to `plugin.json`'s or `0.0.0` */
  version?: string;
  source?: "builtin" | "installed";
}

/** A parsed markdown file: its frontmatter and its body. */
interface Frontmatter {
  data: Record<string, string | string[] | boolean>;
  body: string;
}

/**
 * Parse YAML frontmatter, supporting exactly what plugin metadata uses: `key: value`, quoted values,
 * `[a, b]` inline lists, and `- item` block lists. Not a YAML parser — a real one would be a new
 * dependency for a format that is, in practice, flat scalars. Anything more complex is left as a raw
 * string, and the caller decides whether it can use it.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string | string[] | boolean> = {};
  const lines = match[1]!.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      const prev = data[currentKey];
      const value = unquote(item[1]!);
      data[currentKey] = Array.isArray(prev) ? [...prev, value] : [value];
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    currentKey = key!;
    const value = raw!.trim();
    if (value === "") {
      data[key!] = []; // a block list follows
    } else if (value === "true" || value === "false") {
      data[key!] = value === "true";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key!] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      data[key!] = unquote(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Read a string field out of parsed frontmatter. */
function str(data: Frontmatter["data"], key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a list field, accepting a comma-separated string (which is how `tools:` is often written). */
function list(data: Frontmatter["data"], key: string): string[] {
  const value = data[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Every file under `dir`, relative-pathed, skipping the ignore list. */
async function walk(dir: string, root = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Sequential: a plugin dir is small, and unbounded parallel readdir buys nothing here.
      // eslint-disable-next-line no-await-in-loop
      out.push(...(await walk(full, root)));
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read a plugin directory into a normalized manifest.
 *
 * The result is the whole truth about what installing this plugin would do — including every command
 * that would run in the box, which is what the install preview lists for the user before they agree
 * to it. Throws `ManifestError` if the result fails validation (limits, plaintext credentials,
 * network tampering).
 */
export async function importPluginDirectory(
  dir: string,
  opts: ImportOptions = {},
): Promise<PluginManifest> {
  const ignored: { path: string; reason: string }[] = [];
  const meta = (await readJson(join(dir, ".claude-plugin", "plugin.json"))) ?? {};

  const name = typeof meta.name === "string" ? meta.name : basename(dir);
  const key = (opts.key ?? name).toLowerCase();
  const version = opts.version ?? (typeof meta.version === "string" ? meta.version : "0.0.0");

  const paths = await walk(dir);
  const consumed = new Set<string>([".claude-plugin/plugin.json"]);

  const skills = await collectSkills(dir, paths, consumed, ignored);
  const agents = await collectAgents(dir, paths, consumed, ignored, key);
  const mcpServers = await collectMcpServers(dir, meta, consumed, ignored, key);
  const hooks = await collectHooks(dir, paths, consumed, ignored, key);

  // Legacy commands/ files are reported; explicit invocation uses skills frontmatter command.
  for (const path of paths) {
    if (path.startsWith("commands/") && path.endsWith(".md")) {
      consumed.add(path);
      ignored.push({
        path,
        reason:
          "commands/ files are not supported; use a skill with command frontmatter for explicit invocation",
      });
    }
  }

  const files = await collectFiles(dir, paths, consumed, ignored);

  const manifest = {
    key,
    version,
    displayName: typeof meta.displayName === "string" ? meta.displayName : name,
    description: typeof meta.description === "string" ? meta.description : "",
    ...(isAuthor(meta.author) ? { author: meta.author } : {}),
    ...(typeof meta.homepage === "string" ? { homepage: meta.homepage } : {}),
    skills,
    agents,
    mcpServers,
    hooks,
    files,
    ignored,
    // Passed through rather than dropped here, so `normalizeManifest` strips it AND records why —
    // a bundle that declared platform tools should be told they were ignored, not left guessing.
    ...(Array.isArray(meta.providedTools) ? { providedTools: meta.providedTools } : {}),
  };

  return normalizeManifest(manifest, { source: opts.source ?? "installed" });
}

function isAuthor(value: unknown): value is { name: string; email?: string; url?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/** `skills/<n>/SKILL.md` + every sibling file → one skill with its glue files. */
async function collectSkills(
  dir: string,
  paths: string[],
  consumed: Set<string>,
  ignored: { path: string; reason: string }[],
): Promise<PluginManifest["skills"]> {
  const skills: PluginManifest["skills"] = [];
  const skillFiles = paths.filter(
    (p) => p.startsWith("skills/") && basename(p).toUpperCase() === "SKILL.MD",
  );

  for (const path of skillFiles) {
    consumed.add(path);
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(join(dir, path), "utf8");
    const { data, body } = parseFrontmatter(text);
    const skillRoot = path.slice(0, path.length - basename(path).length); // "skills/<n>/"
    const name = str(data, "name") ?? basename(skillRoot.replace(/\/$/, ""));

    // Sibling files travel WITH the skill (`skills[].files`), not into the plugin's file list, so a
    // skill stays self-contained: the row that carries the playbook carries its scripts too.
    const files: { path: string; content: string; mode?: string }[] = [];
    for (const sibling of paths) {
      if (!sibling.startsWith(skillRoot) || sibling === path || consumed.has(sibling)) continue;
      consumed.add(sibling);
      const ext = extname(sibling).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        ignored.push({ path: sibling, reason: "binary file next to a skill isn't carried" });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const content = await readFile(join(dir, sibling), "utf8");
      if (Buffer.byteLength(content, "utf8") > PLUGIN_LIMITS.fileBytes) {
        ignored.push({ path: sibling, reason: "over the per-file size limit" });
        continue;
      }
      files.push({
        path: sibling.slice(skillRoot.length),
        content,
        // A shell script that isn't executable is a support ticket; mark them at import.
        ...(ext === ".sh" || ext === ".py" ? { mode: "755" } : {}),
      });
    }

    skills.push({
      name,
      description: str(data, "description") ?? "",
      playbook: body.trim(),
      files,
      secretRefs: [],
      ...(str(data, "command") ? { command: str(data, "command") } : {}),
      // Claude Code's opt-out for "this skill is machinery, not something to offer the model".
      hidden: data["disable-model-invocation"] === true,
    });
  }
  return skills;
}

/** `agents/<n>.md` → one predefined expert, with its tool allowlist mapped onto our tool names. */
async function collectAgents(
  dir: string,
  paths: string[],
  consumed: Set<string>,
  ignored: { path: string; reason: string }[],
  pluginKey: string,
): Promise<PluginManifest["agents"]> {
  const agents: PluginManifest["agents"] = [];
  for (const path of paths.filter((p) => p.startsWith("agents/") && p.endsWith(".md"))) {
    consumed.add(path);
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(join(dir, path), "utf8");
    const { data, body } = parseFrontmatter(text);

    const declared = list(data, "tools");
    const mapped = new Set<string>();
    for (const tool of declared) {
      const ours = TOOL_MAP[tool];
      if (ours) mapped.add(ours);
      else if (tool.startsWith("mcp__")) mapped.add(tool); // an MCP tool name is already ours
      else ignored.push({ path, reason: `tool "${tool}" has no equivalent and was dropped` });
    }

    const maxTurns = Number(str(data, "maxTurns") ?? "");
    agents.push({
      name: str(data, "name") ?? basename(path, ".md"),
      description: str(data, "description") ?? "",
      // The prompt is the one place a `${CLAUDE_PLUGIN_ROOT}` reference is TEXT the model reads, so
      // rewrite it too — otherwise the agent is told to look somewhere that doesn't exist.
      prompt: rewritePlaceholders(body.trim(), pluginKey),
      // An empty allowlist means "inherit", and passing `tools: []` would mean "no tools at all" —
      // so only set it when something actually mapped.
      ...(mapped.size > 0 ? { tools: [...mapped] } : {}),
      ...(str(data, "model") ? { model: str(data, "model")! } : {}),
      ...(Number.isFinite(maxTurns) && maxTurns > 0 ? { maxTurns: Math.min(maxTurns, 60) } : {}),
      needsDesktop: false,
      ...(list(data, "skills").length > 0 ? { skills: list(data, "skills") } : {}),
    });
  }
  return agents;
}

/**
 * `.mcp.json` (or `plugin.json`'s `mcpServers`) → `mcpServers[]`.
 *
 * `stdio` is KEPT as `stdio` here, with its command rewritten to box paths. The translation into a
 * bridged box-local row happens at materialization, because that's where a port can be allocated per
 * bot — the manifest is shared content and must not carry one bot's port.
 */
async function collectMcpServers(
  dir: string,
  meta: Record<string, unknown>,
  consumed: Set<string>,
  ignored: { path: string; reason: string }[],
  pluginKey: string,
): Promise<PluginManifest["mcpServers"]> {
  const fromFile = await readJson(join(dir, ".mcp.json"));
  if (fromFile) consumed.add(".mcp.json");
  const declared =
    (fromFile?.mcpServers as Record<string, unknown> | undefined) ??
    (meta.mcpServers as Record<string, unknown> | undefined) ??
    {};

  const servers: PluginManifest["mcpServers"] = [];
  for (const [name, raw] of Object.entries(declared)) {
    if (typeof raw !== "object" || raw === null) continue;
    const spec = raw as Record<string, unknown>;
    const command = typeof spec.command === "string" ? spec.command : undefined;
    const url = typeof spec.url === "string" ? spec.url : undefined;
    const declaredType = typeof spec.type === "string" ? spec.type : undefined;

    const env = stringMap(spec.env);
    const headers = stringMap(spec.headers);

    if (command) {
      const args = Array.isArray(spec.args)
        ? spec.args.filter((a): a is string => typeof a === "string")
        : [];
      // Report a placeholder we don't map rather than passing it to the shell as a literal `${X}`.
      for (const unknown of unknownPlaceholders([command, ...args].join(" "))) {
        ignored.push({
          path: `mcpServers.${name}`,
          reason: `unknown placeholder \${${unknown}} left as-is`,
        });
      }
      servers.push({
        name,
        transport: "stdio",
        command: rewritePlaceholders(command, pluginKey),
        args: args.map((a) => rewritePlaceholders(a, pluginKey)),
        ...(env ? { env } : {}),
      });
      continue;
    }
    if (url) {
      servers.push({
        name,
        transport: declaredType === "sse" ? "sse" : "http",
        url,
        args: [],
        ...(headers ? { headers } : {}),
      });
      continue;
    }
    ignored.push({ path: `mcpServers.${name}`, reason: "neither a command nor a url" });
  }
  return servers;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Claude Code hook events → ours. Only the ones we actually fire are importable. */
const HOOK_EVENTS: Record<string, PluginManifest["hooks"][number]["on"]> = {
  SessionStart: "turn.start",
  UserPromptSubmit: "turn.start",
  PreToolUse: "tool.before",
  PostToolUse: "tool.after",
};

/** `hooks/hooks.json` → `hooks[]`. A `command` hook runs in the box, with its paths rewritten. */
async function collectHooks(
  dir: string,
  paths: string[],
  consumed: Set<string>,
  ignored: { path: string; reason: string }[],
  pluginKey: string,
): Promise<PluginManifest["hooks"]> {
  const candidates = paths.filter((p) => p === "hooks/hooks.json" || p === "hooks.json");
  const hooks: PluginManifest["hooks"] = [];

  for (const path of candidates) {
    consumed.add(path);
    // eslint-disable-next-line no-await-in-loop
    const parsed = await readJson(join(dir, path));
    const byEvent = (parsed?.hooks ?? parsed) as Record<string, unknown> | null;
    if (!byEvent) continue;

    for (const [event, entries] of Object.entries(byEvent)) {
      const on = HOOK_EVENTS[event];
      if (!on) {
        ignored.push({ path: `${path}:${event}`, reason: `event "${event}" has no equivalent` });
        continue;
      }
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (typeof entry !== "object" || entry === null) continue;
        const group = entry as { matcher?: unknown; hooks?: unknown };
        const match = typeof group.matcher === "string" ? group.matcher : undefined;
        for (const h of Array.isArray(group.hooks) ? group.hooks : [group]) {
          const spec = h as { type?: unknown; command?: unknown; timeout?: unknown };
          if (spec.type !== "command" || typeof spec.command !== "string") {
            ignored.push({ path: `${path}:${event}`, reason: "only command hooks are supported" });
            continue;
          }
          // Claude Code's `timeout` is seconds; ours is ms and hard-capped at 30s by the schema.
          const seconds = typeof spec.timeout === "number" ? spec.timeout : 10;
          hooks.push({
            on,
            ...(match && match !== "*" ? { match } : {}),
            do: {
              type: "command",
              command: rewritePlaceholders(spec.command, pluginKey),
              timeoutMs: Math.min(Math.max(Math.round(seconds * 1000), 1000), 30_000),
            },
          });
        }
      }
    }
  }
  return hooks;
}

/** Everything not consumed above → `files[]`, materialized verbatim into `${PLUGIN_ROOT}`. */
async function collectFiles(
  dir: string,
  paths: string[],
  consumed: Set<string>,
  ignored: { path: string; reason: string }[],
): Promise<PluginManifest["files"]> {
  const files: PluginManifest["files"] = [];
  let total = 0;

  for (const path of paths) {
    if (consumed.has(path)) continue;
    const abs = join(dir, path);
    // eslint-disable-next-line no-await-in-loop
    const info = await stat(abs).catch(() => null);
    if (!info) continue;
    if (info.size > PLUGIN_LIMITS.fileBytes) {
      ignored.push({ path, reason: `${info.size} bytes, over the per-file limit` });
      continue;
    }
    if (total + info.size > PLUGIN_LIMITS.totalFileBytes) {
      ignored.push({ path, reason: "would exceed the bundle size limit" });
      continue;
    }
    total += info.size;

    const ext = extname(path).toLowerCase();
    const binary = BINARY_EXT.has(ext);
    // eslint-disable-next-line no-await-in-loop
    const buf = await readFile(abs);
    files.push({
      path,
      content: binary ? buf.toString("base64") : buf.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      // Preserve the executable bit: a carried script is usually the point of carrying it.
      ...(info.mode & 0o111 ? { mode: "755" } : {}),
    });
  }
  return files;
}

// ---------- the install preview

/** One command that will run inside the box if this plugin is installed. */
export interface BoxCommand {
  kind: "setup" | "mcp" | "hook";
  label: string;
  command: string;
}

/**
 * What installing this plugin would actually do — the list the user sees BEFORE agreeing.
 *
 * The security property this exists for: every command that will run in the box is enumerated here,
 * so "install" is never a blind `unzip && trust`. The platform runs none of it; this is a reading of
 * the manifest.
 */
export interface PluginInspection {
  key: string;
  version: string;
  displayName: string;
  description: string;
  skills: { name: string; description: string; hidden: boolean; command?: string; files: number }[];
  /** servers dialed from the platform (remote http/sse) */
  remoteMcp: { name: string; transport: string; url: string }[];
  /** servers that will run as a process in the box, with the command that starts them */
  boxMcp: { name: string; command: string }[];
  agents: { name: string; description: string; tools: string[] | "inherit" }[];
  cards: { name: string; description: string }[];
  /** everything that will execute in the box, in one list */
  boxCommands: BoxCommand[];
  requiredSecrets: string[];
  ignored: { path: string; reason: string }[];
  totalFileBytes: number;
}

/** Build the install preview from a manifest. Pure. */
export function inspectManifest(manifest: PluginManifest): PluginInspection {
  const boxCommands: BoxCommand[] = [];
  for (const [i, step] of manifest.setupSteps.entries()) {
    const spec = step.spec as Record<string, unknown>;
    const shown =
      step.kind === "cmd"
        ? String(spec.run ?? "")
        : `${step.kind}: ${String(spec.pkg ?? spec.url ?? "")}`;
    boxCommands.push({ kind: "setup", label: `setupSteps[${i}] (${step.kind})`, command: shown });
  }
  for (const server of manifest.mcpServers) {
    if (server.transport === "stdio" && server.command) {
      boxCommands.push({
        kind: "mcp",
        label: `mcp "${server.name}"`,
        command: [server.command, ...server.args].join(" "),
      });
    }
  }
  for (const hook of manifest.hooks) {
    if (hook.do.type === "command") {
      boxCommands.push({
        kind: "hook",
        label: `hook on ${hook.on}${hook.match ? ` (${hook.match})` : ""}`,
        command: hook.do.command,
      });
    }
  }

  // Secrets a plugin needs, whether it declared them or merely referenced them.
  const referenced = new Set(manifest.requiredSecrets);
  for (const server of manifest.mcpServers) {
    for (const value of [
      ...Object.values(server.env ?? {}),
      ...Object.values(server.headers ?? {}),
    ]) {
      for (const m of value.matchAll(/\{\{\s*secrets\.([A-Za-z0-9_]{1,120})\s*\}\}/g)) {
        referenced.add(m[1]!);
      }
    }
  }

  return {
    key: manifest.key,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    skills: manifest.skills.map((s) => ({
      name: s.name,
      description: s.description,
      hidden: s.hidden,
      ...(s.command ? { command: s.command } : {}),
      files: s.files.length,
    })),
    remoteMcp: manifest.mcpServers
      .filter((s) => s.transport !== "stdio")
      .map((s) => ({ name: s.name, transport: s.transport, url: s.url ?? "" })),
    boxMcp: manifest.mcpServers
      .filter((s) => s.transport === "stdio")
      .map((s) => ({ name: s.name, command: [s.command ?? "", ...s.args].join(" ").trim() })),
    agents: manifest.agents.map((a) => ({
      name: a.name,
      description: a.description,
      tools: a.tools ?? "inherit",
    })),
    cards: manifest.ui.map((u) => ({ name: u.name, description: u.description })),
    boxCommands,
    requiredSecrets: [...referenced],
    ignored: manifest.ignored,
    totalFileBytes: manifest.files.reduce(
      (n, f) =>
        n +
        (f.encoding === "base64"
          ? Math.floor((f.content.length * 3) / 4)
          : Buffer.byteLength(f.content, "utf8")),
      0,
    ),
  };
}

export { ManifestError };
