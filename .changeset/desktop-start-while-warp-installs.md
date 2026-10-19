---
"@i-bot/templates": patch
---

Start the WARP keeper even when its client is not installed yet. Publish unavailable egress while waiting, and resume verification when installation finishes. Run installation independently from desktop startup so a slow repository cannot exhaust the desktop provisioning budget. Browser proxy routing continues to fail closed.
