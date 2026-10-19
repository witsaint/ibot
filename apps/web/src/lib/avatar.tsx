/**
 * Bot avatars, composed from Open Peeps line-art widgets (CC0) and rendered from a tiny JSON config
 * — never a generated image file.
 *
 * A bot's `avatar` field (a string) holds `JSON.stringify(AvatarConfig)`: four small indices
 * (background / hair / face / clothing) the user picks at creation time. `BotAvatar` layers the
 * three chosen widget SVGs onto a colored background and draws the whole thing inline, so the
 * "image" is reconstructed on every render and nothing but a ~40-byte config is ever stored.
 *
 * The widget markup lives in the generated `avatar-widgets.ts` (Open Peeps, Pablo Stanley —
 * openpeeps.com, CC0). The peeps "lines" are actually filled black shapes, so on a solid color the
 * black line-art reads crisply, white fills stay white, and the un-filled skin area shows the
 * background color through — the intended minimalist look. Layer offsets mirror the reference
 * composer (body low, head up top, face mid). Background palette is illustration DATA (literal
 * hexes), not UI chrome, so it doesn't reference design tokens.
 */
import type { CSSProperties } from "react";
import { composeRunningBodySvg } from "./running-body";
import {
  BODY_ITEMS,
  BODY_SVGS,
  FACE_ITEMS,
  FACE_SVGS,
  HAIR_ITEMS,
  HAIR_SVGS,
} from "./avatar-widgets";

export interface AvatarConfig {
  /** index into BACKGROUNDS */
  bg: number;
  /** index into HAIR_SVGS (the head/hair widget) */
  hair: number;
  /** index into FACE_SVGS (the expression widget) */
  face: number;
  /** index into BODY_SVGS (the clothing widget) */
  body: number;
}

// ---------- background palette (illustration data) ----------
export const BACKGROUNDS = [
  "#E8EEF9",
  "#E3F3EA",
  "#FBEEDD",
  "#F9E6EC",
  "#ECEAF8",
  "#E4F1F3",
  "#EFEEE8",
  "#E7EAEE",
] as const;

// Option labels + counts come straight from the generated widget catalog.
export const HAIR_LABELS: readonly string[] = HAIR_ITEMS;
export const FACE_LABELS: readonly string[] = FACE_ITEMS;
export const BODY_LABELS: readonly string[] = BODY_ITEMS;
export const HAIR_COUNT = HAIR_SVGS.length;
export const FACE_COUNT = FACE_SVGS.length;
export const BODY_COUNT = BODY_SVGS.length;

export const DEFAULT_AVATAR: AvatarConfig = { bg: 0, hair: 0, face: 1, body: 0 };

const clamp = (n: unknown, max: number): number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n < max ? n : 0;

/** Parse a bot's stored `avatar` string into a config, or null if it isn't one (e.g. a legacy emoji). */
export function parseAvatar(value: string | null | undefined): AvatarConfig | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return null;
    // require at least one of our keys so we don't mis-read arbitrary JSON
    if (!("bg" in o || "hair" in o || "face" in o || "body" in o)) return null;
    return {
      bg: clamp(o.bg, BACKGROUNDS.length),
      hair: clamp(o.hair, HAIR_COUNT),
      face: clamp(o.face, FACE_COUNT),
      body: clamp(o.body, BODY_COUNT),
    };
  } catch {
    return null;
  }
}

/** Serialize a config into the compact string stored on `bot.avatar`. */
export function serializeAvatar(c: AvatarConfig): string {
  return JSON.stringify({ v: 1, bg: c.bg, hair: c.hair, face: c.face, body: c.body });
}

/**
 * The peeps widgets' layer offsets — the ONE place they live. The square avatar draws head + peeps
 * body; the standing figure draws the same head over a different body, so `withBody` toggles the
 * peeps torso and the head stays byte-identical between the two.
 *
 * Offsets mirror the reference composer; the centering nudge is on an inner group (not the root
 * <svg>, where a transform isn't reliably honored). Measured across all widgets, the head lands ~+59
 * and the body ~+38 right of center at the reference offsets; a -73 outer shift splits the
 * difference so both sit within ±11px of the midline.
 */
function peepsLayers(config: AvatarConfig, withBody: boolean): string {
  const body = withBody ? (BODY_SVGS[config.body % BODY_SVGS.length] ?? "") : "";
  const hair = HAIR_SVGS[config.hair % HAIR_SVGS.length] ?? "";
  const face = FACE_SVGS[config.face % FACE_SVGS.length] ?? "";
  return (
    `<g transform="translate(-73, 0)">` +
    (withBody ? `<g transform="translate(0, 550)">${body}</g>` : "") +
    `<g transform="translate(200, 50)">${hair}</g>` +
    `<g transform="translate(320, 250)"><g>${face}</g></g>` +
    `</g>`
  );
}

