import { z } from "zod";

/**
 * Computer-use action vocabulary.
 *
 * Mirrors the verified `ppio-sandbox/desktop` API surface (screenshot, click,
 * drag, mousePress/mouseRelease, scroll, write, press, ...). These are the
 * primitives the agent's tools translate into against a remote sandbox.
 *
 * Coordinates are screen pixels: 0..width-1 x 0..height-1.
 */

export const MouseButton = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButton>;

export const Point = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export type Point = z.infer<typeof Point>;

export const ScrollDirection = z.enum(["up", "down", "left", "right"]);
export type ScrollDirection = z.infer<typeof ScrollDirection>;

/** Desktop (pixel) actions — the fallback path for system dialogs, native
 * fields, and slider captchas. */
export const DesktopAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screenshot") }),
  z.object({ type: z.literal("left_click"), at: Point.optional() }),
  z.object({ type: z.literal("right_click"), at: Point.optional() }),
  z.object({ type: z.literal("double_click"), at: Point.optional() }),
  z.object({ type: z.literal("middle_click"), at: Point.optional() }),
  z.object({ type: z.literal("move_mouse"), at: Point }),
  z.object({ type: z.literal("mouse_press"), button: MouseButton.default("left") }),
  z.object({ type: z.literal("mouse_release"), button: MouseButton.default("left") }),
  z.object({ type: z.literal("drag"), from: Point, to: Point }),
  z.object({
    type: z.literal("scroll"),
    direction: ScrollDirection.default("down"),
    amount: z.number().int().positive().default(3),
  }),
  z.object({ type: z.literal("write"), text: z.string() }),
  z.object({ type: z.literal("press"), keys: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().positive().max(30_000) }),
]);
export type DesktopAction = z.infer<typeof DesktopAction>;

/** Browser (CDP) actions — the preferred path for web tasks: fast, stable,
 * coordinate-free. */
export const BrowserAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({ type: z.literal("click"), selector: z.string() }),
  z.object({ type: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("read_dom"), selector: z.string().optional() }),
  z.object({ type: z.literal("screenshot") }),
  z.object({
    type: z.literal("wait_for"),
    selector: z.string(),
    timeoutMs: z.number().int().positive().default(10_000),
  }),
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

/** Result envelope returned to the agent loop after an action executes. */
export const ActionResult = z.object({
  ok: z.boolean(),
  /** base64 PNG when the action produced a screenshot */
  screenshot: z.string().optional(),
  /** text payload (DOM read, stdout, error message) */
  text: z.string().optional(),
  error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResult>;

export const ScreenSize = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ScreenSize = z.infer<typeof ScreenSize>;
