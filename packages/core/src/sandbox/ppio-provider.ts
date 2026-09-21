/**
 * The PPIO-over-AIProxy implementation of `SandboxProvider`. Owns the control-plane
 * dance the rest of the platform must never see: TTL negotiation, real-spec
 * confirmation, the envd-version gate, a runtime reachability probe, keepalive, and
 * runtime provisioning of the desktop stack.
 *
 * Because the gateway disables custom template builds, a box is created from the
 * template's `baseImage` (a stock envd base) and then provisioned at runtime into an
 * i-bot desktop (chromium+CDP, cdp-proxy, x11vnc, noVNC) via `provisionDesktop`. The
 * plan is idempotent, so `connect()` re-runs it to heal a box after the infra's ~24h
 * pause/resume wiped its in-box processes.
 *
 * Tenant isolation is NOT here — it's apps/api's owner-of-bot check before it ever
 * calls this. This provider trusts the request it's given.
 *
 * Every SDK call carries { apiKey, apiUrl } from config and never sets `domain`.
 */
import { getTemplate } from "@i-bot/templates";
import type { Logger } from "@i-bot/logger";
import type { SandboxProviderName } from "@i-bot/types";
import { Sandbox, SandboxNotFoundError } from "ppio-sandbox";
import type {
  ConnectSandboxRequest,
  CreateSandboxRequest,
  SandboxHandle,
  SandboxProvider,
} from "../index.js";
import type { SandboxConfig } from "./config.js";
import { EnvdVersionError, SandboxGoneError, SandboxUnreachableError } from "./errors.js";
import { PpioSandboxHandle } from "./handle.js";
import { Keepalive } from "./keepalive.js";
import { type PpioProviderMeta, parseProviderMeta } from "./meta.js";
import { provisionDesktop } from "./provision.js";
import { withTimeout } from "./timeout.js";

/**
 * Envd version we ASSUME needs the HTTP fallback (below it, envd historically returns no access
 * token → SDK 401). No longer a hard gate: the real test is the runtime probe (`#probe`), because
 * the gateway DOES serve a usable token for some sub-floor channels (verified: envd 0.2.0 codex
 * templates drive fine over the SDK). This floor now only CLASSIFIES a probe failure — a box that
 * fails the probe AND is below it gets the actionable EnvdVersionError; anything else is treated
 * as reachable-or-unreachable on the probe result alone.
 */
const MIN_ENVD_VERSION = "0.5.0";
/** Fallback TTL when the channel rejects a longer request (seconds). */
const FALLBACK_TTL_SECONDS = 3600;
/** Default requested TTL (seconds) — channels may clamp; keepalive self-corrects. */
const DEFAULT_TTL_SECONDS = 3600;
/** Renew at ~1/12 of the granted window, bounded to a sane range (ms). */
const KEEPALIVE_MIN_MS = 60_000;
const KEEPALIVE_MAX_MS = 15 * 60_000;

/**
 * Client-side wall-clock budgets for control-plane / runtime awaits. The SDK's own
 * `timeoutMs` bounds an in-box process, NOT the client transport — a severed gateway↔envd
 * stream hangs these forever without a hard cap. Generous (boot/handshake are legitimately
 * slow) but finite, so a dead transport becomes a throw the caller can turn into `kill`,
 * never an hours-long "provisioning" spinner.
 */
