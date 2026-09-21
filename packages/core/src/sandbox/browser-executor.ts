/**
 * Execute `BrowserAction`s over CDP with playwright-core. This is the PREFERRED path
 * for web tasks (fast, stable, coordinate-free); desktop-executor is the fallback for
 * system dialogs / native fields.
 *
 * CONNECTION (live-verified through the AIProxy gateway):
 * Chrome binds CDP to 127.0.0.1 and rejects any Host header that isn't localhost/IP
 * (DNS-rebinding guard), so the gateway-forwarded `<port>-<id>.<domain>` Host is refused
 * on the raw CDP port. The desktop therefore runs an in-box proxy on `cdpProxy` that
 * rewrites Host→localhost. We reach that proxy off-box, fetch `/json/version` to learn
 * the browser's ws path, then connect `wss://<cdpProxyHost><path>` EXPLICITLY — passing
 * the bare https host to connectOverCDP is unreliable (some playwright versions return
 * Chrome's internal ws://127.0.0.1 URL, which is unreachable off-box).
 *
 * Seams for testing: `CdpConnector` (the playwright connect) and `fetchJson` (the
 * /json/version fetch) are both injectable, so the mapping + URL logic unit-tests with
 * no network and no playwright.
 */
import type { ActionResult, BrowserAction } from "@i-bot/types";
import { DESKTOP } from "@i-bot/templates";
import type { SandboxHandle } from "../index.js";

/** The subset of a playwright Page the executor uses. Keeps the test fake tiny. */
export interface PageLike {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" }): Promise<unknown>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  content(): Promise<string>;
  innerHTML(selector: string): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
}

/** A live CDP connection: a ready page plus a disposer that ends the connection. */
export interface CdpConnection {
  page: PageLike;
  /** Disconnect CDP only — MUST NOT kill the box or the in-box Chrome. */
  dispose(): Promise<void>;
}

/** Connects to a CDP ws endpoint URL and yields a reusable page. Injectable for tests. */
export type CdpConnector = (wsEndpointUrl: string) => Promise<CdpConnection>;

/** Fetches JSON from a URL (the /json/version probe). Injectable for tests. */
export type FetchJson = (url: string) => Promise<{ webSocketDebuggerUrl?: string }>;

/** A reusable browser session bound to one sandbox's Chrome. */
export interface BrowserSession {
  execute(action: BrowserAction): Promise<ActionResult>;
  /** Disconnect CDP; leaves the box and its Chrome running. */
  close(): Promise<void>;
}

/** Default connector: playwright-core over a CDP ws endpoint. */
export const defaultCdpConnector: CdpConnector = async (wsEndpointUrl) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(wsEndpointUrl, { timeout: 30_000 });
  // A CDP-attached Chrome already has a default context + page; reuse it, else make one.
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    page: page as PageLike,
    dispose: () => browser.close(),
  };
};

/** Default JSON fetch with a bounded timeout. */
export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as { webSocketDebuggerUrl?: string };
};

/**
 * Resolve the off-box CDP ws endpoint for a sandbox: fetch `/json/version` through the
 * in-box proxy over https, then rebuild the ws URL against the proxy host (Chrome's
 * reported ws host is its internal 127.0.0.1, unreachable off-box).
 */
export async function resolveCdpWsEndpoint(
  handle: SandboxHandle,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<string> {
  const proxyHost = handle.getHost(DESKTOP.ports.cdpProxy);
  const version = await fetchJson(`https://${proxyHost}/json/version`);
  const reported = version.webSocketDebuggerUrl;
  if (!reported) throw new Error(`no webSocketDebuggerUrl from https://${proxyHost}/json/version`);
  const wsPath = new URL(reported).pathname; // /devtools/browser/<guid>
  return `wss://${proxyHost}${wsPath}`;
}

/**
 * Connect a browser session to the sandbox's Chrome. Derives the ws endpoint via the
 * in-box CDP proxy (`cdpProxy` port), then attaches with the injected connector.
 */
export async function connectBrowser(
  handle: SandboxHandle,
  connector: CdpConnector = defaultCdpConnector,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<BrowserSession> {
  const wsUrl = await resolveCdpWsEndpoint(handle, fetchJson);
  const conn = await connector(wsUrl);
  return new PpioBrowserSession(conn);
}

class PpioBrowserSession implements BrowserSession {
  #conn: CdpConnection;
  constructor(conn: CdpConnection) {
    this.#conn = conn;
  }

  async execute(action: BrowserAction): Promise<ActionResult> {
    const page = this.#conn.page;
    try {
      switch (action.type) {
        case "navigate":
          await page.goto(action.url, { waitUntil: "domcontentloaded" });
          return { ok: true };
        case "click":
          await page.click(action.selector);
          return { ok: true };
        case "fill":
          await page.fill(action.selector, action.value);
          return { ok: true };
        case "read_dom": {
          const text = action.selector
            ? await page.innerHTML(action.selector)
            : await page.content();
          return { ok: true, text };
        }
        case "screenshot": {
          const bytes = await page.screenshot();
          return { ok: true, screenshot: Buffer.from(bytes).toString("base64") };
        }
        case "wait_for":
          await page.waitForSelector(action.selector, { timeout: action.timeoutMs });
          return { ok: true };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  close(): Promise<void> {
    return this.#conn.dispose();
  }
}
