import type {
  AutomationTrigger,
  AutomationRunStatus,
  MessagePart,
  PluginManifest,
  SecretMeta,
} from "@i-bot/types";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth-schema.js";

/**
 * Postgres schema for i-bot. Mirrors the Zod contract in `@i-bot/types`.
 * Source of truth for skills lives here (never only in a sandbox).
 *
 * `users` (and sessions/accounts/verifications) are owned by better-auth and
 * defined in `./auth-schema.ts`; imported here for the ownership FKs. Because
 * better-auth ids are `text`, everything that references a user id is `text` too.
 */

// ---------- enums ----------
export const botStatus = pgEnum("bot_status", ["creating", "active", "idle", "paused", "error"]);
export const sandboxProvider = pgEnum("sandbox_provider", ["ppio", "e2b", "daytona"]);
export const sandboxState = pgEnum("sandbox_state", [
  "create",
  "active",
  "idle",
  "pause",
  "resume",
  "kill",
]);
export const skillScope = pgEnum("skill_scope", ["bot", "user", "org", "public"]);
export const setupStepKind = pgEnum("setup_step_kind", ["apt", "pip", "npm", "cmd", "download"]);
export const setupStepStatus = pgEnum("setup_step_status", ["pending", "applied", "failed"]);
export const mcpTransport = pgEnum("mcp_transport", ["stdio", "sse", "http"]);
/** who a stored secret belongs to — a single bot, or a user (shared across their bots) */
export const secretOwner = pgEnum("secret_owner", ["bot", "user"]);
/** how a stored secret is presented to the thing consuming it */
export const secretKind = pgEnum("secret_kind", ["apikey", "bearer", "header", "oauth"]);
export const messageRole = pgEnum("message_role", ["system", "user", "assistant"]);
export const agentJobStatus = pgEnum("agent_job_status", ["running", "done", "error", "canceled"]);
/**
 * How a detached run was kicked off. `background` = a human asked for it (the original async
 * job). `subagent` = the foreground agent spawned it itself via `spawn_task`, to run
 * concurrently while it keeps talking to the user; its result is relayed back into the
 * conversation when it finishes (never streamed into the transcript step-by-step).
 */
export const agentJobKind = pgEnum("agent_job_kind", ["background", "subagent"]);
/** where a plugin came from — decides who may edit it (see @i-bot/types PluginSource) */
export const pluginSource = pgEnum("plugin_source", ["builtin", "installed", "local"]);
/** who an installation belongs to. `org` is reserved; there is no org table yet. */
export const pluginOwner = pgEnum("plugin_owner", ["user", "org"]);

// ---------- plugins (the packaging unit for capability) ----------
/**
 * A plugin is one bundle of capability — skills + MCP servers + agents + card templates + setup
 * steps + hooks + files — installed, enabled, upgraded and removed as a whole. `manifest` (the
 * `PluginManifest` contract in `@i-bot/types`) is the single source of truth for what it
 * contributes; the rows it expands into (`skills`, `bot_mcp_servers`, `bot_setup_steps`) carry a
 * `plugin_id` back to here so they can be re-derived or removed together.
 *
 * The platform never EXECUTES anything in a manifest: it parses, validates, stores and expands it.
 * The executable parts (setup steps, a stdio MCP `command`, a `command` hook, carried files) run
 * inside the owning bot's own sandbox, the same trust plane the model's `run_command` already has.
 *
 * `unique(key, version)` makes an upgrade a NEW row rather than a mutation, so an install can be
 * repointed (and rolled back) without losing what the previous version declared. A `local` plugin
 * is the exception — it stays at `0.0.0-local` and is edited in place.
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** stable identity across versions: "@ibot/ui" | "acme/crm" | "local:<botId>" */
    key: text("key").notNull(),
    /** semver, or the fixed `0.0.0-local` for a bot's own local bundle */
    version: text("version").notNull(),
    source: pluginSource("source").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    /** {name, email?, url?} */
    author: jsonb("author").$type<Record<string, unknown>>(),
    homepage: text("homepage"),
    /** the normalized PluginManifest — everything the plugin contributes */
    manifest: jsonb("manifest").$type<PluginManifest>().notNull(),
    /** sha256 of the normalized manifest; upgrade + box-materialization idempotency key */
    contentHash: text("content_hash").notNull(),
    requires: jsonb("requires")
      .$type<{ plugin: string; version?: string }[]>()
      .notNull()
      .default([]),
    /** vault names this plugin needs; a missing one is reported at install, not silently dropped */
    requiredSecrets: jsonb("required_secrets").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("plugins_key_version_unique").on(t.key, t.version)],
);

