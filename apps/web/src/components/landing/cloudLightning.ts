import * as THREE from "three";
import { cloudLightningFragment } from "./cloudLightningShader";

// Art coordinates include 15% breathing room around the existing SVG.
const WIDTH = 768;
const HEIGHT = 477;
const DURATION = 1250;
const COOLDOWN = 1800;
type Point = { x: number; y: number };

function surface() {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  return { canvas, ctx };
}

function cloudMask(image: HTMLImageElement) {
  const { canvas, ctx } = surface();
  ctx.drawImage(image, WIDTH * 0.11538, HEIGHT * 0.11538, WIDTH / 1.3, HEIGHT / 1.3);
  const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const blocked = new Uint8Array(WIDTH * HEIGHT);
  // Close tiny gaps in the hand-drawn contour for background flood fill.
  for (let y = 2; y < HEIGHT - 2; y++)
    for (let x = 2; x < WIDTH - 2; x++) {
      const i = y * WIDTH + x;
      if (pixels.data[i * 4 + 3]! < 30) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) blocked[i + dy * WIDTH + dx] = 1;
    }
  const outside = new Uint8Array(WIDTH * HEIGHT);
  const queue = new Int32Array(WIDTH * HEIGHT);
  let head = 0,
    tail = 1;
  queue[0] = 0;
  outside[0] = 1;
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % WIDTH;
    for (const j of [x > 0 ? i - 1 : -1, x < WIDTH - 1 ? i + 1 : -1, i - WIDTH, i + WIDTH]) {
      if (j < 0 || j >= outside.length || outside[j] || blocked[j]) continue;
      outside[j] = 1;
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < outside.length; i++) {
    const ink = pixels.data[i * 4 + 3]!;
    pixels.data[i * 4] = outside[i] ? 0 : 255;
    pixels.data[i * 4 + 1] = ink;
    pixels.data[i * 4 + 2] = 0;
    pixels.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function bolts(front: CanvasRenderingContext2D, back: CanvasRenderingContext2D) {
  front.clearRect(0, 0, WIDTH, HEIGHT);
  back.clearRect(0, 0, WIDTH, HEIGHT);
  const phase = Math.random() * Math.PI * 2;
  const points: Point[] = [];
  for (let i = 0; i < 97; i++) {
    const t = i / 96;
    points.push({
      x: WIDTH * (0.16 + t * 0.68),
      y: HEIGHT * (0.47 + Math.sin(t * Math.PI * 3 + phase) * 0.16 + (Math.random() - 0.5) * 0.038),
    });
  }
  const stroke = (ctx: CanvasRenderingContext2D, a: Point, b: Point, width: number) => {
    for (const [blur, alpha, line] of [
      [22, 0.18, width * 5],
      [7, 0.52, width * 2],
      [1, 1, width],
    ]) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = line!;
      ctx.lineCap = "round";
      ctx.shadowBlur = blur!;
      ctx.shadowColor = "rgb(156,191,255)";
      ctx.strokeStyle = `rgba(238,247,255,${alpha})`;
      ctx.stroke();
    }
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const ctx = Math.sin(i * 0.085 + phase) > 0.25 ? front : back;
    stroke(ctx, a, b, 1.5);
    if (i % 8 === 0) {
      let p = b;
      const direction = Math.random() > 0.5 ? 1 : -1;
      for (let j = 0; j < 9; j++) {
        const q = {
          x: p.x + (Math.random() - 0.45) * 18,
          y: p.y + direction * (3 + Math.random() * 6),
        };
        stroke(ctx, p, q, 0.85 * (1 - j / 11));
        p = q;
      }
    }
  }
  return [points[25]!, points[50]!, points[73]!].map(
    (p, i) => new THREE.Vector3(p.x / WIDTH, 1 - p.y / HEIGHT, i === 1 ? 0.3 : -0.22),
  );
}

export function createCloudLightning(canvas: HTMLCanvasElement, host: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0, 0);
  const front = surface(),
    back = surface();
  const frontTexture = new THREE.CanvasTexture(front.canvas),
    backTexture = new THREE.CanvasTexture(back.canvas);
  const blank = surface();
  const cloudTexture = new THREE.CanvasTexture(blank.canvas);
  const tint = getComputedStyle(host).getPropertyValue("--cloud-light-tint").trim();
  const uniforms = {
    uCloud: { value: cloudTexture },
    uFront: { value: frontTexture },
    uBack: { value: backTexture },
    uPower: { value: 0 },
    uAge: { value: 0 },
    uSeed: { value: 0 },
    uLights: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uTint: { value: new THREE.Color(tint || "#abc7ec") },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: "varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,1.0);}",
    fragmentShader: cloudLightningFragment,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.Camera();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0,
    start = -Infinity,
    ready = false,
    disposed = false,
    visible = true,
    contextLost = false;
  const render = () => {
    if (!disposed && !contextLost) renderer.render(scene, camera);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    uniforms.uPower.value = 0;
    render();
  };
  const animate = (now: number) => {
    const age = (now - start) / 1000;
    if (disposed || document.hidden || !visible || now - start >= DURATION) {
      stop();
      return;
    }
    uniforms.uAge.value = age;
    // One smooth discharge with a soft shoulder; no rapid strobing.
    uniforms.uPower.value =
      Math.min(age / 0.085, 1) *
      Math.exp(-Math.max(0, age - 0.19) * 3.6) *
      (reduced.matches ? 0.3 : 1);
    render();
    frame = requestAnimationFrame(animate);
  };
  const trigger = () => {
    const now = performance.now();
    if (!ready || disposed || contextLost || !visible || document.hidden || now - start < COOLDOWN)
      return;
    uniforms.uLights.value = bolts(front.ctx, back.ctx);
    // Reduced motion uses local cloud illumination only, with no electric filaments.
    if (reduced.matches) {
      front.ctx.clearRect(0, 0, WIDTH, HEIGHT);
      back.ctx.clearRect(0, 0, WIDTH, HEIGHT);
    }
    frontTexture.needsUpdate = backTexture.needsUpdate = true;
    uniforms.uSeed.value = Math.random() * 100;
    start = now;
    frame = requestAnimationFrame(animate);
  };
  const image = new Image();
  image.onload = () => {
    if (disposed) return;
    cloudTexture.image = cloudMask(image);
    cloudTexture.needsUpdate = true;
    ready = true;
  };
  image.src = "/cloud-3.svg";
  const resize = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    render();
  });
  resize.observe(host);
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (!visible) stop();
  });
  visibility.observe(host);
  const onVisibility = () => {
    if (document.hidden) stop();
  };
  document.addEventListener("visibilitychange", onVisibility);
  reduced.addEventListener("change", stop);
  const onContextLost = () => {
    contextLost = true;
    stop();
  };
  const onContextRestored = () => {
    contextLost = false;
    render();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  return {
    trigger,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      image.onload = null;
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", stop);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      frontTexture.dispose();
      backTexture.dispose();
      cloudTexture.dispose();
      material.dispose();
      geometry.dispose();
      renderer.dispose();
    },
  };
}
