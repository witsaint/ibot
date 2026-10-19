---
"@i-bot/web": patch
---

Stop the bot edit dialog from silently downgrading a bot's sandbox, and say what the channel choice
actually costs.

`sandboxPublic` has three meaningful states — `true` (public), `false` (internal), `null` (follow the
fleet default) — and the dialog collapsed them into a checkbox seeded with `bot?.sandboxPublic ?? false`.
Every bot in the fleet is `null`, so opening a bot to rename it and pressing Save wrote an explicit
`false`, pinning it to the internal channel. That used to be a difference in egress IP only. It isn't
any more: the internal channel carries only the small `e2b/base` image (2 vCPU / 1 GB, node v20.9.0),
so a pinned bot loses ~7 GB of RAM and can no longer host a dev server at all — modern Vite needs node
`^20.19 || >=22.12` and dies at import on 20.9. A rename should not do that.

The checkbox is now a three-option select (`跟随默认` / `公网` / `内网`) whose `null` really stays
`null`, and the fleet default is fetched for display only — it labels the inherit option with what it
currently resolves to instead of being written into the bot as a choice the user never made. The copy
now states the real trade (spec + node version + egress), because "公网出口 (clean IP)" gave no way to
know that turning it off breaks page development.
