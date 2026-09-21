/**
 * Concurrency semantics the chat routes lean on, all pure in-memory (no DB or provider): the
 * single foreground voice, the capped task registry, and the exclusive GUI lease (FIFO wait +
 * human-takeover priority). These replace the old single-flight run slot — a bot now runs one
 * foreground turn AND up to MAX_CONCURRENT_TASKS detached tasks at once, with only GUI work
 * serialized.
 */
import type { Database } from "@i-bot/db";
import type { SandboxConfig } from "@i-bot/core";
import type { Logger } from "@i-bot/logger";
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_TASKS, SandboxManager } from "./manager.js";

function makeManager(): SandboxManager {
  const config = {
    apiKey: "test",
    apiUrl: "https://example.test",
    channelSlug: undefined,
    sdkConnectionOpts: () => ({}),
    bootstrapSdkEnv: () => {},
  } as unknown as SandboxConfig;
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
  } as unknown as Logger;
  return new SandboxManager({ db: {} as unknown as Database, sandboxConfig: config, logger });
}

describe("SandboxManager foreground voice", () => {
  it("admits one foreground turn and refuses a second until released", () => {
    const mgr = makeManager();
    const bot = "bot-1";

    expect(mgr.foregroundActive(bot)).toBe(false);
    expect(mgr.tryAcquireForeground(bot, "user")).toBe(true);
    expect(mgr.foreground(bot)?.source).toBe("user");

    // a second foreground voice (user or proactive) is refused
    expect(mgr.tryAcquireForeground(bot, "user")).toBe(false);
    expect(mgr.tryAcquireForeground(bot, "proactive")).toBe(false);

    mgr.releaseForeground(bot);
    expect(mgr.foregroundActive(bot)).toBe(false);
    expect(mgr.tryAcquireForeground(bot, "proactive")).toBe(true);
    expect(mgr.foreground(bot)?.source).toBe("proactive");
  });

  it("scopes the foreground per bot", () => {
    const mgr = makeManager();
    expect(mgr.tryAcquireForeground("bot-a", "user")).toBe(true);
    expect(mgr.tryAcquireForeground("bot-b", "user")).toBe(true);
    expect(mgr.foregroundActive("bot-a")).toBe(true);
    expect(mgr.foregroundActive("bot-b")).toBe(true);
  });

  it("releaseForeground is idempotent and does NOT drop queued steer/relay", () => {
    const mgr = makeManager();
    mgr.tryAcquireForeground("bot-1", "user");
    mgr.enqueueSteer("bot-1", "carry me to the next turn");
    mgr.releaseForeground("bot-1");
    expect(() => mgr.releaseForeground("bot-1")).not.toThrow();
    // un-drained relay survives the release so a proactive flush can pick it up
    expect(mgr.hasPendingSteer("bot-1")).toBe(true);
    expect(mgr.drainSteer("bot-1")).toEqual(["carry me to the next turn"]);
  });
});

describe("SandboxManager awaiting-human (handoff pause)", () => {
  it("setAwaitingHuman toggles the flag and the run-state snapshot", () => {
    const mgr = makeManager();
    const bot = "bot-1";
    expect(mgr.awaitingHuman(bot)).toBe(false);
    expect(mgr.runState(bot).awaitingHuman).toBe(false);

    mgr.setAwaitingHuman(bot, true);
    expect(mgr.awaitingHuman(bot)).toBe(true);
    expect(mgr.runState(bot).awaitingHuman).toBe(true);

    mgr.setAwaitingHuman(bot, false);
    expect(mgr.awaitingHuman(bot)).toBe(false);
  });

  it("clears on a fresh foreground acquire from a USER message (the resume)", () => {
    const mgr = makeManager();
    const bot = "bot-1";
    mgr.setAwaitingHuman(bot, true);
    expect(mgr.tryAcquireForeground(bot, "user")).toBe(true);
    expect(mgr.awaitingHuman(bot)).toBe(false);
  });

  it("clears on a PROACTIVE acquire too (guards the stuck-on relay bug)", () => {
    const mgr = makeManager();
    const bot = "bot-1";
    mgr.setAwaitingHuman(bot, true);
    // a proactive relay turn (task result) acquiring the voice must also clear the pause —
    // otherwise it settles without re-blocking and awaitingHuman stays stuck true while idle.
    expect(mgr.tryAcquireForeground(bot, "proactive")).toBe(true);
    expect(mgr.awaitingHuman(bot)).toBe(false);
  });

  it("scopes awaiting-human per bot", () => {
    const mgr = makeManager();
    mgr.setAwaitingHuman("bot-a", true);
    expect(mgr.awaitingHuman("bot-a")).toBe(true);
    expect(mgr.awaitingHuman("bot-b")).toBe(false);
  });
});

