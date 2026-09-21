---
"@i-bot/core": minor
"@i-bot/templates": minor
---

Provision the runtime desktop on the public egress channel by resolving the stock base image
per-channel instead of always using `e2b/base`.

The public channel (`ppio-sandbox-public`, clean-IP egress) does not carry the `e2b/base` alias the
internal channel does, so a bot with `sandbox_public=true` failed to start its desktop:
`Sandbox.create` returned `400 Invalid environment ID: invalid env ID: e2b/base` and the row landed
`state=kill`. `SandboxConfig` now exposes `baseImageFor(defaultBaseImage, slug)`, which swaps in a
verified codex base (`zsob2dxzqa2lcepse0b0`, envd 0.2.0, Debian 13 trixie) for a box routed to the
public channel and keeps the template's own base on internal. The provider consults it when creating
from a template that has no concrete `templateId` (the runtime-provisioned path). The public base is
overridable with `SANDBOX_PUBLIC_BASE_IMAGE` for when the gateway registers a different public base.

The existing probe-gate and os-release codename fixes already let `provisionDesktop` install the full
stack (real Chrome + CDP@9223 + noVNC) on the codex base, so public desktops now come up end-to-end.
Internal-channel behaviour is unchanged.
