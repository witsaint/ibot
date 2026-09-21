"use client";

/**
 * The avatar picker in the create-bot dialog: a live preview beside a tabbed swatch grid. The four
 * categories — background, hair, face, clothing — are tabs rather than four stacked rows, so the
 * picker stays compact (one category's options visible at a time) instead of eating the dialog's
 * height. Selection is fully manual (no auto-generation from id/name); the chosen `AvatarConfig` is
 * lifted to the parent, which serializes it onto the bot. Styled with the app's design tokens.
 */
import { useState } from "react";
import {
  type AvatarConfig,
  BACKGROUNDS,
  BODY_COUNT,
  BODY_LABELS,
  BotAvatar,
  FACE_COUNT,
  FACE_LABELS,
  HAIR_COUNT,
  HAIR_LABELS,
} from "@/lib/avatar";

type TabKey = "bg" | "hair" | "face" | "body";

interface Tab {
  key: TabKey;
  label: string;
  count: number;
  optionLabels: readonly string[];
  /** the config to preview for option `i` (only this tab's field differs from `value`) */
  render: (value: AvatarConfig, i: number) => AvatarConfig;
}

const TABS: Tab[] = [
  {
    key: "bg",
    label: "Background",
    count: BACKGROUNDS.length,
    optionLabels: BACKGROUNDS.map((_, i) => `Color ${i + 1}`),
    render: (v, i) => ({ ...v, bg: i }),
  },
  {
    key: "hair",
    label: "Hair",
    count: HAIR_COUNT,
    optionLabels: HAIR_LABELS,
    render: (v, i) => ({ ...v, hair: i }),
  },
  {
    key: "face",
    label: "Face",
    count: FACE_COUNT,
    optionLabels: FACE_LABELS,
    render: (v, i) => ({ ...v, face: i }),
  },
  {
    key: "body",
    label: "Clothing",
    count: BODY_COUNT,
    optionLabels: BODY_LABELS,
    render: (v, i) => ({ ...v, body: i }),
  },
];

export function AvatarPicker({
  value,
  onChange,
}: {
  value: AvatarConfig;
  onChange: (next: AvatarConfig) => void;
}) {
  const [tab, setTab] = useState<TabKey>("hair");
  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  const selectedIndex = value[active.key];

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      {/* live preview */}
      <div
        style={{
          flex: "none",
          width: 88,
          height: 88,
          borderRadius: 16,
          overflow: "hidden",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <BotAvatar config={value} size={88} title="avatar preview" />
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {/* tab strip */}
        <div
          role="tablist"
          aria-label="Avatar category"
          style={{
            display: "flex",
            gap: 2,
            padding: 2,
            borderRadius: "var(--radius-md)",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
          }}
        >
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.key)}
                style={{
                  flex: 1,
                  padding: "5px 6px",
                  fontSize: 12,
                  fontWeight: on ? 560 : 460,
                  cursor: "pointer",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid transparent",
                  background: on ? "var(--surface)" : "transparent",
                  color: on ? "var(--ink)" : "var(--ink-secondary)",
                  borderColor: on ? "var(--border)" : "transparent",
                  boxShadow: on ? "var(--shadow-sm)" : "none",
                  transition: "background var(--dur) var(--ease), color var(--dur) var(--ease)",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* swatch grid for the active tab */}
        <div
          role="tabpanel"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gap: 6,
          }}
        >
          {Array.from({ length: active.count }, (_, i) => {
            const on = i === selectedIndex;
            return (
              <button
                key={i}
                type="button"
                title={active.optionLabels[i] ?? String(i + 1)}
                aria-label={`${active.label}: ${active.optionLabels[i] ?? i + 1}`}
                aria-pressed={on}
                onClick={() => onChange(active.render(value, i))}
                style={{
                  aspectRatio: "1 / 1",
                  width: "100%",
                  padding: 0,
                  borderRadius: 8,
                  overflow: "hidden",
                  cursor: "pointer",
                  background: "var(--surface)",
                  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                  boxShadow: on ? "0 0 0 2px var(--accent-ring)" : "none",
                  transition:
                    "border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <BotAvatar config={active.render(value, i)} size={36} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
