/**
 * Materialization: the manifest → per-bot rows step, and the stdio→bridge translation that is the
 * whole reason the Claude Code MCP ecosystem works here at all.
 *
 * The assertions that matter are about the SHAPE of the row written for a stdio server, because that
 * shape is a contract with code this module never calls: `gatherBotDefs` reads it, `startBoxMcp`
 * launches it, `makeTransport` dials it. If the translation is wrong, nothing here fails — a tool
 * just never appears in a run.
 */
import { MCP_BRIDGE_PORT_BASE } from "@i-bot/core";
import { PluginManifest } from "@i-bot/types";
import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { pluginDir, rewritePlaceholders, unknownPlaceholders } from "./box-paths.js";
import { normalizeManifest } from "./manifest.js";
import {
  BRIDGE_TOKEN_HEADER,
  bridgeSpec,
  dematerializePluginForBot,
  materializePluginForBot,
  nextBridgePort,
  npxPackage,
} from "./materialize.js";

/** A db stub that records inserts/deletes and answers the port query from a fixed row set. */
function fakeDb(existingBoxLocal: Array<{ port?: number } | null> = []) {
  const inserts: Array<{ table: string; values: unknown[] }> = [];
  const deletes: string[] = [];
  let tableName = "";

  const db = {
    query: {
      botMcpServers: {
        findMany: async () => existingBoxLocal.map((boxLocal) => ({ boxLocal })),
      },
    },
    insert: (table: Table) => ({
      values: async (values: unknown[]) => {
        inserts.push({
          table: getTableName(table),
          values: Array.isArray(values) ? values : [values],
        });
      },
    }),
    delete: (table: Table) => {
      tableName = getTableName(table);
      return {
        where: async () => {
          deletes.push(tableName);
        },
      };
    },
  } as unknown as import("@i-bot/db").Database;

  return { db, inserts, deletes };
}

/**
 * Typed as the manifest's INPUT shape, not `Partial<PluginManifest>`: the latter is the parsed output,
 * where a skill already has `files`/`secretRefs`/`hidden` and so rejects a legitimate literal.
 */
function manifest(partial: Partial<z.input<typeof PluginManifest>> = {}): PluginManifest {
  return normalizeManifest(
    {
      key: "@acme/crm",
      version: "1.0.0",
      displayName: "CRM",
      description: "",
      ...partial,
    },
    { source: "installed" },
  );
}

describe("rewritePlaceholders", () => {
  it("maps a plugin's own path placeholders onto the box layout", () => {
    const out = rewritePlaceholders(
      "node ${CLAUDE_PLUGIN_ROOT}/s.js --data $CLAUDE_PLUGIN_DATA --proj ${CLAUDE_PROJECT_DIR}",
      "@acme/crm",
    );
    expect(out).toBe(
      "node /root/.ibot/plugins/acme_crm/s.js --data /root/.ibot/plugins/acme_crm/data --proj /root/.ibot/plugins/acme_crm",
    );
  });

  it("does not eat a longer variable that merely starts the same", () => {
    // `$CLAUDE_PLUGIN_ROOTS` is a different name; a naive replace would corrupt it.
    expect(rewritePlaceholders("$CLAUDE_PLUGIN_ROOTS", "@acme/crm")).toBe("$CLAUDE_PLUGIN_ROOTS");
  });

  it("names placeholders it doesn't understand so the importer can report them", () => {
    expect(unknownPlaceholders("${CLAUDE_SESSION_ID} and ${CLAUDE_PLUGIN_ROOT}")).toEqual([
      "CLAUDE_SESSION_ID",
    ]);
  });
});

