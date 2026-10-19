import {
  APT_PACKAGES,
  buildProxyPac,
  desktopProvisionPlan,
  EGRESS_STATE_PATH,
  PROXY_PAC_PATH,
  type ProvisionPlan,
  WARP_PORT,
} from "@i-bot/templates";
import { describe, expect, it } from "vitest";
import { type ProvisionTarget, ProvisionError, provisionDesktop } from "./provision.js";

/**
 * Records commands and answers per a matcher list; unmatched commands exit 0.
 *
 * `times` expires a rule after N matches, which is needed for any service whose idempotency guard and
 * readiness probe are the SAME command (the egress keeper: `pgrep -f '[w]arp-keeper.sh'`). Without it
 * a rule that makes the guard report "not yet running" also makes the readiness probe never pass, and
 * the poll loop spins until it exhausts memory rather than failing the assertion.
 */
function recordingTarget(
  rules: Array<{ match: RegExp; exitCode: number; stderr?: string; times?: number }> = [],
): {
  target: ProvisionTarget;
  commands: string[];
} {
  const commands: string[] = [];
  const used = new Map<RegExp, number>();
  const target: ProvisionTarget = {
    async run(command: string) {
      commands.push(command);
      const rule = rules.find((r) => {
        if (!r.match.test(command)) return false;
        if (r.times === undefined) return true;
        const n = used.get(r.match) ?? 0;
        if (n >= r.times) return false;
        used.set(r.match, n + 1);
        return true;
      });
      return { exitCode: rule?.exitCode ?? 0, stdout: "", stderr: rule?.stderr ?? "" };
    },
  };
  return { target, commands };
}

const fastOpts = { readinessIntervalMs: 0, sleep: async () => {} };

