import { describe, expect, it, vi } from "vitest";
import { Keepalive, type Renewable, renewOnce } from "./keepalive.js";

/** A fake instance recording setTimeout calls and returning a controllable endAt. */
function fakeInstance(endAtMsFrom: (calledWithTtl: number) => number): {
  instance: Renewable;
  calls: number[];
} {
  const calls: number[] = [];
  const instance: Renewable = {
    async setTimeout(timeoutMs: number) {
      calls.push(timeoutMs);
    },
    async getInfo() {
      const lastTtl = calls.at(-1) ?? 0;
      return { endAt: new Date(endAtMsFrom(lastTtl)) };
    },
  };
  return { instance, calls };
}

describe("renewOnce", () => {
  it("renews with the requested ttl and reports the granted window from endAt", async () => {
    const NOW = 1_000_000;
    // channel grants exactly what was asked
    const { instance, calls } = fakeInstance((ttl) => NOW + ttl);
    const res = await renewOnce(instance, 3_600_000, () => NOW);
    expect(calls).toEqual([3_600_000]);
    expect(res.grantedMs).toBe(3_600_000);
    expect(res.endAtMs).toBe(NOW + 3_600_000);
  });

  it("surfaces a clamped window (endAt closer than requested)", async () => {
    const NOW = 1_000_000;
    // asked 4h, channel clamps to ~56min
    const { instance } = fakeInstance(() => NOW + 56 * 60_000);
    const res = await renewOnce(instance, 4 * 3_600_000, () => NOW);
    expect(res.grantedMs).toBe(56 * 60_000);
    expect(res.grantedMs).toBeLessThan(4 * 3_600_000);
  });
});

describe("Keepalive", () => {
  it("start() renews on the interval; stop() halts further renews", async () => {
    vi.useFakeTimers();
    try {
      const NOW = 1_000_000;
      const { instance, calls } = fakeInstance((ttl) => NOW + ttl);
      const ka = new Keepalive({
        instance,
        intervalMs: 300_000,
        ttlMs: 3_600_000,
        now: () => NOW,
      });
      ka.start();
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls.length).toBe(2);
      ka.stop();
      await vi.advanceTimersByTimeAsync(900_000);
      expect(calls.length).toBe(2); // no more after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when the granted window is shorter than the renew interval", async () => {
    vi.useFakeTimers();
    try {
      const NOW = 1_000_000;
      // grant only 60s while renewing every 5min → box may die early
      const { instance } = fakeInstance(() => NOW + 60_000);
      const warn = vi.fn();
      const logger = { warn, error: vi.fn() } as unknown as import("@i-bot/logger").Logger;
      const ka = new Keepalive({
        instance,
        intervalMs: 300_000,
        ttlMs: 3_600_000,
        logger,
        now: () => NOW,
      });
      ka.start();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(warn).toHaveBeenCalledOnce();
      ka.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues after a failed renew and reports via onError", async () => {
    vi.useFakeTimers();
    try {
      let throwNext = true;
      const instance: Renewable = {
        async setTimeout() {
          if (throwNext) {
            throwNext = false;
            throw new Error("transient control-plane blip");
          }
        },
        async getInfo() {
          return { endAt: new Date(Date.now() + 3_600_000) };
        },
      };
      const onError = vi.fn();
      const ka = new Keepalive({ instance, intervalMs: 300_000, ttlMs: 3_600_000, onError });
      ka.start();
      await vi.advanceTimersByTimeAsync(300_000); // first tick throws
      expect(onError).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(300_000); // second tick succeeds, no crash
      ka.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
