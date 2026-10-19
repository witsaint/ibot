import type { ReactNode } from "react";

/**
 * Text with a highlight sweeping through it — the "working…" label. The gradient is built from
 * the ink tokens (muted → ink → muted), so it follows the theme, and the sweep is a background-
 * position animation (`shimmer-text` in globals.css): no layout, no repaint of the glyphs
 * themselves. Under prefers-reduced-motion it settles on the static mid-tone — still readable,
 * just not moving.
 */
export function ShimmerText({
  children,
  size = "var(--text-body)",
}: {
  children: ReactNode;
  size?: string | number;
}) {
  return (
    <span
      className="ui-shimmer"
      style={{
        fontSize: size,
        fontWeight: 500,
        // gradient text: paint the background through the glyphs
        backgroundImage:
          "linear-gradient(90deg, var(--ink-muted) 35%, var(--ink) 50%, var(--ink-muted) 65%)",
        backgroundSize: "200% 100%",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        // fallback if background-clip:text is unsupported — the text is still there
        WebkitTextFillColor: "transparent",
      }}
    >
      {children}
    </span>
  );
}