/**
 * One owner's installation of a plugin. `enabledBots` null = every bot that owner has (including
 * ones created later); an array restricts it to those ids. `enabled: false` keeps the row but
 * contributes nothing at run time. `config` holds the answers to the manifest's `userConfig` —
 * non-sensitive values only; credentials live in `tenant_secrets` and are referenced by name.
 *
 * `owner_id` is text with no FK because it holds either a better-auth user id or (reserved) an org
 * id; tenant isolation is enforced by the queries, which always filter on the caller's owner.
 */
export const pluginInstalls = pgTable(
  "plugin_installs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    ownerType: pluginOwner("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** null = all of this owner's bots; otherwise an explicit bot-id allowlist */
    enabledBots: jsonb("enabled_bots").$type<string[]>(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("plugin_installs_plugin_owner_unique").on(t.pluginId, t.ownerType, t.ownerId),
    index("plugin_installs_owner_idx").on(t.ownerType, t.ownerId),
  ],
);

// ---------- bots ----------
export const bots = pgTable(
  "bots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    avatar: text("avatar"),
    systemPrompt: text("system_prompt").notNull().default(""),
    model: text("model").notNull().default("claude-sonnet-5"),
    temperature: real("temperature"),
    status: botStatus("status").notNull().default("creating"),
    defaultTemplate: text("default_template").notNull().default("desktop"),
    /**
     * Per-bot sandbox egress channel: true = public (clean IP, runtime `sandbox.ppio.cn`), false =
     * internal (gateway proxy). NULL = inherit the fleet default (env `SANDBOX_PUBLIC`), resolved
     * at box-create time. The channel the box actually lands on is pinned into `sandboxes.provider_meta`
     * so a reconnect always returns there; this column is only the preference for the NEXT create.
     */
    sandboxPublic: boolean("sandbox_public"),
    /** left-rail ordering WITHIN a tier (ascending); drag-to-reorder writes each bot's index. */
    sortOrder: integer("sort_order").notNull().default(0),
    /** pinned bots sort above unpinned ones in the rail (right-click → Pin to top). */
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bots_owner_idx").on(t.ownerId)],
);

// ---------- sandboxes (1:1 with a bot) ----------
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    provider: sandboxProvider("provider").notNull().default("ppio"),
    /** canonical provider handle (PPIO/AIProxy: base `sandboxID` from create body) */
    providerSandboxId: text("provider_sandbox_id"),
    templateId: text("template_id").notNull(),
    state: sandboxState("state").notNull().default("create"),
    /**
     * provider-specific routing kept out of the abstraction's columns.
     * PPIO/AIProxy: { controlId, clientId, domain, envdVersion }.
     * runtime host for port P = `${P}-${providerSandboxId}-${clientId}.${domain}`.
     */
    providerMeta: jsonb("provider_meta"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 1:1 — a bot has at most one sandbox row.
  (t) => [uniqueIndex("sandboxes_bot_unique").on(t.botId)],
);

// ---------- bot setup steps (ordered, replayed on fresh sandboxes) ----------
export const botSetupSteps = pgTable(
  "bot_setup_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    kind: setupStepKind("kind").notNull(),
    /** kind-specific: {pkg} for apt/pip/npm, {run} for cmd, {url,dest} for download */
    spec: jsonb("spec").notNull(),
    status: setupStepStatus("status").notNull().default("pending"),
    lastError: text("last_error"),
    /** the plugin this step was expanded from; null = added directly (pre-plugin, or ad hoc) */
    pluginId: uuid("plugin_id").references(() => plugins.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("bot_setup_steps_bot_ord_unique").on(t.botId, t.ord),
    index("bot_setup_steps_plugin_idx").on(t.pluginId),
  ],
);