/**
 * The shared root element: both composers open with identical attributes. The <svg> is sized
 * 100%/100% and the WRAPPER (BotAvatar / WalkingBot's <span>) carries the pixel size — so a caller
 * can rescale an avatar with plain CSS on the wrapper (e.g. `width:100%` inside a picker tile) and
 * the drawing follows; a fixed px on the <svg> itself would overflow or crop instead.
 */
const svgOpen = (viewBox: string): string =>
  `<svg width="100%" height="100%" viewBox="${viewBox}" fill="none" stroke="#000" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`;

/**
 * Compose the three chosen widgets onto a background into one inline SVG string — the square
 * avatar (bust). The 700×700 canvas crops at the waist, which is what makes it a portrait. The
 * peep art is fill-based, so the inherited `stroke`/`stroke-width` barely matter but are kept to
 * match the source.
 */
function composeAvatarSvg(config: AvatarConfig): string {
  const bg = BACKGROUNDS[config.bg % BACKGROUNDS.length];
  return (
    svgOpen("0 0 700 700") +
    `<rect x="0" y="0" width="700" height="700" fill="${bg}"/>` +
    peepsLayers(config, true) +
    `</svg>`
  );
}

/** The supplied body and the existing portrait head; the portrait composer stays independent. */
export function composeFullFigureSvg(config: AvatarConfig, id: string): string {
  return (
    svgOpen("-150 0 1100 1800") +
    // Reuse Loader's brightness animation; decreasing delays send the wave right to left.
    `<g data-part="road" fill="var(--ink)" stroke="none">` +
    Array.from(
      { length: 12 },
      (_, i) =>
        `<rect class="ui-pixel" x="${-125 + i * 90}" y="1638" width="60" height="60" style="opacity:0.15;animation-duration:650ms;animation-delay:${-i * 90}ms"/>`,
    ).join("") +
    `</g>` +
    `<g data-part="figure">` +
    composeRunningBodySvg(id) +
    peepsLayers(config, false) +
    `</g></svg>`
  );
}

/** Render a bot avatar from its config as inline SVG. `size` is the square px edge. */
export function BotAvatar({
  config,
  size = 40,
  style,
  title,
}: {
  config: AvatarConfig;
  size?: number;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      role="img"
      aria-label={title ?? "bot avatar"}
      style={{ display: "block", width: size, height: size, lineHeight: 0, ...style }}
      // The widget markup is vendored, static, build-time content (no user input), composed into
      // one SVG string. Inline SVG via innerHTML is how the source renders layered peeps too.
      dangerouslySetInnerHTML={{ __html: composeAvatarSvg(config) }}
    />
  );
}

/**
 * Sunglasses overlay for the selected rail bot — the "Wayfarer" accessory from Open Peeps
 * (react-peeps, CC0). It's authored in the same head coordinate space as the face widgets, so it
 * lands on the eyes at a fixed offset from the face group: in react-peeps the face sits at
 * translate(159,186) and the accessory at translate(47,241) — a (−112,+55) delta. Our composer
 * puts the face at (320,250), so the shades go at (208,305). Rendered as its own transparent SVG
 * sharing the avatar's 700×700 viewBox so it can be layered (and animated) over the composed peep.
 */
