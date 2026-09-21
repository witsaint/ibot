---
"@i-bot/types": minor
"@i-bot/db": minor
---

Conversation content model: the persistence + validation shapes behind the chat layer.

- **types**: `Conversation`, `Message`, and `Attachment` domain models plus `MessagePart` (one element of the AI SDK `UIMessage.parts` union) and `MessageRole`. Parts are stored verbatim — the lossy model-input transcode happens only at `convertToModelMessages()` time, never in storage; binary payloads live in R2 and are referenced (URL/key) from parts, never inlined. Adds `ai` as a dependency for the `UIMessage` part types.
- **db**: `conversations`, `messages`, and `attachments` tables (with the `message_role` enum) owned by Drizzle — Mastra never creates tables. Tenant isolation runs `message → conversation → bot → owner`. Promotes `@i-bot/types` to a runtime dependency (the schema references shared types).
