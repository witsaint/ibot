# AGENTS.md

Instructions for coding agents working in this repo. Humans: see `README.md`.

## What this is

`i-bot` is a multi-tenant computer-use bot platform. Each user creates independent
**bots**; each bot is backed by an isolated **PPIO sandbox** (Linux desktop: Xvfb +
Chrome + overlay disk), provisioned through the **AIProxy gateway** (not PPIO direct).
The backend runs the agent loop and drives the sandbox remotely; the web app is the
chat UI + live desktop preview.

## Stack (locked)

- **Orchestration:** Mastra (`@mastra/core`) on top of the **Vercel AI SDK** (the model
  substrate). Mastra gives memory (= skill retrieval), workflows, and suspend/resume
  (= human handoff) out of the box.
- **Provider:** provider-agnostic via AI SDK. Anthropic `computer_*` (client-executed)
  drives the sandbox; swappable.
- **Chat UI:** **assistant-ui** (built on shadcn/ui + Tailwind) wired to Mastra via
  `@mastra/ai-sdk` → AI SDK UI message stream → `@assistant-ui/ai-sdk` runtime. Deploy
  as **separate-server** (Next.js frontend → NestJS/Mastra API over HTTP).
- **Sandbox access:** provisioned via the **AIProxy gateway** (single `AIPROXY_API_KEY`,
  control-plane URL carries a channel slug, SDK overrides `apiUrl`). The connector is a
  **`SandboxProvider` abstraction** (`packages/core`) — AIProxy/PPIO is the first
  implementation; E2B/Daytona are swappable behind the same interface. Custom templates
  (Xvfb + WM + Chrome `--remote-debugging-port=9222` + x11vnc, supervisord-started) supply
  the desktop; the SDK is the control plane only. See the `ppio-sandbox-aiproxy` skill and
  `docs/aiproxysandbox.md` before touching lifecycle code.
- **Skills:** **Postgres is the source of truth** (scope-filtered; **no pgvector for MVP** —
  a nullable `embedding` column is reserved as a future placeholder only). Never store skills
  only in a sandbox (sandboxes are ephemeral). Load relevant skills at runtime, inject into
  context or register as tools, materialize executable assets into the sandbox on demand.
- **Design language:** see `packages/config/design-tokens.css` — Geist-based
  (Vercel/Supabase aesthetic). Use those tokens; do not hardcode colors.

## Layout

- `apps/web` — Next.js 16 (App Router) + assistant-ui. Chat UI, bot management, noVNC preview.
- `apps/api` — NestJS 12 + Mastra. Auth, bots, agent orchestration, webhooks, SSE/WS.
- `packages/core` — `SandboxProvider` abstraction (AIProxy/PPIO impl), computer-use +
  browser-use tools, Mastra agents/tools.
- `packages/types` — shared Zod schemas + TS types (single source of truth).
- `packages/db` — database schema + client (users, bots, sandboxes, skills, bot_mcp_servers).
- `packages/config` — shared tsconfig, oxlint config, design tokens.

Internal deps use `workspace:*` and the `@i-bot/*` scope.

## Commands

- Install: `pnpm install`
- Dev (all): `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm lint` (oxlint, single whole-repo pass — not per-package) — must be clean
- Types: `pnpm check-types`
- Test: `pnpm test`
- Format: `pnpm format`

Always run `pnpm lint && pnpm check-types` before considering a change done.

## Conventions

- **oxlint** replaces ESLint; **oxfmt** formats. Both are oxc (Rust) — one toolchain, one parser. No Prettier.
- Turborepo `tasks` key (not `pipeline`). Declare env vars per task for cache correctness.
- Add a **changeset** (`pnpm changeset`) for any change to `packages/*`.
- Zod schemas in `@i-bot/types` are the contract between web, api, and core. Change them there, not inline.

## Golden rules for the sandbox layer

- One bot ↔ one active sandbox instance. Never share a sandbox across tenants. A bot may own
  many `sandboxes` rows over time (history/audit); `bots.current_sandbox_id` points at the live one.
- **Tenant isolation is ours, not the gateway's.** All bots' sandboxes are created under one
  `AIPROXY_API_KEY`, so the gateway's ownership check can't separate tenants. Enforce owner-of-bot
  on every control-plane route (create / connect / timeout / delete) against `sandboxes.bot_id`.
- **Never hit the control plane without the channel slug** (`/sandbox/c/{slug}`) → `409`. Override
  the SDK `apiUrl`, never `domain`. Use the `domain` returned by create/connect; never hardcode it.
- Keep the three sandbox IDs distinct (control-plane header id, body `sandboxID`, runtime
  `sandboxID-clientID`) — see the `ppio-sandbox-aiproxy` skill.
- Prefer **browser tools (CDP)** for web tasks; fall back to **desktop tools (screenshot+coords)** only for system dialogs, native password fields, and slider captchas.
- Only one desktop controller at a time. When a human takes over (VNC handoff), the agent must not dispatch desktop clicks that turn.
- Never log sandbox auth keys or user credentials.

## Agent skills

Operational playbooks live in `.agents/skills/<name>/SKILL.md` (progressive disclosure: read the
frontmatter `description` to decide relevance, load the body when the task matches).

- **`ppio-sandbox-aiproxy`** — provisioning, connecting, keepalive, and teardown of a PPIO sandbox
  through the AIProxy gateway. Load before writing or debugging any sandbox lifecycle code, SDK
  control-plane setup, envd/runtime host construction, or template selection.

## Security

- Every API route is authenticated. The control plane is never unauthenticated.
- Webhook routes verify signatures before doing work.
