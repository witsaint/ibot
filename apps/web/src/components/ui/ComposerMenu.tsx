"use client";

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * One row in the composer's "+" menu. `disabled` rows render but can't be picked (with `hint`
 * explaining why — e.g. a plugin that isn't installed yet), so the menu shows what's possible, not
 * just what's available right now.
 */
export interface ComposerMenuItem {
  key: string;
  label: string;
  /** one-line explanation, muted, truncated */
  desc?: string;
  /** leading glyph (lucide icon at 14-15px, or a brand mark) */
  icon?: ReactNode;
  disabled?: boolean;
  /** trailing note shown on disabled rows ("即将支持") or as a status ("已安装") */
  hint?: string;
}

/** A titled group of rows. Groups render in order with a hairline between them. */
export interface ComposerMenuGroup {
  key: string;
  title: string;
  items: ComposerMenuItem[];
}

/**
 * The grouped picker that pops up from the composer's "+" button — attachments, recording a
 * skill, the bot's saved skills, installed plugins. Anchored to the composer (grows upward from
 * its top edge), with a single gliding highlight instead of per-row hover backgrounds, and full
 * keyboard navigation: ↑/↓ move, Enter picks, Esc closes. Clicking anywhere outside closes it.
 *
 * Purely presentational: it receives groups and reports a picked key. What a pick DOES is the
 * caller's business (open a file dialog, insert a reference into the draft, run an action).
 */
export function ComposerMenu({
  groups,
  onPick,
  onClose,
  footer,
}: {
  groups: ComposerMenuGroup[];
  onPick: (key: string) => void;
  onClose: () => void;
  /** muted line at the bottom (a hint about what the menu is for) */
  footer?: ReactNode;
}) {
  // Flatten to a navigable list of pickable rows; group headers are not focusable. Memoized on
  // `groups`: this array is an effect dependency below, and a fresh array every render would
  // re-run the effect → setBox → re-render → fresh array… (the "Maximum update depth" loop).
  const pickable = useMemo(
    () => groups.flatMap((g) => g.items.filter((it) => !it.disabled)),
    [groups],
  );
  const [active, setActive] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The single highlight glides to the active row (transition on top/height), instead of each
  // row toggling its own background. It only shows once the pointer or keyboard has engaged.
  useLayoutEffect(() => {
    const target = pickable[active];
    const el = target ? rowRefs.current.get(target.key) : undefined;
    const root = rootRef.current;
    if (!el || !root) return;
    // Measure against the menu ROOT, not `offsetTop`: rows live inside per-group wrappers, and an
    // offsetTop relative to a group put every group's first row at the same y — so the highlight
    // stayed parked in the first group no matter which row was hovered. Add scrollTop so a scrolled
    // menu still lands on the row.
    const r = el.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const next = { top: Math.round(r.top - rr.top + root.scrollTop), height: Math.round(r.height) };
    // Bail if unchanged: setting an equal-by-value object is still a new reference → re-render.
    setBox((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next));
  }, [active, pickable]);

  // ↑/↓/Enter/Esc — bound on window while open so the textarea keeps focus and typing still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setEngaged(true);
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : pickable.length - 1)) % pickable.length);
      } else if (e.key === "Enter") {
        // Only pick once the user has actually navigated INTO the menu (↑/↓ or hover). Opening it
        // and pressing Enter should still mean "send my message", not "pick the first row".
        if (!engaged) return;
        const target = pickable[active];
        if (target) {
          e.preventDefault();
          onPick(target.key);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [active, engaged, pickable, onPick, onClose]);

  // click outside closes
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (
        root &&
        !root.contains(e.target as Node) &&
        !(e.target as Element).closest("[data-composer-anchor]")
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="menu"
      onMouseLeave={() => setEngaged(false)}
      className="composer-menu"
      style={{
        position: "absolute",
        left: 0,
        bottom: "100%",
        marginBottom: 6,
        zIndex: 20,
        // a compact picker, not a full-width sheet: fixed width off the "+" it opened from
        width: 280,
        maxWidth: "100%",
        padding: 3,
        borderRadius: 10,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-md)",
        transformOrigin: "bottom left",
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      {/* the one gliding highlight */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 3,
          right: 3,
          top: box?.top ?? 0,
          height: box?.height ?? 0,
          borderRadius: 7,
          background: "var(--surface-hover)",
          opacity: box && engaged && pickable.length > 0 ? 1 : 0,
          pointerEvents: "none",
          transition:
            "top 200ms cubic-bezier(0.23,1,0.32,1), height 200ms cubic-bezier(0.23,1,0.32,1), opacity 120ms var(--ease)",
        }}
      />
      {groups.map((g, gi) => (
        // No `position: relative` here — the highlight is positioned against the root and rows are
        // measured against it too (see the layout effect); a positioned wrapper would break that.
        <div key={g.key}>
          <div
            style={{
              padding: gi === 0 ? "4px 8px 2px" : "6px 8px 2px",
              marginTop: gi === 0 ? 0 : 3,
              borderTop: gi === 0 ? 0 : "1px solid var(--border)",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--ink-muted)",
            }}
          >
            {g.title}
          </div>
          {g.items.map((it) => {
            const idx = pickable.findIndex((p) => p.key === it.key);
            return (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                ref={(el) => {
                  if (el) rowRefs.current.set(it.key, el);
                  else rowRefs.current.delete(it.key);
                }}
                onMouseDown={(e) => e.preventDefault()} // keep textarea focus
                onMouseEnter={() => {
                  if (idx >= 0) {
                    setActive(idx);
                    setEngaged(true);
                  }
                }}
                onClick={() => !it.disabled && onPick(it.key)}
                style={{
                  position: "relative",
                  zIndex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  height: 28,
                  padding: "0 7px",
                  borderRadius: 7,
                  border: 0,
                  background: "transparent",
                  textAlign: "left",
                  cursor: it.disabled ? "default" : "pointer",
                  color: "var(--ink)",
                  opacity: it.disabled ? 0.55 : 1,
                }}
              >
                <span
                  style={{
                    display: "flex",
                    width: 16,
                    height: 16,
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: "var(--ink-secondary)",
                  }}
                >
                  {it.icon}
                </span>
                <span style={{ flexShrink: 0, fontSize: "var(--text-caption)", fontWeight: 500 }}>
                  {it.label}
                </span>
                {it.desc && (
                  <span
                    style={{
                      minWidth: 0,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      color: "var(--ink-muted)",
                    }}
                  >
                    {it.desc}
                  </span>
                )}
                {it.hint && (
                  <span
                    style={{
                      marginLeft: "auto",
                      flexShrink: 0,
                      fontSize: 10.5,
                      color: "var(--ink-muted)",
                    }}
                  >
                    {it.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
      {footer && (
        <div
          style={{
            marginTop: 3,
            padding: "5px 8px 3px",
            borderTop: "1px solid var(--border)",
            fontSize: 10.5,
            color: "var(--ink-muted)",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
