/**
 * The MCP runtime client's security-critical decisions, tested WITHOUT touching the network:
 *  - tool names are namespaced + sanitized (no cross-server collision, no shadowing a built-in);
 *  - a server's `{{secrets.NAME}}` auth headers resolve to real values tenant-scoped, and a header
 *    referencing a missing secret is DROPPED (never sent with braces, never sent empty-but-present);
 *  - stdio servers are refused server-side (they'd spawn a process on the platform host);
 *  - a box-local server is dialed at its live gateway host only when bootstrap started it.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@i-bot/db";
import type { McpServer } from "@i-bot/types";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto.js";
import { makeTransport, namespacedToolName, resolveHeaderSecrets } from "./mcp.js";

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
});

/** A vault-backed db carrying the given bot-scoped secrets. */
function secretDb(secrets: Record<string, string>): Database {
  return {
    query: {
      bots: { findFirst: async () => ({ ownerId: "owner-1" }) },
      tenantSecrets: {
        findMany: async () =>
          Object.entries(secrets).map(([name, value]) => ({
            name,
            ciphertext: encryptSecret(value),
            kind: "bearer",
            metadata: null,
            ownerType: "bot",
            botId: "bot-1",
            userId: null,
          })),
      },
    },
  } as unknown as Database;
}

function server(
  partial: Partial<McpServer> & { id: string; name: string; transport: McpServer["transport"] },
): McpServer {
  return {
    botId: "bot-1",
    command: null,
    args: null,
    url: null,
    headers: null,
    env: null,
    boxLocal: null,
    toolFilter: null,
    enabled: true,
    createdAt: "2026-09-15T00:00:00.000Z",
    ...partial,
  } as McpServer;
}

describe("namespacedToolName", () => {
  it("namespaces by server so two servers can't collide", () => {
    expect(namespacedToolName("linear", "search")).toBe("mcp__linear__search");
    expect(namespacedToolName("github", "search")).not.toBe(namespacedToolName("linear", "search"));
  });

  it("sanitizes characters outside the tool-name grammar", () => {
    const n = namespacedToolName("my server!", "do/a.thing");
    expect(n).toMatch(/^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/);
  });
});

describe("resolveHeaderSecrets", () => {
  it("resolves {{secrets.NAME}} to the real value (tenant-scoped)", async () => {
    const db = secretDb({ lark_token: "s3cr3t" });
    const out = await resolveHeaderSecrets(db, "bot-1", {
      Authorization: "Bearer {{secrets.lark_token}}",
    });
    expect(out.Authorization).toBe("Bearer s3cr3t");
  });

  it("DROPS a header whose referenced secret doesn't exist (never sends braces or a blank)", async () => {
    const db = secretDb({}); // no secrets
    const out = await resolveHeaderSecrets(db, "bot-1", {
      Authorization: "Bearer {{secrets.nope}}",
      "X-Static": "plain-value",
    });
    expect(out).not.toHaveProperty("Authorization");
    expect(out["X-Static"]).toBe("plain-value"); // non-secret headers pass through
  });
});

describe("makeTransport", () => {
  it("refuses a remote stdio server (would spawn a process on the platform host)", () => {
    const t = makeTransport(
      server({ id: "m1", name: "x", transport: "stdio", command: "some-bin" }),
      [],
      {},
    );
    expect(t).toBeNull();
  });

  it("refuses a remote http server with no url", () => {
    expect(
      makeTransport(server({ id: "m1", name: "x", transport: "http", url: null }), [], {}),
    ).toBeNull();
  });

  it("dials a remote http server at its stored url (Streamable HTTP)", () => {
    const t = makeTransport(
      server({ id: "m1", name: "x", transport: "http", url: "https://mcp.example/mcp" }),
      [],
      {},
    );
    expect(t?.transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(t?.target).toBe("https://mcp.example/mcp");
  });

  it("dials a remote sse server with the SSE transport", () => {
    const t = makeTransport(
      server({ id: "m1", name: "x", transport: "sse", url: "https://mcp.example/sse" }),
      [],
      {},
    );
    expect(t?.transport).toBeInstanceOf(SSEClientTransport);
  });

  it("dials a box-local server at its live gateway host + path, only when bootstrap started it", () => {
    const s = server({
      id: "box-1",
      name: "idx",
      transport: "http",
      boxLocal: {
        install: [],
        start: "idx --port 8931",
        port: 8931,
        health: "/health",
        path: "/mcp",
      },
    });
    // not started → no endpoint → not dialable
    expect(makeTransport(s, [], {})).toBeNull();
    // started → dial https://<host><path>
    const t = makeTransport(s, [{ id: "box-1", url: "8931-sbx.gw.example" }], {});
    expect(t?.transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(t?.target).toBe("https://8931-sbx.gw.example/mcp");
  });
});
