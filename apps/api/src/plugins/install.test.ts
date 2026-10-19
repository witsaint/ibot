/**
 * Install/uninstall/retarget: the seam between the two planes.
 *
 * What's worth asserting here is NOT the row shapes (that's materialize.test.ts) and not the SQL
 * (the live script covers that against Postgres). It's the orchestration decisions that are easy to
 * get wrong and expensive when wrong:
 *
 *   - a caller-supplied bot id list is filtered against ownership, so an install can never
 *     materialize into someone else's bot
 *   - a cold sandbox is `pending`, not `failed` — the rows are written and the next bootstrap applies
 *     them, so reporting failure would be a lie that pushes users to re-install
 *   - rows are written before the box is touched, and on uninstall rows are deleted before processes
 *     are stopped, so a failure in the box half never leaves the ledger disagreeing with the box
 *   - a missing secret is reported, not fatal
 *
 * The repository and materializer are mocked: this module's job is deciding WHICH bots get WHAT, and
 * mocking their collaborators is what makes those decisions visible.
 */
import { PluginManifest } from "@i-bot/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { BootstrapTarget, StartedBoxMcp } from "../sandbox/bootstrap.js";
import { normalizeManifest } from "./manifest.js";

// ---- collaborators, mocked ------------------------------------------------------------------

const upsertPlugin = vi.fn();
const ensureInstall = vi.fn();
const listInstallsForOwner = vi.fn();
vi.mock("./repository.js", () => ({
  upsertPlugin: (...a: unknown[]) => upsertPlugin(...a),
  ensureInstall: (...a: unknown[]) => ensureInstall(...a),
  listInstallsForOwner: (...a: unknown[]) => listInstallsForOwner(...a),
}));

const materializePluginForBot = vi.fn();
const dematerializePluginForBot = vi.fn();
vi.mock("./materialize.js", () => ({
  materializePluginForBot: (...a: unknown[]) => materializePluginForBot(...a),
  dematerializePluginForBot: (...a: unknown[]) => dematerializePluginForBot(...a),
}));

const bootstrapBot = vi.fn();
const gatherBotDefs = vi.fn();
const stopBoxMcp = vi.fn();
vi.mock("../sandbox/bootstrap.js", () => ({
  bootstrapBot: (...a: unknown[]) => bootstrapBot(...a),
  gatherBotDefs: (...a: unknown[]) => gatherBotDefs(...a),
  stopBoxMcp: (...a: unknown[]) => stopBoxMcp(...a),
}));

const resolveSecretValues = vi.fn();
vi.mock("../secrets/vault.js", () => ({
  resolveSecretValues: (...a: unknown[]) => resolveSecretValues(...a),
}));

const { installPlugin, setPluginBots, uninstallPlugin } = await import("./install.js");

// ---- fixtures ------------------------------------------------------------------------------

function manifest(partial: Partial<z.input<typeof PluginManifest>> = {}): PluginManifest {
  return normalizeManifest(
    { key: "@acme/crm", version: "1.0.0", displayName: "CRM", description: "", ...partial },
    { source: "installed" },
  );
}

/**
 * A db stub that answers only what this module actually asks of it: the owner's bots, one install
 * row, one plugin row. It deliberately does NOT emulate `where` — a fake that pretended to filter
 * would make a test pass while the real tenant check was missing, which is the one bug class these
 * tests exist for. Ownership here is expressed by WHICH bots the stub returns.
 */
function fakeDb(opts: {
  bots?: string[];
  install?: Record<string, unknown> | null;
  plugin?: Record<string, unknown> | null;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const db = {
    query: {
      bots: { findMany: async () => (opts.bots ?? []).map((id) => ({ id })) },
      pluginInstalls: { findFirst: async () => opts.install ?? null },
      plugins: { findFirst: async () => opts.plugin ?? null },
    },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => updates.push(v) }) }),
    delete: () => ({ where: async () => deletes.push("pluginInstalls") }),
  } as unknown as import("@i-bot/db").Database;
  return { db, updates, deletes };
}

