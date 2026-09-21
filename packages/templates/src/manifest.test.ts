import { describe, expect, it } from "vitest";
import { DESKTOP, getTemplate, TEMPLATES } from "./manifest.js";

describe("getTemplate", () => {
  it("resolves a known template by key", () => {
    expect(getTemplate("desktop")).toBe(DESKTOP);
  });

  it("throws loudly on an unknown key (fail fast, not silent)", () => {
    expect(() => getTemplate("nope")).toThrow(/Unknown sandbox template: nope/);
  });
});

describe("DESKTOP manifest", () => {
  it("is registered under its own key", () => {
    expect(TEMPLATES[DESKTOP.key]).toBe(DESKTOP);
  });

  it("exposes the boot-service ports the getHost URLs depend on (incl. the CDP proxy)", () => {
    expect(DESKTOP.ports).toEqual({
      cdp: 9222,
      cdpProxy: 9223,
      vnc: 5900,
      novnc: 6080,
      envd: 49983,
    });
  });

  it("has no custom templateId (gateway blocks builds) and provisions on a base image", () => {
    expect(DESKTOP.templateId).toBeNull();
    expect(DESKTOP.name).toBe("ibot-desktop");
    expect(DESKTOP.baseImage).toBe("e2b/base");
  });
});
