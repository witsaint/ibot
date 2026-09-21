---
"@i-bot/templates": minor
"@i-bot/core": minor
---

Make a bot's desktop pass Cloudflare's interactive Turnstile: route the browser through
Cloudflare WARP on the public channel, and delete the CDP stealth injector.

Verified end-to-end on a live public-channel box (novita.ai login, real sitekey): the widget
renders and one click yields a token in under 3 s. Three things are required, together:

1. **Clean egress IP for the browser** — the public channel's own IP is a Tencent-Cloud datacenter
   ASN that Cloudflare scores as a bot before any click. New `warp-install` / `warp-up` provision
   steps install `cloudflare-warp` (Cloudflare's apt repo, suite = the box's own codename) and bring
   it up in **proxy mode** — a SOCKS5 listener on `127.0.0.1:40000` that carries only traffic pointed
   at it. Chrome gets `--proxy-server=socks5://127.0.0.1:40000` (DNS resolves through the proxy too).
   Nothing else on the box is proxied: apt, curl, the agent's `run_command`, envd and noVNC keep the
   box's own route, so the management plane cannot be severed. Both steps are best-effort (`exit 0`)
   and WARP is deliberately not a readiness gate; `warp-up` is guarded on `warp=on` through the socket
   so a revived-but-disconnected daemon reconnects on re-provision.
2. **`--disable-blink-features=AutomationControlled`** (already present) sets `navigator.webdriver`
   to false natively, with no tamper trace. CDP attached, cdp-proxy and xdotool are all fine.
3. **No JS stealth patch.** The CDP-injected `/opt/stealth.js` daemon is removed (`STEALTH_JS`,
   `STEALTH_INJECT_JS`, the `stealth-inject` step). Turnstile's client-side integrity check detects
   native getters rewritten by page-world JS — even to "honest" values — logs `Error: 300010` and
   `api.js` self-destructs, so the widget never rendered at all. A patch is a patch.

Wiring: `desktopProvisionPlan({ warp })` builds either shape; `provisionDesktop` takes `opts.warp`;
`SandboxConfig.warpFor(slug)` maps the channel to the flag (public → on, internal → off, following
the same slug resolution as `baseImageFor`), and the PPIO provider passes it on both create and
reconnect from the box's persisted channel — so a box never flips between proxied and direct egress.
The existing per-bot `sandboxPublic` toggle is therefore also the per-bot WARP toggle: a bot that must
reach corporate-internal hosts through Chrome stays on the internal channel (direct egress).

Measured trade-offs of WARP egress: free tier is `loc=CN`; `google.com` / `t.co` are unreachable
through it (Google-account login flows that bounce via the google.com main domain may stall; GA/ads
pixels fail harmlessly); a corporate split-tunnel VPN (Feilian) is mutually exclusive with it in the
same browser; no SLA.
