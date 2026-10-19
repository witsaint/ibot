import type { UIMessage } from "ai";
import { z } from "zod";

/** Core domain models shared across web, api, and core.
 *  This file is the contract — change shapes here, not inline. */

// ---------- User ----------
/** Managed by better-auth (see @i-bot/db auth-schema). Shape mirrors its `user` table. */
export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean().default(false),
  image: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

// ---------- Bot ----------
/** A bot ↔ exactly one sandbox instance (1:1, enforced by a unique bot_id on sandboxes). */
export const BotStatus = z.enum(["creating", "active", "idle", "paused", "error"]);
export type BotStatus = z.infer<typeof BotStatus>;

export const Bot = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().nullable().default(null),
  /** icon / avatar ref (emoji or asset url) */
  avatar: z.string().nullable().default(null),
  /** system prompt / persona for this bot's agent */
  systemPrompt: z.string().default(""),
  /** model id, e.g. "claude-sonnet-5" */
  model: z.string().default("claude-sonnet-5"),
  /** sampling temperature; null = provider default */
  temperature: z.number().min(0).max(2).nullable().default(null),
  status: BotStatus.default("creating"),
  /** which sandbox template this bot's sandbox is provisioned from */
  defaultTemplate: z.string().default("desktop"),
  /**
   * Sandbox egress channel preference: true = public (clean IP), false = internal, null = inherit
   * the fleet default (env `SANDBOX_PUBLIC`). Applies to the NEXT box build; an existing box stays
   * pinned to the channel it was created on.
   */
  sandboxPublic: z.boolean().nullable().default(null),
  /** left-rail order within a tier (ascending); drag-to-reorder persists this. */
  sortOrder: z.number().int().default(0),
  /** pinned bots sort above unpinned ones in the rail (right-click → Pin to top). */
  pinned: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Bot = z.infer<typeof Bot>;

// ---------- Sandbox lifecycle ----------
export const SandboxState = z.enum(["create", "active", "idle", "pause", "resume", "kill"]);
export type SandboxState = z.infer<typeof SandboxState>;

/** Which backend provisions the sandbox. Provider-abstracted; "ppio" = via AIProxy gateway. */
export const SandboxProviderName = z.enum(["ppio", "e2b", "daytona"]);
export type SandboxProviderName = z.infer<typeof SandboxProviderName>;

