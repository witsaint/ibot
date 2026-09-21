/**
 * History pruning for the model call — NOT for storage.
 *
 * The desktop tools return full-frame PNG screenshots as base64 inside their tool-result
 * `output` (`{ ok, screenshot, text?, ... }`). A single 1280×800 frame is ~50–200k tokens,
 * and `convertToModelMessages` re-sends every past screenshot on every turn — so a handful
 * of tool calls blows past the model's context window (`prompt is too long: … > 1000000`).
 *
 * We keep the DB copy verbatim (the transcript, the audit trail) and only slim the array we
 * hand the model: the most recent screenshots stay (the model needs to see current desktop
 * state), older ones are replaced with a short placeholder while their `ok`/`text`/`error`
 * fields — the cheap, still-useful signal — are preserved. A message-count cap is a coarse
 * backstop for very long conversations. Pure function: never mutates its input.
 */
import { isToolUIPart, type UIMessage } from "ai";

export interface PruneOptions {
  /** How many of the most recent screenshots to keep at full fidelity. */
  keepScreenshots?: number;
  /** Hard cap on messages handed to the model (backstop for long chats). */
  maxMessages?: number;
}

const DEFAULTS: Required<PruneOptions> = { keepScreenshots: 2, maxMessages: 80 };

/** Placeholder swapped in for an omitted screenshot so the tool result stays structurally valid. */
export const OMITTED_SCREENSHOT = "[screenshot omitted to save context]";

/** A tool-result part whose output carries a base64 screenshot string. */
function screenshotOf(part: unknown): string | null {
  if (!isToolUIPart(part as never)) return null;
  const output = (part as { output?: unknown }).output;
  if (!output || typeof output !== "object") return null;
  const shot = (output as { screenshot?: unknown }).screenshot;
  return typeof shot === "string" && shot.length > 0 ? shot : null;
}

/**
 * Return a slimmed copy of `messages` safe to send to the model. The input is not mutated;
 * only parts that actually change are cloned.
 */
export function pruneHistoryForModel(messages: UIMessage[], opts: PruneOptions = {}): UIMessage[] {
  const { keepScreenshots, maxMessages } = { ...DEFAULTS, ...opts };

  // Coarse backstop first: keep the most recent `maxMessages`. Anthropic requires the first
  // message to be a user turn, so drop any leading assistant messages left after the slice.
  let windowed = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  const firstUser = windowed.findIndex((m) => m.role === "user");
  if (firstUser > 0) windowed = windowed.slice(firstUser);

  // Count screenshots so we know which ones fall outside the "keep most recent N" window.
  let totalShots = 0;
  for (const m of windowed) for (const p of m.parts) if (screenshotOf(p)) totalShots++;

  const dropBefore = Math.max(0, totalShots - keepScreenshots);
  if (dropBefore === 0 && windowed === messages) return messages; // nothing to do

  let seen = 0;
  return windowed.map((m) => {
    let changed = false;
    const parts = m.parts.map((p) => {
      const shot = screenshotOf(p);
      if (shot === null) return p;
      const keepThis = seen >= dropBefore;
      seen++;
      if (keepThis) return p;
      // Replace only the heavy screenshot field; keep ok/text/error intact.
      changed = true;
      const part = p as { output?: Record<string, unknown> };
      return {
        ...p,
        output: { ...part.output, screenshot: OMITTED_SCREENSHOT },
      } as typeof p;
    });
    return changed ? ({ ...m, parts } as UIMessage) : m;
  });
}
