---
name: ppio-sandbox-aiproxy
description: >-
  Provision, connect to, keep alive, and tear down a PPIO sandbox through the
  AIProxy gateway. Load this before writing or debugging any sandbox lifecycle
  code (create / connect / timeout / delete), SDK control-plane setup, envd or
  runtime host construction, or template selection. Covers the single-credential
  auth model, the channel-slug control-plane URL, the three non-interchangeable
  sandbox IDs, per-channel TTL and keepalive, and how tenant isolation works here.
---

# PPIO sandbox via the AIProxy gateway

Every sandbox in this repo is provisioned through the **AIProxy gateway**, never
against PPIO directly. Authoritative reference: `docs/aiproxysandbox.md` — this file
is the operational summary and the "rules that bite". When they disagree, the doc wins.

## The one credential

- The server holds a single `AIPROXY_API_KEY`. On hand-written HTTP, send it as
  `Authorization: Bearer ${AIPROXY_API_KEY}`.
- Never send `Authorization` and `X-API-KEY` together → `sandbox_gateway_conflicting_credentials`.
- Never ask for or store an upstream PPIO key, channel ID, upstream base URL, runtime
  domain, or template ID. Those are gateway/admin config, discovered at runtime.

## Control-plane URL carries the channel slug

- Control plane = `https://apiproxy.paigod.work/sandbox/c/{slug}`. The slug is **required**.
- Never hit `https://apiproxy.paigod.work/sandbox` (no slug) → `409 ambiguous_sandbox_channel`
  once more than one ppio channel is enabled (fails-closed by design; the gateway will not guess).
- Known slugs and their runtime domains (**not interchangeable**):
  - `ppio-sandbox-internal` → runtime `sandbox.paigod.work` (gateway proxy domain)
  - `ppio-sandbox-public` → runtime `sandbox.ppio.cn` (upstream direct)
- Capabilities, TTL caps, runtime domain, and envd version can all differ per channel.
  Do not assume a number measured on one channel holds on another — confirm live.
- Config env: `SANDBOX_CONTROL_PLANE_URL` (already includes `/c/{slug}`), `SANDBOX_CHANNEL_SLUG`.

## SDK setup — override the control plane, not the domain

```ts
process.env.PPIO_API_KEY = process.env.AIPROXY_API_KEY; // value is the AIProxy key
// E2B-compatible SDK: also set E2B_API_KEY = AIPROXY_API_KEY
new Sandbox({ apiUrl: process.env.SANDBOX_CONTROL_PLANE_URL }); // .../sandbox/c/{slug}
```

- Override `apiUrl` / `baseUrl`, **not** `domain`. Setting `domain` yields `https://api.<domain>/...`
  (the SDK prepends `api.`), which is the wrong address.
- The override affects only the **control plane** (discover / create / get / delete / connect /
  timeout). `files.*`, `commands.*`, and `getHost` run over runtime/envd using the host and
  token returned by connect.

## Three IDs — never interchange

| ID                     | Source                     | Use                                                  |
| ---------------------- | -------------------------- | ---------------------------------------------------- |
| `X-AIProxy-Sandbox-ID` | create response **header** | control-plane ops (GET / DELETE / connect / timeout) |
| `sandboxID`            | create response **body**   | lite deploy `artifactsSource.sandboxId`              |
| `sandboxID-clientID`   | body, two fields joined    | envd runtime host; some channels' DELETE too         |

envd host: `https://49983-{sandboxID}-{clientID}.{domain}`. General runtime host for any exposed
port P is `{P}-{sandboxID}-{clientID}.{domain}` (this is what `sandbox.getHost(P)` builds — CDP =
`getHost(9222)`, VNC = `getHost(<vncPort>)`). Always use the `domain` returned by create/connect;
never hardcode it. A wrong domain or a bare `sandboxID` host gives `502 The sandbox was not found`.

## Templates — discover, don't ask the user

- `GET <control-plane>/v2/templates` (fallback `/templates`). `403` or an empty list does **not**
  mean unusable — public aliases and team templates may not appear in the private list.
- Public alias `e2b/base` — write it in full, never `base` / `default`.
- A templateID not in the list can still create — try it. Only report unavailable on
  `404 template not found` or an explicit permission error.
