---
"@i-bot/core": minor
"@i-bot/types": minor
"@i-bot/db": minor
"@i-bot/api": patch
---

Let each bot choose its sandbox egress channel (internal vs public) at create time, instead of a
fleet-wide `SANDBOX_PUBLIC` env switch only.

- **Per-bot toggle** (`@i-bot/db`, `@i-bot/types`): new nullable `bots.sandbox_public` column
  (migration `0006`). `true` = public egress (clean IP, runtime `sandbox.ppio.cn`), `false` =
  internal (gateway proxy), `null` = inherit the fleet default (`SANDBOX_PUBLIC`), resolved at
  box-create time. The env switch is demoted to the default a new bot's checkbox initialises to.

- **Channel pinned to the box** (`@i-bot/core`): the slug a box is created on is stamped into
  `providerMeta.channelSlug` and every later connect/timeout/delete routes back to it — a box lives
  on one upstream backend, so reconnecting through a different channel 502s. Changing a bot's toggle
  only affects its NEXT box build; an existing box stays on its channel. Rows created before this
  (no `channelSlug` in meta) fall back to the env-default URL, which is where they were created.

- **Config API** (`@i-bot/core`): `sdkConnectionOpts(slug?)` rebuilds the control-plane URL from the
  raw base for an explicit channel (env-default apiUrl when omitted); new `channelSlugFor(pref)`
  resolves a bot's `true`/`false`/`null` preference to a concrete slug; new `defaultPublic` flag +
  exported `slugFromUrl` helper. `GET /api/me` now returns `sandboxPublicDefault` so the create-bot
  form's "公网出口" checkbox seeds from the fleet default.
