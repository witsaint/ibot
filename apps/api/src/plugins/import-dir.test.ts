/**
 * The importer, against real directories on disk.
 *
 * A fixture per case rather than a mocked fs: the whole job of this module is reading a layout
 * someone else defined, so a test that stubs the reading tests nothing about compatibility. Each case
 * writes the files a real Claude Code plugin would have and asserts what comes out.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importPluginDirectory, inspectManifest, parseFrontmatter } from "./import-dir.js";
import { ManifestError } from "./manifest.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ibot-plugin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a file, creating parents. */
async function file(path: string, content: string): Promise<void> {
  const abs = join(dir, path);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function pluginJson(extra: Record<string, unknown> = {}): Promise<void> {
  await file(
    ".claude-plugin/plugin.json",
    JSON.stringify({ name: "acme-crm", version: "2.1.0", description: "talks to the CRM", ...extra }),
  );
}

describe("parseFrontmatter", () => {
  it("reads scalars, booleans, inline lists and block lists", () => {
    const { data, body } = parseFrontmatter(
      [
        "---",
        "name: deploy",
        'description: "ships the thing"',
        "disable-model-invocation: true",
        "tools: [Bash, Read]",
        "skills:",
        "  - alpha",
        "  - beta",
        "---",
        "body text",
      ].join("\n"),
    );
    expect(data.name).toBe("deploy");
    expect(data.description).toBe("ships the thing");
    expect(data["disable-model-invocation"]).toBe(true);
    expect(data.tools).toEqual(["Bash", "Read"]);
    expect(data.skills).toEqual(["alpha", "beta"]);
    expect(body.trim()).toBe("body text");
  });

  it("returns the whole text as body when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter("just a doc");
    expect(data).toEqual({});
    expect(body).toBe("just a doc");
  });
});

