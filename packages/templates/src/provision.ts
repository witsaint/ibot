/**
 * The desktop provisioning recipe — the single source of truth for how a stock
 * `baseImage` box becomes an i-bot computer-use desktop. Pure data + string builders,
 * no I/O: `@i-bot/core`'s provisioner executes this plan against a live box.
 *
 * Live-verified end-to-end through the AIProxy gateway (internal channel, e2b/base, envd
 * 0.5.12): the full stack comes up in ~170s including a cold real-Chrome install — real Chrome
 * 153, webdriver=false. Chrome install degrades safely to chromium if dl.google.com is slow/blocked.
 *
 * PASSING A HARD BOT CHECK (Cloudflare interactive Turnstile) — verified end-to-end 2026-09-21 on a
 * public-channel box (novita.ai login, real sitekey, one click → token in <3s). It takes exactly
 * three things, all required, and nothing else:
 *   1. A clean egress IP for the BROWSER. The public channel's own IP is a Tencent-Cloud datacenter
 *      ASN, which CF scores as a bot before any click ("Just a moment…" forever). We route Chrome
 *      through Cloudflare WARP in proxy mode (SOCKS5 on loopback; egress becomes AS13335) — see
 *      `warp` in `DesktopProvisionOptions`. Only Chrome is proxied; system routes are untouched.
 *   2. `--disable-blink-features=AutomationControlled`: sets navigator.webdriver=false NATIVELY, with
 *      no tamper trace. (CDP attached + cdp-proxy + xdotool are all fine; none of them is a tell.)
 *   3. NO JS-injected "stealth" patch. We used to inject one over CDP; Turnstile's client-side
 *      integrity check (console `Error: 300010`) detects native getters rewritten by page-world JS —
 *      even to "honest" values — and api.js then SELF-DESTRUCTS (removes its own script + mount
 *      point), so the widget never renders at all. Deleting the injector is what made it pass.
 *      A patch is a patch; honesty of the patched values is irrelevant.
 * Change commands here, never inline in core.
 *
 * DESIGN NOTES (each earned from a live probe):
 * - Debian's default deb.debian.org mirror times out from the CN infra the gateway runs on;
 *   a CN mirror (USTC) makes apt update+install ~42s instead of a 3-minute timeout. The mirror
 *   suite is the box's OWN codename (read from /etc/os-release at provision time), NOT hardcoded:
 *   e2b/base is bookworm (Debian 12) but a public codex template is trixie (Debian 13), and
 *   writing the wrong suite skews glibc and breaks the install (verified: trixie box, ~98s clean
 *   install with the codename fix). Modern Debian ships sources in deb822 at
 *   /etc/apt/sources.list.d, so we remove that and write a classic sources.list.
 * - Chrome binds 127.0.0.1 only; a tiny Node proxy on `cdpProxy` rewrites the Host
 *   header to `localhost` so Chrome's DNS-rebinding guard accepts requests the gateway
 *   forwards as `<port>-<id>.<domain>`. Without it, off-box CDP returns HTTP 500.
 * - Services start with `nohup … &` — background processes survive across separate
 *   envd command runs (each `commands.run` is its own exec), verified.
 * - Steps are guarded to be idempotent: re-running provision on an already-provisioned
 *   box (e.g. after the ~24h infra pause/resume) is a cheap no-op.
 * - Anti-detection: the browser is REAL branded Google Chrome (not Chromium) so the UA,
 *   UA-CH brands (`Google Chrome`, not `Chromium`), proprietary codecs (H.264/AAC) and
 *   TLS/JA4 fingerprint all read as a genuine consumer browser — the signals a bot check
 *   scores BEFORE any click. Chrome install is best-effort and falls back to `chromium` if
 *   dl.google.com is slow/blocked from the box's egress. There is deliberately NO JS fingerprint
 *   patch (see the Turnstile notes above): real Chrome + the native AutomationControlled flag
 *   already report everything correctly, and any page-world rewrite of a native getter — however
 *   "honest" — fails Turnstile's integrity check. WebGL renders in software (SwiftShader) and CPU/RAM
 *   report the box's real values; a self-consistent low-end machine passes, a self-contradicting
 *   spoofed one does not.
 * - WARP egress (public channel): `cloudflare-warp` is installed from Cloudflare's apt repo and run
 *   in PROXY mode — a SOCKS5 listener on 127.0.0.1:${WARP_PORT} that only carries traffic explicitly
 *   pointed at it. Chrome gets `--proxy-server=socks5://…` (the `socks5://` scheme makes Chrome do
 *   DNS through the proxy too, so hostnames resolve on the clean side). Nothing else on the box is
 *   proxied: apt, curl, the agent's `run_command`, envd (the SDK channel) and noVNC all keep the
 *   box's own route, so the management plane cannot be severed by this. Trade-offs, measured: the
 *   free WARP node is `loc=CN`; google.com / t.co are unreachable through it (Google login flows
 *   that bounce via google.com main domain may stall; GA/ads pixels fail harmlessly); corporate
 *   split-tunnel VPNs (Feilian) are mutually exclusive with it in the same Chrome. Free WARP has no
 *   SLA — `warp-svc` is pgrep-guarded and re-provision reconnects it.
 */
