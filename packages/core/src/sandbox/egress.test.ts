/**
 * Tests for reading a box's egress verdict.
 *
 * The bug class these exist for is narrow and specific: every cheap signal about egress health is a
 * liar. `warp-cli` reports success for a command it merely accepted, the daemon runs happily with the
 * tunnel down, and pages load fine over the dirty IP. So the ONE thing a caller must never do is
 * conclude "clean" from anything short of a fresh, explicit, positive verdict — and that is what is
 * asserted here, mostly by way of the ways it can fail.
 */
import { describe, expect, it } from "vitest";
import { EGRESS_STATE_PATH } from "@i-bot/templates";
import { readEgressState, waitForCleanEgress } from "./egress.js";

const NOW = Date.parse("2026-09-23T10:00:00Z");
const now = () => NOW;

/** A box that answers `cat` with whatever the keeper supposedly wrote. */
function box(stdout: string, opts: { throws?: string } = {}) {
  const commands: string[] = [];
  return {
    commands,
    target: {
      async run(command: string) {
        commands.push(command);
        if (opts.throws) throw new Error(opts.throws);
        return { exitCode: 0, stdout, stderr: "" };
      },
    },
  };
}

const fresh = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    detail: "ip=2a09:bac5::1 warp=on loc=CN",
    protocol: "MASQUE",
    rung: "protocol-MASQUE",
    checkedAt: "2026-09-23T09:59:45Z",
    failures: 0,
    ...over,
  });

describe("readEgressState", () => {
  it("reports a fresh clean verdict, with the detail a caller can show", async () => {
    // `rung` is worth carrying: "it came back only after the protocol swap" is the difference between
    // a healthy box and one that is quietly flapping.
    const s = await readEgressState(box(fresh()).target, { now });
    expect(s).toMatchObject({
      ok: true,
      protocol: "MASQUE",
      rung: "protocol-MASQUE",
      source: "state-file",
    });
    expect(s.detail).toContain("warp=on");
  });

  it("reads the file rather than probing the network", async () => {
    // Probing through the tunnel to find out whether the tunnel works is circular, and costs a
    // round trip on a box that may be exactly the one that can't make round trips.
    const b = box(fresh());
    await readEgressState(b.target, { now });
    expect(b.commands).toHaveLength(1);
    expect(b.commands[0]).toContain(EGRESS_STATE_PATH);
    expect(b.commands[0]).not.toContain("curl");
  });

  it("does NOT trust a stale verdict, even a positive one", async () => {
    // The keeper writes every 30s. A verdict from ten minutes ago means the keeper died, and a dead
    // keeper is not evidence of a healthy tunnel — it is the absence of evidence.
    const s = await readEgressState(box(fresh({ checkedAt: "2026-09-23T09:48:00Z" })).target, {
      now,
    });
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/stale/);
  });

  it("keeps trusting a verdict inside the freshness window", async () => {
    const s = await readEgressState(box(fresh({ checkedAt: "2026-09-23T09:59:00Z" })).target, {
      now,
    });
    expect(s.ok).toBe(true);
  });

  it("treats a verdict with no timestamp as untrustworthy", async () => {
    const s = await readEgressState(box(fresh({ checkedAt: "" })).target, { now });
    expect(s.ok).toBe(false);
  });

  it("passes a NEGATIVE verdict through verbatim, stale or not", async () => {
    // Only `ok: true` is downgraded by staleness; a "broken" verdict stays broken, and its reason
    // is the useful part.
    const s = await readEgressState(
      box(fresh({ ok: false, detail: "recovery failed; retrying in 60s", failures: 3 })).target,
      { now },
    );
    expect(s).toMatchObject({ ok: false, failures: 3 });
    expect(s.detail).toContain("retrying");
  });

  it("distinguishes 'no verdict' from 'dirty'", async () => {
    // An absent file means WARP is off for this box, or the keeper hasn't finished a first cycle.
    // Reporting that as dirty would make every direct-egress box look broken.
    const s = await readEgressState(box("").target, { now });
    expect(s).toMatchObject({ ok: false, source: "absent" });
    expect(s.detail).toMatch(/no egress state/);
  });

  it("never throws when the box can't be reached", async () => {
    // A caller asking "should I proceed?" must get an answer. Turning a degraded egress into a
    // thrown request would be a worse outcome than the degradation.
    const s = await readEgressState(box("", { throws: "envd stream closed" }).target, { now });
    expect(s).toMatchObject({ ok: false, source: "unreadable" });
    expect(s.detail).toContain("envd stream closed");
  });

  it("survives a truncated file", async () => {
    const s = await readEgressState(box('{"ok":tr').target, { now });
    expect(s).toMatchObject({ ok: false, source: "unreadable" });
  });

  it("does not let a hand-edited file assert cleanliness with a bad shape", async () => {
    // `ok` is compared to `true`, so "true", 1 and null can't sneak through as truthy.
    for (const bad of ['{"ok":"true"}', '{"ok":1}', "{}", "null"]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await readEgressState(box(bad).target, { now })).ok).toBe(false);
    }
  });
});

describe("waitForCleanEgress", () => {
  it("returns as soon as the keeper's verdict is clean", async () => {
    const s = await waitForCleanEgress(box(fresh()).target, { timeoutMs: 1_000, now });
    expect(s.ok).toBe(true);
  });

  it("gives up with the REASON, not just false", async () => {
    // A caller has three sensible responses (proceed / tell the user / fail) and needs the detail to
    // pick between them.
    const s = await waitForCleanEgress(
      box(fresh({ ok: false, detail: "verify failed; recovering (attempt 2)" })).target,
      { timeoutMs: 30, intervalMs: 10, now, sleep: async () => {} },
    );
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("recovering");
  });

  it("polls rather than asking once, and stops instead of spinning forever", async () => {
    const b = box(fresh({ ok: false }));
    await waitForCleanEgress(b.target, {
      timeoutMs: 40,
      intervalMs: 10,
      now,
      sleep: async () => {},
    });
    expect(b.commands.length).toBeGreaterThan(1);
    // Bounded by attempts as well as by the clock, so a caller injecting a fixed `now` (or a box
    // whose clock doesn't move) can't turn this into an infinite loop.
    expect(b.commands.length).toBeLessThanOrEqual(4);
  });
});