/** A BoxAccess whose bots are live, with a recorder for the endpoints handed back to the manager. */
function liveBox(liveBots: string[]) {
  const registered: Array<{ botId: string; endpoints: StartedBoxMcp[] }> = [];
  const target = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    getHost: (p: number) => `${p}-box.example`,
  } satisfies BootstrapTarget;
  return {
    registered,
    box: {
      handleFor: async (botId: string) => (liveBots.includes(botId) ? target : null),
      registerBoxMcp: (botId: string, endpoints: StartedBoxMcp[]) =>
        registered.push({ botId, endpoints }),
    },
  };
}

const CLEAN_BOOTSTRAP = {
  skillsRendered: 0,
  setupStepsApplied: 0,
  setupStepsFailed: 0,
  pluginsRendered: 1,
  pluginsSkipped: 0,
  pluginsFailed: 0,
  boxMcp: [] as StartedBoxMcp[],
};

beforeEach(() => {
  vi.clearAllMocks();
  upsertPlugin.mockResolvedValue({ id: "plug-1", key: "@acme/crm", version: "1.0.0" });
  ensureInstall.mockImplementation(async (_db: unknown, args: { enabledBots: string[] | null }) => ({
    install: { id: "inst-1", pluginId: "plug-1", enabledBots: args.enabledBots },
  }));
  materializePluginForBot.mockResolvedValue({ skills: 1, mcpServers: 1, setupSteps: 0, bridgedPorts: [47001] });
  dematerializePluginForBot.mockResolvedValue({ ports: [47001] });
  gatherBotDefs.mockResolvedValue({ skills: [], setupSteps: [], mcpServers: [], plugins: [] });
  bootstrapBot.mockResolvedValue(CLEAN_BOOTSTRAP);
  resolveSecretValues.mockResolvedValue({});
});

// ---- which bots -----------------------------------------------------------------------------

describe("installPlugin — which bots it touches", () => {
  it("materializes into every bot the owner has when no list is given", async () => {
    const { db } = fakeDb({ bots: ["bot-a", "bot-b"] });
    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest() });

    expect(materializePluginForBot).toHaveBeenCalledTimes(2);
    expect(res.bots.map((b) => b.botId).sort()).toEqual(["bot-a", "bot-b"]);
  });

  it("drops a bot id the caller doesn't own", async () => {
    // `enabledBots` arrives in a request body. Trusting it would write rows into another tenant's
    // bot — the same class of hole as a missing WHERE on a secrets query.
    const { db } = fakeDb({ bots: ["bot-a"] });
    const res = await installPlugin({
      db,
      ownerId: "user-1",
      manifest: manifest(),
      enabledBots: ["bot-a", "someone-elses-bot"],
    });

    expect(res.bots.map((b) => b.botId)).toEqual(["bot-a"]);
    const touched = materializePluginForBot.mock.calls.map((c) => (c[1] as { botId: string }).botId);
    expect(touched).toEqual(["bot-a"]);
    expect(touched).not.toContain("someone-elses-bot");
  });

  it("installs cleanly for an owner with no bots at all", async () => {
    const { db } = fakeDb({ bots: [] });
    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest() });

    expect(res.bots).toEqual([]);
    expect(materializePluginForBot).not.toHaveBeenCalled();
    expect(res.plugin.id).toBe("plug-1"); // the control-plane half still happened
  });
});

// ---- per-bot state --------------------------------------------------------------------------

