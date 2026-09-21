/**
 * Full-stack live smoke test against the RUNNING servers (api:8787 + web:3001),
 * shaped exactly like the browser: every call carries the web Origin and a cookie jar,
 * so it exercises CORS + credentialed better-auth the same way apps/web does.
 *
 * Proves, end to end:
 *   1. web is serving (GET / , /login → 200)
 *   2. cross-origin credentialed sign-up works (CORS + better-auth CSRF/Origin)
 *   3. session cookie authenticates /api/me and /api/bots
 *   4. bot create → sandbox provision → poll to active → noVNC preview URL reachable off-box
 *   5. the CHAT MODEL LOOP: create conversation, stream a turn through the AIProxy gateway
 *      (Anthropic Messages), assert assistant text comes back and is persisted.
 *
 * Run: pnpm --filter @i-bot/api exec tsx scripts/verify-web-e2e.ts
 * (servers must already be up; DB migrated; .env has DATABASE_URL/ANTHROPIC_* etc.)
 */

const API = "http://localhost:8787";
const WEB = "http://localhost:3001";
const ORIGIN = WEB; // browser Origin for every api call

// The user's "own" model key, as they'd type it into Settings. Read from env so it never
// lands in source (this is the chat/model key; the sandbox key is a separate system).
const USER_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const USER_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "";

/**
 * The client-side "take control" transform (mirror of DesktopPanel.withInteractivity).
 * noVNC's vnc_lite.html reads `view_only` as a raw string and any present value is truthy —
 * so interactivity requires REMOVING the param, not setting it to "false".
 */
function takeControlUrl(streamUrl: string): string {
  const u = new URL(streamUrl);
  u.searchParams.delete("view_only");
  return u.toString();
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

// --- tiny cookie jar (mimics the browser) ---
let cookie = "";
function absorb(res: Response) {
  const set = res.headers.get("set-cookie");
  if (set) {
    // keep just the name=value pairs
    const pairs = set.split(/,(?=[^ ;]+=)/).map((c) => c.split(";")[0].trim());
    const jar = new Map(cookie ? cookie.split("; ").map((c) => [c.split("=")[0], c] as const) : []);
    for (const p of pairs) jar.set(p.split("=")[0], p);
    cookie = [...jar.values()].join("; ");
  }
}
async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  absorb(res);
  return res;
}

