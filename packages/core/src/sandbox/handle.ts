/**
 * `SandboxHandle` over a live ppio-sandbox base transport instance (the root
 * `Sandbox` = `Sandbox$2`, NOT the `/desktop` class — that one double-starts
 * Xvfb+xfce4 and fights our supervisord image). Higher layers only ever see this
 * handle; the SDK instance, its envdAccessToken, and routing ids stay inside.
 */
import type { SandboxProviderName } from "@i-bot/types";
import { CommandExitError, type Sandbox, SandboxNotFoundError } from "ppio-sandbox";
import type { CommandResult, SandboxHandle } from "../index.js";
import type { PpioProviderMeta } from "./meta.js";

/** Minimal keepalive contract the handle needs — its concrete class satisfies this. */
export interface Stoppable {
  stop(): void;
}

/** DISPLAY the desktop template's Xvfb runs on; screenshots/actions target it. */
const DISPLAY = ":0";

export interface PpioSandboxHandleDeps {
  /** our `sandboxes.id` (becomes `handle.id`) */
  rowId: string;
  /** connected base-transport SDK instance */
  instance: Sandbox;
  /** typed routing meta to expose as `handle.meta` */
  meta: PpioProviderMeta;
  /** the box's keepalive loop, stopped on destroy */
  keepalive: Stoppable;
}

export class PpioSandboxHandle implements SandboxHandle {
  readonly provider: SandboxProviderName = "ppio";
  readonly id: string;
  readonly providerSandboxId: string;
  readonly meta: Record<string, unknown>;

  #instance: Sandbox;
  #keepalive: Stoppable;
  #destroyed = false;

  constructor(deps: PpioSandboxHandleDeps) {
    this.id = deps.rowId;
    this.#instance = deps.instance;
    this.#keepalive = deps.keepalive;
    // The SDK instance's sandboxId is the composite `sandboxID-clientID` — exactly
    // what connect() needs to reattach. Persist THIS as provider_sandbox_id.
    this.providerSandboxId = deps.instance.sandboxId;
    this.meta = { ...deps.meta };
  }

  getHost(port: number): string {
    return this.#instance.getHost(port);
  }

  /**
   * Run a shell command as root. A non-zero exit is NOT thrown: the SDK raises
   * `CommandExitError` (which carries exitCode/stdout/stderr), and we return it as a
   * normal result so the executor layer inspects `exitCode`. Transport failures
   * (timeout, unreachable) still throw.
   *
   * `opts.env` is forwarded on envd's `envs` channel — the same mechanism `screenshot()`
   * uses for DISPLAY — so the values enter the process environment directly instead of
   * being interpolated into `command`. That is what keeps an injected secret out of the
   * command string (and thus out of `ps` / logs).
   */
  async run(
    command: string,
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<CommandResult> {
    try {
      const res = await this.#instance.commands.run(command, {
        user: "root",
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.env !== undefined ? { envs: opts.env } : {}),
      });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
      }
      throw err;
    }
  }

  /**
   * PNG screenshot of the virtual desktop. The base transport class has no
   * `screenshot()` (only the /desktop class does), so we shell out to `scrot` and
   * read the bytes back. DISPLAY is set explicitly — commands.run does not inherit
   * the image's ENV in every channel.
   */
  async screenshot(): Promise<Uint8Array> {
    const path = `/tmp/ibot-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    // -p includes the pointer; path is ours (no user input) so no escaping needed.
    const shot = await this.#instance.commands.run(`scrot -p ${path}`, {
      user: "root",
      envs: { DISPLAY },
    });
    if (shot.exitCode !== 0) {
      throw new Error(`scrot failed (exit ${shot.exitCode}): ${shot.stderr}`);
    }
    try {
      return await this.#instance.files.read(path, { format: "bytes" });
    } finally {
      // best-effort cleanup; a leaked temp file must not fail the screenshot
      await this.#instance.files.remove(path).catch(() => {});
    }
  }

  /**
   * Drop the handle without killing the box: stop keepalive, mark detached so a stray
   * later `destroy()` is a no-op. The box keeps running on its current grant — a new
   * process reconnects and re-arms keepalive. Idempotent.
   */
  detach(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#keepalive.stop();
  }

  /** Stop keepalive then kill the box. Idempotent; a vanished box is not an error. */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#keepalive.stop();
    try {
      await this.#instance.kill();
    } catch (err) {
      // an already-gone box is a successful teardown, not a failure
      if (!(err instanceof SandboxNotFoundError)) throw err;
    }
  }
}
