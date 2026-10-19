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

/**
 * A fake of just the SDK's `files`, recording call order so the adapter's own normalizations can be
 * asserted (they're the reason this adapter exists rather than passing the SDK class straight up).
 */
function fakeFilesInstance(): {
  instance: Sandbox;
  files: Record<string, ReturnType<typeof vi.fn>>;
  order: string[];
} {
  const order: string[] = [];
  const track =
    (name: string, ret: unknown) =>
    (...args: unknown[]) => {
      order.push(name);
      void args;
      return Promise.resolve(ret);
    };
  const files = {
    read: vi.fn(track("read", "contents")),
    write: vi.fn(track("write", { path: "/x" })),
    list: vi.fn(track("list", [])),
    makeDir: vi.fn(track("makeDir", true)),
    remove: vi.fn(track("remove", undefined)),
    exists: vi.fn(track("exists", true)),
    rename: vi.fn(track("rename", { path: "/b" })),
  };
  return { instance: { sandboxId: "sbx-1-client-1", files } as unknown as Sandbox, files, order };
}

describe("PpioSandboxHandle.files", () => {
  it("reads text and bytes with the format the SDK's overloads require", async () => {
    const { instance, files } = fakeFilesInstance();
    const handle = makeHandle(instance);

    await handle.files.readText("/a.txt");
    expect(files.read).toHaveBeenCalledWith("/a.txt", { format: "text" });
    await handle.files.readBytes("/a.png");
    expect(files.read).toHaveBeenCalledWith("/a.png", { format: "bytes" });
  });

  it("creates the parent dir BEFORE writing, so a new file in a new folder just works", async () => {
    const { instance, files, order } = fakeFilesInstance();
    const handle = makeHandle(instance);

    await handle.files.write("/opt/ibot-sites/demo/src/main.js", "export {}");

    // The SDK rejects a write whose parent is missing, and "new file in a new directory" is the most
    // common edit a code-writing agent makes — so the adapter absorbs the mkdir instead of making
    // every tool (and every model turn) remember it.
    expect(files.makeDir).toHaveBeenCalledWith("/opt/ibot-sites/demo/src");
    expect(order.indexOf("makeDir")).toBeLessThan(order.indexOf("write"));
    expect(files.write).toHaveBeenCalledWith("/opt/ibot-sites/demo/src/main.js", "export {}");
  });

  it("writes anyway when the parent mkdir fails — that normally just means it exists", async () => {
    const { instance, files } = fakeFilesInstance();
    files.makeDir!.mockImplementation(() => Promise.reject(new Error("already exists")));
    const handle = makeHandle(instance);

    await expect(handle.files.write("/tmp/a.txt", "x")).resolves.toBeUndefined();
    expect(files.write).toHaveBeenCalledWith("/tmp/a.txt", "x");
  });

  it("skips the mkdir for a bare filename (no parent segment to create)", async () => {
    const { instance, files } = fakeFilesInstance();
    const handle = makeHandle(instance);

    await handle.files.write("a.txt", "x");
    expect(files.makeDir).not.toHaveBeenCalled();
    expect(files.write).toHaveBeenCalledWith("a.txt", "x");
  });

  it("maps entries to plain types, and omits `type` for anything it can't classify", async () => {
    const { instance, files } = fakeFilesInstance();
    files.list!.mockImplementation(() =>
      Promise.resolve([
        { name: "src", path: "/p/src", type: "dir", size: 0 },
        { name: "a.js", path: "/p/a.js", type: "file", size: 12 },
        // a symlink/socket the box didn't classify — the field must be absent, not guessed
        { name: "odd", path: "/p/odd", type: "symlink", size: 1 },
      ]),
    );
    const handle = makeHandle(instance);

    const entries = await handle.files.list("/p", { depth: 2 });

    expect(files.list).toHaveBeenCalledWith("/p", { depth: 2 });
    expect(entries).toEqual([
      { name: "src", path: "/p/src", type: "dir", size: 0 },
      { name: "a.js", path: "/p/a.js", type: "file", size: 12 },
      { name: "odd", path: "/p/odd", size: 1 },
    ]);
  });

  it("omits depth rather than passing undefined, so the SDK's own default applies", async () => {
    const { instance, files } = fakeFilesInstance();
    const handle = makeHandle(instance);

    await handle.files.list("/p");
    expect(files.list).toHaveBeenCalledWith("/p", {});
  });

  it("forwards the remaining operations unchanged", async () => {
    const { instance, files } = fakeFilesInstance();
    const handle = makeHandle(instance);

    await expect(handle.files.makeDir("/d")).resolves.toBe(true);
    await expect(handle.files.exists("/d")).resolves.toBe(true);
    await handle.files.remove("/d");
    await handle.files.rename("/a", "/b");

    expect(files.makeDir).toHaveBeenCalledWith("/d");
    expect(files.exists).toHaveBeenCalledWith("/d");
    expect(files.remove).toHaveBeenCalledWith("/d");
    expect(files.rename).toHaveBeenCalledWith("/a", "/b");
  });
});
