/**
 * Bootstrap renders a bot's DB definitions into a box: skill glue-files land under
 * /root/.ibot/skills/<id>/, setup steps replay in order (status written back), and box-local MCP
 * servers install→start→health-poll before the agent is told their gateway URL. A single bad
 * definition is recorded and skipped, never fatal.
 */
import type { BotSetupStep, McpServer, Skill } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import {
  type BootstrapTarget,
  bootstrapBot,
  type BotDefs,
  type PluginPayload,
  setupStepCommand,
  skillDir,
  stopBoxMcp,
} from "./bootstrap.js";

const now = "2026-09-15T00:00:00.000Z";

interface Reply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * A target that records every command and answers per a matcher list (unmatched → exit 0).
 *
 * `replies` lets one rule answer successive matches differently, with the last entry repeating. That
 * matters for the health probe: bootstrap checks whether a server is ALREADY up before starting one,
 * so "not up, then healthy after launch" needs two different answers to the same command.
 */
function recordingTarget(
  rules: Array<{ match: RegExp; replies?: Reply[] } & Reply> = [],
): { target: BootstrapTarget; commands: string[] } {
  const commands: string[] = [];
  const seen = new Map<number, number>();
  const target: BootstrapTarget = {
    async run(command: string) {
      commands.push(command);
      const index = rules.findIndex((r) => r.match.test(command));
      if (index < 0) return { exitCode: 0, stdout: "", stderr: "" };
      const rule = rules[index]!;
      const n = seen.get(index) ?? 0;
      seen.set(index, n + 1);
      const reply = rule.replies ? (rule.replies[Math.min(n, rule.replies.length - 1)] ?? {}) : rule;
      return {
        exitCode: reply.exitCode ?? 0,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
      };
    },
    getHost: (port) => `${port}-sbx-1-client-1.sandbox.example`,
  };
  return { target, commands };
}

/** A db stub whose botSetupSteps update() records the patch applied. */
function fakeDb() {
  const updates: Array<{ id?: unknown; patch: Record<string, unknown> }> = [];
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ patch });
        },
      }),
    }),
  } as unknown as import("@i-bot/db").Database;
  return { db, updates };
}

function skill(partial: Partial<Skill> & { id: string }): Skill {
  return {
    scope: "bot",
    ownerRef: "bot-1",
    name: partial.name ?? "s",
    description: "d",
    playbook: "p",
    steps: [],
    assets: [],
    files: partial.files ?? [],
    secretRefs: [],
    version: 1,
    embedding: null,
    createdAt: now,
    ...partial,
  } as Skill;
}

const noSleep = { sleep: async () => {} };

/** A `BotDefs` with everything the case doesn't care about defaulted to empty. */
function defs(partial: Partial<BotDefs> = {}): BotDefs {
  return { skills: [], setupSteps: [], mcpServers: [], plugins: [], ...partial };
}

describe("bootstrapBot — skill files", () => {
  it("renders each skill file under its skill dir, with chmod when a mode is set", async () => {
    const { target, commands } = recordingTarget();
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        skills: [
          skill({
            id: "sk1",
            files: [{ path: "bin/send.sh", content: "#!/bin/sh\necho hi", mode: "755" }],
          }),
        ],
      }),
      noSleep,
    );

    expect(res.skillsRendered).toBe(1);
    const write = commands.find((c) => c.includes("base64 -d"));
    expect(write).toContain(`${skillDir("sk1")}/bin/send.sh`);
    expect(write).toContain("chmod");
    expect(write).toContain("'755'");
  });

  it("skips a skill with no files (nothing to render)", async () => {
    const { target, commands } = recordingTarget();
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({ skills: [skill({ id: "sk1" })] }),
      noSleep,
    );
    expect(res.skillsRendered).toBe(0);
    expect(commands.filter((c) => c.includes("base64 -d"))).toHaveLength(0);
  });

  it("records a skill as not-rendered when a file write fails, without throwing", async () => {
    const { target } = recordingTarget([{ match: /base64 -d/, exitCode: 1, stderr: "disk full" }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({ skills: [skill({ id: "sk1", files: [{ path: "a.sh", content: "x" }] })] }),
      noSleep,
    );
    expect(res.skillsRendered).toBe(0);
  });
});

