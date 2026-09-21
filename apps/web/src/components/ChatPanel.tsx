"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type FileUIPart,
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";
import {
  ArrowUp,
  Camera,
  Check,
  Film,
  Globe,
  GraduationCap,
  Loader2,
  Minus,
  Monitor,
  Plus,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { Skill, SkillDraft, UiEventData } from "@i-bot/types";
import { UI_EVENT_PART_TYPE, uiEventInstruction } from "@i-bot/types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { A2uiMessage, Message } from "@i-bot/types";
import { api, ApiError, type ConversationEvent, type RunStateView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { type A2uiAction, A2uiPanel, A2uiRuntimeProvider } from "@/components/A2uiPanel";

/** A detached task shown in the status strip, tracked from the SSE task lifecycle events. */
interface TaskCard {
  id: string;
  /** `subagent` = the bot spawned it; `background` = a human kicked it off */
  kind: "background" | "subagent";
  goal: string;
  /** true = drives the desktop (contends for the GUI lease); false = pure shell, runs in parallel */
  needsDesktop: boolean;
  status: "running" | "done" | "error" | "canceling";
  /** short summary (done) or error text — shown briefly before the card clears */
  detail?: string;
}

/**
 * The chat pane. Streams an agent turn from the API (AI SDK UI Message Stream) and
 * renders it as it arrives: assistant prose interleaved with "action steps" — the
 * browser/desktop tool calls the bot makes, shown live so you can read what it's doing
 * while the desktop pane shows it happening. Input is gated on an active sandbox
 * (the API 409s a chat without a live box).
 *
 * Alongside the chat, the bot may run detached tasks (subagents it spawns, or human-started
 * background jobs). Those surface as a compact status strip below the transcript, fed by a live
 * SSE stream (`GET .../events`); when a task finishes the bot speaks the result in a normal turn.
 */
export function ChatPanel({
  botId,
  conversationId,
  initialMessages,
  desktopActive,
}: {
  botId: string;
  conversationId: string;
  initialMessages: UIMessage[];
  desktopActive: boolean;
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: api.chatEndpoint(conversationId),
        credentials: "include",
        // The server owns history: it persists the user message then re-reads the thread.
        // So we send only the newest message's parts as `{ parts }`.
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages[messages.length - 1];
          return { body: { parts: last?.parts ?? [] } };
        },
      }),
    [conversationId],
  );

  const { messages, sendMessage, setMessages, status, error, stop } = useChat<UIMessage>({
    transport,
    messages: initialMessages,
  });

  const [input, setInput] = useState("");
  // Files staged for the next send (images/videos), as data-URL file parts. The user attaches
  // them with "+"; the agent decides what to do with them — no mode to pick.
  const [attachments, setAttachments] = useState<FileUIPart[]>([]);
  // Detached tasks (agent-spawned subagents + human background jobs) the bot is running alongside
  // the chat, driven by the SSE stream. A finished/errored card lingers briefly then removes
  // itself; the actual result arrives in the transcript via `message.ready`.
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  // The bot's live run-state (from the SSE `run.state` snapshot): foreground voice, task count,
  // and who holds the desktop lease. Drives the "busy" affordances and the queue/human hints.
  const [runState, setRunState] = useState<RunStateView>({
    foreground: false,
    taskCount: 0,
    gui: "free",
    queueDepth: 0,
    awaitingHuman: false,
  });
  // The bot's most recent handoff ask (from a `needs_human` event): what it needs the human to do.
  // Shown as a paused banner while `runState.awaitingHuman` holds; cleared when a turn resumes.
  const [needsHuman, setNeedsHuman] = useState<{ reason: string; kind: string } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  // "Record → experience": a distilled skill draft awaiting review, plus the in-flight/publish
  // state for its dialog. `null` draft = dialog closed. Analysis reads the persisted transcript,
  // so it works on any past conversation (no live desktop needed).
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  // Messages the user sent MID-RUN (steering) — echoed locally so they show immediately. The
  // server persists them too; on the next transcript sync they're replaced by the real rows.
  const [steerEchoes, setSteerEchoes] = useState<string[]>([]);
  // Bumped whenever the server says new persisted messages exist (`message.ready`); the sync
  // effect re-pulls the transcript once our own foreground stream is idle.
  const [syncTick, setSyncTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Per-task removal timers for finished/errored cards, so they clear after their brief display.
  const cardTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Whether the view is pinned to the bottom. Starts true (a fresh conversation opens at its
  // newest message) and only flips false when the user scrolls up to read earlier turns — so
  // streaming/new messages follow along by default but never yank a reader back down.
  const atBottomRef = useRef(true);
  const streaming = status === "submitted" || status === "streaming";
  // A foreground voice is live if we're streaming here OR the server reports one (a proactive
  // relay turn the bot started on its own to speak a task result). Either way a send should STEER
  // that live turn rather than open a second one; `steer` falls back to a normal send on a 409 if
  // the run just ended. Background tasks alone do NOT make the bot "busy" for the composer — a
  // send then starts a fresh foreground turn.
  const foregroundLive = streaming || runState.foreground;

  const scrollDown = () =>
    queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));

  // Track whether we're near the bottom; a small slop absorbs sub-pixel rounding and the last
  // line's leading. Drives whether new content auto-follows.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  // On mount / conversation switch, open at the newest message (no animation — it's the initial
  // position, not a scroll). Runs before paint so there's no visible jump from the top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
  }, []);

  // Follow new content (streamed tokens, new turns, steer echoes, and the task strip growing or
  // a card changing height) only while pinned to the bottom. If the user scrolled up to read,
  // their position is left alone. `tasks` is in the deps because a card appearing/settling changes
  // the scroll height without touching `messages`.
  useLayoutEffect(() => {
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, steerEchoes, tasks]);

  // Re-pin to the bottom on ANY async height growth of the transcript — the effect above fires when
  // messages/tasks change, but a screenshot (or attached image/video) reports height only once its
  // bytes decode, AFTER that pass ran with scrollHeight still short. That late growth used to leave
  // the newest content below the fold. A ResizeObserver catches every such reflow and re-pins while
  // the user is at the bottom; if they've scrolled up to read, their position is left alone.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Pull the persisted transcript into the live view (used after a background turn finishes —
  // its assistant message is written server-side, not streamed here).
  const syncFromServer = useCallback(async () => {
    const rows = await api.listMessages(conversationId).catch(() => null);
    if (!rows) return;
    setMessages(rows.map((r) => ({ id: r.id, role: r.role, parts: r.parts }) as UIMessage));
    setSteerEchoes([]); // the real rows now include what we echoed locally
  }, [conversationId, setMessages]);

  // Schedule a finished/errored task card to clear after a brief display, so the strip doesn't
  // accumulate stale rows. The full result lands in the transcript separately (message.ready).
  const scheduleCardRemoval = useCallback((taskId: string) => {
    const timers = cardTimers.current;
    const existing = timers.get(taskId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(taskId);
      setTasks((prev) => prev.filter((c) => c.id !== taskId));
    }, 6000);
    timers.set(taskId, t);
  }, []);

  // Live conversation events over SSE — replaces the old 2.5s job poll. Task lifecycle drives the
  // status strip; `run.state` drives the busy/queue affordances; `message.ready` triggers a
  // transcript re-sync (deferred until our own stream is idle by the effect below). EventSource
  // auto-reconnects; on error we fall back once to a state fetch so a settle during a dropped
  // connection isn't missed. Resets task/run state on conversation switch.
  useEffect(() => {
    setTasks([]);
    setRunState({
      foreground: false,
      taskCount: 0,
      gui: "free",
      queueDepth: 0,
      awaitingHuman: false,
    });
    setNeedsHuman(null);
    const timers = cardTimers.current;

    const es = new EventSource(api.eventsEndpoint(conversationId), { withCredentials: true });
    let recovered = false; // guard: fall back to a state fetch at most once per error streak

    es.onopen = () => {
      recovered = false;
    };

    es.onmessage = (e) => {
      recovered = false;
      let ev: ConversationEvent;
      try {
        ev = JSON.parse(e.data) as ConversationEvent;
      } catch {
        return; // ignore malformed frames (heartbeat pings use a named event, not onmessage)
      }
      if (ev.type === "task.started") {
        setTasks((prev) =>
          prev.some((c) => c.id === ev.taskId)
            ? prev
            : [
                ...prev,
                {
                  id: ev.taskId,
                  kind: ev.kind,
                  goal: ev.goal,
                  needsDesktop: ev.needsDesktop,
                  status: "running",
                },
              ],
        );
      } else if (ev.type === "task.done") {
        setTasks((prev) =>
          prev.map((c) => (c.id === ev.taskId ? { ...c, status: "done", detail: ev.summary } : c)),
        );
        scheduleCardRemoval(ev.taskId);
      } else if (ev.type === "task.error") {
        setTasks((prev) =>
          prev.map((c) => (c.id === ev.taskId ? { ...c, status: "error", detail: ev.error } : c)),
        );
        scheduleCardRemoval(ev.taskId);
      } else if (ev.type === "run.state") {
        setRunState({
          foreground: ev.foreground,
          taskCount: ev.taskCount,
          gui: ev.gui,
          queueDepth: ev.queueDepth,
          awaitingHuman: ev.awaitingHuman,
        });
        // A resumed / no-longer-waiting turn clears the paused banner. Re-set by needs_human below.
        if (!ev.awaitingHuman) setNeedsHuman(null);
      } else if (ev.type === "needs_human") {
        // The bot paused on a handoff — remember what it asked for so the banner can show it. The
        // run.state event carrying awaitingHuman:true rides alongside (both published together).
        setNeedsHuman({ reason: ev.reason, kind: ev.kind });
      } else if (ev.type === "message.ready") {
        // New persisted messages exist (a proactive relay turn finished). Nudge the sync effect;
        // it re-pulls the transcript once our own foreground stream is idle (never mid-stream).
        setSyncTick((n) => n + 1);
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect. Recover state once so a settle that happened during the
      // gap is reflected even before the reconnect's run.state snapshot arrives.
      if (recovered) return;
      recovered = true;
      void (async () => {
        const active = await api.getActiveJob(conversationId).catch(() => null);
        if (!active) return;
        setRunState(active.state);
        if (active.job?.status === "error") setJobError(active.job.error ?? "任务执行失败");
        setSyncTick((n) => n + 1);
      })();
    };

    return () => {
      es.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [conversationId, scheduleCardRemoval]);

  // Transcript reconcile, deferred to when our own foreground stream is idle: pull the persisted
  // rows so proactive-turn output (message.ready) and mid-run steer echoes are reflected in order,
  // matching what a reload would show. Guarded on `!streaming` so setMessages never clobbers an
  // in-flight stream. Fires on a settled stream that had steer echoes, or a message.ready tick.
  useEffect(() => {
    if (streaming) return;
    if (steerEchoes.length === 0 && syncTick === 0) return;
    // Small delay so the assistant message's onFinish persistence has committed server-side.
    const id = setTimeout(() => void syncFromServer(), 600);
    return () => clearTimeout(id);
  }, [streaming, steerEchoes.length, syncTick, syncFromServer]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const files = attachments;
    if ((!text && files.length === 0) || !desktopActive) return;
    setJobError(null);

    // A foreground voice is already live → STEER it (inject into the running loop) instead of
    // starting a second turn. Steering carries text only; anything attached stays staged for the
    // next fresh turn. Falls back to a normal send if the server says the run just ended (409).
    // Background tasks alone don't gate this — a send then just starts a fresh foreground turn.
    if (foregroundLive) {
      if (!text) return; // nothing to steer with (attachments can't steer) — keep them staged
      setInput("");
      void steer(text);
      scrollDown();
      return;
    }

    // One send path: stream the turn. The agent works out what the instruction needs — the user
    // never chooses "realtime vs background".
    setInput("");
    setAttachments([]);
    void sendMessage(files.length > 0 ? (text ? { text, files } : { files }) : { text });
    scrollDown();
  }

  // "Record → experience": distill this conversation's action trace into a skill draft, then open
  // the review dialog. Reads the persisted transcript server-side, so it works on any finished
  // conversation. The draft is NEVER auto-saved — the user reviews/edits, then publishes.
  const analyzeSkill = useCallback(async () => {
    setSkillError(null);
    setAnalyzing(true);
    try {
      const draft = await api.analyzeSkill(conversationId);
      setSkillDraft(draft);
    } catch (err) {
      setSkillError(errorText(err, { fallback: "分析失败,请重试。" }));
    } finally {
      setAnalyzing(false);
    }
  }, [conversationId]);

  /**
   * A user interacted with a bot-rendered A2UI panel (clicked a button, submitted a form). Feed
   * the action back to the agent as a normal user message so it drives the next step — steering
   * the live run if one's in flight, else a fresh turn. Same routing as `submit`.
   *
   * The message carries TWO parts (see `UiEventData` in @i-bot/types): a clean natural-language
   * `text` part — the ONLY thing the model sees (`convertToModelMessages` drops user data parts) —
   * and a `data-uiEvent` part the chat renders as a compact chip instead of leaking the raw action
   * name + JSON into the transcript. Steer only forwards text to the running loop but persists the
   * whole parts array, so the chip survives on reload either way.
   */
  function sendUiAction(action: A2uiAction) {
    if (!desktopActive) return;
    const event: UiEventData = {
      surfaceId: action.surfaceId,
      name: action.name,
      context: action.context ?? {},
    };
    const text = uiEventInstruction(event);
    const parts = [
      { type: "text" as const, text },
      { type: UI_EVENT_PART_TYPE, data: event },
    ];
    setJobError(null);
    // Foreground live → steer with the full parts (server extracts text for the model, persists
    // parts for the chip). Otherwise a fresh turn carrying both parts.
    if (foregroundLive) void steer(text, parts as Message["parts"]);
    else void sendMessage({ parts } as Parameters<typeof sendMessage>[0]);
    scrollDown();
  }

  /** Read picked files into data-URL file parts and stage them. Images + videos only. */
  async function onPickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = await Promise.all(
      Array.from(list)
        .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
        .map(
          (f) =>
            new Promise<FileUIPart>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  type: "file",
                  mediaType: f.type,
                  filename: f.name,
                  url: reader.result as string,
                });
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(f);
            }),
        ),
    );
    if (picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
  }

  /** Inject a message into the in-flight run. On 409 (run just ended) fall back to a normal send. */
  // `parts` overrides what's persisted (e.g. a UI action's text + data-uiEvent chip part); the
  // local echo and the fresh-turn fallback stay text-only, since the running loop only ingests
  // the text anyway. When omitted, a plain text part is persisted (normal mid-run message).
  async function steer(text: string, parts?: Message["parts"]) {
    setSteerEchoes((prev) => [...prev, text]);
    try {
      await api.steer(conversationId, parts ?? ([{ type: "text", text }] as Message["parts"]));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The run ended between our check and the request — send it as a fresh turn instead.
        setSteerEchoes((prev) => prev.filter((t) => t !== text));
        void sendMessage(parts ? ({ parts } as Parameters<typeof sendMessage>[0]) : { text });
        return;
      }
      setSteerEchoes((prev) => prev.filter((t) => t !== text));
      setJobError(errorText(err, { fallback: "任务执行失败" }));
    }
  }

  /** Cancel a running task from its card. The row flips to `canceled`; a `task.error` SSE event
   * (error "canceled") clears the card. Optimistically mark it so the spinner stops immediately. */
  const cancelTask = useCallback(
    (taskId: string) => {
      setTasks((prev) => prev.map((c) => (c.id === taskId ? { ...c, status: "canceling" } : c)));
      void api.cancelJob(conversationId, taskId).catch(() => {});
    },
    [conversationId],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="no-scrollbar"
        style={{ flex: 1, overflowY: "auto", padding: "16px 14px", minHeight: 0 }}
      >
        {messages.length === 0 ? (
          <div
            className="muted"
            style={{ fontSize: 13, textAlign: "center", padding: "40px 12px" }}
          >
            {desktopActive
              ? "Ask the bot to do something on its desktop — open a site, search, fill a form."
              : "Start the desktop, then give the bot a task."}
          </div>
        ) : (
          // One shared A2UI runtime for the whole thread: a render_ui that reuses a surfaceId
          // updates its card in place instead of drawing a new one (see A2uiRuntimeProvider).
          <A2uiRuntimeProvider onAction={sendUiAction}>
            <div ref={contentRef} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {messages.map((m, idx) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  // A tool call only legitimately spins while THIS turn is live: the last message,
                  // still streaming. Any earlier/settled message with a non-terminal tool part is a
                  // call whose result never made it back (stream dropped mid-run) — render it as
                  // interrupted, not an eternal spinner.
                  live={streaming && idx === messages.length - 1 && m.role === "assistant"}
                />
              ))}
              {/* messages sent mid-run (steering), echoed until the transcript sync replaces them */}
              {steerEchoes.map((text, i) => (
                <MessageRow
                  key={`steer-${i}`}
                  message={
                    { id: `steer-${i}`, role: "user", parts: [{ type: "text", text }] } as UIMessage
                  }
                />
              ))}
            </div>
          </A2uiRuntimeProvider>
        )}
        {error && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 12 }}>
            {error.message.includes("409")
              ? "The desktop isn't ready yet."
              : `Error: ${error.message}`}
          </div>
        )}
        {jobError && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 12 }}>
            后台任务出错:{jobError}
          </div>
        )}
        {/* the task strip: detached runs the bot is doing alongside the chat, rendered inside the
            scroll container so it follows the transcript and auto-scroll keeps it in view */}
        <TaskStrip tasks={tasks} runState={runState} onCancel={cancelTask} />
        {/* paused-for-you banner: shown while the bot is blocked on a handoff (request_handoff).
            Distinct from the busy spinner — it tells the user the turn stopped and what to do; the
            next message resumes it. Cleared when runState.awaitingHuman drops (a turn resumed). */}
        {runState.awaitingHuman && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--warn)",
              background: "var(--warn-soft)",
              color: "var(--ink)",
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <strong>⏸ 等待你的操作</strong>
            {needsHuman?.reason ? <div style={{ marginTop: 4 }}>{needsHuman.reason}</div> : null}
            <div style={{ marginTop: 4, opacity: 0.7 }}>
              完成后直接发消息,bot 会带着上下文接着做。
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: "none", padding: 12 }}>
        <form
          onSubmit={submit}
          className="composer"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 8,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-strong)",
            background: "var(--surface)",
            transition: "border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease)",
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline (assistant-ui / shadcn convention).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(e);
              }
            }}
            rows={1}
            placeholder={
              !desktopActive
                ? "Start the desktop first…"
                : foregroundLive
                  ? "Add something mid-task — it steers the bot…"
                  : "Message the bot…"
            }
            disabled={!desktopActive}
            style={{
              width: "100%",
              resize: "none",
              border: 0,
              outline: "none",
              background: "transparent",
              color: "var(--ink)",
              font: "inherit",
              fontSize: 13.5,
              lineHeight: 1.55,
              padding: "4px 6px",
              maxHeight: 160,
              overflowY: "auto",
            }}
          />
          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 2px" }}>
              {attachments.map((a, i) => (
                <AttachmentChip
                  key={`${a.filename ?? "file"}-${i}`}
                  part={a}
                  onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                void onPickFiles(e.target.files);
                e.target.value = ""; // let the same file be picked again later
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={!desktopActive}
                title="添加图片或视频"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 30,
                  height: 30,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: desktopActive ? "var(--ink-secondary)" : "var(--ink-muted)",
                  cursor: desktopActive ? "pointer" : "not-allowed",
                }}
              >
                <Plus size={16} strokeWidth={2} />
              </button>
              {/* "Record → experience": distill this conversation into a reusable skill. Enabled
                  whenever there's a transcript (analysis reads history — no live desktop needed). */}
              <button
                type="button"
                onClick={() => void analyzeSkill()}
                disabled={analyzing || messages.length === 0}
                title="把这次对话提炼成一个可复用的经验(skill)"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 30,
                  padding: "0 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: messages.length === 0 ? "var(--ink-muted)" : "var(--ink-secondary)",
                  fontSize: 12.5,
                  cursor: analyzing || messages.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                {analyzing ? (
                  <Loader2 size={13} strokeWidth={2.2} className="spin" />
                ) : (
                  <GraduationCap size={14} strokeWidth={2} />
                )}
                {analyzing ? "分析中…" : "生成经验"}
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* Stop only halts OUR live stream. A proactive relay turn (server-driven) can't be
                  stopped from here; detached tasks are stopped from their own cards instead. */}
              {streaming && (
                <button
                  type="button"
                  onClick={() => stop()}
                  title="停止"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    height: 30,
                    padding: "0 11px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--ink-secondary)",
                    fontSize: 12.5,
                    cursor: "pointer",
                  }}
                >
                  <Square size={12} strokeWidth={2.2} fill="currentColor" />
                  停止
                </button>
              )}
              <SendButton
                disabled={!desktopActive || (!input.trim() && attachments.length === 0)}
                mode={foregroundLive ? "steer" : "send"}
              />
            </div>
          </div>
        </form>
        {skillError && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 8, paddingLeft: 4 }}>
            {skillError}
          </div>
        )}
      </div>

      {skillDraft && (
        <SkillReviewDialog
          botId={botId}
          draft={skillDraft}
          onClose={() => setSkillDraft(null)}
          onSaved={() => setSkillDraft(null)}
        />
      )}
    </div>
  );
}

