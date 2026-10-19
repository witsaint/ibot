/** Only application pages can be return destinations. Never allow external URLs or auth loops. */
export function isProtectedPage(pathname: string): boolean {
  return pathname === "/bots" || pathname.startsWith("/bots/") || pathname === "/settings";
}

export function loginReturnPath(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return "/bots";
  try {
    const url = new URL(value, "http://ibot.local");
    return url.origin === "http://ibot.local" && isProtectedPage(url.pathname)
      ? `${url.pathname}${url.search}${url.hash}`
      : "/bots";
  } catch {
    return "/bots";
  }
}

let redirecting = false;

/** Hard navigation clears stale account state; simultaneous failed requests redirect only once. */
export function redirectToSignIn(): void {
  if (typeof window === "undefined" || redirecting || !isProtectedPage(window.location.pathname))
    return;
  redirecting = true;
  const next = loginReturnPath(
    window.location.pathname + window.location.search + window.location.hash,
  );
  const query = new URLSearchParams({ reason: "session-expired", next });
  window.location.replace(`/?${query}`);
}