describe("bootstrapBot — setup steps", () => {
  const step = (
    partial: Partial<BotSetupStep> & {
      id: string;
      kind: BotSetupStep["kind"];
      spec: Record<string, unknown>;
    },
  ): BotSetupStep => ({
    botId: "bot-1",
    ord: 0,
    status: "pending",
    lastError: null,
    createdAt: now,
    appliedAt: null,
    ...partial,
  });

  it("runs each step and writes back applied status", async () => {
    const { target, commands } = recordingTarget();
    const { db, updates } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({ setupSteps: [step({ id: "st1", kind: "apt", spec: { pkg: "jq" } })] }),
      noSleep,
    );
    expect(res.setupStepsApplied).toBe(1);
    expect(commands.some((c) => c.includes("apt-get install") && c.includes("'jq'"))).toBe(true);
    expect(updates[0]?.patch.status).toBe("applied");
    expect(updates[0]?.patch.appliedAt).toBeInstanceOf(Date);
  });

  it("writes back failed status + error when a step exits non-zero", async () => {
    const { target } = recordingTarget([
      { match: /pip3 install/, exitCode: 1, stderr: "no such package" },
    ]);
    const { db, updates } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({ setupSteps: [step({ id: "st1", kind: "pip", spec: { pkg: "nope" } })] }),
      noSleep,
    );
    expect(res.setupStepsFailed).toBe(1);
    expect(updates[0]?.patch.status).toBe("failed");
    expect(updates[0]?.patch.lastError).toMatch(/no such package/);
  });
});

describe("setupStepCommand", () => {
  const step = (kind: BotSetupStep["kind"], spec: Record<string, unknown>): BotSetupStep => ({
    id: "s",
    botId: "b",
    ord: 0,
    kind,
    spec,
    status: "pending",
    lastError: null,
    createdAt: now,
    appliedAt: null,
  });
  it("builds install commands per kind and null for unknown/incomplete", () => {
    expect(setupStepCommand(step("apt", { pkg: "jq" }))).toContain("apt-get install");
    expect(setupStepCommand(step("pip", { pkg: "requests" }))).toContain("pip3 install");
    expect(setupStepCommand(step("npm", { pkg: "cowsay" }))).toContain("npm install -g");
    expect(setupStepCommand(step("cmd", { run: "echo hi" }))).toBe("echo hi");
    expect(setupStepCommand(step("cmd", {}))).toBeNull();
    expect(setupStepCommand(step("download", { url: "https://x/y", dest: "/opt/y" }))).toContain(
      "curl -fsSL",
    );
    expect(setupStepCommand(step("download", { url: "https://x/y" }))).toBeNull();
  });
});

