/**
 * The vault's security-critical behaviour: resolution is tenant-scoped (a bot sees only its own
 * bot-scoped secrets + its owner's user-scoped ones, never another tenant's), bot scope shadows
 * user scope, values round-trip through real encryption, and stored rows never hold plaintext.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@i-bot/db";
import type { SecretKind, SecretMeta } from "@i-bot/types";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto.js";
import {
  deleteSecret,
  isValidSecretName,
  listSecrets,
  putSecret,
  resolveSecrets,
  resolveSecretValues,
  SecretNameError,
} from "./vault.js";

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

interface Row {
  name: string;
  ciphertext: string;
  kind: SecretKind;
  metadata: SecretMeta | null;
  ownerType: "bot" | "user";
  botId: string | null;
  userId: string | null;
}

function row(
  partial: Partial<Row> & { name: string; value: string; ownerType: "bot" | "user" },
): Row {
  return {
    name: partial.name,
    ciphertext: encryptSecret(partial.value),
    kind: partial.kind ?? "bearer",
    metadata: partial.metadata ?? null,
    ownerType: partial.ownerType,
    botId: partial.botId ?? null,
    userId: partial.userId ?? null,
  };
}

/** A read-only fake: `bots.findFirst` yields the owner, `tenantSecrets.findMany` yields all rows
 *  (the vault applies the ownership filter in JS — exactly what these tests exercise). */
function readDb(ownerId: string | null, rows: Row[]): Database {
  return {
    query: {
      bots: { findFirst: async () => (ownerId ? { ownerId } : undefined) },
      tenantSecrets: { findMany: async () => rows },
    },
  } as unknown as Database;
}

describe("resolveSecrets — tenant isolation", () => {
  it("returns a bot's own bot-scoped secret, decrypted", async () => {
    const db = readDb("owner-1", [
      row({ name: "lark_token", value: "top-secret", ownerType: "bot", botId: "bot-1" }),
    ]);
    const out = await resolveSecrets(db, "bot-1", ["lark_token"]);
    expect(out.lark_token?.value).toBe("top-secret");
  });

  it("includes the owner's user-scoped secrets (shared across their bots)", async () => {
    const db = readDb("owner-1", [
      row({ name: "openai", value: "user-key", ownerType: "user", userId: "owner-1" }),
    ]);
    const out = await resolveSecretValues(db, "bot-1", ["openai"]);
    expect(out.openai).toBe("user-key");
  });

  it("does NOT return another bot's bot-scoped secret of the same name", async () => {
    const db = readDb("owner-1", [
      row({ name: "lark_token", value: "theirs", ownerType: "bot", botId: "bot-OTHER" }),
    ]);
    const out = await resolveSecrets(db, "bot-1", ["lark_token"]);
    expect(out.lark_token).toBeUndefined();
  });

  it("does NOT return another user's user-scoped secret of the same name", async () => {
    const db = readDb("owner-1", [
      row({ name: "openai", value: "theirs", ownerType: "user", userId: "owner-OTHER" }),
    ]);
    const out = await resolveSecrets(db, "bot-1", ["openai"]);
    expect(out.openai).toBeUndefined();
  });

  it("lets a bot-scoped secret shadow a user-scoped one of the same name", async () => {
    const db = readDb("owner-1", [
      row({ name: "token", value: "user-level", ownerType: "user", userId: "owner-1" }),
      row({ name: "token", value: "bot-level", ownerType: "bot", botId: "bot-1" }),
    ]);
    const out = await resolveSecretValues(db, "bot-1", ["token"]);
    expect(out.token).toBe("bot-level");
  });

  it("resolves nothing for an unknown bot (no owner → no user-scoped leakage)", async () => {
    const db = readDb(null, [
      row({ name: "openai", value: "user-key", ownerType: "user", userId: "owner-1" }),
    ]);
    const out = await resolveSecrets(db, "ghost-bot", ["openai"]);
    expect(out).toEqual({});
  });

  it("carries kind + headerName through for a header-kind secret", async () => {
    const db = readDb("owner-1", [
      row({
        name: "api",
        value: "k",
        ownerType: "bot",
        botId: "bot-1",
        kind: "header",
        metadata: { headerName: "X-Api-Key" },
      }),
    ]);
    const out = await resolveSecrets(db, "bot-1", ["api"]);
    expect(out.api?.kind).toBe("header");
    expect(out.api?.headerName).toBe("X-Api-Key");
  });

  it("returns {} for an empty name list without touching the db", async () => {
    let touched = false;
    const db = {
      query: {
        bots: {
          findFirst: async () => {
            touched = true;
            return { ownerId: "x" };
          },
        },
        tenantSecrets: {
          findMany: async () => {
            touched = true;
            return [];
          },
        },
      },
    } as unknown as Database;
    expect(await resolveSecrets(db, "bot-1", [])).toEqual({});
    expect(touched).toBe(false);
  });
});

