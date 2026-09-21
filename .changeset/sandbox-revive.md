---
"@i-bot/core": minor
---

Add `SandboxGoneError` and raise it from `PpioSandboxProvider.connect()` when the gateway
no longer has the box (its SDK `SandboxNotFoundError` from connect / getInfo / probe). This
gives apps/api a distinct signal to tell "the box was reclaimed at its TTL — must create a
fresh one (content lost)" apart from "the box is alive but its in-box services died — a plain
reconnect revives it with disk/env intact". A transient/unreachable failure stays
`SandboxUnreachableError`, so a merely-slow box is never false-recreated and stripped of its
content.

This is what lets "Restart desktop" reconnect to the SAME kept-alive box (restarting the
desktop stack a crash or the ~24h pause/resume killed) instead of provisioning a brand-new
box and losing the environment.
