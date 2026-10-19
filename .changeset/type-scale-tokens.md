---
"@i-bot/config": patch
---

Add a type-scale to the tokens: `--text-body: 13px`, `--text-label: 12.5px`, `--text-caption: 12px`.

The chat's reading size was `13.5px`, hardcoded in seven places across `globals.css` (prose, prose
h4, the A2UI card bridge, the A2UI panel body and headings) and `ChatPanel` (user bubble, composer).
Those all now read `var(--text-body)`, which drops the size to 13px in one move and means A2UI card
text and surrounding prose can no longer drift apart. The three tokens are bridged into Tailwind's
`@theme inline` alongside the fonts.
