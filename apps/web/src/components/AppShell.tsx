"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bot as BotIcon, LogOut, Pencil, Pin, PinOff, Plus, Settings, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bot } from "@i-bot/types";
import { api, ApiError } from "@/lib/api";
import { CreateBotDialog } from "@/components/CreateBotDialog";
import { AnimatedLogo } from "@/components/AnimatedLogo";
import { SessionMonitor } from "@/components/SessionMonitor";
import { isProtectedPage } from "@/lib/session";
import { AvatarShades, BotAvatarValue } from "@/lib/avatar";

/**
 * The app frame. Chat-app layout: a persistent left rail lists the user's bots (the way a
 * messaging app lists conversations), and the active bot's workspace fills the rest. The
 * rail is the primary nav — quick-create "＋", the bot list with a live status dot and an
 * active highlight, and a footer with settings + sign-out.
 *
 * It's hidden on the unauthenticated surfaces (`/`, `/login`) so those stay full-bleed.
 * Everywhere else it renders `[rail | children]`. The rail re-lists on navigation and on
 * the `ibot:bots-changed` event (fired by create/delete) so it never drifts from reality.
 */
const RAIL_HIDDEN_ON = new Set(["/", "/login"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const showRail = !RAIL_HIDDEN_ON.has(pathname);

  if (!showRail) {
    return <>{children}</>;
  }

  return (
    <div style={{ display: "flex", height: "100vh", minHeight: 0 }}>
      {isProtectedPage(pathname) && <SessionMonitor />}
      <BotRail pathname={pathname} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

/** An open right-click menu: which bot, and where to float it (viewport coords). */
interface RailMenu {
  bot: Bot;
  x: number;
  y: number;
}

/** Stable pinned-first partition — mirrors the server's `orderBy [pinned desc, sortOrder asc]`.
 *  Array.sort is stable, so within each tier the incoming (dragged) order is preserved. */
function railSort(list: Bot[]): Bot[] {
  return [...list].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
}

function BotRail({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [creating, setCreating] = useState(false);
  // The three rail interactions layered above the list: a right-click action menu, an edit-profile
  // dialog, and a delete confirmation. Only one of each is ever open.
  const [menu, setMenu] = useState<RailMenu | null>(null);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [deleting, setDeleting] = useState<Bot | null>(null);
  // id of the bot being dragged for reorder; null when no drag is in flight.
  const [dragId, setDragId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listBots()
      .then(setBots)
      .catch((err) => {
        // The page itself handles the auth redirect; the rail just stays empty.
        if (!(err instanceof ApiError)) setBots([]);
        else if (err.status !== 401) setBots([]);
      });
  }, []);

  // Live-reorder as the dragged item passes over another: splice it to the target's slot and
  // re-partition pinned-first so the preview matches how the server will sort it. Persisted on drop.
  const moveOver = useCallback((targetId: string) => {
    setDragId((currentDrag) => {
      if (!currentDrag || currentDrag === targetId) return currentDrag;
      setBots((prev) => {
        if (!prev) return prev;
        const from = prev.findIndex((b) => b.id === currentDrag);
        const to = prev.findIndex((b) => b.id === targetId);
        if (from === -1 || to === -1) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        if (!moved) return prev; // unreachable (from !== -1), but keeps the splice result typed
        next.splice(to, 0, moved);
        return railSort(next);
      });
      return currentDrag;
    });
  }, []);

  // Drop: persist the current visual order. On failure, reload from the server (revert).
  const persistOrder = useCallback(() => {
    setDragId(null);
    setBots((prev) => {
      if (prev) {
        api.reorderBots(prev.map((b) => b.id)).catch(() => load());
      }
      return prev;
    });
  }, [load]);

  // Right-click Pin/Unpin: flip the flag, optimistically re-partition, persist via PATCH.
  const togglePin = useCallback(
    (bot: Bot) => {
      setBots((prev) =>
        prev
          ? railSort(prev.map((b) => (b.id === bot.id ? { ...b, pinned: !b.pinned } : b)))
          : prev,
      );
      api.updateBot(bot.id, { pinned: !bot.pinned }).catch(() => load());
    },
    [load],
  );

  // Re-list on navigation (keeps the active highlight honest) and on create/delete events.
  useEffect(() => {
    load();
  }, [load, pathname]);

  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener("ibot:bots-changed", onChanged);
    return () => window.removeEventListener("ibot:bots-changed", onChanged);
  }, [load]);

  // Dismiss the action menu on any outside click, Escape, scroll, or resize — it's anchored to a
  // fixed viewport point, so anything that moves the layout should close it rather than orphan it.
  // The listeners attach on the NEXT tick, never synchronously: the right-click that OPENS the menu
  // keeps bubbling to `window` after React sets state, so a same-tick `contextmenu` closer would
  // fire on that very event and self-close. Rail items also `stopPropagation`, so re-opening on a
  // different item doesn't reach these closers — a right-click on empty space still does.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const arm = setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(arm);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  async function signOut() {
    await api.signOut().catch(() => {});
    router.push("/");
  }

  const settingsActive = pathname === "/settings";

  return (
    <aside
      style={{
        width: 64,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "var(--bg-subtle)",
        borderRight: "1px solid var(--border)",
        minHeight: 0,
      }}
    >
      {/* header: wordmark mark only */}
      <div
        style={{
          height: 52,
          flex: "none",
          display: "grid",
          placeItems: "center",
          width: "100%",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Link href="/bots" title="i-bot" style={{ display: "grid", placeItems: "center" }}>
          <AnimatedLogo size={36} />
        </Link>
      </div>

      {/* bot list — avatars only. New-bot moved to the footer (bottom-left, with settings). */}
      <nav
        className="no-scrollbar"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 0",
          minHeight: 0,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        {bots === null ? (
          <span className="spinner" style={{ marginTop: 18 }} />
        ) : (
          bots.map((bot) => (
            <RailItem
              key={bot.id}
              bot={bot}
              active={pathname === `/bots/${bot.id}`}
              menuOpen={menu?.bot.id === bot.id}
              dragging={dragId === bot.id}
              onOpenMenu={(x, y) => setMenu({ bot, x, y })}
              onDragStart={() => setDragId(bot.id)}
              onDragOverItem={() => moveOver(bot.id)}
              onDrop={persistOrder}
            />
          ))
        )}
      </nav>

      {/* footer: new-bot + settings + sign out, icons only, borderless */}
      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--border)",
          padding: "8px 0",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
        }}
      >
        <button
          onClick={() => setCreating(true)}
          title="New bot"
          style={{
            display: "grid",
            placeItems: "center",
            width: 40,
            height: 36,
            border: 0,
            background: "transparent",
            borderRadius: "var(--radius-sm)",
            color: "var(--ink-secondary)",
            cursor: "pointer",
          }}
        >
          <Plus size={18} strokeWidth={1.9} />
        </button>
        <Link
          href="/settings"
          title="Settings"
          style={{
            display: "grid",
            placeItems: "center",
            width: 40,
            height: 36,
            borderRadius: "var(--radius-sm)",
            background: settingsActive ? "var(--accent-soft)" : "transparent",
            color: settingsActive ? "var(--accent-ink)" : "var(--ink-secondary)",
          }}
        >
          <Settings size={16} strokeWidth={1.8} />
        </Link>
        <button
          onClick={signOut}
          title="Sign out"
          style={{
            display: "grid",
            placeItems: "center",
            width: 40,
            height: 36,
            border: 0,
            background: "transparent",
            borderRadius: "var(--radius-sm)",
            color: "var(--ink-secondary)",
            cursor: "pointer",
          }}
        >
          <LogOut size={16} strokeWidth={1.8} />
        </button>
      </div>

      {creating && (
        <CreateBotDialog
          onClose={() => setCreating(false)}
          onSaved={(bot) => {
            setCreating(false);
            router.push(`/bots/${bot.id}`);
          }}
        />
      )}

      {editing && (
        <CreateBotDialog
          bot={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {menu && (
        <BotContextMenu
          menu={menu}
          onEdit={() => {
            setEditing(menu.bot);
            setMenu(null);
          }}
          onTogglePin={() => {
            togglePin(menu.bot);
            setMenu(null);
          }}
          onDelete={() => {
            setDeleting(menu.bot);
            setMenu(null);
          }}
        />
      )}

      {deleting && (
        <DeleteBotConfirm
          bot={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const gone = deleting.id;
            setDeleting(null);
            window.dispatchEvent(new CustomEvent("ibot:bots-changed"));
            // If the open workspace was the deleted bot, leave it — its page would 404.
            if (pathname === `/bots/${gone}`) router.push("/bots");
          }}
        />
      )}
    </aside>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "dot-ok",
  creating: "dot-warn",
  idle: "dot-muted",
  paused: "dot-muted",
  error: "dot-danger",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  creating: "Starting…",
  idle: "Idle",
  paused: "Paused",
  error: "Error",
};

function RailItem({
  bot,
  active,
  menuOpen,
  dragging,
  onOpenMenu,
  onDragStart,
  onDragOverItem,
  onDrop,
}: {
  bot: Bot;
  active: boolean;
  menuOpen: boolean;
  /** true while THIS item is the one being dragged (dimmed to signal it's in flight) */
  dragging: boolean;
  /** open the right-click action menu at viewport point (x, y) */
  onOpenMenu: (x: number, y: number) => void;
  /** this item picked up for a reorder drag */
  onDragStart: () => void;
  /** the dragged item is hovering over this item — live-reorder to here */
  onDragOverItem: () => void;
  /** the drag ended (dropped or released) — persist the order */
  onDrop: () => void;
}) {
  // A rich hover card floated to the right of the rail. The rail's <nav> clips overflow, so the
  // card is fixed-positioned from the item's measured rect rather than absolutely inside the item.
  const [hoverAt, setHoverAt] = useState<{ top: number; left: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTip = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(
      () => setHoverAt({ top: r.top + r.height / 2, left: r.right + 12 }),
      260,
    );
  };
  const hideTip = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverAt(null);
  };
  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);
  // Never show the hover card while its own action menu is open — they'd overlap.
  const tipOpen = hoverAt !== null && !menuOpen;
  // "Offline" = the bot dropped: paused or errored. Only these grey out in the rail.
  const offline = bot.status === "paused" || bot.status === "error";

  return (
    <Link
      href={`/bots/${bot.id}`}
      aria-label={`${bot.name} · ${STATUS_LABEL[bot.status] ?? bot.status}`}
      draggable
      onMouseEnter={(e) => showTip(e.currentTarget)}
      onMouseLeave={hideTip}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        onOpenMenu(e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        // A drag is a reorder, not a link drag — suppress the ghost URL and hint a move.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", bot.id);
        hideTip();
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault(); // allow drop
        e.dataTransfer.dropEffect = "move";
        onDragOverItem();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDrop}
      style={{
        position: "relative",
        display: "grid",
        placeItems: "center",
        flex: "none",
        opacity: dragging ? 0.4 : 1,
      }}
    >
      {/* active accent bar on the left edge */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: -12,
          top: "50%",
          transform: "translateY(-50%)",
          width: 3,
          height: active ? 22 : 0,
          borderRadius: 2,
          background: "var(--accent)",
          transition: "height var(--dur) var(--ease)",
        }}
      />
      <div
        className={`rail-avatar${offline ? " is-offline" : ""}`}
        style={{
          position: "relative",
          width: 40,
          height: 40,
          borderRadius: 11,
          // Only OFFLINE bots (paused / errored) grey out (.is-offline); everyone else stays full
          // color. Selection is shown by the sunglasses overlay + the left accent bar. An open
          // action menu firms the hairline so it's clear which item the menu belongs to.
          border: `1px solid ${active || menuOpen ? "var(--border-strong)" : "var(--border)"}`,
          background: "var(--surface)",
          display: "grid",
          placeItems: "center",
          fontSize: 18,
          color: active ? "var(--ink)" : "var(--ink-secondary)",
          overflow: "hidden",
        }}
      >
        {BotAvatarValue({ value: bot.avatar, size: 40, title: bot.name }) ?? (
          <BotIcon size={19} strokeWidth={1.7} />
        )}
        {/* selected bot "puts on shades" — the overlay drops in over the eyes */}
        {active && <AvatarShades className="rail-shades" />}
      </div>
      {/* status dot, bottom-right corner */}
      <span
        className={`dot ${STATUS_TONE[bot.status] ?? "dot-muted"}`}
        style={{
          position: "absolute",
          right: 1,
          bottom: 1,
          border: "1.5px solid var(--bg-subtle)",
          width: 9,
          height: 9,
        }}
      />

      {/* pinned badge, top-left corner — clear of the bottom-right status dot */}
      {bot.pinned && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: -3,
            top: -3,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: "var(--accent)",
            color: "var(--accent-ink)",
            display: "grid",
            placeItems: "center",
            border: "1.5px solid var(--bg-subtle)",
          }}
        >
          <Pin size={8} strokeWidth={2.4} />
        </span>
      )}

      {tipOpen && <RailTooltip bot={bot} top={hoverAt.top} left={hoverAt.left} />}
    </Link>
  );
}

