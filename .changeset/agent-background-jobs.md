---
"@i-bot/db": minor
"@i-bot/types": minor
---

Add `agent_jobs` — the lifecycle row for human-initiated background agent turns. A job
records its bot, conversation, originating instruction, and status (`running` → `done` /
`error` / `canceled`) with timings; the assistant output it produces still lands in
`messages` like any turn. A partial unique index (`WHERE status = 'running'`) enforces at
most one running job per bot — the DB backstop for single-flight (a bot runs one turn at a
time, foreground and background sharing the slot). `@i-bot/types` gains the matching
`AgentJob` / `AgentJobStatus` contract.
