/**
 * Manifest normalization and identity.
 *
 * Every import path — our builtin declarations, a community Claude Code plugin directory, an
 * uploaded zip — is funnelled through `normalizeManifest` before anything is stored, so the rest of
 * the system reads exactly one shape (`PluginManifest`). Nothing here executes any part of a
 * manifest: this module parses, validates and hashes data. The executable parts a plugin carries run
 * later, inside the owning bot's own sandbox.
 *
 * `hashManifest` is the identity used for "is this the same plugin content?" — upgrade comparison in
 * the DB and materialization idempotency in the box (`.ibot-plugin.json`). It hashes a CANONICAL
 * serialization (keys sorted at every depth) so two manifests that differ only in key order — which
 * JSON round-trips and jsonb storage both reorder freely — hash the same.
 */
import { createHash } from "node:crypto";
import { PLUGIN_LIMITS, PluginManifest, sanitizePluginKey } from "@i-bot/types";

/**
 * Tool-name prefix owned by the plugin layer. A plugin may not declare a bare (core) tool name.
 *
 * Card templates have no prefix of their own: they are all called through the single `render_card`
 * tool and named by `templateId` (see `ui-templates.ts`), so there is no `ui__<key>__<name>` tool.
 */
export const AGENT_TOOL_PREFIX = "agent__";

/** The tool name a plugin's predefined expert is exposed as: `agent__<key>__<name>`. */
export function agentToolName(pluginKey: string, agentName: string): string {
  return `${AGENT_TOOL_PREFIX}${sanitizePluginKey(pluginKey)}__${sanitizePluginKey(agentName)}`;
}

/**
 * Serialize with keys sorted at every depth. Arrays keep their order (it's meaningful — setup steps
 * are ordered, A2UI children are positional); only object key order, which carries no meaning, is
 * normalized away.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical manifest, hex. Stable across JSON round-trips and jsonb storage. */
export function hashManifest(manifest: PluginManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex");
}

/** Why a manifest was rejected, with the field at fault. */
export class ManifestError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * Parse + validate an untrusted manifest into the normalized contract, applying the structural
 * limits from `PLUGIN_LIMITS`. Throws `ManifestError` with per-field issues on failure.
 *
 * The `providedTools` field is stripped for any non-builtin source: it declares tools whose
 * implementation lives in OUR code, so an imported bundle claiming to provide one would be claiming
 * a capability it can't back (and would widen an agent's tool allowlist by assertion).
 */