describe("importPluginDirectory", () => {
  it("takes identity from plugin.json", async () => {
    await pluginJson({ displayName: "Acme CRM", homepage: "https://acme.test" });
    const m = await importPluginDirectory(dir);
    expect(m.key).toBe("acme-crm");
    expect(m.version).toBe("2.1.0");
    expect(m.displayName).toBe("Acme CRM");
    expect(m.homepage).toBe("https://acme.test");
  });

  it("falls back to the directory name when plugin.json is missing", async () => {
    await file("skills/thing/SKILL.md", "---\nname: thing\n---\ndo the thing");
    const m = await importPluginDirectory(dir);
    expect(m.key).toBe(dir.split("/").pop()!.toLowerCase());
    expect(m.version).toBe("0.0.0");
  });

  it("reads a skill's frontmatter, body and sibling files", async () => {
    await pluginJson();
    await file(
      "skills/deploy/SKILL.md",
      "---\nname: deploy\ndescription: ship it\n---\n1. run the script\n",
    );
    await file("skills/deploy/run.sh", "#!/bin/sh\necho deploying");
    await file("skills/deploy/notes.md", "extra context");

    const m = await importPluginDirectory(dir);
    expect(m.skills).toHaveLength(1);
    const skill = m.skills[0]!;
    expect(skill.name).toBe("deploy");
    expect(skill.description).toBe("ship it");
    expect(skill.playbook).toBe("1. run the script");
    // Sibling files travel WITH the skill, pathed relative to the skill dir.
    expect(skill.files.map((f) => f.path).sort()).toEqual(["notes.md", "run.sh"]);
    // A script arrives executable — otherwise the first `bash …` in the box fails on permissions.
    expect(skill.files.find((f) => f.path === "run.sh")?.mode).toBe("755");
    // And a skill's own files are NOT duplicated into the plugin's file list.
    expect(m.files.some((f) => f.path.startsWith("skills/"))).toBe(false);
  });

  it("honours disable-model-invocation as hidden", async () => {
    await pluginJson();
    await file(
      "skills/internal/SKILL.md",
      "---\nname: internal\ndisable-model-invocation: true\n---\nmachinery",
    );
    const m = await importPluginDirectory(dir);
    expect(m.skills[0]?.hidden).toBe(true);
  });

  it("maps an agent's tool allowlist onto our tools and drops what has no equivalent", async () => {
    await pluginJson();
    await file(
      "agents/researcher.md",
      [
        "---",
        "name: researcher",
        "description: digs things up",
        "tools: [Bash, Read, WebFetch, KillShell]",
        "model: claude-sonnet-5",
        "---",
        "You research. Files are in ${CLAUDE_PLUGIN_ROOT}/refs.",
      ].join("\n"),
    );
    const m = await importPluginDirectory(dir);
    const agent = m.agents[0]!;
    // Bash+Read both collapse to run_command, so the set dedupes to two entries.
    expect(agent.tools?.sort()).toEqual(["browser_action", "run_command"]);
    expect(agent.model).toBe("claude-sonnet-5");
    // The prompt's path placeholder is rewritten — the model is told a path that exists in the box.
    expect(agent.prompt).toContain("/root/.ibot/plugins/acme-crm/refs");
    expect(agent.prompt).not.toContain("CLAUDE_PLUGIN_ROOT");
    // A dropped tool is reported, never silently ignored.
    expect(m.ignored.some((i) => i.reason.includes("KillShell"))).toBe(true);
  });

  it("omits `tools` entirely when nothing maps, so the agent inherits instead of getting none", async () => {
    await pluginJson();
    await file("agents/a.md", "---\nname: a\ntools: [Unknown1, Unknown2]\n---\nprompt");
    const m = await importPluginDirectory(dir);
    // `tools: []` would mean "no tools at all"; absent means "inherit the run's toolset".
    expect(m.agents[0]?.tools).toBeUndefined();
  });

  it("keeps a stdio MCP as stdio, with its paths rewritten to the box layout", async () => {
    await pluginJson();
    await file(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          crm: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "--data", "$CLAUDE_PLUGIN_DATA"],
            env: { CRM_TOKEN: "{{secrets.CRM_TOKEN}}" },
          },
        },
      }),
    );
    const m = await importPluginDirectory(dir);
    const server = m.mcpServers[0]!;
    expect(server.transport).toBe("stdio");
    expect(server.args[0]).toBe("/root/.ibot/plugins/acme-crm/server.js");
    // The `$NAME` form works too, not just `${NAME}`.
    expect(server.args[2]).toBe("/root/.ibot/plugins/acme-crm/data");
    // A secret stays a REFERENCE in the manifest; resolution happens per-tenant at bootstrap.
    expect(server.env?.CRM_TOKEN).toBe("{{secrets.CRM_TOKEN}}");
  });

  it("passes a remote MCP through unchanged", async () => {
    await pluginJson();
    await file(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          remote: { type: "sse", url: "https://mcp.acme.test/sse", headers: { "x-api": "{{secrets.K}}" } },
        },
      }),
    );
    const m = await importPluginDirectory(dir);
    expect(m.mcpServers[0]).toMatchObject({
      transport: "sse",
      url: "https://mcp.acme.test/sse",
    });
  });

  it("refuses a bundle carrying a plaintext credential", async () => {
    await pluginJson();
    await file(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          crm: { command: "node", args: ["s.js"], env: { TOKEN: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" } },
        },
      }),
    );
    // Hard failure, not a warning: `plugins.manifest` is shared content, so a token in it would be
    // published to every tenant that installs the plugin.
    await expect(importPluginDirectory(dir)).rejects.toThrow(ManifestError);
    await expect(importPluginDirectory(dir)).rejects.toThrow(/plaintext credential/);
  });

  it("allows non-sensitive literals that merely look long", async () => {
    await pluginJson();
    await file(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://mcp.acme.test/mcp",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
          },
        },
      }),
    );
    const m = await importPluginDirectory(dir);
    expect(m.mcpServers[0]?.headers?.["content-type"]).toBe("application/json");
  });

  it("refuses a setup step that would reconfigure the box's networking", async () => {
    await pluginJson({
      // A plugin declaring this doesn't breach anything — it bricks the gateway's route to noVNC and
      // envd, and the user sees a dead box rather than a failed plugin.
      mcpServers: { x: { command: "iptables -F && node s.js", args: [] } },
    });
    await expect(importPluginDirectory(dir)).rejects.toThrow(/networking/);
  });

  it("imports command hooks, converting seconds to ms and capping them", async () => {
    await pluginJson();
    await file(
      "hooks/hooks.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/check.sh", timeout: 120 }],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: "x" }] }],
        },
      }),
    );
    const m = await importPluginDirectory(dir);
    expect(m.hooks).toHaveLength(1);
    expect(m.hooks[0]).toMatchObject({ on: "tool.before", match: "Bash" });
    expect(m.hooks[0]?.do).toMatchObject({
      type: "command",
      command: "/root/.ibot/plugins/acme-crm/check.sh",
      timeoutMs: 30_000, // 120s capped to the hard limit
    });
    expect(m.ignored.some((i) => i.reason.includes("Stop"))).toBe(true);
  });

  it("reports slash commands instead of dropping them silently", async () => {
    await pluginJson();
    await file("commands/deploy.md", "# deploy");
    const m = await importPluginDirectory(dir);
    expect(m.ignored.some((i) => i.path === "commands/deploy.md")).toBe(true);
    expect(m.files.some((f) => f.path === "commands/deploy.md")).toBe(false);
  });

  it("carries remaining files, skips junk directories, and base64s binaries", async () => {
    await pluginJson();
    await file("lib/helper.js", "module.exports = 1;");
    await file("node_modules/dep/index.js", "should not appear");
    await file(".git/config", "should not appear");
    await writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const m = await importPluginDirectory(dir);
    const paths = m.files.map((f) => f.path);
    expect(paths).toContain("lib/helper.js");
    expect(paths).not.toContain("node_modules/dep/index.js");
    expect(paths).not.toContain(".git/config");
    const png = m.files.find((f) => f.path === "logo.png")!;
    expect(png.encoding).toBe("base64");
    expect(Buffer.from(png.content, "base64")[0]).toBe(0x89);
  });

  it("strips providedTools from an imported bundle", async () => {
    await pluginJson({ providedTools: [{ name: "run_command", description: "mine now" }] });
    const m = await importPluginDirectory(dir);
    // An imported bundle claiming a platform tool would be asserting a capability it can't back.
    expect(m.providedTools).toEqual([]);
    expect(m.ignored.some((i) => i.path === "providedTools")).toBe(true);
  });
});

describe("inspectManifest", () => {
  it("lists every command that will run in the box, split from the remote ones", async () => {
    await pluginJson();
    await file("skills/a/SKILL.md", "---\nname: a\ndescription: d\n---\nplay");
    await file(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          local: { command: "npx", args: ["-y", "@acme/mcp"], env: { T: "{{secrets.ACME}}" } },
          remote: { url: "https://mcp.acme.test/mcp" },
        },
      }),
    );
    await file(
      "hooks/hooks.json",
      JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "./fmt.sh" }] }] },
      }),
    );

    const report = inspectManifest(await importPluginDirectory(dir));

    // This list is the security property: nothing runs in a box that wasn't shown here first.
    expect(report.boxCommands.map((c) => c.command)).toEqual(
      expect.arrayContaining(["npx -y @acme/mcp", "./fmt.sh"]),
    );
    expect(report.boxMcp).toEqual([{ name: "local", command: "npx -y @acme/mcp" }]);
    expect(report.remoteMcp).toHaveLength(1);
    expect(report.skills).toEqual([{ name: "a", description: "d", hidden: false, files: 0 }]);
    // A secret referenced but not declared still shows up as needed.
    expect(report.requiredSecrets).toContain("ACME");
  });
});
