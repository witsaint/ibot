/**
 * The in-box stdio→HTTP MCP bridge.
 *
 * ## Why this exists
 *
 * Most community MCP servers are `stdio`: a command the host spawns, speaking newline-delimited
 * JSON-RPC over the child's stdin/stdout. Our platform must NEVER spawn one — `makeTransport`
 * refuses `stdio` on purpose, because a subprocess on the API host runs outside every tenant
 * boundary we have (one bot's server would sit next to another's, on the platform's filesystem,
 * with the platform's network identity). But the bot's OWN sandbox is exactly the right place: it is
 * already the bot's private trust plane, the place the model runs `run_command` in.
 *
 * So the box gets a ~150-line wrapper: it spawns the stdio server as a child, and exposes it as a
 * StreamableHTTP MCP endpoint on a loopback port. The platform then treats it as an ordinary
 * `box_local` MCP server (`transport: "http"`), which is a row shape the runtime already knows —
 * `gatherBotDefs`, `startBoxMcp` and `connectBotMcpTools` need no changes at all to support the
 * entire stdio ecosystem.
 *
 * ## Shipping and lifecycle
 *
 * This is written to `/opt/ibot-mcp-bridge.js` as a provision plan FILE, the same way
 * `cdp-proxy.js` is. That matters for a reason specific to our infra: `provisionDesktop` runs on
 * both create AND connect, so the script is re-materialized after the gateway's forced ~24h
 * pause/resume without anything extra to remember. The bridge PROCESSES are not started here —
 * each is launched per-server by `bootstrapBot`/`startBoxMcp` from its `boxLocal.start`, so a
 * server's lifetime follows its DB row rather than the desktop's.
 *
 * Dependency-free (node core `http` + `child_process`) because the base image has node and nothing
 * else is guaranteed — same discipline as the cdp-proxy.
 */

/** Where the bridge script lands in the box. */
export const MCP_BRIDGE_PATH = "/opt/ibot-mcp-bridge.js";

/**
 * First loopback port handed to a bridged server. Deliberately far above the desktop's ports
 * (9222/9223/5900/6080/49983) and out of the ephemeral range, so allocation can just count upward
 * per bot without colliding with anything the desktop or a user's own server binds.
 */
export const MCP_BRIDGE_PORT_BASE = 47001;

/**
 * The bridge. Usage:
 *
 *   node /opt/ibot-mcp-bridge.js --port 47001 [--cwd /root/.ibot/plugins/acme_crm] -- <cmd> [args…]
 *
 * Endpoints: `GET /health` (200 once the child is up, 503 while it is restarting) and
 * `POST /mcp` (a JSON-RPC message in, the matching reply out). Requests are correlated by JSON-RPC
 * `id`, so concurrent calls from the platform's MCP client interleave safely over one child.
 *
 * Secrets: values arrive in the bridge's OWN environment (`handle.run`'s env channel, resolved
 * tenant-scoped on the platform) and are inherited by the child. They are never arguments, so they
 * never appear in `ps`, in a log line, or in the DB row.
 *
 * ## Why it binds 0.0.0.0, and the token
 *
 * The platform reaches an in-box service through the gateway at `${port}-${sandboxId}.${domain}`, so
 * a loopback-only listener is unreachable — it has to bind `0.0.0.0`, exactly like the cdp-proxy.
 * That makes the port internet-facing, and the only thing protecting the desktop's other exposed
 * ports today is the unguessability of that host. An MCP endpoint is a worse thing to leave open
 * than a pixel stream (it is `tools/call` on whatever the server can reach), so the bridge also
 * requires a shared token in `x-ibot-bridge` when `IBOT_BRIDGE_TOKEN` is set in its environment.
 * The platform stores that token in the server row's `headers` (already sent as `requestInit`
 * headers by `connectBotMcpTools`) and passes it to the bridge over the env channel, so it never
 * appears in the start command or in `ps`. Unset = no check, which keeps a hand-run bridge debuggable.
 */
