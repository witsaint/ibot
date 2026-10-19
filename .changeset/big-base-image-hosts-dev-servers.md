---
"@i-bot/core": minor
---

Make a bot's box big enough to host its own dev servers: the public-channel base image is now
`codeoff-server` (4 vCPU / 8192 MiB) instead of `ppcodex` (2 vCPU / 4096 MiB), and the fleet default
channel is public.

A bot is getting one stable box that has to do two jobs at once — drive the desktop/browser, and run
the Node/Vite services the bot builds for the user. The old default couldn't do the second job at
all, and the reason wasn't only memory:

- **Node was too old to run modern Vite.** The internal channel's `e2b/base` ships node v20.9.0;
  Vite is built on rolldown, which needs `^20.19 || >=22.12`. It dies at import with
  `SyntaxError: 'node:util' does not provide an export named 'styleText'`. `codeoff-server` ships
  **node v26.8.1 / npm 11.19.0**, so no node-install provisioning step is needed. Measured side
  effect: `npm i vite` goes from **113s to 9.4s**, which moves it from "must be a background task"
  (over `run_command`'s ~45s cap) to a plain command.
- **1 GB has no room for a second workload.** On `e2b/base` (985 MB usable) a Vite dev server left
  ~513 MB for everything else. On `codeoff-server`, a Vite dev server + Chrome (12 procs) + the whole
  desktop stack resident together used **767 MB of 7967 MB**, no OOM. The full loop was verified in
  one box: edit a file → HMR frame arrives through the runtime host → Chrome renders the new content.
- It also preinstalls **Chrome 154** and `codex-cli`, so the best-effort chrome step has less to do.

**Template ids are registered per channel, and this is why the default channel moved.** All of the
gateway's larger templates 404 on the internal channel (`SandboxError: 404: template not found`);
internal's only base is `e2b/base`. So "give the box more memory" is not a resource flag, it's a
channel + base-image choice, and the big image is only reachable on public. `SANDBOX_PUBLIC=true` is
now set so a bot with no explicit preference lands there; `bots.sandbox_public` still pins a bot
either way.

**The trade-offs, stated:** public egress means WARP is brought up (install + ladder + keeper), which
costs ~60s of the 175s provision. That's wanted for browser work (clean IP for Cloudflare) and is
pure overhead for a pure-dev box — worth decoupling later, since WARP is applied only to Chrome via
`--proxy-pac-url` and not system-wide, so it never slowed the npm installs above. And a bot that
genuinely needs internal-network reach must stay on the internal channel, which means it stays on the
small image and cannot host a modern dev server. No bot in the fleet needs that today.

Live-verified end to end on the new default (`pnpm --filter @i-bot/core verify:sandbox`): provision
158s, `cpuCount: 4`, `memoryMB: 8192`, envd health 204, screenshot PNG, desktop write, and CDP
navigate + read_dom all pass.
