---
"@i-bot/types": minor
---

Add the `A2uiMessage` contract — a structural zod guard (`{ version: string, ... }`
passthrough) for a single A2UI protocol (https://a2ui.org) envelope. The bot's agent emits
these via the new `render_ui` tool to render generative UI; they ride the UI Message Stream
as tool output and are stored verbatim, then fed to the `@a2ui/web_core` renderer client-side
(the authority on the full v0.9 schema). Kept loose on purpose, matching `MessagePart` — the
renderer validates deeply against the component catalog.
