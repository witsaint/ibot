---
"@i-bot/templates": minor
---

Provision a real lightweight desktop in the sandbox (Openbox + tint2 + PCManFM + lxterminal), started before Chromium so the display is an actual Linux desktop — taskbar, minimisable windows, wallpaper, right-click menu — instead of a lone fullscreen browser. Chromium now launches maximized as a managed window.

The desktop is guaranteed to paint a solid colour rather than fall through to unpainted X11 black when Chrome is minimised: `x11-xserver-utils` is installed and `xsetroot -solid` paints the root the instant the WM starts, and PCManFM's desktop profile is pre-seeded with `wallpaper_mode=color` (its no-image default can render black).

Text now renders instead of showing as tofu boxes. Chromium is installed with `--no-install-recommends`, which skips its recommended font packages, so the base box could end up with essentially no usable fonts — even Latin punctuation in the address bar (which uses fontconfig's default sans) drew as tofu. A complete font set is now installed explicitly: `fonts-dejavu-core` (Latin/Greek/Cyrillic, punctuation, symbols — the base UI and web font) and `fonts-wqy-zenhei` (WenQuanYi ZenHei — Simplified + Traditional Chinese, ~15MB), so both English and Chinese draw real glyphs.

The apt-install idempotency guard also checks for `openbox`, `xsetroot`, and both font files, so boxes provisioned by an older recipe re-install to pick up the desktop, background, and font fixes on next connect.
