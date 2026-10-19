/**
 * The mid-run steering merge (`injectSteer`): what `prepareStep` appends to a step's messages
 * when the user sent something while the run was in flight. The no-steer path must be a true
 * no-op (undefined) so the overwhelming majority of steps carry zero overhead.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { injectSteer, releaseStreamOnClose } from "./run.js";

const base: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "first task" }] }];

describe("foreground response cancellation", () => {
  it("releases the turn and cancels the source when the client disconnects", async () => {
    const cancelSource = vi.fn();
    const release = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelSource });
    const response = releaseStreamOnClose(new Response(source), release);
    await response.body!.cancel("client disconnected");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("client disconnected");
    expect(cancelSource).toHaveBeenCalledWith("client disconnected");
  });

  it("preserves a successful response without treating it as cancellation", async () => {
    const release = vi.fn();
    const response = releaseStreamOnClose(
      new Response("data: result\n\n", { headers: { "content-type": "text/event-stream" } }),
      release,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: result\n\n");
    expect(release).not.toHaveBeenCalled();
  });
});

describe("injectSteer", () => {
  it("returns undefined when nothing is queued (no per-step override)", () => {
    expect(injectSteer(base, [])).toBeUndefined();
  });

  it("appends queued messages as user turns, preserving the prior messages", () => {
    const out = injectSteer(base, ["also check the cart", "and take a screenshot"]);
    expect(out).toBeDefined();
    expect(out).toHaveLength(3);
    expect(out?.[0]).toEqual(base[0]); // original step messages untouched, first
    expect(out?.[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "also check the cart" }],
    });
    expect(out?.[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "and take a screenshot" }],
    });
  });

  it("does not mutate the input array", () => {
    const input = [...base];
    injectSteer(input, ["x"]);
    expect(input).toHaveLength(1);
  });
});