describe("bootstrapBot — box-local MCP", () => {
  const mcp = (
    partial: Partial<McpServer> & { id: string; boxLocal: McpServer["boxLocal"] },
  ): McpServer => ({
    botId: "bot-1",
    name: partial.name ?? "m",
    transport: "http",
    command: null,
    args: null,
    url: null,
    headers: null,
    env: null,
    toolFilter: null,
    enabled: true,
    createdAt: now,
    ...partial,
  });

  it("installs, starts, health-polls, and returns the gateway URL when healthy", async () => {
    // First probe = "nothing listening yet" (the already-up short-circuit must not fire), then 200.
    const { target, commands } = recordingTarget([
      { match: /http_code/, replies: [{ stdout: "000" }, { stdout: "200" }] },
    ]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        mcpServers: [
          mcp({
            id: "m1",
            name: "idx",
            boxLocal: {
              install: ["pip3 install idx-mcp"],
              start: "idx-mcp --port 8931",
              port: 8931,
              health: "/health",
              path: "/mcp",
            },
          }),
        ],
      }),
      noSleep,
    );
    expect(res.boxMcp).toHaveLength(1);
    expect(res.boxMcp[0]).toMatchObject({
      id: "m1",
      name: "idx",
      url: "8931-sbx-1-client-1.sandbox.example",
    });
    expect(commands.some((c) => c.includes("pip3 install idx-mcp"))).toBe(true);
    expect(commands.some((c) => c.includes("setsid idx-mcp --port 8931"))).toBe(true);
  });

  it("gives up (and returns no endpoint) when health never passes", async () => {
    const { target } = recordingTarget([{ match: /http_code/, exitCode: 0, stdout: "000" }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        mcpServers: [
          mcp({
            id: "m1",
            boxLocal: { install: [], start: "x", port: 9000, health: "/health", path: "/mcp" },
          }),
        ],
      }),
      { sleep: async () => {}, healthAttempts: 3 },
    );
    expect(res.boxMcp).toHaveLength(0);
  });

  it("does not start when an install step fails", async () => {
    const { target, commands } = recordingTarget([
      { match: /install-me/, exitCode: 1, stderr: "boom" },
    ]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        mcpServers: [
          mcp({
            id: "m1",
            boxLocal: {
              install: ["install-me"],
              start: "srv",
              port: 9000,
              health: "/health",
              path: "/mcp",
            },
          }),
        ],
      }),
      noSleep,
    );
    expect(res.boxMcp).toHaveLength(0);
    expect(commands.some((c) => c.includes("setsid srv"))).toBe(false); // never reached start
  });

  it("leaves an already-healthy server alone instead of starting a second one", async () => {
    // After a pause/resume the processes are often still alive. Starting a duplicate would fight over
    // the port, and the winner might be the one with a stale environment.
    const { target, commands } = recordingTarget([{ match: /http_code/, stdout: "200" }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        mcpServers: [
          mcp({
            id: "m1",
            boxLocal: {
              install: ["pip3 install x"],
              start: "srv",
              port: 9000,
              health: "/health",
              path: "/mcp",
            },
          }),
        ],
      }),
      noSleep,
    );
    expect(res.boxMcp).toHaveLength(1);
    expect(commands.some((c) => c.includes("setsid srv"))).toBe(false);
    expect(commands.some((c) => c.includes("pip3 install x"))).toBe(false);
  });

  it("launches so that nothing is left holding envd's pipes open", async () => {
    // Live-box regression. `mkdir … && nohup srv &` backgrounds the whole LIST, so bash forks a
    // subshell that waits on the child while holding envd's stdout — envd never sees EOF, the run
    // times out, and a server that actually came up is reported as a failed install. Three things
    // prevent that and each is asserted: the mkdir is its own command, all three fds are redirected,
    // and the launch is setsid'd.
    const { target, commands } = recordingTarget([
      { match: /http_code/, exitCode: 0, stdout: "000" },
      { match: /http_code/, exitCode: 0, stdout: "200" },
    ]);
    const { db } = fakeDb();
    await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        mcpServers: [
          mcp({
            id: "m1",
            boxLocal: {
              install: [],
              start: "srv --port 9000",
              port: 9000,
              health: "/health",
              path: "/mcp",
            },
          }),
        ],
      }),
      noSleep,
    );
    const launch = commands.find((c) => c.includes("setsid srv"));
    expect(launch).toBeDefined();
    expect(launch).toContain("< /dev/null"); // stdin not held
    expect(launch).toContain("2>&1"); // stderr redirected
    expect(launch).toMatch(/> '\/root\/\.ibot\/mcp\/m1\.log'/); // stdout to the log, not the pipe
    expect(launch).not.toContain("&&"); // no list → bash doesn't fork a waiting subshell
    // the mkdir happened, separately
    expect(commands.some((c) => c === "mkdir -p '/root/.ibot/mcp'")).toBe(true);
  });
});

