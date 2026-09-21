/**
 * The trace flattener behind "record → experience". `buildActionTrace` turns a conversation's
 * UIMessages into the compact USER/ASSISTANT/ACTION transcript the distiller feeds the model —
 * eliding screenshots and oversized payloads, and marking each tool call ok/error.
 */
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildActionTrace } from "./distill.js";

/** Build a tool UIMessage part the same way the AI SDK persists one (`tool-<name>` + state). */
function toolPart(name: string, input: unknown, output?: unknown) {
  return {
    type: `tool-${name}`,
    toolCallId: `call-${name}`,
    state: output === undefined ? "input-available" : "output-available",
    input,
    ...(output === undefined ? {} : { output }),
  };
}

function msg(role: "user" | "assistant", parts: unknown[]): UIMessage {
  return { id: `${role}-${Math.random()}`, role, parts } as UIMessage;
}

describe("buildActionTrace", () => {
  it("returns empty string for a conversation with no text or actions", () => {
    expect(buildActionTrace([])).toBe("");
    expect(buildActionTrace([msg("user", [])])).toBe("");
  });

  it("flattens user/assistant text and tool calls in order", () => {
    const trace = buildActionTrace([
      msg("user", [{ type: "text", text: "book a flight" }]),
      msg("assistant", [
        { type: "text", text: "on it" },
        toolPart("desktop_action", { type: "click", x: 10, y: 20 }, { ok: true }),
      ]),
    ]);
    expect(trace).toBe(
      [
        "USER: book a flight",
        "ASSISTANT: on it",
        'ACTION: desktop_action({"type":"click","x":10,"y":20}) → ok',
      ].join("\n"),
    );
  });

  it("marks a failed tool call with its error", () => {
    const trace = buildActionTrace([
      msg("assistant", [toolPart("run_command", { cmd: "ls" }, { ok: false, error: "boom" })]),
    ]);
    expect(trace).toContain("→ error: boom");
  });

  it("renders a screenshot output as a bare result, never the blob", () => {
    // Outputs contribute only ok/error/state to the trace — the screenshot payload in the output
    // object is never serialized, so a data URL there can't leak in.
    const dataUrl = `data:image/png;base64,${"A".repeat(500)}`;
    const trace = buildActionTrace([
      msg("assistant", [toolPart("screenshot", {}, { ok: true, image: dataUrl })]),
    ]);
    expect(trace).toBe("ACTION: screenshot({}) → ok");
    expect(trace).not.toContain("base64");
  });

  it("elides an oversized tool INPUT instead of dumping the payload", () => {
    // >4000 chars once stringified → omitted wholesale, not truncated with an ellipsis.
    const huge = "A".repeat(5000);
    const trace = buildActionTrace([
      msg("assistant", [toolPart("desktop_action", { type: "paste", text: huge }, { ok: true })]),
    ]);
    expect(trace).not.toContain("AAAA");
    expect(trace).toContain("chars omitted");
    expect(trace).toContain("→ ok");
  });

  it("truncates a merely-long input with an ellipsis", () => {
    const longish = "x".repeat(600); // > MAX_FIELD (400), < 4000
    const trace = buildActionTrace([
      msg("assistant", [toolPart("run_command", { cmd: longish }, { ok: true })]),
    ]);
    expect(trace).toContain("…");
    expect(trace).not.toContain("chars omitted");
  });
});
