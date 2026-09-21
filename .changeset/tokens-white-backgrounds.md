---
"@i-bot/config": patch
---

Make light-mode `--bg-subtle` pure white (`#ffffff`) instead of `#fafafa`. Resting
backgrounds across the app chrome (rail, inset panels, status pills, thumbnails) are now
pure white; separation comes from hairline borders, not grey fills. `--surface-hover`
stays a transient hover tint only, never a resting background. Dark mode is unchanged.
