import type { Skill } from "./domain.js";

/** Only a command at the beginning of the first text part in a NEW user message counts. */
export function skillCommandFromParts(
  parts: readonly { type?: string; text?: unknown }[],
): string | undefined {
  const part = parts.find((p) => p.type === "text");
  if (typeof part?.text !== "string") return undefined;
  return /^\/([a-z][a-z0-9-]{0,39})(?=\s|$)/.exec(part.text.trimStart())?.[1];
}

export type SkillListItem = Skill & { command?: string };