describe("SandboxManager task registry (concurrency cap)", () => {
  it("admits up to MAX_CONCURRENT_TASKS, then reports cap", () => {
    const mgr = makeManager();
    const bot = "bot-1";
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
      const res = mgr.tryRegisterTask(bot, {
        jobId: `job-${i}`,
        kind: "subagent",
        needsDesktop: false,
        goal: `task ${i}`,
      });
      expect(res.ok).toBe(true);
    }
    expect(mgr.taskCount(bot)).toBe(MAX_CONCURRENT_TASKS);

    const overflow = mgr.tryRegisterTask(bot, {
      jobId: "job-extra",
      kind: "subagent",
      needsDesktop: false,
      goal: "one too many",
    });
    expect(overflow).toEqual({ ok: false, reason: "cap" });

    // freeing one lets the next in
    mgr.unregisterTask(bot, "job-0");
    expect(mgr.taskCount(bot)).toBe(MAX_CONCURRENT_TASKS - 1);
    expect(
      mgr.tryRegisterTask(bot, {
        jobId: "job-extra",
        kind: "subagent",
        needsDesktop: false,
        goal: "now fits",
      }).ok,
    ).toBe(true);
  });

  it("foreground and tasks are independent — a task doesn't block chat", () => {
    const mgr = makeManager();
    const bot = "bot-1";
    mgr.tryRegisterTask(bot, { jobId: "j", kind: "subagent", needsDesktop: false, goal: "bg" });
    // foreground is still free while a task runs — the whole point
    expect(mgr.foregroundActive(bot)).toBe(false);
    expect(mgr.tryAcquireForeground(bot, "user")).toBe(true);
  });

  it("scopes tasks per bot", () => {
    const mgr = makeManager();
    mgr.tryRegisterTask("bot-a", { jobId: "j", kind: "subagent", needsDesktop: false, goal: "a" });
    expect(mgr.taskCount("bot-a")).toBe(1);
    expect(mgr.taskCount("bot-b")).toBe(0);
  });
});

describe("SandboxManager GUI lease", () => {
  it("grants immediately when free and serializes a second acquirer FIFO", async () => {
    const mgr = makeManager();
    const bot = "bot-1";

    const t1 = await mgr.acquireGui(bot, "run-1");
    expect(mgr.runState(bot).gui).toBe("agent");

    // second acquirer waits — not resolved until the first releases
    let secondResolved = false;
    const p2 = mgr.acquireGui(bot, "run-2").then((tok) => {
      secondResolved = true;
      return tok;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(mgr.runState(bot).queueDepth).toBe(1);

    mgr.releaseGui(bot, t1);
    const t2 = await p2;
    expect(secondResolved).toBe(true);
    expect(mgr.runState(bot).gui).toBe("agent");

    mgr.releaseGui(bot, t2);
    expect(mgr.runState(bot).gui).toBe("free");
  });

  it("releasing with a stale token is a no-op (doesn't free another holder's lease)", async () => {
    const mgr = makeManager();
    const bot = "bot-1";
    const t1 = await mgr.acquireGui(bot, "run-1");
    mgr.releaseGui(bot, Symbol("not-the-token"));
    expect(mgr.runState(bot).gui).toBe("agent"); // still held by run-1
    mgr.releaseGui(bot, t1);
    expect(mgr.runState(bot).gui).toBe("free");
  });

  it("human takeover reports 'human' and rejects queued agent waiters", async () => {
    const mgr = makeManager();
    const bot = "bot-1";
    const t1 = await mgr.acquireGui(bot, "run-1");

    const waiter = mgr.acquireGui(bot, "run-2");
    const rejected = waiter.then(
      () => "resolved",
      (err: Error) => err.name,
    );

    mgr.setHumanControl(bot, true);
    expect(await rejected).toBe("HumanControlError");
    expect(mgr.runState(bot).gui).toBe("human");

    // a fresh acquire while the human holds control is rejected immediately
    const blocked = await mgr.acquireGui(bot, "run-3").then(
      () => "resolved",
      (err: Error) => err.name,
    );
    expect(blocked).toBe("HumanControlError");

    // releasing the (still-held) lease and the human's control returns to free
    mgr.releaseGui(bot, t1);
    mgr.setHumanControl(bot, false);
    expect(mgr.runState(bot).gui).toBe("free");
  });

  it("times out a waiter that never gets the lease", async () => {
    const mgr = makeManager();
    const bot = "bot-1";
    await mgr.acquireGui(bot, "run-1"); // held, never released
    const outcome = await mgr.acquireGui(bot, "run-2", { timeoutMs: 20 }).then(
      () => "resolved",
      (err: Error) => err.name,
    );
    expect(outcome).toBe("GuiLeaseTimeoutError");
    expect(mgr.runState(bot).queueDepth).toBe(0); // timed-out waiter removed
  });
});

describe("SandboxManager teardown", () => {
  it("destroy clears foreground, tasks, and the lease", async () => {
    const mgr = makeManager();
    const bot = "bot-1";
    mgr.tryAcquireForeground(bot, "user");
    mgr.tryRegisterTask(bot, { jobId: "j", kind: "subagent", needsDesktop: false, goal: "x" });
    await mgr.acquireGui(bot, "run-1");
    mgr.setAwaitingHuman(bot, true);

    await mgr.destroy(bot).catch(() => {}); // swallow the DB path (fake db)
    expect(mgr.foregroundActive(bot)).toBe(false);
    expect(mgr.taskCount(bot)).toBe(0);
    expect(mgr.runState(bot).gui).toBe("free");
    expect(mgr.awaitingHuman(bot)).toBe(false);
  });
});
