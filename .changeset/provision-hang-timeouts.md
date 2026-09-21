---
"@i-bot/core": patch
"@i-bot/api": patch
---

Fix the "stuck on 'provisioning' for hours, never errors" hang. A sandbox provision could wedge
forever with the row left on `create`: the SDK's `commands.run({ timeoutMs })` bounds the in-box
process, not the client transport, so a silently-severed gateway↔envd stream left create/connect/
probe/provision awaits unsettled — which meant the caller's catch (that flips the row to `kill`)
never ran, and the `#provisioning` dedupe gate keyed on that never-settling promise never cleared,
turning every later status poll and Restart into a no-op until the API process was restarted.

- **`withTimeout` / `TimeoutError`** (new, `@i-bot/core`): race an await against a real wall clock
  so a dead transport surfaces as a throw instead of an unbounded hang.
- **Provider awaits bounded**: `Sandbox.create` (120s), `Sandbox.connect` (60s), `getInfo` (30s),
  and the runtime `probe` (30s) are now wrapped — a hung control-plane/runtime call throws and the
  row goes `kill`, so the UI shows a failure the user can Restart from.
- **`provisionDesktop` wall-clock backstop**: the whole step/readiness flow is raced against
  `totalTimeoutMs` (the prior `now() > deadline` check only ran _between_ steps, so a hung
  `target.run` bypassed it). A timeout normalises to `ProvisionError("timeout", …)`.
- **Dedupe-gate self-heal** (`@i-bot/api`): the promise stored in `#provisioning` (both provision
  and recover) is bounded by `PROVISION_GATE_TIMEOUT_MS` (15 min), so the gate always clears and
  the bot can never be permanently wedged even if some future unbounded await slips in.