describe("bootstrapBot — plugin directories", () => {
  const plugin = (partial: Partial<PluginPayload> = {}): PluginPayload => ({
    pluginId: "p1",
    key: "@acme/crm",
    version: "1.0.0",
    contentHash: "hash-aaa",
    files: [{ path: "lib/s.js", content: "console.log(1)", encoding: "utf8" }],
    ...partial,
  });

  it("renders the files under the plugin's dir and writes the marker last", async () => {
    const { target, commands } = recordingTarget([{ match: /cat .*ibot-plugin/, exitCode: 1 }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(target, db, "bot-1", defs({ plugins: [plugin()] }), noSleep);

    expect(res.pluginsRendered).toBe(1);
    const write = commands.find((c) => c.includes("lib/s.js"))!;
    expect(write).toContain("/root/.ibot/plugins/acme_crm/lib/s.js");
    // The marker is written AFTER the file, so an interrupted render re-runs instead of looking done.
    const fileAt = commands.findIndex((c) => c.includes("lib/s.js"));
    const markerAt = commands.findIndex((c) => c.includes(".ibot-plugin.json") && c.includes("base64 -d"));
    expect(markerAt).toBeGreaterThan(fileAt);
    // The marker travels base64 like every other write, so decode it to check what it records.
    const payload = /printf %s '([^']+)'/.exec(commands[markerAt]!)![1]!;
    expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toMatchObject({
      key: "@acme/crm",
      version: "1.0.0",
      contentHash: "hash-aaa",
    });
  });

  it("skips the whole plugin when the marker already holds the same content hash", async () => {
    const marker = JSON.stringify({
      key: "@acme/crm",
      version: "1.0.0",
      contentHash: "hash-aaa",
      materializedAt: now,
    });
    const { target, commands } = recordingTarget([{ match: /cat .*ibot-plugin/, stdout: marker }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(target, db, "bot-1", defs({ plugins: [plugin()] }), noSleep);

    expect(res.pluginsSkipped).toBe(1);
    expect(res.pluginsRendered).toBe(0);
    // One `cat` and nothing else — the point of the marker is that an unchanged plugin is ~free.
    expect(commands.some((c) => c.includes("lib/s.js"))).toBe(false);
    expect(commands.some((c) => c.includes("rm -rf"))).toBe(false);
  });

  it("re-renders when the hash differs, preserving data/ while clearing the rest", async () => {
    const stale = JSON.stringify({
      key: "@acme/crm",
      version: "0.9.0",
      contentHash: "hash-OLD",
      materializedAt: now,
    });
    const { target, commands } = recordingTarget([{ match: /cat .*ibot-plugin/, stdout: stale }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(target, db, "bot-1", defs({ plugins: [plugin()] }), noSleep);

    expect(res.pluginsRendered).toBe(1);
    const reset = commands.find((c) => c.includes("find") && c.includes("rm -rf"))!;
    // `data` is pruned from the delete: it's the plugin's own state, not our render output.
    expect(reset).toContain("-name data -prune");
    expect(commands.some((c) => c.includes("lib/s.js"))).toBe(true);
  });

  it("re-renders when the marker is unparseable rather than trusting it", async () => {
    const { target, commands } = recordingTarget([
      { match: /cat .*ibot-plugin/, stdout: "{ truncated" },
    ]);
    const { db } = fakeDb();
    const res = await bootstrapBot(target, db, "bot-1", defs({ plugins: [plugin()] }), noSleep);
    expect(res.pluginsRendered).toBe(1);
    expect(commands.some((c) => c.includes("lib/s.js"))).toBe(true);
  });

  it("decodes a base64 file without re-encoding it", async () => {
    const { target, commands } = recordingTarget([{ match: /cat .*ibot-plugin/, exitCode: 1 }]);
    const { db } = fakeDb();
    const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        plugins: [plugin({ files: [{ path: "logo.png", content: b64, encoding: "base64" }] })],
      }),
      noSleep,
    );
    const write = commands.find((c) => c.includes("logo.png"))!;
    // Double-encoding would write the base64 TEXT into the file instead of the bytes.
    expect(write).toContain(`printf %s '${b64}'`);
  });

  it("refuses a path that would escape the plugin directory", async () => {
    const { target, commands } = recordingTarget([{ match: /cat .*ibot-plugin/, exitCode: 1 }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        plugins: [plugin({ files: [{ path: "../../../etc/cron.d/evil", content: "x", encoding: "utf8" }] })],
      }),
      noSleep,
    );
    expect(res.pluginsFailed).toBe(1);
    expect(commands.some((c) => c.includes("cron.d"))).toBe(false);
  });

  it("records a failure and carries on to the next plugin", async () => {
    const { target } = recordingTarget([
      { match: /cat .*ibot-plugin/, exitCode: 1 },
      { match: /bad\.js/, exitCode: 1, stderr: "disk full" },
    ]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        plugins: [
          plugin({ key: "@acme/bad", files: [{ path: "bad.js", content: "x", encoding: "utf8" }] }),
          plugin({ key: "@acme/good" }),
        ],
      }),
      noSleep,
    );
    expect(res.pluginsFailed).toBe(1);
    expect(res.pluginsRendered).toBe(1);
  });

  it("renders plugin files before running setup steps that might use them", async () => {
    const { target, commands } = recordingTarget([{ match: /cat .*ibot-plugin/, exitCode: 1 }]);
    const { db } = fakeDb();
    await bootstrapBot(
      target,
      db,
      "bot-1",
      defs({
        plugins: [plugin()],
        setupSteps: [
          {
            id: "st1",
            botId: "bot-1",
            ord: 0,
            kind: "cmd",
            spec: { run: "bash /root/.ibot/plugins/acme_crm/install.sh" },
            status: "pending",
            lastError: null,
            createdAt: now,
            appliedAt: null,
          },
        ],
      }),
      noSleep,
    );
    const renderAt = commands.findIndex((c) => c.includes("lib/s.js"));
    const stepAt = commands.findIndex((c) => c.includes("install.sh"));
    expect(renderAt).toBeGreaterThanOrEqual(0);
    expect(stepAt).toBeGreaterThan(renderAt);
  });
});

