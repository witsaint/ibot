---
"@i-bot/core": minor
---

Add `SandboxHandle.detach()` — drop an in-process handle (stop keepalive) without killing
the box on the control plane. Lets apps/api release handles on a graceful shutdown while
leaving boxes running for the next process to reconnect and re-arm, instead of killing
every box on SIGTERM (which made a bot's desktop vanish after a restart / dev hot-reload).

Also switch the noVNC preview `streamUrl` from the full `vnc.html` to `vnc_lite.html`
(`scale=true&view_only=true`): the full client's dark control dock clashed with the app
chrome and its fullscreen button tripped the iframe permissions policy. The lite client is
a bare, auto-scaling canvas we frame ourselves.
