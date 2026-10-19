/**
 * Record → skill, for a HUMAN driving the desktop.
 *
 * The conversation distiller (`distill.ts`) reads the bot's own tool trace, which is already in the
 * DB. A person taking control through noVNC leaves no such trace — their clicks and keystrokes go
 * straight to the X server. So this module records the session on the box and distils the frames.
 *
 * On the box, `/opt/ibot-recorder.sh` (written at provision) samples the display while it runs:
 * pointer position + active window title (xdotool) and a coarse screen-change hash, writing one
 * full-res PNG + one JSON event line per change, plus a keyframe every 5s. Start/stop are just shell
 * calls through the sandbox handle, so nothing here runs unless someone presses Record.
 *
 * Distillation: pull the events + frames back, downscale frames to ~640px JPEG (the model needs to
 * read the screen, not admire it; 8 full-res PNGs would be 700KB of base64), pick the most
 * informative ones (window switches, screen changes, evenly spaced keyframes — capped), and ask the
 * OWNER'S vision-capable model for the same `SkillDraft` shape the conversation distiller produces.
 * The human review dialog is the safety gate: literal credentials seen on screen must come out as
 * `{{secrets.NAME}}`, and the reviewer confirms before anything is stored.
 *
 * No DB writes here — this module talks to the box and to a model; persistence is the route's job.
 */
import type { SandboxHandle } from "@i-bot/core";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { type DistilledDraft, DraftSchema } from "./distill.js";

/** Where the recorder keeps a session on the box. One recording per box at a time. */
export const RECORDING_DIR = "/tmp/ibot-rec";
const RECORDER = "/opt/ibot-recorder.sh";

/** One line of `events.jsonl`, as the recorder writes it. */
const RecordedEvent = z.object({
  n: z.number().int(),
  /** ms since recording start */
  t: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  /** active window title at the time */
  win: z.string(),
  screen: z.number().int(),
  moved: z.number().int(),
  winChanged: z.number().int(),
  key: z.number().int().optional(),
});
export type RecordedEvent = z.infer<typeof RecordedEvent>;

export interface RecordingStatus {
  recording: boolean;
  frames: number;
}

