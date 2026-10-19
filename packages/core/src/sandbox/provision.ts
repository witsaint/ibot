/**
 * Runtime provisioner: turn a freshly-created stock box into an i-bot desktop by
 * executing the `ProvisionPlan` from `@i-bot/templates`. This is deliberately dumb —
 * all the *what* (packages, commands, ports) lives in the plan; this owns only the
 * *how* (run each step against a handle, honour idempotency guards, poll readiness).
 *
 * Why base64 for file writes: `SandboxHandle` intentionally exposes only `run` (not the
 * SDK's `files.write`), so we materialise plan files by piping base64 through `base64 -d`.
 * That keeps the handle surface minimal and the provisioner testable with a fake handle.
 */
import { desktopProvisionPlan, type ProvisionPlan, type ReadinessCheck } from "@i-bot/templates";
import type { Logger } from "@i-bot/logger";
import { TimeoutError, withTimeout } from "./timeout.js";

/** The slice of `SandboxHandle` the provisioner needs (keeps the unit test tiny). */
export interface ProvisionTarget {
  run(
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ProvisionOptions {
  /** overall wall-clock budget for the whole provision (ms). Default 6 min. */
  totalTimeoutMs?: number;
  /** default per-step timeout when the step doesn't set one (ms). Default 60s. */
  stepTimeoutMs?: number;
  /** readiness poll interval (ms). Default 2s. */
  readinessIntervalMs?: number;
  logger?: Logger;
  /** now() injection for deterministic tests. */
  now?: () => number;
  /** sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Route the browser through Cloudflare WARP for a clean egress IP (the public channel's own IP
   * is a datacenter ASN Cloudflare challenges hard). Selects the WARP shape of the default plan;
   * ignored when an explicit `plan` is supplied. See `DesktopProvisionOptions.warp`.
   */
  warp?: boolean;
  /**
   * Extra hosts (each + subdomains) the browser reaches DIRECT even with `warp` on, on top of the
   * built-in CN whitelist. Ignored when `warp` is off or an explicit `plan` is supplied. See
   * `DesktopProvisionOptions.directDomains`.
   */
  directDomains?: readonly string[];
}

const DEFAULTS = {
  totalTimeoutMs: 360_000,
  stepTimeoutMs: 60_000,
  readinessIntervalMs: 2_000,
};

export class ProvisionError extends Error {
  constructor(
    readonly stepId: string,
    readonly detail: string,
  ) {
    super(`provision step "${stepId}" failed: ${detail}`);
    this.name = "ProvisionError";
  }
}

/** Shell-safe single-quote wrap (for embedding base64 — belt & suspenders; base64 is [A-Za-z0-9+/=]). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Provision `target` per the desktop plan (or a supplied plan). Idempotent: a step with
 * a `check` that exits 0 is skipped, so re-running on an already-provisioned box is cheap.
 * Resolves when every readiness probe passes; throws `ProvisionError` on failure/timeout.
 */
export async function provisionDesktop(
  target: ProvisionTarget,
  opts: ProvisionOptions = {},
  plan: ProvisionPlan = desktopProvisionPlan({
    warp: opts.warp ?? false,
    ...(opts.directDomains ? { directDomains: opts.directDomains } : {}),
  }),
): Promise<void> {
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs;
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULTS.stepTimeoutMs;
  const readinessIntervalMs = opts.readinessIntervalMs ?? DEFAULTS.readinessIntervalMs;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.logger;
  const deadline = now() + totalTimeoutMs;

  // The `now() > deadline` checks below are a cheap early-out BETWEEN awaits — they can't
  // fire while a single `target.run` is hung (the loop is stuck inside the await). The real
  // backstop is the outer `withTimeout`: `target.run` bounds only the in-box process, not the
  // client transport, so a severed gateway↔envd stream would hang `run` — and thus the whole
  // provision — forever without it. A real timer guarantees this settles, so the caller's catch
  // (which flips the sandbox row to `kill`) actually runs instead of the UI spinning for hours.
  const runAll = async (): Promise<void> => {
    // Steps and probes below run STRICTLY in order against one box (mirror → apt → launch,
    // each guarded by the previous). Parallelising them would corrupt the sequence or hammer
    // a 1-CPU box, so the sequential awaits are intentional — hence the scoped disables.
    /* eslint-disable no-await-in-loop */

    // 1) materialise files (base64 → base64 -d) before any step that depends on them.
    for (const f of plan.files) {
      const b64 = Buffer.from(f.content, "utf8").toString("base64");
      const res = await target.run(
        `mkdir -p "$(dirname ${shq(f.path)})" && printf %s ${shq(b64)} | base64 -d > ${shq(f.path)}`,
        {
          timeoutMs: stepTimeoutMs,
        },
      );
      if (res.exitCode !== 0) {
        throw new ProvisionError(`write:${f.path}`, res.stderr || `exit ${res.exitCode}`);
      }
    }

    // 2) run steps in order, honouring idempotency guards.
    for (const step of plan.steps) {
      if (now() > deadline) throw new ProvisionError(step.id, "overall provision timeout exceeded");
      if (step.check) {
        const c = await target.run(step.check, { timeoutMs: 15_000 });
        if (c.exitCode === 0) {
          log?.debug({ step: step.id }, "provision step already satisfied, skipping");
          continue;
        }
      }
      log?.info({ step: step.id, label: step.label }, "provision step");
      const res = await target.run(step.run, { timeoutMs: step.timeoutMs ?? stepTimeoutMs });
      // Background-launch steps (nohup … &) return 0 immediately; a real failure surfaces
      // as non-zero here or is caught by the readiness poll below.
      if (res.exitCode !== 0) {
        throw new ProvisionError(
          step.id,
          (res.stderr || res.stdout || `exit ${res.exitCode}`).slice(-400),
        );
      }
    }

    // 3) poll readiness until every probe passes or the overall deadline hits.
    await pollReadiness(target, plan.readiness, {
      deadline,
      intervalMs: readinessIntervalMs,
      now,
      sleep,
      log,
    });
    /* eslint-enable no-await-in-loop */
  };

  try {
    await withTimeout(runAll(), totalTimeoutMs, "provisionDesktop");
  } catch (err) {
    // A hung transport surfaces as TimeoutError — normalise to ProvisionError so callers see one
    // failure type (and the row goes `kill`), never an unbounded hang.
    if (err instanceof TimeoutError) {
      throw new ProvisionError("timeout", `provision exceeded ${totalTimeoutMs}ms wall clock`);
    }
    throw err;
  }
}

async function pollReadiness(
  target: ProvisionTarget,
  checks: ReadinessCheck[],
  ctx: {
    deadline: number;
    intervalMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    log: Logger | undefined;
  },
): Promise<void> {
  const pending = new Set(checks.map((c) => c.id));
  const byId = new Map(checks.map((c) => [c.id, c]));
  // Sequential polling against one box is intentional (see provisionDesktop).
  /* eslint-disable no-await-in-loop */
  while (pending.size > 0) {
    if (ctx.now() > ctx.deadline) {
      throw new ProvisionError(
        "readiness",
        `services not ready before timeout: ${[...pending].join(", ")}`,
      );
    }
    for (const id of [...pending]) {
      const check = byId.get(id);
      if (!check) {
        pending.delete(id);
        continue;
      }
      const res = await target.run(check.command, { timeoutMs: 10_000 });
      if (res.exitCode === 0) {
        ctx.log?.debug({ check: id }, "service ready");
        pending.delete(id);
      }
    }
    if (pending.size > 0) await ctx.sleep(ctx.intervalMs);
  }
  /* eslint-enable no-await-in-loop */
}