describe("provisionDesktop", () => {
  it("writes plan files via base64 and runs every step in order", async () => {
    // idempotency guards (command -v / pgrep) report "not yet done" so every step runs;
    // readiness curls still succeed (default exit 0).
    const { target, commands } = recordingTarget([
      // match only the idempotency guards (pgrep-based, and the apt check's websockify probe),
      // never the chromium run step which itself calls `command -v chromium`.
      { match: /pgrep|websockify >\/dev\/null/, exitCode: 1 },
    ]);
    await provisionDesktop(target, fastOpts);
    // first command materialises /opt/cdp-proxy.js through base64 -d
    expect(commands[0]).toContain("base64 -d > '/opt/cdp-proxy.js'");
    // mirror step precedes apt-update precedes apt-install. Match on stable substrings
    // (`update -qq`, `install -y`) rather than a contiguous "apt-get update" — the commands
    // now carry an `-o DPkg::Lock::Timeout=60` flag between `apt-get` and the subcommand.
    const idx = (needle: string): number => commands.findIndex((c) => c.includes(needle));
    expect(idx("/etc/apt/sources.list")).toBeGreaterThan(-1);
    expect(idx("update -qq")).toBeGreaterThan(idx("/etc/apt/sources.list"));
    expect(idx("install -y --no-install-recommends")).toBeGreaterThan(idx("update -qq"));
  });

  it("writes the apt mirror suite from the box's own release codename, not a hardcoded distro", () => {
    // Regression guard: hardcoding `bookworm` broke trixie boxes (codex templates) — glibc skew.
    // The mirror step must read VERSION_CODENAME from /etc/os-release and use it for the suite.
    const mirror = desktopProvisionPlan().steps.find((s) => s.id === "mirror");
    expect(mirror?.run).toContain("/etc/os-release");
    expect(mirror?.run).toContain("VERSION_CODENAME");
    expect(mirror?.run).toContain("$CN");
    // must NOT pin a specific distro codename in the written sources
    expect(mirror?.run).not.toContain("bookworm main");
    expect(mirror?.run).not.toContain("trixie main");
  });

  it("re-arms an older box: the apt guard covers the terminal + clipboard packages", () => {
    // An already-provisioned box satisfies a guard that only probes chromium/websockify/openbox/fonts,
    // so it would skip the whole apt-install step and never receive autocutsel — leaving the
    // start-desktop lines that launch it failing silently. Each newly added package must be probed.
    const check = desktopProvisionPlan().steps.find((s) => s.id === "apt-install")?.check ?? "";
    expect(check).toContain("command -v lxterminal");
    expect(check).toContain("command -v autocutsel");
  });

  it("skips a step whose idempotency check passes", async () => {
    // make the apt-install check ('command -v chromium ...') succeed → install skipped
    const { target, commands } = recordingTarget([
      { match: /command -v chromium .*websockify/, exitCode: 0 },
    ]);
    await provisionDesktop(target, fastOpts);
    expect(commands.some((c) => c.startsWith("DEBIAN_FRONTEND=noninteractive apt-get"))).toBe(
      false,
    );
  });

  it("polls readiness until all probes pass", async () => {
    // novnc readiness fails the first 2 times then passes
    let novncCalls = 0;
    const target: ProvisionTarget = {
      async run(command: string) {
        if (command.includes(":6080/vnc.html")) {
          novncCalls++;
          return { exitCode: novncCalls >= 3 ? 0 : 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await provisionDesktop(target, fastOpts);
    expect(novncCalls).toBe(3);
  });

  it("throws ProvisionError with the step id when a step fails", async () => {
    const { target } = recordingTarget([
      { match: /update -qq/, exitCode: 100, stderr: "mirror down" },
    ]);
    await expect(provisionDesktop(target, fastOpts)).rejects.toBeInstanceOf(ProvisionError);
    await expect(provisionDesktop(target, fastOpts)).rejects.toThrow(/apt-update/);
  });

  it("throws a readiness ProvisionError when a probe never passes before the deadline", async () => {
    const target: ProvisionTarget = {
      async run(command: string) {
        if (command.includes("/json/version")) return { exitCode: 1, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    // tiny total budget so the poll loop gives up immediately
    let t = 0;
    await expect(
      provisionDesktop(target, { ...fastOpts, totalTimeoutMs: 5, now: () => (t += 10) }),
    ).rejects.toThrow(/readiness|timeout/);
  });

  it("accepts a custom plan", async () => {
    const plan: ProvisionPlan = {
      files: [],
      steps: [{ id: "only", label: "noop", run: "echo hi" }],
      readiness: [],
    };
    const { target, commands } = recordingTarget();
    await provisionDesktop(target, fastOpts, plan);
    expect(commands).toEqual(["echo hi"]);
  });

  it("rejects within the wall-clock budget when a step's run hangs (dead transport)", async () => {
    // The failure this guards: `target.run`'s timeoutMs bounds the in-box process, not the client
    // transport — a severed gateway↔envd stream leaves this Promise unsettled forever. Without the
    // outer wall-clock race the whole provision (and the UI spinner) would hang indefinitely.
    const hang: ProvisionTarget = { run: () => new Promise(() => {}) }; // never settles
    const plan: ProvisionPlan = {
      files: [],
      steps: [{ id: "wedged", label: "hangs forever", run: "sleep infinity" }],
      readiness: [],
    };
    const err = await provisionDesktop(hang, { totalTimeoutMs: 30 }, plan).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).stepId).toBe("timeout");
    expect((err as ProvisionError).message).toMatch(/wall clock/);
  });

  it("the real desktop plan exposes cdp-proxy + novnc readiness", () => {
    const plan = desktopProvisionPlan();
    expect(plan.files.map((f) => f.path)).toContain("/opt/cdp-proxy.js");
    expect(plan.readiness.map((r) => r.id).sort()).toEqual(["cdp", "novnc"]);
  });

  it("never passes -clip to x11vnc: it is the screen sub-region flag, not clipboard", () => {
    // Regression guard for a live outage. In x11vnc 0.9.17 `-clip` takes a `WxH+X+Y` argument, so a
    // bare `-clip` eats the next token and leaves the port as a stray positional arg — x11vnc then
    // exits "unrecognized option(s)" and the whole desktop goes down. Clipboard sync is ON by
    // default in x11vnc (every related flag is a negation), so nothing needs to be added.
    const run = desktopProvisionPlan().steps.find((s) => s.id === "x11vnc")?.run ?? "";
    expect(run).not.toMatch(/-clip\b/);
    expect(run).toContain("-rfbport");
  });

  it("starts a terminal and guards it inside the script, not via the outer openbox check", () => {
    // lxterminal shipped in APT_PACKAGES but was never launched. It needs its own guard: the
    // `desktop` step short-circuits on `pgrep -x openbox`, which stays satisfied when only the
    // terminal has died — so a terminal guarded only from outside would never come back.
    const sh =
      desktopProvisionPlan().files.find((f) => f.path === "/opt/start-desktop.sh")?.content ?? "";
    expect(sh).toContain("lxterminal");
    expect(sh).toMatch(/pgrep -x lxterminal[^\n]*nohup lxterminal/);
    // The clipboard bridge's guards must name the SELECTION: `pgrep -x autocutsel` matches either
    // instance, so the second line would skip and PRIMARY would go unmirrored (verified live).
    expect(sh).toMatch(/pgrep -f 'autocutsel -selection CLIPBOARD'/);
    expect(sh).toMatch(/pgrep -f 'autocutsel -selection PRIMARY'/);
    expect(sh).not.toMatch(/pgrep -x autocutsel/);
  });

  it("writes the human-session recorder and its shell survived the template literal intact", () => {
    // The recorder is a bash script embedded in a JS template string. `${…}` is JS interpolation
    // inside String.raw, so a shell `${2:-default}` either mangles the script or breaks the build —
    // it was rewritten without `${`. Guard both the presence of the file and the exact idiom.
    const f = desktopProvisionPlan().files.find((x) => x.path === "/opt/ibot-recorder.sh");
    expect(f).toBeDefined();
    const sh = f?.content ?? "";
    expect(sh).toContain('DIR="$2"; [ -n "$DIR" ] || DIR=/tmp/ibot-rec');
    expect(sh).not.toContain("${");
    expect(sh).not.toContain("undefined");
    // the three sub-commands the API drives, and the change-detection + keyframe logic
    for (const needle of ["start)", "stop)", "status)", "_loop)", "key=1", "python3 -W ignore"]) {
      expect(sh).toContain(needle);
    }
    // `start` must begin from a clean keyboard: a modifier left held on the X server (Control_L
    // stuck after a mis-mapped Cmd release, seen live) turns every letter into a shortcut, and a
    // recording of that is garbage. Verified: keydown Control_L → start → XQueryKeymap empty.
    const startBlock = sh.slice(sh.indexOf("start)"), sh.indexOf("stop)"));
    expect(startBlock).toMatch(/xdotool keyup Control_L Control_R Shift_L/);
  });

  it("launches the browser with --restore-last-session so a revived box reopens its tabs", () => {
    // A crash / OOM-kill / ~24h pause-resume kills Chrome; the pgrep guard relaunches it. Without
    // this flag the relaunch drops the user on about:blank, losing every open tab (the reset the
    // user hit). The profile persists on disk, so the flag restores the prior session.
    const plan = desktopProvisionPlan();
    const browser = plan.steps.find((s) => s.id === "browser");
    expect(browser?.run).toContain("--restore-last-session");
  });

  it("prefers real Google Chrome and drops the WebGL-null-inducing --disable-gpu", () => {
    // Real branded Chrome fixes the UA/UA-CH/codec/TLS fingerprint for free; --disable-gpu is
    // dropped so WebGL is functional (a null context is a worse tell than a spoofed renderer).
    const plan = desktopProvisionPlan();
    const browser = plan.steps.find((s) => s.id === "browser");
    expect(browser?.run).toContain("google-chrome-stable");
    expect(browser?.run).not.toContain("--disable-gpu");
  });

  it("installs real Chrome best-effort with a chromium fallback that never fails provisioning", () => {
    const plan = desktopProvisionPlan();
    const install = plan.steps.find((s) => s.id === "chrome-install");
    // best-effort: swallow failure and exit 0 so the chromium fallback path stays viable.
    expect(install?.run).toContain("|| echo");
    expect(install?.run?.trimEnd().endsWith("exit 0")).toBe(true);
    expect(install?.check).toContain("command -v google-chrome-stable");
    // chromium must remain installed as the fallback binary.
    expect(APT_PACKAGES).toContain("chromium");
  });

  it("injects NO JS stealth patch — Turnstile's integrity check (300010) fails any native rewrite", () => {
    // Regression guard for the fix that made Cloudflare interactive Turnstile pass end-to-end:
    // a CDP-injected patch (even one writing "honest" values) makes Turnstile's api.js self-destruct
    // so the widget never renders. webdriver=false comes from the NATIVE flag instead.
    for (const warp of [false, true]) {
      const plan = desktopProvisionPlan({ warp });
      expect(plan.files.map((f) => f.path)).not.toEqual(
        expect.arrayContaining([expect.stringContaining("stealth")]),
      );
      expect(plan.steps.map((s) => s.id)).not.toContain("stealth-inject");
      const browser = plan.steps.find((s) => s.id === "browser");
      expect(browser?.run).toContain("--disable-blink-features=AutomationControlled");
      expect(browser?.run).not.toContain("--enable-automation");
    }
    // cdp-proxy.js is still written first (base64 materialised as commands[0] in other tests).
    expect(desktopProvisionPlan().files[0]?.path).toBe("/opt/cdp-proxy.js");
  });

  it("default plan (warp off) egresses direct: no WARP steps, no proxy flag, no warp/pac files", () => {
    const plan = desktopProvisionPlan();
    expect(plan.steps.map((s) => s.id)).not.toEqual(
      expect.arrayContaining(["warp-install", "warp-up"]),
    );
    expect(plan.files.map((f) => f.path)).not.toContain("/opt/warp-up.sh");
    expect(plan.files.map((f) => f.path)).not.toContain(PROXY_PAC_PATH);
    const browser = plan.steps.find((s) => s.id === "browser");
    expect(browser?.run).not.toContain("--proxy-server");
    expect(browser?.run).not.toContain("--proxy-pac-url");
  });

  it("warp plan steers ONLY the browser via a split PAC (CN direct, rest SOCKS5) and brings WARP up before Chrome", () => {
    const plan = desktopProvisionPlan({ warp: true });
    const ids = plan.steps.map((s) => s.id);
    // install + connect BEFORE the browser launches: Chrome reads the PAC once at startup.
    expect(ids.indexOf("warp-install")).toBeGreaterThan(ids.indexOf("apt-update"));
    expect(ids.indexOf("warp-up")).toBeGreaterThan(ids.indexOf("warp-install"));
    expect(ids.indexOf("browser")).toBeGreaterThan(ids.indexOf("warp-up"));
    // Chrome gets a data: PAC (file:// PAC URLs are rejected by Chrome), not a flat --proxy-server
    // — a flat flag would drag domestic sites through WARP's overseas-looking IP too.
    const browser = plan.steps.find((s) => s.id === "browser");
    expect(browser?.run).not.toContain("--proxy-server");
    const m =
      /--proxy-pac-url='data:application\/x-ns-proxy-autoconfig;base64,([A-Za-z0-9+/=]+)'/.exec(
        browser?.run ?? "",
      );
    expect(m).not.toBeNull();
    const pac = Buffer.from(m![1]!, "base64").toString("ascii");
    expect(pac).toBe(
      buildProxyPac({ socksHost: "127.0.0.1", socksPort: WARP_PORT, fallbackDirect: false }),
    );
    // Fail closed: no `; DIRECT` tail. With one, a dead tunnel silently egresses from the box's
    // datacenter IP and a CF-walled page just never shows a challenge — the exact day-long outage
    // this reversal exists to prevent.
    expect(pac).toContain("SOCKS5 127.0.0.1:40000");
    expect(pac).not.toContain("; DIRECT");
    // A readable copy is materialised for on-box debugging; the bring-up script pins the same port.
    expect(plan.files.find((f) => f.path === PROXY_PAC_PATH)?.content).toBe(pac);
    expect(plan.files.map((f) => f.path)).toContain("/opt/warp-up.sh");
    expect(plan.files.find((f) => f.path === "/opt/warp-up.sh")?.content).toContain("mode proxy");
    expect(plan.steps.find((s) => s.id === "warp-up")?.run).toContain("/opt/warp-up.sh 40000");
  });

  it("egressFallbackDirect: true opts a box back into the leaky-but-always-working fallback", () => {
    const plan = desktopProvisionPlan({ warp: true, egressFallbackDirect: true });
    expect(plan.files.find((f) => f.path === PROXY_PAC_PATH)?.content).toContain(
      "SOCKS5 127.0.0.1:40000; DIRECT",
    );
  });

  // ---- recovery: the reason this stopped being a one-shot bring-up ------------------------------
  it("verifies the TUNNEL, never warp-cli's own word for it", () => {
    // Measured live: `warp-cli connect` answered `Success` while status stayed `Disconnected`, and
    // `pgrep warp-svc` matched a daemon whose SOCKS port wasn't even listening. Both are useless as
    // readiness. Only bytes back through the socket prove anything.
    const plan = desktopProvisionPlan({ warp: true });
    const verify = plan.files.find((f) => f.path === "/opt/warp-verify.sh")?.content ?? "";
    expect(verify).toContain("--proxy");
    expect(verify).toContain("cdn-cgi/trace");
    expect(verify).toContain("warp=on");
    // The step's idempotency guard must be that same check, not a pid test.
    const up = plan.steps.find((s) => s.id === "warp-up");
    expect(up?.check).toContain("warp-verify.sh");
    expect(up?.check).not.toContain("pgrep");
  });

  it("escalates instead of retrying, because the failing command reports success", () => {
    // A plain retry loop was measured useless: connect failed, disconnect+connect failed the same
    // way. Setting the tunnel protocol is what rebuilt it, so each rung must do something MORE
    // drastic than the last, and both protocols get a turn (WireGuard was dead on this path while
    // MASQUE was healthy — that's a property of the network, not of our config).
    const up =
      desktopProvisionPlan({ warp: true }).files.find((f) => f.path === "/opt/warp-up.sh")
        ?.content ?? "";
    for (const rung of [
      "connect",
      "disconnect",
      "tunnel protocol set",
      "MASQUE",
      "WireGuard",
      "pkill -x warp-svc",
      "registration delete",
    ]) {
      expect(up).toContain(rung);
    }
    // every rung ends in a real verify, and exhaustion is a FAILURE, not a shrug
    expect(up).toContain("warp-verify.sh");
    expect(up).toContain("exit 1");
    expect(up).not.toContain("mode warp"); // would sever envd/noVNC
  });

  it("keeps a supervisor running, because a tunnel dying mid-session is the actual failure", () => {
    // Provision-time recovery fixes a box at connect and does nothing for hour 2. The keeper holds
    // the invariant for the life of the box and publishes the verdict for the platform to read.
    const plan = desktopProvisionPlan({ warp: true });
    const keeper = plan.files.find((f) => f.path === "/opt/warp-keeper.sh")?.content ?? "";
    expect(keeper).toContain("warp-verify.sh");
    expect(keeper).toContain("warp-up.sh");
    expect(keeper).toContain(EGRESS_STATE_PATH);
    expect(keeper).toMatch(/while :/); // a loop, not a one-shot
    expect(keeper).toContain("MAX_BACKOFF"); // bounded: rung 7 re-registers, don't spin it

    const step = plan.steps.find((s) => s.id === "warp-keeper");
    // Bracketed pattern: an unbracketed `pgrep -f warp-keeper` matches the shell running the check.
    expect(step?.check).toContain("[w]arp-keeper.sh");
    // setsid + all three fds, or the child holds envd's stdout open and the call never returns.
    expect(step?.run).toContain("setsid");
    expect(step?.run).toContain("< /dev/null");
    // And the `&` must background the setsid ALONE. `cmd && setsid … &` backgrounds the whole list,
    // so bash forks a waiting subshell that keeps envd's stdout open — measured: a live provision
    // timed out at exactly this step while the keeper it launched was running fine.
    expect(step?.run).not.toMatch(/&&[^\n]*&\s*$/m);
    const launch = (step?.run ?? "").split("\n").find((l) => l.includes("setsid")) ?? "";
    expect(launch.trimEnd().endsWith("&")).toBe(true);
    expect(launch).not.toContain("&&");
    // The keeper RUNNING is a readiness gate (it can't fail for network reasons); WARP being up is
    // deliberately not one, or a Cloudflare outage would mark the whole desktop dead.
    expect(plan.readiness.map((r) => r.id)).toContain("warp-keeper");
    expect(plan.readiness.map((r) => r.id)).not.toContain("warp-up");
  });

  it("ships none of the egress machinery when warp is off", () => {
    const plan = desktopProvisionPlan();
    const paths = plan.files.map((f) => f.path);
    expect(paths).not.toContain("/opt/warp-verify.sh");
    expect(paths).not.toContain("/opt/warp-keeper.sh");
    expect(plan.steps.map((s) => s.id)).not.toContain("warp-keeper");
    expect(plan.readiness.map((r) => r.id)).not.toContain("warp-keeper");
  });

  it("directDomains extends the PAC whitelist only when warp is on", () => {
    const on = desktopProvisionPlan({ warp: true, directDomains: ["corp.example"] });
    expect(on.files.find((f) => f.path === PROXY_PAC_PATH)?.content).toContain('"corp.example":1');
    const off = desktopProvisionPlan({ directDomains: ["corp.example"] });
    expect(off.files.map((f) => f.path)).not.toContain(PROXY_PAC_PATH);
  });

  it("warp steps are best-effort and never gate readiness (a slow WARP must not kill the desktop)", () => {
    const plan = desktopProvisionPlan({ warp: true });
    const install = plan.steps.find((s) => s.id === "warp-install");
    const up = plan.steps.find((s) => s.id === "warp-up");
    // both swallow failure like chrome-install so provisioning continues on a blocked repo.
    expect(install?.run?.trimEnd().endsWith("exit 0")).toBe(true);
    expect(up?.run?.trimEnd().endsWith("exit 0")).toBe(true);
    // idempotency: install skips once warp-cli exists; up is guarded on the TUNNEL passing traffic
    // (warp-verify.sh), not the daemon pid — a revived box routinely has warp-svc alive but
    // disconnected, which is precisely the state that went unnoticed for a day.
    expect(install?.check).toContain("command -v warp-cli");
    expect(up?.check).toContain("warp-verify.sh");
    // WARP being UP still gates nothing. The keeper RUNNING does: it can't fail for network reasons,
    // and it's what guarantees the box never sits with a silently dirty egress.
    expect(plan.readiness.map((r) => r.id).sort()).toEqual(["cdp", "novnc", "warp-keeper"]);
  });

  it("warp-install never touches system routes: proxy mode only (management plane stays reachable)", () => {
    // The PPIO edge relay carries noVNC + envd (the SDK channel). A full-tunnel WARP would sever
    // both; proxy mode never edits routes or resolv.conf. Guard the mode literally.
    const sh = desktopProvisionPlan({ warp: true }).files.find((f) => f.path === "/opt/warp-up.sh");
    expect(sh?.content).toContain("mode proxy");
    expect(sh?.content).not.toMatch(/mode warp\b/);
  });

  it("provisionDesktop threads opts.warp into the default plan", async () => {
    // The keeper's guard and its readiness probe are the same pgrep, so the "not running" answer has
    // to expire — otherwise readiness could never pass. `times` counts the guards for x11vnc, novnc
    // and the keeper (plus the apt check's websockify probe).
    const { target, commands } = recordingTarget([
      { match: /pgrep|websockify >\/dev\/null/, exitCode: 1, times: 8 },
    ]);
    await provisionDesktop(target, { ...fastOpts, warp: true });
    expect(commands.some((c) => c.includes("--proxy-pac-url='data:"))).toBe(true);
    expect(commands.some((c) => c.includes("base64 -d > '/opt/warp-up.sh'"))).toBe(true);
    expect(commands.some((c) => c.includes("base64 -d > '/opt/warp-verify.sh'"))).toBe(true);
    expect(commands.some((c) => c.includes("base64 -d > '/opt/warp-keeper.sh'"))).toBe(true);
    // the keeper is actually LAUNCHED, not merely written
    expect(commands.some((c) => c.includes("setsid sh /opt/warp-keeper.sh"))).toBe(true);
    expect(commands.some((c) => c.includes(`base64 -d > '${PROXY_PAC_PATH}'`))).toBe(true);

    const direct = recordingTarget([{ match: /pgrep|websockify >\/dev\/null/, exitCode: 1 }]);
    await provisionDesktop(direct.target, fastOpts);
    expect(direct.commands.some((c) => c.includes("--proxy-pac-url"))).toBe(false);
  });
});
