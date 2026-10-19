/**
 * The skill preamble the model sees: names, when-to-use, playbook, on-box file paths, and secret
 * references (by NAME, never a value). Empty when the bot has no skills.
 */
import type { Database } from "@i-bot/db";
import type { Skill } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import { composeSkillPreamble, loadBotSkills } from "./skills.js";

const now = "2026-09-15T00:00:00.000Z";

function skill(partial: Partial<Skill> & { id: string; name: string }): Skill {
  return {
    scope: "bot",
    ownerRef: "bot-1",
    description: "does a thing",
    playbook: "step one; step two",
    steps: [],
    assets: [],
    files: [],
    secretRefs: [],
    version: 1,
    embedding: null,
    createdAt: now,
    ...partial,
  } as Skill;
}

describe("composeSkillPreamble", () => {
  it("returns empty string when there are no skills", () => {
    expect(composeSkillPreamble([])).toBe("");
  });

  it("lists name, description, and playbook", () => {
    const out = composeSkillPreamble([skill({ id: "s1", name: "Book a flight" })]);
    expect(out).toContain("## Your skills");
    expect(out).toContain("### Book a flight");
    expect(out).toContain("does a thing");
    expect(out).toContain("step one; step two");
  });

  it("points at the on-box file paths under the skill dir", () => {
    const out = composeSkillPreamble([
      skill({
        id: "sk9",
        name: "Lark",
        files: [{ path: "bin/send.sh", content: "x", mode: "755" }],
      }),
    ]);
    expect(out).toContain("/root/.ibot/skills/sk9/bin/send.sh");
  });

  it("references secrets by name as {{secrets.NAME}}, never a value", () => {
    const out = composeSkillPreamble([
      skill({ id: "s1", name: "Msg", secretRefs: ["lark_token"] }),
    ]);
    expect(out).toContain("{{secrets.lark_token}}");
    expect(out).toContain("you never see it");
  });
});

describe("loadBotSkills", () => {
  /**
   * Capture the WHERE drizzle is handed, so the tenant predicate itself is asserted — not just the
   * rows a stub chose to return. The SQL chunks include the literal scope value and the bound botId.
   */
  function capturingDb(): { db: Database; where: () => unknown } {
    let captured: unknown;
    const db = {
      query: {
        skills: {
          findMany: async (args: { where?: unknown }) => {
            captured = args.where;
            return [];
          },
        },
      },
    } as unknown as Database;
    return { db, where: () => captured };
  }

  /** Flatten a drizzle SQL object into the literal + bound values it carries. */
  function sqlText(node: unknown): string {
    const parts: string[] = [];
    const walk = (n: unknown) => {
      if (n == null) return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n === "object") {
        const rec = n as Record<string, unknown>;
        if (typeof rec.value === "string") parts.push(rec.value);
        if (rec.name) parts.push(String(rec.name));
        for (const key of ["queryChunks", "chunks", "left", "right", "conditions", "encoder"]) {
          if (key in rec) walk(rec[key]);
        }
        return;
      }
      parts.push(String(n));
    };
    walk(node);
    return parts.join(" ");
  }

  it("scopes to the one bot: bot-scoped AND this owner, with no unfiltered branch", async () => {
    const { db, where } = capturingDb();
    await loadBotSkills(db, "bot-42");
    const text = sqlText(where());
    expect(text).toContain("bot-42");
    expect(text).toContain("bot");
    // The retired `scope='public'` branch had NO owner column to filter on, so once plugins expand
    // shared capability into rows, an OR on it would read across tenants. It must not come back.
    expect(text).not.toContain("public");
  });
});
