---
"@i-bot/web": patch
---

Chat composer grows with what you type — measured against the panel, not a fixed cap.

- **Two lines now grow on the second line, not the third.** The height was measured inside
  `onChange`, before React re-rendered the open/compact swap that changes the field's padding — so
  the measurement was taken against the old padding and lagged one keystroke behind. The fit now
  runs in a layout effect keyed on the text, the open state and the attachment count, i.e. after
  the padding it measures against has landed, and before paint.
- **The cap is the space the thread can spare, not `160px`.** Field max = panel height − composer
  chrome (control row, attachment chips, paddings) − a 160px floor for the conversation. Growing the
  field shrinks the thread down to that floor and stops; a `ResizeObserver` on the panel re-fits
  when the window changes.
- **No scrollbar while growing.** `overflow-y` is `hidden` until the content exceeds the cap, then
  `auto` — the field only scrolls once it is pinned. (Previously `overflow-y: auto` was always on,
  and the fixed `maxHeight` let a scrollbar appear at 160px regardless of how much room was left.)
- **The open/compact decision can no longer oscillate.** The two layouts give the field different
  widths (compact shares its row with the buttons; open has the row to itself), so "does the text
  wrap right now" was a function of the layout it was deciding: a sentence that wraps in the narrow
  compact field but fits the wide open one flipped compact→open→compact forever ("Maximum update
  depth exceeded"). The decision is now probed at the compact width whichever layout is showing,
  so it is a pure function of the text and one state change always settles. Height fitting is pure
  DOM writes and sets no state, so it cannot feed back either.

Verified in the running app (Playwright, 1280×800): 1 line 28px → 2 lines 48px → 6 lines 129px,
`overflow-y: hidden`, no scrollbar; 60 lines caps at 518px with the thread held at exactly 160px
and only then `overflow-y: auto`; clearing returns to 28px. The former oscillation input (text
just wider than the compact field) opens once, sits on one line at the open width, and is
unchanged 400ms later with no React errors.
