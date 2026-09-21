---
"@i-bot/core": minor
"@i-bot/api": patch
---

Add a one-flag switch to the public egress channel, and self-heal sandbox rows stranded
mid-provision.

- **`SANDBOX_PUBLIC` toggle** (`@i-bot/core`): set `SANDBOX_PUBLIC=true` to route through the
  public egress channel (clean IP, runtime `sandbox.ppio.cn`) without rewriting the whole
  control-plane URL — it swaps only the `/c/{slug}` segment to `SANDBOX_PUBLIC_SLUG`
  (default `ppio-sandbox-public`). Slug ≠ runtime domain, but the runtime domain is discovered at
  connect time, so the slug swap is all that's needed. New `withChannelSlug(url, slug)` helper +
  config tests. Unset/falsy leaves the URL untouched (internal channel as before).

- **Orphan-row self-heal** (`@i-bot/api`): a `sandboxes` row left in `create`/`resume` by a process
  that died mid-provision (deploy, crash, the just-fixed hang) was never picked back up —
  `rearmActive` only re-armed `active` rows and `getView`'s auto-revive only fired on `active` rows,
  so the desktop never finished building and the UI spun on "provisioning" forever. `getView` now
  re-kicks a stranded row on the next poll, and `rearmActive` sweeps them on boot. Idempotent:
  no-op when the box is warm or an op is already in flight; routes to fresh provision when there's
  no persisted box, or recover (reconnect same box, content intact) when there is.
