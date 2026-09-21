/**
 * Single source of truth for sandbox templates. `@i-bot/core` imports these so
 * template names/ports are never scattered magic strings.
 *
 * IMPORTANT — runtime provisioning, not a pre-built image. Template build is disabled
 * at the AIProxy gateway (`403 sandbox_gateway_provider_root_mutation_disabled`), so
 * the desktop is assembled at runtime on top of `baseImage` (a stock base template that
 * already ships envd). The recipe lives in `./provision.ts`; `@i-bot/core`'s provider
 * runs it right after `Sandbox.create(baseImage)`. `templateId`/`name` are kept for the
 * day the gateway allows custom templates again — until then the provider uses `baseImage`.
 */

export interface SandboxTemplate {
  /** stable key used across the app (e.g. bots.defaultTemplate) */
  key: string;
  /** human-facing template name (for a future registered custom template) */
  name: string;
  /**
   * Concrete templateId once a custom image can be built & registered. Null today
   * (gateway blocks builds) — the provider provisions `baseImage` at runtime instead.
   */
  templateId: string | null;
  /**
   * The stock base template the box is created from, then provisioned on. Must already
   * carry envd. `e2b/base` = Debian 12 bookworm, envd 0.5.12, 2 vCPU / 1024 MB (live-verified).
   * This is the INTERNAL-channel base; the public channel lacks `e2b/base`, so the provider swaps
   * in a verified codex base there via `SandboxConfig.baseImageFor` (env `SANDBOX_PUBLIC_BASE_IMAGE`).
   */
  baseImage: string;
  /** ports the provisioned services expose inside the sandbox (reached via getHost) */
  ports: {
    /** Chrome DevTools Protocol — bound to 127.0.0.1 only (reached via cdpProxy off-box) */
    cdp: number;
    /**
     * In-box Node proxy that forwards to cdp rewriting `Host: localhost` — the port
     * browser-use actually connects to off-box. Chrome's DNS-rebinding guard rejects the
     * gateway's `<port>-<id>.<domain>` Host header on the raw cdp port, so this is required.
     */
    cdpProxy: number;
    /** raw VNC (x11vnc) */
    vnc: number;
    /** noVNC websocket bridge — live preview / human handoff in the browser */
    novnc: number;
    /** envd control channel (platform-managed; listed for reference) */
    envd: number;
  };
  /** virtual display geometry the desktop boots with */
  screen: { width: number; height: number; depth: number };
}

/** The default computer-use desktop: Xvfb + Chrome(CDP) + cdp-proxy + x11vnc + noVNC, provisioned at runtime. */
export const DESKTOP: SandboxTemplate = {
  key: "desktop",
  name: "ibot-desktop",
  templateId: null,
  baseImage: "e2b/base",
  ports: { cdp: 9222, cdpProxy: 9223, vnc: 5900, novnc: 6080, envd: 49983 },
  screen: { width: 1280, height: 800, depth: 24 },
};

export const TEMPLATES: Record<string, SandboxTemplate> = {
  [DESKTOP.key]: DESKTOP,
};

/** Look up a template by key; throws if unknown so misconfig fails loud, not silent. */
export function getTemplate(key: string): SandboxTemplate {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`Unknown sandbox template: ${key}`);
  return t;
}
