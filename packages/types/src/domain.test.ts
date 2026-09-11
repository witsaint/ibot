import { describe, expect, it } from "vitest";
import { Bot, Sandbox, Skill } from "./domain.js";

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
  });
});