/** Persisted sandbox row — 1:1 with a bot. Provider-specific routing bits live in `providerMeta`. */
export const Sandbox = z.object({
  id: z.string(),
  botId: z.string(),
  provider: SandboxProviderName.default("ppio"),
  /** canonical provider handle (PPIO/AIProxy: the base `sandboxID` from the create body) */
  providerSandboxId: z.string().nullable().default(null),
  /** template name/id the instance was created from */
  templateId: z.string(),
  state: SandboxState.default("create"),
  /**
   * provider-specific routing needed to reach runtime, kept out of the abstraction's columns.
   * PPIO/AIProxy: { controlId (X-AIProxy-Sandbox-ID), clientId, domain, envdVersion }.
   * Runtime host for port P = `${P}-${providerSandboxId}-${clientId}.${domain}`.
   */
  providerMeta: z.record(z.string(), z.unknown()).nullable().default(null),
  lastActiveAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Sandbox = z.infer<typeof Sandbox>;

/** Runtime handle info surfaced to the UI (never includes auth keys or provider routing secrets). */
export const SandboxInfo = z.object({
  sandboxId: z.string(),
  state: SandboxState,
  /** noVNC stream URL for live preview / handoff (view-only unless handed off) */
  streamUrl: z.string().url().nullable(),
  screen: z.object({ width: z.number().int(), height: z.number().int() }),
});
export type SandboxInfo = z.infer<typeof SandboxInfo>;

// ---------- Per-user model credentials (masked view) ----------
/**
 * What the settings API returns about a user's stored model credential. The API key itself
 * is NEVER included — only whether one is configured and a last-4 hint for display. The
 * plaintext lives encrypted at rest (apps/api owns the crypto); this is the read shape.
 */
export const ModelCredentialsView = z.object({
  /** whether the user has stored a model API key */
  configured: z.boolean(),
  /** last-4 display hint, e.g. "····KeUy"; null when not configured */
  keyHint: z.string().nullable().default(null),
  /** optional per-user gateway base URL */
  baseUrl: z.string().nullable().default(null),
  /** optional default model id used to prefill new-bot creation */
  defaultModel: z.string().nullable().default(null),
});
export type ModelCredentialsView = z.infer<typeof ModelCredentialsView>;

// ---------- Model discovery ----------
/**
 * One model the provider exposes, surfaced to the bot / settings model picker. Populated by
 * `GET /api/settings/models`, which queries the provider's own catalog (Anthropic-compatible
 * `GET /v1/models`) with the user's stored key. `id` is the value written onto a bot's `model`.
 */
export const ModelInfo = z.object({
  /** provider model id, e.g. "claude-sonnet-5" — the value stored on a bot */
  id: z.string(),
  /** human label for the dropdown; falls back to the id when the provider gives none */
  displayName: z.string(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

// ---------- Bot software setup (ordered, auditable) ----------
/** How a setup step provisions software into the sandbox. */
export const SetupStepKind = z.enum(["apt", "pip", "npm", "cmd", "download"]);
export type SetupStepKind = z.infer<typeof SetupStepKind>;

export const SetupStepStatus = z.enum(["pending", "applied", "failed"]);
export type SetupStepStatus = z.infer<typeof SetupStepStatus>;

/**
 * One declarative provisioning step for a bot's sandbox. Replayed on a fresh sandbox so
 * software the bot installed survives sandbox recreation (sandboxes are ephemeral).
 */
export const BotSetupStep = z.object({
  id: z.string(),
  botId: z.string(),
  /** apply order (ascending) */
  ord: z.number().int().nonnegative(),
  kind: SetupStepKind,
  /** kind-specific payload: {pkg} for apt/pip/npm, {run} for cmd, {url,dest} for download */
  spec: z.record(z.string(), z.unknown()),
  status: SetupStepStatus.default("pending"),
  lastError: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable().default(null),
});
export type BotSetupStep = z.infer<typeof BotSetupStep>;

// ---------- MCP servers (per bot) ----------
export const McpTransport = z.enum(["stdio", "sse", "http"]);
export type McpTransport = z.infer<typeof McpTransport>;

/**
 * A server-hosted (in the sandbox) MCP server. When set, the agent connects over HTTP through
 * the gateway at `getHost(port)` — `url` is derived at resolve time, not stored. `install` is
 * replayed idempotently on a fresh sandbox; `health` is the readiness path polled after `start`.
 */
export const McpBoxLocal = z.object({
  install: z.array(z.string()).default([]),
  start: z.string(),
  port: z.number().int().positive(),
  health: z.string().default("/health"),
  /** the MCP endpoint path the server-side client POSTs to (StreamableHTTP) / opens (SSE) */
  path: z.string().default("/mcp"),
});
export type McpBoxLocal = z.infer<typeof McpBoxLocal>;

/** An MCP server the bot's agent can call. Secrets in `headers`/`env` are stored encrypted. */
export const McpServer = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string().min(1).max(80),
  transport: McpTransport,
  /** stdio: executable + args */
  command: z.string().nullable().default(null),
  args: z.array(z.string()).nullable().default(null),
  /** sse/http: endpoint url */
  url: z.string().url().nullable().default(null),
  /** remote auth headers (encrypted at rest) */
  headers: z.record(z.string(), z.string()).nullable().default(null),
  /** stdio env vars (encrypted at rest) */
  env: z.record(z.string(), z.string()).nullable().default(null),
  /** when set, run this server inside the sandbox rather than remote/stdio */
  boxLocal: McpBoxLocal.nullable().default(null),
  /** optional tool allowlist; null = all tools exposed */
  toolFilter: z.array(z.string()).nullable().default(null),
  enabled: z.boolean().default(true),
  createdAt: z.string().datetime(),
});
export type McpServer = z.infer<typeof McpServer>;

// ---------- Skill ----------
/** A skill = a reusable "how to do X" the bot has learned.
 *  Source of truth lives in Postgres, NOT in the sandbox. */
export const SkillScope = z.enum(["bot", "user", "org", "public"]);
export type SkillScope = z.infer<typeof SkillScope>;

export const SkillStep = z.object({
  /** natural-language step, or a serialized action */
  note: z.string(),
  action: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});
export type SkillStep = z.infer<typeof SkillStep>;

export const Skill = z.object({
  id: z.string(),
  scope: SkillScope,
  /** owner ref depends on scope: botId | userId | orgId | null(public) */
  ownerRef: z.string().nullable(),
  name: z.string().min(1).max(120),
  /** used for retrieval matching against a task */
  description: z.string(),
  /** the reusable playbook, natural language */
  playbook: z.string(),
  /** optional structured, replayable steps */
  steps: z.array(SkillStep).default([]),
  /** references to executable assets materialized into the sandbox on demand */
  assets: z.array(z.string()).default([]),
  /**
   * Glue scripts carried with the skill (content, not just a ref) so it fully reconstructs from
   * the DB after a sandbox rebuild. Third-party binaries are NOT here — those are setup steps.
   */
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        mode: z.string().optional(),
      }),
    )
    .default([]),
  /** names of tenant_secrets this skill references via {{secrets.NAME}} (declarative; no values) */
  secretRefs: z.array(z.string()).default([]),
  version: z.number().int().positive().default(1),
  /** reserved for future semantic retrieval; MVP does NOT use pgvector — always null for now */
  embedding: z.array(z.number()).nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Skill = z.infer<typeof Skill>;

/** What the retriever returns when matching skills to a task. */
export const SkillMatch = z.object({
  skill: Skill,
  score: z.number().min(0).max(1),
});
export type SkillMatch = z.infer<typeof SkillMatch>;

/**
 * A skill DRAFT distilled from a finished conversation ("record → experience"). The analyzer turns
 * a conversation's action trace into this proposal; a human reviews/edits it, then it's published
 * as a bot-scoped Skill. It's the reviewable subset of Skill — no id/scope/owner/version, which the
 * publish step assigns. `secretRefs` lists any credentials the analyzer detected and rewrote to
 * `{{secrets.NAME}}` in the playbook; values are NEVER carried here (the human confirms them).
 */
export const SkillDraft = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1),
  playbook: z.string().min(1),
  steps: z.array(SkillStep).default([]),
  secretRefs: z.array(z.string()).default([]),
});
export type SkillDraft = z.infer<typeof SkillDraft>;

