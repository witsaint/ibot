---
"@i-bot/api": patch
---

Stop leaking a keepalive loop every time a bot's sandbox handle is replaced.

A handle owns a live `setInterval` that renews its box's TTL against the control plane. Dropping the
map reference does not stop that timer — only `detach()` does. Two sites installed a handle with a
bare `#handles.set` (the reconnect in `#reconnect`, and the fresh-box create in `#provision`), so
whenever a bot moved to a different box the superseded handle kept renewing one nobody would use
again: once every 5 minutes, for the life of the process. Observed in a dev process that had done two
Restarts in half an hour.

The reason this was easy to misread: the orphan's routing is pinned to the channel its box was
created on, so the spam is not a 404 but `403 sandbox_gateway_ownership_denied`. Verified directly
against the gateway — same API key, same box id, `200` on `ppio-sandbox-public` and `403` on
`ppio-sandbox-internal`, because ownership is scoped per channel and the superseded box was no longer
that channel's. Read from the log alone it looks like a credential or routing fault in the live path;
the live path was fine and the fault was the missing detach.

Both sites now go through one `installHandle(handles, botId, handle)` — the only way the manager
populates that map. It detaches the entry it replaces, and deliberately does nothing when the same
handle is re-installed: detaching there would stop the keepalive of the box currently in use and let
it lapse at its TTL, turning a leak into an outage. `#markKilled` already did this correctly (with a
comment describing the identical failure); these two paths had just never been brought in line.

`installHandle` is exported and unit-tested against the invariant rather than the error string:
superseded handles detach exactly once, a re-install of the same handle never detaches, bots stay
independent, and a chain of replacements leaves only the current handle armed. Reverting the fix
fails two of those tests.