describe("installPlugin — per-bot status", () => {
  it("reports ready for a bot whose box bootstrapped, and hands its endpoints to the manager", async () => {
    const { db } = fakeDb({ bots: ["bot-a"] });
    const endpoints = [{ id: "m1", name: "files", url: "47001-box.example" }];
    bootstrapBot.mockResolvedValue({ ...CLEAN_BOOTSTRAP, boxMcp: endpoints });
    const { box, registered } = liveBox(["bot-a"]);

    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest(), box });

    expect(res.bots[0]).toMatchObject({ botId: "bot-a", state: "ready" });
    // Without this the row exists and the process runs, but the run loop has no URL to dial.
    expect(registered).toEqual([{ botId: "bot-a", endpoints }]);
  });

  it("reports pending (not failed) when the sandbox is cold", async () => {
    // The rows ARE written; the box gets them at next start. Calling this a failure would push the
    // user to re-install, and provisioning a box here would be a billable surprise they didn't ask for.
    const { db } = fakeDb({ bots: ["bot-a"] });
    const { box } = liveBox([]); // handleFor → null

    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest(), box });

    expect(res.bots[0]?.state).toBe("pending");
    expect(materializePluginForBot).toHaveBeenCalledTimes(1);
    expect(bootstrapBot).not.toHaveBeenCalled();
  });

  it("reports pending when the caller has no sandbox access at all", async () => {
    const { db } = fakeDb({ bots: ["bot-a"] });
    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest() });
    expect(res.bots[0]).toMatchObject({ state: "pending" });
  });

  it("reports pending when getting a handle throws", async () => {
    const { db } = fakeDb({ bots: ["bot-a"] });
    const res = await installPlugin({
      db,
      ownerId: "user-1",
      manifest: manifest(),
      box: {
        handleFor: async () => {
          throw new Error("gateway timeout");
        },
      },
    });
    expect(res.bots[0]).toMatchObject({ state: "pending", reason: "gateway timeout" });
  });

  it("reports failed when the box couldn't render the plugin's files", async () => {
    const { db } = fakeDb({ bots: ["bot-a"] });
    bootstrapBot.mockResolvedValue({ ...CLEAN_BOOTSTRAP, pluginsRendered: 0, pluginsFailed: 1 });
    const { box } = liveBox(["bot-a"]);

    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest(), box });
    expect(res.bots[0]).toMatchObject({ state: "failed" });
  });

  it("reports failed, with a pointer to the recorded error, when a setup step failed", async () => {
    const { db } = fakeDb({ bots: ["bot-a"] });
    bootstrapBot.mockResolvedValue({ ...CLEAN_BOOTSTRAP, setupStepsFailed: 2 });
    const { box } = liveBox(["bot-a"]);

    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest(), box });
    expect(res.bots[0]?.state).toBe("failed");
    expect(res.bots[0]?.reason).toContain("bot_setup_steps");
  });

  it("gives each bot its own state rather than collapsing to the worst", async () => {
    // Normal situation: one box warm, one cold. A single boolean would misreport one of them.
    const { db } = fakeDb({ bots: ["warm", "cold"] });
    const { box } = liveBox(["warm"]);

    const res = await installPlugin({ db, ownerId: "user-1", manifest: manifest(), box });
    const byBot = Object.fromEntries(res.bots.map((b) => [b.botId, b.state]));
    expect(byBot).toEqual({ warm: "ready", cold: "pending" });
    expect(materializePluginForBot).toHaveBeenCalledTimes(2); // rows for both regardless
  });

  it("writes rows before touching the box", async () => {
    // Reverse order would start a bridge for a server whose row isn't there yet, and `gatherBotDefs`
    // would then not find it.
    const order: string[] = [];
    materializePluginForBot.mockImplementation(async () => {
      order.push("rows");
      return { skills: 0, mcpServers: 1, setupSteps: 0, bridgedPorts: [47001] };
    });
    bootstrapBot.mockImplementation(async () => {
      order.push("box");
      return CLEAN_BOOTSTRAP;
    });
    const { db } = fakeDb({ bots: ["bot-a"] });
    const { box } = liveBox(["bot-a"]);

    await installPlugin({ db, ownerId: "user-1", manifest: manifest(), box });
    expect(order).toEqual(["rows", "box"]);
  });
});

// ---- secrets --------------------------------------------------------------------------------

