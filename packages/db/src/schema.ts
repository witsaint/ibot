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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("bot_setup_steps_bot_ord_unique").on(t.botId, t.ord)],
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
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bot_mcp_servers_bot_idx").on(t.botId)],
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
    version: integer("version").notNull().default(1),
    /**
     * Reserved for future semantic retrieval. MVP does NOT use pgvector — this stays null.
     * Kept as jsonb (not a vector column) so the schema needs no pgvector extension yet.
     */
    embedding: jsonb("embedding").$type<number[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("skills_scope_owner_idx").on(t.scope, t.ownerRef)],
);