// ---------- tenant secrets (the vault behind {{secrets.NAME}}) ----------
/** who a stored secret belongs to: a single bot, or a user (shared across their bots) */
export const SecretOwner = z.enum(["bot", "user"]);
export type SecretOwner = z.infer<typeof SecretOwner>;

/** how a stored secret is presented to whatever consumes it */
export const SecretKind = z.enum(["apikey", "bearer", "header", "oauth"]);
export type SecretKind = z.infer<typeof SecretKind>;

/**
 * Kind-specific extra data stored ALONGSIDE the encrypted value (never the plaintext itself):
 * - `header`: the header name the value should be sent under (e.g. "X-Api-Key").
 * - `oauth`: the encrypted refresh token, the access-token expiry, and the token endpoint, so
 *   the vault can refresh a machine-refreshable grant server-side before injecting.
 */
export const SecretMeta = z.object({
  headerName: z.string().optional(),
  refreshCiphertext: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  tokenUrl: z.string().url().optional(),
});
export type SecretMeta = z.infer<typeof SecretMeta>;

/**
 * A credential in the vault, referenced by name via `{{secrets.NAME}}`. The plaintext is never
 * present — only the GCM ciphertext and a last-4 hint. Exactly one of `botId`/`userId` is set
 * per `ownerType`.
 */
