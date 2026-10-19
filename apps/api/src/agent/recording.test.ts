import { describe, expect, it } from "vitest";
import { type RecordedEvent, selectFrames } from "./recording.js";

const ev = (n: number, extra: Partial<RecordedEvent> = {}): RecordedEvent => ({
  n,
  t: n * 500,
  x: 0,
  y: 0,
  win: "w",
  screen: 0,
  moved: 1,
  winChanged: 0,
  key: 0,
  ...extra,
});

describe("selectFrames", () => {
  it("returns everything when under the cap", () => {
    const events = [ev(1), ev(2), ev(3)];
    expect(selectFrames(events, 12)).toEqual(events);
  });

  it("always keeps the first and last frame", () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(i + 1));
    const picked = selectFrames(events, 6);
    expect(picked[0]?.n).toBe(1);
    expect(picked[picked.length - 1]?.n).toBe(40);
    expect(picked.length).toBeLessThanOrEqual(6);
  });

  it("prefers transitions (window switch / screen change) over pointer-only frames", () => {
    // 30 pointer-only frames with 3 real transitions buried in them
    const events = Array.from({ length: 30 }, (_, i) => ev(i + 1));
    events[9] = ev(10, { winChanged: 1 });
    events[19] = ev(20, { screen: 1 });
    events[24] = ev(25, { winChanged: 1, screen: 1 });
    const picked = selectFrames(events, 6);
    const ns = picked.map((e) => e.n);
    expect(ns).toContain(10);
    expect(ns).toContain(20);
    expect(ns).toContain(25);
    expect(ns[0]).toBe(1);
    expect(ns[ns.length - 1]).toBe(30);
  });

  it("thins evenly when there are more transitions than the cap, preserving order", () => {
    const events = Array.from({ length: 50 }, (_, i) => ev(i + 1, { screen: 1 }));
    const picked = selectFrames(events, 8);
    expect(picked.length).toBe(8);
    const ns = picked.map((e) => e.n);
    expect([...ns].sort((a, b) => a - b)).toEqual(ns); // in order
    expect(ns[0]).toBe(1);
    expect(ns[7]).toBe(50);
    expect(new Set(ns).size).toBe(8); // no duplicates
  });
});