// ---------- MCP servers (per bot) ----------
export const botMcpServers = pgTable(
  "bot_mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    transport: mcpTransport("transport").notNull(),
    command: text("command"),
    args: jsonb("args").$type<string[]>(),
    url: text("url"),
    /** encrypted at rest */
    headers: jsonb("headers").$type<Record<string, string>>(),
    /** encrypted at rest */
    env: jsonb("env").$type<Record<string, string>>(),
    toolFilter: jsonb("tool_filter").$type<string[]>(),
    /**
     * When set, this MCP server runs as a process INSIDE the bot's sandbox (not remote, not
     * a local stdio child of the API): bootstrap installs + starts it on `port`, and the agent
     * connects over HTTP through the gateway at `getHost(port)` (so `url` is derived at resolve
     * time, not stored). Null = the ordinary stdio/remote-url server described by the columns
     * above. `install` is replayed idempotently on a fresh sandbox; `health` is the readiness
     * path polled after `start`.
     */
    boxLocal: jsonb("box_local").$type<{
      install: string[];
      start: string;
      port: number;
      health: string;
      /** MCP endpoint path the server-side client dials (StreamableHTTP POST / SSE open) */
      path: string;
    }>(),
    enabled: boolean("enabled").notNull().default(true),
    /** the plugin this server was expanded from; null = bound directly (`bind_mcp`, pre-plugin) */
    pluginId: uuid("plugin_id").references(() => plugins.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bot_mcp_servers_bot_idx").on(t.botId),
    index("bot_mcp_servers_plugin_idx").on(t.pluginId),
  ],
);

// ---------- skills (Postgres is the source of truth) ----------
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: skillScope("scope").notNull(),
    /**
     * owner ref depends on scope: botId (uuid) | userId (text) | orgId | null(public).
     * text so it can hold either a text user id or a uuid bot id (polymorphic).
     */
    ownerRef: text("owner_ref"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    playbook: text("playbook").notNull(),
    steps: jsonb("steps").notNull().default([]),
    assets: jsonb("assets").$type<string[]>().notNull().default([]),
    /**
     * Glue scripts materialized alongside the playbook into the sandbox skill dir. Unlike
     * `assets` (bare string references), these carry their own content, so a skill is fully
     * reconstructable from the DB after a sandbox rebuild. Heavy third-party binaries do NOT
     * live here — those are `bot_setup_steps` (install commands), never stored bytes.
     */
    files: jsonb("files")
      .$type<{ path: string; content: string; mode?: string }[]>()
      .notNull()
      .default([]),
    /**
     * Names of `tenant_secrets` this skill references via `{{secrets.NAME}}`. Declarative only
     * (audit + resolve-time prefetch); the plaintext is never stored here or in the playbook.
     */
    secretRefs: jsonb("secret_refs").$type<string[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    /**
     * Reserved for future semantic retrieval. MVP does NOT use pgvector — this stays null.
     * Kept as jsonb (not a vector column) so the schema needs no pgvector extension yet.
     */
    embedding: jsonb("embedding").$type<number[]>(),
    /**
     * The plugin this skill was expanded from. Every plugin-expanded skill row is PER BOT
     * (`scope='bot'`, `ownerRef=botId`) — a builtin skill enabled on N bots is N rows — so tenant
     * isolation stays a SQL predicate rather than a scope convention. A user's own recorded skills
     * point at their bot's `local` plugin; null = a row written before plugins existed.
     */
    pluginId: uuid("plugin_id").references(() => plugins.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skills_scope_owner_idx").on(t.scope, t.ownerRef),
    index("skills_plugin_idx").on(t.pluginId),
  ],
);

// ---------- conversations (a thread, belongs to one bot) ----------
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_bot_idx").on(t.botId)],
);