import { DESKTOP } from "./manifest.js";

/** Fastest reachable Debian mirror from the gateway's CN infra (probe: USTC 0.34s). */
export const APT_MIRROR = "https://mirrors.ustc.edu.cn";

/**
 * Desktop packages. `--no-install-recommends` keeps it lean enough for the 1 GB box.
 *
 * `chromium` here is the FALLBACK browser: the box prefers real Google Chrome (installed
 * best-effort by the `chrome-install` step from dl.google.com), but if that download is
 * blocked/slow from the egress, the launch step resolves `chromium` instead so the desktop
 * always comes up. Real Chrome idles heavier (~300-400 MB/tab vs Chromium); on the 1 GB box
 * that's tight but fits with a single boot tab + `--disable-dev-shm-usage` — heavy pages risk
 * the OOM-killer (which trips the launch pgrep guard → relaunch), another reason to keep the
 * chromium fallback installed.
 *
 * The first block is the computer-use plumbing (browser + CDP + input + VNC). The second
 * block is a *real* lightweight desktop so the display isn't just a bare Chrome window:
 * - openbox    — window manager: every window gets a titlebar, can be minimised / moved
 * - tint2      — taskbar/panel: shows open windows, a clock, a launcher (so minimise has
 *                somewhere to go, and you can switch windows)
 * - pcmanfm    — paints the desktop (wallpaper + icons + right-click menu) AND is the file
 *                manager, so the box feels like a Linux desktop, not a kiosk
 * - lxterminal — a terminal available from the menu/panel
 * - dbus-x11   — a session bus so the file manager and app menus start cleanly
 * Openbox + tint2 + pcmanfm idle at well under ~50 MB combined, comfortably inside the
 * ~660 MB free measured with Chromium running.
 */
export const APT_PACKAGES = [
  "chromium",
  "xvfb",
  "xdotool",
  "scrot",
  "x11vnc",
  "novnc",
  "websockify",
  "openbox",
  "tint2",
  "pcmanfm",
  "lxterminal",
  // autocutsel bridges the desktop's two X selections (PRIMARY ↔ CLIPBOARD) and keeps them alive
  // so x11vnc's `-clip` has something to sync with the browser. Tiny, and without it copy/paste
  // between the remote terminal and the browser silently does nothing. See START_DESKTOP_SH.
  "autocutsel",
  "dbus-x11",
  // xsetroot (from x11-xserver-utils) paints the root window a solid colour as a
  // guaranteed floor: even if pcmanfm's desktop layer fails to draw, minimising Chrome
  // reveals a coloured desktop, never unpainted X11 black.
  "x11-xserver-utils",
  // Fonts. Chromium is installed with --no-install-recommends, which SKIPS its recommended
  // font packages — so the base box can end up with essentially no usable fonts and renders
  // EVERYTHING (even Latin punctuation in the omnibox, which uses fontconfig's default sans)
  // as tofu boxes. Install a complete set explicitly:
  //  - fonts-dejavu-core: Latin/Greek/Cyrillic + punctuation + symbols (~1.5MB) — the base UI
  //    and web font, so the address bar and English pages draw real glyphs.
  //  - fonts-wqy-zenhei: CJK (Simplified + Traditional), ~15MB — so Chinese renders, not blank.
  // (Swap wqy for fonts-noto-cjk if Japanese/Korean coverage is ever needed — but it's ~200MB.)
  "fonts-dejavu-core",
  "fonts-wqy-zenhei",
] as const;

