/**
 * Read a box's browser-egress verdict.
 *
 * Why this exists as a platform-side function at all: the failure this guards against was not a crash
 * but a box that looked completely healthy while the browser quietly egressed from a datacenter IP for
 * a day. Every signal available at the time agreed it was fine — the desktop was up, `warp-svc` was
 * running, pages loaded, provisioning reported success. The only thing that disagreed was Cloudflare,
 * and it disagreed by rendering nothing.
 *
 * So the invariant is held by `warp-keeper.sh` in the box (verify every 30s, escalate on failure) and
 * PUBLISHED to `EGRESS_STATE_PATH`. This reads it. That split matters: reading a file can't fail for
 * the same reason the egress failed, and it costs one `cat` rather than a network round trip through a
 * tunnel whose health is the very thing in question.
 *
 * Intended use is gating, not display: a task that needs a clean IP (anything behind Cloudflare) can
 * ask first and refuse — or wait for the keeper — instead of running to completion against a page that
 * was never going to show it a challenge widget.
 */
import { EGRESS_STATE_PATH } from "@i-bot/templates";

/** The slice of `SandboxHandle` needed to read the state file. */
export interface EgressTarget {
  run(
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface EgressState {
  /** true only when the keeper's last check saw traffic actually leaving through WARP. */
  ok: boolean;
  /** `ip=… warp=on loc=…` when up, or why it isn't. */
  detail: string;
  /** WARP tunnel protocol in force (`MASQUE` / `WireGuard`) — which one works is path-dependent. */
  protocol: string;
  /** which rung of the ladder last brought it up; "" when it came up on its own. */
  rung: string;
  /** ISO-8601, from the box's clock. */
  checkedAt: string;
  /** consecutive failed verifies; >0 means the keeper is mid-recovery. */
  failures: number;
  /**
   * How this verdict was obtained. `state-file` is the keeper's own; `absent` means the file isn't
   * there (WARP off for this box, or the keeper hasn't completed a first cycle) — which is NOT the
   * same as "dirty", and callers must not treat it as either clean or broken without checking
   * whether the box is even supposed to be proxied.
   */
  source: "state-file" | "absent" | "unreadable";
}

const ABSENT: EgressState = {
  ok: false,
  detail: "no egress state published (WARP off, or the keeper has not completed a cycle yet)",
  protocol: "",
  rung: "",
  checkedAt: "",
  failures: 0,
  source: "absent",
};

/**
 * Read and parse the keeper's verdict. Never throws: a box that can't answer is reported as
 * `unreadable`, because the caller's decision (proceed / wait / refuse) is the same shape either way
 * and an exception here would turn a degraded egress into a failed request.
 *
 * `staleAfterMs` guards the case the file exists but the keeper died: a verdict older than a few
 * cycles is not evidence of anything, so it is downgraded to not-ok rather than trusted. Default is
 * 4× the keeper's 30s interval — long enough to ride out one slow recovery, short enough that a dead
 * keeper doesn't keep vouching for an egress nobody is checking.
 */
export async function readEgressState(
  target: EgressTarget,
  opts: { staleAfterMs?: number; now?: () => number } = {},
): Promise<EgressState> {
  const staleAfterMs = opts.staleAfterMs ?? 120_000;
  const now = opts.now ?? Date.now;

  let stdout: string;
  try {
    const res = await target.run(`cat ${EGRESS_STATE_PATH} 2>/dev/null; exit 0`, {
      timeoutMs: 10_000,
    });
    stdout = res.stdout.trim();
  } catch (err) {
    return { ...ABSENT, detail: `could not read the box: ${(err as Error).message}`, source: "unreadable" };
  }
  if (!stdout) return ABSENT;

  let parsed: Partial<EgressState>;
  try {
    const raw: unknown = JSON.parse(stdout);
    // `JSON.parse("null")` is valid JSON and yields null, and a bare array/string parses too — all of
    // which would throw on property access below. Anything that isn't an object is not a verdict.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ...ABSENT, detail: "egress state file is not a JSON object", source: "unreadable" };
    }
    parsed = raw as Partial<EgressState>;
  } catch {
    // A half-written file shouldn't happen (the keeper writes to .tmp and moves) but a truncated read
    // must not crash a caller that only wanted to know whether to proceed.
    return { ...ABSENT, detail: "egress state file is not valid JSON", source: "unreadable" };
  }

  const state: EgressState = {
    ok: parsed.ok === true,
    detail: typeof parsed.detail === "string" ? parsed.detail : "",
    protocol: typeof parsed.protocol === "string" ? parsed.protocol : "",
    rung: typeof parsed.rung === "string" ? parsed.rung : "",
    checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : "",
    failures: typeof parsed.failures === "number" ? parsed.failures : 0,
    source: "state-file",
  };

  const at = state.checkedAt ? Date.parse(state.checkedAt) : Number.NaN;
  if (state.ok && (Number.isNaN(at) || now() - at > staleAfterMs)) {
    return {
      ...state,
      ok: false,
      detail: `stale verdict (checked ${state.checkedAt || "never"}); the keeper may have died`,
    };
  }
  return state;
}

/**
 * Wait for the egress to be verified clean, for a caller that would rather pause than run dirty. The
 * keeper is already working on it, so this only watches; it does not itself run the ladder.
 *
 * Returns the final state either way — a caller deciding between "proceed", "tell the user the IP
 * isn't clean" and "fail" needs the reason, not just a boolean.
 */
export async function waitForCleanEgress(
  target: EgressTarget,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    /** sleep injection, so a test can drive the loop without real time (and without a frozen clock
     * making the deadline unreachable). */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<EgressState> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();

  // Sequential by design: this polls one box.
  /* eslint-disable no-await-in-loop */
  let state = await readEgressState(target, { now });
  // Elapsed against the loop's own start, and an attempt cap as a second bound: a caller may inject a
  // fixed `now` (tests do), and without the cap that would loop forever.
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)));
  let attempts = 1;
  while (!state.ok && now() - started < timeoutMs && attempts < maxAttempts) {
    await sleep(intervalMs);
    state = await readEgressState(target, { now });
    attempts++;
  }
  /* eslint-enable no-await-in-loop */
  return state;
}
