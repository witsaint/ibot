/**
 * The tenant secrets vault — the server-side home of every credential a skill or external API
 * call references via `{{secrets.NAME}}`. Three invariants hold the security model together:
 *
 *  1. **Plaintext is never stored.** Values are AES-256-GCM encrypted at rest (see `../crypto.js`);
 *     rows carry only the packed ciphertext + a last-4 hint. `listSecrets` returns the masked
 *     view; the plaintext leaves this module only through `resolveSecretValues`, in memory, on the
 *     server, to be handed to the box over envd's `envs` channel — never written into a config
 *     file, a command string, or the model's context.
 *
 *  2. **Resolution is tenant-scoped at the SQL layer.** A caller resolves secrets for a *bot*, and
 *     we derive the owning user from `bots.ownerId` ourselves — the resolve path never trusts an
 *     ownerId handed in from outside. A bot therefore sees exactly its own bot-scoped secrets plus
 *     its owner's user-scoped secrets, and nothing from any other tenant, even on a name collision.
 *
 *  3. **Bot scope shadows user scope.** When a bot-scoped and a user-scoped secret share a name,
 *     the bot-scoped one wins (the more specific binding), matching how config layering reads.
 */
import { bots, tenantSecrets } from "@i-bot/db";
import type { Database } from "@i-bot/db";
import type { SecretKind, SecretMeta } from "@i-bot/types";
import { and, eq, inArray } from "drizzle-orm";
import { decryptSecret, encryptSecret, keyHint } from "../crypto.js";

/** A secret name is the token in `{{secrets.NAME}}`; constrained so it is a valid env-var suffix. */
const NAME_RE = /^[A-Za-z0-9_]{1,120}$/;

/** True when `name` is a legal secret reference name (letters/digits/underscore, ≤120). */
export function isValidSecretName(name: string): boolean {
  return NAME_RE.test(name);
}

/** A resolved secret: the decrypted value plus the bits a consumer needs to present it. */
export interface ResolvedSecret {
  value: string;
  kind: SecretKind;
  /** for `header` kind: the header name the value is sent under (e.g. "X-Api-Key") */
  headerName: string | null;
}

/** Where a secret lives. `bot` = one bot; `user` = shared across all of a user's bots. */
export type SecretOwnerRef =
  | { ownerType: "bot"; botId: string }
  | { ownerType: "user"; userId: string };

/**
 * Resolve the decrypted VALUE of each requested secret for a bot, tenant-scoped. Returns a map of
 * only the names that exist (missing names are simply absent — the caller decides whether that is
 * an error). Bot-scoped secrets shadow user-scoped ones of the same name.
 *
 * This is the one function that returns plaintext. Callers must pass what it returns straight into
 * an `env` channel and never into a command string, a stored file, or a model-visible payload.
 */
export async function resolveSecretValues(
  db: Database,
  botId: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const resolved = await resolveSecrets(db, botId, names);
  const out: Record<string, string> = {};
  for (const [name, s] of Object.entries(resolved)) out[name] = s.value;
  return out;
}

/**
 * Like `resolveSecretValues` but returns the full `ResolvedSecret` (kind + headerName) for callers
 * that must present the value in a specific way — e.g. assembling an MCP server's auth header.
 */
export async function resolveSecrets(
  db: Database,
  botId: string,
  names: readonly string[],
): Promise<Record<string, ResolvedSecret>> {
  if (names.length === 0) return {};
  const unique = [...new Set(names)];

  // Derive the owner ourselves — never trust an ownerId from the caller. A bot with no row
  // resolves to nothing (rather than leaking another tenant's user-scoped secrets).
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    columns: { ownerId: true },
  });
  if (!bot) return {};

  const rows = await db.query.tenantSecrets.findMany({
    where: inArray(tenantSecrets.name, unique),
    columns: {
      name: true,
      ciphertext: true,
      kind: true,
      metadata: true,
      ownerType: true,
      botId: true,
      userId: true,
    },
  });

  // Keep only rows this bot is entitled to, and let bot scope shadow user scope per name.
  const out: Record<string, ResolvedSecret> = {};
  for (const row of rows) {
    const mine =
      (row.ownerType === "bot" && row.botId === botId) ||
      (row.ownerType === "user" && row.userId === bot.ownerId);
    if (!mine) continue;
    // bot scope wins: skip a user-scoped row if a bot-scoped one already filled this name
    if (out[row.name] && row.ownerType === "user") continue;
    out[row.name] = {
      value: decryptSecret(row.ciphertext),
      kind: row.kind,
      headerName: (row.metadata as SecretMeta | null)?.headerName ?? null,
    };
  }
  return out;
}

