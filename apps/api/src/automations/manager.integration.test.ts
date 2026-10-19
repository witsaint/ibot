/** Opt-in local Postgres integration. Creates and migrates a temporary database, then removes it. */
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createServer } from "node:http";
import { runAgentToCompletion } from "../agent/run.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { AutomationDefinition, type MessagePart } from "@i-bot/types";
import {
  automationRuns,
  automations,
  bots,
  conversations,
  createDb,
  messages,
  users,
  type Database,
} from "@i-bot/db";
import { Hono } from "hono";
import { createLogger } from "@i-bot/logger";
import type { AppBindings, AppContext } from "../context.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { RunAgentArgs } from "../agent/run.js";
import { ConversationEventBus } from "../events/bus.js";
import { signWebhook } from "./protocol.js";
import { AutomationManager } from "./manager.js";
import { automationsRoutes, automationWebhookRoutes } from "../routes/automations.js";
const resolution = vi.hoisted(() => ({
  failure: false,
  baseURL: null as string | null,
  commands: [] as string[],
}));
vi.mock("../agent/resolve.js", async (original) => {
  const actual = await original<typeof import("../agent/resolve.js")>();
  return {
    ...actual,
    resolveBotRunConfig: async (_db: unknown, _sandboxes: unknown, botId: string) =>
      resolution.failure
        ? { ok: false, reason: "sandbox_not_ready" }
        : {
            ok: true,
            config: {
              botId,
              handle: {
                id: "fixture-box",
                run: async (command: string) => {
                  resolution.commands.push(command);
                  return { exitCode: 0, stdout: "fixture-ok", stderr: "" };
                },
              },
              credential: { apiKey: "fixture", baseURL: resolution.baseURL },
              modelId: "fixture",
              temperature: null,
              systemPrompt: "",
            },
          },
  };
});
describe.runIf(process.env.AUTOMATION_DB_TEST === "1" && !!process.env.DATABASE_URL)(
  "automation real Postgres integration",
  () => {
    let db: Database;
    let admin: Database;
    let databaseUrl: string;
    const databaseName = `ibot_automation_test_${randomUUID().replaceAll("-", "")}`;
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Automation integration tests require local Postgres");
      admin = createDb(url.toString());
      await admin.$client.unsafe(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      databaseUrl = url.toString();
      const migrationDb = createDb(databaseUrl);
      try {
        await migrate(migrationDb, {
          migrationsFolder: fileURLToPath(
            new URL("../../../../packages/db/drizzle", import.meta.url),
          ),
        });
      } finally {
        await migrationDb.$client.end();
      }
    });
    afterAll(async () => {
      if (admin) {
        try {
          await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally {
          await admin.$client.end();
        }
      }
    });
    let manager: AutomationManager;
    let userId: string;
    let botId: string;
    let conversationId: string;
    let execute: (args: RunAgentArgs) => Promise<void>;
    let callbackCalls: number;
    const held = new Set<string>();
    const human = new Set<string>();
    const sandboxes = {
      runState: (id: string) => ({
        foreground: held.has(id),
        taskCount: 0,
        gui: human.has(id) ? "human" : "free",
        queueDepth: 0,
        awaitingHuman: false,
      }),
      tryAcquireForeground: (id: string) => {
        if (held.has(id)) return false;
        held.add(id);
        return true;
      },
      releaseForeground: (id: string) => held.delete(id),
      boxMcpEndpoints: () => [],
      isHumanInControl: (id: string) => human.has(id),
      acquireGui: async () => Symbol(),
      releaseGui: () => {},
      drainSteer: () => [],
    } as unknown as SandboxManager;
    const build = () =>
      new AutomationManager({
        ctx: {
          db,
          sandboxes,
          events: new ConversationEventBus(),
          logger: createLogger({ name: "automation-test", level: "silent", pretty: false }),
          storage: null,
        },
        apiOrigin: "http://localhost:8787",
        execute: (args) => execute(args),
        deliver: async () => {
          callbackCalls++;
          if (callbackCalls === 1) throw new Error("test failure");
        },
      });
    beforeEach(async () => {
      resolution.failure = false;
      resolution.baseURL = null;
      resolution.commands = [];
      held.clear();
      human.clear();
      callbackCalls = 0;
      db = createDb(databaseUrl);
      userId = `automation-test-${randomUUID()}`;
      await db
        .insert(users)
        .values({ id: userId, name: "Automation test", email: `${userId}@example.invalid` });
      const [bot] = await db
        .insert(bots)
        .values({ ownerId: userId, name: "Automation test" })
        .returning();
      botId = bot!.id;
      const [conv] = await db
        .insert(conversations)
        .values({ botId, title: "Automation test" })
        .returning();
      conversationId = conv!.id;
      execute = async (args) => {
        const id = randomUUID();
        const parts: MessagePart[] = [{ type: "text", text: "检查完成：正常" }];
        await db
          .insert(messages)
          .values({ id, conversationId: args.conversationId, role: "assistant", parts });
        args.onMessagePersisted?.(id, parts);
        args.onSettled?.("done");
      };
      manager = build();
    });
    afterEach(async () => {
      manager.stop();
      await db.delete(users).where(eq(users.id, userId));
      await db.$client.end();
    });
    const create = (extra: Record<string, unknown> = {}) =>
      manager.create(
        userId,
        botId,
        AutomationDefinition.parse({
          name: "检查",
          instruction: "检查并记录状态",
          conversationId,
          trigger: { type: "webhook", conditions: [] },
          enabled: true,
          ...extra,
        }),
      );
    const wait = async (ruleId: string, status: string) => {
      await vi.waitFor(
        async () => {
          expect((await manager.runs(userId, ruleId))[0]?.status).toBe(status);
        },
        { timeout: 3000, interval: 20 },
      );
    };
    const app = () => {
      const a = new Hono<AppBindings>();
      a.use("*", async (c, next) => {
        c.set("userId", userId);
        c.set("ctx", {
          db,
          automations: manager,
          logger: createLogger({ name: "route-test", level: "silent", pretty: false }),
        } as AppContext);
        await next();
      });
      a.route("/api/automations", automationsRoutes);
      a.route("/api/webhooks/automations", automationWebhookRoutes);
      return a;
    };
    it("drives the real AI SDK/tool/persistence path through an Anthropic-compatible HTTP stream", async () => {
      let requests = 0;
      const provider = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          requests++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          const event = (value: Record<string, unknown>) =>
            res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
          event({
            type: "message_start",
            message: {
              id: `msg_${requests}`,
              type: "message",
              role: "assistant",
              model: "fixture",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          });
          if (requests === 1) {
            event({
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "call_fixture",
                name: "run_command",
                input: {},
              },
            });
            event({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ command: "printf fixture-ok" }),
              },
            });
          } else {
            event({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
            event({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "自动化检查完成，命令返回 fixture-ok。" },
            });
          }
          event({ type: "content_block_stop", index: 0 });
          event({
            type: "message_delta",
            delta: { stop_reason: requests === 1 ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 10 },
          });
          event({ type: "message_stop" });
          res.end();
        });
      });
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("provider fixture unavailable");
      resolution.baseURL = `http://127.0.0.1:${address.port}`;
      execute = runAgentToCompletion;
      try {
        const rule = await create({ needsDesktop: false });
        await manager.trigger(rule.id, "manual", "real-sdk");
        await manager.tick();
        await wait(rule.id, "succeeded");
        expect(requests).toBe(2);
        expect(resolution.commands).toEqual(["printf fixture-ok"]);
        const [run] = await manager.runs(userId, rule.id);
        expect(run?.summary).toContain("fixture-ok");
        const message = await db.query.messages.findFirst({
          where: eq(messages.id, run!.resultMessageId!),
        });
        expect(message?.parts.some((p) => p.type === "tool-run_command")).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
    it("deduplicates concurrent signed events; rejects tampering and oversized bodies", async () => {
      const rule = await create();
      const key = await manager.rotateKey(userId, rule.id, "webhook");
      const a = app();
      const body = '{"type":"ticket.created"}';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = {
        "content-type": "application/json",
        "x-ibot-event-id": "event-1",
        "x-ibot-timestamp": timestamp,
        "x-ibot-signature": signWebhook(key.secret, "event-1", timestamp, body),
      };
      const send = (data = body) =>
        a.request(rule.webhookUrl, { method: "POST", headers, body: data });
      expect((await Promise.all([send(), send()])).map((r) => r.status)).toEqual([202, 202]);
      expect((await manager.runs(userId, rule.id)).length).toBe(1);
      expect((await send(body + " ")).status).toBe(401);
      expect((await send("x".repeat(65537))).status).toBe(413);
      manager = build();
      await manager.tick();
      await wait(rule.id, "succeeded");
      expect((await manager.runs(userId, rule.id))[0]?.resultMessageId).toBeTruthy();
    });
    it("resolves tenant ownership and always creates agent rules as drafts", async () => {
      const rule = await create();
      await expect(manager.ownedRule("another-user", rule.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(manager.list("another-user", botId)).rejects.toMatchObject({ status: 404 });
      await expect(
        manager.create(
          userId,
          botId,
          AutomationDefinition.parse({
            name: "x",
            instruction: "x",
            conversationId: randomUUID(),
            trigger: { type: "webhook", conditions: [] },
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        manager.forAgent(userId, randomUUID(), conversationId).pause(rule.id),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        manager.forAgent(userId, randomUUID(), conversationId).runs(rule.id),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (
          await app().request(`/api/automations/${rule.id}/runs/${randomUUID()}/cancel`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
      const draft = await manager.forAgent(userId, botId, conversationId).create({
        name: "草稿",
        instruction: "检查",
        trigger: { type: "schedule", schedule: { kind: "interval", minutes: 5 } },
        needsDesktop: false,
        maxRunsPerDay: 5,
        maxDurationSeconds: 60,
      });
      expect(draft.enabled).toBe(false);
    });
    it("filters events, enforces quotas and cancels queued runs on pause", async () => {
      const rule = await create({
        trigger: {
          type: "webhook",
          conditions: [{ path: "type", operator: "equals", value: "ticket.created" }],
        },
        maxRunsPerDay: 1,
      });
      await manager.rotateKey(userId, rule.id, "webhook");
      const raw = (await db.select().from(automations).where(eq(automations.id, rule.id)))[0]!;
      expect(
        (await manager.trigger(rule.id, "webhook", "ignored", { type: "other" }, raw.webhookKey!))
          .status,
      ).toBe("ignored");
      expect(
        (
          await manager.trigger(
            rule.id,
            "webhook",
            "accepted",
            { type: "ticket.created" },
            raw.webhookKey!,
          )
        ).status,
      ).toBe("queued");
      await expect(manager.trigger(rule.id, "manual", "too-many")).rejects.toMatchObject({
        status: 429,
      });
      await manager.patch(userId, rule.id, { enabled: false });
      expect((await manager.runs(userId, rule.id)).some((r) => r.status === "canceled")).toBe(true);
    });
    it("waits for human control and persists handoff/resume rather than reporting success", async () => {
      const rule = await create();
      human.add(botId);
      await manager.trigger(rule.id, "manual", "manual-1");
      await manager.tick();
      await wait(rule.id, "queued");
      human.delete(botId);
      await db
        .update(automationRuns)
        .set({ availableAt: new Date() })
        .where(eq(automationRuns.automationId, rule.id));
      execute = async (args) => {
        args.onHandoff?.({ reason: "请完成登录", kind: "login" });
        args.onSettled?.("done");
      };
      await manager.tick();
      await wait(rule.id, "waiting");
      const [run] = await manager.runs(userId, rule.id);
      await manager.actOnRun(userId, rule.id, run!.id, "resume", "已登录，继续检查");
      execute = async (args) => {
        expect(args.history.at(-1)?.parts).toEqual([
          { type: "text", text: expect.stringContaining("已登录") },
        ]);
        args.onSettled?.("done");
      };
      await manager.tick();
      await wait(rule.id, "succeeded");
      expect((await manager.runs(userId, rule.id))[0]?.attempts).toBe(2);
    });
    it("marks expired runs interrupted and never silently replays them", async () => {
      const rule = await create();
      const receipt = await manager.trigger(rule.id, "manual", "restart");
      await db
        .update(automationRuns)
        .set({ status: "running", leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(automationRuns.id, receipt.runId));
      await manager.tick();
      await wait(rule.id, "interrupted");
      expect((await manager.list(userId, botId))[0]?.enabled).toBe(false);
      await manager.tick();
      await wait(rule.id, "interrupted");
    });
    it("reports model errors, pauses after three failures, and persists callback retries", async () => {
      const rule = await create({ callbackUrl: "https://example.com/results" });
      await manager.rotateKey(userId, rule.id, "callback");
      execute = async (args) => {
        args.onSettled?.("error");
      };
      await manager.trigger(rule.id, "manual", "failure-1");
      await manager.tick();
      await wait(rule.id, "failed");
      await manager.tick();
      let [run] = await manager.runs(userId, rule.id);
      expect(run?.deliveryStatus).toBe("pending");
      expect(run?.deliveryAttempts).toBe(1);
      await db
        .update(automationRuns)
        .set({ deliveryNextAt: new Date(Date.now() - 1) })
        .where(eq(automationRuns.id, run!.id));
      manager = build();
      await manager.tick();
      [run] = await manager.runs(userId, rule.id);
      expect(run?.deliveryStatus).toBe("delivered");
      await manager.trigger(rule.id, "manual", "failure-2");
      await manager.tick();
      await wait(rule.id, "failed");
      await manager.trigger(rule.id, "manual", "failure-3");
      await manager.tick();
      await wait(rule.id, "failed");
      expect((await manager.list(userId, botId))[0]?.pauseReason).toContain("三次");
    });
    it("coalesces overdue schedules and safely claims work across two workers", async () => {
      const rule = await create({
        trigger: { type: "schedule", schedule: { kind: "interval", minutes: 5 } },
      });
      await db
        .update(automations)
        .set({ nextRunAt: new Date(Date.now() - 3600_000) })
        .where(eq(automations.id, rule.id));
      await Promise.all([manager.tick(), build().tick()]);
      await wait(rule.id, "succeeded");
      expect((await manager.runs(userId, rule.id)).length).toBe(1);
      expect(
        new Date((await manager.list(userId, botId))[0]!.nextRunAt!).getTime(),
      ).toBeGreaterThan(Date.now());
    });
    it("stops a running execution and never calls it successful", async () => {
      const rule = await create();
      execute = async (args) => {
        await new Promise<void>((resolve) =>
          args.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        args.onSettled?.("error");
      };
      const receipt = await manager.trigger(rule.id, "manual", "cancel");
      await manager.tick();
      await wait(rule.id, "running");
      await manager.actOnRun(userId, rule.id, receipt.runId, "cancel");
      await wait(rule.id, "canceled");
      expect(held.size).toBe(0);
    });
    it("records unavailable desktops as waiting without spending a model turn", async () => {
      resolution.failure = true;
      const rule = await create();
      await manager.trigger(rule.id, "manual", "no-desktop");
      await manager.tick();
      await wait(rule.id, "waiting");
      expect((await manager.runs(userId, rule.id))[0]?.error).toContain("启动");
    });
    it("never returns signing keys to list views or agent tools", async () => {
      const rule = await create();
      const key = await manager.rotateKey(userId, rule.id, "webhook");
      const view = JSON.stringify(await manager.forAgent(userId, botId, conversationId).list());
      expect(view).not.toContain(key.secret);
      expect(view).not.toContain("webhookKey");
      expect((await manager.list(userId, botId))[0]?.hasWebhookKey).toBe(true);
    });
  },
);
