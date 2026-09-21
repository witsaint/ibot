/**
 * The skill preamble the model sees: names, when-to-use, playbook, on-box file paths, and secret
 * references (by NAME, never a value). Empty when the bot has no skills.
 */
import type { Skill } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import { composeSkillPreamble } from "./skills.js";

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
