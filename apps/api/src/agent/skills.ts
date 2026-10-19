/**
 * Skill retrieval + preamble for an agent run. A skill is a reusable "how to do X" the bot has
 * learned; its source of truth is the DB (never only the sandbox). At run start we load the bot's
 * applicable skills and compose a compact system-prompt section so the model knows what it can do
 * and HOW to invoke each one — the glue-files are already rendered into the box by bootstrap under
 * `/root/.ibot/skills/<id>/`, so the preamble just points the model at them.
 *
 * Playbooks live server-side (here), not in the box: they're instructions for the model, not files
 * the box executes. Secret VALUES are never in a playbook — a skill references them as
 * `{{secrets.NAME}}`, resolved + injected server-side when the model runs the command.
 */
import type { Database } from "@i-bot/db";
import { skills as skillsTable } from "@i-bot/db";
import type { Skill } from "@i-bot/types";
import { and, eq } from "drizzle-orm";
import { skillDir } from "../sandbox/bootstrap.js";

/** A loaded skill row, plus the plugin it was expanded from (null for a row that predates plugins). */
export type LoadedSkill = Skill & { pluginId: string | null };

/**
 * Load the skills applicable to a bot: exactly its own, `scope='bot' AND ownerRef=botId`.
 *
 * This predicate is the tenant boundary, so it stays a single AND with no OR branch. It previously
 * also loaded every `scope='public'` row — and `public` has no owner column, so any such row would
 * have been readable by every tenant's bots. Nothing wrote those rows, so nothing leaked, but the
 * plugin layer is about to expand shared capability into per-bot rows, and a shared-scope shortcut
 * would have turned that into a real cross-tenant read. "Public" now lives one level up, as a
 * `builtin` plugin whose skills are materialized per bot (each row owned, each row filtered here).
 */
export async function loadBotSkills(db: Database, botId: string): Promise<LoadedSkill[]> {
  const rows = await db.query.skills.findMany({
    where: and(eq(skillsTable.scope, "bot"), eq(skillsTable.ownerRef, botId)),
  });
  return rows as unknown as LoadedSkill[];
}

/**
 * Compose a system-prompt section describing a bot's skills. Returns "" when there are none (the
 * caller then adds nothing to the prompt). Each entry gives the model the name, when to use it
 * (description), the playbook, the referenced secrets (by name — never values), and the on-box
 * directory its files live in so a `run_command` can execute them.
 */
export function composeSkillPreamble(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((s) => {
    const lines = [`### ${s.name}`, s.description];
    if (s.playbook.trim()) lines.push("", s.playbook.trim());
    if (s.files.length > 0) {
      const paths = s.files.map((f) => `${skillDir(s.id)}/${f.path}`).join(", ");
      lines.push("", `Files available in the sandbox: ${paths}`);
    }
    if (s.secretRefs.length > 0) {
      lines.push(
        "",
        `Uses stored credentials — reference them in a run_command as ${s.secretRefs
          .map((n) => `{{secrets.${n}}}`)
          .join(", ")} (the value is injected at run time; you never see it).`,
      );
    }
    return lines.join("\n");
  });
  return (
    "## Your skills\n" +
    "These are reusable procedures you've learned. When a task matches one, follow its playbook. " +
    "Skill files are already present in the sandbox at the paths listed — run them with " +
    "`run_command`.\n\n" +
    blocks.join("\n\n")
  );
}
