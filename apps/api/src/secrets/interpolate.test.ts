/**
 * Interpolation's core guarantee: a `{{secrets.NAME}}` becomes an env-var REFERENCE in the command
 * and the plaintext rides a separate `env` map — so a resolved value never appears in the command
 * string. Plus the readback gate that stops an injected env var from being printed back out.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@i-bot/db";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto.js";
import {
  envVarFor,
  guardSecretReadback,
  interpolateSecrets,
  referencedSecretNames,
} from "./interpolate.js";

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

/** A fake db carrying one bot-scoped secret named `secretName` with value `secretValue`. */
function dbWith(secretName: string, secretValue: string): Database {
  return {
    query: {
      bots: { findFirst: async () => ({ ownerId: "owner-1" }) },
      tenantSecrets: {
        findMany: async () => [
          {
            name: secretName,
            ciphertext: encryptSecret(secretValue),
            kind: "bearer",
            metadata: null,
            ownerType: "bot",
            botId: "bot-1",
            userId: null,
          },
        ],
      },
    },
  } as unknown as Database;
}

describe("referencedSecretNames", () => {
  it("extracts distinct names, tolerating inner whitespace", () => {
    const names = referencedSecretNames(
      "a {{secrets.TOKEN}} b {{ secrets.TOKEN }} c {{secrets.OTHER}}",
    );
    expect(names.sort()).toEqual(["OTHER", "TOKEN"]);
  });

  it("finds none in a plain command", () => {
    expect(referencedSecretNames("ls -la /root")).toEqual([]);
  });
});

describe("interpolateSecrets", () => {
  it("replaces the placeholder with an env reference and puts the value in env, not the command", async () => {
    const db = dbWith("TOKEN", "s3cr3t-value-abc");
    const { command, env, missing } = await interpolateSecrets(
      db,
      "bot-1",
      'curl -H "Authorization: Bearer {{secrets.TOKEN}}" https://api.example',
    );

    // the value is nowhere in the command text
    expect(command).not.toContain("s3cr3t-value-abc");
    // the placeholder became a quoted env-var reference
    expect(command).toContain(`"$${envVarFor("TOKEN")}"`);
    // the value rides the env map
    expect(env[envVarFor("TOKEN")]).toBe("s3cr3t-value-abc");
    expect(missing).toEqual([]);
  });

  it("reports a referenced-but-unknown name as missing and leaves no literal braces", async () => {
    const db = dbWith("TOKEN", "v");
    const { command, env, missing } = await interpolateSecrets(
      db,
      "bot-1",
      "use {{secrets.ABSENT}} here",
    );
    expect(missing).toEqual(["ABSENT"]);
    expect(command).not.toContain("{{");
    expect(command).toContain(`"$${envVarFor("ABSENT")}"`);
    expect(env).toEqual({});
  });

  it("is a no-op for a command with no placeholders (no db round-trip needed)", async () => {
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
    const res = await interpolateSecrets(db, "bot-1", "echo hello");
    expect(res).toEqual({ command: "echo hello", env: {}, missing: [] });
    expect(touched).toBe(false);
  });
});

describe("guardSecretReadback", () => {
  it("blocks bare env / printenv", () => {
    expect(guardSecretReadback("env")).toBe("env");
    expect(guardSecretReadback("printenv")).toBe("printenv");
    expect(guardSecretReadback("printenv TOKEN")).toBe("printenv");
  });

  it("blocks reading /proc/*/environ", () => {
    expect(guardSecretReadback("cat /proc/self/environ")).toBe("/proc/*/environ");
    expect(guardSecretReadback("cat /proc/1/environ")).toBe("/proc/*/environ");
  });

  it("blocks a direct reference to the injected env var (exfiltration attempt)", () => {
    expect(guardSecretReadback("echo $IBOT_SECRET_TOKEN")).toBeTruthy();
    expect(guardSecretReadback("echo ${IBOT_SECRET_TOKEN}")).toBeTruthy();
    expect(guardSecretReadback("printf %s $ibot_secret_token")).toBeTruthy();
  });

  it("blocks bare `set` and `export -p` (they dump vars)", () => {
    expect(guardSecretReadback("set")).toBe("set");
    expect(guardSecretReadback("set ; echo done")).toBe("set");
    expect(guardSecretReadback("export -p")).toBe("export -p");
  });

  it("allows ordinary commands, including `set -e` and `env FOO=1 cmd`", () => {
    expect(guardSecretReadback("ls -la /root")).toBeNull();
    expect(guardSecretReadback("set -e; ./build.sh")).toBeNull();
    expect(guardSecretReadback("env FOO=1 ./run.sh")).toBeNull();
    expect(
      guardSecretReadback('curl -H "Authorization: Bearer {{secrets.TOKEN}}" https://api.example'),
    ).toBeNull();
    expect(guardSecretReadback("python3 /root/tasks/x/main.py")).toBeNull();
  });
});
