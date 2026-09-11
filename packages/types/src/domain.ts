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
