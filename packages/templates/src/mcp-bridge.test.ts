/**
 * The stdio→HTTP MCP bridge, exercised as a real process against a real stdio child.
 *
 * This is the one piece of P3 that CANNOT be tested by inspecting strings: it is a script that ships
 * as text and runs in a box, so its correctness is entirely about runtime behaviour — does a
 * JSON-RPC reply find the request that asked for it, does a concurrent pair interleave without
 * crossing, does a dead child fail its waiters instead of hanging them, does the token actually
 * refuse an unauthenticated call. So the test writes the script to a temp file, spawns it with node
 * against a tiny echo MCP server, and speaks HTTP to it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_BRIDGE_JS, MCP_BRIDGE_PATH, MCP_BRIDGE_PORT_BASE } from "./mcp-bridge.js";

/**
 * A minimal stdio JSON-RPC server: replies to `ping` with its params, to `slow` after a delay (so a
 * concurrency test can force replies out of order), and exits on `die`.
 */
const ECHO_SERVER = `
let buf = '';
// A cold-start stall, to model "npx -y <pkg>" fetching before it execs anything that reads stdin.
const STALL_MS = Number(process.env.ECHO_STALL_MS || 0);
const started = Date.now();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  // While "fetching", bytes pile up in the pipe unanswered — exactly npx's behaviour.
  if (Date.now() - started < STALL_MS) return;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === '__ibot_ready__') {                    // the bridge's readiness probe, by its id
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
      continue;
    }
    if (msg.method === 'die') { process.exit(3); }
    if (msg.method === 'notify') { continue; }            // a notification gets no reply
    const reply = () => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { echo: msg.params ?? null, env: process.env.TEST_SECRET ?? null, cwd: process.cwd() },
    }) + '\\n');
    if (msg.method === 'slow') setTimeout(reply, 120); else reply();
  }
});
`;

/** Pick a port unlikely to clash with a parallel test run. */
const PORT = MCP_BRIDGE_PORT_BASE + 900 + Math.floor(Math.random() * 90);
const TOKEN = "test-token-abc";

let dir: string;
let bridge: ChildProcess;

async function post(
  body: unknown,
  headers: Record<string, string> = { "x-ibot-bridge": TOKEN },
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Poll /health until the bridge answers 200, so tests don't race the spawn. */
async function waitHealthy(attempts = 60): Promise<boolean> {
  /* eslint-disable no-await-in-loop */ // a poll loop is sequential by definition
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ibot-bridge-"));
  const bridgePath = join(dir, "ibot-mcp-bridge.js"); // name matters: stopBoxMcp pkills on it
  const serverPath = join(dir, "echo-server.js");
  await writeFile(bridgePath, MCP_BRIDGE_JS, "utf8");
  await writeFile(serverPath, ECHO_SERVER, "utf8");

  bridge = spawn(
    process.execPath,
    [bridgePath, "--port", String(PORT), "--cwd", dir, "--", process.execPath, serverPath],
    { env: { ...process.env, IBOT_BRIDGE_TOKEN: TOKEN, TEST_SECRET: "s3cret" }, stdio: "ignore" },
  );
  const ok = await waitHealthy();
  expect(ok, "bridge never became healthy").toBe(true);
}, 20_000);

afterAll(async () => {
  bridge?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
});

