/**
 * Single source of truth for sandbox templates. `@i-bot/core` imports these so
 * template names/ports are never scattered magic strings.
 *
 * The image itself is built from `desktop/` via `pnpm template:build`, which
 * registers it with the PPIO/AIProxy control plane and prints the `templateId`.
 * Record that id back here (or resolve by `name` at runtime — the control plane
 * accepts either).
 */

export interface SandboxTemplate {
  /** stable key used across the app (e.g. bots.defaultTemplate) */
  key: string;
  /** human-facing template name registered with the control plane */
  name: string;
  /**
   * Concrete templateId once built & registered. Null until first build.
   * Runtime may fall back to `name`, which the control plane also resolves.
   */
  templateId: string | null;
  /** ports the boot services expose inside the sandbox (reached via getHost) */
  ports: {
    /** Chrome DevTools Protocol — browser-use / CDP client */
    cdp: number;
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

/** The default computer-use desktop: Xvfb + openbox + Chrome(CDP) + x11vnc + noVNC + ffmpeg. */
export const DESKTOP: SandboxTemplate = {
  key: "desktop",
  name: "ibot-desktop",
  templateId: null,
  ports: { cdp: 9222, vnc: 5900, novnc: 6080, envd: 49983 },
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