const P = DESKTOP.ports;
const S = DESKTOP.screen;

/**
 * The in-box CDP Host-rewrite proxy. Listens on `cdpProxy`, forwards to
 * `127.0.0.1:cdp` with `Host: localhost:<cdp>` on both HTTP and the WS upgrade, so
 * Chrome's rebinding guard accepts the gateway-forwarded request. Written to
 * /opt/cdp-proxy.js. Kept dependency-free (node core http+net) — the base image has node.
 */
export const CDP_PROXY_JS = String.raw`
const http = require('http'); const net = require('net');
const TARGET = { host: '127.0.0.1', port: ${P.cdp} };
const FIXED_HOST = 'localhost:${P.cdp}';
http.createServer((req, res) => {
  const pr = http.request(
    { host: TARGET.host, port: TARGET.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: FIXED_HOST } },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); }
  );
  pr.on('error', (e) => { try { res.writeHead(502); res.end(String(e)); } catch {} });
  req.pipe(pr);
}).on('upgrade', (req, socket, head) => {
  const up = net.connect(TARGET.port, TARGET.host, () => {
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    const h = { ...req.headers, host: FIXED_HOST };
    for (const k of Object.keys(h)) raw += k + ': ' + h[k] + '\r\n';
    raw += '\r\n';
    up.write(raw); if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}).listen(${P.cdpProxy}, '0.0.0.0', () => console.log('cdp-proxy on ${P.cdpProxy}'));
`;

/**
 * Cloudflare WARP, proxy mode. The SOCKS5 port WARP listens on for the browser. WARP's own default
 * (40000) — kept explicit so the Chrome flag and the readiness probe can't drift from it.
 */
export const WARP_PORT = 40000;

/** Cloudflare's apt repo. Suite = the box's own codename (`$CN`, same trick as the Debian mirror). */
export const WARP_APT_REPO = "https://pkg.cloudflareclient.com/";
export const WARP_APT_KEY_URL = "https://pkg.cloudflareclient.com/pubkey.gpg";

/**
 * Bring WARP up in proxy mode, idempotently. Written to /opt/warp-up.sh so the multi-command
 * sequence is one guarded step (envd runs each step in its own shell).
 *
 * - `warp-svc` is the daemon (no systemd in the box → nohup it; pgrep-guarded on re-provision).
 * - `registration new` is a no-op error if already registered (`|| true`); the registration is
 *   the free consumer tier, no account/key — nothing tenant-specific ever leaves the box.
 * - `mode proxy` BEFORE `connect`: in proxy mode WARP never touches routes or resolv.conf, so the
 *   PPIO edge relay (noVNC + envd) stays reachable. Full-tunnel mode would sever the management
 *   plane — never switch this to `warp` mode.
 * - `proxy port` pins the SOCKS5 port to WARP_PORT so Chrome's flag always matches.
 * - Waits (bounded) for `warp=on` THROUGH the proxy — the only proof the tunnel is actually up.
 *   Exit 0 either way: a slow WARP must not fail provisioning (Chrome still launches; the
 *   readiness probe below reports the real state and re-provision reconnects).
 */
export const WARP_UP_SH = String.raw`#!/bin/sh
PORT="${"${1:-40000}"}"
if ! pgrep -x warp-svc >/dev/null 2>&1; then
  nohup warp-svc >/tmp/warp-svc.log 2>&1 &
  sleep 3
fi
warp-cli --accept-tos registration new >/dev/null 2>&1 || true
warp-cli --accept-tos mode proxy >/dev/null 2>&1 || true
warp-cli --accept-tos proxy port "$PORT" >/dev/null 2>&1 || true
warp-cli --accept-tos connect >/dev/null 2>&1 || true
i=0
while [ $i -lt 20 ]; do
  if curl -s --max-time 4 --proxy "socks5h://127.0.0.1:$PORT" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^warp=on'; then
    echo "[warp-up] warp=on via socks5 :$PORT"; exit 0
  fi
  i=$((i+1)); sleep 1
done
echo "[warp-up] WARNING: warp not confirmed on after 20s (status: $(warp-cli --accept-tos status 2>&1 | head -1))"
exit 0
`;

