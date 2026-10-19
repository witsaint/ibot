"use client";

import type { ReactNode } from "react";
import { Elapsed } from "./Elapsed";
import { Loader, type LoaderVariant } from "./Loader";
import { ShimmerText } from "./ShimmerText";

/**
 * The one-line "working…" status: an optional leading mark, a shimmering label, and a live elapsed
 * counter. Use it wherever the UI is waiting on something that takes real time (a turn starting, a
 * task running) — never a bare spinner with no words.
 *
 * `leading`: `"grid"` (default) draws the pixel Loader; `"none"` omits the mark; or pass any node
 * (typically `<WalkingBot/>` for the chat wait, so the bot's own character does the waiting).
 */
export function LoadingStatus({
  label,
  leading = "grid",
  loader = "drive",
  since,
  showElapsed = true,
}: {
  label: ReactNode;
  leading?: "grid" | "none" | ReactNode;
  /** pixel-grid pattern when `leading` is "grid" */
  loader?: LoaderVariant;
  /** epoch ms the wait started; defaults to mount */
  since?: number;
  showElapsed?: boolean;
}) {
  const mark =
    leading === "grid" ? <Loader variant={loader} /> : leading === "none" ? null : leading;
  return (
    <div
      role="status"
      style={{ display: "inline-flex", alignItems: "center", gap: 10, width: "fit-content" }}
    >
      {mark}
      <ShimmerText>{label}</ShimmerText>
      {showElapsed && <Elapsed since={since} />}
    </div>
  );
}