// ---------- messages (interleaved content as AI SDK UIMessage.parts) ----------
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    /**
     * The interleaved content, verbatim as AI SDK `UIMessage.parts`
     * (text / file / reasoning / tool / ...). This one shape renders in the UI,
     * matches Mastra's message format, and converts to model input via
     * `convertToModelMessages()`. Bytes for any file part live in R2 (see attachments);
     * the part holds only the URL/key. Lossy model-input downgrade (e.g. dropping video
     * for Anthropic) happens at call time, never here.
     */
    parts: jsonb("parts").$type<MessagePart[]>().notNull().default([]),
    /** token usage, model id, latency, finish reason, ... */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

// ---------- attachments (binary artifacts in R2, referenced by a message part) ----------
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** R2 object key (bucket-relative); canonical location of the bytes */
    objectKey: text("object_key").notNull(),
    /** IANA media type, e.g. image/png, audio/mpeg, video/mp4, application/pdf */
    mediaType: text("media_type").notNull(),
    filename: text("filename"),
    sizeBytes: integer("size_bytes"),
    /** pixel dimensions for image/video */
    width: integer("width"),
    height: integer("height"),
    /** duration in ms for audio/video */
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

// ---------- per-user model credentials (1:1 with a user) ----------
/**
 * Each tenant stores their OWN model API key here. The agent loop resolves the bot
 * owner's key at chat time — the platform never lends its own key to a user's bots.
 * `apiKeyCiphertext` is AES-256-GCM (packed iv|tag|ct, base64), encrypted app-side in
 * apps/api; the plaintext key never touches Postgres or any log. `keyHint` is the last
 * few chars only, so the UI can show "····KeUy" without decrypting.
 */
export const userModelCredentials = pgTable("user_model_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
  keyHint: text("key_hint").notNull(),
  /** optional per-user gateway base URL (e.g. an AIProxy endpoint) */
  baseUrl: text("base_url"),
  /** optional default model id, used to prefill new-bot creation */
  defaultModel: text("default_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- tenant secrets (the vault behind {{secrets.NAME}}) ----------
/**
 * Credentials a bot's skills / external-API calls need, kept OUT of the sandbox and out of the
 * model's context. Referenced by name via `{{secrets.NAME}}` in a skill; the value is resolved,
 * decrypted, and injected server-side (as a command env var, never spliced into the command
 * string) at `run_command` time — see apps/api secrets vault. `ciphertext` is AES-256-GCM
 * (crypto.ts, packed iv|tag|ct); plaintext never touches Postgres or logs. `hint` is the last-4
 * for display. An MCP server's OWN auth lives in `bot_mcp_servers.headers/env`, not here — this
 * table is for secrets that don't belong to any one MCP server.
 *
 * Ownership: exactly one of `botId` / `userId` is set (per `ownerType`). A `user`-owned secret is
 * shared across that user's bots; a `bot`-owned one is scoped to the single bot. Because NULLs
 * are distinct in a unique index, uniqueness is enforced by two partial indexes (one per owner
 * kind) rather than one composite.
 */
export const tenantSecrets = pgTable(
  "tenant_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerType: secretOwner("owner_type").notNull(),
    botId: uuid("bot_id").references((): AnyPgColumn => bots.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** reference name — the NAME in `{{secrets.NAME}}` */
    name: text("name").notNull(),
    /** AES-256-GCM packed blob; plaintext never stored */
    ciphertext: text("ciphertext").notNull(),
    /** last-4 for display, never reveals the secret */
    hint: text("key_hint").notNull(),
    kind: secretKind("kind").notNull(),
    /** kind-specific: header → {headerName}; oauth → {refreshCiphertext, expiresAt, tokenUrl} */
    metadata: jsonb("metadata").$type<SecretMeta>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_secrets_bot_name")
      .on(t.botId, t.name)
      .where(sql`owner_type = 'bot'`),
    uniqueIndex("tenant_secrets_user_name")
      .on(t.userId, t.name)
      .where(sql`owner_type = 'user'`),
    index("tenant_secrets_bot_idx").on(t.botId),
  ],
);

// ---------- agent jobs (human-initiated background runs) ----------
/**
 * A detached agent run: it drives the sandbox independent of any open HTTP request while the
 * UI watches (now over SSE, formerly polling). Distinct from a foreground chat turn (which
 * streams over the open response and is never rowed here). `kind` says how it started — a
 * human-initiated `background` job, or a `subagent` the foreground agent spawned itself.
 *
 * Lifecycle only: running → done/error/canceled, plus the originating instruction and timings.
 * A `background` run persists its assistant output into `messages` like a foreground turn; a
 * `subagent` run does NOT (its internal steps stay out of the transcript) — instead its final
 * text lands in `result` and is relayed into the conversation when it settles.
 *
 * Concurrency: a bot can now have MANY running rows at once (the old one-running-per-bot unique
 * index is gone). Resource safety is enforced in-process by the GUI lease (only `needsDesktop`
 * runs contend for the single `:0`/Chrome) and a task-count cap, not by the DB. On an unclean
 * restart, any orphaned `running` rows are reconciled to `error` at boot.
 */
export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    status: agentJobStatus("status").notNull().default("running"),
    kind: agentJobKind("kind").notNull().default("background"),
    /**
     * whether this run needs the desktop/GUI (browser, screenshot, xdotool). GUI runs contend
     * for the exclusive GUI lease; non-GUI runs (pure `run_command`) run truly concurrently.
     */
    needsDesktop: boolean("needs_desktop").notNull().default(true),
    /** the originating instruction (human kickoff, or the goal the foreground agent set) */
    instruction: text("instruction").notNull().default(""),
    /** a subagent's final answer, relayed back into the conversation on settle; null otherwise */
    result: text("result"),
    /**
     * the foreground run that spawned this subagent, if any. Self-reference kept for lineage;
     * v1 forbids nested spawns (only a foreground turn spawns), so this is always null or a
     * foreground marker — reserved for future task trees.
     */
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => agentJobs.id, {
      onDelete: "set null",
    }),
    /** failure detail when status = error (never a secret); null otherwise */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_jobs_bot_idx").on(t.botId, t.createdAt),
    index("agent_jobs_conversation_idx").on(t.conversationId, t.createdAt),
    index("agent_jobs_parent_idx").on(t.parentJobId),
  ],
);