describe("installPlugin — secrets", () => {
  it("installs and REPORTS a secret the owner hasn't stored", async () => {
    // Refusing would be wrong: the plugin's other capabilities work, and the fix (store the secret)
    // is a thing the user does after installing, in a different screen.
    const { db } = fakeDb({ bots: ["bot-a"] });
    const res = await installPlugin({
      db,
      ownerId: "user-1",
      manifest: manifest({ requiredSecrets: ["CRM_TOKEN"] }),
    });

    expect(res.missingSecrets).toEqual(["CRM_TOKEN"]);
    expect(res.plugin.id).toBe("plug-1"); // installed anyway
  });

  it("finds a secret referenced only inside an MCP server's env", async () => {
    // `requiredSecrets` is author-declared and routinely incomplete; what actually breaks at runtime
    // is an unresolved `{{secrets.X}}` in env/headers, so the preview has to look there too.
    const { db } = fakeDb({ bots: ["bot-a"] });
    const res = await installPlugin({
      db,
      ownerId: "user-1",
      manifest: manifest({
        mcpServers: [
          {
            name: "crm",
            transport: "stdio",
            command: "npx",
            args: ["-y", "crm-mcp"],
            env: { CRM_API_KEY: "{{secrets.ENV_ONLY}}" },
          },
        ],
      }),
    });

    expect(res.missingSecrets).toContain("ENV_ONLY");
  });

  it("does not report a secret the owner has already stored", async () => {
    resolveSecretValues.mockResolvedValue({ CRM_TOKEN: "s3cret" });
    const { db } = fakeDb({ bots: ["bot-a"] });
    const res = await installPlugin({
      db,
      ownerId: "user-1",
      manifest: manifest({ requiredSecrets: ["CRM_TOKEN"] }),
    });
    expect(res.missingSecrets).toEqual([]);
  });
});

// ---- uninstall ------------------------------------------------------------------------------

describe("uninstallPlugin", () => {
  const installed = {
    bots: ["bot-a"],
    install: { id: "inst-1", pluginId: "plug-1", enabledBots: null },
    plugin: { key: "@acme/crm" },
  };

  it("removes rows before stopping processes", async () => {
    // Rows first: if the box step then fails, the next bootstrap has nothing to restart. The reverse
    // order can leave rows whose processes are already dead — a server the UI says is running.
    const order: string[] = [];
    dematerializePluginForBot.mockImplementation(async () => {
      order.push("rows");
      return { ports: [47001] };
    });
    stopBoxMcp.mockImplementation(async () => {
      order.push("box");
    });
    const { db } = fakeDb(installed);
    const { box } = liveBox(["bot-a"]);

    const res = await uninstallPlugin({ db, ownerId: "user-1", pluginId: "plug-1", box });
    expect(order).toEqual(["rows", "box"]);
    expect(res.bots).toEqual([{ botId: "bot-a", stopped: [47001] }]);
  });

  it("passes the ports and the plugin key, so processes stop and the directory goes", async () => {
    const { db } = fakeDb(installed);
    const { box } = liveBox(["bot-a"]);
    await uninstallPlugin({ db, ownerId: "user-1", pluginId: "plug-1", box });

    expect(stopBoxMcp).toHaveBeenCalledWith(
      expect.anything(),
      { ports: [47001], pluginKey: "@acme/crm" },
    );
  });

  it("still removes rows and the install when the box is cold", async () => {
    const { db, deletes } = fakeDb(installed);
    const { box } = liveBox([]); // cold

    await uninstallPlugin({ db, ownerId: "user-1", pluginId: "plug-1", box });
    expect(dematerializePluginForBot).toHaveBeenCalledTimes(1);
    expect(stopBoxMcp).not.toHaveBeenCalled(); // nothing is running to stop
    expect(deletes).toContain("pluginInstalls");
  });

  it("does not let a failing box cleanup strand the uninstall", async () => {
    stopBoxMcp.mockRejectedValue(new Error("box unreachable"));
    const { db, deletes } = fakeDb(installed);
    const { box } = liveBox(["bot-a"]);

    await expect(
      uninstallPlugin({ db, ownerId: "user-1", pluginId: "plug-1", box }),
    ).resolves.toBeDefined();
    expect(deletes).toContain("pluginInstalls"); // the ledger is authoritative and was updated
  });

  it("refuses when the owner doesn't have this plugin installed", async () => {
    const { db } = fakeDb({ bots: ["bot-a"], install: null });
    await expect(
      uninstallPlugin({ db, ownerId: "user-1", pluginId: "plug-1" }),
    ).rejects.toThrow(/not installed/);
  });
});

