import type { DesktopAction } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import type { CommandResult, SandboxHandle } from "../index.js";
import { executeDesktopAction } from "./desktop-executor.js";

/** A fake handle that records the commands it's asked to run. */
function fakeHandle(opts?: { exitCode?: number; stderr?: string; screenshot?: Uint8Array }): {
  handle: SandboxHandle;
  commands: string[];
} {
  const commands: string[] = [];
  const handle: SandboxHandle = {
    id: "row-1",
    provider: "ppio",
    providerSandboxId: "sbx-1",
    meta: {},
    getHost: (port) => `${port}-sbx-1.example`,
    run: async (command: string): Promise<CommandResult> => {
      commands.push(command);
      return { exitCode: opts?.exitCode ?? 0, stdout: "", stderr: opts?.stderr ?? "" };
    },
    screenshot: async () => opts?.screenshot ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    detach: () => {},
    destroy: async () => {},
  };
  return { handle, commands };
}

describe("executeDesktopAction — mappings", () => {
  it("screenshot returns base64 of the handle's PNG bytes", async () => {
    const { handle } = fakeHandle({ screenshot: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    const res = await executeDesktopAction(handle, { type: "screenshot" });
    expect(res.ok).toBe(true);
    expect(res.screenshot).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  });

  it("left_click with a point moves (sync) then clicks button 1", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "left_click", at: { x: 12, y: 34 } });
    expect(commands[0]).toBe("DISPLAY=:0 xdotool mousemove --sync 12 34 click 1");
  });

  it("left_click without a point clicks in place", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "left_click" });
    expect(commands[0]).toBe("DISPLAY=:0 xdotool click 1");
  });

  it("right/middle click use buttons 3/2", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "right_click" });
    await executeDesktopAction(handle, { type: "middle_click" });
    expect(commands[0]).toContain("click 3");
    expect(commands[1]).toContain("click 2");
  });

  it("double_click repeats twice", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "double_click", at: { x: 1, y: 2 } });
    expect(commands[0]).toBe(
      "DISPLAY=:0 xdotool mousemove --sync 1 2 click --repeat 2 --delay 25 1",
    );
  });

  it("mouse_press/release map to mousedown/mouseup with button numbers", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "mouse_press", button: "left" });
    await executeDesktopAction(handle, { type: "mouse_release", button: "right" });
    expect(commands[0]).toBe("DISPLAY=:0 xdotool mousedown 1");
    expect(commands[1]).toBe("DISPLAY=:0 xdotool mouseup 3");
  });

  it("drag presses at from, moves to to, releases", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "drag", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } });
    expect(commands[0]).toBe(
      "DISPLAY=:0 xdotool mousemove --sync 5 6 mousedown 1 mousemove --sync 7 8 mouseup 1",
    );
  });

  it("scroll maps directions to wheel buttons up:4 down:5 left:6 right:7", async () => {
    const dirs: Array<[DesktopAction & { type: "scroll" }, number]> = [
      [{ type: "scroll", direction: "up", amount: 3 }, 4],
      [{ type: "scroll", direction: "down", amount: 3 }, 5],
      [{ type: "scroll", direction: "left", amount: 3 }, 6],
      [{ type: "scroll", direction: "right", amount: 3 }, 7],
    ];
    // each direction is independent — run in parallel, each with its own fake handle
    const results = await Promise.all(
      dirs.map(async ([action, button]) => {
        const { handle, commands } = fakeHandle();
        await executeDesktopAction(handle, action);
        return { cmd: commands[0], button };
      }),
    );
    for (const { cmd, button } of results) {
      expect(cmd).toBe(`DISPLAY=:0 xdotool click --repeat 3 ${button}`);
    }
  });

  it("press joins keys into a chord", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "press", keys: ["ctrl", "c"] });
    expect(commands[0]).toBe("DISPLAY=:0 xdotool key --clearmodifiers ctrl+c");
  });
});

describe("executeDesktopAction — security", () => {
  it("write single-quote escapes the text (no raw interpolation)", async () => {
    const { handle, commands } = fakeHandle();
    await executeDesktopAction(handle, { type: "write", text: "it's; rm -rf /" });
    // the ' is escaped as '\'' and the whole payload is single-quoted after --
    expect(commands[0]).toBe("DISPLAY=:0 xdotool type --delay 12 -- 'it'\\''s; rm -rf /'");
  });

  it("press rejects a key outside the keysym allowlist", async () => {
    const { handle, commands } = fakeHandle();
    const res = await executeDesktopAction(handle, {
      type: "press",
      keys: ["ctrl", "c; rm -rf /"],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not an allowed keysym/);
    expect(commands).toHaveLength(0); // nothing was run
  });
});

describe("executeDesktopAction — failures", () => {
  it("maps a non-zero exit to {ok:false, error}", async () => {
    const { handle } = fakeHandle({ exitCode: 1, stderr: "xdotool: no display" });
    const res = await executeDesktopAction(handle, { type: "left_click" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("xdotool: no display");
  });
});
