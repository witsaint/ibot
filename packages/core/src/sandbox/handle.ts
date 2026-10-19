/**
 * `SandboxHandle` over a live ppio-sandbox base transport instance (the root
 * `Sandbox` = `Sandbox$2`, NOT the `/desktop` class — that one double-starts
 * Xvfb+xfce4 and fights our supervisord image). Higher layers only ever see this
 * handle; the SDK instance, its envdAccessToken, and routing ids stay inside.
 */
import type { SandboxProviderName } from "@i-bot/types";
import { CommandExitError, type Sandbox, SandboxNotFoundError } from "ppio-sandbox";
import type { CommandResult, SandboxEntry, SandboxFiles, SandboxHandle } from "../index.js";
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

/**
 * `SandboxFiles` over the SDK's `files`. A thin adapter on purpose: it narrows the SDK's surface to
 * the subset the interface promises, and normalizes what leaks through.
 *
 * Two normalizations worth naming, because both would otherwise surface as confusing tool output:
 *  - `write` makes the parent directory first. The SDK errors on a missing parent, and "write a new
 *    file into a new folder" is the single most common thing a code-editing agent does.
 *  - `list` maps the SDK's `FileType` enum to a plain string union so nothing downstream has to
 *    import the SDK to compare against it.
 */
class PpioSandboxFiles implements SandboxFiles {
  #instance: Sandbox;

  constructor(instance: Sandbox) {
    this.#instance = instance;
  }

  async readText(path: string): Promise<string> {
    return this.#instance.files.read(path, { format: "text" });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return this.#instance.files.read(path, { format: "bytes" });
  }

  async write(path: string, content: string): Promise<void> {
    // The SDK refuses a write whose parent doesn't exist; creating a file in a fresh directory is
    // routine for this caller, so absorb it here rather than making every tool remember a mkdir.
    const parent = path.replace(/\/+[^/]*$/, "");
    if (parent && parent !== path) await this.#instance.files.makeDir(parent).catch(() => false);
    await this.#instance.files.write(path, content);
  }

  async list(path: string, opts?: { depth?: number }): Promise<SandboxEntry[]> {
    const entries = await this.#instance.files.list(path, {
      ...(opts?.depth !== undefined ? { depth: opts.depth } : {}),
    });
    return entries.map((e) => ({
      name: e.name,
      path: e.path,
      // FileType is an enum whose values are already "file"/"dir"; compare as strings so this file
      // stays the only place that knows the SDK's shape.
      ...(e.type === "file" || e.type === "dir" ? { type: e.type } : {}),
      size: e.size,
    }));
  }

  async makeDir(path: string): Promise<boolean> {
    return this.#instance.files.makeDir(path);
  }

  async remove(path: string): Promise<void> {
    await this.#instance.files.remove(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.#instance.files.exists(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.#instance.files.rename(oldPath, newPath);
  }
}

export class PpioSandboxHandle implements SandboxHandle {
  readonly provider: SandboxProviderName = "ppio";
  readonly id: string;
  readonly providerSandboxId: string;
  readonly meta: Record<string, unknown>;
  readonly files: SandboxFiles;

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
    this.files = new PpioSandboxFiles(deps.instance);
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
