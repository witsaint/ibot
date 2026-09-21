---
"@i-bot/templates": minor
"@i-bot/core": minor
---

Provision the computer-use desktop with real branded Google Chrome plus a browser-wide
anti-detection layer, so a bot's browser presents itself consistently against fingerprint
scoring (Cloudflare managed challenge etc.). IP reputation is out of scope — switch the
sandbox channel slug for a clean egress.

- **Real Chrome, best-effort**: new `chrome-install` step fetches `google-chrome-stable`
  directly from `dl.google.com` and installs it against the already-updated USTC apt list.
  It swallows any failure and `exit 0`s, so a blocked download falls back to the existing
  `chromium` (kept in `APT_PACKAGES`). Real Chrome fixes UA/UA-CH `brands=Google Chrome`,
  proprietary H.264/AAC codecs, and the TLS/JA4 fingerprint for free.
- **Flag hygiene**: launch step renamed `chromium` → `browser`, resolves
  `google-chrome-stable || chromium || chromium-browser`. Dropped `--disable-gpu` (a null
  WebGL context is a worse tell than a spoofed renderer) and added `--enable-unsafe-swiftshader`,
  `--disable-blink-features=AutomationControlled`, `--lang=en-US`, and a persistent
  `--user-data-dir`. The pgrep relaunch guard and `--restore-last-session` are unchanged.
- **CDP stealth injector**: Chrome 137+ removed `--load-extension` (and the workaround died
  by 139+), so the patch is injected over CDP instead. A dependency-free node-core daemon
  (`/opt/stealth-inject.js`, same pattern as `cdp-proxy.js`) connects to `127.0.0.1:9222`,
  `Target.setAutoAttach({flatten:true})`, and runs `Page.addScriptToEvaluateOnNewDocument`
  on every target — covering agent-CDP, agent-xdotool, and human noVNC tabs alike. The
  injected `/opt/stealth.js` is deliberately minimal (over-patching is itself a tell): WebGL
  vendor/renderer spoofing, plus defensive `webdriver`, `hardwareConcurrency`, `deviceMemory`,
  `languages`, and notification-permission consistency.