/** The masked shape returned by list/put — never the value, only a hint + kind + timestamps. */
export interface SecretView {
  name: string;
  kind: SecretKind;
  hint: string;
  headerName: string | null;
  updatedAt: string;
}

/** List a tenant's secrets (masked). Scope-exact: bot owner passes its bot; a user passes itself. */
export async function listSecrets(db: Database, owner: SecretOwnerRef): Promise<SecretView[]> {
  const rows = await db.query.tenantSecrets.findMany({
    where:
      owner.ownerType === "bot"
        ? and(eq(tenantSecrets.ownerType, "bot"), eq(tenantSecrets.botId, owner.botId))
        : and(eq(tenantSecrets.ownerType, "user"), eq(tenantSecrets.userId, owner.userId)),
    columns: { name: true, kind: true, hint: true, metadata: true, updatedAt: true },
  });
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    hint: r.hint,
    headerName: (r.metadata as SecretMeta | null)?.headerName ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Args for storing a secret. The plaintext `value` is encrypted here and never persisted raw. */
export interface PutSecretArgs {
  owner: SecretOwnerRef;
  name: string;
  kind: SecretKind;
  value: string;
  /** header name for `header` kind; extra oauth fields are set by the refresh path, not here */
  headerName?: string;
}

/**
 * Create or replace a secret (upsert on the scope's unique index). Encrypts the value, records a
 * hint, and merges `headerName` into metadata for `header` kind. Returns the masked view.
 */
export async function putSecret(db: Database, args: PutSecretArgs): Promise<SecretView> {
  if (!isValidSecretName(args.name)) {
    throw new SecretNameError(`invalid secret name "${args.name}" (allowed: A–Z a–z 0–9 _ , ≤120)`);
  }
  const metadata: SecretMeta | null =
    args.kind === "header" && args.headerName ? { headerName: args.headerName } : null;

  const base = {
    name: args.name,
    kind: args.kind,
    ciphertext: encryptSecret(args.value),
    hint: keyHint(args.value),
    metadata,
    updatedAt: new Date(),
  };

  const values =
    args.owner.ownerType === "bot"
      ? { ownerType: "bot" as const, botId: args.owner.botId, userId: null, ...base }
      : { ownerType: "user" as const, userId: args.owner.userId, botId: null, ...base };

  // Upsert on the partial unique index for this scope (owner_type is fixed per index).
  const target =
    args.owner.ownerType === "bot"
      ? [tenantSecrets.botId, tenantSecrets.name]
      : [tenantSecrets.userId, tenantSecrets.name];

  await db
    .insert(tenantSecrets)
    .values(values)
    .onConflictDoUpdate({
      target,
      set: {
        ciphertext: base.ciphertext,
        hint: base.hint,
        kind: base.kind,
        metadata,
        updatedAt: base.updatedAt,
      },
    });

  return {
    name: args.name,
    kind: args.kind,
    hint: base.hint,
    headerName: metadata?.headerName ?? null,
    updatedAt: base.updatedAt.toISOString(),
  };
}

/** Delete a secret by name within a scope. Idempotent (deleting a missing name is a no-op). */
export async function deleteSecret(
  db: Database,
  owner: SecretOwnerRef,
  name: string,
): Promise<void> {
  await db
    .delete(tenantSecrets)
    .where(
      owner.ownerType === "bot"
        ? and(
            eq(tenantSecrets.ownerType, "bot"),
            eq(tenantSecrets.botId, owner.botId),
            eq(tenantSecrets.name, name),
          )
        : and(
            eq(tenantSecrets.ownerType, "user"),
            eq(tenantSecrets.userId, owner.userId),
            eq(tenantSecrets.name, name),
          ),
    );
}

/** Thrown when a secret name doesn't satisfy the reference-name grammar. */
export class SecretNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretNameError";
  }
}