/**
 * Bring up the desktop session on the Xvfb display. Must run AFTER Xvfb and BEFORE Chromium
 * so Chrome opens as a window Openbox manages (titlebar + minimise), not a bare unmanaged
 * surface. Kept in a script (not inlined) so the dbus session env is shared by the window
 * manager, panel, and file manager it launches — envd runs each step in its own shell, so a
 * one-liner couldn't hold the bus address across processes.
 *
 * - dbus-launch gives lxpanel/pcmanfm a session bus (no system dbus in the box → harmless
 *   warnings otherwise, but the menu/mount plumbing wants one).
 * - xsetroot paints the root window a solid colour immediately after the WM starts — the
 *   guaranteed floor so minimising Chrome never reveals unpainted X11 black, even if the
 *   pcmanfm desktop layer is slow or fails.
 * - pcmanfm --desktop then paints the real desktop (wallpaper + icons + right-click menu) —
 *   and we pre-write its profile so its wallpaper_mode is a solid colour (its default with no
 *   image can render black), keeping the desktop coloured rather than black.
 * - tint2 is the taskbar. openbox is the WM. All backgrounded; the script exits immediately.
 */
export const START_DESKTOP_SH = String.raw`#!/bin/sh
export DISPLAY=:0
export HOME="${"${HOME:-/root}"}"
# a session bus, if we don't already have one (idempotent across re-provision)
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
  eval "$(dbus-launch --sh-syntax)" 2>/dev/null || true
fi
# pre-seed pcmanfm's desktop profile so it paints a SOLID COLOUR (its no-image default can
# render the root black). Written before pcmanfm starts so the first paint is already coloured.
mkdir -p "$HOME/.config/pcmanfm/default"
cat > "$HOME/.config/pcmanfm/default/desktop-items-0.conf" <<'PCMANFM_EOF'
[*]
wallpaper_mode=color
wallpaper_common=1
desktop_bg=#2e3440
desktop_fg=#d8dee9
desktop_shadow=#000000
show_wm_menu=0
PCMANFM_EOF
# window manager first, so it adopts windows mapped after it
nohup openbox >/tmp/openbox.log 2>&1 &
sleep 1
# guaranteed floor: paint the root a solid colour the instant the WM is up
xsetroot -solid '#2e3440' 2>/dev/null || true
# Clipboard bridge. Two managers, because the desktop has two selections and they are NOT the same
# thing: lxterminal copies on select into PRIMARY (the X select buffer), while a browser and every
# modern app use CLIPBOARD. x11vnc syncs only one of them to the RFB clipboard channel, so one
# autocutsel on CLIPBOARD keeps that selection both ways and a second on PRIMARY mirrors it in —
# which is what makes select-in-terminal-then-paste-in-browser work.
#
# The guards MUST name the selection (pgrep -f with the full command), not just the binary:
# a plain pgrep on the binary name matches EITHER instance, so whichever line ran second saw the
# first one already up and skipped — leaving PRIMARY unmirrored. Verified: only one ever survived.
pgrep -f 'autocutsel -selection CLIPBOARD' >/dev/null 2>&1 || nohup autocutsel -selection CLIPBOARD >/tmp/autocutsel-clip.log 2>&1 &
pgrep -f 'autocutsel -selection PRIMARY' >/dev/null 2>&1 || nohup autocutsel -selection PRIMARY >/tmp/autocutsel-prim.log 2>&1 &
# desktop surface (wallpaper colour + icons + right-click menu) — also the file manager
nohup pcmanfm --desktop --profile default >/tmp/pcmanfm.log 2>&1 &
# taskbar / panel: shows open windows, clock, launcher
nohup tint2 >/tmp/tint2.log 2>&1 &
# terminal — lxterminal ships in APT_PACKAGES but nothing ever launched it, so the desktop had no
# terminal at all. pgrep-guarded here (NOT relying on the outer desktop step's openbox guard,
# which stays satisfied when only the terminal dies) so it self-heals on every re-provision.
# --geometry is deliberately left at the default: a fixed size would fight the WM on a resized box.
pgrep -x lxterminal >/dev/null 2>&1 || nohup lxterminal >/tmp/lxterminal.log 2>&1 &
sleep 1
`;

/** A file the provisioner must write before running the launch commands. */
export interface ProvisionFile {
  path: string;
  content: string;
}

/** A guarded shell step. `check` (if present) short-circuits when it exits 0 (idempotency). */
export interface ProvisionStep {
  /** short id for logs */
  id: string;
  /** human description */
  label: string;
  /** command to run (as root) when `check` is absent or non-zero */
  run: string;
  /** optional idempotency guard: if this exits 0, `run` is skipped */
  check?: string;
  /** per-step timeout (ms); provisioner default applies when omitted */
  timeoutMs?: number;
}