// Durable rules and executions. Secrets are encrypted server-side; views never expose them.
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    instruction: text("instruction").notNull(),
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    needsDesktop: boolean("needs_desktop").notNull().default(true),
    maxRunsPerDay: integer("max_runs_per_day").notNull().default(20),
    maxDurationSeconds: integer("max_duration_seconds").notNull().default(900),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    webhookKey: text("webhook_key"),
    callbackUrl: text("callback_url"),
    callbackKey: text("callback_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("automations_bot_idx").on(t.botId),
    index("automations_due_idx").on(t.enabled, t.nextRunAt),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    source: text("source").$type<"schedule" | "webhook" | "manual">().notNull(),
    status: text("status").$type<AutomationRunStatus>().notNull().default("queued"),
    input: jsonb("input").$type<Record<string, unknown>>(),
    resumeMessage: text("resume_message"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    summary: text("summary"),
    error: text("error"),
    resultMessageId: uuid("result_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    // Callback outbox lives on the execution; frozen body and target make retries deterministic.
    deliveryStatus: text("delivery_status").$type<"pending" | "delivered" | "failed">(),
    deliveryBody: jsonb("delivery_body").$type<Record<string, unknown>>(),
    deliveryUrl: text("delivery_url"),
    deliveryKey: text("delivery_key"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveryError: text("delivery_error"),
    deliveryNextAt: timestamp("delivery_next_at", { withTimezone: true }),
    deliveryLease: text("delivery_lease"),
    deliveryLeaseExpiresAt: timestamp("delivery_lease_expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("automation_runs_event_unique").on(t.automationId, t.eventId),
    uniqueIndex("automation_runs_running_bot_unique")
      .on(t.botId)
      .where(sql`status = 'running'`),
    index("automation_runs_queue_idx").on(t.status, t.availableAt),
    index("automation_runs_rule_idx").on(t.automationId, t.createdAt),
  ],
);
