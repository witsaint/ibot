/**
 * Guards the model-history pruning that keeps screenshots from overflowing the context
 * window (`prompt is too long`). The DB transcript is untouched; only the array handed to
 * the model is slimmed — recent screenshots kept, older ones swapped for a placeholder.
 */
import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { OMITTED_SCREENSHOT, pruneHistoryForModel } from "./history.js";

let seq = 0;
/** An assistant message carrying one screenshot tool-result with the given base64 payload. */
function shotMessage(b64: string): UIMessage {
  seq++;
  return {
    id: `a${seq}`,
    role: "assistant",
    parts: [
      {
        type: "tool-screenshot",
        toolCallId: `call-${seq}`,
        state: "output-available",
        input: { type: "screenshot" },
        output: { ok: true, screenshot: b64 },
      },
    ],
  } as unknown as UIMessage;
}

function userText(text: string): UIMessage {
  seq++;
  return { id: `u${seq}`, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

describe("pruneHistoryForModel", () => {
  it("keeps only the most recent N screenshots, omitting older ones", () => {
    const history = [userText("go"), shotMessage("AAAA"), shotMessage("BBBB"), shotMessage("CCCC")];
    const pruned = pruneHistoryForModel(history, { keepScreenshots: 2 });

    const shots = pruned
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool-screenshot")
      .map((p) => (p as { output: { screenshot: string } }).output.screenshot);

    expect(shots).toEqual([OMITTED_SCREENSHOT, "BBBB", "CCCC"]); // oldest omitted, last 2 kept
  });

  it("preserves the ok/text fields when omitting a screenshot", () => {
    const msg = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-screenshot",
          toolCallId: "c1",
          state: "output-available",
          input: { type: "screenshot" },
          output: { ok: true, screenshot: "HUGE", text: "kept" },
        },
      ],
    } as unknown as UIMessage;
    const pruned = pruneHistoryForModel([userText("x"), msg, shotMessage("Z"), shotMessage("Y")], {
      keepScreenshots: 2,
    });
    const part = pruned[1]?.parts[0] as { output: Record<string, unknown> } | undefined;
    expect(part?.output).toEqual({ ok: true, screenshot: OMITTED_SCREENSHOT, text: "kept" });
  });

  it("does not mutate the input array", () => {
    const history = [userText("go"), shotMessage("AAAA"), shotMessage("BBBB"), shotMessage("CCCC")];
    const before = JSON.stringify(history);
    pruneHistoryForModel(history, { keepScreenshots: 1 });
    expect(JSON.stringify(history)).toBe(before);
  });

  it("leaves text parts untouched", () => {
    const history = [userText("hello"), userText("world")];
    const pruned = pruneHistoryForModel(history);
    expect(pruned).toBe(history); // no screenshots, under cap → same reference
  });

  it("caps the message window and never leads with a non-user message", () => {
    const history: UIMessage[] = [];
    for (let i = 0; i < 50; i++) {
      history.push(userText(`q${i}`));
      history.push(shotMessage(`shot${i}`));
    }
    const pruned = pruneHistoryForModel(history, { maxMessages: 10, keepScreenshots: 1 });
    expect(pruned.length).toBeLessThanOrEqual(10);
    expect(pruned[0]?.role).toBe("user");
  });

  it("output still converts to model messages after pruning", async () => {
    const history = [userText("go"), shotMessage("AAAA"), shotMessage("BBBB"), shotMessage("CCCC")];
    const pruned = pruneHistoryForModel(history, { keepScreenshots: 1 });
    const modelMessages = await convertToModelMessages(pruned);
    expect(Array.isArray(modelMessages)).toBe(true);
    expect(modelMessages.length).toBeGreaterThan(0);
  });
});
