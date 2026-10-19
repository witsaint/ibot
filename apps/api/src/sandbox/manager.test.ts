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
import type { SandboxHandle } from "@i-bot/core";
import { installHandle, SandboxManager } from "./manager.js";

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

/**
 * Replacing a bot's handle must stop the superseded one's keepalive.
 *
 * A handle owns a live `setInterval` renew loop, and dropping the map reference does NOT stop it.
 * Two sites in the manager overwrote the handle map directly (a reconnect and a fresh-box create),
 * so a Restart whose reconnect failed left an orphan renewing a box nobody would use again - once
 * every 5 minutes, for the life of the process.
 *
 * It did not read as a leak in the log. An orphan's routing is pinned to the channel its box was
 * created on, so renewing a box since replaced on another channel returns
 * `403 sandbox_gateway_ownership_denied`; measured live, the same key and box id gave `200` on the
 * public channel and `403` on internal. The symptom accused the gateway while the fault was the
 * missing detach, so what these assert is the invariant, not the error string.
 */
function fakeHandle(id: string) {
  const h = {
    providerSandboxId: id,
    detachCount: 0,
    detach() {
      h.detachCount += 1;
    },
  };
  return h as unknown as SandboxHandle & { detachCount: number };
}

describe("installHandle", () => {
  it("detaches the handle it supersedes, so the orphan stops renewing", () => {
    const handles = new Map<string, SandboxHandle>();
    const first = fakeHandle("box-1");
    const second = fakeHandle("box-2");

    installHandle(handles, "bot-1", first);
    expect(first.detachCount).toBe(0); // nothing to supersede on the first install

    installHandle(handles, "bot-1", second);
    expect(first.detachCount).toBe(1); // the replaced box's renew loop is stopped
    expect(second.detachCount).toBe(0); // the live one is untouched
    expect(handles.get("bot-1")).toBe(second);
  });

  it("does NOT detach when the same handle is re-installed", () => {
    // Detaching here would stop the keepalive of the box currently in use, killing it at its TTL.
    const handles = new Map<string, SandboxHandle>();
    const only = fakeHandle("box-1");

    installHandle(handles, "bot-1", only);
    installHandle(handles, "bot-1", only);

    expect(only.detachCount).toBe(0);
    expect(handles.get("bot-1")).toBe(only);
  });

  it("keeps bots independent - installing for one never detaches another's", () => {
    const handles = new Map<string, SandboxHandle>();
    const a = fakeHandle("box-a");
    const b = fakeHandle("box-b");

    installHandle(handles, "bot-a", a);
    installHandle(handles, "bot-b", b);

    expect(a.detachCount).toBe(0);
    expect(b.detachCount).toBe(0);
    expect(handles.size).toBe(2);
  });

  it("detaches once per replacement across a chain of them", () => {
    // A bot that gets restarted repeatedly (the observed pattern: two fresh boxes in 30 minutes)
    // must not accumulate live renew loops.
    const handles = new Map<string, SandboxHandle>();
    const chain = [fakeHandle("b1"), fakeHandle("b2"), fakeHandle("b3")];
    for (const h of chain) installHandle(handles, "bot-1", h);

    expect(chain[0]!.detachCount).toBe(1);
    expect(chain[1]!.detachCount).toBe(1);
    expect(chain[2]!.detachCount).toBe(0); // the current one stays armed
  });
});