/**
 * The hover card for a rail item — name, status, and (if set) description. Fixed-positioned to the
 * right of the rail so it isn't clipped by the list's overflow. Layering + a soft top-down surface
 * gradient give it a lift off the flat rail without breaking the single-accent palette.
 */
function RailTooltip({ bot, top, left }: { bot: Bot; top: number; left: number }) {
  return (
    <div
      role="tooltip"
      style={{
        position: "fixed",
        top,
        left,
        transform: "translateY(-50%)",
        zIndex: 60,
        pointerEvents: "none",
        width: 220,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border)",
        background: "linear-gradient(180deg, var(--surface), var(--bg-subtle))",
        boxShadow: "var(--shadow-lg)",
        animation: "railpop var(--dur) var(--ease)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            flex: "none",
            borderRadius: 7,
            overflow: "hidden",
            border: "1px solid var(--border)",
            display: "grid",
            placeItems: "center",
          }}
        >
          {BotAvatarValue({ value: bot.avatar, size: 26, title: bot.name }) ?? (
            <BotIcon size={14} strokeWidth={1.7} />
          )}
        </span>
        <span style={{ fontSize: 13, fontWeight: 560, color: "var(--ink)" }}>{bot.name}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
        <span className={`dot ${STATUS_TONE[bot.status] ?? "dot-muted"}`} />
        <span style={{ fontSize: 11.5, color: "var(--ink-secondary)" }}>
          {STATUS_LABEL[bot.status] ?? bot.status}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--ink-muted)",
          }}
        >
          {bot.model}
        </span>
      </div>
      {bot.description && (
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--ink-secondary)",
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {bot.description}
        </p>
      )}
      <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--ink-muted)" }}>
        Right-click for actions
      </div>
    </div>
  );
}

