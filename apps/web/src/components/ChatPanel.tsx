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
  BookOpen,
  Camera,
  Check,
  Film,
  Globe,
  GraduationCap,
  Loader2,
  Minus,
  Monitor,
  Paperclip,
  Plug,
  Plus,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { SkillListItem, SkillDraft, UiEventData, WebPreview } from "@i-bot/types";
import {
  UI_EVENT_PART_TYPE,
  uiEventInstruction,
  skillCommandFromParts,
  webPreviewsFromMessages,
} from "@i-bot/types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import type { A2uiMessage, Message } from "@i-bot/types";
import { api, ApiError, sessionFetch, type ConversationEvent, type RunStateView } from "@/lib/api";
import { type AvatarConfig, parseAvatar } from "@/lib/avatar";
import { errorText } from "@/lib/errors";
import { remarkTags, tagComponents } from "@/lib/markdown-tags";
import { type A2uiAction, A2uiPanel, A2uiRuntimeProvider } from "@/components/A2uiPanel";
import { SkillReviewDialog } from "@/components/SkillReviewDialog";
import { Chip, toChipTone } from "@/components/ui/Chip";
import { ComposerMenu, type ComposerMenuGroup } from "@/components/ui/ComposerMenu";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { WalkingBot } from "@/components/ui/WalkingBot";

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
  avatar,
  onWebPreviewsChange,
}: {
  botId: string;
  conversationId: string;
  initialMessages: UIMessage[];
  desktopActive: boolean;
  /** the bot's stored avatar value; when it parses to an AvatarConfig the wait state shows the
   *  bot's own character walking, otherwise the pixel-grid loader */
  avatar?: string | null;
  onWebPreviewsChange?: (previews: WebPreview[]) => void;
}) {
  const avatarConfig: AvatarConfig | null = parseAvatar(avatar);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: api.chatEndpoint(conversationId),
        credentials: "include",
        fetch: sessionFetch,
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
  // The composer is a single pill row until the draft wraps or a file is staged; then it opens to
  // two rows (field above, controls below) and its corners relax from full-round to a card radius.
  const [multiline, setMultiline] = useState(false);
  const composerOpen = multiline || attachments.length > 0;
  // The "+" menu: attachments, record-a-skill, saved skills, plugins. Skills are fetched lazily
  // the first time it opens (they change rarely; a save re-fetches via the review dialog's onSaved).
  const webPreviews = useMemo(() => webPreviewsFromMessages(messages), [messages]);
  const deliveredPreviews = useRef<{
    signature: string;
    callback: typeof onWebPreviewsChange;
  } | null>(null);
  useEffect(() => {
    const signature = JSON.stringify(webPreviews);
    if (
      deliveredPreviews.current?.signature === signature &&
      deliveredPreviews.current?.callback === onWebPreviewsChange
    ) {
      return;
    }
    deliveredPreviews.current = { signature, callback: onWebPreviewsChange };
    onWebPreviewsChange?.(webPreviews);
  }, [webPreviews, onWebPreviewsChange]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [skills, setSkills] = useState<SkillListItem[] | null>(null);
  useEffect(() => {
    if (!menuOpen || skills !== null) return;
    void api
      .listSkills(botId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [menuOpen, skills, botId]);
  // A skill recorded from the desktop panel (or saved anywhere else) invalidates the cached list so
  // the next menu open shows it.
  useEffect(() => {
    const onChanged = () => setSkills(null);
    window.addEventListener("ibot:skills-changed", onChanged);
    return () => window.removeEventListener("ibot:skills-changed", onChanged);
  }, []);
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
  const panelRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
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
      if (skillCommandFromParts([{ type: "text", text }])) {
        setJobError("请先停止当前任务，再调用插件。");
        return;
      }
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

  // What the "+" menu offers, in three groups. "添加" is the built-ins; "技能" is the bot's own
  // saved skills (a pick inserts a reference the model reads as "use this playbook"); "插件" is
  // the integration slot — GitHub / GitLab / internal tools land here as MCP servers get a list
  // endpoint. Until then they're shown disabled so the shape of the menu is already right.
  const composerMenuGroups: ComposerMenuGroup[] = useMemo(() => {
    const groups: ComposerMenuGroup[] = [
      {
        key: "add",
        title: "添加",
        items: [
          {
            key: "attach",
            label: "附件",
            desc: "上传图片或视频",
            icon: <Paperclip size={13} strokeWidth={1.8} />,
            disabled: !desktopActive,
            hint: desktopActive ? undefined : "需先启动桌面",
          },
          {
            key: "record-skill",
            label: "录制技能",
            desc: "把这次对话提炼成可复用的经验",
            icon: <GraduationCap size={13} strokeWidth={1.8} />,
            disabled: analyzing || messages.length === 0,
            hint: messages.length === 0 ? "对话后可用" : undefined,
          },
        ],
      },
    ];
    if (skills === null || skills.some((sk) => !sk.command)) {
      groups.push({
        key: "skills",
        title: "技能",
        items:
          skills === null
            ? [{ key: "skills-loading", label: "加载中…", disabled: true }]
            : skills
                .filter((sk) => !sk.command)
                .map((sk) => ({
                  key: `skill:${sk.id}`,
                  label: sk.name,
                  desc: sk.description,
                  icon: <BookOpen size={13} strokeWidth={1.8} />,
                })),
      });
    }
    groups.push({
      key: "plugins",
      title: "插件",
      items: [
        ...(skills ?? [])
          .filter((sk) => sk.command)
          .map((sk) => ({
            key: `skill:${sk.id}`,
            label: sk.name,
            desc: `/${sk.command} · ${sk.description}`,
            icon: <Plug size={13} strokeWidth={1.8} />,
            disabled: foregroundLive || !desktopActive,
            hint: foregroundLive ? "请先停止当前任务" : !desktopActive ? "需先启动桌面" : undefined,
          })),
        {
          key: "plugin:github",
          label: "GitHub",
          desc: "Issues、PR、代码检索",
          icon: <Plug size={13} strokeWidth={1.8} />,
          disabled: true,
          hint: "即将支持",
        },
        {
          key: "plugin:gitlab",
          label: "GitLab",
          desc: "内部仓库与流水线",
          icon: <Plug size={13} strokeWidth={1.8} />,
          disabled: true,
          hint: "即将支持",
        },
      ],
    });
    return groups;
  }, [desktopActive, analyzing, messages.length, skills, foregroundLive]);

  const onMenuPick = useCallback(
    (key: string) => {
      setMenuOpen(false);
      if (key === "attach") {
        fileRef.current?.click();
        return;
      }
      if (key === "record-skill") {
        void analyzeSkill();
        return;
      }
      if (key.startsWith("skill:")) {
        // Manual entries insert a command prefix; automatic entries insert a normal skill reference.
        const sk = skills?.find((x) => `skill:${x.id}` === key);
        if (sk?.command) {
          setInput((prev) => `/${sk.command} ${prev.replace(/^\/[a-z][a-z0-9-]*(?:\s|$)/, "")}`);
          inputRef.current?.focus();
          return;
        }
        if (sk) {
          setInput(
            (prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}用「${sk.name}」这个技能:`,
          );
          inputRef.current?.focus();
        }
      }
    },
    [analyzeSkill, skills],
  );

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

  // Two separate concerns, deliberately kept apart so neither can feed back into the other:
  //
  // 1) WHICH layout (compact pill vs. two-row) — state, decided from the text alone by probing at
  //    the COMPACT width (see needsOpenLayout). The answer does not depend on the layout it
  //    produces, so it can never oscillate. `composerOpen` is read only to know how to find the
  //    compact width from the current DOM; the effect keys on the text and the panel size.
  const composerOpenRef = useRef(composerOpen);
  composerOpenRef.current = composerOpen;
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const decide = () => setMultiline(needsOpenLayout(el, !composerOpenRef.current));
    decide();
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(decide);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [input]);

  // 2) HOW TALL — pure DOM writes, no state. Re-fit after every render that can change the field's
  //    size: the text, the open/compact swap (which changes padding, so a fit taken in onChange —
  //    BEFORE that re-render — is stale by one frame: the "two lines but still one line tall" bug),
  //    attachment chips (they take footer space), and any panel resize. Layout effect so it lands
  //    before paint — no flash of the wrong height.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const fit = () => fitComposer(el, panelRef.current, footerRef.current);
    fit();
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [input, composerOpen, attachments.length]);

  return (
    <div
      ref={panelRef}
      style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}
    >
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
              {/* The wait between sending and the first visible reply. Shown while streaming and
                  the live assistant turn hasn't said anything yet (tool calls without prose still
                  count as "nothing to read"). The bot's own character does the waiting when it has
                  an avatar config; a plain pixel grid otherwise. Disappears the moment text lands. */}
              {streaming && !liveTurnHasText(messages) && (
                <LoadingStatus
                  label="思考中"
                  leading={
                    avatarConfig ? (
                      <WalkingBot config={avatarConfig} height={40} title="bot 正在处理" />
                    ) : (
                      "grid"
                    )
                  }
                />
              )}
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

      <div ref={footerRef} style={{ flex: "none", padding: 12 }}>
        <div data-composer-anchor style={{ position: "relative" }}>
          {menuOpen && (
            <ComposerMenu
              groups={composerMenuGroups}
              onPick={onMenuPick}
              onClose={() => setMenuOpen(false)}
              footer="↑↓ 选择 · Enter 确认 · Esc 关闭"
            />
          )}
          <form
            onSubmit={submit}
            className="composer"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: composerOpen ? 6 : 0,
              padding: 6,
              // Pill at rest; relaxes to a card radius once it opens (a 999px radius on a tall box
              // reads as a capsule, not a composer).
              borderRadius: composerOpen ? 20 : 999,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              boxShadow: "var(--shadow-sm)",
              transition:
                "border-color var(--dur) var(--ease), border-radius var(--dur) var(--ease), box-shadow var(--dur) var(--ease)",
            }}
          >
            {attachments.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 6px 0" }}>
                {attachments.map((a, i) => (
                  <AttachmentChip
                    key={`${a.filename ?? "file"}-${i}`}
                    part={a}
                    onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
            {/* Compact: [+] [field] [stop?] [send] on one row. Open: the field takes the full width
              and the controls drop to their own row beneath it. Same nodes both ways — only the
              wrapping changes, so focus and the textarea's height are never disturbed. */}
            <div
              style={{
                display: "flex",
                flexWrap: composerOpen ? "wrap" : "nowrap",
                alignItems: "flex-end",
                gap: 4,
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
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
                  // open: the field is the whole first row; compact: it sits between the controls
                  order: composerOpen ? 0 : 1,
                  flex: composerOpen ? "1 1 100%" : "1 1 auto",
                  minWidth: 0,
                  resize: "none",
                  border: 0,
                  outline: "none",
                  background: "transparent",
                  color: "var(--ink)",
                  font: "inherit",
                  fontSize: "var(--text-body)",
                  lineHeight: 1.55,
                  padding: composerOpen ? "6px 8px 2px" : "4px 6px",
                  // height / max / overflow are owned by fitComposer (measured against the panel),
                  // not fixed here: the cap is "whatever the thread can spare", not a magic number.
                  overflowY: "hidden",
                }}
              />
              {/* left: the "+" that opens the grouped menu (attachments, record a skill, saved
                skills, plugins). Everything that used to be a separate button lives in there. */}
              <div
                style={{
                  order: composerOpen ? 1 : 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  flex: composerOpen ? "1 1 auto" : "none",
                }}
              >
                <ComposerIconButton
                  onClick={() => setMenuOpen((o) => !o)}
                  disabled={!desktopActive && messages.length === 0}
                  title="添加附件、技能或插件"
                  active={menuOpen}
                >
                  <Plus
                    size={16}
                    strokeWidth={2}
                    style={{
                      transition: "transform var(--dur) var(--ease)",
                      transform: menuOpen ? "rotate(45deg)" : "none",
                    }}
                  />
                </ComposerIconButton>
                {analyzing && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: "var(--text-caption)",
                      color: "var(--ink-muted)",
                      paddingLeft: 4,
                    }}
                  >
                    <Loader2 size={12} strokeWidth={2.2} className="spin" />
                    分析对话中…
                  </span>
                )}
              </div>
              {/* right controls: stop (while streaming), send */}
              <div
                style={{ order: 2, display: "flex", alignItems: "center", gap: 4, flex: "none" }}
              >
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
                      height: 28,
                      padding: "0 10px",
                      borderRadius: 999,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--ink-secondary)",
                      fontSize: "var(--text-label)",
                      cursor: "pointer",
                    }}
                  >
                    <Square size={11} strokeWidth={2.2} fill="currentColor" />
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
        </div>
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
          onSaved={() => {
            setSkillDraft(null);
            setSkills(null); // re-fetch on next menu open so the new skill shows up
          }}
        />
      )}
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

/** A round, borderless 28px icon button for the composer's controls (hover reveals a tint). */
function ComposerIconButton({
  onClick,
  disabled,
  title,
  active = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  /** pressed/open state (e.g. while its menu is showing) */
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-expanded={active}
      className="composer-icon"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 999,
        border: 0,
        background: active ? "var(--surface-hover)" : "transparent",
        color: disabled ? "var(--ink-muted)" : active ? "var(--ink)" : "var(--ink-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        flex: "none",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Least conversation height the composer may not eat into. The textarea's cap is whatever the panel
 * has left above this; the fixed floor keeps a long draft from pushing the thread off-screen.
 */
const COMPOSER_MIN_THREAD_PX = 160;
/** Fallback cap when the panel can't be measured (SSR / detached). */
const COMPOSER_FALLBACK_MAX_PX = 240;

/**
 * Fit the composer textarea to its content, capped at the space the panel can spare. The cap is
 * the panel height minus everything that isn't the textarea (thread floor + composer chrome), so
 * growing the field shrinks the thread down to its floor and no further.
 *
 * Measured, not styled: `height: auto` forces the browser to report the content's real scrollHeight
 * for the CURRENT padding, so this must run after any padding change (the open/compact swap) — the
 * layout effect re-runs it post-render for exactly that reason.
 */
function fitComposer(
  el: HTMLTextAreaElement,
  panel: HTMLElement | null,
  footer: HTMLElement | null,
) {
  const cs = getComputedStyle(el);
  const lineHeight = parseFloat(cs.lineHeight) || 20;
  const oneLine = lineHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

  el.style.height = "auto";
  const content = el.scrollHeight;

  let max = COMPOSER_FALLBACK_MAX_PX;
  if (panel && footer) {
    // The footer's height minus the field = attachment chips, control row, paddings, borders. The
    // field may grow into panel − that chrome − the thread floor.
    const chrome = footer.offsetHeight - el.offsetHeight;
    max = Math.max(oneLine, panel.clientHeight - chrome - COMPOSER_MIN_THREAD_PX);
  }
  const h = Math.min(content, max);
  el.style.height = `${h}px`;
  // Scroll inside the field only once it is pinned at the cap; a field that still fits never shows
  // a scrollbar.
  el.style.overflowY = content > max + 1 ? "auto" : "hidden";
}

/**
 * The width the field has in the COMPACT row (sharing it with the buttons), whichever layout is
 * currently showing. Compact: the field's own width. Open: the row's width minus every sibling
 * (button groups) and the gaps between them — what the field would get if the row collapsed.
 */
function compactFieldWidth(el: HTMLTextAreaElement, compact: boolean): number {
  if (compact) return el.clientWidth;
  const row = el.parentElement;
  if (!row) return el.clientWidth;
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  let siblings = 0;
  let n = 0;
  for (const c of Array.from(row.children)) {
    if (c === el || !(c instanceof HTMLElement) || c.hidden) continue;
    // In the open row the left group stretches (flex: 1 1 auto); its buttons' intrinsic width is
    // what it takes in the compact row, so sum the children rather than the stretched box.
    siblings += Array.from(c.children).reduce((w, b) => w + (b as HTMLElement).offsetWidth, 0);
    n++;
  }
  return row.clientWidth - siblings - gap * n;
}

/**
 * Does the text wrap AT THE COMPACT WIDTH? Decides compact pill vs. two-row layout: the field opens
 * exactly when it can no longer hold the draft on one line beside the buttons.
 *
 * Measured at the compact width on purpose, whichever layout is currently showing. The two layouts
 * give the field different widths, so a "does it wrap right now" test is a function of the layout
 * it is deciding — a sentence that wraps in the narrow compact field but fits the wide open one
 * flips compact→open→compact forever ("Maximum update depth exceeded"). Fixing the probe width
 * makes the answer a pure function of the text, so one state change always settles. The probe is a
 * synchronous write/read/restore inside one frame: nothing is painted in between.
 */
function needsOpenLayout(el: HTMLTextAreaElement, compact: boolean): boolean {
  const cs = getComputedStyle(el);
  const lineHeight = parseFloat(cs.lineHeight) || 20;
  const oneLine = lineHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const width = compactFieldWidth(el, compact);
  const prev = { height: el.style.height, width: el.style.width, flex: el.style.flex };
  el.style.flex = "none";
  el.style.width = `${width}px`;
  el.style.height = "auto";
  const wraps = el.scrollHeight > oneLine + lineHeight * 0.5;
  el.style.height = prev.height;
  el.style.width = prev.width;
  el.style.flex = prev.flex;
  return wraps;
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
        height: isImage ? 44 : 26,
        padding: isImage ? 0 : "0 8px 0 7px",
        borderRadius: isImage ? "var(--radius-sm)" : 999,
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
        width: 28,
        height: 28,
        borderRadius: 999,
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
        <span style={{ height: 28, display: "grid", placeItems: "center" }}>
          <ArrowUp size={16} strokeWidth={2.4} />
        </span>
        <span style={{ height: 28, display: "grid", placeItems: "center" }}>
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
                  fontSize: "var(--text-body)",
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
                // remark-directive parses `:tag[text]{tone=ok}`; remarkTags turns that one
                // directive into a `ui-chip` element (see lib/markdown-tags). Order matters:
                // directive must run before the plugin that consumes its nodes.
                remarkPlugins={[remarkGfm, remarkDirective, remarkTags]}
                // Syntax-highlight fenced code (lowlight/highlight.js). `detect` so a fence with no
                // language still gets tokenized; `ignoreMissing` so an unknown language degrades to
                // plain text instead of throwing. Tokens are styled by `.hljs-*` rules in globals.css.
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                components={{
                  // Open any link the model emits in a new tab, safely.
                  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
                  // `:tag[...]{tone=…}` → inline chip. The tone is model-authored, so it goes
                  // through the allow-list; the children are plain markdown text, never HTML.
                  ...tagComponents((p) => (
                    <Chip tone={toChipTone(p["data-tone"])}>{p.children}</Chip>
                  )),
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
          // A rendered A2UI panel: show the interactive surface, not a tool "action" line. Both
          // tools emit the same `{a2ui}` output — `render_ui` is hand-written, `render_card` is a
          // plugin template expanded server-side — so they render through one path.
          if (toolName === "render_ui" || toolName === "render_card") {
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

/** True when the last message is an assistant turn that has already produced some prose. */
function liveTurnHasText(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  return last.parts.some((p) => p.type === "text" && p.text.trim().length > 0);
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
