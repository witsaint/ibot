/**
 * Guards at-rest encryption for user API keys: round-trip fidelity, that the ciphertext
 * isn't the plaintext, and that tampering is detected (GCM auth tag) rather than silently
 * returning corrupted output.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, keyHint } from "./crypto.js";

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("crypto", () => {
  it("round-trips a secret", () => {
    const secret = "dummy-test-key-0123456789-abcdefghijklmnop";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces ciphertext that is not the plaintext", () => {
    const secret = "sk-fake-secret-key";
    const blob = encryptSecret(secret);
    expect(blob).not.toContain(secret);
  });

  it("uses a fresh IV each time (same plaintext → different blobs)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("throws when the auth tag is tampered", () => {
    const blob = Buffer.from(encryptSecret("secret"), "base64");
    blob[13] = (blob[13] ?? 0) ^ 0xff; // flip a byte inside the auth tag region
    expect(() => decryptSecret(blob.toString("base64"))).toThrow();
  });

  it("throws on a truncated blob", () => {
    expect(() => decryptSecret("AAAA")).toThrow();
  });

  it("keyHint reveals only the last 4 chars", () => {
    expect(keyHint("abcdefghij")).toBe("····ghij");
    expect(keyHint("xy")).toBe("····");
  });
});
