---
"@i-bot/templates": minor
"@i-bot/core": minor
---

Make the browser's clean egress an invariant that is held, verified and published, instead of a
side-effect of one command at provision time. This is the difference between a recipe that passed once
and something that can be delivered.

**What actually broke.** A public-channel box was found with WARP `Disconnected (Manual Disconnection)`
and the SOCKS5 port not even listening. Nothing looked wrong anywhere: the desktop was up, `warp-svc`
was running, provisioning reported success, and pages loaded at 71 KB/s. Cloudflare's Turnstile simply
never rendered, because the requests were arriving from a Tencent-Cloud datacenter ASN — the box had
been silently egressing dirty. Four layers each failed open, and every one of them had to change:

- **`warp-cli` lies, and we believed it.** Measured: `warp-cli connect` prints `Success` while status
  stays `Disconnected`. `status` reports the daemon's intent, not a working path. `pgrep warp-svc`
  matches a daemon whose tunnel is dead. The only honest signal is bytes coming back THROUGH the SOCKS5
  socket, so that is now factored into `warp-verify.sh` and is the single check used by the bring-up
  step's idempotency guard, the ladder, and the keeper.

- **Retrying the failing command is not recovery.** `connect` failed; `disconnect` + `connect` failed
  identically, both printing `Success`. What rebuilt the tunnel was `tunnel protocol set`. So `warp-up.sh`
  is now a **ladder**, each rung strictly more drastic than the last and each followed by a real verify:
  verify → connect → reconnect → protocol MASQUE → protocol WireGuard → restart `warp-svc` →
  re-register the device. It exits non-zero when exhausted instead of exiting 0 regardless.
  Protocol is alternated rather than pinned because which one works is a property of the network path:
  on the same box minutes apart, WireGuard was completely dead (0 B/s) and MASQUE was healthy
  (155 KB/s, a 1.3 MB page in 2.2s).

- **Nothing re-checked after connect, and merely pausing the sandbox is enough to break it.** A tunnel
  that dies an hour into a session was invisible, which is exactly how this happened — and it takes no
  one doing anything. Measured end to end on a live box: a pause/resume is checkpoint/restore, not a
  reboot, so `warp-svc` and the keeper come back with the *same pids* and `/proc/uptime` never resets;
  the daemon's memory survives while the tunnel's UDP/QUIC session and NAT mappings cannot. The resumed
  box therefore insists `Connected / Network: healthy` while nothing egresses at all — a quieter
  failure than the `Disconnected` one, with no reason string to key off, and a third independent reason
  `status` can never be the readiness check. `warp-keeper.sh` now holds the invariant for the life of
  the box: verify every 30s, walk the ladder on failure, bounded backoff to 5 min so a persistently
  broken tunnel neither spins the ladder (its last rung deletes a registration) nor eats a 1-CPU box.
  On that same pause/resume test it published `verify failed; recovering (attempt 1)` and was clean
  again **20s later with provisioning explicitly skipped** — so recovery is the keeper's doing, not a
  side effect of re-provisioning on connect. The keeper RUNNING is a readiness gate — it cannot fail
  for network reasons; WARP being UP deliberately still is not, or a Cloudflare outage would mark the
  whole desktop dead.

- **The PAC's `; DIRECT` fallback was the leak itself.** It reads as graceful degradation and it is the
  mechanism by which this produced wrong answers for a day: proxy down → fall through → dirty IP →
  page loads → no challenge widget. `buildProxyPac` now **fails closed** by default, so a down tunnel
  is `ERR_PROXY_CONNECTION_FAILED` on the first request — visible, attributable, and healed by the
  keeper within ~30s. The trade is deliberate and this way round on purpose: a loud failure that
  self-heals in half a minute beats a silent one that quietly invalidates a day of work. "Degraded but
  working" is not a state this system can have, because the degraded thing IS what the task needed.
  `fallbackDirect` / `egressFallbackDirect: true` restores the old behaviour for a box where a clean IP
  is opportunistic rather than the point.

**Made answerable, not assumed:** the keeper publishes its verdict to `/opt/ibot-egress.json` and
`readEgressState` / `waitForCleanEgress` read it. Reading a file can't fail for the same reason the
egress failed, and it costs no round trip through the tunnel whose health is the question. A stale
verdict is downgraded to not-ok (a dead keeper is the absence of evidence, not evidence of health), and
`absent` is kept distinct from `dirty` so a direct-egress box doesn't read as broken. Intended for
gating: a task that needs a clean IP can wait or refuse up front instead of running to completion
against a page that was never going to challenge it.

**Still true and worth saying plainly:** free WARP has no SLA. This makes an outage loud and
self-healing; it cannot make Cloudflare's consumer tier a guaranteed service. If a hard guarantee is
needed, the answer is paid egress (WARP+ or a commercial proxy) — the SOCKS5-on-loopback seam means
that is a swap of what listens on the port, not a rewrite.