export const MCP_BRIDGE_JS = String.raw`
// i-bot stdio→StreamableHTTP MCP bridge. Spawns an MCP stdio server and speaks HTTP to the platform.
const http = require('http');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
let port = 0, cwd = process.cwd(), i = 0;
for (; i < argv.length; i++) {
  if (argv[i] === '--port') { port = Number(argv[++i]); continue; }
  if (argv[i] === '--cwd') { cwd = argv[++i]; continue; }
  if (argv[i] === '--') { i++; break; }
}
const cmd = argv.slice(i);
if (!port || cmd.length === 0) {
  console.error('usage: ibot-mcp-bridge --port <p> [--cwd <dir>] -- <command> [args...]');
  process.exit(2);
}

const MAX_BODY = 4 * 1024 * 1024;   // a tool result can be large; a runaway body must not eat the box
const REQUEST_TIMEOUT_MS = 300000;  // a pending request is dropped rather than leaked forever

let child = null;
let ready = false;
let buffer = '';
let restarts = 0;
/** in-flight JSON-RPC calls, by id → the HTTP response waiting on them */
const pending = new Map();

/**
 * Readiness probe id. "ready" must NOT mean "the process forked": with an npx command the fork
 * happens instantly while npm spends tens of seconds fetching the package, and anything written to
 * stdin in that window just sits in the pipe. Bootstrap polls /health and hands the platform an
 * endpoint the moment it turns 200, so a spawn-based readiness produces a URL whose first real call
 * times out. Instead the bridge pings the child until it answers ANYTHING (a JSON-RPC error is a
 * perfectly good answer - it proves something is reading stdin and writing stdout), and only then
 * reports healthy.
 */
const PROBE_ID = '__ibot_ready__';
const PROBE_INTERVAL_MS = 750;
let probeTimer = null;

function stopProbe() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

function beginProbe() {
  stopProbe();
  probeTimer = setInterval(() => {
    if (ready) { stopProbe(); return; }
    // ping is in the spec and cheap; a server that doesn't implement it still replies with an error.
    write({ jsonrpc: '2.0', id: PROBE_ID, method: 'ping' });
  }, PROBE_INTERVAL_MS);
  if (probeTimer.unref) probeTimer.unref();
}

function fail(id, code, message) {
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  clearTimeout(waiter.timer);
  waiter.send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** One newline-delimited message from the child. */
function onMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }  // not JSON → server noise on stdout, ignore

  // Our own readiness ping came back: the child is really speaking, so start reporting healthy. The
  // reply is consumed here and never forwarded — no HTTP caller is waiting on it.
  if (msg.id === PROBE_ID) {
    if (!ready) { ready = true; console.log('[bridge] child is answering; ready'); }
    stopProbe();
    return;
  }

  // A reply to something we forwarded.
  if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.send(msg);
    return;
  }
  // A REQUEST from the server (sampling, roots/list, elicitation). We have no channel back to the
  // platform for these — StreamableHTTP would need the GET event stream — so answer immediately
  // instead of leaving the server blocked on a reply that will never come.
  if (msg.id !== undefined && msg.id !== null && msg.method) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'server-initiated requests are not bridged' } });
    return;
  }
  // A notification with no id: nothing to correlate it to, so it is dropped by design.
}

function write(obj) {
  if (!child || child.killed) return false;
  try { child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
}

function start() {
  child = spawn(cmd[0], cmd.slice(1), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('spawn', () => {
    console.log('[bridge] spawned: ' + cmd.join(' '));
    beginProbe(); // healthy only once it answers — see PROBE_ID
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onMessage(line);
    }
  });
  child.on('error', (e) => { console.error('[bridge] spawn error: ' + e.message); });
  child.on('exit', (code, signal) => {
    ready = false;
    buffer = '';
    stopProbe();
    // Every waiter is now unanswerable: fail them loudly rather than let the platform's MCP client
    // sit on a dead socket until its own timeout.
    for (const id of [...pending.keys()]) fail(id, -32000, 'mcp server exited (' + (signal || code) + ')');
    // Backoff-restart: a server that crashes on a bad request should recover, one that crashes on
    // startup should not spin. Capped delay, uncapped attempts — the row is the source of truth for
    // whether this server should be running at all.
    restarts++;
    const delay = Math.min(30000, 500 * Math.min(restarts, 60));
    console.error('[bridge] child exited (' + (signal || code) + '), restarting in ' + delay + 'ms');
    setTimeout(start, delay);
  });
}

function readBody(req, cb) {
  let body = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (c) => {
    if (tooBig) return;
    body += c;
    if (body.length > MAX_BODY) { tooBig = true; cb(new Error('body too large')); }
  });
  req.on('end', () => { if (!tooBig) cb(null, body); });
  req.on('error', (e) => { if (!tooBig) { tooBig = true; cb(e); } });
}

const TOKEN = process.env.IBOT_BRIDGE_TOKEN || '';

http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  // /health is deliberately unauthenticated: it is polled from INSIDE the box over loopback by
  // bootstrap (which has no token in hand) and leaks nothing but a boolean.
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: ready, restarts }));
    return;
  }

  // Everything else is the MCP endpoint, which is gateway-exposed — require the shared token.
  if (TOKEN && req.headers['x-ibot-bridge'] !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }));
    return;
  }
  // The client may open the GET event stream for server→client messages. We don't bridge those
  // (see onMessage), and 405 is the spec's "this server has no such stream" answer, which the SDK
  // treats as a non-fatal absence rather than an error.
  if (req.method === 'GET' && path === '/mcp') { res.writeHead(405).end(); return; }
  if (req.method === 'DELETE' && path === '/mcp') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST' || path !== '/mcp') { res.writeHead(404).end(); return; }

  readBody(req, (err, body) => {
    if (err) { res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: err.message } })); return; }
    let msg;
    try { msg = JSON.parse(body); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    if (!ready) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32000, message: 'mcp server not running' } }));
      return;
    }

    // A notification (no id) gets no reply: forward it and answer 202, as StreamableHTTP expects.
    if (msg.id === undefined || msg.id === null) {
      write(msg);
      res.writeHead(202).end();
      return;
    }

    const send = (out) => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    };
    const timer = setTimeout(() => fail(msg.id, -32000, 'mcp server timed out'), REQUEST_TIMEOUT_MS);
    pending.set(msg.id, { send, timer });
    // Drop the waiter if the platform hangs up first, so a cancelled turn can't leak an entry.
    res.on('close', () => { const w = pending.get(msg.id); if (w && w.send === send) { clearTimeout(timer); pending.delete(msg.id); } });
    if (!write(msg)) fail(msg.id, -32000, 'mcp server stdin unavailable');
  });
// 0.0.0.0 because the platform dials this through the gateway, not from inside the box (see above).
}).listen(port, '0.0.0.0', () => console.log('[bridge] listening on :' + port + (TOKEN ? ' (token required)' : ' (no token)')));

start();

// The bridge outlives individual requests but must die with its box cleanly; stopping it is a
// pkill -f "ibot-mcp-bridge.*--port <port>" from the platform (see stopBoxMcp).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { if (child) child.kill('SIGTERM'); } catch {} process.exit(0); });
}
`;
