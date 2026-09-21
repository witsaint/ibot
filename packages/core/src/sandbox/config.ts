/**
 * Sandbox provider configuration: validate the env, and produce the SDK connection
 * options every control-plane call must carry. Centralised so the `/c/{slug}` guard
 * and the "override apiUrl, never domain" rule are enforced in exactly one place.
 *
 * See the `ppio-sandbox-aiproxy` skill + docs/aiproxysandbox.md for the rules encoded here.
 */
import { z } from "zod";

/**
 * Raw env contract. `SANDBOX_CONTROL_PLANE_URL` must carry a channel slug (`/c/{slug}`):
 * a bare `/sandbox` returns 409 ambiguous_sandbox_channel once >1 ppio channel exists,
 * so we fail construction here rather than at the first request.
 */
/** Accept the usual truthy spellings for a boolean-ish env var; anything else (incl. unset) is false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1" || v?.toLowerCase() === "yes");

/** The public egress channel slug (upstream-direct, runtime `sandbox.ppio.cn`) — the clean IP
 * path for anti-detection work. The internal slug (`ppio-sandbox-internal`) is the gateway proxy
 * domain. Slug ≠ runtime domain and they are NOT interchangeable, but the runtime domain is
 * discovered at connect time (not baked into the control-plane URL), so switching egress is just
 * swapping the `/c/{slug}` segment — which is exactly what `SANDBOX_PUBLIC` does. */
const DEFAULT_PUBLIC_SLUG = "ppio-sandbox-public";

/**
 * The public channel does NOT carry the `e2b/base` alias the internal channel does — creating
 * from it there fails `400 Invalid environment ID`. A codex-family base (`ppcodex`, envd 0.2.0,
 * Debian 13 trixie) is the verified stock base on public: the runtime `provisionDesktop` recipe
 * installs the full desktop (real Chrome + CDP@9223 + noVNC) on it end-to-end. This is the
 * per-channel replacement for `e2b/base` when a box lands on the public egress channel. Override
 * with `SANDBOX_PUBLIC_BASE_IMAGE` if the gateway later registers a different public base. */
const DEFAULT_PUBLIC_BASE_IMAGE = "zsob2dxzqa2lcepse0b0";

export const SandboxEnv = z.object({
  /** the single AIProxy gateway credential (fed to the SDK as the api key) */
  AIPROXY_API_KEY: z.string().min(1, "AIPROXY_API_KEY is required"),
  /** control plane incl. channel slug, e.g. https://apiproxy.paigod.work/sandbox/c/ppio-sandbox-internal */
  SANDBOX_CONTROL_PLANE_URL: z
    .string()
    .url("SANDBOX_CONTROL_PLANE_URL must be a URL")
    .refine((u) => u.includes("/c/"), {
      message: "SANDBOX_CONTROL_PLANE_URL must include a channel slug (/c/{slug})",
    }),
  /** optional: the channel slug on its own, for logging/telemetry (not required to route) */
  SANDBOX_CHANNEL_SLUG: z.string().min(1).optional(),
  /** flip to the public egress channel without rewriting the whole URL — swaps the `/c/{slug}`
   * segment of SANDBOX_CONTROL_PLANE_URL to SANDBOX_PUBLIC_SLUG (default `ppio-sandbox-public`). */
  SANDBOX_PUBLIC: boolish,
  /** override the slug SANDBOX_PUBLIC switches to (defaults to `ppio-sandbox-public`). */
  SANDBOX_PUBLIC_SLUG: z.string().min(1).optional(),
  /** override the stock base image used when a box lands on the public channel (the public channel
   * lacks `e2b/base`); defaults to the verified codex base `zsob2dxzqa2lcepse0b0`. */
  SANDBOX_PUBLIC_BASE_IMAGE: z.string().min(1).optional(),
});
export type SandboxEnv = z.infer<typeof SandboxEnv>;