export const TenantSecret = z.object({
  id: z.string(),
  ownerType: SecretOwner,
  botId: z.string().nullable().default(null),
  userId: z.string().nullable().default(null),
  name: z.string().min(1).max(120),
  hint: z.string(),
  kind: SecretKind,
  metadata: SecretMeta.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TenantSecret = z.infer<typeof TenantSecret>;

// ---------- Conversation content ----------
/**
 * A message part is exactly one element of the AI SDK's `UIMessage.parts` union
 * (`TextUIPart | FileUIPart | ReasoningUIPart | ToolUIPart | ...`). This is the ONE
 * interleaving format that is simultaneously:
 *   - renderable by the chat UI (assistant-ui reads `parts` directly),
 *   - the shape Mastra's own message format (`MastraDBMessage.content.parts`) uses, and
 *   - convertible to model input via `convertToModelMessages()`.
 *
 * We store parts verbatim. The lossy step (dropping/transcoding parts a given model
 * can't ingest — e.g. Anthropic takes text/image/PDF but NOT video) happens only when
 * building model input, never in storage. Video is a first-class stored/rendered part
 * but display/output-only for the model.
 */
export type MessagePart = UIMessage["parts"][number];

/** Zod guard for a stored part: structural only (`{ type: string, ... }`). The AI SDK
 *  is the authority on the full union; deep re-validation here would just duplicate it. */
export const MessagePart = z
  .object({ type: z.string() })
  .passthrough() as unknown as z.ZodType<MessagePart>;

/**
 * One A2UI protocol message (https://a2ui.org) — a single versioned envelope the bot's
 * agent emits to render generative UI (a `createSurface` / `updateComponents` /
 * `updateDataModel` frame, etc.). Carried as the output of the `render_ui` tool over the
 * same UI Message Stream and stored verbatim; the client feeds an array of these to the
 * `@a2ui/web_core` `MessageProcessor`, which is the authority on the full v0.9 schema.
 *
 * Structural guard only (`{ version: string, ... }`, same discipline as MessagePart) — the
 * renderer validates deeply against the component catalog, so re-checking every component
 * field here would just duplicate it and couple this contract to one protocol revision.
 */
export const A2uiMessage = z.object({ version: z.string() }).passthrough();
export type A2uiMessage = z.infer<typeof A2uiMessage>;

/**
 * A user's interaction with a bot-rendered A2UI panel (a button click / form submit), carried
 * back to the agent as a message. It rides as a normal `UIMessage` on the `user` turn but needs
 * to satisfy TWO readers with ONE message, which is why it's split across two parts:
 *
 *   - a plain `text` part — the ONLY thing the model sees. `convertToModelMessages` drops user
 *     `data-*` parts unless a `convertDataPart` is wired (we don't), so the model-facing signal
 *     MUST live in text. We phrase it as a clean natural-language line (no raw `[panel action]`
 *     tag, no bare JSON) so the model reads an instruction, not a protocol frame — and so it's a
 *     sane fallback if the chip ever isn't rendered.
 *   - a `data-uiEvent` part (`type: "data-uiEvent"`, this `UiEventData` as `data`) — display-only,
 *     the structured truth the chat renders as a compact chip instead of the raw text bubble. It
 *     survives persist + reload (structural-only `validateUIMessages`, no deep `dataSchemas`), so
 *     the chip re-renders identically on refresh.
 *
 * This is the send/receive counterpart to `A2uiMessage` (bot → human): `A2uiMessage` renders the
 * panel, `UiEventData` carries the human's reply back — both typed, neither leaking protocol into
 * the visible transcript.
 */
export const UI_EVENT_PART_TYPE = "data-uiEvent" as const;

export const UiEventData = z.object({
  /** The A2UI surface the interaction came from (its `surfaceId`). */
  surfaceId: z.string(),
  /** The fired action's event name (the model chose it; meaningful context for the model). */
  name: z.string(),
  /** The action's context payload (form field values, the picked option, …). */
  context: z.record(z.string(), z.unknown()).default({}),
  /** Optional human label for the chip; the chat falls back to `name` when absent. */
  label: z.string().optional(),
});
export type UiEventData = z.infer<typeof UiEventData>;

/**
 * The clean, model-facing line for a panel interaction — what goes in the sibling `text` part.
 * Natural language, not a protocol dump: names the action and lists any context fields so the
 * model can act on it, and reads fine to a human as the chip's fallback.
 */
export function uiEventInstruction(event: UiEventData): string {
  const label = event.label?.trim() || event.name;
  const entries = Object.entries(event.context ?? {});
  if (entries.length === 0) {
    return `I interacted with the "${label}" panel control.`;
  }
  const fields = entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return `I submitted the "${label}" panel control with ${fields}.`;
}

export const MessageRole = z.enum(["system", "user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRole>;

/** A conversation (thread) belongs to exactly one bot. Tenant isolation runs
 *  `message → conversation → bot → owner`; we own this table (not Mastra memory). */
export const Conversation = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Conversation = z.infer<typeof Conversation>;

/**
 * One message. `parts` is the interleaved content (see MessagePart). Binary payloads
 * referenced by any FileUIPart live in R2 and are mirrored in `attachments`; `parts`
 * holds the R2 URL/key, never the bytes.
 */
export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: MessageRole,
  parts: z.array(MessagePart).default([]),
  /** provider/run bookkeeping: token usage, model id, latency, finish reason, ... */
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof Message>;

/**
 * A binary artifact stored in R2 and referenced by a message part. Normalized out of
 * `parts` so files have a real home (object key, mime, size) instead of living inside JSONB.
 */
export const Attachment = z.object({
  id: z.string(),
  messageId: z.string(),
  /** R2 object key (bucket-relative); the canonical location of the bytes */
  objectKey: z.string(),
  /** IANA media type, e.g. image/png, audio/mpeg, video/mp4, application/pdf */
  mediaType: z.string(),
  filename: z.string().nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  /** pixel dimensions for image/video, null otherwise */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  /** duration in ms for audio/video, null otherwise */
  durationMs: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Attachment = z.infer<typeof Attachment>;

// ---------- agent jobs (detached runs) ----------
export const AgentJobStatus = z.enum(["running", "done", "error", "canceled"]);
export type AgentJobStatus = z.infer<typeof AgentJobStatus>;

/**
 * How a detached run started. `background` = a human asked for it. `subagent` = the foreground
 * agent spawned it itself (via `spawn_task`) to run concurrently while it keeps talking to the
 * user; its final answer is relayed back into the conversation on settle.
 */
export const AgentJobKind = z.enum(["background", "subagent"]);
export type AgentJobKind = z.infer<typeof AgentJobKind>;

/**
 * What kind of human intervention a run is blocked on when it calls `request_handoff` — the
 * structured half of a HITL handoff (the prose ask travels in the assistant message). Drives the
 * `needs_human` event so the UI can label the pause (a login vs an OTP vs a choice) and, later,
 * route a notification. `other` is the catch-all when none fit.
 */
export const HandoffKind = z.enum(["login", "otp", "secret", "choice", "captcha", "other"]);
export type HandoffKind = z.infer<typeof HandoffKind>;

/**
 * A detached agent run. It drives the sandbox independent of any open request; the UI watches
 * it (over SSE) to know when it's running/finished. A `background` run's assistant output lands
 * in `messages` like any turn; a `subagent` run's final answer lands in `result` and is relayed
 * into the conversation instead (its steps stay out of the transcript). `error` carries a
 * failure summary (never a secret) when status is `error`. Many runs can be live per bot at
 * once — GUI runs contend for the desktop lease, non-GUI runs (`needsDesktop:false`) don't.
 */
export const AgentJob = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  status: AgentJobStatus,
  kind: AgentJobKind.default("background"),
  needsDesktop: z.boolean().default(true),
  instruction: z.string().default(""),
  result: z.string().nullable().default(null),
  parentJobId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});
export type AgentJob = z.infer<typeof AgentJob>;

/**
 * A live event pushed over the per-conversation SSE stream (`GET /conversations/:id/events`),
 * replacing the old 2.5s job poll. All are best-effort notifications — the authoritative state
 * still lives in the DB, which the client pulls on `message.ready`.
 *
 * - `task.started/done/error`: a subagent/background run changed lifecycle. `done` carries a
 *   short `summary` (the relayed result, already framed) for the status strip; the full turn
 *   arrives via a later `message.ready`.
 * - `run.state`: a snapshot of what's active on the bot right now — whether a foreground voice
 *   is streaming, how many tasks run, whether the GUI lease is free/agent-held/human-held, and
 *   whether the bot is paused waiting for the human (`awaitingHuman`, set after `request_handoff`).
 * - `needs_human`: the foreground/relay voice called `request_handoff` and paused — it's blocked on
 *   something only the human can do (`reason` is the plain ask, `kind` classifies it). The turn has
 *   ended; the user's next message resumes it (a fresh turn replays the transcript).
 * - `message.ready`: new persisted messages exist (a proactive turn finished); the client should
 *   re-sync the transcript when its own foreground stream is idle.
 */
export const ConversationEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.started"),
    taskId: z.string(),
    kind: AgentJobKind,
    goal: z.string(),
    needsDesktop: z.boolean(),
  }),
  z.object({
    type: z.literal("task.done"),
    taskId: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("task.error"),
    taskId: z.string(),
    error: z.string(),
  }),
  z.object({
    type: z.literal("run.state"),
    foreground: z.boolean(),
    taskCount: z.number().int().nonnegative(),
    gui: z.enum(["free", "agent", "human"]),
    queueDepth: z.number().int().nonnegative().default(0),
    // paused waiting for the human (a run called request_handoff). Defaults false so an older
    // publisher / a persisted frame without the field stays valid.
    awaitingHuman: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("needs_human"),
    reason: z.string(),
    kind: HandoffKind,
  }),
  z.object({ type: z.literal("message.ready") }),
]);
export type ConversationEvent = z.infer<typeof ConversationEvent>;