/**
 * Review-before-publish for a distilled skill. `analyzeSkill` produces a DRAFT from the conversation's
 * action trace; this dialog is the human gate — the reviewer edits the name/when-to-use/playbook and
 * confirms the `{{secrets.NAME}}` list before it's written as a bot-scoped skill. Nothing is saved
 * until "保存经验" succeeds. Secret NAMES only ever appear here (never values) — the playbook already
 * had literals rewritten to `{{secrets.NAME}}` upstream.
 */
function SkillReviewDialog({
  botId,
  draft,
  onClose,
  onSaved,
}: {
  botId: string;
  draft: SkillDraft;
  onClose: () => void;
  onSaved: (skill: Skill) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [playbook, setPlaybook] = useState(draft.playbook);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Secret NAMES the playbook references. Kept in sync with the edited text so a reviewer who removes
  // a {{secrets.X}} line doesn't leave a dangling declared secret (and vice-versa).
  const secretRefs = useMemo(() => {
    const found = new Set<string>();
    for (const m of playbook.matchAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g)) {
      if (m[1]) found.add(m[1]);
    }
    return [...found];
  }, [playbook]);

  const save = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const skill = await api.saveSkill(botId, {
        ...draft,
        name: name.trim(),
        description: description.trim(),
        playbook: playbook.trim(),
        secretRefs,
      });
      onSaved(skill);
    } catch (err) {
      setError(errorText(err, { fallback: "保存失败,请重试。" }));
    } finally {
      setSaving(false);
    }
  }, [botId, draft, name, description, playbook, secretRefs, onSaved]);

  const canSave =
    name.trim().length > 0 && description.trim().length > 0 && playbook.trim().length > 0;
  const fieldStyle = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--ink)",
    fontSize: 13,
    fontFamily: "inherit",
    resize: "vertical" as const,
  };
  const labelStyle = { fontSize: 12, color: "var(--ink-secondary)", fontWeight: 500 };

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "88vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 20,
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
          background: "var(--bg)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GraduationCap size={18} strokeWidth={2} color="var(--ink-secondary)" />
          <div style={{ fontSize: 15, fontWeight: 600 }}>提炼为经验</div>
        </div>
        <div
          style={{ fontSize: 12.5, color: "var(--ink-secondary)", lineHeight: 1.5, marginTop: -6 }}
        >
          这是根据这次对话自动生成的草稿,确认或修改后保存。之后这个 bot 遇到类似任务会参考它。
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>何时使用</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            style={fieldStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>操作步骤(playbook)</span>
          <textarea
            value={playbook}
            onChange={(e) => setPlaybook(e.target.value)}
            rows={10}
            style={{
              ...fieldStyle,
              fontFamily: "var(--font-mono, ui-monospace), monospace",
              lineHeight: 1.55,
            }}
          />
        </label>

        {secretRefs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelStyle}>引用的密钥(仅名称,值由 bot 的密钥库提供)</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {secretRefs.map((s) => (
                <code
                  key={s}
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--ink-secondary)",
                  }}
                >
                  {`{{secrets.${s}}}`}
                </code>
              ))}
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              height: 34,
              padding: "0 14px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--ink-secondary)",
              fontSize: 13,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !canSave}
            className="btn btn-primary"
            style={{
              height: 34,
              padding: "0 16px",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              cursor: saving || !canSave ? "not-allowed" : "pointer",
              opacity: canSave ? 1 : 0.6,
            }}
          >
            {saving && <Loader2 size={13} strokeWidth={2.2} className="spin" />}
            {saving ? "保存中…" : "保存经验"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The compact task status strip: one chip per detached run the bot is doing alongside the chat,
 * plus a hint when runs are queued for the desktop or a human holds it. Kept minimal on purpose —
 * the mid-task steps stay off the transcript; the bot speaks the result when a task finishes.
 */
function TaskStrip({
  tasks,
  runState,
  onCancel,
}: {
  tasks: TaskCard[];
  runState: RunStateView;
  onCancel: (taskId: string) => void;
}) {
  // Tasks running on the bot but with no card yet (e.g. right after a reconnect, before their
  // task.started replays) — show a generic count so the strip isn't silently empty.
  const untracked = tasks.length === 0 ? runState.taskCount : 0;
  const humanHolds = runState.gui === "human";
  const queued = runState.queueDepth;

  if (tasks.length === 0 && untracked === 0 && !humanHolds && queued === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: 14,
        paddingTop: 12,
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          className="muted"
          style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}
        >
          后台任务
        </span>
      </div>
      {tasks.map((t) => (
        <TaskChip key={t.id} task={t} onCancel={onCancel} />
      ))}
      {untracked > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          {untracked} 个后台任务进行中…
        </div>
      )}
      {humanHolds && (
        <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
          你正在控制桌面 — bot 的桌面/浏览器操作已暂停
        </div>
      )}
      {queued > 0 && !humanHolds && (
        <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>{queued} 个任务在等待桌面…</div>
      )}
    </div>
  );
}

