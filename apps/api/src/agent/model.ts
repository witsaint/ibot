/**
 * Model provider wiring. The agent loop runs on the Vercel AI SDK (the substrate
 * AGENTS.md locks Mastra on top of); we use the Anthropic provider directly for the
 * computer-use loop.
 *
 * Multi-tenant: the key is NOT a server env var — it's the bot OWNER's own key, stored
 * encrypted per user and resolved at chat time (see `routes/settings.ts` + `crypto.ts`).
 * The platform never lends its own key to a user's bots. Missing key → a typed error so
 * the route can 503 cleanly ("add your key in settings") instead of throwing deep in the
 * stream.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("no model API key — add one in settings");
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * The gateway serves the Anthropic Messages API under `/v1` (`/v1/messages`), and the
 * SDK appends `/messages` to whatever base URL it's given — so the base must end in
 * `/v1`. A base URL supplied without it (a bare origin, or an ambient env var that
 * dropped the segment) would make the SDK POST to `/messages` → `403 forbidden`. We
 * normalize here so the wiring is robust to that drift instead of failing at runtime.
 */
export function normalizeGatewayBaseURL(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Per-request model credentials, resolved from the bot OWNER's stored settings. */
export interface ModelCredential {
  /** the tenant's own API key (decrypted just-in-time; never logged) */
  apiKey: string;
  /** optional per-user gateway base URL; falls back to the Anthropic default when absent */
  baseURL?: string | null;
}

/**
 * Build a language model for a bot's configured model id using the OWNER's credential.
 * Multi-tenant: each turn runs on the user's key, never the platform's.
 */
export function resolveModel(cred: ModelCredential, modelId: string): LanguageModel {
  if (!cred.apiKey) throw new ModelNotConfiguredError();
  const anthropic = createAnthropic({
    apiKey: cred.apiKey,
    ...(cred.baseURL ? { baseURL: normalizeGatewayBaseURL(cred.baseURL) } : {}),
  });
  return anthropic(modelId);
}
