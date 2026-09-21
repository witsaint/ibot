#!/usr/bin/env bash
# Launch Google Chrome with CDP open on 9222 so browser-use can attach.
# --remote-debugging-address=0.0.0.0 is required so the platform can reach CDP
# via getHost(9222); without it CDP binds loopback-only and is unreachable.
# --no-sandbox is needed inside the container (no user namespaces).
set -euo pipefail

exec google-chrome-stable \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/root/chrome-profile \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --disable-dev-shm-usage \
  --start-maximized \
  --window-position=0,0 \
  "about:blank"
