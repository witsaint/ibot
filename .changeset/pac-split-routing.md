---
"@i-bot/core": minor
"@i-bot/templates": minor
---

Split the WARP desktop's browser egress per host: domestic (CN) traffic goes DIRECT on the box's
own route, everything else goes through WARP's SOCKS5 — with a DIRECT fallback when WARP is down.

- **PAC instead of a flat `--proxy-server`** (`@i-bot/templates`): with `warp: true` Chrome now
  launches with `--proxy-pac-url=data:…` carrying a generated PAC (new `proxy-pac.ts`:
  `buildProxyPac`, `proxyPacDataUrl`, `CN_DIRECT_TLDS`, `CN_DIRECT_DOMAINS`). `.cn` / `.中国` TLDs
  and a maintained whitelist of CN services on other TLDs (Baidu, Tencent/WeChat, Alibaba/Alipay,
  ByteDance/Feishu, JD, Bilibili, Weibo, NetEase, Xiaomi/Huawei, Kuaishou, Zhihu, Meituan, Ctrip,
  Gitee/npmmirror/USTC, domestic banks, CN AI vendors, …) return `DIRECT`; anything else returns
  `SOCKS5 127.0.0.1:40000; DIRECT`. Why: WARP's free node is a Cloudflare anycast IP that reads as
  overseas to many CN sites (geo-walls, SMS gates, slow trans-border hops) while the box's own
  egress IS domestic and fast — a flat proxy flag dragged both worlds down one pipe. Chrome rejects
  `file://` PAC URLs, hence the `data:` URL (~7 KiB); a readable copy is also written to
  `/opt/ibot-proxy.pac` for on-box debugging.

- **No DNS leak, no per-request lookups**: the PAC matches by suffix-walking the host's labels
  against a lookup table — it never calls `dnsResolve`, and `isInNet` only runs on hosts that are
  already IPv4 literals (private/loopback/link-local/CGNAT ranges → DIRECT, public IPs → proxy).
  SOCKS5-routed hostnames still resolve through WARP, exactly as before. Plain names, `localhost`,
  `*.localhost` and `::1` stay DIRECT so in-box services and the management plane are untouched.

- **Self-healing when WARP is late**: the `DIRECT` fallback means a Chrome started against a
  not-yet-connected WARP is no longer dead — it egresses direct and Chrome retries the proxy after
  its ~5 min bad-proxy TTL. Trade-off: during that window a CF-walled site sees the datacenter IP
  and challenges (visible in the page, not silent breakage).

- **Per-box additions** (`@i-bot/core` + `@i-bot/templates`): `DesktopProvisionOptions.directDomains`
  / `ProvisionOptions.directDomains` extend the whitelist for a bot whose target is domestic but not
  yet listed. Ignored when `warp` is off (everything is direct then).

Tests execute the generated PAC in a `node:vm` context with the spec builtins stubbed (and
`dnsResolve` as a trap), so routing decisions are verified, not just string shape. Not yet
live-verified on a public-channel box; the flag/quoting path is covered by the plan tests.
