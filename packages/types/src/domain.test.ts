import { describe, expect, it } from "vitest";
import {
  Attachment,
  Bot,
  Conversation,
  McpServer,
  Message,
  ModelInfo,
  Sandbox,
  Skill,
  TenantSecret,
  UI_EVENT_PART_TYPE,
  UiEventData,
  uiEventInstruction,
} from "./domain.js";

const now = "2026-09-11T00:00:00.000Z";

describe("Bot contract", () => {
  it("applies MVP defaults for a minimally-specified bot", () => {
    const bot = Bot.parse({
      id: "b1",
      ownerId: "u1",
      name: "Scout",
      createdAt: now,
      updatedAt: now,
    });
    expect(bot.model).toBe("claude-sonnet-5");
    expect(bot.defaultTemplate).toBe("desktop");
    expect(bot.status).toBe("creating");
    expect(bot.temperature).toBeNull();
    expect(bot.systemPrompt).toBe("");
    // rail ordering: a fresh bot is unpinned at index 0 until a drag / pin writes it
    expect(bot.pinned).toBe(false);
    expect(bot.sortOrder).toBe(0);
  });

  it("rejects an empty name and out-of-range temperature", () => {
    expect(
      Bot.safeParse({ id: "b1", ownerId: "u1", name: "", createdAt: now, updatedAt: now }).success,
    ).toBe(false);
    expect(
      Bot.safeParse({
        id: "b1",
        ownerId: "u1",
        name: "ok",
        temperature: 3,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });
});

describe("ModelInfo contract", () => {
  it("carries a provider id + display label for the model picker", () => {
    const m = ModelInfo.parse({ id: "claude-sonnet-5", displayName: "Claude Sonnet 5" });
    expect(m.id).toBe("claude-sonnet-5");
    expect(m.displayName).toBe("Claude Sonnet 5");
  });

  it("requires both fields (the endpoint fills displayName from id when absent)", () => {
    expect(ModelInfo.safeParse({ id: "only-id" }).success).toBe(false);
  });
});

describe("Sandbox contract", () => {
  it("defaults provider to ppio and leaves routing meta null until provisioned", () => {
    const sb = Sandbox.parse({
      id: "s1",
      botId: "b1",
      templateId: "desktop",
      createdAt: now,
      updatedAt: now,
    });
    expect(sb.provider).toBe("ppio");
    expect(sb.state).toBe("create");
    expect(sb.providerSandboxId).toBeNull();
    expect(sb.providerMeta).toBeNull();
  });
});

describe("Skill contract", () => {
  it("keeps embedding null for the MVP (no pgvector)", () => {
    const skill = Skill.parse({
      id: "sk1",
      scope: "public",
      ownerRef: null,
      name: "Book a flight",
      description: "d",
      playbook: "p",
      createdAt: now,
    });
    expect(skill.embedding).toBeNull();
    expect(skill.version).toBe(1);
    expect(skill.steps).toEqual([]);
    // new mounting fields default empty — a plain playbook skill carries no scripts/secrets
    expect(skill.files).toEqual([]);
    expect(skill.secretRefs).toEqual([]);
  });

  it("carries glue-script files and secret refs when mounting a richer skill", () => {
    const skill = Skill.parse({
      id: "sk2",
      scope: "bot",
      ownerRef: "b1",
      name: "Lark message",
      description: "send a Feishu message",
      playbook: "run bin/send.sh with the target",
      files: [{ path: "bin/send.sh", content: "#!/bin/sh\ncurl ...", mode: "755" }],
      secretRefs: ["lark_token"],
      createdAt: now,
    });
    expect(skill.files[0]?.path).toBe("bin/send.sh");
    expect(skill.files[0]?.mode).toBe("755");
    expect(skill.secretRefs).toEqual(["lark_token"]);
  });
});

describe("McpServer contract", () => {
  it("defaults boxLocal null (ordinary stdio/remote server)", () => {
    const mcp = McpServer.parse({
      id: "mcp1",
      botId: "b1",
      name: "github",
      transport: "http",
      url: "https://mcp.example/sse",
      createdAt: now,
    });
    expect(mcp.boxLocal).toBeNull();
    expect(mcp.enabled).toBe(true);
  });

  it("accepts a box-local server spec (runs inside the sandbox)", () => {
    const mcp = McpServer.parse({
      id: "mcp2",
      botId: "b1",
      name: "repo-index",
      transport: "http",
      boxLocal: { start: "repo-index-mcp --port 8931", port: 8931 },
      createdAt: now,
    });
    expect(mcp.boxLocal?.port).toBe(8931);
    expect(mcp.boxLocal?.health).toBe("/health"); // default
    expect(mcp.boxLocal?.install).toEqual([]); // default
  });
});

describe("TenantSecret contract", () => {
  it("stores only a hint + kind, never plaintext, and defaults metadata null", () => {
    const s = TenantSecret.parse({
      id: "s1",
      ownerType: "bot",
      botId: "b1",
      name: "lark_token",
      hint: "····KeUy",
      kind: "bearer",
      createdAt: now,
      updatedAt: now,
    });
    expect(s.metadata).toBeNull();
    expect(s.userId).toBeNull();
    expect(s).not.toHaveProperty("ciphertext"); // contract never exposes the value
  });

  it("carries oauth refresh metadata when the kind needs it", () => {
    const s = TenantSecret.parse({
      id: "s2",
      ownerType: "user",
      userId: "u1",
      name: "gcal",
      hint: "····9aA1",
      kind: "oauth",
      metadata: {
        refreshCiphertext: "blob",
        expiresAt: now,
        tokenUrl: "https://oauth.example/token",
      },
      createdAt: now,
      updatedAt: now,
    });
    expect(s.metadata?.tokenUrl).toBe("https://oauth.example/token");
  });
});

describe("Conversation contract", () => {
  it("defaults title to null", () => {
    const c = Conversation.parse({ id: "c1", botId: "b1", createdAt: now, updatedAt: now });
    expect(c.title).toBeNull();
  });
});

describe("Message contract", () => {
  it("accepts interleaved text/image/video parts verbatim and defaults metadata null", () => {
    const msg = Message.parse({
      id: "m1",
      conversationId: "c1",
      role: "assistant",
      parts: [
        { type: "text", text: "here is the chart" },
        { type: "file", mediaType: "image/png", url: "https://r2.example/img.png" },
        { type: "text", text: "and the clip" },
        { type: "file", mediaType: "video/mp4", url: "https://r2.example/clip.mp4" },
      ],
      createdAt: now,
    });
    expect(msg.parts).toHaveLength(4);
    // order is preserved — the interleaving is the semantics
    expect(msg.parts[1]).toMatchObject({ type: "file", mediaType: "image/png" });
    expect(msg.metadata).toBeNull();
  });

  it("rejects a role outside system/user/assistant and a part with no type", () => {
    expect(
      Message.safeParse({ id: "m1", conversationId: "c1", role: "tool", parts: [], createdAt: now })
        .success,
    ).toBe(false);
    expect(
      Message.safeParse({
        id: "m1",
        conversationId: "c1",
        role: "user",
        parts: [{ text: "no type field" }],
        createdAt: now,
      }).success,
    ).toBe(false);
  });
});

describe("Attachment contract", () => {
  it("requires objectKey + mediaType and nulls optional dimensions", () => {
    const a = Attachment.parse({
      id: "a1",
      messageId: "m1",
      objectKey: "bots/b1/conv/c1/clip.mp4",
      mediaType: "video/mp4",
      createdAt: now,
    });
    expect(a.filename).toBeNull();
    expect(a.sizeBytes).toBeNull();
    expect(a.durationMs).toBeNull();
    expect(a.width).toBeNull();
  });
});

describe("UiEventData contract", () => {
  it("defaults context to an empty object", () => {
    const ev = UiEventData.parse({ surfaceId: "s1", name: "bing_search" });
    expect(ev.context).toEqual({});
    expect(ev.label).toBeUndefined();
  });

  it("rides as a data-uiEvent part on a user Message", () => {
    const msg = Message.parse({
      id: "m1",
      conversationId: "c1",
      role: "user",
      parts: [
        { type: "text", text: 'I submitted the "Search" panel control with query: cats.' },
        { type: UI_EVENT_PART_TYPE, data: { surfaceId: "s1", name: "search", context: {} } },
      ],
      createdAt: now,
    });
    expect(msg.parts[1]!.type).toBe("data-uiEvent");
  });

  it("builds a clean model instruction — no protocol tag, no bare JSON", () => {
    const withCtx = uiEventInstruction({
      surfaceId: "s1",
      name: "bing_search",
      label: "Search",
      context: { query: "1+1" },
    });
    expect(withCtx).toBe('I submitted the "Search" panel control with query: 1+1.');
    expect(withCtx).not.toContain("[panel action]");

    // No context → a plain interaction sentence; falls back to `name` when no label.
    const noCtx = uiEventInstruction({ surfaceId: "s1", name: "refresh", context: {} });
    expect(noCtx).toBe('I interacted with the "refresh" panel control.');
  });

  it("serializes non-string context values as JSON in the instruction", () => {
    const line = uiEventInstruction({
      surfaceId: "s1",
      name: "pick",
      context: { tags: ["a", "b"], count: 3 },
    });
    expect(line).toContain('tags: ["a","b"]');
    expect(line).toContain("count: 3");
  });
});
