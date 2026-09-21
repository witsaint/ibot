---
"@i-bot/templates": minor
---

Give the sandbox desktop a terminal, a working clipboard bridge, and a control bar that stops covering the clock.

- **Terminal**: `lxterminal` was in `APT_PACKAGES` but nothing ever launched it, so the desktop had no
  terminal at all. It is now started by `start-desktop.sh`, pgrep-guarded _inside_ the script rather than
  relying on the outer `desktop` step's `openbox` guard — that guard stays satisfied when only the
  terminal dies, so a terminal guarded only from outside would never have come back.
- **Clipboard**: x11vnc already syncs selections (every related option is a _negation_ — `-nosel`,
  `-noprimary`, `-noclipboard` — so there is nothing to enable and **no x11vnc flag to add**). The real
  gap was that lxterminal copies into PRIMARY while browsers use CLIPBOARD, so `autocutsel` (new
  package) now runs twice, once per selection, keeping both alive and mirrored. Its guards name the
  selection (`pgrep -f '... -selection CLIPBOARD'`), because a bare binary-name match sees _either_
  instance and silently skips the second one — verified: only one ever survived with the naive guard.
- Text only: rich formats (HTML, images) are out of scope.

Do **not** pass `-clip` to x11vnc. In 0.9.17 that is the screen sub-region option (`-clip WxH+X+Y`), so
a bare `-clip` swallows the next argument and x11vnc exits `unrecognized option(s)`, taking the whole
desktop down — hit live while building this. A regression test now pins it.

The web side of the feature (Cmd→Ctrl remap, clipboard event plumbing both ways, and moving the Release
chip to bottom-center so it no longer covers the desktop clock) lives in `@i-bot/web`, which is not published.

Also fixes a defect found while verifying this work on a **fresh** box: `warp-install` ran
`curl` + `apt-get update` + `apt-get install cloudflare-warp` as ONE foreground command, which on a
cold box blew past the step timeout — and because a step timeout aborts the whole provision, the
result was the desktop never starting at all, not merely "no WARP". It now writes the install to a
script, runs it detached, and waits on a bounded poll for `warp-cli`, so the envd call returns
immediately. Verified end-to-end on a from-scratch box: provision completes in ~152s with
`warp-cli` installed, WARP `Connected` (`warp=on`), terminal running, and both `autocutsel`
instances up.