/** An on-box readiness probe polled after launch until it exits 0 (or overall timeout). */
export interface ReadinessCheck {
  id: string;
  /** command that exits 0 when the service is up */
  command: string;
}

/** The full recipe the core provisioner executes. */
export interface ProvisionPlan {
  files: ProvisionFile[];
  steps: ProvisionStep[];
  readiness: ReadinessCheck[];
}

/**
 * The mirror sources.list, written at provision time with `$CN` = the box's OWN Debian codename
 * (read from /etc/os-release). NOT hardcoded: the internal e2b/base is bookworm (Debian 12) but a
 * public codex template is trixie (Debian 13) — writing bookworm onto trixie skews glibc and breaks
 * the install. `$CN` is a shell var expanded in-box (the heredoc is unquoted so it interpolates),
 * so this string is a template the mirror step fills; `${APT_MIRROR}` is substituted here in JS.
 */
const sourcesList =
  `deb ${APT_MIRROR}/debian $CN main contrib non-free non-free-firmware\n` +
  `deb ${APT_MIRROR}/debian $CN-updates main contrib non-free non-free-firmware\n` +
  `deb ${APT_MIRROR}/debian-security $CN-security main contrib non-free non-free-firmware\n`;

/**
 * Per-box knobs for the plan. Everything else in the recipe is fixed; these are the only bits that
 * legitimately differ between boxes.
 */
export interface DesktopProvisionOptions {
  /**
   * Route the BROWSER's egress through Cloudflare WARP (proxy mode) for a clean IP. This is what
   * lets a bot pass Cloudflare's interactive Turnstile (see the file header). Default `false`: the
   * caller decides per box — on the public channel (datacenter egress IP) it should be on; on the
   * internal channel, or for a bot that must reach corporate-internal hosts through Chrome (WARP and
   * a split-tunnel VPN are mutually exclusive in the same browser), leave it off. Only Chrome is
   * proxied; the box's own route (apt, curl, run_command, envd, noVNC) is untouched either way.
   */
  warp?: boolean;
}

/**
 * Build the provisioning plan. Pure function of `opts` so the same recipe can be unit-tested for
 * both shapes and the provisioner stays a dumb executor.
 */
