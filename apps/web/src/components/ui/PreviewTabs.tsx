"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface PreviewTab {
  id: string;
  title: string;
  kind: "desktop" | "web";
  icon?: ReactNode;
  panelId?: string;
}

/** Shared by the live workspace and the design sheet; receives presentation data only. */
export function PreviewTabs({
  items,
  value,
  onChange,
  idPrefix,
}: {
  items: readonly PreviewTab[];
  value: string;
  onChange: (id: string) => void;
  /** Matches the containing panel's aria-labelledby; each instance needs its own prefix. */
  idPrefix: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    tabId: string;
    title: string;
    left: number;
    top: number;
    maxWidth: number;
  } | null>(null);
  const tooltipId = useId();
  const showTooltip = (tab: HTMLButtonElement, title: string) => {
    const rect = tab.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 160));
    setTooltip({
      tabId: tab.id,
      title,
      left,
      top: rect.bottom + 8,
      maxWidth: Math.min(280, window.innerWidth - left - 8),
    });
  };
  const hideTooltip = () => setTooltip(null);
  useEffect(() => {
    if (!tooltip) return;
    const hide = () => setTooltip(null);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [tooltip]);
  return (
    <>
      <div className="workspace-preview-tabs" role="tablist" aria-label="工作区预览" ref={listRef}>
        {items.map((item, index) => (
          <button
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${index}`}
            aria-controls={item.panelId}
            aria-selected={item.id === value}
            tabIndex={item.id === value ? 0 : -1}
            key={item.id}
            className={`workspace-preview-tab${item.kind === "desktop" ? " workspace-preview-desktop-tab" : ""}`}
            aria-label={item.title}
            aria-describedby={tooltip?.tabId === `${idPrefix}-tab-${index}` ? tooltipId : undefined}
            onMouseEnter={(event) => showTooltip(event.currentTarget, item.title)}
            onMouseLeave={hideTooltip}
            onFocus={(event) => showTooltip(event.currentTarget, item.title)}
            onBlur={hideTooltip}
            onClick={() => {
              hideTooltip();
              onChange(item.id);
            }}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (index + 1) % items.length;
              else if (event.key === "ArrowLeft") next = (index + items.length - 1) % items.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = items.length - 1;
              else return;
              event.preventDefault();
              listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
              onChange(items[next]!.id);
            }}
            style={item.kind === "web" ? orbMotionStyle(item.id) : undefined}
          >
            <PreviewOrb>{item.icon}</PreviewOrb>
          </button>
        ))}
      </div>
      {tooltip &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="workspace-preview-tooltip"
            style={{ left: tooltip.left, top: tooltip.top, maxWidth: tooltip.maxWidth }}
          >
            {tooltip.title}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Stable offsets let different project orbs drift independently without hydration changes. */
function orbMotionStyle(key: string): CSSProperties {
  const seed = Array.from(key).reduce(
    (hash, char) => Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0,
    2166136261,
  );
  return {
    "--orb-hue": `${seed % 360}deg`,
    "--orb-turn": `${seed % 360}deg`,
    "--orb-delay-a": `-${seed % 7300}ms`,
    "--orb-delay-b": `-${(seed * 7) % 10900}ms`,
    "--orb-delay-c": `-${(seed * 13) % 13100}ms`,
  } as CSSProperties;
}

/** Blurred color clouds orbit independently; foreground icons never inherit their filters. */
function PreviewOrb({ children }: { children?: ReactNode }) {
  return (
    <span className="workspace-preview-orb" aria-hidden="true">
      <span className="workspace-preview-clouds">
        {Array.from({ length: 6 }, (_, index) => (
          <span className="workspace-preview-cloud" key={index} />
        ))}
      </span>
      {children}
    </span>
  );
}