const SHADES_WAYFARER_PATH =
  "M379.584 5.44083C374.676 5.04763 361.281 0 337.809 0C322.496 0 301.24 4.68927 287.629 10.9038L286.824 11.2693C280.634 14.0632 274.177 16.647 267.464 17.7921C259.217 19.2079 251.031 17.4015 243.065 15.3129L241.551 14.9193C233.986 12.9714 226.468 11.3294 218.906 10.3325C214.682 9.34741 210.429 8.59431 206.136 8.01192C195.948 6.61618 185.67 6.17537 175.422 7.14937C165.484 8.10329 155.695 9.87959 146.278 13.2334C145.27 13.5949 144.233 13.9784 143.186 14.3751C138.049 15.8612 131.546 18.0813 126.898 21.3959C121.282 22.0084 114.562 21.4783 110.805 25.3522C104.733 26.5034 20.3682 25.8027 20.3682 25.8027C15.1403 26.8329 3.36676 30.0862 0.814798 35.4948C-0.876527 39.0896 0.134265 42.2626 3.20667 44.6434C7.63936 48.0673 18.1384 43.6483 18.1384 43.6483C23.6002 43.6483 92.0277 41.6027 103.436 39.19C104.866 39.0876 106.301 38.9822 107.739 38.8717C107.875 40.9121 108.43 42.9133 109.51 44.7027C111.973 48.8015 115.85 49.8994 120.051 50.6879L122.009 51.0397C131.215 52.6807 133.537 62.5902 136.45 70.2277L136.691 70.8501C140.724 81.1233 158.225 105.158 188.502 107.742C203.415 109.015 219.665 105.634 231.626 96.4252C234.918 93.8948 237.63 90.9728 239.822 87.6993C246.297 81.2037 249.339 72.4577 251.231 63.3001C252.512 57.0936 253.343 50.7485 253.703 44.4225L253.835 41.8901C255.753 40.155 257.831 39.0595 260.031 38.3958C262.045 37.9841 264.054 37.6818 266.087 37.4549C268.166 37.3625 270.307 37.4318 272.479 37.5091C277.025 37.6698 281.436 38.0142 285.242 39.8347L285.134 40.7543C284.406 47.4288 285.031 54.2635 286.368 60.8299C289.191 74.6055 297.887 86.2132 309.597 93.7653C318.004 99.1835 327.831 102.295 337.771 102.666C343.597 104 350.098 103.497 355.584 102.233C366.509 99.7157 385.73 92.8184 388.42 51.9474C389.927 45.2475 389.786 37.785 389.65 30.6239L389.65 30.622C389.59 27.4213 389.53 24.2818 389.619 21.2975C393.743 16.6273 392.592 9.21687 385.526 6.49569C383.605 5.75264 381.773 5.58193 379.732 5.4514L379.584 5.44083ZM359.696 19.3626C360.724 17.6003 363.403 16.6745 365.173 17.9216C369.215 20.7673 372.149 24.9997 372.344 30.0655C372.544 35.2438 364.537 35.2177 364.338 30.0655L364.321 29.8193C364.135 27.8505 362.654 25.9291 361.133 24.8571L360.964 24.7332C359.306 23.4637 358.565 21.3031 359.696 19.3626ZM218.087 22.7224C213.065 21.6178 210.92 29.3606 215.958 30.4682C219.526 31.2525 222.549 33.0515 224.592 36.0993L224.807 36.4307C227.548 40.7926 234.48 36.7661 231.72 32.376C228.614 27.4357 223.788 23.9755 218.087 22.7224Z";

// Fit the Wayfarer onto the eyes. Measured directly from the vendored art (the react-peeps piece
// offsets don't transfer — the vendored faces were re-scaled from the source):
//  • the Wayfarer path itself is 394 wide, center (196.4, 54.5) — measured from SHADES_WAYFARER_PATH;
//  • the composer maps face-local (fx,fy) → canvas (fx+247, fy+250); the face's eye band centers at
//    face-local ≈ (144, 110), i.e. canvas (391, 360) — where the shades center must land;
//  • SHADES_SCALE = 1 keeps the pair at its native ~394-wide size, which reads "just right" spanning
//    the head at 40px (≈22px of the box). translate = eyeCenter − SCALE·pathCenter.
// To nudge: SHADES_CX/CY move the pair (canvas units, +x right / +y down), SHADES_SCALE resizes it.
const SHADES_SCALE = 1;
const SHADES_CX = 391;
const SHADES_CY = 360;
const SHADES_PATH_CX = 196.4;
const SHADES_PATH_CY = 54.5;
const SHADES_TX = SHADES_CX - SHADES_SCALE * SHADES_PATH_CX;
const SHADES_TY = SHADES_CY - SHADES_SCALE * SHADES_PATH_CY;

/** The sunglasses overlay, sized to the avatar box via its own 700×700 viewBox (matching the
 * composed avatar), positioned on the eyes. Absolutely stacked over the avatar by `.rail-shades`. */
export function AvatarShades({ className }: { className?: string }) {
  return (
    <svg
      {...(className ? { className } : {})}
      viewBox="0 0 700 700"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g transform={`translate(${SHADES_TX}, ${SHADES_TY}) scale(${SHADES_SCALE})`}>
        <path d={SHADES_WAYFARER_PATH} fill="#050505" fillRule="evenodd" />
      </g>
    </svg>
  );
}

/**
 * Render whatever a bot's `avatar` string holds: a config → the SVG avatar; a legacy non-config
 * string (e.g. an emoji) → that text; nothing → `null` so the caller can show its own icon fallback.
 */
export function BotAvatarValue({
  value,
  size = 40,
  title,
}: {
  value: string | null | undefined;
  size?: number;
  title?: string;
}): React.ReactNode {
  const cfg = parseAvatar(value);
  if (cfg) return <BotAvatar config={cfg} size={size} {...(title ? { title } : {})} />;
  if (value && value.trim()) return value;
  return null;
}
