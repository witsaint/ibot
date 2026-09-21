/**
 * Real end-to-end verification of the sandbox layer against a live AIProxy channel.
 * The 承重 proof that runtime provisioning + provider + executors work through the
 * gateway. `provider.create()` now provisions the desktop stack (~90s) before returning.
 * Requires a live key — see env below.
 *
 * Run: `pnpm --filter @i-bot/core verify:sandbox`
 * Env: AIPROXY_API_KEY, SANDBOX_CONTROL_PLANE_URL (incl. /c/{slug}); optional SANDBOX_CHANNEL_SLUG.
 *
 * Flow (destroy guaranteed in finally):
 *   create (=create base + runtime provision) → envd /health → screenshot (PNG magic)
 *   → desktop write smoke → CDP connectBrowser → navigate example.com → read_dom asserts title
 *   → finally destroy.
 */
import { createLogger } from "@i-bot/logger";
import {
  connectBrowser,
  DESKTOP,
  loadSandboxConfig,
  PpioSandboxProvider,
  type SandboxHandle,
} from "../src/index.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "verify-sandbox" });
  const config = loadSandboxConfig();
  const provider = new PpioSandboxProvider({ config, logger });

  const rowId = `verify-${Date.now()}`;
  let handle: SandboxHandle | undefined;

  try {
    console.log("→ creating sandbox…");
    handle = await provider.create({
      sandboxRowId: rowId,
      botId: rowId,
      templateKey: DESKTOP.key,
    });
    console.log(`  handle.id=${handle.id} providerSandboxId=${handle.providerSandboxId}`);
    console.log(`  meta=${JSON.stringify(handle.meta)}`);

    // envd health — GET {envd host}/health should be 204
    const envdHost = handle.getHost(DESKTOP.ports.envd);
    console.log(`→ envd health: https://${envdHost}/health`);
    const health = await fetch(`https://${envdHost}/health`);
    console.log(`  status=${health.status}`);
    assert(health.status === 204 || health.ok, `envd health not green (${health.status})`);

    // screenshot — assert PNG magic + non-trivial length
    console.log("→ screenshot()…");
    const shot = await handle.screenshot();
    assert(shot.length > 1000, `screenshot too small (${shot.length} bytes)`);
    for (let i = 0; i < PNG_MAGIC.length; i++) {
      assert(shot[i] === PNG_MAGIC[i], `screenshot is not a PNG (byte ${i})`);
    }
    console.log(`  ok — ${shot.length} bytes, PNG magic present`);

    // desktop write smoke — a harmless keystroke into the desktop
    console.log("→ desktop write smoke…");
    const { executeDesktopAction } = await import("../src/index.js");
    const wrote = await executeDesktopAction(handle, { type: "write", text: "hello ibot" });
    assert(wrote.ok, `desktop write failed: ${wrote.error}`);
    console.log("  ok");

    // CDP browser — the load-bearing proof that Chrome's remote-debugging is reachable
    console.log(`→ CDP connectBrowser (port ${DESKTOP.ports.cdp})…`);
    const browser = await connectBrowser(handle);
    try {
      const nav = await browser.execute({ type: "navigate", url: "https://example.com/" });
      assert(nav.ok, `navigate failed: ${nav.error}`);
      const dom = await browser.execute({ type: "read_dom" });
      assert(dom.ok && dom.text, "read_dom returned no text");
      assert(/Example Domain/i.test(dom.text ?? ""), "example.com title not found in DOM");
      console.log("  ok — navigated + read expected title over CDP");
    } finally {
      await browser.close();
    }

    console.log("\n✅ sandbox layer E2E passed.");
  } finally {
    if (handle) {
      console.log("→ destroy…");
      await handle.destroy();
      console.log("  destroyed");
    }
  }
}

main().catch((err: unknown) => {
  console.error("\n❌ verify-sandbox failed.");
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