// ---------- plugins (the one packaging unit for capability) ----------
/**
 * Where a plugin came from, which decides who may change it:
 * - `builtin`  — shipped with our code. Not editable, not removable; most are switchable off.
 * - `installed` — imported from a community/tenant bundle. Not editable; upgradable/removable.
 * - `local`    — the per-bot bundle the user's own recordings and `save_skill` calls land in. The
 *   ONLY editable source, and never versioned (it's edited in place at `0.0.0-local`).
 */
export const PluginSource = z.enum(["builtin", "installed", "local"]);
export type PluginSource = z.infer<typeof PluginSource>;

/** Who an installation belongs to. `org` is reserved — there is no org table yet. */
export const PluginOwnerType = z.enum(["user", "org"]);
export type PluginOwnerType = z.infer<typeof PluginOwnerType>;

/** The fixed `local` version marker — a local plugin is edited in place, never version-bumped. */
export const LOCAL_PLUGIN_VERSION = "0.0.0-local";

/** The `plugins.key` of a bot's own local bundle. One per bot, created with the bot. */
export function localPluginKey(botId: string): string {
  return `local:${botId}`;
}

/**
 * A plugin key turned into a tool-name segment: `@ibot/ui` → `ibot_ui`. Tool names must match the
 * provider's `[a-zA-Z0-9_-]` rule, so every other character folds to `_`. Shared by the runtime
 * (which names the tools) and the UI (which has to recognise them), hence it lives in the contract.
 */
