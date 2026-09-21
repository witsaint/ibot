---
"@i-bot/types": minor
"@i-bot/db": minor
---

Model concurrent agent runs: a bot can now have one foreground chat turn AND several detached
tasks in flight at once, instead of a single shared run slot.

- `agentJobs` gains `kind` (`background` | `subagent`), `needsDesktop` (GUI runs contend for the
  one desktop; pure-shell runs don't), `result` (a subagent's final answer, relayed into the
  conversation on settle), and a self-referencing `parentJobId` (task lineage; nesting reserved
  for later). The `agent_jobs_one_running_per_bot` partial unique index is dropped — many running
  rows per bot is now the point. Migration `0003` is additive plus that one index drop.
- `@i-bot/types` adds `AgentJobKind`, extends `AgentJob`, and adds the `ConversationEvent` union
  (the per-conversation SSE stream: `task.started/done/error`, `run.state`, `message.ready`) and
  the `RunCommand` tool payload.

Resource safety moves from the DB unique index to in-process arbitration: an exclusive GUI lease
(only desktop runs serialize on the single `:0`/Chrome) plus a per-bot task cap.
