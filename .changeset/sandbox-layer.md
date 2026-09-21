---
"@i-bot/core": minor
"@i-bot/templates": minor
---

Sandbox layer: self-built desktop template + PPIO/AIProxy `SandboxProvider` + computer/browser executors.

- **templates**: library-driven remote template build (`scripts/build-template.ts`) replacing the placeholder CLI; Dockerfile installs `xdotool`+`scrot` and real `google-chrome-stable`, and declares `USER root`/`WORKDIR /root` (the builder transpiles the Dockerfile and would otherwise default the boot user to a non-existent `user`).
- **core**: `PpioSandboxProvider` (TTL negotiation, real-spec confirm, envd-version gate, reachability probe, verified keepalive), `PpioSandboxHandle` (run/screenshot via `scrot`, idempotent destroy), pure `config`/`meta`/`errors`, and tool-agnostic `executeDesktopAction` (xdotool, shell-escaped) + `connectBrowser` (playwright-core CDP). Additive contract fields on `SandboxHandle` (`providerSandboxId`, `meta`) and `CreateSandboxRequest`/`ConnectSandboxRequest` (`sandboxRowId`).
