---
"@i-bot/templates": minor
---

Record a human desktop session and distil it into a skill.

The existing "record → experience" path reads the bot's own tool trace from the DB. A person
taking control of the desktop through noVNC leaves no such trace — their clicks and keystrokes go
straight to the X server — so nothing could be learned from what they did. Now it can:

- **On the box**: `/opt/ibot-recorder.sh` (written at provision, never auto-started) samples the
  display while it runs — pointer position + active window title (xdotool) and a coarse screen-change
  hash (scrot thumbnail) — writing one full-res PNG + one JSON event per change, plus a keyframe every
  5s. The box has no xinput/ffmpeg; this uses only what's already installed and costs ~0.3 CPU-s per
  tick on a still desktop. `start|stop|status` are shell sub-commands driven by the API.
- **API** (`/skills/recording/:botId/…`, in `@i-bot/api`): start/stop/status/discard shell the
  recorder through the live sandbox handle; `analyze` pulls the events back, picks the informative
  frames (window switches, screen changes, evenly-thinned keyframes; ≤12), transcodes them to 640px
  JPEGs _in the box_ (~18KB each vs ~80KB PNG), and asks the OWNER's vision model for the same
  `SkillDraft` shape the conversation distiller produces. Literal credentials seen on screen must
  come back as `{{secrets.NAME}}`; the review dialog remains the gate before anything is stored.
- **Web**: a "录制技能" button next to "Release control" while a person holds the desktop; it
  becomes "停止录制 · 0:12" with a live counter. Stop _is_ analyze. Releasing control mid-recording
  also stops and analyzes. The result opens the same `SkillReviewDialog` the chat uses (now a shared
  component), and a saved skill appears in the composer's "+" menu without a reload.

Verified end to end on a live public-channel box: a 14s session (terminal commands, then a window
switch to Chrome) → 8 frames → the model produced a correct, generalised playbook with the typed
commands as `{placeholders}` and the window switch as a step.
