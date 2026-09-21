"use client";

import type { UIMessage } from "ai";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Bot } from "@i-bot/types";
import { api, ApiError } from "@/lib/api";
import { ChatPanel } from "@/components/ChatPanel";
import { DesktopPanel } from "@/components/DesktopPanel";
import { BotAvatarValue } from "@/lib/avatar";

export default function WorkspacePage() {
  const router = useRouter();
  const params = useParams<{ botId: string }>();
  const botId = params.botId;

  const [bot, setBot] = useState<Bot | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null);
  const [desktopActive, setDesktopActive] = useState(false);
  const [notFound, setNotFound] = useState(false);

  // Chat/desktop split: the chat column's width in px, user-draggable and remembered across visits.
  const CHAT_MIN = 320;
  const CHAT_MAX = 760;
  const CHAT_WIDTH_KEY = "ibot:chatWidth";
  const [chatWidth, setChatWidth] = useState(420);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  // Restore a saved width once on mount (clamped, in case bounds changed).
  useEffect(() => {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      setChatWidth(Math.min(CHAT_MAX, Math.max(CHAT_MIN, saved)));
    }
  }, []);

  // Drag the divider: track the pointer against the split container's left edge, clamp, and
  // persist. Pointer capture keeps the drag alive even if the cursor outruns the thin seam.
  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const box = splitRef.current?.getBoundingClientRect();
      if (!box) return;
      const w = Math.min(CHAT_MAX, Math.max(CHAT_MIN, ev.clientX - box.left));
      setChatWidth(w);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setChatWidth((w) => {
        localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(w)));
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // Load bot, then ensure a conversation + its history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { bot: loaded } = await api.getBot(botId);
        if (cancelled) return;
        setBot(loaded);

        const convos = await api.listConversations(botId);
        const convo = convos[0] ?? (await api.createConversation(botId));
        if (cancelled) return;
        setConversationId(convo.id);

        const msgs = await api.listMessages(convo.id);
        if (cancelled) return;
        setInitialMessages(
          msgs.map((m) => ({ id: m.id, role: m.role, parts: m.parts })) as UIMessage[],
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace("/");
        else setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId, router]);

  // Keep the header (avatar / name / model) in step with edits made elsewhere. The settings
  // dialog writes through PATCH and fires `ibot:bots-changed`; the rail already re-lists on it,
  // but this page only fetched the bot once on mount, so the header kept showing the values it
  // mounted with until a manual reload. Refetch just the bot — the conversation is independent,
  // so this must not re-run the load above (that would restart the message fetch mid-read).
  useEffect(() => {
    const onChanged = () => {
      api
        .getBot(botId)
        .then(({ bot: fresh }) => setBot(fresh))
        // A refetch raced with a delete: the page is going away anyway, so ignore.
        .catch(() => {});
    };
    window.addEventListener("ibot:bots-changed", onChanged);
    return () => window.removeEventListener("ibot:bots-changed", onChanged);
  }, [botId]);

  if (notFound) {
    return (
      <main className="container" style={{ paddingTop: 64, textAlign: "center" }}>
        <h1>Bot not found</h1>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          It may have been deleted, or you don&apos;t have access.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/bots" className="btn btn-sm">
            Back to bots
          </Link>
        </p>
      </main>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* slim workspace header — wordmark + sign-out live in the rail now */}
      <header
        style={{
          height: 52,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 18px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {bot &&
          (() => {
            const av = BotAvatarValue({ value: bot.avatar, size: 26, title: bot.name });
            return av ? (
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  display: "grid",
                  placeItems: "center",
                  flex: "none",
                }}
              >
                {av}
              </span>
            ) : null;
          })()}
        <span style={{ fontSize: 14, fontWeight: 540 }}>{bot?.name ?? "…"}</span>
        {bot && (
          <span className="muted" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
            {bot.model}
          </span>
        )}
      </header>

      <div ref={splitRef} style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* left: chat — width is user-draggable via the divider */}
        <section
          style={{
            width: chatWidth,
            flex: "none",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          {conversationId && initialMessages !== null ? (
            <ChatPanel
              botId={botId}
              conversationId={conversationId}
              initialMessages={initialMessages}
              desktopActive={desktopActive}
            />
          ) : (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <span className="spinner" />
            </div>
          )}
        </section>

        {/* draggable divider — a dashed seam you grab to rebalance chat vs. desktop. The desktop
            keeps its own aspect ratio automatically (its ResizeObserver re-fits on every width
            change), so dragging never distorts the screen. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and desktop"
          onPointerDown={startDrag}
          style={{
            flex: "none",
            width: 9,
            cursor: "col-resize",
            display: "flex",
            justifyContent: "center",
            alignItems: "stretch",
            background: "transparent",
            touchAction: "none",
          }}
        >
          {/* the visible seam: a vertical dashed line, brightened while dragging */}
          <div
            style={{
              width: 0,
              borderLeft: `1px dashed ${dragging ? "var(--accent)" : "var(--border-strong)"}`,
              transition: dragging ? "none" : "border-color var(--dur) var(--ease)",
            }}
          />
        </div>

        {/* right: live desktop */}
        <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <DesktopPanel botId={botId} onActive={setDesktopActive} />
        </section>
      </div>
    </div>
  );
}
