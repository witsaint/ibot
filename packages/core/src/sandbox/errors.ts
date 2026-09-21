/**
 * Typed sandbox-provider errors. apps/api branches on these to decide whether to
 * retry, surface to the user, or fail the bot's sandbox row — a bare `Error` can't
 * carry that decision. Never put auth keys / envdAccessToken in a message.
 */

/** Base class so callers can `instanceof SandboxProviderError` to catch the family. */
export class SandboxProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The channel's envd is older than the SDK needs (`envdVersion < 0.5.0`): it won't
 * return an `envdAccessToken`, so the new SDK fails `401 invalid token`. This is a
 * version mismatch, NOT a credential problem — do not retry or swap keys. The scoped
 * follow-up (if a channel is actually this old) is the envd HTTP fallback.
 */
export class EnvdVersionError extends SandboxProviderError {
  constructor(
    readonly envdVersion: string,
    readonly minimumVersion: string,
  ) {
    super(
      `Sandbox envd version ${envdVersion} is below the minimum ${minimumVersion} the SDK requires; ` +
        `this channel needs the envd HTTP fallback, not a retry.`,
    );
  }
}

/** envd health never went green (create succeeded but the runtime is unreachable). */
export class SandboxUnreachableError extends SandboxProviderError {
  constructor(
    readonly providerSandboxId: string,
    detail: string,
  ) {
    super(`Sandbox ${providerSandboxId} is unreachable: ${detail}`);
  }
}

/**
 * The box no longer exists on the gateway — reclaimed at its TTL (e.g. keepalive
 * stopped while the process was down, or the ~1h grant lapsed). `connect()` raises
 * this so the caller can tell "box is gone, must create a FRESH one (content lost)"
 * apart from "box is alive but its in-box services died" (a plain reconnect revives
 * it with disk/env intact). Only a definitive not-found from the control plane maps
 * here; a transient/unreachable failure stays `SandboxUnreachableError` (never
 * false-recreate a merely-slow box and throw away its content).
 */
export class SandboxGoneError extends SandboxProviderError {
  constructor(
    readonly providerSandboxId: string,
    options?: { cause?: unknown },
  ) {
    super(`Sandbox ${providerSandboxId} no longer exists on the gateway (reclaimed).`, options);
  }
}

/**
 * The requested TTL didn't hold. Some channels hard-cap at 1h and either reject
 * `timeout > 3600` or silently clamp it. The provider negotiates down and re-reads
 * `endAt`; this signals the caller that the granted window is shorter than asked.
 */
export class TtlClampedError extends SandboxProviderError {
  constructor(
    readonly requestedSeconds: number,
    readonly grantedSeconds: number,
  ) {
    super(`Requested sandbox TTL ${requestedSeconds}s but the channel granted ${grantedSeconds}s.`);
  }
}
