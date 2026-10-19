/**
 * Pixel-grid loader for long-running work: a 3×3 grid of cells with a wavefront of brightness
 * moving through it. Reads as "busy" at a glance without the spin of `.spinner`, and is the
 * leading mark in `LoadingStatus`. Motion is CSS (`pixel-on` in globals.css); under
 * prefers-reduced-motion the grid holds its dim resting state and the elapsed counter still ticks.
 *
 *  drive — square cells, chevron wavefront sweeping right; the 650ms cycle is shorter than the
 *          sweep so two fronts are always in flight
 *  dots  — same wavefront, round cells
 *  orbit — a single comet lapping the perimeter (the centre cell stays dark)
 */
export type LoaderVariant = "drive" | "dots" | "orbit";

// chevron: delay grows with column and with distance from the middle row → a ">" wavefront
const CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

// orbit: perimeter cells in clockwise order; the centre (index 4) is skipped (null)
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<LoaderVariant, { delays: (number | null)[]; dur: number; round: boolean }> =
  {
    drive: { delays: CHEVRON, dur: 650, round: false },
    dots: { delays: CHEVRON, dur: 650, round: true },
    orbit: { delays: ORBIT, dur: 950, round: false },
  };

export function Loader({
  variant = "drive",
  /** cell edge in px; the grid is 3 cells + 2 gaps wide */
  cell = 4,
}: {
  variant?: LoaderVariant;
  cell?: number;
}) {
  const { delays, dur, round } = PATTERNS[variant];
  const gap = Math.max(1, Math.round(cell * 0.375));
  return (
    <span
      aria-hidden
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(3, ${cell}px)`,
        gap,
        flexShrink: 0,
      }}
    >
      {delays.map((delay, i) => (
        <span
          key={i}
          className={delay === null ? undefined : "ui-pixel"}
          style={{
            width: cell,
            height: cell,
            background: "var(--ink)",
            borderRadius: round ? 999 : 1,
            // resting dimness; the keyframe brightens it. Centre cell of `orbit` is darker still.
            opacity: delay === null ? 0.07 : 0.15,
            animationDuration: delay === null ? undefined : `${dur}ms`,
            animationDelay: delay === null ? undefined : `${delay}ms`,
          }}
        />
      ))}
    </span>
  );
}
