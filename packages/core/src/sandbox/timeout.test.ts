import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("passes through a value when the work settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "ok")).resolves.toBe(42);
  });

  it("passes through a rejection when the work rejects in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "rej")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with TimeoutError when the work never settles", async () => {
    const hang = new Promise<never>(() => {}); // never settles
    const err = await withTimeout(hang, 20, "hang").catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).label).toBe("hang");
    expect((err as TimeoutError).timeoutMs).toBe(20);
  });

  it("disables the guard for a non-positive budget (returns the work untouched)", async () => {
    // 0/negative means "no wall clock" — used to make the opt-out testable.
    await expect(withTimeout(Promise.resolve("x"), 0, "off")).resolves.toBe("x");
    const hang = new Promise<never>(() => {});
    const race = Promise.race([
      withTimeout(hang, 0, "off"),
      new Promise((r) => setTimeout(() => r("still-pending"), 20)),
    ]);
    await expect(race).resolves.toBe("still-pending");
  });
});