// ---- retarget -------------------------------------------------------------------------------

describe("setPluginBots", () => {
  beforeEach(() => {
    listInstallsForOwner.mockResolvedValue([
      {
        install: { id: "inst-1", enabledBots: ["bot-a"] },
        plugin: { id: "plug-1", key: "@acme/crm", manifest: manifest() },
      },
    ]);
  });

  it("materializes only the newly-added bot", async () => {
    const { db } = fakeDb({ bots: ["bot-a", "bot-b"] });
    const res = await setPluginBots({
      db,
      ownerId: "user-1",
      pluginId: "plug-1",
      enabledBots: ["bot-a", "bot-b"],
    });

    // bot-a was already materialized; redoing it would reassign its bridge port for no reason.
    const touched = materializePluginForBot.mock.calls.map((c) => (c[1] as { botId: string }).botId);
    expect(touched).toEqual(["bot-b"]);
    expect(res.bots.map((b) => b.botId)).toEqual(["bot-b"]);
  });

  it("dematerializes and stops the box state of a removed bot", async () => {
    const { db } = fakeDb({ bots: ["bot-a", "bot-b"] });
    const { box } = liveBox(["bot-a"]);
    await setPluginBots({
      db,
      ownerId: "user-1",
      pluginId: "plug-1",
      enabledBots: ["bot-b"],
      box,
    });

    const removed = dematerializePluginForBot.mock.calls.map((c) => (c[1] as { botId: string }).botId);
    expect(removed).toEqual(["bot-a"]);
    expect(stopBoxMcp).toHaveBeenCalledWith(expect.anything(), {
      ports: [47001],
      pluginKey: "@acme/crm",
    });
  });

  it("persists the new target list", async () => {
    const { db, updates } = fakeDb({ bots: ["bot-a", "bot-b"] });
    await setPluginBots({ db, ownerId: "user-1", pluginId: "plug-1", enabledBots: ["bot-b"] });
    expect(updates).toEqual([{ enabledBots: ["bot-b"] }]);
  });

  it("treats null as every bot, now and later", async () => {
    // Stored as null rather than an expanded list precisely so a bot created tomorrow is included.
    const { db, updates } = fakeDb({ bots: ["bot-a", "bot-b", "bot-c"] });
    const res = await setPluginBots({
      db,
      ownerId: "user-1",
      pluginId: "plug-1",
      enabledBots: null,
    });

    expect(updates).toEqual([{ enabledBots: null }]);
    expect(res.bots.map((b) => b.botId).sort()).toEqual(["bot-b", "bot-c"]); // bot-a already had it
  });

  it("does nothing when the target set is unchanged", async () => {
    const { db } = fakeDb({ bots: ["bot-a", "bot-b"] });
    const res = await setPluginBots({
      db,
      ownerId: "user-1",
      pluginId: "plug-1",
      enabledBots: ["bot-a"],
    });
    expect(materializePluginForBot).not.toHaveBeenCalled();
    expect(dematerializePluginForBot).not.toHaveBeenCalled();
    expect(res.bots).toEqual([]);
  });

  it("refuses when the plugin isn't installed for this owner", async () => {
    listInstallsForOwner.mockResolvedValue([]);
    const { db } = fakeDb({ bots: ["bot-a"] });
    await expect(
      setPluginBots({ db, ownerId: "user-1", pluginId: "plug-1", enabledBots: null }),
    ).rejects.toThrow(/not installed/);
  });
});