describe("stopBoxMcp", () => {
  it("kills each bridge by its port, one command per pkill", async () => {
    const { target, commands } = recordingTarget();
    await stopBoxMcp(target, { ports: [47001, 47002] });

    const kills = commands.filter((c) => c.includes("pkill"));
    expect(kills).toHaveLength(2);
    expect(kills[0]).toContain("bot-mcp-bridge.*--port 47001");
    // Each pkill is its OWN command: a combined one matches the shell running it and kills itself.
    for (const kill of kills) {
      expect(kill).not.toContain("&&");
      expect(kill).not.toContain("rm -rf");
      // The bracket class is what stops the pattern matching THIS command's own argv. Live-box
      // evidence: `pgrep -fc 'ibot-mcp-bridge'` returns 1 with no bridge running; bracketed, 0.
      expect(kill).toContain("[i]bot-mcp-bridge");
    }
  });

  it("removes the plugin directory only after the processes are gone", async () => {
    const { target, commands } = recordingTarget();
    await stopBoxMcp(target, { ports: [47001], pluginKey: "@acme/crm" });

    const killAt = commands.findIndex((c) => c.includes("pkill"));
    const rmAt = commands.findIndex((c) => c.includes("rm -rf"));
    // Deleting a running server's cwd out from under it leaves a process in a deleted directory.
    expect(rmAt).toBeGreaterThan(killAt);
    expect(commands[rmAt]).toContain("/root/.ibot/plugins/acme_crm");
  });

  it("does nothing but the directory when there are no ports", async () => {
    const { target, commands } = recordingTarget();
    await stopBoxMcp(target, { ports: [] });
    expect(commands).toHaveLength(0);
  });
});