async function main() {
  const email = `web-e2e-${Date.now()}@example.com`;
  let botId = "";

  try {
    // 1) web is serving
    console.log("→ web serving?");
    /* eslint-disable no-await-in-loop -- sequential probes, order matters for readable output */
    for (const p of ["/", "/login"]) {
      const r = await fetch(`${WEB}${p}`);
      assert(r.ok, `web ${p} not ok (${r.status})`);
    }
    /* eslint-enable no-await-in-loop */
    console.log("  ✅ web /, /login → 200");

    // 2) cross-origin credentialed sign-up (CORS preflight + better-auth)
    console.log("→ CORS preflight on /api/auth/sign-up/email");
    const pre = await fetch(`${API}/api/auth/sign-up/email`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    const allow = pre.headers.get("access-control-allow-origin");
    console.log(
      `  preflight ${pre.status}, allow-origin=${allow}, allow-credentials=${pre.headers.get("access-control-allow-credentials")}`,
    );
    assert(allow === ORIGIN, `CORS allow-origin should echo ${ORIGIN}, got ${allow}`);

    // Node's fetch ignores CORS, so a browser-only bug (a verb missing from allow-methods)
    // sails past every other check here. Assert the preflight explicitly advertises the verbs
    // the UI actually uses — PUT (settings save, desktop take-control) was the one that bit us.
    console.log("→ CORS allow-methods must cover the verbs the browser sends");
    const methodsPre = await fetch(`${API}/api/settings/credentials`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    const allowMethods = (
      methodsPre.headers.get("access-control-allow-methods") ?? ""
    ).toUpperCase();
    console.log(`  allow-methods=${allowMethods}`);
    for (const verb of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert(
        allowMethods.includes(verb),
        `CORS allow-methods missing ${verb} — browser will block it`,
      );
    }

    console.log("→ sign up (cross-origin, credentialed)");
    const su = await call("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: "Web E2E" }),
    });
    assert(su.ok, `sign-up failed (${su.status}: ${await su.text()})`);
    assert(cookie.length > 0, "no session cookie set after sign-up");
    console.log("  ✅ signed up, session cookie set");

    // 3) session authenticates /api/me
    const me = await call("/api/me");
    assert(me.ok, `/api/me failed (${me.status})`);
    const meBody = await me.json();
    console.log("  ✅ /api/me →", meBody.user?.email ?? meBody.email ?? "(user)");

    // 3b) multi-tenant key gate: no credential yet → settings reads unconfigured
    console.log("→ settings: credential should be unconfigured for a fresh user");
    const cred0 = await call("/api/settings/credentials");
    assert(cred0.ok, `GET credentials failed (${cred0.status})`);
    const cred0Body = (await cred0.json()).credentials;
    assert(cred0Body.configured === false, "fresh user should have no stored credential");
    console.log("  ✅ no credential stored");

    // 4) create bot (needed to prove the 503 gate uses the OWNER's missing key)
    console.log("→ create bot");
    const cb = await call("/api/bots", {
      method: "POST",
      body: JSON.stringify({
        name: "Web E2E Bot",
        systemPrompt: "You are a helpful test bot. Keep replies short.",
      }),
    });
    assert(cb.status === 201, `create bot failed (${cb.status})`);
    const bot = (await cb.json()).bot;
    botId = bot.id;
    console.log(`  botId=${botId}, model=${bot.model}`);
    assert(
      bot.model === "pa/claude-opus-5-ppinfra",
      `expected opus-5 gateway model, got ${bot.model}`,
    );

    // 4b) 503 gate: chatting before the owner stores a key must be refused (no_model_key).
    // This check runs BEFORE the sandbox handle, so no provisioning is needed to prove it.
    console.log("→ create conversation");
    const cc = await call(`/api/chat/bots/${botId}/conversations`, { method: "POST" });
    assert(cc.ok, `create conversation failed (${cc.status})`);
    const conversationId = (await cc.json()).conversation.id;
    console.log("  conversationId=", conversationId);

    console.log("→ chat WITHOUT a stored key must 503 no_model_key");
    const gated = await call(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    });
    assert(gated.status === 503, `expected 503 before key stored, got ${gated.status}`);
    const gatedBody = await gated.json().catch(() => ({}));
    assert(
      gatedBody.error === "no_model_key",
      `expected no_model_key, got ${JSON.stringify(gatedBody)}`,
    );
    console.log("  ✅ chat correctly gated (503 no_model_key)");

    // 4c) the user stores their OWN key (encrypted at rest); GET then reflects it (masked).
    assert(
      USER_API_KEY.length >= 8,
      "ANTHROPIC_API_KEY missing from env — can't simulate user key entry",
    );
    console.log("→ store the user's own model key via settings");
    const putCred = await call("/api/settings/credentials", {
      method: "PUT",
      body: JSON.stringify({
        apiKey: USER_API_KEY,
        baseUrl: USER_BASE_URL || null,
        defaultModel: "pa/claude-opus-5-ppinfra",
      }),
    });
    if (!putCred.ok)
      throw new Error(`PUT credentials failed (${putCred.status}: ${await putCred.text()})`);
    const putBody = (await putCred.json()).credentials;
    assert(putBody.configured === true, "credential should read configured after PUT");
    assert(
      !JSON.stringify(putBody).includes(USER_API_KEY),
      "SECURITY: settings echoed the plaintext key",
    );
    console.log(`  ✅ key stored (masked hint=${putBody.keyHint}), plaintext never returned`);

    // 4d) update baseUrl/model WITHOUT resending the key — the stored key must be kept.
    console.log("→ update settings without re-sending the key (keeps stored key)");
    const putNoKey = await call("/api/settings/credentials", {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: USER_BASE_URL || null,
        defaultModel: "pa/claude-sonnet-5-ppinfra",
      }),
    });
    if (!putNoKey.ok)
      throw new Error(`keyless PUT failed (${putNoKey.status}: ${await putNoKey.text()})`);
    const noKeyBody = (await putNoKey.json()).credentials;
    assert(noKeyBody.configured === true, "credential must stay configured after a keyless update");
    assert(
      noKeyBody.keyHint === putBody.keyHint,
      "keyless update must preserve the stored key hint",
    );
    assert(
      noKeyBody.defaultModel === "pa/claude-sonnet-5-ppinfra",
      "keyless update should change the model",
    );
    console.log(`  ✅ keyless update kept the key (hint=${noKeyBody.keyHint}), model updated`);

    console.log("→ provision sandbox");
    const prov = await call(`/api/bots/${botId}/sandbox`, { method: "POST" });
    assert(prov.ok, `provision kick failed (${prov.status})`);

    console.log("→ poll to active (~210s — desktop stack adds apt time)");
    const deadline = Date.now() + 210_000;
    let view: { state: string; streamUrl: string | null } | null = null;
    /* eslint-disable no-await-in-loop -- polling is inherently sequential */
    while (Date.now() < deadline) {
      const s = await call(`/api/bots/${botId}/sandbox`);
      view = (await s.json()).sandbox;
      process.stdout.write(`\r  state=${view?.state}    `);
      if (view?.state === "active") break;
      if (view?.state === "kill") throw new Error("sandbox errored (state=kill)");
      await new Promise((r) => setTimeout(r, 3000));
    }
    /* eslint-enable no-await-in-loop */
    console.log();
    assert(view?.state === "active", `sandbox not active (last=${view?.state})`);
    assert(view.streamUrl, "no streamUrl on active sandbox");
    console.log("  ✅ sandbox active — preview:", view.streamUrl);

    const prev = await fetch(view.streamUrl, { signal: AbortSignal.timeout(15_000) });
    assert(prev.ok, `preview not reachable (${prev.status})`);
    console.log(`  ✅ noVNC preview reachable off-box → HTTP ${prev.status}`);

    // take-control: the read-only preview becomes interactive by REMOVING view_only (a present
    // value — even "false" — is truthy in vnc_lite.html and keeps the client read-only).
    assert(view.streamUrl.includes("view_only=true"), "preview URL should start read-only");
    const control = takeControlUrl(view.streamUrl);
    assert(
      !/[?&]view_only=/.test(control),
      "take-control URL must DROP view_only entirely, not set it false",
    );
    const controlRes = await fetch(control, { signal: AbortSignal.timeout(15_000) });
    assert(controlRes.ok, `take-control preview not reachable (${controlRes.status})`);
    console.log(`  ✅ take-control URL reachable (view_only dropped) → HTTP ${controlRes.status}`);

    // 5) the chat model loop through the gateway, now on the user's own key
    console.log("→ stream a chat turn (through AIProxy → claude-opus-5, user's key)");
    const chat = await call(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: "Reply with exactly the three words: sandbox is live" }],
      }),
    });
    console.log(
      `  chat POST → HTTP ${chat.status}, content-type=${chat.headers.get("content-type")}`,
    );
    // Read the body exactly once on each path (reading it twice throws "Body already read").
    if (!chat.ok) {
      const errText = await chat.text();
      throw new Error(`chat failed (${chat.status}: ${errText.slice(0, 300)})`);
    }
    // drain the UI message stream; collect any assistant text deltas
    const text = await chat.text();
    const hasText = /sandbox|live/i.test(text);
    console.log("  stream bytes:", text.length, "| contains expected words:", hasText);
    assert(text.length > 0, "empty chat stream");

    // confirm persistence: the assistant message landed in the thread
    const msgs = await call(`/api/chat/conversations/${conversationId}/messages`);
    const list = (await msgs.json()).messages ?? [];
    const roles = list.map((m: { role: string }) => m.role);
    console.log("  persisted roles:", roles.join(", "));
    assert(roles.includes("assistant"), "assistant message not persisted");
    console.log("  ✅ chat model loop worked end-to-end + persisted");

    // 6) BACKGROUND job: kick off a detached turn, prove single-flight (409 while it runs),
    //    then poll to completion and confirm its assistant output persisted.
    console.log("→ start a BACKGROUND agent turn");
    const assistantBefore = roles.filter((r: string) => r === "assistant").length;
    const startJob = await call(`/api/chat/conversations/${conversationId}/jobs`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: "Reply with exactly the two words: background works" }],
      }),
    });
    assert(startJob.status === 202, `expected 202 starting a job, got ${startJob.status}`);
    const { jobId } = await startJob.json();
    assert(typeof jobId === "string" && jobId.length > 0, "job start returned no jobId");
    console.log("  jobId=", jobId);

    // single-flight: a foreground turn AND a second job must both be refused while it runs
    const fgBusy = await call(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    assert(
      fgBusy.status === 409,
      `expected 409 (busy) foreground while job runs, got ${fgBusy.status}`,
    );
    const jobBusy = await call(`/api/chat/conversations/${conversationId}/jobs`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    assert(
      jobBusy.status === 409,
      `expected 409 (busy) second job while one runs, got ${jobBusy.status}`,
    );
    console.log("  ✅ single-flight held (foreground + second job both 409'd)");

    // poll the job to a terminal state
    let jobState: {
      job: { status: string; error: string | null } | null;
      running: boolean;
    } | null = null;
    /* eslint-disable no-await-in-loop -- polling is inherently sequential */
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const jr = await call(`/api/chat/conversations/${conversationId}/jobs/active`);
      jobState = await jr.json();
      if (jobState && !jobState.running && jobState.job?.status !== "running") break;
      if (i % 5 === 0)
        console.log(`  …job status=${jobState?.job?.status} running=${jobState?.running}`);
    }
    /* eslint-enable no-await-in-loop */
    assert(
      jobState?.job?.status === "done",
      `job not done (last=${JSON.stringify(jobState?.job)})`,
    );
    console.log("  ✅ background job reached status=done");

    // its assistant output persisted (one more assistant message than before)
    const msgs2 = await call(`/api/chat/conversations/${conversationId}/messages`);
    const list2 = (await msgs2.json()).messages ?? [];
    const assistantAfter = list2.filter((m: { role: string }) => m.role === "assistant").length;
    assert(
      assistantAfter > assistantBefore,
      `background job produced no new assistant message (${assistantBefore} → ${assistantAfter})`,
    );
    console.log("  ✅ background job output persisted to the transcript");

    console.log("\n🎉 FULL-STACK WEB E2E PASSED");
  } finally {
    if (botId) {
      console.log("→ cleanup: delete bot (+ destroy sandbox)");
      await call(`/api/bots/${botId}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌", err instanceof Error ? err.message : err);
    process.exit(1);
  });