/**
 * The right-click action menu, floated at the cursor. Two tiers: neutral actions (Open, Edit
 * profile) then a hairline divider then the destructive Delete, tinted with `--danger` so the
 * gravity of the row is legible before the confirm. Fixed-positioned; the parent closes it on any
 * outside interaction. A tiny left→right surface gradient matches the tooltip's lift.
 */
function BotContextMenu({
  menu,
  onEdit,
  onTogglePin,
  onDelete,
}: {
  menu: RailMenu;
  onEdit: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  // Keep the menu on-screen: clamp near the right/bottom edges (it's ~180×w tall).
  const left = Math.min(menu.x, typeof window !== "undefined" ? window.innerWidth - 196 : menu.x);
  const top = Math.min(menu.y, typeof window !== "undefined" ? window.innerHeight - 150 : menu.y);
  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 70,
        width: 184,
        padding: 5,
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border)",
        background: "linear-gradient(180deg, var(--surface), var(--bg-subtle))",
        boxShadow: "var(--shadow-lg)",
        animation: "railmenu var(--dur) var(--ease)",
      }}
    >
      <div style={{ padding: "4px 8px 6px", fontSize: 11, color: "var(--ink-muted)" }}>
        {menu.bot.name}
      </div>
      <MenuRow
        icon={<BotIcon size={14} strokeWidth={1.8} />}
        onClick={() => router.push(`/bots/${menu.bot.id}`)}
      >
        Open
      </MenuRow>
      <MenuRow icon={<Pencil size={14} strokeWidth={1.8} />} onClick={onEdit}>
        Edit profile
      </MenuRow>
      <MenuRow
        icon={
          menu.bot.pinned ? (
            <PinOff size={14} strokeWidth={1.8} />
          ) : (
            <Pin size={14} strokeWidth={1.8} />
          )
        }
        onClick={onTogglePin}
      >
        {menu.bot.pinned ? "Unpin" : "Pin to top"}
      </MenuRow>
      <div style={{ height: 1, background: "var(--border)", margin: "5px 6px" }} />
      <MenuRow icon={<Trash2 size={14} strokeWidth={1.8} />} danger onClick={onDelete}>
        Delete
      </MenuRow>
    </div>
  );
}