describe("bridgeSpec", () => {
  const spec = bridgeSpec({
    pluginKey: "@acme/crm",
    command: "npx",
    args: ["-y", "@acme/mcp-server", "--flag"],
    port: 47001,
  });

  it("starts the in-box bridge with the server as its child", () => {
    expect(spec.start).toContain("node /opt/ibot-mcp-bridge.js");
    expect(spec.start).toContain("--port 47001");
    // `--` separates the bridge's own flags from the child command, so a child flag can't be eaten.
    expect(spec.start).toContain("-- 'npx' '-y' '@acme/mcp-server' '--flag'");
  });

  it("runs the child in the plugin's own directory", () => {
    expect(spec.start).toContain(`--cwd '${pluginDir("@acme/crm")}'`);
  });

  it("uses the health and path the platform's MCP client expects", () => {
    // These two are what `startBoxMcp` polls and what `makeTransport` appends to the gateway host.
    expect(spec.health).toBe("/health");
    expect(spec.path).toBe("/mcp");
  });

  it("creates the plugin's data dir first", () => {
    // The bridge chdirs into the plugin dir, so it has to exist even for a plugin carrying no files.
    expect(spec.install[0]).toBe(`mkdir -p '${pluginDir("@acme/crm")}/data'`);
  });

  it("pre-warms an npx server's package into the npm cache", () => {
    // Live-box finding: `npx -y <pkg>` downloads on first run, which for a real MCP server is tens of
    // seconds. The bridge is listening the whole time while its child isn't reading stdin yet, so the
    // first tool call lands on a server that can't answer. Fetching at INSTALL time moves that wait
    // to where the user is already waiting.
    expect(spec.install).toContain("npm cache add '@acme/mcp-server' > /dev/null 2>&1 || true");
  });

  it("never lets a failed pre-warm fail the install", () => {
    // An offline box or a private registry must degrade to a cold start, not a broken plugin.
    const warm = spec.install.find((c) => c.startsWith("npm cache add"));
    expect(warm).toMatch(/\|\| true$/);
  });

  it("skips the pre-warm for a command that isn't npx", () => {
    const local = bridgeSpec({
      pluginKey: "k",
      command: "/usr/bin/my-server",
      args: ["--stdio"],
      port: 47003,
    });
    expect(local.install.some((c) => c.includes("npm cache add"))).toBe(false);
  });

  it("quotes a command containing shell metacharacters", () => {
    const risky = bridgeSpec({
      pluginKey: "k",
      command: "sh",
      args: ["-c", "echo $(whoami); rm -rf /"],
      port: 47002,
    });
    // The args are single-quoted, so the box's shell passes them to the bridge as literal argv
    // rather than executing the substitution when the START command runs.
    expect(risky.start).toContain(`'echo $(whoami); rm -rf /'`);
  });
});

describe("npxPackage", () => {
  it("reads the package off a plain npx invocation", () => {
    expect(npxPackage("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/data"])).toBe(
      "@modelcontextprotocol/server-filesystem",
    );
  });

  it("skips flags and the values they consume", () => {
    // `-p` takes the package name as its VALUE, so the first bare arg after it is the binary, and
    // treating it as the package would pre-warm the wrong thing.
    expect(npxPackage("npx", ["-p", "@acme/tools", "acme-mcp", "--stdio"])).toBe("@acme/tools");
    expect(npxPackage("npx", ["--yes", "--quiet", "pkg-a"])).toBe("pkg-a");
  });

  it("accepts an absolute npx path", () => {
    expect(npxPackage("/usr/local/bin/npx", ["-y", "pkg-b"])).toBe("pkg-b");
  });

  it("returns null for anything that isn't npx, or an npx with no package", () => {
    expect(npxPackage("node", ["server.js"])).toBeNull();
    expect(npxPackage("uvx", ["some-server"])).toBeNull();
    expect(npxPackage("npx", ["-y"])).toBeNull();
  });
});

describe("nextBridgePort", () => {
  it("starts at the base for a bot with no bridged servers", async () => {
    const { db } = fakeDb([]);
    expect(await nextBridgePort(db, "bot-1")).toBe(MCP_BRIDGE_PORT_BASE);
  });

  it("counts above the bot's highest existing bridge port", async () => {
    const { db } = fakeDb([{ port: MCP_BRIDGE_PORT_BASE }, { port: MCP_BRIDGE_PORT_BASE + 3 }]);
    expect(await nextBridgePort(db, "bot-1")).toBe(MCP_BRIDGE_PORT_BASE + 4);
  });

  it("ignores a box-local server below the bridge range (a hand-bound one)", async () => {
    const { db } = fakeDb([{ port: 8931 }, null]);
    expect(await nextBridgePort(db, "bot-1")).toBe(MCP_BRIDGE_PORT_BASE);
  });
});