export function sanitizePluginKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A file carried by a plugin and materialized into the box under `${PLUGIN_ROOT}`. */
export const PluginFile = z.object({
  path: z.string().min(1).max(512),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  /** chmod bits as a string, e.g. "755" for an executable glue script */
  mode: z.string().optional(),
});
export type PluginFile = z.infer<typeof PluginFile>;

/** Knowledge: becomes a `skills` row per enabled bot, and a section of the system prompt. */
export const PluginSkillDecl = z.object({
  name: z.string().min(1).max(120),
  description: z.string(),
  playbook: z.string(),
  files: z
    .array(z.object({ path: z.string().min(1), content: z.string(), mode: z.string().optional() }))
    .default([]),
  secretRefs: z.array(z.string()).default([]),
  /** true = referenced only by hooks/agents, kept out of the model's skill list */
  hidden: z.boolean().default(false),
  /** Present = explicit user command only; absent = normal skill loading. */
  command: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .optional(),
});
export type PluginSkillDecl = z.infer<typeof PluginSkillDecl>;

/**
 * Connection: becomes a `bot_mcp_servers` row per enabled bot.
 * `http`/`sse` are dialed from the platform. `stdio` is NOT run on the platform host — install
 * translates it into a process started inside the bot's own box behind the stdio→HTTP bridge, so the
 * stored row is an ordinary box-local one (see the design doc §4.7).
 */
export const PluginMcpDecl = z.object({
  name: z.string().min(1).max(80),
  transport: McpTransport,
  /** http/sse: the remote endpoint */
  url: z.string().url().optional(),
  /** remote auth headers; each value must be `{{secrets.NAME}}` or a non-sensitive literal */
  headers: z.record(z.string(), z.string()).optional(),
  /** stdio: the executable started in the box. `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` are substituted. */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** stdio env; `{{secrets.NAME}}` values are injected over the command env channel, never inline */
  env: z.record(z.string(), z.string()).optional(),
  toolFilter: z.array(z.string()).optional(),
});
export type PluginMcpDecl = z.infer<typeof PluginMcpDecl>;

/** A predefined expert: a specialised subagent with its own prompt, model and tool allowlist. */
export const PluginAgentDecl = z.object({
  name: z.string().min(1).max(80),
  description: z.string(),
  prompt: z.string(),
  /** allowlist of tool names; omitted = inherit the parent run's toolset (minus `spawn_task`) */
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().max(60).optional(),
  needsDesktop: z.boolean().default(false),
  /** load only these skills (by name); omitted = all of the bot's */
  skills: z.array(z.string()).optional(),
});
export type PluginAgentDecl = z.infer<typeof PluginAgentDecl>;

