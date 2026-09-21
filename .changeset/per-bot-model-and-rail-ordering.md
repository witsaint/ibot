---
"@i-bot/types": minor
"@i-bot/db": minor
---

Per-bot model + left-rail ordering (drag-to-reorder & pin-to-top), plus model discovery.

- **types**: new `ModelInfo` (`{ id, displayName }`) — one entry of the provider catalog surfaced to the model picker; `id` is the value written onto a bot's `model`. `Bot` gains `sortOrder` (number, default 0) and `pinned` (boolean, default false): the rail's within-tier order and the pin flag, both persisted.
- **db**: `bots` gains `sort_order integer NOT NULL DEFAULT 0` and `pinned boolean NOT NULL DEFAULT false`. Migration `0005` adds the two columns. The bot list orders `[pinned DESC, sortOrder ASC, updatedAt DESC]` — pinned first, then the persisted drag order, with most-recently-updated as a stable tiebreaker before any reorder.