export function normalizeManifest(
  input: unknown,
  opts: { source: "builtin" | "installed" | "local" },
): PluginManifest {
  const parsed = PluginManifest.safeParse(input);
  if (!parsed.success) {
    throw new ManifestError(
      "manifest failed validation",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const manifest = parsed.data;

  if (opts.source !== "builtin" && manifest.providedTools.length > 0) {
    manifest.providedTools = [];
    manifest.ignored = [
      ...manifest.ignored,
      { path: "providedTools", reason: "only builtin plugins may declare platform-provided tools" },
    ];
  }

  assertFileLimits(manifest);
  assertNoDuplicateNames(manifest);
  assertNoPlaintextCredentials(manifest);
  assertNoNetworkTampering(manifest);
  return manifest;
}

/**
 * Character classes present in a string — the cheap proxy for "this looks like a credential".
 */
function charClasses(value: string): number {
  let n = 0;
  if (/[a-z]/.test(value)) n++;
  if (/[A-Z]/.test(value)) n++;
  if (/[0-9]/.test(value)) n++;
  if (/[^a-zA-Z0-9]/.test(value)) n++;
  return n;
}

/**
 * Does this header/env value look like a secret someone pasted in? Deliberately a heuristic: the
 * REAL rule is "credentials belong in the vault and are referenced as `{{secrets.NAME}}`", and this
 * is what makes a manifest that ignores the rule fail loudly at import instead of quietly shipping a
 * live token into `plugins.manifest` (jsonb, unencrypted, readable by every admin path that reads a
 * plugin row).
 *
 * Shaped to accept the things that legitimately appear as literals — `application/json`,
 * `text/event-stream`, `no-cache`, a URL, a version string, anything with whitespace — and to catch
 * the shapes tokens actually have: long, unbroken, mixed-class (`ghp_…`, `sk-ant-…`, base64) or a
 * long hex/base32 run.
 */
export function looksLikeCredential(value: string): boolean {
  if (value.includes("{{secrets.")) return false; // a reference, which is the correct form
  const v = value.trim();
  if (v.length < 20) return false;
  if (/\s/.test(v)) return false; // prose, a UA string, a header list
  if (/^https?:\/\//i.test(v)) return false; // an endpoint, not a credential
  if (/^[a-z0-9]+\/[a-z0-9.+-]+$/i.test(v)) return false; // a media type
  if (/^[0-9.]+$/.test(v)) return false; // a version
  // A long single-case hex/base32 run is a key even though its class count is low.
  if (v.length >= 32 && /^[a-f0-9]{32,}$/i.test(v)) return true;
  return charClasses(v) >= 3;
}

/**
 * A plugin manifest may not carry a plaintext credential. Values in an MCP server's `headers`/`env`
 * must be a `{{secrets.NAME}}` reference or a plainly non-sensitive literal.
 *
 * Why this is a hard error and not a warning: `plugins.manifest` is shared content — the same row
 * serves every tenant that installs it — so a token in there is a token published to everyone who
 * installs the plugin, and it would also be duplicated into `bot_mcp_servers` on materialization.
 * The vault exists precisely so a per-tenant value never lands in shared content.
 */
function assertNoPlaintextCredentials(manifest: PluginManifest): void {
  const issues: { path: string; message: string }[] = [];
  manifest.mcpServers.forEach((server, i) => {
    for (const [field, map] of [
      ["headers", server.headers],
      ["env", server.env],
    ] as const) {
      for (const [key, value] of Object.entries(map ?? {})) {
        if (looksLikeCredential(value)) {
          issues.push({
            path: `mcpServers.${i}.${field}.${key}`,
            message: `looks like a plaintext credential — use {{secrets.NAME}} and store the value in the vault`,
          });
        }
      }
    }
  });
  if (issues.length) throw new ManifestError("manifest carries plaintext credentials", issues);
}

/**
 * Refuse setup steps and MCP commands that reconfigure the box's networking.
 *
 * This is not a general sandbox-escape defense (the box is the model's own trust plane; it can run
 * commands there already). It is protection against a specific, very reachable failure: the box's
 * usefulness depends on the gateway reaching envd and noVNC over its own routes, so a plugin that
 * rewrites `resolv.conf`, adds an `ip route`, or installs `iptables` rules doesn't compromise
 * anything — it silently bricks the desktop and the agent's own transport, and the user sees an
 * unexplained dead box rather than a failed plugin.
 */
function assertNoNetworkTampering(manifest: PluginManifest): void {
  const patterns: { re: RegExp; what: string }[] = [
    { re: /\biptables\b|\bnft\b|\bufw\b/, what: "firewall rules" },
    { re: /\bip\s+route\b|\broute\s+add\b/, what: "routing table" },
    { re: /\/etc\/resolv\.conf|\bresolvectl\b/, what: "DNS resolver config" },
    { re: /\/etc\/hosts\b/, what: "/etc/hosts" },
    { re: /\bsysctl\b/, what: "kernel parameters" },
  ];
  const issues: { path: string; message: string }[] = [];
  const check = (path: string, text: string) => {
    for (const { re, what } of patterns) {
      if (re.test(text)) {
        issues.push({
          path,
          message: `modifies ${what}, which would cut the sandbox off from the gateway`,
        });
      }
    }
  };
  manifest.setupSteps.forEach((step, i) => {
    if (step.kind === "cmd" && typeof step.spec.run === "string") {
      check(`setupSteps.${i}`, step.spec.run);
    }
  });
  manifest.mcpServers.forEach((server, i) => {
    if (server.command)
      check(`mcpServers.${i}.command`, [server.command, ...server.args].join(" "));
  });
  manifest.hooks.forEach((hook, i) => {
    if (hook.do.type === "command") check(`hooks.${i}`, hook.do.command);
  });
  if (issues.length) throw new ManifestError("manifest would reconfigure box networking", issues);
}

/** Carried files are materialized into a small box — cap each one and the bundle as a whole. */
function assertFileLimits(manifest: PluginManifest): void {
  const issues: { path: string; message: string }[] = [];
  let total = 0;
  manifest.files.forEach((file, i) => {
    // base64 carries 3 bytes per 4 chars; utf8 length in bytes, not code points.
    const bytes =
      file.encoding === "base64"
        ? Math.floor((file.content.length * 3) / 4)
        : Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > PLUGIN_LIMITS.fileBytes) {
      issues.push({
        path: `files.${i}`,
        message: `${file.path} is ${bytes} bytes, over the ${PLUGIN_LIMITS.fileBytes} limit`,
      });
    }
  });
  if (total > PLUGIN_LIMITS.totalFileBytes) {
    issues.push({
      path: "files",
      message: `carried files total ${total} bytes, over the ${PLUGIN_LIMITS.totalFileBytes} limit`,
    });
  }
  if (issues.length) throw new ManifestError("manifest exceeds file limits", issues);
}

/**
 * Names must be unique within each kind: they become skill headings, tool names and row keys, so a
 * duplicate silently shadows rather than failing loudly at use time.
 */
function assertNoDuplicateNames(manifest: PluginManifest): void {
  const issues: { path: string; message: string }[] = [];
  const check = (field: string, names: string[]) => {
    const seen = new Set<string>();
    for (const name of names) {
      const norm = name.trim().toLowerCase();
      if (seen.has(norm)) issues.push({ path: field, message: `duplicate name "${name}"` });
      seen.add(norm);
    }
  };
  check(
    "skills",
    manifest.skills.map((s) => s.name),
  );
  check(
    "skills.command",
    manifest.skills.flatMap((s) => (s.command ? [s.command] : [])),
  );
  check(
    "mcpServers",
    manifest.mcpServers.map((s) => s.name),
  );
  check(
    "agents",
    manifest.agents.map((a) => a.name),
  );
  check(
    "ui",
    manifest.ui.map((u) => u.name),
  );
  if (issues.length) throw new ManifestError("manifest has duplicate names", issues);
}