export function desktopProvisionPlan(opts: DesktopProvisionOptions = {}): ProvisionPlan {
  const warp = opts.warp ?? false;
  // `DPkg::Lock::Timeout` so the install also waits out any boot-time dpkg job holding the lock
  // rather than failing immediately (same freshly-booted-box race the apt-update step rides out).
  const aptInstall = `DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends ${APT_PACKAGES.join(" ")}`;

  // Chrome egress. `socks5://` (not `socks5h://` — Chrome's flag grammar) already means "resolve
  // through the proxy" in Chrome, so hostnames never leak to the box's own resolver. Off = direct.
  const proxyFlag = warp ? `--proxy-server=socks5://127.0.0.1:${WARP_PORT} ` : "";

  const warpSteps: ProvisionStep[] = warp
    ? [
        {
          id: "warp-install",
          label: "install Cloudflare WARP client (clean browser egress)",
          // idempotent: skip once the CLI is on the overlay disk — which is also what the polling
          // wait below finally observes, so a slow install that finishes late is still picked up.
          check: "command -v warp-cli >/dev/null 2>&1",
          // Cloudflare's repo, suite = the box's own codename (`$CN`, same as the Debian mirror —
          // WARP publishes bookworm AND trixie). Its `libpcap0.8` dep was renamed `libpcap0.8t64` on
          // trixie (which Provides: libpcap0.8), so this MUST run after the main `apt-get update` has
          // populated the mirror lists, or the dep won't resolve. Best-effort like chrome-install:
          // a blocked pkg.cloudflareclient.com must not fail provisioning — Chrome then launches
          // with the proxy flag pointing at a port nobody listens on, rather than the whole desktop
          // being marked dead.
          //
          // Detached + polled, NOT run as one foreground command. Measured live on a cold box: the
          // curl + `apt-get update` + `apt-get install cloudflare-warp` chain blows past the step
          // budget, and because a step timeout aborts the WHOLE provision, the failure mode was the
          // desktop never launching at all (not merely "no WARP"). Backgrounding it means the envd
          // call returns immediately and only the bounded wait is exposed to the transport.
          run:
            `cat > /tmp/warp-install.sh <<'WARP_INSTALL_EOF'\n` +
            `CN=$(. /etc/os-release && echo "\${VERSION_CODENAME:-bookworm}")\n` +
            `curl -fsSL --max-time 120 ${WARP_APT_KEY_URL} -o /tmp/warp.gpg &&\n` +
            `  gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg /tmp/warp.gpg &&\n` +
            `  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] ${WARP_APT_REPO} $CN main" > /etc/apt/sources.list.d/cloudflare-client.list &&\n` +
            `  apt-get -o DPkg::Lock::Timeout=60 update -qq &&\n` +
            `  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends cloudflare-warp\n` +
            `WARP_INSTALL_EOF\n` +
            `nohup sh /tmp/warp-install.sh >/tmp/warp-install.log 2>&1 &\n` +
            `i=0; while [ $i -lt 90 ] && ! command -v warp-cli >/dev/null 2>&1; do i=$((i+1)); sleep 2; done; ` +
            `command -v warp-cli >/dev/null 2>&1 && echo "[provision] warp-cli installed" || echo "[provision] cloudflare-warp still installing/failed; browser will egress direct"; exit 0`,
          timeoutMs: 240_000,
        },
        {
          id: "warp-up",
          label: "bring WARP up in proxy mode (SOCKS5 on loopback)",
          // Guard on the TUNNEL being up (warp=on through the socket), not on the daemon's pid: a
          // revived box can have warp-svc running but disconnected after the infra pause/resume.
          check: `curl -s --max-time 4 --proxy socks5h://127.0.0.1:${WARP_PORT} https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^warp=on'`,
          run: `command -v warp-cli >/dev/null 2>&1 && sh /opt/warp-up.sh ${WARP_PORT} >/tmp/warp-up.log 2>&1; exit 0`,
          timeoutMs: 60_000,
        },
      ]
    : [];

  return {
    files: [
      { path: "/opt/cdp-proxy.js", content: CDP_PROXY_JS },
      { path: "/opt/start-desktop.sh", content: START_DESKTOP_SH },
      ...(warp ? [{ path: "/opt/warp-up.sh", content: WARP_UP_SH }] : []),
    ],
    steps: [
      {
        id: "mirror",
        label: "point apt at a fast CN mirror (codename read from the box)",
        // `$CN` = the box's OWN release codename so the mirror suite matches the installed distro
        // (bookworm on e2b/base, trixie on codex templates) — a mismatch skews glibc and breaks
        // the install. Modern Debian keeps sources in deb822 at sources.list.d/debian.sources; we
        // remove it and write a classic sources.list. We ALSO drop /var/lib/apt/lists/* first:
        // switching a template built against deb.debian.org (e.g. a codex base) over to USTC leaves
        // stale per-component index metadata, and the next `apt-get update -qq` then exits non-zero
        // ("doesn't have the component … / Skipping acquire"); e2b/base never hit this (its lists
        // already match the mirror). The clear runs BEFORE the heredoc so the heredoc is the last
        // token in the command — appending `&& …` after its terminator line is a shell syntax error.
        // Heredoc is UNQUOTED so `$CN` interpolates in-box; `${APT_MIRROR}` was substituted in JS above.
        run:
          `CN=$(. /etc/os-release && echo "\${VERSION_CODENAME:-bookworm}") && ` +
          `rm -f /etc/apt/sources.list.d/debian.sources && ` +
          `rm -rf /var/lib/apt/lists/* && ` +
          `cat > /etc/apt/sources.list <<IBOT_EOF\n${sourcesList}IBOT_EOF\n`,
      },
      {
        id: "apt-update",
        label: "apt-get update",
        // A box provisioned seconds after creation may still be settling: a boot-time dpkg job
        // (dpkg-db-backup/savelog observed running at t≈1s) briefly holds the lock, and egress to
        // the base image's own extra repos (e.g. nodesource) can lag. `DPkg::Lock::Timeout` makes
        // apt WAIT for the lock instead of erroring immediately; the retry loop rides out a
        // not-yet-ready mirror/repo. Defensive hardening for the auto-provision path (no human to
        // re-run it) — in the clean case attempt 1 succeeds (~4s) and the loop never retries.
        run: 'for i in 1 2 3 4 5; do apt-get -o DPkg::Lock::Timeout=60 update -qq && exit 0; echo "[provision] apt-get update attempt $i failed; retrying"; sleep 3; done; exit 1',
        timeoutMs: 240_000,
      },
      {
        id: "apt-install",
        label: "install desktop stack",
        // idempotency: skip only if the browser plumbing (chromium+websockify), the desktop
        // (openbox+xsetroot), AND both fonts (DejaVu base + WenQuanYi CJK) are all present.
        // Checking each newer piece means a box from an older recipe re-installs to pick it up
        // on next connect — the two font globs re-arm boxes that predate the full-font fix.
        check:
          "command -v chromium >/dev/null 2>&1 && command -v websockify >/dev/null 2>&1 && command -v openbox >/dev/null 2>&1 && command -v xsetroot >/dev/null 2>&1 && command -v lxterminal >/dev/null 2>&1 && command -v autocutsel >/dev/null 2>&1 && find /usr/share/fonts -iname 'DejaVuSans*' 2>/dev/null | grep -q . && find /usr/share/fonts -iname 'wqy-zenhei*' 2>/dev/null | grep -q .",
        run: aptInstall,
        timeoutMs: 480_000,
      },
      {
        id: "chrome-install",
        label: "install real Google Chrome (best-effort; falls back to chromium)",
        // idempotent: skip once the branded binary is on the overlay disk.
        check: "command -v google-chrome-stable >/dev/null 2>&1",
        // Fetch the direct .deb (one crossing to dl.google.com); `apt-get install ./file.deb`
        // resolves its deps from the already-updated USTC lists. dl.google.com may be slow or
        // blocked from the CN egress, so the whole thing is wrapped to be a NO-OP on failure —
        // `|| echo … ; exit 0` guarantees provisioning continues and the launch step then
        // resolves `chromium` instead. (provisionDesktop throws on any non-zero exit, hence exit 0.)
        run:
          `( curl -fsSL --max-time 120 -o /tmp/chrome.deb ` +
          `https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb ` +
          `&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb ` +
          `&& rm -f /tmp/chrome.deb ) ` +
          `|| echo "[provision] google-chrome install failed; falling back to chromium"; exit 0`,
        timeoutMs: 180_000,
      },
      // WARP must be installed + connected BEFORE Chrome launches: Chrome reads --proxy-server once
      // at startup and there is no runtime toggle, so a late-arriving proxy would leave the running
      // browser egressing direct until the next relaunch.
      ...warpSteps,
      {
        id: "xvfb",
        label: "start Xvfb virtual display",
        // `[X]vfb` is a regex that matches the running Xvfb but NOT this check's own shell
        // command line (which contains the literal `[X]vfb`) — avoids a pgrep -f self-match.
        check: "pgrep -f '[X]vfb :0' >/dev/null 2>&1",
        run: `nohup Xvfb :0 -screen 0 ${S.width}x${S.height}x${S.depth} >/tmp/xvfb.log 2>&1 & sleep 2`,
      },
      {
        id: "desktop",
        label: "start the desktop session (openbox + tint2 + pcmanfm)",
        // idempotent: skip if the window manager is already running on the display
        check: "pgrep -x openbox >/dev/null 2>&1",
        run: "DISPLAY=:0 nohup sh /opt/start-desktop.sh >/tmp/start-desktop.log 2>&1 & sleep 3",
      },
      {
        id: "browser",
        label: "start the browser (real Chrome if present, else chromium) with CDP on 127.0.0.1",
        // binary-agnostic guard: matches whichever browser carries the debug port.
        check: "pgrep -f '[r]emote-debugging-port' >/dev/null 2>&1",
        // Prefer real Google Chrome (see chrome-install); fall back to chromium if it's not there.
        //
        // Flag rationale:
        // - --no-sandbox: mandatory (no user namespaces in the container; root Chrome needs it).
        //   NOT JS-visible, so it's not a bot-check signal.
        // - --remote-debugging-port/-address: CDP for the agent + cdp-proxy. The port ALONE does
        //   not set navigator.webdriver — only --enable-automation would, and we never pass it.
        //   Verified: Turnstile passes with CDP attached the whole time.
        // - --disable-dev-shm-usage: /dev/shm is tiny in the container; without it Chrome crashes.
        // - --disable-blink-features=AutomationControlled: THE webdriver fix. Native, no JS rewrite,
        //   so it leaves no tamper trace for Turnstile's integrity check (a JS patch does — 300010).
        // - --proxy-server (warp only): route the browser's egress through WARP's SOCKS5 for a clean
        //   IP. Chrome-only; see DesktopProvisionOptions.warp.
        // - NO --disable-gpu: it forces software rendering and can make getContext('webgl') return
        //   null — a null WebGL context is a stronger tell than an honest SwiftShader one. We keep
        //   WebGL functional (software/SwiftShader, since the box has no GPU) and report it honestly.
        // - --enable-unsafe-swiftshader: recent Chrome gates the software-WebGL fallback; without
        //   it a GPU-less Xvfb box can yield a null WebGL context. (Ignored by older Chromium.)
        // - --lang=en-US: keeps navigator.language and the Accept-Language header consistent.
        // - --user-data-dir: a stable profile on the overlay disk so challenge cookies + client-id
        //   survive the ~24h pause/resume; pairs with --restore-last-session.
        // - --test-type: cosmetic only — hides the yellow "--no-sandbox unsupported flag" infobar
        //   (human/screenshot-visible, not JS-readable). Neither helps nor hurts the bot check.
        // - --start-maximized/--restore-last-session: fill the desktop; reopen tabs after a revive.
        run:
          `CHROME=$(command -v google-chrome-stable || command -v chromium || command -v chromium-browser); ` +
          `DISPLAY=:0 nohup "$CHROME" --no-sandbox --test-type --disable-dev-shm-usage ` +
          `--disable-blink-features=AutomationControlled --enable-unsafe-swiftshader ` +
          proxyFlag +
          `--remote-debugging-port=${P.cdp} --remote-debugging-address=127.0.0.1 ` +
          `--user-data-dir=/root/chrome-profile --lang=en-US ` +
          `--no-first-run --no-default-browser-check --restore-last-session ` +
          `--start-maximized --window-size=${S.width},${S.height} ` +
          `about:blank >/tmp/chrome.log 2>&1 & sleep 5`,
      },
      {
        id: "cdp-proxy",
        label: "start CDP Host-rewrite proxy",
        check: `pgrep -f '[c]dp-proxy.js' >/dev/null 2>&1`,
        run: "nohup node /opt/cdp-proxy.js >/tmp/cdp-proxy.log 2>&1 & sleep 2",
      },
      {
        id: "x11vnc",
        label: "start x11vnc on the display",
        // Clipboard: there is NO flag to add here. x11vnc syncs selections by default, and every
        // related option is a NEGATION (-nosel, -noprimary, -noclipboard, -nosetclipboard), so the
        // server already advertises the Extended Clipboard capabilities noVNC needs for
        // `clipboardPasteFrom` to work. Do NOT reach for `-clip`: in x11vnc 0.9.17 that is the
        // screen sub-region option (`-clip WxH+X+Y`), so a bare `-clip` swallows the next token,
        // leaves the port dangling as a stray positional argument, and x11vnc exits with
        // "unrecognized option(s)" — killing the entire desktop. (Learned the hard way, live.)
        check: `pgrep -x x11vnc >/dev/null 2>&1`,
        run: `nohup x11vnc -display :0 -forever -shared -nopw -rfbport ${P.vnc} -bg -o /tmp/x11vnc.log >/dev/null 2>&1; sleep 2`,
      },
      {
        id: "novnc",
        label: "start noVNC (websockify) live-preview bridge",
        check: `pgrep -f '[w]ebsockify' >/dev/null 2>&1`,
        run: `nohup websockify --web /usr/share/novnc ${P.novnc} localhost:${P.vnc} >/tmp/novnc.log 2>&1 & sleep 2`,
      },
    ],
    readiness: [
      {
        id: "cdp",
        command: `curl -sf --max-time 6 http://127.0.0.1:${P.cdpProxy}/json/version -o /dev/null`,
      },
      {
        id: "novnc",
        command: `curl -sf --max-time 6 http://127.0.0.1:${P.novnc}/vnc.html -o /dev/null`,
      },
      // NOTE: WARP is deliberately NOT a readiness gate. A slow/blocked WARP would otherwise mark
      // the whole desktop dead (row → kill) when everything else works; the warp-up step already
      // waited a bounded time and logged the outcome, and re-provision reconnects it.
    ],
  };
}