describe("putSecret", () => {
  it("rejects an invalid secret name before any write", async () => {
    const db = {
      insert: () => {
        throw new Error("should not be called");
      },
    } as unknown as Database;
    await expect(
      putSecret(db, {
        owner: { ownerType: "bot", botId: "b1" },
        name: "bad name!",
        kind: "bearer",
        value: "v",
      }),
    ).rejects.toBeInstanceOf(SecretNameError);
  });

  it("encrypts the value and stores a hint, never the plaintext", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v);
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    } as unknown as Database;

    const view = await putSecret(db, {
      owner: { ownerType: "bot", botId: "b1" },
      name: "lark_token",
      kind: "bearer",
      value: "plaintext-value-xyz",
    });

    expect(captured).toHaveLength(1);
    const v = captured[0]!;
    expect(v.ownerType).toBe("bot");
    expect(v.botId).toBe("b1");
    expect(v.userId).toBeNull();
    expect(v.ciphertext).not.toContain("plaintext-value-xyz");
    expect(view.hint).toBe("····-xyz");
    expect(view).not.toHaveProperty("value");
  });

  it("stores headerName in metadata for a header-kind secret", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v);
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    } as unknown as Database;

    await putSecret(db, {
      owner: { ownerType: "user", userId: "u1" },
      name: "api",
      kind: "header",
      value: "k",
      headerName: "X-Api-Key",
    });
    expect((captured[0]!.metadata as SecretMeta).headerName).toBe("X-Api-Key");
  });
});

describe("listSecrets", () => {
  it("returns the masked view (hint + kind, never ciphertext)", async () => {
    const db = {
      query: {
        tenantSecrets: {
          findMany: async () => [
            { name: "t", kind: "bearer", hint: "····abcd", metadata: null, updatedAt: new Date(0) },
          ],
        },
      },
    } as unknown as Database;
    const out = await listSecrets(db, { ownerType: "bot", botId: "b1" });
    expect(out[0]).toMatchObject({ name: "t", kind: "bearer", hint: "····abcd", headerName: null });
    expect(out[0]).not.toHaveProperty("ciphertext");
  });
});

describe("deleteSecret", () => {
  it("issues a scoped delete", async () => {
    let whereArg: unknown;
    const db = {
      delete: () => ({
        where: async (w: unknown) => {
          whereArg = w;
        },
      }),
    } as unknown as Database;
    await deleteSecret(db, { ownerType: "bot", botId: "b1" }, "t");
    expect(whereArg).toBeDefined();
  });
});

describe("isValidSecretName", () => {
  it("accepts identifier-like names and rejects the rest", () => {
    expect(isValidSecretName("lark_token")).toBe(true);
    expect(isValidSecretName("OPENAI2")).toBe(true);
    expect(isValidSecretName("bad name")).toBe(false);
    expect(isValidSecretName("has-dash")).toBe(false);
    expect(isValidSecretName("")).toBe(false);
    expect(isValidSecretName("a".repeat(121))).toBe(false);
  });
});