describe("materializePluginForBot", () => {
  it("writes a stdio server as an ordinary box-local HTTP row", async () => {
    const { db, inserts } = fakeDb([]);
    const m = manifest({
      mcpServers: [
        {
          name: "crm",
          transport: "stdio",
          command: "node",
          args: ["/root/.ibot/plugins/acme_crm/s.js"],
          env: { CRM_TOKEN: "{{secrets.CRM_TOKEN}}" },
        },
      ],
    });
    await materializePluginForBot(db, { botId: "bot-1", pluginId: "p1", manifest: m });

    const row = inserts.find((i) => i.table === "bot_mcp_servers")!.values[0] as Record<
      string,
      unknown
    >;
    // The row the runtime sees is box-local HTTP — it has no idea stdio was involved.
    expect(row.transport).toBe("http");
    expect(row.command).toBeNull();
    expect(row.url).toBeNull();
    expect((row.boxLocal as { start: string }).start).toContain("ibot-mcp-bridge.js");
    expect((row.boxLocal as { port: number }).port).toBe(MCP_BRIDGE_PORT_BASE);
    // The secret stays a reference in the row; it's resolved per-tenant when the bridge starts.
    expect(row.env).toEqual({ CRM_TOKEN: "{{secrets.CRM_TOKEN}}" });
    // A token guards the gateway-exposed port, and it is NOT in the start command.
    const token = (row.headers as Record<string, string>)[BRIDGE_TOKEN_HEADER];
    expect(token).toBeTruthy();
    expect((row.boxLocal as { start: string }).start).not.toContain(token!);
  });

  it("gives each stdio server its own port", async () => {
    const { db, inserts } = fakeDb([]);
    const m = manifest({
      mcpServers: [
        { name: "a", transport: "stdio", command: "a", args: [] },
        { name: "b", transport: "stdio", command: "b", args: [] },
      ],
    });
    const result = await materializePluginForBot(db, {
      botId: "bot-1",
      pluginId: "p1",
      manifest: m,
    });
    expect(result.bridgedPorts).toEqual([MCP_BRIDGE_PORT_BASE, MCP_BRIDGE_PORT_BASE + 1]);
    const rows = inserts.find((i) => i.table === "bot_mcp_servers")!.values as Array<{
      headers: Record<string, string>;
    }>;
    // Distinct tokens: one leaked token must not open the other server.
    expect(rows[0]!.headers[BRIDGE_TOKEN_HEADER]).not.toBe(rows[1]!.headers[BRIDGE_TOKEN_HEADER]);
  });

  it("passes a remote server through with no bridge", async () => {
    const { db, inserts } = fakeDb([]);
    const m = manifest({
      mcpServers: [{ name: "r", transport: "http", url: "https://x.test/mcp", args: [] }],
    });
    const result = await materializePluginForBot(db, {
      botId: "bot-1",
      pluginId: "p1",
      manifest: m,
    });
    const row = inserts.find((i) => i.table === "bot_mcp_servers")!.values[0] as Record<
      string,
      unknown
    >;
    expect(row.boxLocal).toBeNull();
    expect(row.url).toBe("https://x.test/mcp");
    expect(result.bridgedPorts).toEqual([]);
  });

  it("writes skills and setup steps stamped with the plugin, keeping step order", async () => {
    const { db, inserts } = fakeDb([]);
    const m = manifest({
      skills: [{ name: "s1", description: "d", playbook: "p" }],
      setupSteps: [
        { kind: "apt", spec: { pkg: "jq" } },
        { kind: "pip", spec: { pkg: "requests" } },
      ],
    });
    await materializePluginForBot(db, { botId: "bot-1", pluginId: "p1", manifest: m });

    const skill = inserts.find((i) => i.table === "skills")!.values[0] as Record<string, unknown>;
    expect(skill).toMatchObject({ scope: "bot", ownerRef: "bot-1", pluginId: "p1", name: "s1" });
    const steps = inserts.find((i) => i.table === "bot_setup_steps")!.values as Array<{
      ord: number;
      pluginId: string;
    }>;
    // `ord` carries declaration order — setup steps are replayed in it.
    expect(steps.map((s) => s.ord)).toEqual([0, 1]);
    expect(steps.every((s) => s.pluginId === "p1")).toBe(true);
  });

  it("clears the plugin's previous rows first, so re-materializing replaces rather than duplicates", async () => {
    const { db, deletes } = fakeDb([]);
    await materializePluginForBot(db, {
      botId: "bot-1",
      pluginId: "p1",
      manifest: manifest({ skills: [{ name: "s", description: "", playbook: "" }] }),
    });
    expect(deletes).toEqual(
      expect.arrayContaining(["skills", "bot_setup_steps", "bot_mcp_servers"]),
    );
  });
});

describe("dematerializePluginForBot", () => {
  it("returns the ports to kill before deleting the rows that hold them", async () => {
    // Reading after the delete would find nothing, and the bridge processes would be orphaned —
    // still listening, still holding their ports, with no row to explain them.
    const { db, deletes } = fakeDb([{ port: 47001 }, { port: 47002 }, null]);
    const { ports } = await dematerializePluginForBot(db, { botId: "bot-1", pluginId: "p1" });
    expect(ports).toEqual([47001, 47002]);
    expect(deletes).toHaveLength(3);
  });
});
