import type { CSSProperties, ReactNode } from "react";

/**
 * Semantic tones a chip can carry. Each maps to a solid ink + soft ground pair from the design
 * tokens, so a status chip never needs a raw colour. `muted` is the neutral fallback and what an
 * unknown tone degrades to — never throw on bad input, this is rendered from model output.
 */
export const CHIP_TONES = ["ok", "warn", "danger", "info", "muted"] as const;
export type ChipTone = (typeof CHIP_TONES)[number];

/** Coerce anything (model-authored attribute, user text) into a valid tone; unknown → muted. */
export function toChipTone(value: unknown): ChipTone {
  return typeof value === "string" && (CHIP_TONES as readonly string[]).includes(value)
    ? (value as ChipTone)
    : "muted";
}

const TONE_STYLE: Record<ChipTone, { color: string; background: string; border: string }> = {
  ok: { color: "var(--ok)", background: "var(--ok-soft)", border: "transparent" },
  warn: { color: "var(--warn)", background: "var(--warn-soft)", border: "transparent" },
  danger: { color: "var(--danger)", background: "var(--danger-soft)", border: "transparent" },
  info: { color: "var(--accent-ink)", background: "var(--accent-soft)", border: "transparent" },
  // neutral: no fill, hairline border — reads as a label, not a status
  muted: { color: "var(--ink-secondary)", background: "transparent", border: "var(--border)" },
};

/**
 * Inline label. Sits in running text (prose tags, task strips, transcript meta) at caption size,
 * pill-shaped, one tone. Deliberately tiny API: it's a leaf, not a layout primitive.
 */
export function Chip({
  tone = "muted",
  icon,
  children,
  title,
  style,
}: {
  tone?: ChipTone;
  /** optional leading glyph (a lucide icon at 11-12px works) */
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}) {
  const t = TONE_STYLE[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 20,
        padding: "0 8px",
        borderRadius: 999,
        border: `1px solid ${t.border}`,
        background: t.background,
        color: t.color,
        fontSize: "var(--text-caption)",
        lineHeight: 1,
        fontWeight: 500,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
        // a chip inside a line of prose shouldn't push the line taller
        position: "relative",
        top: -1,
        ...style,
      }}
    >
      {icon}
      {children}
    </span>
  );
}
