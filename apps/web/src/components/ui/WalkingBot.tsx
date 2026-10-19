"use client";

import { useId, type CSSProperties } from "react";
import { type AvatarConfig, composeFullFigureSvg } from "@/lib/avatar";
import styles from "./WalkingBot.module.css";

/** The bot's existing head on the supplied SVG body, animated at its joints. */
export function WalkingBot({
  config,
  height = 96,
  walking = true,
  running = false,
  style,
  title,
}: {
  config: AvatarConfig;
  /** Total canvas height in pixels, including space for the stride. */
  height?: number;
  /** false = a static standing figure */
  walking?: boolean;
  /** faster stride with bent elbows and knees */
  running?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  const id = `walking-bot-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span
      role="img"
      aria-label={title ?? "bot is working"}
      className={styles.figure}
      data-motion={walking ? (running ? "running" : "walking") : "still"}
      style={{ height, width: (height * 1100) / 1800, ...style }}
      // Only trusted, local illustration markup and catalog widgets are composed here.
      dangerouslySetInnerHTML={{ __html: composeFullFigureSvg(config, id) }}
    />
  );
}