/** Start sampling. Idempotent: a second start while recording restarts the session (fresh dir). */
export async function startRecording(handle: SandboxHandle): Promise<void> {
  // stop any stale loop first so we never have two samplers writing the same dir
  await handle.run(`pkill -f 'ibot-recorder.sh _loop' || true; rm -rf ${RECORDING_DIR}`, {
    timeoutMs: 10_000,
  });
  const res = await handle.run(`${RECORDER} start ${RECORDING_DIR}`, { timeoutMs: 10_000 });
  if (res.exitCode !== 0) {
    throw new Error(`recorder start failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
  }
}

export async function recordingStatus(handle: SandboxHandle): Promise<RecordingStatus> {
  const res = await handle.run(`${RECORDER} status ${RECORDING_DIR}`, { timeoutMs: 10_000 });
  const m = /recording frames=(\d+)/.exec(res.stdout);
  return m ? { recording: true, frames: Number(m[1]) } : { recording: false, frames: 0 };
}

/** Stop sampling. Returns how many frames were captured. Safe to call when not recording. */
export async function stopRecording(handle: SandboxHandle): Promise<{ frames: number }> {
  const res = await handle.run(`${RECORDER} stop ${RECORDING_DIR}`, { timeoutMs: 10_000 });
  const m = /frames=(\d+)/.exec(res.stdout);
  return { frames: m ? Number(m[1]) : 0 };
}

/** A frame chosen for the model: its event + a downscaled JPEG (base64). */
export interface RecordedFrame {
  event: RecordedEvent;
  jpegBase64: string;
}

/** Hard cap on frames sent to the model — enough to see every transition of a few-minute session. */
const MAX_FRAMES = 12;
/** Downscale target. 640px wide is readable for window titles, buttons and form labels. */
const THUMB_W = 640;
const THUMB_H = 400;

/**
 * Pick the frames worth sending: every window switch and every screen change first (those are the
 * moments something happened), then keyframes to cover any long stretch, then thin evenly to the
 * cap while ALWAYS keeping the first and last. Order is preserved.
 */
export function selectFrames(events: RecordedEvent[], cap = MAX_FRAMES): RecordedEvent[] {
  if (events.length <= cap) return events;
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const interesting = events.filter(
    (e) => e !== first && e !== last && (e.winChanged === 1 || e.screen === 1),
  );
  let picked: RecordedEvent[];
  if (interesting.length + 2 <= cap) {
    picked = [first, ...interesting, last];
  } else {
    // too many transitions: thin evenly across the interesting ones
    const step = interesting.length / (cap - 2);
    picked = [first];
    for (let i = 0; i < cap - 2; i++) picked.push(interesting[Math.floor(i * step)]!);
    picked.push(last);
  }
  return picked.sort((a, b) => a.n - b.n);
}

/**
 * Read the session back from the box: parse events, choose frames, and transcode the chosen ones to
 * small JPEGs IN the box (PIL is there; shipping full PNGs to transcode here would move ~10× the
 * bytes). One `run` returns all thumbnails, newline-separated, in event order.
 */
export async function pullRecording(
  handle: SandboxHandle,
): Promise<{ events: RecordedEvent[]; frames: RecordedFrame[]; durationMs: number }> {
  const raw = await handle.run(
    `cat ${RECORDING_DIR}/events.jsonl 2>/dev/null; echo "__META__ $(cat ${RECORDING_DIR}/started_at 2>/dev/null) $(cat ${RECORDING_DIR}/stopped_at 2>/dev/null)"`,
    { timeoutMs: 15_000 },
  );
  const lines = raw.stdout.split("\n").filter(Boolean);
  const meta = lines.find((l) => l.startsWith("__META__")) ?? "";
  const [, startedAt, stoppedAt] = meta.split(" ");
  const durationMs =
    startedAt && stoppedAt ? Math.max(0, Number(stoppedAt) - Number(startedAt)) : 0;
  const events: RecordedEvent[] = [];
  for (const l of lines) {
    if (l.startsWith("__META__")) continue;
    try {
      events.push(RecordedEvent.parse(JSON.parse(l)));
    } catch {
      // a torn line from a kill mid-write — skip it
    }
  }
  if (events.length === 0) return { events, frames: [], durationMs };

  const chosen = selectFrames(events);
  const names = chosen.map((e) => String(e.n).padStart(4, "0")).join(" ");
  // The frame set and output shape are ours; no user input reaches this command.
  const thumbs = await handle.run(
    `cd ${RECORDING_DIR}/frames && python3 -W ignore -c "
import sys, base64, io
from PIL import Image
for n in sys.argv[1:]:
    try:
        im = Image.open(n + '.png').convert('RGB'); im.thumbnail((${THUMB_W}, ${THUMB_H}))
        b = io.BytesIO(); im.save(b, 'JPEG', quality=72); print(base64.b64encode(b.getvalue()).decode())
    except Exception:
        print('')
" ${names}`,
    { timeoutMs: 40_000 },
  );
  const b64s = thumbs.stdout.split("\n");
  const frames: RecordedFrame[] = [];
  chosen.forEach((event, i) => {
    const jpegBase64 = b64s[i] ?? "";
    if (jpegBase64) frames.push({ event, jpegBase64 });
  });
  return { events, frames, durationMs };
}

/** Wipe the session on the box (after a successful distill, or on cancel). */
export async function discardRecording(handle: SandboxHandle): Promise<void> {
  await handle.run(`pkill -f 'ibot-recorder.sh _loop' || true; rm -rf ${RECORDING_DIR}`, {
    timeoutMs: 10_000,
  });
}

const SYSTEM_PROMPT =
  "You are distilling a screen recording of a PERSON operating a Linux desktop (a browser and a terminal) into a reusable skill for a computer-use bot that will later perform the same task on the same kind of desktop.\n" +
  "You see a sequence of screenshots taken whenever something changed, each tagged with the time offset, the active window title, and the pointer position. Between frames the person may have clicked, typed, or scrolled; infer the action from what changed.\n" +
  "Rules:\n" +
  "- Write the playbook as numbered natural-language steps describing INTENT ('open the billing page', 'click Export CSV', 'type the month into the filter'), never raw coordinates or pixel positions.\n" +
  "- Generalize concrete values you can read on screen (a month, a customer name, a search term) into {placeholders} and say what they stand for.\n" +
  "- If a password, token, or API key is visible or was evidently typed, do NOT reproduce it: write {{secrets.NAME}} with a descriptive NAME and list NAME in secretRefs.\n" +
  "- Ignore idle stretches, cursor wandering, and accidental mis-clicks; keep only the steps that advance the task.\n" +
  "- description = when to use this skill (for later matching). name = a short imperative label.\n" +
  "If the recording shows no coherent task, still produce your best-effort draft; a human reviews it.";

/**
 * Distil a pulled recording into a skill draft with the owner's model. The model must accept image
 * input; frames are sent as inline JPEGs interleaved with their event captions so the model reads
 * them as a timeline, not a gallery. Throws `empty_recording` if there is nothing to look at.
 */
export async function distillRecording(
  model: LanguageModel,
  rec: { events: RecordedEvent[]; frames: RecordedFrame[]; durationMs: number },
): Promise<DistilledDraft> {
  if (rec.frames.length === 0) throw new Error("empty_recording");
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const content: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
    {
      type: "text",
      text:
        `Recording: ${secs(rec.durationMs)} long, ${rec.events.length} change events, ${rec.frames.length} frames shown below in order. ` +
        `Window titles seen: ${[...new Set(rec.events.map((e) => e.win))].filter(Boolean).slice(0, 8).join(" | ")}.`,
    },
  ];
  for (const f of rec.frames) {
    const e = f.event;
    const why = [
      e.winChanged === 1 ? "window switched" : null,
      e.screen === 1 ? "screen changed" : null,
      e.moved === 1 ? "pointer moved" : null,
      e.key === 1 ? "keyframe" : null,
    ]
      .filter(Boolean)
      .join(", ");
    content.push({
      type: "text",
      text: `Frame ${e.n} @ ${secs(e.t)} — window: "${e.win}" — pointer (${e.x},${e.y}) — ${why}`,
    });
    content.push({ type: "image", image: `data:image/jpeg;base64,${f.jpegBase64}` });
  }
  const { object } = await generateObject({
    model,
    schema: DraftSchema,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  const referenced = new Set<string>(object.secretRefs ?? []);
  for (const m of object.playbook.matchAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g)) {
    if (m[1]) referenced.add(m[1]);
  }
  return { ...object, secretRefs: [...referenced] };
}
