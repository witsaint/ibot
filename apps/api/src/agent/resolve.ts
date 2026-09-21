/**
 * Context-free helpers to assemble what an agent run needs — the bot's run config (credential +
 * persona + model) and the conversation's UI-message history — without a Hono `Context`.
 *
 * The foreground chat routes have a `Context` and wrap these with owner-of-bot checks and
 * ready-to-send error responses (see `routes/chat.ts`). A proactive turn (the agent relaying a
 * finished task's result — see `jobs.ts`) has NO request in hand, so it calls these directly.
 * Isolation still holds: a proactive turn only ever runs for a bot/conversation the platform
 * itself spawned a task against, never one derived from an unauthenticated request.
 */
import type { SandboxHandle } from "@i-bot/core";
import type { Database } from "@i-bot/db";
import { bots, messages as messagesTable, userModelCredentials } from "@i-bot/db";
import type { MessagePart } from "@i-bot/types";
import { type UIMessage, validateUIMessages } from "ai";
import { asc, eq } from "drizzle-orm";
import { decryptSecret } from "../crypto.js";
import type { ModelCredential } from "./model.js";
import type { SandboxManager } from "../sandbox/manager.js";

/** The bot config a run needs, resolved from the DB (no request context). */
export interface BotRunConfig {
  botId: string;
  ownerId: string;
  systemPrompt: string;
  modelId: string;
  temperature: number | null;
  credential: ModelCredential;
  handle: SandboxHandle;
}

/** Why resolving a run config failed — mirrors the foreground route's error cases. */
export type ResolveFailure = "bot_not_found" | "no_model_key" | "sandbox_not_ready";

/**
 * Resolve the bot OWNER's model credential (decrypted just-in-time). Returns null if the owner
 * hasn't configured one — the platform never lends its key.
 */
export async function ownerCredentialFor(
  db: Database,
  ownerId: string,
): Promise<ModelCredential | null> {
  const row = await db.query.userModelCredentials.findFirst({
    where: eq(userModelCredentials.userId, ownerId),
    columns: { apiKeyCiphertext: true, baseUrl: true },
  });
  if (!row) return null;
  return { apiKey: decryptSecret(row.apiKeyCiphertext), baseURL: row.baseUrl };
}

/**
 * Gather a bot's run config (credential + persona + live handle). Returns `{ ok: false, reason }`
 * on any failure so callers map it to their own error shape (an HTTP response, or a log + bail).
 */
export async function resolveBotRunConfig(
  db: Database,
  sandboxes: SandboxManager,
  botId: string,
): Promise<{ ok: true; config: BotRunConfig } | { ok: false; reason: ResolveFailure }> {
  const bot = await db.query.bots.findFirst({ where: eq(bots.id, botId) });
  if (!bot) return { ok: false, reason: "bot_not_found" };

  const credential = await ownerCredentialFor(db, bot.ownerId);
  if (!credential) return { ok: false, reason: "no_model_key" };

  let handle: SandboxHandle;
  try {
    handle = await sandboxes.getHandle(botId);
  } catch {
    return { ok: false, reason: "sandbox_not_ready" };
  }

  return {
    ok: true,
    config: {
      botId,
      ownerId: bot.ownerId,
      systemPrompt: bot.systemPrompt,
      modelId: bot.model,
      temperature: bot.temperature,
      credential,
      handle,
    },
  };
}

/** Load a conversation's full history as validated UIMessages (read-only; no user insert). */
export async function loadHistory(db: Database, conversationId: string): Promise<UIMessage[]> {
  const rows = await db.query.messages.findMany({
    where: eq(messagesTable.conversationId, conversationId),
    orderBy: [asc(messagesTable.createdAt)],
  });
  return validateUIMessages({
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role === "system" ? "assistant" : r.role,
      parts: r.parts as MessagePart[],
    })) as unknown as UIMessage[],
  });
}
