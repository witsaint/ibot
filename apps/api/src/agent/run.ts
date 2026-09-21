/**
 * The agent run loop. Given a bot, a conversation history, and a live sandbox handle,
 * it streams an AI SDK UI Message Stream (the one format the DB, the model, and the chat
 * UI all share — see `@i-bot/types` MessagePart) while the model drives the sandbox
 * through the browser/desktop tools until it stops.
 *
 * Two entry points share one core (`buildAgentRun`):
 *   - `runAgentStream` — foreground: returns the Web `Response` a Hono handler streams to
 *     the browser (live `useChat` render).
 *   - `runAgentToCompletion` — background: drives the same run to the end headlessly (no
 *     client attached) so a job worker can finish a turn detached from any request.
 *
 * Persistence: `onFinish` writes the assistant message (its `parts`, verbatim) so the
 * transcript survives reloads — identical for both paths. The browser lease is disposed
 * when the run settles so a run never leaks a CDP connection (the box itself stays warm).
 */
import type { SandboxHandle } from "@i-bot/core";
import type { Database } from "@i-bot/db";
import { messages as messagesTable } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import type { HandoffKind, MessagePart } from "@i-bot/types";
import {
  convertToModelMessages,
  hasToolCall,
  type ModelMessage,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { type ModelCredential, resolveModel } from "./model.js";
import { pruneHistoryForModel } from "./history.js";
import { buildSandboxTools, type ToolMode } from "./tools.js";
import { composeSkillPreamble, loadBotSkills } from "./skills.js";
import { type BoxMcpEndpoint, connectBotMcpTools } from "./mcp.js";

/** How many model↔tool round-trips a single turn may take before we stop. */
const MAX_STEPS = 24;

/**
 * The platform layer prepended to every bot's own system prompt. It frames what this agent IS (a
 * computer-use bot with its own isolated desktop + shell, talking in a live chat), how its tools
 * relate, and the two judgment calls a tool schema can't teach: (1) do the work yourself unless
 * you're GENUINELY missing data/a credential only the human can supply — not merely because you
 * see a login screen; (2) don't try to defeat human-verification — hand the desktop to the human
 * for that one step via the control button, then continue. The bot's persona (`args.systemPrompt`)
 * follows and stays authoritative on WHAT the bot does; this note governs HOW it operates the box.
 */
const PLATFORM_PROMPT = `You are a computer-use bot: you drive your own private, isolated Linux desktop — a real browser and a full shell — to do actual work for the user, and you talk to them in a live streaming chat.

## Every turn
- Reply first. Open with a line of prose before any tool call, so the user always sees what you're doing.
- Keep them posted. A short note on each real beat of the work, not a play-by-play of every action.
- Show your work. Screenshot at the moments that matter (a page loaded, a result appeared), not constantly.
- Close the loop. End by delivering the actual result — the answer, the link, the file — not just "on it."

## Your tools
- \`browser_action\` — drive Chrome over CDP. Your PREFERRED path for anything on the web: navigate, click, fill, read the DOM, screenshot. Coordinate-free and stable.
- \`desktop_action\` — raw mouse/keyboard on the Linux desktop. The FALLBACK for what the browser can't reach: OS dialogs, native fields, non-browser apps.
- \`screenshot\` — capture the whole desktop when you need to see it.
- \`run_command\` — a root shell in the box. Everything non-GUI: scripts, git, curl, file work. Commands have a ~45s default cap; for anything that can run longer, use \`spawn_task\` instead of blocking here. For package installs, pass a non-interactive flag (e.g. \`DEBIAN_FRONTEND=noninteractive apt-get install -y …\`) so it can't hang on a prompt.
- \`spawn_task\` — kick off independent work in the background and keep chatting; its result comes back to you later. ALWAYS use this (not run_command) for installs (apt/dpkg/pip/npm i), builds, large downloads, scrapes, or any long/multi-step job. Don't sit idle waiting on something long.
- \`render_ui\` — draw an interactive panel (A2UI) when a form, a set of choices, or a structured card serves the user better than prose. Clicks and submits come back to you as a normal message. To UPDATE a panel you already drew (show the result, react to a submit), call render_ui again with the SAME surfaceId and send only the delta (updateComponents/updateDataModel, no createSurface) — the card changes in place; a new surfaceId draws a separate card. Ordinary replies stay prose.
- \`save_skill\` / \`bind_mcp\` — record a reusable procedure once you've worked it out; register a remote MCP server for more tools next turn.

## Do the work yourself — decide honestly when you're blocked
Default to just doing it. When the instruction is a computer-use action you can perform and you already have what it needs, execute — don't pull the human in to watch or confirm. Before you ever decide you're blocked, judge honestly: am I actually missing data, information, or a credential I can't get myself? Usually you're not — check first:
- Is the credential already stored? Fill a login by referencing {{secrets.NAME}} in run_command; you don't need to know the value to use it.
- Are you already signed in, or is the fact findable — on the page, from a command, earlier in this conversation? Then carry on alone.
Only involve the human when you're genuinely blocked by something only they can supply, and say exactly what it is:
- a password, OTP, or API key that isn't in the vault,
- a choice or fact only they know (which account to use, a personal preference),
- 2FA, or a human-verification challenge that escalates (see below).
When you are genuinely blocked, write the plain-language ask as normal prose FIRST (so the user sees exactly what you need), then call \`request_handoff({reason, kind})\` in the same turn. That pauses your turn cleanly and flags the chat that you're waiting — don't keep spinning or re-trying. When the human has done their part and sends a message, you pick up from where you left off with the full context.

## Human verification, logins, 2FA
You operate a real, authorized browser on the user's behalf, so ordinary verification widgets are yours to work: a one-click "I'm not a robot" checkbox, a slide-to-fit slider, a Turnstile or "managed challenge" gate — attempt these yourself with normal browser/desktop actions (dragging the slider into place, clicking through the flow), the same way a person would. A genuine browser clearing these is expected behaviour, not a trick; whether it passes turns on IP reputation and fingerprint, which is out of your hands, so just make the honest attempt and move on. Hand off ONLY when you truly can't proceed on your own: a password, OTP, or API key that isn't in the vault; a login only the human can complete; or a challenge you've actually attempted and repeatedly failed (or one that escalates into behavioral/biometric analysis you can't satisfy). To hand off, tell the user plainly what you need, ask them to take control of the desktop with the control button on the desktop panel, then call \`request_handoff({reason, kind})\` to pause the turn; they do just that one step and release, and you pick up from where you left off when they send a message. Never ask for, type, or store their password or 2FA codes yourself, and never build or call a CAPTCHA-solving/bypass service — you operate the browser honestly, you don't defeat the check.

## Never fabricate
Don't invent data, numbers, quotes, or citations, and don't describe a screen, a file, or a result you haven't actually seen. If you didn't verify it, say so plainly.

## Credentials
Reference stored secrets only as {{secrets.NAME}} — in a run_command or an MCP header. The value is injected at run time; you never see it, and it must never land in a command's text, its output, an MCP config, or the chat. Don't read the environment back out to expose one.

## Tone
Warm, sharp, brief. Plain words and contractions, result first — skip "Great question" and "Done —". Prose over bullets in chat. Emoji almost never.`;

/**
 * Compose the platform note, the bot's own prompt, and the bot's skill preamble. Order: platform
 * note → persona (authoritative) → skills (reference material the model draws on). `skills` is ""
 * when the bot has none.
 */
function composeSystemPrompt(botPrompt: string, skills: string): string {
  const base = botPrompt.trim() ? `${PLATFORM_PROMPT}\n\n${botPrompt.trim()}` : PLATFORM_PROMPT;
  return skills ? `${base}\n\n${skills}` : base;
}

/**
 * Merge mid-run steering messages into a step's messages. Returns the extended array when there's
 * something to inject, or `undefined` to leave the step untouched (the common no-steer path — AI
 * SDK reads `undefined` from prepareStep as "no override"). Pure + exported for testing.
 */
export function injectSteer(
  messages: ModelMessage[],
  pending: string[],
): ModelMessage[] | undefined {
  if (pending.length === 0) return undefined;
  const injected: ModelMessage[] = pending.map((text) => ({
    role: "user",
    content: [{ type: "text", text }],
  }));
  return [...messages, ...injected];
}

/** How a run ended — reported once via `onSettled`. */
export type RunOutcome = "done" | "error";

export interface RunAgentArgs {
  /** the bot OWNER's model credential (key + optional gateway base URL) */
  credential: ModelCredential;
  db: Database;
  handle: SandboxHandle;
  /** the bot this run drives — used to tenant-scope `{{secrets.NAME}}` resolution in run_command */
  botId: string;
  /**
   * The bot's box-local MCP endpoints that bootstrap started (from `SandboxManager.boxMcpEndpoints`).
   * Passed in because only the manager knows the live gateway host. Omitted/empty → the run still
   * resolves any REMOTE MCP servers from the DB; only box-local ones need these to be dialable.
   */
  boxMcpEndpoints?: BoxMcpEndpoint[];
  /** optional logger for MCP connect diagnostics (callers pass ctx.logger); silent when omitted */
  logger?: Logger;
  conversationId: string;
  /** the bot's persona + model */
  systemPrompt: string;
  modelId: string;
  temperature: number | null;
  /** full UI-message history (including the just-sent user message) */
  history: UIMessage[];
  /** true while a human holds the desktop — gates the GUI tools (see tools.ts) */
  isHumanInControl?: () => boolean;
  /**
   * Which toolset this run gets. `full` (default) = browser/desktop/screenshot/render_ui +
   * run_command (foreground turns, desktop-driving tasks). `concurrent-safe` = run_command only
   * (a non-GUI task that must run in parallel with others).
   */
  mode?: ToolMode;
  /** Acquire the exclusive GUI lease for this run (GUI-capable runs); may reject on human/timeout. */
  acquireGui?: (requester: string) => Promise<symbol>;
  /** Release the GUI lease token this run acquired. Paired with `acquireGui`. */
  releaseGui?: (token: symbol) => void;
  /** Spawn a concurrent detached task (wired only for the interactive foreground turn). */
  spawnTask?: (
    goal: string,
    needsDesktop: boolean,
  ) => Promise<{ taskId: string } | { error: string }>;
  /**
   * Called when the model invokes `request_handoff` (genuinely blocked, needs the human). Wiring it
   * adds the tool AND — via `hasToolCall` in `stopWhen` — makes the call end the turn. The caller
   * flips the bot to "awaiting human" + publishes `needs_human`. Wired for the foreground and the
   * proactive-relay voice; omitted for subagent/background runs (they bubble a block as prose).
   */
  onHandoff?: (payload: { reason: string; kind: HandoffKind }) => void;
  /** Scope `run_command` into this working directory (a task's own dir). */
  workdir?: string;
  /** aborts the model loop mid-run (background cancel); ignored in the foreground path */
  abortSignal?: AbortSignal;
  /**
   * Mid-run steering: called at each model↔tool step boundary to collect any user messages the
   * human sent WHILE this run was in flight (see SandboxManager.drainSteer). Returned texts are
   * appended to the current step's messages so the model sees the new instruction immediately,
   * without a second concurrent run. Returns `[]` on the common no-steer step.
   */
  drainSteer?: () => string[];
  /**
   * Called exactly once when the run truly settles (generation finished or errored),
   * regardless of whether a client is still attached. This is where the caller releases
   * the per-bot foreground/task registration / flips a job row. `error` carries the failure
   * when outcome is `error`. Never throws to the run.
   */
  onSettled?: (outcome: RunOutcome, error?: unknown) => void;
  /**
   * Subagent mode. When set, the run does NOT persist its assistant message into `messages` (a
   * subagent's internal steps stay OUT of the transcript). Instead this is called once with the
   * final assistant text, so the caller can relay it back into the conversation as a single
   * framed result. A `background` job or foreground/proactive turn leaves this unset and persists
   * normally.
   */
  onComplete?: (finalText: string) => void | Promise<void>;
}

/**
 * The shared core. Builds the stream, wires persistence + one-shot settle, and returns the
 * live `result` plus a `response()` factory. Callers choose: stream the response to a client
 * (foreground) or drain it to completion (background) — both drive the exact same run.
 */
async function buildAgentRun(args: RunAgentArgs) {
  const model = resolveModel(args.credential, args.modelId);
  // Load the bot's skills once at run start → a system-prompt section. Fixed for the turn (a skill
  // saved mid-turn is usable same-turn via run_command since its files render immediately, but the
  // preamble listing it appears next turn). Best-effort: a load failure never blocks the run.
  const skillPreamble = await loadBotSkills(args.db, args.botId)
    .then(composeSkillPreamble)
    .catch(() => "");
  const { tools, dispose } = buildSandboxTools(args.handle, {
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.isHumanInControl ? { isHumanInControl: args.isHumanInControl } : {}),
    ...(args.acquireGui ? { acquireGui: args.acquireGui } : {}),
    ...(args.releaseGui ? { releaseGui: args.releaseGui } : {}),
    ...(args.spawnTask ? { spawnTask: args.spawnTask } : {}),
    ...(args.onHandoff ? { onHandoff: args.onHandoff } : {}),
    ...(args.workdir ? { workdir: args.workdir } : {}),
    // tenant context: powers run_command's {{secrets.NAME}} injection and the save_skill tool
    tenant: { db: args.db, botId: args.botId },
  });
  // Connect the bot's enabled MCP servers and merge their tools into the toolset. Best-effort: a
  // server that won't connect is skipped, never failing the run. The toolset is FIXED for the turn
  // (a server bound mid-turn appears next turn), matching how skills' preamble is loaded once here.
  const mcp = await connectBotMcpTools(args.db, args.botId, args.boxMcpEndpoints ?? [], {
    ...(args.logger ? { logger: args.logger } : {}),
  }).catch(() => ({ tools: {}, connected: [], failed: [], close: async () => {} }));
  for (const [name, def] of Object.entries(mcp.tools)) tools[name] = def;
  // Slim the history for the model only (DB keeps the verbatim transcript) — old screenshots
  // are the dominant token cost and would otherwise overflow the context window. Pass `tools`
  // so each tool's `toModelOutput` runs here too: the kept (recent) screenshots in history
  // become real image blocks the vision model can see, not stringified base64.
  const modelMessages = await convertToModelMessages(pruneHistoryForModel(args.history), { tools });

  // Settle fires at most once — from success (streamText.onFinish) or failure (onError), and
  // also as a safety net when a background caller finishes draining (see runAgentToCompletion).
  let settled = false;
  const settle = (outcome: RunOutcome, error?: unknown) => {
    if (settled) return;
    settled = true;
    void dispose(); // close the CDP lease; box stays running
    void mcp.close(); // close every MCP client this run opened (box stays running)
    try {
      args.onSettled?.(outcome, error);
    } catch {
      /* a settle handler must never break the run */
    }
  };

  // A one-line note about the MCP servers whose tools are live this turn, so the model knows the
  // `mcp__<server>__*` tools exist and where they came from. Empty when none connected.
  const mcpNote = mcp.connected.length
    ? `\n\n## Connected MCP servers\nTools prefixed \`mcp__<server>__\` come from these servers you can use: ${mcp.connected
        .map((s) => `${s.name} (${s.tools} tool${s.tools === 1 ? "" : "s"})`)
        .join(", ")}.`
    : "";

  const result = streamText({
    model,
    system: composeSystemPrompt(args.systemPrompt, skillPreamble) + mcpNote,
    ...(args.temperature !== null ? { temperature: args.temperature } : {}),
    messages: modelMessages,
    tools,
    // Stop at the step cap, OR the moment the model calls request_handoff — the tool's execute
    // already fired onHandoff (the block signal); hasToolCall ends the turn right after that step
    // so we don't burn steps after a handoff. The tool call + its output are in the transcript, so
    // the resume turn (a fresh turn replaying history) sees a well-formed exchange.
    stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("request_handoff")],
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    // Mid-run steering: before each step, drain any messages the user sent while this run was in
    // flight and append them to the step's messages. A returned `messages` override carries
    // forward to later steps (AI SDK contract), so the injected instruction persists for the rest
    // of the turn. The common case (nothing queued) returns undefined → no per-step overhead.
    ...(args.drainSteer
      ? {
          prepareStep: ({ messages }) => {
            const merged = injectSteer(messages, args.drainSteer?.() ?? []);
            return merged ? { messages: merged } : undefined;
          },
        }
      : {}),
    onFinish: () => settle("done"),
    onError: (event) => {
      // Surface the real failure — without this the stream masks it as "An error occurred".
      console.error("[agent stream error]", event?.error ?? event);
      settle("error", event?.error ?? event);
    },
  });

  const response = () =>
    result.toUIMessageStreamResponse({
      onError: (error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[agent uiStream error]", msg);
        return msg;
      },
      onFinish: async ({ responseMessage }) => {
        const parts = (responseMessage.parts ?? []) as MessagePart[];
        // Subagent run: don't put its internal steps in the transcript. Hand the final text to
        // the caller, which relays it back into the conversation as one framed result.
        if (args.onComplete) {
          const finalText = parts
            .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
            .map((p) => p.text)
            .join("")
            .trim();
          await args.onComplete(finalText);
          return;
        }
        // Foreground / background / proactive: persist the assistant message verbatim.
        if (parts.length === 0) return;
        await args.db.insert(messagesTable).values({
          conversationId: args.conversationId,
          role: "assistant",
          parts,
        });
      },
    });

  return { result, response, settle };
}

/**
 * Foreground: stream a turn. Returns a Web `Response` carrying the AI SDK UI message stream,
 * ready to return straight from a Hono handler. Assistant output is persisted on finish.
 */
export async function runAgentStream(args: RunAgentArgs): Promise<Response> {
  return (await buildAgentRun(args)).response();
}

/**
 * Background: drive a turn to completion with no client attached. Drains the same UI message
 * stream server-side so persistence (`onFinish`) and settle both run, then resolves. Never
 * rejects — a model/tool failure settles as `error` and is reported via `onSettled`; the
 * returned promise resolves once the run is fully done (so a worker can finalize its row).
 */
export async function runAgentToCompletion(args: RunAgentArgs): Promise<void> {
  const { response, settle } = await buildAgentRun(args);
  const res = response();
  try {
    // Reading the body to completion forces the stream (and its onFinish persistence) to run.
    await res.body?.pipeTo(new WritableStream());
  } catch {
    /* an aborted/broken drain still settles below */
  } finally {
    // Safety net: if the drain ended without success/error firing (e.g. abort), settle now.
    // Idempotent — a real onFinish/onError already won the race.
    if (args.abortSignal?.aborted) settle("error", new Error("canceled"));
    else settle("done");
  }
}