/** One task's chip: icon (desktop vs shell), goal, live state, and a cancel affordance while running. */
function TaskChip({ task, onCancel }: { task: TaskCard; onCancel: (taskId: string) => void }) {
  const Icon = task.needsDesktop ? Monitor : Terminal;
  const running = task.status === "running" || task.status === "canceling";
  const color =
    task.status === "error"
      ? "var(--danger)"
      : task.status === "done"
        ? "var(--ink-secondary)"
        : "var(--ink-muted)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 8px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        fontSize: 12,
        minWidth: 0,
      }}
    >
      <Icon size={13} strokeWidth={1.8} color={color} style={{ flex: "none" }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--ink-secondary)",
        }}
        title={task.detail ? `${task.goal}\n${task.detail}` : task.goal}
      >
        {task.goal || "(task)"}
      </span>
      <TaskStateIcon status={task.status} />
      {running && (
        <button
          type="button"
          onClick={() => onCancel(task.id)}
          disabled={task.status === "canceling"}
          title="停止这个任务"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            flex: "none",
            borderRadius: "var(--radius-sm)",
            border: 0,
            background: "transparent",
            color: "var(--ink-muted)",
            cursor: task.status === "canceling" ? "default" : "pointer",
            padding: 0,
          }}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}

/** The trailing state marker on a task chip: spinner while running, check when done, x on error. */
function TaskStateIcon({ status }: { status: TaskCard["status"] }) {
  if (status === "error")
    return <X size={13} strokeWidth={2} color="var(--danger)" style={{ flex: "none" }} />;
  if (status === "done")
    return <Check size={13} strokeWidth={2} color="var(--ink-muted)" style={{ flex: "none" }} />;
  return (
    <Loader2
      size={13}
      strokeWidth={2}
      color="var(--ink-muted)"
      style={{ flex: "none", animation: "spin 0.8s linear infinite" }}
    />
  );
}