function MenuRow({
  icon,
  children,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const color = danger ? "var(--danger)" : "var(--ink)";
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        padding: "7px 8px",
        border: 0,
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        fontSize: 12.5,
        fontWeight: 500,
        textAlign: "left",
        color,
        background: hover
          ? danger
            ? "color-mix(in srgb, var(--danger) 10%, transparent)"
            : "var(--accent-soft)"
          : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <span style={{ display: "grid", placeItems: "center", color }}>{icon}</span>
      {children}
    </button>
  );
}

/**
 * A deliberate confirm before a destructive, irreversible delete. Deleting a bot tears down its
 * sandbox and cascades to its conversations/messages, so we spell that out and gate it behind an
 * explicit click rather than a native `confirm()`.
 */
function DeleteBotConfirm({
  bot,
  onClose,
  onDeleted,
}: {
  bot: Bot;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteBot(bot.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete bot");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.28)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 80,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 400, padding: 22, boxShadow: "var(--shadow-lg)" }}
      >
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Delete “{bot.name}”?</h2>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
          This shuts down the bot&apos;s desktop and permanently removes its conversations and
          history. This can&apos;t be undone.
        </p>
        {error && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10 }}>{error}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>
            {busy ? <span className="spinner" /> : "Delete bot"}
          </button>
        </div>
      </div>
    </div>
  );
}
