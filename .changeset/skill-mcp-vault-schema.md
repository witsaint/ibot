---
"@i-bot/db": minor
"@i-bot/types": minor
---

Extend the (previously unused) skill/MCP schema and add a tenant secrets vault, laying the
data model for mounting skills + MCP servers into a bot's sandbox.

- `skills` gains `files` (glue scripts carried with the playbook, content not just a ref, so a
  skill fully reconstructs from the DB after a sandbox rebuild) and `secretRefs` (names of
  `tenant_secrets` it references via `{{secrets.NAME}}` — declarative, no plaintext).
- `bot_mcp_servers` gains `boxLocal` (`{install, start, port, health, path}`): when set, the server
  runs as a process inside the sandbox and the agent connects over the gateway at
  `getHost(port)` + `path` (the MCP endpoint, default `/mcp`); null keeps the existing
  stdio/remote-url behaviour. `boxLocal` is jsonb, so `path` is a type-only addition (no migration).
- New `tenant_secrets` table + `secret_owner`/`secret_kind` enums: AES-256-GCM ciphertext (never
  plaintext), last-4 hint, bot- or user-owned (two partial unique indexes since NULLs are
  distinct in a composite unique index). Backs `{{secrets.NAME}}` for skills and external-API
  calls; an MCP server's own auth stays in `bot_mcp_servers.headers/env`.

Migration `0004_broken_nitro.sql` is purely additive (one new table, two enums, three columns
with safe defaults, two partial indexes) — no drops.
