/**
 * The mid-run steering merge (`injectSteer`): what `prepareStep` appends to a step's messages
 * when the user sent something while the run was in flight. The no-steer path must be a true
 * no-op (undefined) so the overwhelming majority of steps carry zero overhead.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { injectSteer } from "./run.js";

const base: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "first task" }] }];

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