/** Rewrite the `/c/{slug}` segment of a control-plane URL to `slug`. Preserves everything else. */
export function withChannelSlug(controlPlaneUrl: string, slug: string): string {
  return controlPlaneUrl.replace(/\/c\/[^/?#]+/, `/c/${slug}`);
}

/** Read the channel slug out of a control-plane URL's `/c/{slug}` segment (undefined if absent). */
export function slugFromUrl(controlPlaneUrl: string): string | undefined {
  return /\/c\/([^/?#]+)/.exec(controlPlaneUrl)?.[1];
}

/** Options fed to every SDK control-plane call. Never includes `domain`. */
export interface SdkConnectionOpts {
  /** the AIProxy key, passed as the SDK's apiKey */
  apiKey: string;
  /** control-plane base incl. slug — overrides the SDK's apiUrl, NOT its domain */
  apiUrl: string;
}

/** Validated config + derived SDK wiring. */
export interface SandboxConfig {
  readonly apiKey: string;
  /** the env-default control-plane URL (public slug already swapped in if SANDBOX_PUBLIC). */
  readonly apiUrl: string;
  /** the env-default channel slug (public if SANDBOX_PUBLIC, else SANDBOX_CHANNEL_SLUG). */
  readonly channelSlug: string | undefined;
  /**
   * Whether the fleet default (env `SANDBOX_PUBLIC`) routes through the public egress channel.
   * The seed for a per-bot toggle: a bot that hasn't explicitly chosen inherits this. Surfaced
   * to the UI so a "public egress" checkbox can initialise to the fleet default.
   */
  readonly defaultPublic: boolean;
  /**
   * Connection opts to spread into an SDK control-plane call. With no `slug`, uses the env-default
   * `apiUrl` (back-compat: an old box with no persisted channel reconnects where it was created).
   * With an explicit `slug`, rebuilds the URL from the raw control-plane base so a per-bot channel
   * fully determines routing regardless of the fleet default.
   */
  sdkConnectionOpts(slug?: string): SdkConnectionOpts;
  /**
   * Resolve a per-bot public/internal preference to a concrete channel slug. `pref` is the bot's
   * stored `sandbox_public` (true = public, false = internal, null/undefined = inherit the fleet
   * default `SANDBOX_PUBLIC`). The result is what gets passed to create and stamped into the box's
   * persisted meta so every later reconnect returns to the SAME channel.
   */
  channelSlugFor(pref: boolean | null | undefined): string;
  /**
   * Resolve the stock base image to create a box from, given the template's own default base and the
   * channel `slug` the box will land on. The public channel lacks `e2b/base`, so a box routed there
   * gets the public base (env `SANDBOX_PUBLIC_BASE_IMAGE`, default a verified codex base) instead;
   * the internal channel (or a slug-less env-default create) keeps the template's own base. A caller
   * that already has a concrete registered `templateId` should prefer that and never call this.
   */
  baseImageFor(defaultBaseImage: string, slug?: string): string;
  /**
   * Whether the desktop on channel `slug` should route its BROWSER through Cloudflare WARP for a
   * clean egress IP. The public channel's own IP is a datacenter ASN that Cloudflare challenges hard
   * (interactive Turnstile never renders); WARP proxy-mode is what lets a bot there pass. The
   * internal channel keeps direct egress: it's where corporate-internal hosts are reachable, and
   * WARP would hide them from the browser. Same slug→channel resolution as `baseImageFor`.
   */
  warpFor(slug?: string): boolean;
  /**
   * Set PPIO_API_KEY / E2B_API_KEY in the process env to the AIProxy key. E2B/PPIO
   * tooling reads these globals; call once at startup. We still pass apiKey/apiUrl
   * explicitly to every SDK call, so this is belt-and-suspenders for code paths that
   * read the env directly.
   */
  bootstrapSdkEnv(): void;
}

/**
 * Build a validated config from a raw env bag (defaults to `process.env`). Throws a
 * ZodError with a readable message if anything is missing or the URL lacks `/c/`.
 */
export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const parsed = SandboxEnv.parse({
    AIPROXY_API_KEY: env.AIPROXY_API_KEY,
    SANDBOX_CONTROL_PLANE_URL: env.SANDBOX_CONTROL_PLANE_URL,
    SANDBOX_CHANNEL_SLUG: env.SANDBOX_CHANNEL_SLUG,
    SANDBOX_PUBLIC: env.SANDBOX_PUBLIC,
    SANDBOX_PUBLIC_SLUG: env.SANDBOX_PUBLIC_SLUG,
    SANDBOX_PUBLIC_BASE_IMAGE: env.SANDBOX_PUBLIC_BASE_IMAGE,
  });

  // The raw control-plane base carries the INTERNAL slug (e.g. .../c/ppio-sandbox-internal).
  // `publicSlug` is the egress channel (clean IP for anti-detection). Both are known up front;
  // per-call routing picks between them. The runtime domain is still discovered at connect time,
  // so switching egress is only ever a `/c/{slug}` swap.
  const controlPlaneUrl = parsed.SANDBOX_CONTROL_PLANE_URL;
  const publicSlug = parsed.SANDBOX_PUBLIC_SLUG ?? DEFAULT_PUBLIC_SLUG;
  const internalSlug = parsed.SANDBOX_CHANNEL_SLUG ?? slugFromUrl(controlPlaneUrl) ?? "";
  const defaultPublic = parsed.SANDBOX_PUBLIC;
  const publicBaseImage = parsed.SANDBOX_PUBLIC_BASE_IMAGE ?? DEFAULT_PUBLIC_BASE_IMAGE;

  // The env-default apiUrl: public slug swapped in when SANDBOX_PUBLIC is set (fleet default),
  // else the raw control-plane URL untouched. This is what a slug-less connect uses.
  const apiUrl = defaultPublic ? withChannelSlug(controlPlaneUrl, publicSlug) : controlPlaneUrl;
  const channelSlug = defaultPublic ? publicSlug : parsed.SANDBOX_CHANNEL_SLUG;

  return {
    apiKey: parsed.AIPROXY_API_KEY,
    apiUrl,
    channelSlug,
    defaultPublic,
    sdkConnectionOpts(slug?: string): SdkConnectionOpts {
      // An explicit per-bot slug rebuilds routing from the raw base so it fully determines the
      // channel; without one, fall back to the env-default apiUrl (slug-less reconnect of an old box).
      const url = slug ? withChannelSlug(controlPlaneUrl, slug) : apiUrl;
      return { apiKey: parsed.AIPROXY_API_KEY, apiUrl: url };
    },
    channelSlugFor(pref: boolean | null | undefined): string {
      // null/undefined → inherit the fleet default; true → public; false → internal.
      const isPublic = pref ?? defaultPublic;
      return isPublic ? publicSlug : internalSlug;
    },
    baseImageFor(defaultBaseImage: string, slug?: string): string {
      // Which channel does this box actually land on? An explicit slug decides directly; a slug-less
      // create uses the env-default channel, which is public only when SANDBOX_PUBLIC is set. The
      // public channel lacks e2b/base, so swap in the public base there; internal keeps the default.
      const isPublic = slug ? slug === publicSlug : defaultPublic;
      return isPublic ? publicBaseImage : defaultBaseImage;
    },
    warpFor(slug?: string): boolean {
      // Public channel ⇒ datacenter egress ⇒ WARP the browser. Internal ⇒ direct (corp hosts).
      return slug ? slug === publicSlug : defaultPublic;
    },
    bootstrapSdkEnv(): void {
      process.env.PPIO_API_KEY = parsed.AIPROXY_API_KEY;
      process.env.E2B_API_KEY = parsed.AIPROXY_API_KEY;
    },
  };
}
