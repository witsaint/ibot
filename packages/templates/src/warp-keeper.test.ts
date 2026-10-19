import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopProvisionPlan, WARP_KEEPER_SH } from "./provision.js";

describe("WARP keeper startup", () => {
  it("launches the keeper before warp-cli is installed so desktop readiness can pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibot-keeper-"));
    const marker = join(dir, "started");
    try {
      // No warp-cli in this PATH. setsid records a launch without starting a real service.
      writeFileSync(join(dir, "setsid"), `#!/bin/sh\necho started > '${marker}'\n`, {
        mode: 0o755,
      });
      const command = desktopProvisionPlan({ warp: true })
        .steps.find((s) => s.id === "warp-keeper")!
        .run.replace("/tmp/warp-keeper.boot", join(dir, "boot.log"));
      execFileSync("/bin/sh", ["-c", command], { env: { PATH: dir }, stdio: "ignore" });
      // The launch is detached; allow the child to write its marker before checking.
      execFileSync("/bin/sh", [
        "-c",
        `i=0; while [ ! -f '${marker}' ] && [ "$i" -lt 50 ]; do sleep 0.01; i=$((i+1)); done`,
      ]);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe("started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("starts installation instead of matching its own launch command as an existing installer", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibot-warp-install-"));
    const marker = join(dir, "started");
    try {
      writeFileSync(join(dir, "setsid"), `#!/bin/sh\necho started > '${marker}'\n`, {
        mode: 0o755,
      });
      // Linux pgrep can report the parent shell whose command contains the installer launch.
      writeFileSync(join(dir, "pgrep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const command = desktopProvisionPlan({ warp: true })
        .steps.find((s) => s.id === "warp-install")!
        .run.replaceAll("/tmp/", `${dir}/`);
      execFileSync("/bin/sh", ["-c", command], {
        env: { PATH: `${dir}:/usr/bin:/bin` },
        stdio: "ignore",
      });
      execFileSync("/bin/sh", [
        "-c",
        `i=0; while [ ! -f '${marker}' ] && [ "$i" -lt 50 ]; do sleep 0.01; i=$((i+1)); done`,
      ]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes unavailable egress while installation is pending and recovers when the client appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ibot-keeper-loop-"));
    const statePath = join(dir, "ibot-egress.json");
    const script = WARP_KEEPER_SH.replaceAll("/tmp/", `${dir}/`)
      .replaceAll("/opt/", `${dir}/`)
      .replace("INTERVAL=30", "INTERVAL=0.02");
    writeFileSync(
      join(dir, "warp-verify.sh"),
      '#!/bin/sh\ncommand -v warp-cli >/dev/null 2>&1 || exit 1\necho "ip=test warp=on"\n',
    );
    writeFileSync(join(dir, "warp-up.sh"), "#!/bin/sh\nexit 0\n");
    const child = spawn("/bin/sh", ["-c", script], {
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      stdio: "ignore",
    });
    const waitForState = async (ok: boolean) => {
      for (let i = 0; i < 100; i++) {
        if (existsSync(statePath)) {
          const state = JSON.parse(readFileSync(statePath, "utf8"));
          if (state.ok === ok) return state;
        }
        // Poll this one state file sequentially; later checks depend on earlier results.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`keeper did not publish ok=${ok}`);
    };
    try {
      expect((await waitForState(false)).detail).toContain("waiting for installation");
      expect(child.exitCode).toBeNull();
      writeFileSync(join(dir, "warp-cli"), '#!/bin/sh\necho "tunnel protocol: MASQUE"\n', {
        mode: 0o755,
      });
      expect((await waitForState(true)).detail).toContain("warp=on");
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
