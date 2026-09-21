/**
 * Resolve any thrown value into one display string for the UI.
 *
 * Single source of truth for error copy is the SERVER: every API route returns `{ error, message }`
 * where `message` is the user-facing (Chinese) text, and `req()` surfaces that as `ApiError.message`.
 * So this helper just TRUSTS that message — it does not keep its own per-code copy (that would be
 * duplicate config drifting out of sync with the backend). It only steps in when there's nothing
 * human to show: a bare machine code slipped through without a message, or a non-API error (network,
 * aborted fetch) with no useful text. `overrides` lets one screen relabel a specific code locally.
 */
import { ApiError } from "./api";

/** A bare machine token (snake_case, no spaces) is an internal code, never fit to show a user — fall
 * back. Anything with spaces/punctuation is already human copy (a server message, a Zod issue like
 * "baseUrl: Invalid URL") and is shown as-is. */
function isMachineCode(s: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(s);
}

export function errorText(
  err: unknown,
  opts: { overrides?: Record<string, string>; fallback?: string } = {},
): string {
  const fallback = opts.fallback ?? "操作失败,请重试。";
  if (err instanceof ApiError) {
    const text = err.message;
    const override = opts.overrides?.[text];
    if (override) return override;
    return isMachineCode(text) ? fallback : text || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
