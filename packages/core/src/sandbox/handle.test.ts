import { CommandExitError, type Sandbox } from "ppio-sandbox";
import { describe, expect, it, vi } from "vitest";
import { PpioSandboxHandle, type Stoppable } from "./handle.js";
import type { PpioProviderMeta } from "./meta.js";

const meta: PpioProviderMeta = { domain: "sandbox.paigod.work", envdVersion: "0.5.0" };

/**
 * A minimal fake of the SDK `Sandbox` — only the bits `PpioSandboxHandle` touches. We
 * record the (cmd, opts) every `commands.run` receives so a test can assert HOW a value
 * reached the box (the `envs` channel) vs. what the command string literally said.
 */
function fakeInstance(
  run: (
    cmd: string,
    opts: Record<string, unknown>,
  ) => { exitCode: number; stdout: string; stderr: string },
): { instance: Sandbox; calls: Array<{ cmd: string; opts: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
  const instance = {
    sandboxId: "sbx-1-client-1",
    commands: {
      run: vi.fn(async (cmd: string, opts: Record<string, unknown>) => {
        calls.push({ cmd, opts });
        return run(cmd, opts);
      }),
    },
  } as unknown as Sandbox;
  return { instance, calls };
}

const noopKeepalive: Stoppable = { stop() {} };

function makeHandle(instance: Sandbox): PpioSandboxHandle {
  return new PpioSandboxHandle({ rowId: "row-1", instance, meta, keepalive: noopKeepalive });
}

describe("PpioSandboxHandle.run", () => {
  it("forwards env on the envs channel, never spliced into the command string", async () => {
    const { instance, calls } = fakeInstance(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const handle = makeHandle(instance);

    const res = await handle.run('curl -H "Authorization: Bearer $TOKEN" https://api.example', {
      env: { TOKEN: "s3cr3t-value" },
    });

    expect(res).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(calls).toHaveLength(1);
    const { cmd, opts } = calls[0]!;
    // the secret reached the process via envs, as root
    expect(opts.envs).toEqual({ TOKEN: "s3cr3t-value" });
    expect(opts.user).toBe("root");
    // …and is NOT present in the command text (so `ps`/logs can't see it)
    expect(cmd).not.toContain("s3cr3t-value");
    expect(cmd).toBe('curl -H "Authorization: Bearer $TOKEN" https://api.example');
  });

  it("omits the envs key entirely when no env is given (legacy call shape preserved)", async () => {
    const { instance, calls } = fakeInstance(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const handle = makeHandle(instance);

    await handle.run("echo hi");

    const { opts } = calls[0]!;
    expect(opts.user).toBe("root");
    expect(opts).not.toHaveProperty("envs");
    expect(opts).not.toHaveProperty("timeoutMs");
  });

  it("passes timeoutMs and env together without touching the command", async () => {
    const { instance, calls } = fakeInstance(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const handle = makeHandle(instance);

    await handle.run("run-thing", { timeoutMs: 5_000, env: { A: "1" } });

    const { opts } = calls[0]!;
    expect(opts.timeoutMs).toBe(5_000);
    expect(opts.envs).toEqual({ A: "1" });
  });

  it("returns a non-zero exit (CommandExitError) as a normal result instead of throwing", async () => {
    const { instance } = fakeInstance(() => {
      throw new CommandExitError({ exitCode: 3, stdout: "partial", stderr: "boom" });
    });
    const handle = makeHandle(instance);

    const res = await handle.run("false", { env: { A: "1" } });
    expect(res).toEqual({ exitCode: 3, stdout: "partial", stderr: "boom" });
  });
});
