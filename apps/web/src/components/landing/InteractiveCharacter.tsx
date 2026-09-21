"use client";

import { useEffect, useRef } from "react";
import styles from "./InteractiveCharacter.module.css";

export function InteractiveCharacter() {
  const characterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const character = characterRef.current;
    const scene = character?.parentElement;
    if (!character || !scene) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;

    const updateDirection = (x: number, y: number) => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        character.style.setProperty("--character-head-x", `${x * 1.8}px`);
        character.style.setProperty("--character-head-y", `${y * 0.45}px`);
        character.style.setProperty("--character-head-rotation", `${y * -5.5}deg`);
      });
    };

    const resetDirection = () => updateDirection(0, 0);
    const handlePointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches || event.pointerType === "touch") return;

      const bounds = scene.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
      const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
      updateDirection(x, y);
    };

    const handleMotionPreference = () => {
      if (reducedMotion.matches) resetDirection();
    };

    scene.addEventListener("pointermove", handlePointerMove, { passive: true });
    scene.addEventListener("pointerleave", resetDirection);
    reducedMotion.addEventListener("change", handleMotionPreference);

    return () => {
      cancelAnimationFrame(animationFrame);
      scene.removeEventListener("pointermove", handlePointerMove);
      scene.removeEventListener("pointerleave", resetDirection);
      reducedMotion.removeEventListener("change", handleMotionPreference);
    };
  }, []);

  return (
    <div ref={characterRef} className={styles.character} aria-hidden="true">
      <svg className={styles.artwork} viewBox="0 0 200 288" role="presentation">
        <defs>
          <mask
            id="character-body-mask"
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="200"
            height="288"
          >
            <rect width="200" height="288" fill="white" />
            <path
              fill="black"
              d="M58 0H200V140L174 145 156 151 148 174 140 181 122 181 112 163 94 158 78 151 64 135 58 120Z"
            />
          </mask>
          <clipPath id="character-head-clip" clipPathUnits="userSpaceOnUse">
            <path d="M54 0H200V142L176 148 160 154 152 176 146 190 118 190 104 168 88 162 72 154 58 136 54 118Z" />
          </clipPath>
          <clipPath id="character-collar-clip" clipPathUnits="userSpaceOnUse">
            <path d="M127 155 151 150 161 163 157 183 146 198 136 192 140 176 132 165Z" />
          </clipPath>
        </defs>

        <path
          className={styles.neckJoint}
          d="M111 143C119 147 127 156 132 166 138 171 143 178 146 185L135 194C128 184 119 176 112 167 108 157 108 149 111 143Z"
        />

        <image
          href="/seated-character.svg"
          width="200"
          height="288"
          preserveAspectRatio="none"
          mask="url(#character-body-mask)"
        />

        <g className={styles.head} clipPath="url(#character-head-clip)">
          <image href="/seated-character.svg" width="200" height="288" preserveAspectRatio="none" />
        </g>

        <image
          href="/seated-character.svg"
          width="200"
          height="288"
          preserveAspectRatio="none"
          clipPath="url(#character-collar-clip)"
        />
      </svg>
    </div>
  );
}
