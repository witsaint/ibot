/**
 * End-to-end verification of the API layer against a live Postgres + the live AIProxy
 * gateway. Proves the whole vertical slice the web app depends on:
 *   sign-up (better-auth) → session cookie → create bot → provision sandbox (real box,
 *   ~90s) → poll to `active` → the view-only noVNC preview URL is actually reachable
 *   off-box (this is the "verify execution location incl. web端" proof) → tear down.
 *
 * Env: DATABASE_URL (migrated), AIPROXY_API_KEY, SANDBOX_CONTROL_PLANE_URL, plus
 * BETTER_AUTH_SECRET/URL. Run via tsx with --env-file for the sandbox creds.
 */
import { serve } from "@hono/node-server";
import { buildContext } from "../src/context.js";
import { loadApiEnv } from "../src/env.js";
import { createServer } from "../src/server.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const env = loadApiEnv();
  const ctx = buildContext(env);
  const app = createServer(ctx);
  const port = 8791;
  const server = serve({ fetch: app.fetch, port });
  const base = `http://localhost:${port}`;
  console.log(`→ api up on ${base}`);

  let cookie = "";
  let botId = "";
  try {
    // 1) sign up (better-auth email+password) → capture session cookie
    const email = `verify+${Date.now()}@ibot.test`;
    console.log("→ sign-up…");
    const su = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email, password: "verify-pw-12345", name: "Verify User" }),
    });
    assert(su.ok, `sign-up failed (${su.status}): ${await su.text()}`);
    cookie = su.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    assert(cookie.length > 0, "no session cookie from sign-up");
    console.log("  ok — session established");

    const authed = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin: base,
          cookie,
          ...(init.headers ?? {}),
        },
      });

    // 2) /api/me
    const me = await authed("/api/me");
    assert(me.ok, `/api/me not ok (${me.status})`);
    console.log("  /api/me →", await me.json());

    // 3) create a bot
    console.log("→ create bot…");
    const created = await authed("/api/bots", {
      method: "POST",
      body: JSON.stringify({ name: "Verify Bot", systemPrompt: "You are a test bot." }),
    });
    assert(created.status === 201, `create bot failed (${created.status})`);
    botId = (await created.json()).bot.id;
    console.log("  botId =", botId);

    // 4) provision the sandbox (returns immediately in `create`)
    console.log("→ provision sandbox…");
    const prov = await authed(`/api/bots/${botId}/sandbox`, { method: "POST" });
    assert(prov.ok, `provision kick failed (${prov.status})`);
    console.log("  initial state:", (await prov.json()).sandbox.state);

    // 5) poll to active (~90s), then confirm the preview URL
    console.log("→ polling sandbox status (up to ~150s)…");
    const deadline = Date.now() + 150_000;
    let view: { state: string; streamUrl: string | null } | null = null;
    /* eslint-disable no-await-in-loop -- polling is inherently sequential: each check depends on the previous state + delay */
    while (Date.now() < deadline) {
      const s = await authed(`/api/bots/${botId}/sandbox`);
      view = (await s.json()).sandbox;
      process.stdout.write(`\r  state=${view?.state} `);
      if (view?.state === "active") break;
      if (view?.state === "kill") throw new Error("sandbox provisioning errored (state=kill)");
      await new Promise((r) => setTimeout(r, 3000));
    }
    /* eslint-enable no-await-in-loop */
    console.log();
    assert(view?.state === "active", `sandbox did not reach active (last=${view?.state})`);
    assert(view.streamUrl, "no streamUrl on active sandbox");
    console.log("  ✅ sandbox active — preview:", view.streamUrl);

    // 6) the web端 proof: the noVNC preview URL is reachable off-box
    console.log("→ fetching preview URL (noVNC vnc.html)…");
    const preview = await fetch(view.streamUrl, { signal: AbortSignal.timeout(15_000) });
    console.log(`  preview HTTP ${preview.status}`);
    const html = await preview.text();
    assert(preview.ok, `preview not reachable (${preview.status})`);
    assert(/noVNC|vnc|canvas/i.test(html), "preview did not look like a noVNC page");
    console.log("  ✅ live desktop preview reachable from the browser");

    console.log("\n✅ API layer E2E passed.");
  } finally {
    if (botId && cookie) {
      console.log("→ cleanup: delete bot (tears down sandbox)…");
      await fetch(`${base}/api/bots/${botId}`, { method: "DELETE", headers: { cookie } }).catch(
        () => {},
      );
    }
    await ctx.sandboxes.shutdown().catch(() => {});
    server.close();
    console.log("  done");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\n❌ verify-api failed.");
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
