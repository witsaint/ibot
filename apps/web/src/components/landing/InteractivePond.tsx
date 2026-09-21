"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import styles from "./InteractivePond.module.css";

// Traced inside the existing pond rim in ground-tiles.svg (628 × 141).
// The same path clips the canvas and determines pointer hit testing.
const OUTLINE =
  "M0 .52C.025 .25 .14 .12 .29 .10C.42 .02 .55 .05 .66 .07C.78 .09 .80 .21 .89 .25C.96 .29 1 .37 .99 .52C.99 .71 .90 .81 .77 .84C.69 .92 .61 .96 .49 .94C.37 .99 .32 .85 .26 .82C.16 .79 .075 .81 .025 .68Z";
const WAVE_COUNT = 12;

const fragmentShader = `
  varying vec2 vUv;
  uniform sampler2D uSurface;
  uniform float uTime;
  uniform vec3 uWaves[12];
  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    vec2 offset = vec2(0.0);
    float light = 0.0;
    for (int i = 0; i < 12; i++) {
      float age = uTime - uWaves[i].z;
      if (age >= 0.0 && age < 2.4) {
        vec2 delta = uv - uWaves[i].xy;
        delta.x *= 2.5;
        float radius = length(delta);
        float ring = radius - age * .55;
        float envelope = exp(-ring * ring * 95.0) * exp(-age * 1.7);
        float wave = sin(ring * 40.0) * envelope;
        offset += delta / max(radius, .025) * wave * vec2(.014, .065);
        light += wave * .04;
      }
    }
    float edge = smoothstep(0.0, .13, uv.y) * smoothstep(0.0, .13, 1.0-uv.y);
    vec2 sampleUv = clamp(uv + offset * edge, .002, .998);
    vec4 surface = texture2D(uSurface, vec2(sampleUv.x, 1.0-sampleUv.y));
    gl_FragColor = vec4(surface.rgb + light * edge, surface.a);
  }
`;

export function InteractivePond() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const pond = canvas?.parentElement;
    const sceneElement = pond?.parentElement;
    if (!canvas || !pond || !sceneElement) return;

    const lamp = sceneElement.querySelector<HTMLButtonElement>("button[aria-pressed]");
    const source = document.createElement("canvas");
    source.width = 1024;
    source.height = 160;
    const context = source.getContext("2d");
    if (!context) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
      });
    } catch {
      // Keep the original SVG pond visible if WebGL is unavailable.
      return;
    }

    const texture = new THREE.CanvasTexture(source);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const waves = Array.from({ length: WAVE_COUNT }, () => new THREE.Vector3(0, 0, -100));
    const uniforms = {
      uSurface: { value: texture },
      uTime: { value: 0 },
      uWaves: { value: waves },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position,1.0);}",
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));
    const camera = new THREE.Camera();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const lampImage = new window.Image();
    const cloudImage = new window.Image();
    let disposed = false;
    let frame = 0;
    let waveIndex = 0;
    let lastWave = -10;
    let lastPointer = { x: -10, y: -10 };
    const render = () => renderer.render(scene, camera);

    const paintSurface = () => {
      if (disposed) return;
      const { width, height, left } = pond.getBoundingClientRect();
      if (!width || !height) return;
      const bg = getComputedStyle(sceneElement).getPropertyValue("--landing-bg").trim() || "white";
      context.clearRect(0, 0, 1024, 160);
      context.fillStyle = bg;
      context.fillRect(0, 0, 1024, 160);
      const shade = context.createLinearGradient(0, 0, 0, 160);
      shade.addColorStop(0, "rgba(70,73,70,.11)");
      shade.addColorStop(0.6, "rgba(70,73,70,.055)");
      shade.addColorStop(1, "rgba(70,73,70,.025)");
      context.fillStyle = shade;
      context.fillRect(0, 0, 1024, 160);
      if (cloudImage.complete && cloudImage.naturalWidth) {
        context.save();
        context.globalAlpha = 0.065;
        context.translate(620, 115);
        context.scale(1, -1);
        context.drawImage(cloudImage, -190, 0, 380, 115);
        context.restore();
      }
      if (lamp && lampImage.complete && lampImage.naturalWidth) {
        const bounds = lamp.getBoundingClientRect();
        const x = ((bounds.left - left) / width) * 1024;
        const w = (bounds.width / width) * 1024;
        context.save();
        context.globalAlpha = 0.3;
        context.translate(x, 148);
        context.scale(1, -1);
        context.drawImage(lampImage, 0, 0, w, 150);
        context.restore();
        if (lamp.getAttribute("aria-pressed") === "true") {
          const cx = x + w * 0.49;
          const glow = context.createRadialGradient(cx, 117, 0, cx, 117, 42);
          glow.addColorStop(0, "rgba(221,198,132,.40)");
          glow.addColorStop(1, "rgba(221,198,132,0)");
          context.fillStyle = glow;
          context.fillRect(cx - 42, 75, 84, 84);
        }
      }
      // Short, low-contrast pencil-like strokes provide detail for the displacement.
      context.strokeStyle = "rgba(70,73,70,.055)";
      context.lineWidth = 0.7;
      for (let i = 0; i < 32; i++) {
        const x = (i * 173) % 1024;
        const y = 10 + ((i * 37) % 140);
        context.beginPath();
        context.moveTo(x, y);
        context.quadraticCurveTo(x + 18, y - 1.5, x + 35 + (i % 17), y);
        context.stroke();
      }
      texture.needsUpdate = true;
      render();
    };
    const resize = () => {
      const { width, height } = pond.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(Math.max(1, width), Math.max(1, height), false);
      paintSurface();
    };
    const animate = (now: number) => {
      uniforms.uTime.value = now / 1000;
      render();
      if (now / 1000 - lastWave < 2.4) frame = requestAnimationFrame(animate);
      else frame = 0;
    };
    const hitContext = document.createElement("canvas").getContext("2d");
    const outline = new Path2D(OUTLINE);
    const interact = (event: PointerEvent) => {
      if (reducedMotion.matches) return;
      const rect = pond.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (!hitContext?.isPointInPath(outline, x, y)) return;
      const now = performance.now() / 1000;
      if (
        event.type === "pointermove" &&
        (now - lastWave < 0.035 || Math.hypot(x - lastPointer.x, y - lastPointer.y) < 0.035)
      )
        return;
      waves[waveIndex]!.set(x, y, now);
      waveIndex = (waveIndex + 1) % WAVE_COUNT;
      lastWave = now;
      lastPointer = { x, y };
      if (!frame) frame = requestAnimationFrame(animate);
    };
    lampImage.onload = paintSurface;
    cloudImage.onload = paintSurface;
    lampImage.src = "/streetlamp-off.svg";
    cloudImage.src = "/cloud-1.svg";
    const observer = new ResizeObserver(resize);
    observer.observe(sceneElement);
    const lampObserver = new MutationObserver(paintSurface);
    if (lamp) lampObserver.observe(lamp, { attributes: true, attributeFilter: ["aria-pressed"] });
    pond.addEventListener("pointermove", interact, { passive: true });
    pond.addEventListener("pointerdown", interact, { passive: true });
    resize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      lampObserver.disconnect();
      pond.removeEventListener("pointermove", interact);
      pond.removeEventListener("pointerdown", interact);
      texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <>
      <svg className={styles.definitions} aria-hidden="true">
        <defs>
          <clipPath id="landing-pond-clip" clipPathUnits="objectBoundingBox">
            <path d={OUTLINE} />
          </clipPath>
        </defs>
      </svg>
      <div className={styles.pond} aria-hidden="true">
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
    </>
  );
}