- **Spec is fixed by the template.** `cpuCount` / `memoryMB` in the create body are silently
  ignored (still returns 201). To change CPU/RAM, change template. Always GET after create.

## Create → confirm

```
POST <control-plane>/sandboxes
{ "templateID": "<id>", "timeout": 3600, "metadata": { "long_running": "true" } }
```

Record: header `X-AIProxy-Sandbox-ID`; body `sandboxID`, `clientID`, `templateID`, `domain`,
`envdVersion`. Then `GET /sandboxes/{X-AIProxy-Sandbox-ID}` and read
`cpuCount / memoryMB / diskSizeMB / state / endAt` to confirm the real spec.

## TTL varies per channel — measure, don't assume

- Some channels cap at 1h: `timeout > 3600` either hard-fails `400 Timeout cannot be greater
than 1 hours` or is **silently clamped** (a 240-min request yielded 56 min in testing).
- Method: try the timeout you need; on `400`, drop to `3600` and keep alive by renewing.
- Renew: `POST /sandboxes/{X-AIProxy-Sandbox-ID}/timeout` `{ "timeout": <s> }`.
  **A 204 does not mean the window took** — re-GET and verify via `endAt`.
- Keepalive interval must be well below the real window (1h → ~5 min; 4h → ~15 min), and must
  **not share a lock with a long-running task**, or the box is reclaimed mid-task.
- `long_running` metadata is **create-time only** (can't add later; inherited by resume/clone).
  Infra restarts (pause+resume) long-running boxes every ~24h — in-box processes must survive
  it, or an external controller rebuilds the workspace after restart.

## connect / work in the box

- `POST /sandboxes/{X-AIProxy-Sandbox-ID}/connect` with body `{ "timeout": <s> }` (required; `400` without).
- Validate envd: `GET <envd host>/health` → `204`; `/metrics` → `cpu_count`, `mem_total_mib`, `mem_used_mib`.
- SDK capabilities live on the **instance** (`sandbox.files.*`, `sandbox.commands.run`,
  `sandbox.getHost(port)`), not the package top level.
- **envd/SDK version match:** `envdVersion < 0.5.0` may not return `envdAccessToken`, so a new SDK
  fails `401 invalid token`. That is a version mismatch, not a credential problem — do not retry
  or swap keys; fall back to the envd HTTP interface (files endpoint + `process.Process/Start`
  connect-rpc frames; see `docs/aiproxysandbox.md`).
- Toolchain: base template often has only git / python3 / gcc / make — no Go / Node / pnpm /
  docker guaranteed. `command -v` before installing; if an upstream source is blocked, use a
  reachable mirror.

## Cleanup

- `DELETE <control-plane>/sandboxes/{X-AIProxy-Sandbox-ID}` (some channels also accept the
  composite `sandboxID-clientID`; a bare `sandboxID` may `404`). Prefer SDK `kill()` but keep the
  control-plane base URL.
- If a keepalive process was registered (launchd / systemd / cron), DELETE alone does **not** stop
  billing — the process silently rebuilds the box on next login/restart. Stop and unregister it,
  then re-list running sandboxes to confirm the count is zero.

## How this maps to i-bot (multi-tenant)

- The **platform server** holds one `AIPROXY_API_KEY`; every bot's sandbox is created under it.
  The gateway's key-ownership check (`403 sandbox_gateway_ownership_denied`) therefore does **not**
  isolate tenants for us — one key owns them all.
- Tenant isolation is **our** responsibility: the DB `sandboxes.bot_id` binding plus authorization
  on every control-plane route. Enforce owner-of-bot before any create / connect / timeout / delete.
- Lite deploy (`https://apiproxy.paigod.work/lite/internal-lite`) is available but is a bot _task_
  capability (build & ship an app from `/app`), not part of the bot-runtime desktop lifecycle.

## Failure table

Full symptom → fix table: `docs/aiproxysandbox.md`, section "常见失败处理". The ones that bite most:
`409 ambiguous_sandbox_channel` (missing slug), `502 The sandbox was not found` (wrong runtime
domain, or bare `sandboxID` in the host), `401 invalid token` (envd version, not creds), and the
silent spec-ignore (change the template, not the request body).