/** Auto-grow a textarea to fit its content, capped by its maxHeight. */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

/** A staged attachment shown above the composer footer: image thumbnail or a video filename chip. */
function AttachmentChip({ part, onRemove }: { part: FileUIPart; onRemove: () => void }) {
  const isImage = part.mediaType.startsWith("image/");
  return (
    <div
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: isImage ? 44 : 28,
        padding: isImage ? 0 : "0 8px 0 7px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        overflow: "hidden",
      }}
    >
      {isImage ? (
        // biome-ignore lint: staged data URL, not a remote asset
        <img
          src={part.url}
          alt={part.filename ?? "image"}
          style={{ height: 44, width: 44, objectFit: "cover", display: "block" }}
        />
      ) : (
        <>
          <Film size={13} strokeWidth={1.8} color="var(--ink-muted)" />
          <span
            style={{
              fontSize: 11.5,
              color: "var(--ink-secondary)",
              maxWidth: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {part.filename ?? "video"}
          </span>
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="移除"
        style={{
          position: isImage ? "absolute" : "static",
          top: isImage ? 2 : undefined,
          right: isImage ? 2 : undefined,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          borderRadius: 999,
          border: 0,
          background: isImage ? "rgba(0,0,0,0.55)" : "transparent",
          color: isImage ? "var(--accent-fg)" : "var(--ink-muted)",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <X size={11} strokeWidth={2.4} />
      </button>
    </div>
  );
}

/** The round send button — accent arrow when ready; hairline outline (no grey fill) when idle. */
function SendButton({ disabled, mode }: { disabled: boolean; mode: "send" | "steer" }) {
  const title = mode === "steer" ? "发送以引导正在执行的任务" : "发送";
  return (
    <button
      type="submit"
      disabled={disabled}
      title={title}
      className="send-btn"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        borderRadius: "var(--radius-sm)",
        border: disabled ? "1px solid var(--border)" : "1px solid var(--accent)",
        background: disabled ? "transparent" : "var(--accent)",
        color: disabled ? "var(--ink-muted)" : "var(--accent-fg)",
        cursor: disabled ? "not-allowed" : "pointer",
        overflow: "hidden", // clip the belt to a single-arrow window
        transition: "background var(--dur) var(--ease), border-color var(--dur) var(--ease)",
      }}
    >
      {/* Two identical arrows stacked; on hover the pair rides up one slot (CSS `.send-belt`),
          carrying the current arrow off the top while the next rides in from below. `alignSelf`
          top-anchors the belt so the FIRST arrow fills the window at rest (centered), instead of
          the belt centering as a whole and showing the seam between the two arrows. */}
      <span className="send-belt" aria-hidden style={{ alignSelf: "flex-start" }}>
        <span style={{ height: 30, display: "grid", placeItems: "center" }}>
          <ArrowUp size={16} strokeWidth={2.4} />
        </span>
        <span style={{ height: 30, display: "grid", placeItems: "center" }}>
          <ArrowUp size={16} strokeWidth={2.4} />
        </span>
      </span>
    </button>
  );
}

function MessageRow({
  message,
  live = false,
}: {
  message: UIMessage;
  /** true only for the assistant turn that's actively streaming — gates the tool-call spinner. */
  live?: boolean;
}) {
  const isUser = message.role === "user";
  // A panel interaction rides as a clean text part (for the model) + a data-uiEvent part (the chip
  // for us). When the chip part is present we render IT and drop the sibling text, so the transcript
  // shows a tidy "panel action" chip instead of the raw instruction line. Old messages (plain text,
  // no data-uiEvent part) just render as text — backward compatible.
  const hasUiEvent = isUser && message.parts.some((p) => p.type === UI_EVENT_PART_TYPE);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        // Breathing room between a message's own parts (prose ↔ image ↔ tool step ↔ A2UI panel),
        // which otherwise stack flush. Matches the inter-message rhythm in the list container.
        gap: 8,
      }}
    >
      {message.parts.map((part, i) => {
        if (part.type === UI_EVENT_PART_TYPE) {
          const data = (part as { data?: unknown }).data as UiEventData | undefined;
          return data ? <UiEventChip key={i} event={data} /> : null;
        }
        if (part.type === "text") {
          if (!part.text) return null;
          // The clean instruction paired with a chip part → hidden; the chip stands in for it.
          if (hasUiEvent) return null;
          // User messages render verbatim (their own text, not markup); assistant prose is
          // rendered as markdown so headings/lists/code/links/tables come through.
          if (isUser) {
            return (
              <div
                key={i}
                style={{
                  maxWidth: "88%",
                  // White bubble with a hairline border (no grey fill).
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  padding: "8px 12px",
                  color: "var(--ink)",
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {part.text}
              </div>
            );
          }
          // Cap the reading measure so assistant prose stays legible instead of stretching to a
          // long line as the chat column widens. Left-aligned, so it just stops growing past ~68ch.
          return (
            <div key={i} className="prose" style={{ maxWidth: "68ch", width: "100%" }}>
              <Markdown
                remarkPlugins={[remarkGfm]}
                // Syntax-highlight fenced code (lowlight/highlight.js). `detect` so a fence with no
                // language still gets tokenized; `ignoreMissing` so an unknown language degrades to
                // plain text instead of throwing. Tokens are styled by `.hljs-*` rules in globals.css.
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                components={{
                  // Open any link the model emits in a new tab, safely.
                  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
                  // Wrap tables so a wide one scrolls inside the bubble instead of stretching the
                  // whole chat column.
                  table: (props) => (
                    <div className="prose-table-wrap">
                      <table {...props} />
                    </div>
                  ),
                }}
              >
                {part.text}
              </Markdown>
            </div>
          );
        }
        if (part.type === "file") {
          return <MessageFile key={i} part={part} />;
        }
        if (isToolUIPart(part)) {
          const toolName = getToolName(part);
          // A rendered A2UI panel: show the interactive surface, not a tool "action" line.
          if (toolName === "render_ui") {
            const out = (part as { output?: { a2ui?: unknown } }).output;
            const msgs = Array.isArray(out?.a2ui) ? (out.a2ui as A2uiMessage[]) : null;
            // No output yet (tool call still streaming) → render nothing until the panel arrives.
            // `toolCallId` is the stable per-part key the shared runtime dedups feeding on.
            const toolCallId = (part as { toolCallId?: string }).toolCallId;
            return msgs ? <A2uiPanel key={i} messages={msgs} partId={toolCallId} /> : null;
          }
          return <ActionStep key={i} name={toolName} part={part} live={live} />;
        }
        return null;
      })}
    </div>
  );
}

/**
 * A user's A2UI panel interaction, rendered as a compact chip (not the raw instruction text). Shows
 * the action label and any context fields the human submitted, so the transcript reads as "you did
 * X on the panel" rather than leaking the protocol frame. The model, separately, gets the clean
 * text part (see `sendUiAction` / `uiEventInstruction`).
 */
function UiEventChip({ event }: { event: UiEventData }) {
  const label = event.label?.trim() || event.name;
  const entries = Object.entries(event.context ?? {});
  return (
    <div
      style={{
        maxWidth: "88%",
        display: "inline-flex",
        flexDirection: "column",
        gap: 4,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-subtle)",
        padding: "6px 10px",
        fontSize: 12.5,
        color: "var(--ink-secondary)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Check size={13} style={{ color: "var(--accent)", flex: "none" }} />
        <span style={{ color: "var(--ink)", fontWeight: 500 }}>{label}</span>
      </span>
      {entries.length > 0 && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, wordBreak: "break-word" }}>
          {entries
            .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("  ·  ")}
        </span>
      )}
    </div>
  );
}