const CREATE_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 60_000;
const GETINFO_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Compare dotted versions; returns true if `v` >= `min`. Enough for x.y.z envd tags. */
export function versionGte(v: string, min: string): boolean {
  const a = v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Renew interval from the granted window, clamped. */
export function keepaliveIntervalMs(grantedSeconds: number): number {
  const target = Math.floor((grantedSeconds * 1000) / 12);
  return Math.min(KEEPALIVE_MAX_MS, Math.max(KEEPALIVE_MIN_MS, target));
}

export interface PpioSandboxProviderOptions {
  config: SandboxConfig;
  logger?: Logger;
  /**
   * Skip runtime provisioning (create/connect return as soon as the box is reachable).
   * For tests or when a future pre-built template already ships the desktop stack.
   */
  skipProvision?: boolean;
}

export class PpioSandboxProvider implements SandboxProvider {
  readonly name: SandboxProviderName = "ppio";
  #config: SandboxConfig;
  #logger: Logger | undefined;
  #skipProvision: boolean;

  constructor(opts: PpioSandboxProviderOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#skipProvision = opts.skipProvision ?? false;
    // mirror the AIProxy key into PPIO_API_KEY/E2B_API_KEY for any env-reading paths
    this.#config.bootstrapSdkEnv();
  }

  async create(req: CreateSandboxRequest): Promise<SandboxHandle> {
    const template = getTemplate(req.templateKey);
    // Gateway blocks custom template builds, so create from the stock base and provision
    // at runtime. (templateId/name is honoured first for the day custom templates return.)
    // Base image is per-channel: the public channel lacks `e2b/base`, so config swaps in the
    // verified public base for a box routed there (see SandboxConfig.baseImageFor).
    const templateRef =
      template.templateId ?? this.#config.baseImageFor(template.baseImage, req.channelSlug);
    // Route this create on the requested channel (per-bot internal/public egress), falling back
    // to the env default when none is given. The chosen slug is stamped into meta below so every
    // later reconnect returns to the same backend.
    const conn = this.#config.sdkConnectionOpts(req.channelSlug);
    const requestedSeconds = DEFAULT_TTL_SECONDS;

    // TTL negotiation: try requested; on an argument/timeout rejection, drop to 3600.
    const metadata = req.longRunning ? { long_running: "true" } : undefined;
    let instance: Sandbox;
    try {
      instance = await withTimeout(
        Sandbox.create(templateRef, {
          ...conn,
          timeoutMs: requestedSeconds * 1000,
          ...(metadata ? { metadata } : {}),
        }),
        CREATE_TIMEOUT_MS,
        "Sandbox.create",
      );
    } catch (err) {
      if (requestedSeconds > FALLBACK_TTL_SECONDS && isTtlRejection(err)) {
        instance = await withTimeout(
          Sandbox.create(templateRef, {
            ...conn,
            timeoutMs: FALLBACK_TTL_SECONDS * 1000,
            ...(metadata ? { metadata } : {}),
          }),
          CREATE_TIMEOUT_MS,
          "Sandbox.create(fallback)",
        );
      } else {
        throw err;
      }
    }

    try {
      // Confirm the REAL spec + window (create-body cpu/mem is silently ignored; GET
      // after create). endAt is the authoritative granted window.
      const info = await withTimeout(instance.getInfo(), GETINFO_TIMEOUT_MS, "getInfo");
      const envdVersion = info.envdVersion ?? "0.0.0";

      const meta: PpioProviderMeta = {
        domain: instance.sandboxDomain,
        envdVersion,
        // Pin the channel this box was created on so reconnect always returns to the same backend,
        // regardless of the bot's toggle or the fleet default later changing. Omitted when the
        // create used the env default (no explicit slug) — connect then falls back to that default.
        ...(req.channelSlug ? { channelSlug: req.channelSlug } : {}),
      };

      // Runtime reachability probe is the REAL gate (not the version number): a trivial command
      // exercises envd + SDK auth end to end. If it fails on a box below the envd floor, that's the
      // known no-token-→-401 mismatch (EnvdVersionError); any other probe failure = unreachable.
      await this.#probe(instance, envdVersion);

      const keepalive = this.#startKeepalive(instance, info.endAt, requestedSeconds);
      const handle = new PpioSandboxHandle({ rowId: req.sandboxRowId, instance, meta, keepalive });

      // Provision the desktop through the handle (idempotent). Keepalive is already
      // running so the ~90s provision can't let the box expire mid-install.
      if (!this.#skipProvision) {
        const t0 = Date.now();
        // WARP follows the channel: a public-channel box egresses from a datacenter IP, so its
        // browser is routed through WARP for the clean IP Cloudflare accepts; internal stays direct.
        const warp = this.#config.warpFor(req.channelSlug);
        this.#logger?.info(
          { rowId: req.sandboxRowId, botId: req.botId, warp },
          "provisioning desktop",
        );
        await provisionDesktop(handle, { warp, ...(this.#logger ? { logger: this.#logger } : {}) });
        this.#logger?.info({ rowId: req.sandboxRowId, ms: Date.now() - t0 }, "desktop provisioned");
      }

      this.#logger?.info(
        {
          rowId: req.sandboxRowId,
          botId: req.botId,
          cpuCount: info.cpuCount,
          memoryMB: info.memoryMB,
        },
        "sandbox created",
      );

      return handle;
    } catch (err) {
      // any post-create failure must not leak a running box
      await safeKill(instance);
      throw err;
    }
  }

  async connect(req: ConnectSandboxRequest): Promise<SandboxHandle> {
    const meta = parseProviderMeta(req.meta);
    // Reconnect on the SAME channel the box was created on (persisted in meta). A box lives on one
    // upstream backend; connecting through a different channel 502s. Undefined for pre-per-channel
    // rows → the env-default URL, which is where they were created.
    const conn = this.#config.sdkConnectionOpts(meta.channelSlug);

    let instance: Sandbox | undefined;
    try {
      // connect requires a timeout in the body (400 without one).
      instance = await withTimeout(
        Sandbox.connect(req.providerSandboxId, {
          ...conn,
          timeoutMs: DEFAULT_TTL_SECONDS * 1000,
        }),
        CONNECT_TIMEOUT_MS,
        "Sandbox.connect",
      );

      const info = await withTimeout(instance.getInfo(), GETINFO_TIMEOUT_MS, "getInfo");
      const envdVersion = info.envdVersion ?? meta.envdVersion;
      // Probe is the gate; the version only classifies a probe failure (see #probe / create()).
      await this.#probe(instance, envdVersion);

      const keepalive = this.#startKeepalive(instance, info.endAt, DEFAULT_TTL_SECONDS);
      const handle = new PpioSandboxHandle({ rowId: req.sandboxRowId, instance, meta, keepalive });

      // Re-provision idempotently: if the box survived intact this is a cheap series of
      // "already satisfied" checks; if the infra pause/resume wiped the in-box processes,
      // this restarts them (packages persist on disk, so only the launch steps re-run).
      // WARP is decided from the channel the box was CREATED on (persisted meta), same as routing,
      // so a reconnect never flips a box between proxied and direct egress.
      if (!this.#skipProvision) {
        const warp = this.#config.warpFor(meta.channelSlug);
        await provisionDesktop(handle, { warp, ...(this.#logger ? { logger: this.#logger } : {}) });
      }

      return handle;
    } catch (err) {
      if (instance) await safeKill(instance);
      // The box is gone from the gateway (reclaimed at TTL) — a distinct signal from a
      // transient failure. The caller uses this to decide "create a fresh box" vs
      // "retry the reconnect", so it must not be flattened into a bare Error. A
      // SandboxNotFoundError can surface from connect(), getInfo(), or the probe.
      if (err instanceof SandboxNotFoundError) {
        throw new SandboxGoneError(req.providerSandboxId, { cause: err });
      }
      throw err;
    }
  }

  #startKeepalive(instance: Sandbox, endAt: Date, ttlSeconds: number): Keepalive {
    const grantedSeconds = Math.max(1, Math.floor((endAt.getTime() - Date.now()) / 1000));
    const keepalive = new Keepalive({
      instance,
      intervalMs: keepaliveIntervalMs(grantedSeconds),
      ttlMs: ttlSeconds * 1000,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
    keepalive.start();
    return keepalive;
  }

  /**
   * Trivial command to confirm the runtime is reachable and SDK auth works — the actual
   * usability gate. On failure it kills the box and classifies: a box BELOW the envd floor that
   * can't run a command is the historical no-access-token → 401 mismatch, surfaced as the
   * actionable `EnvdVersionError` (do not retry / swap keys; use the envd HTTP fallback). Any
   * other failure (or a failure at/above the floor) is a plain `SandboxUnreachableError`. A box
   * that PASSES is driven regardless of its version tag — which is how a sub-floor channel the
   * gateway does serve a token for (e.g. envd 0.2.0 codex templates) gets through.
   */
  async #probe(instance: Sandbox, envdVersion: string): Promise<void> {
    try {
      const res = await withTimeout(
        instance.commands.run("true", { user: "root" }),
        PROBE_TIMEOUT_MS,
        "probe",
      );
      if (res.exitCode !== 0) {
        throw new Error(`probe command exited ${res.exitCode}`);
      }
    } catch (err) {
      // The caller's catch (create/connect) owns safeKill on any throw — don't double-kill here.
      if (!versionGte(envdVersion, MIN_ENVD_VERSION)) {
        throw new EnvdVersionError(envdVersion, MIN_ENVD_VERSION);
      }
      throw new SandboxUnreachableError(
        instance.sandboxId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** True if an error looks like the channel refusing a too-long TTL. */
function isTtlRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout/i.test(msg) && /(greater|exceed|maximum|1 hour)/i.test(msg);
}

/** Kill without letting a teardown error mask the original failure. */
async function safeKill(instance: Sandbox): Promise<void> {
  try {
    await instance.kill();
  } catch {
    // swallow — we're already on an error path or cleaning up
  }
}