/**
 * A card template. The model reaches every template through the SINGLE `render_card` tool, naming
 * this one as `template: "<plugin>.<name>"` — not through a tool of its own, so the model's tool list
 * and the per-request schema overhead don't grow with what the user has installed. `input` is the
 * JSON Schema the model fills in; `template` is the A2UI it expands into.
 *
 * `template` is deliberately looser than `A2uiMessage[]`: before expansion an entry may be a
 * DIRECTIVE rather than a finished message (`{$each, as, body}` to repeat, `{$if, then, else}` to
 * branch), and a directive carries no `version` field. Holes are `${input.x}`, `${@index}` and
 * `${surfaceId}`. The expander substitutes, it does not evaluate; the EXPANDED result is validated
 * against the component catalog exactly like a hand-written `render_ui` panel, and that check is
 * where a bad template is caught — so a stricter schema here would buy nothing.
 */
export const PluginUiDecl = z.object({
  name: z.string().min(1).max(80),
  description: z.string(),
  input: z.record(z.string(), z.unknown()),
  template: z.array(z.record(z.string(), z.unknown())),
});
export type PluginUiDecl = z.infer<typeof PluginUiDecl>;

/** Software the box needs: becomes a `bot_setup_steps` row, replayed on every fresh sandbox. */
export const PluginSetupStepDecl = z.object({
  kind: SetupStepKind,
  spec: z.record(z.string(), z.unknown()),
});
export type PluginSetupStepDecl = z.infer<typeof PluginSetupStepDecl>;

/** When a hook fires. Mirrors the community events we import (SessionStart/PreToolUse/PostToolUse). */
export const PluginHookEvent = z.enum([
  "turn.start",
  "tool.before",
  "tool.after",
  "form.submit",
  "bootstrap.done",
]);
export type PluginHookEvent = z.infer<typeof PluginHookEvent>;

/** Hard cap on a `command` hook — `tool.before` is a synchronous wait inside a run. */
export const HOOK_COMMAND_MAX_TIMEOUT_MS = 30_000;

/**
 * What a hook does. `tool` runs on the platform (inject a call into the next model step); `command`
 * runs IN THE BOX via `handle.run`, receiving the event as JSON on stdin and answering with
 * `{decision?, reason?, note?}` on stdout. Only `tool.before` may block.
 */
export const PluginHookDecl = z.object({
  on: PluginHookEvent,
  /** tool.* → a tool-name glob; form.submit → a surfaceId/action-name glob */
  match: z.string().optional(),
  do: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("tool"),
      tool: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    z.object({
      type: z.literal("command"),
      command: z.string(),
      timeoutMs: z.number().int().positive().max(HOOK_COMMAND_MAX_TIMEOUT_MS).default(10_000),
    }),
  ]),
});
export type PluginHookDecl = z.infer<typeof PluginHookDecl>;

/** One knob a plugin exposes for the user to fill in at install time (never a secret). */
export const PluginUserConfigDecl = z.object({
  type: z.enum(["string", "number", "boolean", "enum"]),
  description: z.string(),
  default: z.unknown().optional(),
  enum: z.array(z.string()).optional(),
});
export type PluginUserConfigDecl = z.infer<typeof PluginUserConfigDecl>;

/**
 * The normalized plugin manifest — the single source of truth for what a plugin contributes, stored
 * verbatim in `plugins.manifest`. Every import path (our builtin directories, a community
 * Claude Code plugin directory, an uploaded zip) is translated INTO this shape before it is stored,
 * so runtime assembly has exactly one format to read.
 *
 * It is pure DATA by construction. The platform parses, validates, stores and expands it, and never
 * executes anything it contains: each executable thing a plugin carries (`setupSteps`, a stdio MCP
 * `command`, a `command` hook, `files`) runs inside the owning bot's own sandbox, on the same trust
 * plane as the model's `run_command`.
 */
