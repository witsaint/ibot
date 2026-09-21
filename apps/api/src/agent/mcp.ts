/**
 * MCP (Model Context Protocol) runtime client. At run start we resolve a bot's ENABLED MCP servers
 * from the DB, connect to each one server-side with the official `@modelcontextprotocol/sdk` client,
 * list its tools, and adapt every tool into an AI SDK `dynamicTool` the model can call. The tools
 * are merged into the run's toolset (namespaced `mcp__<server>__<tool>` so two servers can't collide
 * and can't shadow a built-in tool), and `close()` tears every client down when the run settles.
 *
 * Two server shapes:
 *  - **box-local** (`boxLocal` set): the server runs INSIDE the bot's sandbox (started by bootstrap).
 *    We dial it through the gateway at `https://<getHost(port)><path>`. The live host is only known
 *    at runtime, so the caller passes the started endpoints in (`boxEndpoints`).
 *  - **remote** (`url` set, transport `http`|`sse`): a server the bot's owner configured. We dial its
 *    stored `url` directly.
 *
 * **stdio is refused server-side.** A stdio server would spawn a subprocess on the PLATFORM host, not
 * the tenant's box — that breaks isolation and runs untrusted commands next to the API. Box-local is
 * the supported way to run a "local" MCP server (it lives in the tenant's own sandbox).
 *
 * **Secrets:** an MCP server's auth (`headers`/`env`) may contain `{{secrets.NAME}}`. Unlike the shell
 * path (which passes values via envd's `envs` channel and never into the command), an HTTP header must
 * carry the literal value — but this is a SERVER-SIDE TLS request the box and the model never see, so
 * resolving the value into the header here keeps it off the box and out of the model context. Values
 * are resolved tenant-scoped (a bot only ever sees its own + its owner's secrets).
 */
import { botMcpServers } from "@i-bot/db";
import type { Database } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import type { McpServer } from "@i-bot/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { and, eq } from "drizzle-orm";
import { referencedSecretNames } from "../secrets/interpolate.js";
import { resolveSecretValues } from "../secrets/vault.js";

/** A box-local MCP endpoint that bootstrap started (id + the gateway host it's reachable at). */
export interface BoxMcpEndpoint {
  id: string;
  /** bare gateway host from `getHost(port)` (no scheme) */
  url: string;
}

export interface McpToolset {
  tools: ToolSet;
  /** server names that connected + how many tools each contributed (for a system-prompt note/log) */
  connected: Array<{ name: string; tools: number }>;
  /** server names that failed to connect (best-effort: a bad server never fails the run) */
  failed: string[];
  /** close every MCP client. Call once when the run settles. Never throws. */
  close(): Promise<void>;
}

/** Options (timeouts + a logger); all optional with sane defaults. */
export interface McpConnectOptions {
  logger?: Logger;
  /** per-server connect + listTools budget (ms). Default 10s — a dead remote can't hang run start. */
  connectTimeoutMs?: number;
  /** per tool-call budget (ms). Default 60s. */
  callTimeoutMs?: number;
}

/** Tool-name segment grammar the model API accepts: letters/digits/_/-, non-empty. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "x";
}

/** Namespaced tool name: `mcp__<server>__<tool>`. Collision-safe across servers and vs. built-ins. */
export function namespacedToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

/**
 * Resolve `{{secrets.NAME}}` inside an MCP server's header/env map to real values (tenant-scoped).
 * Returns a plain string map safe to hand to the transport's `requestInit.headers`. A referenced
 * name with no secret is dropped (the header is omitted rather than sent with braces in it).
 */
export async function resolveHeaderSecrets(
  db: Database,
  botId: string,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const names = referencedSecretNames(Object.values(headers).join("\n"));
  const values = names.length ? await resolveSecretValues(db, botId, names) : {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    let missing = false;
    const filled = raw.replace(
      /\{\{\s*secrets\.([A-Za-z0-9_]{1,120})\s*\}\}/g,
      (_all, name: string) => {
        if (name in values) return values[name]!;
        missing = true;
        return "";
      },
    );
    if (!missing) out[key] = filled;
  }
  return out;
}