/** A file part on a user message — an image or a video the user attached. */
function MessageFile({ part }: { part: { mediaType: string; url: string; filename?: string } }) {
  const box: React.CSSProperties = {
    maxWidth: 260,
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    overflow: "hidden",
    background: "var(--surface)",
    lineHeight: 0,
  };
  if (part.mediaType.startsWith("video/")) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: user-supplied clip, no caption track available
      <video src={part.url} controls style={{ ...box, display: "block", width: "100%" }} />
    );
  }
  return (
    <div style={box}>
      {/* biome-ignore lint: data/remote URL supplied by the user — next/image adds no value */}
      <img
        src={part.url}
        alt={part.filename ?? "attachment"}
        style={{ display: "block", width: "100%", height: "auto" }}
      />
    </div>
  );
}

/** A compact "action step" line: what tool the bot called, its state, and any screenshot it returned. */
function ActionStep({
  name,
  part,
  live = false,
}: {
  name: string;
  part: Record<string, unknown>;
  live?: boolean;
}) {
  const state = part.state as string | undefined;
  const input = part.input as Record<string, unknown> | undefined;
  const output = part.output as { ok?: boolean; error?: string; screenshot?: string } | undefined;

  const label = actionLabel(name, input);
  const done = state === "output-available";
  const failed = state === "output-error" || (output && output.ok === false);
  // A non-terminal call in a turn that's no longer streaming never got its result back (the stream
  // dropped mid-run) — mark it interrupted instead of leaving an eternal spinner.
  const interrupted = !done && !failed && !live;
  // The screenshot may have been dropped from history to save context (pruneHistoryForModel
  // replaces old base64 with a placeholder), so only render a real base64 payload.
  const shot =
    typeof output?.screenshot === "string" && output.screenshot.length > 64
      ? output.screenshot
      : null;

  const ToolIcon = name === "browser_action" ? Globe : name === "screenshot" ? Camera : Monitor;
  const iconColor = failed ? "var(--danger)" : "var(--ink-muted)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "3px 0",
          margin: "1px 0",
          fontSize: 12.5,
        }}
      >
        <ToolIcon size={13} strokeWidth={1.8} color={iconColor} style={{ flex: "none" }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--ink-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <StateIcon done={!!done} failed={!!failed} interrupted={interrupted} />
        {interrupted && (
          <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
            — 已中断
          </span>
        )}
        {failed && output?.error && (
          <span
            className="muted"
            style={{
              fontSize: 11.5,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            — {output.error.slice(0, 60)}
          </span>
        )}
      </div>
      {shot && <Screenshot base64={shot} />}
    </div>
  );
}

/** A screenshot returned by a tool, shown inline as a thumbnail; click to open full-size. */
function Screenshot({ base64 }: { base64: string }) {
  const [open, setOpen] = useState(false);
  const src = `data:image/png;base64,${base64}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="点击查看大图"
        style={{
          display: "block",
          padding: 0,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          background: "var(--bg-subtle)",
          cursor: "zoom-in",
          maxWidth: 260,
          lineHeight: 0,
        }}
      >
        {/* biome-ignore lint: base64 data URL, not a remote asset — next/image adds no value */}
        <img
          src={src}
          alt="screenshot"
          style={{ display: "block", width: "100%", height: "auto" }}
        />
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "grid",
            placeItems: "center",
            padding: 32,
            background: "rgba(0,0,0,0.72)",
            cursor: "zoom-out",
          }}
        >
          {/* biome-ignore lint: base64 data URL */}
          <img
            src={src}
            alt="screenshot"
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-lg)",
            }}
          />
        </div>
      )}
    </>
  );
}

/** The trailing state marker on an action line: check when done, x on failure, a muted dash when
 * interrupted (stream dropped before the result came back), else spinning while genuinely live. */
function StateIcon({
  done,
  failed,
  interrupted,
}: {
  done: boolean;
  failed: boolean;
  interrupted?: boolean;
}) {
  if (failed) return <X size={13} strokeWidth={2} color="var(--danger)" style={{ flex: "none" }} />;
  if (done)
    return <Check size={13} strokeWidth={2} color="var(--ink-muted)" style={{ flex: "none" }} />;
  if (interrupted)
    return <Minus size={13} strokeWidth={2} color="var(--ink-muted)" style={{ flex: "none" }} />;
  return (
    <Loader2
      size={13}
      strokeWidth={2}
      color="var(--ink-muted)"
      style={{ flex: "none", animation: "spin 0.8s linear infinite" }}
    />
  );
}

/** Human-readable one-liner for an action step from its tool + input. */
function actionLabel(name: string, input: Record<string, unknown> | undefined): string {
  const type = (input?.type as string) ?? "";
  if (name === "browser_action") {
    if (type === "navigate") return `browser · navigate ${String(input?.url ?? "")}`;
    if (type === "click") return `browser · click ${String(input?.selector ?? "")}`;
    if (type === "fill") return `browser · fill ${String(input?.selector ?? "")}`;
    if (type === "read_dom") return "browser · read page";
    if (type === "screenshot") return "browser · screenshot";
    if (type === "wait_for") return `browser · wait for ${String(input?.selector ?? "")}`;
    return `browser · ${type}`;
  }
  if (name === "desktop_action") return `desktop · ${type || "action"}`;
  if (name === "screenshot") return "desktop · screenshot";
  return name;
}
