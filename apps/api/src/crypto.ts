/**
 * At-rest encryption for per-user secrets (model API keys).
 *
 * AES-256-GCM via node:crypto. The 32-byte key comes from `SECRETS_ENCRYPTION_KEY`
 * (base64) — a dedicated secret, never the auth signing secret, so key rotation and
 * auth are independent concerns. The packed blob is `base64(iv | authTag | ciphertext)`:
 * a 12-byte random IV per encryption (GCM's nonce), the 16-byte auth tag, then the
 * ciphertext. Decryption verifies the tag, so any tampering throws rather than returning
 * garbage. Plaintext keys never touch Postgres or logs — only the packed blob is stored.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/** Decode + validate the 32-byte key from env once. Throws loudly on misconfig. */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error("SECRETS_ENCRYPTION_KEY is not set — cannot encrypt user secrets");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`SECRETS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  cachedKey = key;
  return key;
}

/** Encrypt a plaintext secret → packed base64 blob `iv|tag|ciphertext`. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a packed base64 blob produced by `encryptSecret`. Throws if tampered/invalid. */
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext blob is too short");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Last-4 hint for display (never reveals the key). Short keys collapse to "····". */
export function keyHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return plaintext.length <= 4 ? "····" : `····${tail}`;
}
