/**
 * The per-bot steer queue: how a mid-run message reaches the one in-flight run without opening
 * a second concurrent loop. `/steer` enqueues; the run's prepareStep drains at each step
 * boundary. These are pure in-memory registry ops (no db/provider needed) — the injection into
 * the model loop itself is covered by run.ts and exercised end-to-end by the verify script.
 */
import type { Database } from "@i-bot/db";
import type { SandboxConfig } from "@i-bot/core";
import type { Logger } from "@i-bot/logger";
import { describe, expect, it } from "vitest";
import { SandboxManager } from "./manager.js";

function fakeLogger(): Logger {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l };
  return l as unknown as Logger;
}

/** An inert sandbox config — constructing the provider must not touch the network. */
function fakeConfig(): SandboxConfig {
  return {
    apiKey: "k",
    apiUrl: "https://example/sandbox/c/slug",
    channelSlug: "slug",
    defaultPublic: false,
    sdkConnectionOpts: () => ({ apiKey: "k", apiUrl: "https://example/sandbox/c/slug" }),
    channelSlugFor: (pref) => (pref ? "ppio-sandbox-public" : "slug"),
    baseImageFor: (defaultBaseImage, slug) =>
      slug === "ppio-sandbox-public" ? "public-base" : defaultBaseImage,
    warpFor: (slug) => slug === "ppio-sandbox-public",
    bootstrapSdkEnv: () => {},
  };
}

function newManager(): SandboxManager {
  return new SandboxManager({
    db: {} as Database,
    sandboxConfig: fakeConfig(),
    logger: fakeLogger(),
  });
}

describe("SandboxManager steer queue", () => {
  it("drains what was enqueued, in order, then empties", () => {
    const mgr = newManager();
    mgr.enqueueSteer("bot-1", "go to reddit");
    mgr.enqueueSteer("bot-1", "actually, hacker news");

    expect(mgr.drainSteer("bot-1")).toEqual(["go to reddit", "actually, hacker news"]);
    // second drain is empty — a drain clears the queue
    expect(mgr.drainSteer("bot-1")).toEqual([]);
  });

  it("returns [] for a bot with nothing queued (the common per-step path)", () => {
    const mgr = newManager();
    expect(mgr.drainSteer("idle-bot")).toEqual([]);
  });

  it("keeps each bot's steer separate", () => {
    const mgr = newManager();
    mgr.enqueueSteer("bot-a", "for a");
    mgr.enqueueSteer("bot-b", "for b");

    expect(mgr.drainSteer("bot-a")).toEqual(["for a"]);
    expect(mgr.drainSteer("bot-b")).toEqual(["for b"]);
  });

  it("keeps un-drained steer when the foreground turn is released (proactive flush picks it up)", () => {
    const mgr = newManager();
    mgr.tryAcquireForeground("bot-1", "user");
    mgr.enqueueSteer("bot-1", "arrived at the last step");

    mgr.releaseForeground("bot-1"); // turn settled before the queue was drained

    // Unlike the old single-flight slot, release no longer discards the queue — a proactive
    // turn flushes it (a result that raced the final step must not be lost).
    expect(mgr.hasPendingSteer("bot-1")).toBe(true);
    expect(mgr.drainSteer("bot-1")).toEqual(["arrived at the last step"]);
  });

  it("hasPendingSteer is false once drained", () => {
    const mgr = newManager();
    mgr.enqueueSteer("bot-1", "x");
    expect(mgr.hasPendingSteer("bot-1")).toBe(true);
    mgr.drainSteer("bot-1");
    expect(mgr.hasPendingSteer("bot-1")).toBe(false);
  });
});
