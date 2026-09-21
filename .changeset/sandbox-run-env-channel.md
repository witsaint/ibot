---
"@i-bot/core": minor
---

`SandboxHandle.run` gains an optional `env` (`Record<string, string>`), forwarded to the box
over envd's dedicated `envs` channel — the same mechanism `screenshot()` already uses for
DISPLAY. Values enter the process environment directly instead of being interpolated into the
command string, so an injected value never appears in the command text, `ps`, or shell history.

This is the transport for `{{secrets.NAME}}`: a resolved secret is passed as `env` rather than
spliced into the command, keeping the plaintext out of logs. Purely additive — omitting `env`
preserves the previous call shape exactly (no `envs` key sent).
