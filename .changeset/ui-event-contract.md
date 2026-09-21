---
"@i-bot/types": minor
---

Add the `UiEventData` contract — the send/receive counterpart to `A2uiMessage` for A2UI panel
interactions (a button click / form submit carried back to the agent). Exports `UiEventData`
(the `{surfaceId, name, context, label?}` payload), the `UI_EVENT_PART_TYPE` constant
(`"data-uiEvent"`), and `uiEventInstruction()` which builds the clean natural-language line the
model reads. A panel interaction now rides as a plain `text` part (the only thing
`convertToModelMessages` forwards to the model) plus a `data-uiEvent` part the chat renders as a
compact chip — so the raw action name + JSON no longer leaks into the visible transcript. The
data part is structural-only (no deep `dataSchemas`), so it persists and reloads as-is.
