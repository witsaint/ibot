#!/usr/bin/env bash
# Build & register the i-bot desktop template with the PPIO/AIProxy control plane.
#
# Prereqs:
#   - PPIO CLI installed (the tool that reads ppio.toml + a Dockerfile).
#   - AIPROXY_API_KEY set (the single gateway credential).
#   - SANDBOX_CONTROL_PLANE_URL set to the control plane incl. channel slug,
#     e.g. https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-internal
#
# Builds go through the gateway, not PPIO direct — the CLI must be pointed at the
# control-plane URL and authenticated with the AIProxy key (never an upstream key).
# On success the CLI prints a template_id: copy it into ppio.toml and
# src/manifest.ts (DESKTOP.templateId).
set -euo pipefail
cd "$(dirname "$0")"

: "${AIPROXY_API_KEY:?set AIPROXY_API_KEY (the AIProxy gateway key)}"
: "${SANDBOX_CONTROL_PLANE_URL:?set SANDBOX_CONTROL_PLANE_URL (incl. /c/{slug})}"

# PPIO/E2B-compatible CLIs read PPIO_API_KEY; feed it the AIProxy key.
export PPIO_API_KEY="${AIPROXY_API_KEY}"

echo "Building ibot-desktop template via ${SANDBOX_CONTROL_PLANE_URL}"
# NOTE: exact CLI invocation depends on the installed PPIO CLI version.
# Typical shape (adjust the binary/flags to your CLI):
#   ppio template build --config ppio.toml --api-url "${SANDBOX_CONTROL_PLANE_URL}"
ppio template build \
  --config ppio.toml \
  --api-url "${SANDBOX_CONTROL_PLANE_URL}"

echo "Done. Copy the printed template_id into ppio.toml and src/manifest.ts (DESKTOP.templateId)."
