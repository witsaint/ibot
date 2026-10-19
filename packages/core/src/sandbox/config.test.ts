import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSandboxConfig } from "./config.js";

const OK_URL = "https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-internal";

describe("loadSandboxConfig", () => {
  it("accepts a well-formed env and exposes SDK connection opts (apiUrl, no domain)", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_CHANNEL_SLUG: "ppio-sandbox-internal",
    });
    const opts = cfg.sdkConnectionOpts();
    expect(opts).toEqual({ apiKey: "k-123", apiUrl: OK_URL });
    // the SDK-domain trap: we override apiUrl, never domain
    expect(opts).not.toHaveProperty("domain");
    expect(cfg.channelSlug).toBe("ppio-sandbox-internal");
  });

  it("rejects a control-plane URL missing the channel slug (/c/) — the 409 trap", () => {
    expect(() =>
      loadSandboxConfig({
        AIPROXY_API_KEY: "k-123",
        SANDBOX_CONTROL_PLANE_URL: "https://apiproxy.paigod.work/sandbox",
      }),
    ).toThrow(/channel slug/);
  });

  it("rejects a missing api key", () => {
    expect(() => loadSandboxConfig({ SANDBOX_CONTROL_PLANE_URL: OK_URL })).toThrow(
      /AIPROXY_API_KEY/,
    );
  });

  it("treats the channel slug as optional", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
    });
    expect(cfg.channelSlug).toBeUndefined();
  });

  it("SANDBOX_PUBLIC swaps only the /c/{slug} segment to the public egress slug", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_PUBLIC: "true",
    });
    expect(cfg.apiUrl).toBe("https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-public");
    expect(cfg.channelSlug).toBe("ppio-sandbox-public");
    expect(cfg.sdkConnectionOpts().apiUrl).toBe(cfg.apiUrl);
  });

  it("SANDBOX_PUBLIC honours a custom SANDBOX_PUBLIC_SLUG override", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_PUBLIC: "1",
      SANDBOX_PUBLIC_SLUG: "ppio-sandbox-edge",
    });
    expect(cfg.apiUrl).toBe("https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-edge");
    expect(cfg.channelSlug).toBe("ppio-sandbox-edge");
  });

  it("leaves the URL untouched when SANDBOX_PUBLIC is unset or falsy", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_PUBLIC: "false",
    });
    expect(cfg.apiUrl).toBe(OK_URL);
    expect(cfg.defaultPublic).toBe(false);
  });

  describe("per-bot channel resolution", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_CHANNEL_SLUG: "ppio-sandbox-internal",
    });

    it("channelSlugFor maps true→public, false→internal", () => {
      expect(cfg.channelSlugFor(true)).toBe("ppio-sandbox-public");
      expect(cfg.channelSlugFor(false)).toBe("ppio-sandbox-internal");
    });

    it("channelSlugFor(null) inherits the fleet default (internal here)", () => {
      expect(cfg.channelSlugFor(null)).toBe("ppio-sandbox-internal");
      expect(cfg.channelSlugFor(undefined)).toBe("ppio-sandbox-internal");
    });

    it("channelSlugFor(null) inherits a public fleet default", () => {
      const pub = loadSandboxConfig({
        AIPROXY_API_KEY: "k-123",
        SANDBOX_CONTROL_PLANE_URL: OK_URL,
        SANDBOX_PUBLIC: "true",
      });
      expect(pub.channelSlugFor(null)).toBe("ppio-sandbox-public");
      expect(pub.defaultPublic).toBe(true);
    });

    it("sdkConnectionOpts(slug) rebuilds the URL from the raw base for an explicit channel", () => {
      expect(cfg.sdkConnectionOpts("ppio-sandbox-public").apiUrl).toBe(
        "https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-public",
      );
      // no slug → env-default apiUrl (an old box with no persisted channel)
      expect(cfg.sdkConnectionOpts().apiUrl).toBe(OK_URL);
    });
  });

  describe("baseImageFor (per-channel stock base)", () => {
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_CHANNEL_SLUG: "ppio-sandbox-internal",
    });

    it("keeps the template's own base on the internal channel", () => {
      expect(cfg.baseImageFor("e2b/base", "ppio-sandbox-internal")).toBe("e2b/base");
    });

    it("swaps in the verified public base on the public channel (public lacks e2b/base)", () => {
      expect(cfg.baseImageFor("e2b/base", "ppio-sandbox-public")).toBe("xf3sz12wrms461c4h5dt");
    });

    it("honours a custom SANDBOX_PUBLIC_BASE_IMAGE override for the public channel", () => {
      const custom = loadSandboxConfig({
        AIPROXY_API_KEY: "k-123",
        SANDBOX_CONTROL_PLANE_URL: OK_URL,
        SANDBOX_PUBLIC_BASE_IMAGE: "my-public-base",
      });
      expect(custom.baseImageFor("e2b/base", "ppio-sandbox-public")).toBe("my-public-base");
      expect(custom.baseImageFor("e2b/base", "ppio-sandbox-internal")).toBe("e2b/base");
    });

    it("a slug-less create follows the fleet default (internal here → template base)", () => {
      expect(cfg.baseImageFor("e2b/base")).toBe("e2b/base");
    });

    it("a slug-less create on a public fleet default gets the public base", () => {
      const pub = loadSandboxConfig({
        AIPROXY_API_KEY: "k-123",
        SANDBOX_CONTROL_PLANE_URL: OK_URL,
        SANDBOX_PUBLIC: "true",
      });
      expect(pub.baseImageFor("e2b/base")).toBe("xf3sz12wrms461c4h5dt");
    });
  });

  describe("warpFor (clean browser egress per channel)", () => {
    // Public channel = datacenter egress IP → Cloudflare challenges it hard → browser goes through
    // WARP. Internal channel = where corporate-internal hosts live → direct, WARP would hide them.
    const cfg = loadSandboxConfig({
      AIPROXY_API_KEY: "k-123",
      SANDBOX_CONTROL_PLANE_URL: OK_URL,
      SANDBOX_CHANNEL_SLUG: "ppio-sandbox-internal",
    });

    it("is on for the public channel and off for internal", () => {
      expect(cfg.warpFor("ppio-sandbox-public")).toBe(true);
      expect(cfg.warpFor("ppio-sandbox-internal")).toBe(false);
    });

    it("a slug-less box follows the fleet default (internal here → off)", () => {
      expect(cfg.warpFor()).toBe(false);
    });

    it("a slug-less box on a public fleet default is on", () => {
      const pub = loadSandboxConfig({
        AIPROXY_API_KEY: "k-123",
        SANDBOX_CONTROL_PLANE_URL: OK_URL,
        SANDBOX_PUBLIC: "true",
      });
      expect(pub.warpFor()).toBe(true);
    });

    it("tracks a custom public slug, same resolution as baseImageFor", () => {
      const custom = loadSandboxConfig({
        AIPROXY_API_KEY: "k-123",
        SANDBOX_CONTROL_PLANE_URL: OK_URL,
        SANDBOX_PUBLIC_SLUG: "my-public",
      });
      expect(custom.warpFor("my-public")).toBe(true);
      expect(custom.warpFor("ppio-sandbox-public")).toBe(false);
    });
  });

  describe("bootstrapSdkEnv", () => {
    const saved = { ppio: process.env.PPIO_API_KEY, e2b: process.env.E2B_API_KEY };
    beforeEach(() => {
      delete process.env.PPIO_API_KEY;
      delete process.env.E2B_API_KEY;
    });
    afterEach(() => {
      process.env.PPIO_API_KEY = saved.ppio;
      process.env.E2B_API_KEY = saved.e2b;
    });

    it("mirrors the AIProxy key into PPIO_API_KEY and E2B_API_KEY", () => {
      const cfg = loadSandboxConfig({
        AIPROXY_API_KEY: "k-xyz",
        SANDBOX_CONTROL_PLANE_URL: OK_URL,
      });
      cfg.bootstrapSdkEnv();
      expect(process.env.PPIO_API_KEY).toBe("k-xyz");
      expect(process.env.E2B_API_KEY).toBe("k-xyz");
    });
  });
});
