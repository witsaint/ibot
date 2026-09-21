---
"@i-bot/core": minor
"@i-bot/templates": minor
---

Let the desktop provision onto more base templates by trusting a runtime probe over the envd
version tag, and stop the apt mirror step from assuming one Debian release.

- **Probe replaces the version gate** (`@i-bot/core`): `MIN_ENVD_VERSION` was a hard gate —
  `envd < 0.5.0` threw `EnvdVersionError` before the box was ever exercised, on the assumption
  that old envd returns no access token (→ SDK 401). Verified false for some channels: the
  gateway DOES serve a usable token for envd 0.2.0 codex templates, and the modern SDK drives
  them fine. The trivial `commands.run("true")` probe is now the real gate — a box that runs a
  command is provisioned regardless of its version tag. The version is demoted to a failure
  _classifier_: a probe failure below the floor still surfaces the actionable `EnvdVersionError`
  (use the envd HTTP fallback, don't retry/swap keys); any other probe failure stays
  `SandboxUnreachableError`. `versionGte` / `MIN_ENVD_VERSION` are retained for that classification.

- **Mirror suite follows the box's own codename** (`@i-bot/templates`): the `mirror` step hardcoded
  `bookworm` (Debian 12, our e2b/base), which on a Debian 13 (trixie) codex box wrote the wrong
  suite and skewed glibc — the install broke. It now reads `VERSION_CODENAME` from
  `/etc/os-release` at provision time and writes the sources for that release (falling back to
  `bookworm`), so one plan provisions cleanly on bookworm and trixie alike.

- **Mirror step clears the stale apt lists** (`@i-bot/templates`): a codex base is built against
  `deb.debian.org`; switching its sources to USTC left the cached per-component index metadata
  pointing at the old mirror, so a subsequent `apt-get update` could exit non-zero
  ("doesn't have the component … / Skipping acquire"). The step now `rm -rf /var/lib/apt/lists/*`
  before writing the new `sources.list`, making the following update a clean first fetch (e2b/base
  never hit this — its lists already matched the mirror).

- **apt update/install ride out a freshly-booted box** (`@i-bot/templates`): a box provisioned
  seconds after creation can still be settling — a boot-time dpkg job (`dpkg-db-backup`) briefly
  holds the lock, and egress to the base image's own extra repos may not be up yet. `apt-get update`
  now runs in a short retry loop and both update and install pass `-o DPkg::Lock::Timeout=60` so apt
  waits for the lock instead of erroring immediately. Cheap hardening for the auto-provision path
  (a human isn't watching to re-run it); in the clean case the first attempt succeeds and the loop
  is a no-op.

Verified end-to-end on the **public** channel (a codex template, envd 0.2.0, Debian 13 trixie,
3942 MB): `provisionDesktop` comes up in ~100–140s and an **off-box** probe through the gateway
confirms real branded **Google Chrome 153** answering CDP on the proxy port (`/json/version` →
`"Browser": "Chrome/153…"`, not Chromium/HeadlessChrome), noVNC serving (HTTP 200), and the
browser-wide stealth injector running. What is NOT covered here is whether a real bot check passes
— that turns on egress IP reputation, a channel/infra concern out of this recipe's scope.
