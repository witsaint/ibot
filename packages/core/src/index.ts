import type { SandboxProviderName } from "@i-bot/types";

export { DESKTOP, getTemplate, TEMPLATES } from "@i-bot/templates";
export type { SandboxTemplate } from "@i-bot/templates";

// ---------- Sandbox layer (PPIO via AIProxy gateway) ----------
export { loadSandboxConfig, SandboxEnv, slugFromUrl, withChannelSlug } from "./sandbox/config.js";
export type { SandboxConfig, SdkConnectionOpts } from "./sandbox/config.js";
export {
  EnvdVersionError,
  SandboxGoneError,
  SandboxProviderError,
  SandboxUnreachableError,
  TtlClampedError,
} from "./sandbox/errors.js";
export { parseProviderMeta, PpioProviderMeta, runtimeHost, streamUrl } from "./sandbox/meta.js";
export { PpioSandboxProvider } from "./sandbox/ppio-provider.js";
export type { PpioSandboxProviderOptions } from "./sandbox/ppio-provider.js";
export { provisionDesktop, ProvisionError } from "./sandbox/provision.js";
export type { ProvisionOptions, ProvisionTarget } from "./sandbox/provision.js";
export { TimeoutError, withTimeout } from "./sandbox/timeout.js";
// executors — the primitives Mastra tools will wrap
export { executeDesktopAction } from "./sandbox/desktop-executor.js";
export {
  connectBrowser,
  defaultCdpConnector,
  defaultFetchJson,
  resolveCdpWsEndpoint,
} from "./sandbox/browser-executor.js";
export type {
  BrowserSession,
  CdpConnection,
  CdpConnector,
  FetchJson,
  PageLike,
} from "./sandbox/browser-executor.js";

/**
 * A live sandbox handle as the platform sees it — provider-agnostic. The three
 * PPIO IDs (control-plane id, provider sandboxID, clientID) live inside `meta`,
 * never leaked into higher layers; callers address a box only through this handle.
 */
export interface SandboxHandle {
  /** our DB row id (sandboxes.id), not any provider id */
  id: string;
  provider: SandboxProviderName;
  /**
   * The provider's canonical handle to persist as `sandboxes.provider_sandbox_id`.
   * For PPIO/AIProxy this is the SDK's composite `sandboxID-clientID` — the exact
   * string `connect()` needs to reattach later.
   */
  readonly providerSandboxId: string;
  /**
   * Provider-specific routing to persist as `sandboxes.provider_meta`, so a future
   * process can `connect(providerSandboxId, meta)` without a live handle. Opaque to
   * higher layers; never contains auth keys.
   */
  readonly meta: Record<string, unknown>;
  /** build `{port}-{sandboxID}-{clientID}.{domain}` for envd runtime access */
  getHost(port: number): string;
  /**
   * Run a shell command in the box as root — the software-install primitive.
   * `env` is passed to the box over envd's dedicated env channel (NOT spliced into the
   * command string), so values never appear in the command text, `ps`, or shell history.
   * This is the injection channel for `{{secrets.NAME}}`: the plaintext reaches the
   * process environment without becoming visible to logs or the model.
   */
  run(
    command: string,
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<CommandResult>;
  /** grab a PNG screenshot of the desktop (bytes; caller decides where they land) */
  screenshot(): Promise<Uint8Array>;
  /**
   * Drop this in-process handle WITHOUT touching the box: stop the keepalive loop and
   * release local resources, but leave the sandbox running on the control plane so a
   * later process can `connect()` and re-arm it. This is what a graceful server
   * shutdown wants — killing boxes on every restart (or dev hot-reload) is exactly the
   * bug that makes a bot's desktop "disappear". Idempotent.
   */
  detach(): void;
  /** release the box on the control plane (real teardown — a user "Stop" / delete) */
  destroy(): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateSandboxRequest {
  /**
   * The `sandboxes` row id apps/api created first (state=`create`). Becomes
   * `handle.id`. Creating the row first is what triggers the 1:1 `bot_id` unique
   * constraint and the owner-of-bot check before any control-plane call is made.
   */
  sandboxRowId: string;
  /** owning bot (1:1 — one bot, one sandbox) */
  botId: string;
  /** template key from @i-bot/templates (e.g. "desktop") */
  templateKey: string;
  /** create-time only; infra recycles long-running boxes ~every 24h */
  longRunning?: boolean;
  /**
   * Control-plane channel slug to create this box on (internal vs public egress). Omit to use the
   * provider's env-default channel. Whatever channel the box is created on is stamped into the
   * returned handle's `meta.channelSlug`, so every later reconnect routes to the same backend.
   */
  channelSlug?: string;
}

/**
 * Reconnect an existing box from its persisted row. Mirrors `CreateSandboxRequest`:
 * apps/api loads the `sandboxes` row (after the owner-of-bot check) and hands the
 * provider everything it needs, including the row id to stamp onto `handle.id`.
 */
export interface ConnectSandboxRequest {
  /** the existing `sandboxes` row id → becomes `handle.id` */
  sandboxRowId: string;
  /** persisted `sandboxes.provider_sandbox_id` (PPIO: the composite `sandboxID-clientID`) */
  providerSandboxId: string;
  /** persisted `sandboxes.provider_meta` */
  meta: Record<string, unknown>;
}

/**
 * The seam every sandbox backend implements (PPIO via the AIProxy gateway first;
 * e2b/daytona later). Kept as a pure contract here — the PPIO implementation,
 * with its control-plane slug + credential handling, lands in its own module.
 */
export interface SandboxProvider {
  readonly name: SandboxProviderName;
  create(req: CreateSandboxRequest): Promise<SandboxHandle>;
  /** reconnect to an existing box from its persisted row */
  connect(req: ConnectSandboxRequest): Promise<SandboxHandle>;
}
