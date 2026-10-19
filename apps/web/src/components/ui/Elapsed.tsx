"use client";

import { useEffect, useState } from "react";

/**
 * Seconds elapsed since `since` (epoch ms), ticking at 100ms so the tenths read as live. The
 * anchor is the caller's, so a re-render never resets the count — pass a value captured once.
 */
export function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, (now - since) / 1000);
}

/** `4.2s` under a minute, `1m 12.4s` after. Tenths so a stall is visible as a frozen digit. */
export function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const m = Math.floor(totalSeconds / 60);
  return `${m}m ${(totalSeconds % 60).toFixed(1)}s`;
}

/**
 * A live elapsed-time counter in mono tabular figures, so the digits don't jitter as they change.
 * Counts from mount by default; pass `since` (epoch ms) to count from an earlier event.
 */
export function Elapsed({ since }: { since?: number }) {
  // Fix the mount instant once — a parent re-render must not restart the clock.
  const [mounted] = useState(() => Date.now());
  const seconds = useElapsed(since ?? mounted);
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-caption)",
        color: "var(--ink-muted)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatElapsed(seconds)}
    </span>
  );
}
