"use client";

import { useEffect, useRef } from "react";

/**
 * The animated i-bot mark for the left rail. The source (`public/ibot-animation.svg`) is a SMIL
 * animation — a green→cyan radial sweep with beams — that autoplays and loops indefinitely by
 * default. A permanently-visible rail icon in perpetual motion pulls the eye from the work, so we
 * drive its timeline instead: it sits FROZEN at t=0 and only runs while hovered.
 *
 * Why this works cleanly: at t=0 every animated layer is invisible (the sweep masks are all
 * `opacity=0`, the beams sit off-canvas), while the base logo shapes (`fill=#050505`) carry no
 * animation — so the frozen frame is a clean, complete static mark, not a half-drawn one.
 *
 * We fetch + inline the markup (rather than an <img>, which can't script SMIL, or bundling 351 KB
 * of path data into the JS) so we can call `pauseAnimations`/`unpauseAnimations` on the root SVG —
 * one control point for all 34 animations. Honours `prefers-reduced-motion` (stays frozen).
 */
// The source art loops over 8s — too languid for a hover flourish on a 36px mark. Compress the
// whole timeline to 2s at inline time (every one of the 34 animates shares `dur="8s"`; keyTimes
// are proportional fractions, so retiming is a single duration swap that keeps the sequence intact).
// The source file is left untouched so a slower variant stays available elsewhere.
const HOVER_DURATION = "2s";

/**
 * Inline the fetched markup into `host` and freeze the SVG at its first frame. Returns the root
 * SVG element (for hover control), or null if the fetch was cancelled or the markup had no <svg>.
 */
function mountSvg(host: HTMLElement, markup: string, cancelled: boolean): SVGSVGElement | null {
  if (cancelled) return null;
  host.innerHTML = markup.replaceAll('dur="8s"', `dur="${HOVER_DURATION}"`);
  const svg = host.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) return null;
  // scale the intrinsic 1500×1500 art down to the rail box; the viewBox keeps it framed
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";
  // let hover + click fall through to the wrapping <span>/<Link>
  svg.style.pointerEvents = "none";
  // freeze on the first frame — a still, clean mark until hovered
  svg.setCurrentTime(0);
  svg.pauseAnimations();
  return svg;
}

export function AnimatedLogo({ size = 36 }: { size?: number }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    void fetch("/ibot-animation.svg")
      .then((r) => r.text())
      .then((markup) => {
        svgRef.current = mountSvg(host, markup, cancelled);
        return svgRef.current;
      })
      .catch(() => {
        // never leave the rail blank if the asset can't load — fall back to the static mark
        if (!cancelled) {
          host.innerHTML =
            '<img src="/logo.png" alt="i-bot" style="width:100%;height:100%;object-fit:cover;display:block" />';
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const prefersReducedMotion = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const play = () => {
    const svg = svgRef.current;
    if (!svg || prefersReducedMotion()) return;
    svg.setCurrentTime(0); // replay from the start on every hover
    svg.unpauseAnimations();
  };
  const stop = () => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.pauseAnimations();
    svg.setCurrentTime(0); // back to the clean resting frame
  };

  return (
    <span
      ref={hostRef}
      onMouseEnter={play}
      onMouseLeave={stop}
      style={{
        width: size,
        height: size,
        display: "block",
        borderRadius: 9,
        overflow: "hidden",
      }}
    />
  );
}