/** Build the transport for a server, or null if it can't be dialed server-side (stdio / no url). */
export function makeTransport(
  server: McpServer,
  boxEndpoints: BoxMcpEndpoint[],
  headers: Record<string, string>,
): { transport: StreamableHTTPClientTransport | SSEClientTransport; target: string } | null {
  const requestInit = Object.keys(headers).length ? { headers } : undefined;

  if (server.boxLocal) {
    // box-local: dial the live gateway host bootstrap started this server at.
    const ep = boxEndpoints.find((e) => e.id === server.id);
    if (!ep) return null; // not started (bootstrap failed / box cold) — skip, don't guess a host
    const base = `https://${ep.url}${server.boxLocal.path}`;
    const url = new URL(base);
    // box-local servers speak StreamableHTTP unless the row explicitly says sse.
    return server.transport === "sse"
      ? { transport: new SSEClientTransport(url, requestInit ? { requestInit } : {}), target: base }
      : {
          transport: new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : {}),
          target: base,
        };
  }

  // remote: only http/sse can be reached server-side. stdio would spawn a process on OUR host.
  if (server.transport === "stdio" || !server.url) return null;
  const url = new URL(server.url);
  return server.transport === "sse"
    ? {
        transport: new SSEClientTransport(url, requestInit ? { requestInit } : {}),
        target: server.url,
      }
    : {
        transport: new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : {}),
        target: server.url,
      };
}

/** Turn an MCP `callTool` content array into an AI SDK tool result (text joined; images as files). */
function toToolResult(result: {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}): unknown {
  const parts = result.content ?? [];
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  // Keep it JSON-able and compact. structuredContent (if the server returns it) is the richest form.
  if (result.structuredContent !== undefined) {
    return { ok: !result.isError, structured: result.structuredContent, ...(text ? { text } : {}) };
  }
  return { ok: !result.isError, text };
}

/**
 * Connect to a bot's enabled MCP servers and return their tools as an AI SDK toolset. Best-effort:
 * a server that fails to connect is logged and skipped (its name lands in `failed`), never throwing
 * into the run. The returned `close()` tears down every client — the caller MUST call it on settle.
 */
export async function connectBotMcpTools(
  db: Database,
  botId: string,
  boxEndpoints: BoxMcpEndpoint[],
  opts: McpConnectOptions = {},
): Promise<McpToolset> {
  const log = opts.logger;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 60_000;

  const servers = (await db.query.botMcpServers.findMany({
    where: and(eq(botMcpServers.botId, botId), eq(botMcpServers.enabled, true)),
  })) as unknown as McpServer[];

  const tools: ToolSet = {};
  const connected: Array<{ name: string; tools: number }> = [];
  const failed: string[] = [];
  const clients: Client[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        const headers = await resolveHeaderSecrets(db, botId, server.headers ?? {});
        const built = makeTransport(server, boxEndpoints, headers);
        if (!built) {
          // stdio remote, or box-local that never started — nothing we can dial.
          log?.warn(
            { botId, mcp: server.name, transport: server.transport },
            "MCP server not dialable server-side, skipping",
          );
          failed.push(server.name);
          return;
        }

        const client = new Client({ name: "i-bot", version: "1.0.0" });
        await client.connect(built.transport, { timeout: connectTimeoutMs });
        clients.push(client);

        const listed = await client.listTools(undefined, { timeout: connectTimeoutMs });
        const allow = server.toolFilter; // null = all tools
        let count = 0;
        for (const t of listed.tools) {
          if (allow && !allow.includes(t.name)) continue;
          const toolName = namespacedToolName(server.name, t.name);
          tools[toolName] = dynamicTool({
            description: t.description ?? `${server.name}: ${t.name}`,
            inputSchema: jsonSchema((t.inputSchema ?? { type: "object", properties: {} }) as never),
            async execute(args) {
              const res = await client.callTool(
                { name: t.name, arguments: (args ?? {}) as Record<string, unknown> },
                undefined,
                { timeout: callTimeoutMs },
              );
              return toToolResult(res as never);
            },
          });
          count++;
        }
        connected.push({ name: server.name, tools: count });
        log?.info(
          { botId, mcp: server.name, target: built.target, tools: count },
          "MCP server connected",
        );
      } catch (err) {
        failed.push(server.name);
        log?.warn(
          { botId, mcp: server.name, err: (err as Error).message },
          "MCP server connect failed",
        );
      }
    }),
  );

  return {
    tools,
    connected,
    failed,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
