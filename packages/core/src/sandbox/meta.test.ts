import { describe, expect, it } from "vitest";
import { parseProviderMeta, runtimeHost, streamUrl } from "./meta.js";

// A composite providerSandboxId as the SDK produces it: `${sandboxID}-${clientID}`.
const COMPOSITE = "sbx_abc123-client789";
const META = { domain: "sandbox.paigod.work", envdVersion: "0.5.1" };

describe("parseProviderMeta", () => {
  it("accepts a minimal {domain, envdVersion} record", () => {
    expect(parseProviderMeta(META)).toEqual(META);
  });

  it("rejects a record missing the domain", () => {
    expect(() => parseProviderMeta({ envdVersion: "0.5.1" })).toThrow();
  });
});

describe("runtimeHost", () => {
  it("mirrors the SDK's getHost: `${port}-${compositeId}.${domain}`", () => {
    // matches the documented envd host `${port}-${sandboxID}-${clientID}.${domain}`
    // because the composite id already contains -clientID
    expect(runtimeHost(COMPOSITE, META, 49983)).toBe(
      "49983-sbx_abc123-client789.sandbox.paigod.work",
    );
  });

  it("builds the CDP host on port 9222", () => {
    expect(runtimeHost(COMPOSITE, META, 9222)).toBe(
      "9222-sbx_abc123-client789.sandbox.paigod.work",
    );
  });
});

describe("streamUrl", () => {
  it("produces an https view-only noVNC lite URL on port 6080", () => {
    expect(streamUrl(COMPOSITE, META)).toBe(
      "https://6080-sbx_abc123-client789.sandbox.paigod.work/vnc_lite.html?scale=true&view_only=true",
    );
  });
});
