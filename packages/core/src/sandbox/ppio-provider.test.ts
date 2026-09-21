import { describe, expect, it } from "vitest";
import { keepaliveIntervalMs, versionGte } from "./ppio-provider.js";

describe("versionGte (envd version gate)", () => {
  it("accepts equal and newer versions", () => {
    expect(versionGte("0.5.0", "0.5.0")).toBe(true);
    expect(versionGte("0.5.1", "0.5.0")).toBe(true);
    expect(versionGte("1.0.0", "0.5.0")).toBe(true);
    expect(versionGte("0.12.0", "0.5.0")).toBe(true); // numeric, not lexical
  });

  it("rejects older versions (the 401 mismatch case)", () => {
    expect(versionGte("0.4.9", "0.5.0")).toBe(false);
    expect(versionGte("0.0.0", "0.5.0")).toBe(false);
    expect(versionGte("0.4.99", "0.5.0")).toBe(false);
  });
});

describe("keepaliveIntervalMs (must stay below the granted window)", () => {
  it("targets ~1/12 of the window", () => {
    // 1h window → 5min
    expect(keepaliveIntervalMs(3600)).toBe(300_000);
  });

  it("clamps to the 15min ceiling for long windows", () => {
    // 4h/12 = 20min → clamped to 15min
    expect(keepaliveIntervalMs(4 * 3600)).toBe(15 * 60_000);
  });

  it("clamps to the 60s floor for short windows", () => {
    expect(keepaliveIntervalMs(60)).toBe(60_000);
    expect(keepaliveIntervalMs(1)).toBe(60_000);
  });
});
