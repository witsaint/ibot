/**
 * Build & register the i-bot desktop template with the PPIO/AIProxy control plane,
 * using the ppio-sandbox library's remote build API (no local Docker daemon).
 *
 * Run: `pnpm --filter @i-bot/templates template:build` (or `tsx scripts/build-template.ts`).
 *
 * Env (see the `ppio-sandbox-aiproxy` skill + docs/aiproxysandbox.md):
 *   AIPROXY_API_KEY            the single gateway credential
 *   SANDBOX_CONTROL_PLANE_URL  control plane incl. channel slug, e.g.
 *                              https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-internal
 *
 * On success it prints the templateId — paste it into src/manifest.ts (DESKTOP.templateId)
 * and desktop/ppio.toml (template_id). Until then the provider falls back to the alias
 * `ibot-desktop`, which the control plane also resolves.
 *
 * NOTE ON TRANSPILATION: `fromDockerfile` does NOT ship the Dockerfile verbatim — the
 * library parses it and re-emits each instruction as a builder call. COPY sources resolve
 * against `fileContextPath` (must be desktop/), and a Dockerfile with no explicit USER/WORKDIR
 * gets `user`/`/home/user` appended (wrong for our root-based supervisord boot) — desktop.Dockerfile
 * declares `USER root`/`WORKDIR /root` for exactly this reason. Keep them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type LogEntry, Template, TemplateBase } from "ppio-sandbox";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "../desktop");
const dockerfilePath = path.join(desktopDir, "desktop.Dockerfile");

const ALIAS = "ibot-desktop";
// The concrete spec is fixed by the template on the control-plane side (create-time
// cpuCount/memoryMB in the sandbox-create body are silently ignored); these values
// are what the *template* is registered with. Keep in sync with desktop/ppio.toml.
const CPU_COUNT = 2;
const MEMORY_MB = 4096;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("AIPROXY_API_KEY");
  const apiUrl = requireEnv("SANDBOX_CONTROL_PLANE_URL");

  // The control plane URL MUST carry a channel slug (/c/{slug}); a bare /sandbox
  // returns 409 ambiguous_sandbox_channel once >1 ppio channel is enabled. Fail
  // here rather than let the gateway reject us mid-build.
  if (!apiUrl.includes("/c/")) {
    throw new Error(
      `SANDBOX_CONTROL_PLANE_URL must include a channel slug (/c/{slug}); got: ${apiUrl}`,
    );
  }

  // E2B/PPIO-compatible tooling reads PPIO_API_KEY / E2B_API_KEY from the env; feed
  // both the AIProxy gateway key. We ALSO pass apiKey/apiUrl explicitly to build()
  // below (belt and suspenders) and never set `domain` (the SDK would prepend `api.`).
  process.env.PPIO_API_KEY = apiKey;
  process.env.E2B_API_KEY = apiKey;

  // fileContextPath MUST be desktop/ so the COPY sources (supervisord.conf, entrypoint.sh,
  // start-chrome.sh) resolve — the library tars this dir as the build context. Without it,
  // context defaults to THIS script's dir and the COPYs would 404.
  const template = Template({ fileContextPath: desktopDir }).fromDockerfile(
    readFileSync(dockerfilePath, "utf-8"),
  );

  console.log(`Building "${ALIAS}" via ${apiUrl}`);
  console.log(`  context: ${desktopDir}`);
  console.log(`  spec:    ${CPU_COUNT} vCPU / ${MEMORY_MB} MB (template-fixed)`);

  // build() blocks until the remote build reaches `ready`, streaming logs via
  // onBuildLogs, and throws BuildError on `error`. No manual polling needed.
  const info = await TemplateBase.build(template, {
    alias: ALIAS,
    cpuCount: CPU_COUNT,
    memoryMB: MEMORY_MB,
    apiKey,
    apiUrl,
    onBuildLogs: (entry: LogEntry) => {
      console.log(`[${entry.level}] ${entry.message}`);
    },
  });

  console.log("\n✅ Build ready.");
  console.log(`   templateId: ${info.templateId}`);
  console.log(`   alias:      ${info.alias}`);
  console.log(`   buildId:    ${info.buildId}`);
  console.log(
    "\nNext: paste templateId into packages/templates/src/manifest.ts (DESKTOP.templateId) " +
      "and desktop/ppio.toml (template_id).",
  );
}

main().catch((err: unknown) => {
  console.error("\n❌ Template build failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
