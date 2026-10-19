---
"@i-bot/templates": minor
---

Plugin system, phase 3: the importer and the install path. A Claude Code plugin directory on disk
becomes a manifest, the manifest becomes rows, and the rows become real files and real processes
**inside the owning bot's own sandbox**. This is the phase where "plugin" stops being a data model and
starts being something a user can install. (Design: `docs/plugin-system-design.md`, P3.)

Three questions had to be answered concretely, and they are what shaped the code:

- **Where does an imported plugin land?** The control plane stores declarations only: one shared
  `plugins` row (manifest + content hash) plus a per-owner `plugin_installs` row, from which install
  writes the per-bot `skills` / `bot_mcp_servers` / `bot_setup_steps` rows it already had, each stamped
  with `plugin_id` so uninstall is a delete by that column rather than a guess. The DB stays the
  ledger; nothing a plugin carries is stored only in a box.

- **Where in the sandbox?** `/root/.ibot/plugins/<key>/`, with the key sanitized (`@acme/crm` →
  `acme_crm`, hyphens kept) so it is one path segment, a `data/` subdirectory the plugin's own servers
  are pointed at, and a `.ibot-plugin.json` marker holding the content hash. The marker is what makes
  a second bootstrap a no-op: re-rendering unchanged files on every box start would cost a fresh
  install's worth of work every resume.

- **How do the executable parts fit our stack?** A stdio MCP server cannot run on the platform — that
  would spawn a subprocess on the API host and put every tenant's servers in one process tree, which is
  why `makeTransport` refuses stdio outright. So install **translates** it: the stored row is an
  ordinary box-local HTTP one (`transport: "http"`, `boxLocal.start = node /opt/ibot-mcp-bridge.js …`),
  and a small bridge shipped with the desktop image speaks stdio to the child and HTTP to us.
  `gatherBotDefs`, `startBoxMcp`, `connectBotMcpTools` and `makeTransport` needed **no** changes — the
  translation happens once, at install, rather than becoming a second code path everywhere downstream.
  Secrets keep their existing shape too: `{{secrets.NAME}}` is resolved server-side, tenant-scoped, and
  handed to `handle.run`'s `env` channel, so a value is never spliced into a command string and never
  reaches the model.

`POST /plugins/inspect` is deliberately separate from install. The security story is that a user sees
**every command** that will run in their box before agreeing to it, so the preview reads files, builds
a manifest, reports each setup step / bridged server / command hook — and stores and executes nothing.
Install answers per-bot (`ready` / `pending` / `failed`) rather than one boolean: a cold sandbox is
`pending`, not a failure, because the rows are written and the next bootstrap applies them, and
provisioning a box here would be a billable surprise nobody asked for. A missing secret is reported,
not fatal.

Two bugs only a real box could surface, both now covered by regression tests:

- **The launch hung until its timeout on a server that was in fact running.** `mkdir … && nohup … &`
  backgrounds the whole `&&` list, so bash forks a subshell that waits on the child — and that subshell
  holds envd's stdout pipe open, so envd never sees EOF. Now: a separate `mkdir`, then
  `setsid … < /dev/null > log 2>&1 &`, with all three fds redirected so nothing is left holding a pipe.

- **`ready` meant "spawned", which it isn't.** `npx -y <pkg>` forks instantly and then fetches for
  tens of seconds; the bridge reported healthy while stdin bytes sat unread in a pipe, and the first
  connect died with `-32001` even though the in-box hop was 10ms. Readiness now means the child
  **answered** a reserved `ping`, and the health check allows 60 attempts — sized from a measured
  29.3s cold start, with the package pre-warmed into the npm cache at install so the wait is paid once.

Measured, which also revised the design's own ceiling: 29.3s cold, 2.4s warm, 269MB resident across
the bridge and its four child processes against ~1.5GB available in a box — so the per-bot stdio MCP
limit drops from 8 to 4. Verified end to end twice: 34 assertions against real Postgres (import →
install → row shapes → `gatherBotDefs` payload → idempotency → uninstall, DB left as found) and 18
inside a live box, where `@modelcontextprotocol/server-filesystem` over `npx` delivered 14 real tools
through the gateway and a `write_file` call's side effect was confirmed on the box's filesystem.
