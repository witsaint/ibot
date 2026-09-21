/**
 * Pure functions over a PPIO sandbox's persisted routing metadata. No SDK, no I/O —
 * so apps/api can rebuild a runtime host or a preview URL from a DB row alone (e.g.
 * to render `SandboxInfo.streamUrl`) without holding a live handle.
 *
 * WHY THIS SHAPE (verified against ppio-sandbox@2.1.1 source, not guessed):
 * - The SDK instance's `.sandboxId` already folds in the clientId as the composite
 *   `sandboxID-clientID` (create maps `data.clientID ? `${sandboxID}-${clientID}` : sandboxID`).
 * - `getHost(port)` builds `${port}-${sandboxId}.${domain}`, which with the composite id
 *   yields the documented runtime host `${port}-${sandboxID}-${clientID}.${domain}`.
 * - `connect(sandboxId)` stores the id verbatim — so the COMPOSITE is what must be
 *   persisted as `providerSandboxId` to reconnect later.
 *
 * Therefore `clientId` need not be stored separately; it is already inside
 * `providerSandboxId`. Meta only needs what the SDK does NOT put in the id: the
 * runtime `domain` and the `envdVersion` (for the version gate on reconnect).
 *
 * PREFER a live `handle.getHost(port)` when connected — it is always authoritative.
 * These reconstructions are the no-connection fallback.
 */
import { DESKTOP } from "@i-bot/templates";
import { z } from "zod";

/** noVNC bridge port inside the desktop template (websockify → x11vnc:5900). */
const NOVNC_PORT = DESKTOP.ports.novnc;

/**
 * Persisted routing bits for a PPIO/AIProxy sandbox. Kept minimal on purpose: the
 * clientId lives inside `providerSandboxId` (the composite), never duplicated here.
 */
export const PpioProviderMeta = z.object({
  /** runtime host suffix returned by create/connect (`data.domain`), e.g. sandbox.paigod.work */
  domain: z.string().min(1),
  /** envd version reported at create; used to gate reconnect (SDK needs >= 0.5.0) */
  envdVersion: z.string().min(1),
  /**
   * The control-plane channel slug this box was CREATED on — the authoritative routing for every
   * later connect/timeout/delete. A box lives on one upstream backend (internal vs public egress);
   * reconnecting it through a different channel 502s. Persisted so a reconnect returns to the same
   * channel even if the bot's toggle (or the fleet default) later changes. Optional for back-compat:
   * rows created before per-bot channels have none, and connect falls back to the env-default URL
   * (correct — they were created there).
   */
  channelSlug: z.string().min(1).optional(),
});
export type PpioProviderMeta = z.infer<typeof PpioProviderMeta>;

/**
 * Parse an untyped `providerMeta` record (as persisted in `sandboxes.provider_meta`)
 * into the typed shape, throwing if it's malformed. Provider/apps-api call this at the
 * trust boundary rather than casting.
 */
export function parseProviderMeta(meta: Record<string, unknown>): PpioProviderMeta {
  return PpioProviderMeta.parse(meta);
}

/**
 * Rebuild the runtime host for an exposed port WITHOUT a live handle, from the
 * composite `providerSandboxId` + persisted domain. Mirrors the SDK's own
 * `getHost`: `${port}-${sandboxId}.${domain}`.
 */
export function runtimeHost(
  providerSandboxId: string,
  meta: PpioProviderMeta,
  port: number,
): string {
  return `${port}-${providerSandboxId}.${meta.domain}`;
}

/**
 * noVNC preview URL for the UI (live desktop preview / pre-handoff view).
 *
 * Uses `vnc_lite.html`, NOT the full `vnc.html`: the full client ships a dark control
 * dock (settings / clipboard / fullscreen / disconnect) that clashes with our chrome and
 * whose fullscreen button trips the iframe's permissions policy. The lite client is a bare
 * canvas — we frame it ourselves. Params: `scale=true` fits the desktop into the pane
 * (letterboxed, aspect kept); `view_only=true` is a client-side default only — real control
 * arbitration is enforced in apps/api, never by this URL. Lite auto-connects on load, so no
 * `autoconnect` param is needed.
 *
 * Scheme is https to match the SDK's non-debug default.
 */
export function streamUrl(providerSandboxId: string, meta: PpioProviderMeta): string {
  const host = runtimeHost(providerSandboxId, meta, NOVNC_PORT);
  return `https://${host}/vnc_lite.html?scale=true&view_only=true`;
}
