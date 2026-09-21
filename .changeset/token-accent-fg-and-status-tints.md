---
"@i-bot/config": patch
---

Close the last gaps where a raw hex stood in for a token: add `--accent-fg` and the status tints.

- `--accent-fg` — the text/icon colour ON an accent-filled control. Replaces four literal `#fff`
  (the `.btn-primary` rule, the A2UI `--a2ui-color-on-primary` bridge, and the chat send button /
  image-close button in `ChatPanel`). Kept white in both themes, matching the shipped UI; the dark
  value carries a note that it is ~2.5:1 against the lifted green, so flipping it to dark ink is a
  deliberate contrast decision rather than an incidental one.
- `--ok-soft` / `--warn-soft` / `--danger-soft` — a filled ground for a status surface, so no notice
  banner needs a hardcoded colour. `ChatPanel`'s paused-for-you banner was the offender: it referenced
  `var(--warn-border, #e6c200)` / `var(--warn-bg, #fff8e1)`, neither of which existed anywhere, so it
  fell back to that bright yellow in BOTH themes — off-system in light and glaring on dark. It now uses
  `var(--warn)` for the border and `var(--warn-soft)` for the ground, which flip correctly.

Tokens are bridged into Tailwind via the `@theme inline` block in `globals.css` alongside their
siblings. No visual change in light mode or on any accent-filled control.
