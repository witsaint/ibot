# `components/ui/` — the primitive layer

Small, leaf-level UI pieces shared across the app. Everything here is **token-driven** (colours,
sizes and motion come from `packages/config/design-tokens.css` through `var(--…)`), has **no
business logic**, and knows nothing about bots, sandboxes or chat. If a component needs an API
call or app state, it does not belong here — compose these inside a feature component instead.

## Rules

- **Zero raw colour.** Every colour is a token: `--ink*`, `--accent*`, `--ok/warn/danger` (+ `-soft`),
  `--border*`, `--surface*`. Illustration data (avatar backgrounds, landing art) is the one exception
  and lives in `lib/`, not here.
- **Type sizes are tokens too.** `--text-body` (13px, prose/bubbles/inputs), `--text-label` (12.5px,
  control text), `--text-caption` (12px, meta). No literal `px` for text.
- **Motion lives in `globals.css`.** Keyframes and the `prefers-reduced-motion` override are in the
  `components/ui motion` block there, so every ui/ animation is in one place and switches off
  together. Components only set `animation-duration` / `animation-delay` inline.
- **Tone, not colour, as the API.** Status-bearing components take `tone: "ok" | "warn" | "danger" |
"info" | "muted"`. Anything that reaches the UI from model output goes through an allow-list
  (`toChipTone`) — unknown values degrade to `muted`, never throw.
- **Existing `.btn` / `.card` / `.spinner` classes stay.** They are not being migrated wholesale;
  new code reaches for `ui/` first, and old inline styles move over when a feature is touched.

## Components

`PreviewTabs` 是工作区和 `/dev/design` 共用的圆形预览 tab。接收 `items`、`value`、`onChange` 和独立的 `idPrefix`；支持桌面图标、网页图标、无图标渐变球、选中云雾动效、标题 tooltip 和方向键切换。它只负责展示和交互，预览服务、iframe、桌面连接由 `WorkspacePreview` 管理。

| Component                | Use it for                                                                                                                                                                                                  | Key props                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Chip`                   | An inline label at caption size — a state, a count, a file name — in prose, task strips, chips in the transcript. Not a button.                                                                             | `tone`, `icon`, `title`                                                             |
| `Loader`                 | The 3×3 pixel-grid "busy" mark. Leading mark in `LoadingStatus`; fine on its own in a task strip.                                                                                                           | `variant: drive \| dots \| orbit`, `cell`                                           |
| `ShimmerText`            | A label the eye should read as _in progress_. Gradient sweep through the glyphs; settles static under reduced motion.                                                                                       | `size`                                                                              |
| `Elapsed` / `useElapsed` | A live elapsed counter in mono tabular figures (`4.2s`, `1m 12.4s`). Pass `since` (epoch ms) to count from an event.                                                                                        | `since`                                                                             |
| `LoadingStatus`          | The composed wait line: `[mark] shimmer label · elapsed`. The default for anything that takes real time.                                                                                                    | `label`, `leading: "grid" \| "none" \| ReactNode`, `loader`, `since`, `showElapsed` |
| `WalkingBot`             | The bot's unchanged avatar head on the supplied `runningman.svg` body, with shoulder, elbow, hip and knee motion. Clothing picks affect only the portrait. The chat's wait mark when the bot has an avatar. | `config`, `height`, `walking`, `running`                                            |
| `ComposerMenu`           | The grouped picker off the composer's "+": titled groups of rows, one gliding highlight, ↑/↓/Enter/Esc, click-outside closes. Presentational — reports a picked `key`; the caller decides what it does.     | `groups`, `onPick`, `onClose`, `footer`                                             |

### Where each is used today

- `DesktopPanel` — `Elapsed` on the recording button (live counter while a session is being
  recorded); `LoadingStatus` (grid) while the recording is analysed.
- `ChatPanel` — `LoadingStatus` with `WalkingBot` as the leading mark while a turn is streaming and
  the assistant hasn't written anything yet; `Chip` for `:tag[]{tone}` markdown directives in prose
  (via `lib/markdown-tags`); `ComposerMenu` behind the composer's "+" with three groups — **添加**
  (attach files, record a skill), **技能** (the bot's saved skills; picking one inserts a reference
  into the draft), **插件** (GitHub / GitLab / internal tools — the integration slot, shown disabled
  until MCP servers have a list endpoint).

## Adding a component

1. One file, one export, `PascalCase.tsx`. Client-only hooks → `"use client"` at the top.
2. Props: a small object, documented inline; prefer a `tone`/`variant` enum over booleans that
   multiply.
3. Keyframes go in `globals.css` under `components/ui motion`, with a reduced-motion entry.
4. Add a row to the table above.

## Avatar ↔ figure

`lib/avatar.tsx` owns the character. Both composers draw the SAME head (`peepsLayers`: hair + face
from the bot's `AvatarConfig`), so a bot is recognisably itself in both places:

- `composeAvatarSvg` — the square portrait (700×700). Head + the peeps CLOTHING widget, cropped at
  the waist. Byte-identical to before the figure existed.
- `composeFullFigureSvg` — the standing figure (700×1800). Head + `FIGURE_BODY_SVG`, one
  purpose-drawn body (torso, arms with hands, legs with shoes) authored in the canvas frame with its
  collar on the head's neck line. The peeps clothing widget is NOT drawn here — a bust with legs glued
  on read as a collage — instead the body's top is tinted with the avatar's background colour via
  `--outfit-primary`, and trousers/shoes take a fixed dark `--outfit-secondary`.

The body's joints are `<g id>`s the walk cycle rotates: `arm-left`/`arm-right` at the shoulders,
`leg-left`/`leg-right` at the hips; `torso` and `waist` stay still. Opposite limbs share a phase
(left leg forward ↔ right arm forward) — see the `stride`/`swing`/`bob` keyframes in `globals.css`.
Verified with frozen-phase renders: head and torso do not move; arms and legs do.

To add an outfit later: generate another body to the same collar/shoulder/hip coordinates and ids,
keep the two `var(--outfit-*)` fills, and index it — the animation and composer need no change.
