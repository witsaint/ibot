/**
 * Route-level tests for the plugin write endpoints. The router is mounted alone with a fake ctx (db +
 * sandbox manager) and a stubbed `userId`, so these exercise the real Hono handlers — param routing,
 * the error table, the shape the UI reads, and the tenant gate — without a database or a box.
 *
 * What's worth asserting at THIS layer (install.test.ts owns the orchestration, manifest.test.ts the
 * validation):
 *
 *   - `/inspect` stores nothing and runs nothing. It's the entire security story: the user sees every
 *     command before agreeing to it, so a preview that quietly installed would be the worst bug here.
 *   - a bad package is `invalid_manifest` WITH issues, an unreadable directory is `import_failed`.
 *     Collapsing them loses the only signal that tells a user which of the two they need to fix.
 *   - install answers per-bot, plus `missingSecrets` and `ignored` — the three things the response
 *     carries that a boolean would have thrown away.
 *   - PATCH/DELETE resolve the plugin through the CALLER'S OWN installs, so a plugin belonging to
 *     someone else is indistinguishable from one that doesn't exist.
 *   - core is `locked`, not 500 and not a silent no-op.
 *
 * The seam mocked is the pair of modules that touch the world: `import-dir` (reads the filesystem)
 * and `install` (writes rows, drives a box). `inspectManifest` and `summarize` stay real, because the
 * numbers the UI renders are exactly what's being checked.
 */
import { PluginManifest } from "@i-bot/types";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AppBindings } from "../context.js";
import { ManifestError, normalizeManifest } from "../plugins/manifest.js";
import { CORE_PLUGIN_KEY } from "../plugins/resolve.js";

const OWNER = "user-1";
const PLUGIN = "plug-1";

// ---- mocks -------------------------------------------------------------------------------------

/**
 * Only `importPluginDirectory` is stubbed; `inspectManifest` is kept real. The preview's job is to
 * report accurately, so a mocked inspector would make these tests agree with themselves instead of
 * with the code the UI depends on.
 */
const importDirMock = vi.fn();
/** vitest 5 mis-attributes a rejection flowing through a vi.fn as an unhandled error even when the
 * route catches it, so the throwing paths use a plain closure. */
let importImpl: null | ((...a: unknown[]) => Promise<unknown>) = null;
vi.mock("../plugins/import-dir.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    importPluginDirectory: (...a: unknown[]) => (importImpl ? importImpl(...a) : importDirMock(...a)),
  };
});

const installPlugin = vi.fn();
const setPluginBots = vi.fn();
const uninstallPlugin = vi.fn();
vi.mock("../plugins/install.js", () => ({
  installPlugin: (...a: unknown[]) => installPlugin(...a),
  setPluginBots: (...a: unknown[]) => setPluginBots(...a),
  uninstallPlugin: (...a: unknown[]) => uninstallPlugin(...a),
}));

const listInstallsForOwner = vi.fn();
vi.mock("../plugins/repository.js", () => ({
  listInstallsForOwner: (...a: unknown[]) => listInstallsForOwner(...a),
}));

const { pluginsRoutes } = await import("./plugins.js");

// ---- fixtures ----------------------------------------------------------------------------------

function manifest(partial: Partial<z.input<typeof PluginManifest>> = {}): PluginManifest {
  return normalizeManifest(
    { key: "@acme/crm", version: "1.0.0", displayName: "CRM", description: "a crm", ...partial },
    { source: "installed" },
  );
}

/** One install row in the shape `listInstallsForOwner` returns. */
function installRow(over: { key?: string; pluginId?: string; manifest?: PluginManifest } = {}) {
  return {
    install: { id: "inst-1", enabled: true, enabledBots: null, config: {} },
    plugin: {
      id: over.pluginId ?? PLUGIN,
      key: over.key ?? "@acme/crm",
      version: "1.0.0",
      source: "installed",
      displayName: "CRM",
      description: "a crm",
      contentHash: "deadbeef",
      manifest: over.manifest ?? manifest(),
    },
  };
}

/** Records what the route asked of the sandbox manager, so "install touched no box" is checkable. */
let handleCalls: string[] = [];
let registered: Array<{ botId: string; endpoints: unknown }> = [];
let updates: Array<Record<string, unknown>> = [];

function app(opts: { activeBots?: string[] } = {}) {
  const a = new Hono<AppBindings>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("ctx", {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      db: {
        update: () => ({
          set: (v: Record<string, unknown>) => ({ where: async () => updates.push(v) }),
        }),
      },
      sandboxes: {
        async getHandle(botId: string) {
          handleCalls.push(botId);
          if (!(opts.activeBots ?? []).includes(botId)) throw new Error("not active");
          return { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
        },
        registerBoxMcp: (botId: string, endpoints: unknown) => registered.push({ botId, endpoints }),
      },
    } as never);
    await next();
  });
  a.route("/plugins", pluginsRoutes);
  return a;
}

