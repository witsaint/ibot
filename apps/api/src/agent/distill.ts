/**
 * "Record → experience": distill a finished conversation into a reusable skill DRAFT.
 *
 * This is the analysis half of the recording feature. A bot's action trace is ALREADY persisted —
 * every tool call (desktop_action, run_command, browser actions, …) lands in `messages.parts`. So
 * Phase 1 needs no video and no new capture path: we replay that trace, compress it to a compact
 * transcript, and ask the OWNER'S model (never the platform's key) to generalize it into a named,
 * parameterized playbook. The result is a `SkillDraft` a human reviews before it's published as a
 * bot-scoped Skill (see routes/bots.ts). Human review is the quality + safety gate — the model is
 * asked to rewrite any literal credential it sees as `{{secrets.NAME}}`, but the reviewer confirms.
 *
 * Deliberately NOT here: screenshots/video (Phase 2), embeddings/retrieval (Phase 3), and any DB
 * write — this module only reads a model and returns a draft; persistence is the route's job.
 */
import type { LanguageModel } from "ai";
import { generateObject, getToolName, isToolUIPart, type UIMessage } from "ai";
import { z } from "zod";

/** The structured draft the model must return. Mirrors `SkillDraft` in @i-bot/types (kept local so
 * the generateObject schema is a plain zod object the SDK can drive without the branded re-exports). */
export const DraftSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe("Short, human-readable skill name (imperative, e.g. 'Export monthly sales report')."),
  description: z
    .string()
    .min(1)
    .describe("When to use this skill — one or two sentences, used later to match it to a task."),
  playbook: z
    .string()
    .min(1)
    .describe(
      "The reusable procedure as a numbered natural-language list. Generalize concrete values seen " +
        "in the trace into {placeholders}. Rewrite any literal credential/password/token as " +
        "{{secrets.NAME}} and list NAME in secretRefs. Describe intent ('click the Compose button'), " +
        "not raw coordinates.",
    ),
  steps: z
    .array(z.object({ note: z.string(), action: z.string().optional() }))
    .default([])
    .describe("Optional distilled step list; each note is one action in order."),
  secretRefs: z
    .array(z.string())
    .default([])
    .describe(
      "Names of credentials the playbook references as {{secrets.NAME}} (names only, never values).",
    ),
});

export type DistilledDraft = z.infer<typeof DraftSchema>;

/** Cap how much of any single tool argument/result we feed the model — a screenshot data URL or a
 * huge stdout would blow the context for no gain. The trace is about WHAT happened, not payloads. */
const MAX_FIELD = 400;

function clip(value: unknown): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  // Drop obvious binary/screenshot blobs entirely — they're noise in an action trace.
  if (/^data:image\//.test(s) || s.length > 4000) return `[${s.length} chars omitted]`;
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

/**
 * Flatten a conversation's UIMessages into a compact, model-readable trace: user asks, assistant
 * text, and each tool call as `tool(input) → ok|error`. Screenshots and oversized payloads are
 * elided. Returns "" when there's nothing actionable (caller should refuse to analyze).
 */
export function buildActionTrace(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") {
        const text = (part as { text?: string }).text?.trim();
        if (text) lines.push(`${m.role === "user" ? "USER" : "ASSISTANT"}: ${clip(text)}`);
        continue;
      }
      if (isToolUIPart(part)) {
        const name = getToolName(part);
        const p = part as {
          input?: unknown;
          output?: { ok?: boolean; error?: string } | unknown;
          state?: string;
        };
        const input = p.input === undefined ? "" : clip(p.input);
        const out = p.output as { ok?: boolean; error?: string } | undefined;
        const result =
          out && typeof out === "object"
            ? out.error
              ? `error: ${clip(out.error)}`
              : out.ok === false
                ? "error"
                : "ok"
            : (p.state ?? "");
        lines.push(`ACTION: ${name}(${input})${result ? ` → ${result}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT =
  "You turn a finished agent session into a REUSABLE skill another run can follow later. You are " +
  "given the user's request(s) and the exact sequence of actions the agent took. Extract the " +
  "GENERAL procedure, not this one run's specifics:\n" +
  "- Generalize concrete values (names, dates, amounts, URLs the task varies over) into {placeholders}.\n" +
  "- Skip dead-ends, retries, and corrections — describe the path that WORKED.\n" +
  "- Describe intent ('open the billing page', 'click Submit'), never raw pixel coordinates.\n" +
  "- If any password/token/API key appears, DO NOT copy its value — rewrite it as {{secrets.NAME}} " +
  "and put NAME in secretRefs.\n" +
  "- description = when to use this skill (for later matching). name = a short imperative label.\n" +
  "If the trace shows no coherent reusable task, still produce your best-effort draft; a human will review it.";

/**
 * Distill a conversation into a skill draft using the owner's model. `model` is already resolved
 * from the owner's credential (see resolveModel). Throws if the trace is empty (nothing to learn).
 */
export async function distillSkillDraft(
  model: LanguageModel,
  messages: UIMessage[],
): Promise<DistilledDraft> {
  const trace = buildActionTrace(messages);
  if (!trace.trim()) throw new Error("empty_trace");

  const { object } = await generateObject({
    model,
    schema: DraftSchema,
    system: SYSTEM_PROMPT,
    prompt: `Here is the session trace to distill into a skill:\n\n${trace}`,
  });
  // Normalize: secretRefs mentioned in the playbook but not listed (and vice-versa) — union the
  // {{secrets.X}} tokens actually present so the declared set matches the text a reviewer sees.
  const referenced = new Set<string>(object.secretRefs ?? []);
  for (const match of object.playbook.matchAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g)) {
    if (match[1]) referenced.add(match[1]);
  }
  return { ...object, secretRefs: [...referenced] };
}
