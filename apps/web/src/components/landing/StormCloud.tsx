"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { createCloudLightning } from "./cloudLightning";
import styles from "./StormCloud.module.css";

export function StormCloud({ className }: { className: string }) {
  const host = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const effect = useRef<ReturnType<typeof createCloudLightning> | null>(null);
  useEffect(() => {
    if (!canvas.current || !host.current) return;
    try {
      effect.current = createCloudLightning(canvas.current, host.current);
    } catch {
      return;
    } // The original SVG remains usable without GPU support.
    return () => {
      effect.current?.dispose();
      effect.current = null;
    };
  }, []);
  return (
    <button
      ref={host}
      type="button"
      className={`${className} ${styles.cloud}`}
      aria-label="Illuminate the storm cloud"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") effect.current?.trigger();
      }}
      onClick={() => effect.current?.trigger()}
    >
      <Image
        src="/cloud-3.svg"
        alt=""
        width={628}
        height={390}
        sizes="(max-width: 760px) 25vw, 17vw"
        className={styles.artwork}
        priority
        draggable={false}
      />
      <canvas ref={canvas} className={styles.effect} aria-hidden="true" />
    </button>
  );
}
