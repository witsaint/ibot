/**
 * Guards the base-URL normalization that keeps the agent loop pointed at the gateway's
 * `/v1/messages`. A base URL without `/v1` (a bare origin, or an ambient env var that
 * dropped the segment) previously made the SDK POST to `/messages` → `403 forbidden`.
 */
import { describe, expect, it } from "vitest";
import { normalizeGatewayBaseURL } from "./model.js";

describe("normalizeGatewayBaseURL", () => {
  it("appends /v1 to a bare origin", () => {
    expect(normalizeGatewayBaseURL("https://apiproxy.paigod.work")).toBe(
      "https://apiproxy.paigod.work/v1",
    );
  });

  it("leaves an existing /v1 in place", () => {
    expect(normalizeGatewayBaseURL("https://apiproxy.paigod.work/v1")).toBe(
      "https://apiproxy.paigod.work/v1",
    );
  });

  it("strips a trailing slash before appending", () => {
    expect(normalizeGatewayBaseURL("https://apiproxy.paigod.work/")).toBe(
      "https://apiproxy.paigod.work/v1",
    );
  });

  it("treats a trailing-slashed /v1 as already versioned", () => {
    expect(normalizeGatewayBaseURL("https://apiproxy.paigod.work/v1/")).toBe(
      "https://apiproxy.paigod.work/v1",
    );
  });

  it("honors any versioned suffix, not just v1", () => {
    expect(normalizeGatewayBaseURL("https://example.test/v2")).toBe("https://example.test/v2");
  });

  it("appends /v1 when the path is not a version segment", () => {
    expect(normalizeGatewayBaseURL("https://example.test/gateway")).toBe(
      "https://example.test/gateway/v1",
    );
  });
});