export const PluginManifest = z.object({
  /** stable identity: `@ibot/ui`, `acme/crm`, `local:<botId>` */
  key: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9@][a-z0-9@/_.:-]*$/, "lowercase key, e.g. @scope/name"),
  version: z.string().min(1).max(40),
  displayName: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  author: z
    .object({
      name: z.string(),
      email: z.string().optional(),
      url: z.string().url().optional(),
    })
    .optional(),
  homepage: z.string().url().optional(),
  /** whether a fresh install is enabled without the user opting in */
  defaultEnabled: z.boolean().default(true),

  skills: z.array(PluginSkillDecl).default([]),
  mcpServers: z.array(PluginMcpDecl).default([]),
  agents: z.array(PluginAgentDecl).default([]),
  ui: z.array(PluginUiDecl).default([]),
  /**
   * Platform tools this plugin DECLARES but does not carry — their implementation lives in our own
   * code (the nine primitives in `@ibot/core`). Declaring them makes "core is a plugin too" true in
   * the data and gives the UI and an agent's tool allowlist something to validate against. Only a
   * `builtin` plugin may set this; the importer strips it from anything else, since an imported
   * bundle claiming to provide a platform tool would be asserting a capability it can't back.
   */
  providedTools: z
    .array(z.object({ name: z.string().min(1), description: z.string().default("") }))
    .default([]),
  setupSteps: z.array(PluginSetupStepDecl).default([]),
  hooks: z.array(PluginHookDecl).default([]),
  /** the plugin directory's remaining files, materialized into `${PLUGIN_ROOT}` in the box */
  files: z.array(PluginFile).default([]),

  /** hard dependencies on other plugins, checked at install */
  requires: z.array(z.object({ plugin: z.string(), version: z.string().optional() })).default([]),
  /** vault names the plugin needs; a missing one is surfaced at install, not silently dropped */
  requiredSecrets: z.array(z.string()).default([]),
  userConfig: z.record(z.string(), PluginUserConfigDecl).default({}),
  /**
   * What the importer could not represent (slash commands, unsupported hook types, oversized
   * files). Kept so the install preview can tell the user what was dropped instead of pretending
   * the bundle came through whole.
   */
  ignored: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

/** Declared limits on a manifest, enforced by the importer (§10 资源). */
export const PLUGIN_LIMITS = {
  /** one carried file */
  fileBytes: 2 * 1024 * 1024,
  /** all carried files together */
  totalFileBytes: 20 * 1024 * 1024,
  /** stdio MCP processes per box — each is a real process in a small box */
  stdioMcpPerBot: 8,
} as const;

/** A stored plugin row: the manifest plus the bookkeeping that makes upgrades decidable. */
export const Plugin = z.object({
  id: z.string(),
  key: z.string(),
  version: z.string(),
  source: PluginSource,
  displayName: z.string(),
  description: z.string().default(""),
  author: z.record(z.string(), z.unknown()).nullable().default(null),
  homepage: z.string().nullable().default(null),
  manifest: PluginManifest,
  /** sha256 of the normalized manifest — upgrade/idempotency comparisons use this, not deep-equal */
  contentHash: z.string(),
  requires: z.array(z.object({ plugin: z.string(), version: z.string().optional() })).default([]),
  requiredSecrets: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Plugin = z.infer<typeof Plugin>;

/**
 * One owner's installation of a plugin. `enabledBots: null` means every bot that owner has (present
 * and future); an array restricts it. `enabled: false` keeps the install but contributes nothing.
 */
export const PluginInstall = z.object({
  id: z.string(),
  pluginId: z.string(),
  ownerType: PluginOwnerType,
  ownerId: z.string(),
  enabled: z.boolean().default(true),
  enabledBots: z.array(z.string()).nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
  installedAt: z.string().datetime(),
});
export type PluginInstall = z.infer<typeof PluginInstall>;

// ---------- sandbox shell ops (concurrency-safe tool) ----------
/**
 * The `run_command` tool payload: a shell command run in the sandbox via `handle.run` (envd
 * supports parallel shell sessions, so this is the one primitive safe to run concurrently with
 * other tasks — unlike the GUI tools, which all contend for the single desktop). Runs as root
 * inside the tenant-isolated box, same trust boundary as the existing xdotool path.
 */
export const RunCommand = z.object({
  command: z.string().min(1),
  /** hard wall-clock cap; the box kills the command if it overruns */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe(
      "Hard wall-clock cap in ms (max 600000 = 10 min). Defaults to ~45s when omitted. " +
        "A long command (apt/dpkg install, build, large download, anything that can run for " +
        "minutes) MUST set a large value here — or better, run it via spawn_task instead so it " +
        "doesn't block the conversation. The box kills the command if it overruns.",
    ),
});
export type RunCommand = z.infer<typeof RunCommand>;
