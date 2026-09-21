import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "../index.js";
import {
  type CdpConnection,
  type FetchJson,
  type PageLike,
  connectBrowser,
  resolveCdpWsEndpoint,
} from "./browser-executor.js";

function fakeHandle(): SandboxHandle {
  return {
    id: "row-1",
    provider: "ppio",
    providerSandboxId: "sbx-1",
    meta: {},
    getHost: (port) => `${port}-sbx-1.sandbox.example`,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    screenshot: async () => new Uint8Array(),
    detach: () => {},
    destroy: async () => {},
  };
}

/** Fake /json/version fetch: returns Chrome's internal ws URL (which we must rewrite). */
const fakeFetchJson: FetchJson = async () => ({
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123",
});

function fakePage(overrides: Partial<PageLike> = {}): PageLike {
  return {
    goto: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    content: vi.fn(async () => "<html>full</html>"),
    innerHTML: vi.fn(async () => "<div>frag</div>"),
    screenshot: vi.fn(async () => new Uint8Array([0x89, 0x50])),
    waitForSelector: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function session(page: PageLike) {
  const dispose = vi.fn(async () => undefined);
  const conn: CdpConnection = { page, dispose };
  const s = await connectBrowser(fakeHandle(), async () => conn, fakeFetchJson);
  return { s, dispose };
}

describe("resolveCdpWsEndpoint — endpoint derivation", () => {
  it("fetches /json/version through the cdpProxy port (9223) host, over https", async () => {
    const fetchJson = vi.fn(fakeFetchJson);
    await resolveCdpWsEndpoint(fakeHandle(), fetchJson);
    expect(fetchJson).toHaveBeenCalledWith("https://9223-sbx-1.sandbox.example/json/version");
  });

  it("rebuilds the ws URL against the proxy host (drops Chrome's internal 127.0.0.1 host)", async () => {
    const wsUrl = await resolveCdpWsEndpoint(fakeHandle(), fakeFetchJson);
    expect(wsUrl).toBe("wss://9223-sbx-1.sandbox.example/devtools/browser/abc-123");
  });

  it("throws when /json/version has no webSocketDebuggerUrl", async () => {
    await expect(resolveCdpWsEndpoint(fakeHandle(), async () => ({}))).rejects.toThrow(
      /no webSocketDebuggerUrl/,
    );
  });
});

describe("connectBrowser — endpoint derivation", () => {
  it("passes the constructed wss endpoint to the connector", async () => {
    const connector = vi.fn(async (_url: string) => ({
      page: fakePage(),
      dispose: async () => {},
    }));
    await connectBrowser(fakeHandle(), connector, fakeFetchJson);
    expect(connector).toHaveBeenCalledWith(
      "wss://9223-sbx-1.sandbox.example/devtools/browser/abc-123",
    );
  });
});

describe("BrowserSession.execute — mappings", () => {
  it("navigate goes to the url waiting for domcontentloaded", async () => {
    const page = fakePage();
    const { s } = await session(page);
    const res = await s.execute({ type: "navigate", url: "https://example.com/" });
    expect(res.ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith("https://example.com/", {
      waitUntil: "domcontentloaded",
    });
  });

  it("click / fill forward selector (and value)", async () => {
    const page = fakePage();
    const { s } = await session(page);
    await s.execute({ type: "click", selector: "#go" });
    await s.execute({ type: "fill", selector: "#q", value: "hello" });
    expect(page.click).toHaveBeenCalledWith("#go");
    expect(page.fill).toHaveBeenCalledWith("#q", "hello");
  });

  it("read_dom with a selector returns innerHTML; without one returns full content", async () => {
    const page = fakePage();
    const { s } = await session(page);
    const withSel = await s.execute({ type: "read_dom", selector: "#main" });
    expect(withSel).toEqual({ ok: true, text: "<div>frag</div>" });
    const whole = await s.execute({ type: "read_dom" });
    expect(whole).toEqual({ ok: true, text: "<html>full</html>" });
  });

  it("screenshot returns base64 of the page bytes", async () => {
    const page = fakePage();
    const { s } = await session(page);
    const res = await s.execute({ type: "screenshot" });
    expect(res).toEqual({ ok: true, screenshot: Buffer.from([0x89, 0x50]).toString("base64") });
  });

  it("wait_for passes the timeout", async () => {
    const page = fakePage();
    const { s } = await session(page);
    await s.execute({ type: "wait_for", selector: "#ready", timeoutMs: 5000 });
    expect(page.waitForSelector).toHaveBeenCalledWith("#ready", { timeout: 5000 });
  });
});

describe("BrowserSession — errors + lifecycle", () => {
  it("maps a thrown action to {ok:false, error}", async () => {
    const page = fakePage({
      click: vi.fn(async () => {
        throw new Error("no such element");
      }),
    });
    const { s } = await session(page);
    const res = await s.execute({ type: "click", selector: "#missing" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no such element");
  });

  it("close() disposes the CDP connection (does not touch the box)", async () => {
    const page = fakePage();
    const { s, dispose } = await session(page);
    await s.close();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
