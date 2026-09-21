/**
 * Bootstrap renders a bot's DB definitions into a box: skill glue-files land under
 * /root/.ibot/skills/<id>/, setup steps replay in order (status written back), and box-local MCP
 * servers install→start→health-poll before the agent is told their gateway URL. A single bad
 * definition is recorded and skipped, never fatal.
 */
import type { BotSetupStep, McpServer, Skill } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import { type BootstrapTarget, bootstrapBot, setupStepCommand, skillDir } from "./bootstrap.js";

const now = "2026-09-15T00:00:00.000Z";

/** A target that records every command and answers per a matcher list (unmatched → exit 0). */
function recordingTarget(
  rules: Array<{ match: RegExp; exitCode?: number; stdout?: string; stderr?: string }> = [],
): { target: BootstrapTarget; commands: string[] } {
  const commands: string[] = [];
  const target: BootstrapTarget = {
    async run(command: string) {
      commands.push(command);
      const rule = rules.find((r) => r.match.test(command));
      return {
        exitCode: rule?.exitCode ?? 0,
        stdout: rule?.stdout ?? "",
        stderr: rule?.stderr ?? "",
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

describe("bootstrapBot — skill files", () => {
  it("renders each skill file under its skill dir, with chmod when a mode is set", async () => {
    const { target, commands } = recordingTarget();
    const { db } = fakeDb();
    const defs = {
      skills: [
        skill({
          id: "sk1",
          files: [{ path: "bin/send.sh", content: "#!/bin/sh\necho hi", mode: "755" }],
        }),
      ],
      setupSteps: [],
      mcpServers: [],
    };
    const res = await bootstrapBot(target, db, "bot-1", defs, noSleep);

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
      { skills: [skill({ id: "sk1" })], setupSteps: [], mcpServers: [] },
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
      {
        skills: [skill({ id: "sk1", files: [{ path: "a.sh", content: "x" }] })],
        setupSteps: [],
        mcpServers: [],
      },
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
      {
        skills: [],
        setupSteps: [step({ id: "st1", kind: "apt", spec: { pkg: "jq" } })],
        mcpServers: [],
      },
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
      {
        skills: [],
        setupSteps: [step({ id: "st1", kind: "pip", spec: { pkg: "nope" } })],
        mcpServers: [],
      },
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
    const { target, commands } = recordingTarget([
      { match: /http_code/, exitCode: 0, stdout: "200" },
    ]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      {
        skills: [],
        setupSteps: [],
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
      },
      noSleep,
    );
    expect(res.boxMcp).toHaveLength(1);
    expect(res.boxMcp[0]).toMatchObject({
      id: "m1",
      name: "idx",
      url: "8931-sbx-1-client-1.sandbox.example",
    });
    expect(commands.some((c) => c.includes("pip3 install idx-mcp"))).toBe(true);
    expect(commands.some((c) => c.includes("nohup idx-mcp --port 8931"))).toBe(true);
  });

  it("gives up (and returns no endpoint) when health never passes", async () => {
    const { target } = recordingTarget([{ match: /http_code/, exitCode: 0, stdout: "000" }]);
    const { db } = fakeDb();
    const res = await bootstrapBot(
      target,
      db,
      "bot-1",
      {
        skills: [],
        setupSteps: [],
        mcpServers: [
          mcp({
            id: "m1",
            boxLocal: { install: [], start: "x", port: 9000, health: "/health", path: "/mcp" },
          }),
        ],
      },
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
      {
        skills: [],
        setupSteps: [],
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
      },
      noSleep,
    );
    expect(res.boxMcp).toHaveLength(0);
    expect(commands.some((c) => c.includes("nohup srv"))).toBe(false); // never reached start
  });
});
