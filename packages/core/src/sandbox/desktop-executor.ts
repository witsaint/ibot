/**
 * Execute one `DesktopAction` against a live sandbox by shelling to `xdotool` (input
 * synthesis) and `scrot` (screenshots, via handle.screenshot()). Tool-agnostic: no
 * Mastra, no `ai` — this is the primitive the agent's computer-use tool wraps.
 *
 * SECURITY: user-controlled strings (`write` text, `press` keys) are NEVER raw
 * interpolated into the shell. `write` text is single-quote escaped; `press` keys
 * are validated against a keysym allowlist. Coordinates are integers from a zod
 * schema (`Point`), so they carry no injection risk.
 *
 * Actions are synchronous request/response (one action → one ActionResult). Streaming
 * a step feed is the agent loop's job, above core — see the sandbox↔protocol seams.
 */
import type { DesktopAction, MouseButton } from "@i-bot/types";
import type { CommandResult, SandboxHandle } from "../index.js";

/** The Xvfb display the desktop template runs on; xdotool must target it. */
const DISPLAY = ":0";

/** MouseButton → X11 button number. */
const BUTTON_NUMBER: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 };

/** ScrollDirection → X11 wheel button (up:4 down:5 left:6 right:7). */
const SCROLL_BUTTON: Record<"up" | "down" | "left" | "right", number> = {
  up: 4,
  down: 5,
  left: 6,
  right: 7,
};

/** Keysyms xdotool `key`/`type` may receive: names and single chars, no metachars. */
const KEYSYM_RE = /^[A-Za-z0-9_]+$/;

/** Single-quote a string for POSIX sh: wrap in '...' and escape embedded quotes. */
function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** ok=false envelope from a failed command. */
function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Run a command and map a non-zero exit to a failure envelope. */
async function runOk(
  handle: SandboxHandle,
  command: string,
): Promise<{ ok: true; result: CommandResult } | { ok: false; error: string }> {
  const result = await handle.run(command);
  if (result.exitCode !== 0) {
    return fail(result.stderr.trim() || `command exited ${result.exitCode}`);
  }
  return { ok: true, result };
}

/** `xdotool mousemove --sync X Y` prefix for actions that target a point. */
function moveTo(x: number, y: number): string {
  return `mousemove --sync ${Math.trunc(x)} ${Math.trunc(y)}`;
}

/**
 * Execute a validated desktop action. Returns `{ok:false, error}` on any failure
 * rather than throwing, so the agent loop can decide how to recover.
 */
export async function executeDesktopAction(
  handle: SandboxHandle,
  action: DesktopAction,
): Promise<import("@i-bot/types").ActionResult> {
  try {
    switch (action.type) {
      case "screenshot": {
        const bytes = await handle.screenshot();
        return { ok: true, screenshot: Buffer.from(bytes).toString("base64") };
      }

      case "left_click":
      case "right_click":
      case "middle_click": {
        const button = action.type === "left_click" ? 1 : action.type === "right_click" ? 3 : 2;
        const move = action.at ? `${moveTo(action.at.x, action.at.y)} ` : "";
        const r = await runOk(handle, `DISPLAY=${DISPLAY} xdotool ${move}click ${button}`);
        return r.ok ? { ok: true } : r;
      }

      case "double_click": {
        const move = action.at ? `${moveTo(action.at.x, action.at.y)} ` : "";
        const r = await runOk(
          handle,
          `DISPLAY=${DISPLAY} xdotool ${move}click --repeat 2 --delay 25 1`,
        );
        return r.ok ? { ok: true } : r;
      }

      case "move_mouse": {
        const r = await runOk(
          handle,
          `DISPLAY=${DISPLAY} xdotool ${moveTo(action.at.x, action.at.y)}`,
        );
        return r.ok ? { ok: true } : r;
      }

      case "mouse_press": {
        const r = await runOk(
          handle,
          `DISPLAY=${DISPLAY} xdotool mousedown ${BUTTON_NUMBER[action.button]}`,
        );
        return r.ok ? { ok: true } : r;
      }

      case "mouse_release": {
        const r = await runOk(
          handle,
          `DISPLAY=${DISPLAY} xdotool mouseup ${BUTTON_NUMBER[action.button]}`,
        );
        return r.ok ? { ok: true } : r;
      }

      case "drag": {
        const cmd =
          `DISPLAY=${DISPLAY} xdotool ${moveTo(action.from.x, action.from.y)} mousedown 1 ` +
          `${moveTo(action.to.x, action.to.y)} mouseup 1`;
        const r = await runOk(handle, cmd);
        return r.ok ? { ok: true } : r;
      }

      case "scroll": {
        const button = SCROLL_BUTTON[action.direction];
        const r = await runOk(
          handle,
          `DISPLAY=${DISPLAY} xdotool click --repeat ${Math.trunc(action.amount)} ${button}`,
        );
        return r.ok ? { ok: true } : r;
      }

      case "write": {
        // text is single-quote escaped; `--` stops flag parsing so leading `-` is literal
        const r = await runOk(
          handle,
          `DISPLAY=${DISPLAY} xdotool type --delay 12 -- ${shellSingleQuote(action.text)}`,
        );
        return r.ok ? { ok: true } : r;
      }

      case "press": {
        for (const key of action.keys) {
          if (!KEYSYM_RE.test(key)) {
            return fail(`rejected key "${key}": not an allowed keysym`);
          }
        }
        // validated → safe to join into a chord (e.g. ctrl+c) and pass to xdotool key
        const chord = action.keys.join("+");
        const r = await runOk(handle, `DISPLAY=${DISPLAY} xdotool key --clearmodifiers ${chord}`);
        return r.ok ? { ok: true } : r;
      }

      case "wait": {
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        return { ok: true };
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
