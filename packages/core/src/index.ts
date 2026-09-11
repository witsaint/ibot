import type { SandboxProviderName } from "@i-bot/types";

export { DESKTOP, getTemplate, TEMPLATES } from "@i-bot/templates";
export type { SandboxTemplate } from "@i-bot/templates";

/**
 * A live sandbox handle as the platform sees it — provider-agnostic. The three
 * PPIO IDs (control-plane id, provider sandboxID, clientID) live inside `meta`,
 * never leaked into higher layers; callers address a box only through this handle.
 */
export interface SandboxHandle {
  /** our DB row id (sandboxes.id), not any provider id */
  id: string;
  provider: SandboxProviderName;
  /** build `{port}-{sandboxID}-{clientID}.{domain}` for envd runtime access */
  getHost(port: number): string;
  /** run a shell command in the box as root — the software-install primitive */
  run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>;
  /** grab a PNG screenshot of the desktop (bytes; caller decides where they land) */
  screenshot(): Promise<Uint8Array>;
  /** release the box on the control plane */
  destroy(): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateSandboxRequest {
  /** owning bot (1:1 — one bot, one sandbox) */
  botId: string;
  /** template key from @i-bot/templates (e.g. "desktop") */
  templateKey: string;
  /** create-time only; infra recycles long-running boxes ~every 24h */
  longRunning?: boolean;
}

/**
 * The seam every sandbox backend implements (PPIO via the AIProxy gateway first;
 * e2b/daytona later). Kept as a pure contract here — the PPIO implementation,
 * with its control-plane slug + credential handling, lands in its own module.
 */
export interface SandboxProvider {
  readonly name: SandboxProviderName;
  create(req: CreateSandboxRequest): Promise<SandboxHandle>;
  /** reconnect to an existing box from its persisted provider metadata */
  connect(providerSandboxId: string, meta: Record<string, unknown>): Promise<SandboxHandle>;
}