const send = (a: Hono<AppBindings>, method: string, path: string, body?: unknown) =>
  a.request(`http://x/plugins${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const OK_INSTALL = {
  plugin: {
    id: PLUGIN,
    key: "@acme/crm",
    version: "1.0.0",
    displayName: "CRM",
    manifest: manifest(),
  },
  install: { id: "inst-1" },
  missingSecrets: [] as string[],
  bots: [] as unknown[],
};

beforeEach(() => {
  vi.clearAllMocks();
  importImpl = null;
  handleCalls = [];
  registered = [];
  updates = [];
  importDirMock.mockResolvedValue(manifest());
  installPlugin.mockResolvedValue(OK_INSTALL);
  setPluginBots.mockResolvedValue({ bots: [] });
  uninstallPlugin.mockResolvedValue({ bots: [{ botId: "bot-a", stopped: [47001] }] });
  listInstallsForOwner.mockResolvedValue([installRow()]);
});

// ---- inspect -----------------------------------------------------------------------------------

describe("POST /plugins/inspect", () => {
  it("reports every command that would run in the box, and installs nothing", async () => {
    importDirMock.mockResolvedValue(
      manifest({
        setupSteps: [{ kind: "cmd", spec: { run: "apt-get install -y jq" } }],
        mcpServers: [
          { name: "files", transport: "stdio", command: "npx", args: ["-y", "srv-filesystem"] },
        ],
        hooks: [{ on: "bootstrap.done", do: { type: "command", command: "echo hi" } }],
      }),
    );

    const res = await send(app(), "POST", "/inspect", { dir: "/tmp/p" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inspection: { boxCommands: { kind: string; command: string }[] };
    };

    // The consent surface: a setup step, a bridged stdio server, and a hook are all commands that
    // will execute in the user's box, and all three have to be visible before they agree.
    expect(body.inspection.boxCommands.map((b) => b.kind)).toEqual(["setup", "mcp", "hook"]);
    expect(body.inspection.boxCommands[1]?.command).toBe("npx -y srv-filesystem");
    // Nothing was stored and no box was touched — the whole point of a separate endpoint.
    expect(installPlugin).not.toHaveBeenCalled();
    expect(handleCalls).toEqual([]);
  });

  it("passes an overriding key and version through to the importer", async () => {
    await send(app(), "POST", "/inspect", { dir: "/tmp/p", key: "@me/fork", version: "9.9.9" });
    expect(importDirMock).toHaveBeenCalledWith("/tmp/p", { key: "@me/fork", version: "9.9.9" });
  });

  it("omits the overrides entirely when they weren't sent", async () => {
    // Passing `key: undefined` would override the directory's own name with nothing.
    await send(app(), "POST", "/inspect", { dir: "/tmp/p" });
    expect(importDirMock).toHaveBeenCalledWith("/tmp/p", {});
  });

  it("rejects a body with no directory", async () => {
    const res = await send(app(), "POST", "/inspect", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("bad_request");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("answers invalid_manifest WITH the per-field issues", async () => {
    // The user has to know WHICH field to fix; a bare 422 makes a broken package unactionable.
    importImpl = async () => {
      throw new ManifestError("manifest failed validation", [
        { path: "mcpServers.0.command", message: "required for stdio" },
      ]);
    };
    const res = await send(app(), "POST", "/inspect", { dir: "/tmp/p" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "invalid_manifest",
      issues: [{ path: "mcpServers.0.command", message: "required for stdio" }],
    });
  });

  it("separates an unreadable directory from an invalid manifest", async () => {
    // Different fixes: one is a wrong path, the other is a broken package.
    importImpl = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    const res = await send(app(), "POST", "/inspect", { dir: "/nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("import_failed");
    // The underlying reason is carried through: "wrong path" and "unreadable" look the same
    // otherwise, and the message is what tells them apart.
    expect(body.detail).toMatch(/ENOENT/);
  });
});

// ---- install -----------------------------------------------------------------------------------

describe("POST /plugins/install", () => {
  it("returns per-bot status rather than one boolean", async () => {
    // One warm box and one cold box is the normal case, and a single ✓/✗ would misreport one of them.
    installPlugin.mockResolvedValue({
      ...OK_INSTALL,
      bots: [
        { botId: "warm", state: "ready" },
        { botId: "cold", state: "pending", reason: "sandbox not active" },
      ],
    });
    const res = await send(app(), "POST", "/install", { dir: "/tmp/p" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bots: { botId: string; state: string }[] };
    expect(body.bots).toEqual([
      { botId: "warm", state: "ready" },
      { botId: "cold", state: "pending", reason: "sandbox not active" },
    ]);
  });

  it("surfaces missing secrets without failing the install", async () => {
    installPlugin.mockResolvedValue({ ...OK_INSTALL, missingSecrets: ["CRM_TOKEN"] });
    const res = await send(app(), "POST", "/install", { dir: "/tmp/p" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ missingSecrets: ["CRM_TOKEN"] });
  });

  it("reports what the importer refused to carry", async () => {
    // A plugin whose skill was dropped for being oversized is installed but degraded; saying so here
    // is the only place the user finds out.
    importDirMock.mockResolvedValue(manifest());
    const withIgnored = manifest();
    (withIgnored as { ignored: unknown[] }).ignored = [
      { path: "skills/huge/SKILL.md", reason: "exceeds size limit" },
    ];
    importDirMock.mockResolvedValue(withIgnored);
    const res = await send(app(), "POST", "/install", { dir: "/tmp/p" });
    expect(await res.json()).toMatchObject({
      ignored: [{ path: "skills/huge/SKILL.md", reason: "exceeds size limit" }],
    });
  });

  it("counts what the plugin contributes, hidden skills apart", async () => {
    // The card's "3 skills · 1 MCP" line. Hidden skills are real but invisible to the model, so
    // counting them in the same number would overstate the plugin.
    installPlugin.mockResolvedValue({
      ...OK_INSTALL,
      plugin: {
        ...OK_INSTALL.plugin,
        manifest: manifest({
          skills: [
            { name: "visible", description: "d", playbook: "p" },
            { name: "internal", description: "d", playbook: "p", hidden: true },
          ],
          mcpServers: [{ name: "crm", transport: "http", url: "https://crm.example/mcp" }],
        }),
      },
    });
    const res = await send(app(), "POST", "/install", { dir: "/tmp/p" });
    const body = (await res.json()) as { plugin: { summary: Record<string, number> } };
    expect(body.plugin.summary).toMatchObject({ skills: 1, hiddenSkills: 1, mcpServers: 1 });
  });

  it("installs as the session user, never as a caller-supplied owner", async () => {
    // ownerId is the tenant boundary. If it came from the body, an install could be written into
    // someone else's account.
    await send(app(), "POST", "/install", { dir: "/tmp/p", ownerId: "someone-else" });
    expect(installPlugin).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER }));
  });

  it("defaults an omitted bot list to null, meaning every bot now and later", async () => {
    await send(app(), "POST", "/install", { dir: "/tmp/p" });
    expect(installPlugin).toHaveBeenCalledWith(expect.objectContaining({ enabledBots: null }));
  });

  it("forwards an explicit bot list", async () => {
    await send(app(), "POST", "/install", { dir: "/tmp/p", enabledBots: ["bot-a"] });
    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ enabledBots: ["bot-a"] }),
    );
  });

  it("never provisions a box: a cold sandbox resolves to no handle, not a new one", async () => {
    // Installing is not a reason to start a billable box. The route hands `installPlugin` a
    // `handleFor` that swallows the error, so a cold bot becomes `pending`.
    installPlugin.mockImplementation(async (opts: { box: { handleFor(id: string): unknown } }) => {
      const handle = await opts.box.handleFor("cold-bot");
      expect(handle).toBeNull();
      return OK_INSTALL;
    });
    const res = await send(app(), "POST", "/install", { dir: "/tmp/p" });
    expect(res.status).toBe(200);
    expect(handleCalls).toEqual(["cold-bot"]);
  });

  it("gives back the handle for a bot whose box IS live", async () => {
    installPlugin.mockImplementation(async (opts: { box: { handleFor(id: string): unknown } }) => {
      expect(await opts.box.handleFor("bot-a")).not.toBeNull();
      return OK_INSTALL;
    });
    await send(app({ activeBots: ["bot-a"] }), "POST", "/install", { dir: "/tmp/p" });
  });

  it("registers started endpoints with the manager, so the run loop has a URL to dial", async () => {
    const endpoints = [{ id: "m1", name: "files", url: "47001-box.example" }];
    installPlugin.mockImplementation(
      async (opts: { box: { registerBoxMcp(b: string, e: unknown): void } }) => {
        opts.box.registerBoxMcp("bot-a", endpoints);
        return OK_INSTALL;
      },
    );
    await send(app({ activeBots: ["bot-a"] }), "POST", "/install", { dir: "/tmp/p" });
    expect(registered).toEqual([{ botId: "bot-a", endpoints }]);
  });

  it("refuses a package that fails validation, before anything is written", async () => {
    importImpl = async () => {
      throw new ManifestError("bad", [{ path: "key", message: "required" }]);
    };
    const res = await send(app(), "POST", "/install", { dir: "/tmp/p" });
    expect(res.status).toBe(422);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("rejects a body with no directory", async () => {
    const res = await send(app(), "POST", "/install", { enabledBots: ["bot-a"] });
    expect(res.status).toBe(400);
    expect(installPlugin).not.toHaveBeenCalled();
  });
});

// ---- patch -------------------------------------------------------------------------------------

describe("PATCH /plugins/:pluginId", () => {
  it("retargets the bots and reports what changed in the box", async () => {
    setPluginBots.mockResolvedValue({ bots: [{ botId: "bot-b", state: "ready" }] });
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabledBots: ["bot-b"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      enabledBots: ["bot-b"],
      bots: [{ botId: "bot-b", state: "ready" }],
    });
    expect(setPluginBots).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, pluginId: PLUGIN, enabledBots: ["bot-b"] }),
    );
  });

  it("treats an explicit null as every bot, and still calls the retarget", async () => {
    // `null` is meaningful state, not an absent field: it's what makes a bot created tomorrow
    // inherit the plugin. Skipping the call for null would silently drop that change.
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabledBots: null });
    expect(res.status).toBe(200);
    expect(setPluginBots).toHaveBeenCalledWith(expect.objectContaining({ enabledBots: null }));
  });

  it("flips enabled without touching the bot set", async () => {
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabled: false });
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ enabled: false }]);
    expect(setPluginBots).not.toHaveBeenCalled();
  });

  it("echoes the stored values back for fields the caller didn't send", async () => {
    // The UI re-renders the row from this response; inventing a default would flip a toggle the
    // user never touched.
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabledBots: ["bot-b"] });
    expect(await res.json()).toMatchObject({ enabled: true, enabledBots: ["bot-b"] });
  });

  it("refuses to disable core", async () => {
    // Core carries the nine primitives' declarations; a bot without it has no tools at all.
    listInstallsForOwner.mockResolvedValue([installRow({ key: CORE_PLUGIN_KEY })]);
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "locked" });
    expect(updates).toEqual([]);
  });

  it("still lets core be retargeted to specific bots", async () => {
    // Only `enabled: false` is the dangerous edit; choosing which bots get it is not.
    listInstallsForOwner.mockResolvedValue([installRow({ key: CORE_PLUGIN_KEY })]);
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabledBots: ["bot-a"] });
    expect(res.status).toBe(200);
    expect(setPluginBots).toHaveBeenCalledTimes(1);
  });

  it("404s a plugin the caller doesn't have installed", async () => {
    // Resolved through the caller's own installs: not-installed and not-existing are the same
    // answer, so the endpoint never confirms a plugin this user has nothing to do with.
    listInstallsForOwner.mockResolvedValue([installRow({ pluginId: "someone-elses" })]);
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabled: false });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(setPluginBots).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("looks up installs as the session user", async () => {
    await send(app(), "PATCH", `/${PLUGIN}`, { enabled: true });
    expect(listInstallsForOwner).toHaveBeenCalledWith(expect.anything(), OWNER);
  });

  it("rejects a body whose fields are the wrong type", async () => {
    const res = await send(app(), "PATCH", `/${PLUGIN}`, { enabled: "yes" });
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("is a no-op for an empty body", async () => {
    // Both fields optional, so {} validates. Nothing should change.
    const res = await send(app(), "PATCH", `/${PLUGIN}`, {});
    expect(res.status).toBe(200);
    expect(updates).toEqual([]);
    expect(setPluginBots).not.toHaveBeenCalled();
  });
});

// ---- delete ------------------------------------------------------------------------------------

describe("DELETE /plugins/:pluginId", () => {
  it("uninstalls and reports which box processes were stopped", async () => {
    const res = await send(app(), "DELETE", `/${PLUGIN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      bots: [{ botId: "bot-a", stopped: [47001] }],
    });
    expect(uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, pluginId: PLUGIN }),
    );
  });

  it("refuses to uninstall core", async () => {
    listInstallsForOwner.mockResolvedValue([installRow({ key: CORE_PLUGIN_KEY })]);
    const res = await send(app(), "DELETE", `/${PLUGIN}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "locked" });
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("404s a plugin the caller doesn't have installed, without touching anything", async () => {
    listInstallsForOwner.mockResolvedValue([]);
    const res = await send(app(), "DELETE", `/${PLUGIN}`);
    expect(res.status).toBe(404);
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });
});
