#!/usr/bin/env bash
# Build & register the i-bot desktop template with the PPIO/AIProxy control plane.
#
# Thin wrapper around scripts/build-template.ts, which drives the ppio-sandbox
# library's remote build API (no local Docker daemon, no external CLI). See that
# file for env requirements and the templateId round-trip.
#
# Prereqs:
#   - AIPROXY_API_KEY set (the single gateway credential).
#   - SANDBOX_CONTROL_PLANE_URL set incl. channel slug, e.g.
#     https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-internal
set -euo pipefail
cd "$(dirname "$0")/.."

exec pnpm exec tsx scripts/build-template.ts