describe("the bridge script", () => {
  it("is written to the path the provision plan ships it at", () => {
    expect(MCP_BRIDGE_PATH).toBe("/opt/ibot-mcp-bridge.js");
    // The name is load-bearing: stopBoxMcp finds the process by matching it in argv.
    expect(MCP_BRIDGE_PATH).toContain("ibot-mcp-bridge");
  });

  it("pairs a reply with the request that asked for it", async () => {
    const { status, json } = await post({ jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } });
    expect(status).toBe(200);
    expect(json).toMatchObject({ id: 1, result: { echo: { a: 1 } } });
  });

  it("keeps concurrent calls from crossing, even when replies come back out of order", async () => {
    // `slow` answers after 120ms, `ping` immediately: the second request's reply arrives FIRST, so a
    // bridge that matched replies positionally instead of by id would hand each caller the other's.
    const [slow, fast] = await Promise.all([
      post({ jsonrpc: "2.0", id: "slow-1", method: "slow", params: { which: "slow" } }),
      post({ jsonrpc: "2.0", id: "fast-1", method: "ping", params: { which: "fast" } }),
    ]);
    expect(slow.json).toMatchObject({ id: "slow-1", result: { echo: { which: "slow" } } });
    expect(fast.json).toMatchObject({ id: "fast-1", result: { echo: { which: "fast" } } });
  });

  it("runs the child in the given cwd and passes its environment through", async () => {
    const { json } = await post({ jsonrpc: "2.0", id: 2, method: "ping" });
    const result = (json as { result: { cwd: string; env: string | null } }).result;
    // The secret reached the child through the bridge's OWN env — never through argv.
    expect(result.env).toBe("s3cret");
    expect(result.cwd).toContain("ibot-bridge-");
  });

  it("accepts a notification with no id and answers 202 without waiting for a reply", async () => {
    const { status } = await post({ jsonrpc: "2.0", method: "notify" });
    expect(status).toBe(202);
  });

  it("refuses a call with no token, and one with the wrong token", async () => {
    const none = await post({ jsonrpc: "2.0", id: 3, method: "ping" }, {});
    expect(none.status).toBe(401);
    const wrong = await post({ jsonrpc: "2.0", id: 4, method: "ping" }, { "x-ibot-bridge": "nope" });
    expect(wrong.status).toBe(401);
  });

  it("leaves /health unauthenticated (bootstrap polls it from inside the box, tokenless)", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("answers 405 on the GET event stream instead of hanging the client", async () => {
    // The SDK opens this for server→client messages; 405 is the spec's "no such stream" and is
    // treated as a non-fatal absence. Hanging here would stall every connect.
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      headers: { "x-ibot-bridge": TOKEN },
    });
    expect(res.status).toBe(405);
  });

  it("reports a parse error rather than dying on malformed input", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ibot-bridge": TOKEN },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    // Still alive afterwards.
    const after = await post({ jsonrpc: "2.0", id: 5, method: "ping" });
    expect(after.status).toBe(200);
  });

  it("reports healthy only once the child ANSWERS, not when it spawns", async () => {
    // The live-box failure this exists for: with `npx -y <pkg>` the fork is instant but npm spends
    // tens of seconds fetching, during which anything written to stdin just sits in the pipe.
    // Bootstrap hands the platform an endpoint the moment /health turns 200, so a spawn-based
    // readiness produces a URL whose first real call times out. Here the child stalls 2.5s; /health
    // must stay 503 through the stall and only then flip.
    const port = PORT + 1;
    const stalled = spawn(
      process.execPath,
      [join(dir, "ibot-mcp-bridge.js"), "--port", String(port), "--cwd", dir, "--", process.execPath, join(dir, "echo-server.js")],
      { env: { ...process.env, IBOT_BRIDGE_TOKEN: TOKEN, ECHO_STALL_MS: "2500" }, stdio: "ignore" },
    );
    try {
      // The listener binds immediately; readiness must not follow it.
      let sawListening = false;
      let sawUnready = false;
      /* eslint-disable no-await-in-loop */ // sequential polling, by definition
      for (let i = 0; i < 40 && !sawUnready; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          sawListening = true;
          if (res.status === 503) sawUnready = true;
          else break; // already ready — the stall didn't hold, nothing to assert
        } catch {
          // not bound yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(sawListening, "bridge never bound its port").toBe(true);
      expect(sawUnready, "/health was 200 while the child was still stalling").toBe(true);

      // …and it becomes ready on its own once the child starts answering the probe.
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        ready = res.status === 200;
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      /* eslint-enable no-await-in-loop */
      expect(ready, "never became ready after the stall").toBe(true);

      // A real call works right away now, with no warm-up from the caller.
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ibot-bridge": TOKEN },
        body: JSON.stringify({ jsonrpc: "2.0", id: "after-stall", method: "ping2", params: { ok: 1 } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "after-stall" });
    } finally {
      stalled.kill("SIGTERM");
    }
  }, 30_000);

  it("fails in-flight waiters when the child dies, then restarts and serves again", async () => {
    // Without this, a crashed server leaves the platform's MCP client waiting on a socket that will
    // never answer — the run stalls instead of reporting a failed server.
    const died = await post({ jsonrpc: "2.0", id: "will-die", method: "die" });
    expect(died.json).toMatchObject({ id: "will-die", error: { code: -32000 } });
    expect(JSON.stringify(died.json)).toContain("exited");

    // Backoff restart: healthy again shortly, and serving.
    expect(await waitHealthy()).toBe(true);
    const after = await post({ jsonrpc: "2.0", id: 6, method: "ping", params: { back: true } });
    expect(after.json).toMatchObject({ id: 6, result: { echo: { back: true } } });
  }, 15_000);
});
