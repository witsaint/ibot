import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ApiError, sessionFetch } from "../src/lib/api";
import { loginReturnPath } from "../src/lib/session";

test("login return destinations preserve application state and reject external URLs", () => {
  assert.equal(
    loginReturnPath("/bots/bot-1?preview=web#desktop"),
    "/bots/bot-1?preview=web#desktop",
  );
  assert.equal(loginReturnPath("/settings"), "/settings");
  for (const value of [
    null,
    "",
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/",
    "/login?next=/settings",
    "/api/auth/sign-out",
    "/bots/../../login",
    "/bots/\nanything",
  ]) {
    assert.equal(loginReturnPath(value), "/bots");
  }
});

test("only platform session expiry redirects, once, while leaving response bodies readable", async (t) => {
  const redirects: string[] = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const location = {
    pathname: "/bots/bot-1",
    search: "?preview=web",
    hash: "#desktop",
    replace: (url: string) => redirects.push(url),
  };
  Object.defineProperty(globalThis, "window", { value: { location }, configurable: true });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let status = 401;
  let error = "INVALID_EMAIL_OR_PASSWORD";
  const requests: Array<RequestInit | undefined> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(init);
    return Response.json({ error, message: "登录已过期，请重新登录。" }, { status });
  });
  const badLogin = await sessionFetch("http://localhost/api/auth/sign-in/email");
  assert.equal(((await badLogin.json()) as { error: string }).error, error);
  assert.equal(redirects.length, 0);
  status = 503;
  error = "unauthenticated";
  await sessionFetch("http://localhost/api/me");
  assert.equal(redirects.length, 0);
  status = 401;
  location.pathname = "/";
  await sessionFetch("http://localhost/api/me");
  assert.equal(redirects.length, 0); // Landing session checks do not redirect in a loop.
  location.pathname = "/bots/bot-1";
  await assert.rejects(api.me(), (err: unknown) => err instanceof ApiError && err.status === 401);
  assert.equal(requests.at(-1)?.credentials, "include");
  const [a, b] = await Promise.all([
    sessionFetch("http://localhost/api/me"),
    sessionFetch("http://localhost/api/chat"),
  ]);
  assert.equal(((await a.json()) as { error: string }).error, "unauthenticated");
  assert.equal(((await b.json()) as { error: string }).error, "unauthenticated");
  assert.equal(redirects.length, 1);
  const redirect = new URL(redirects[0]!, "http://localhost");
  assert.equal(redirect.pathname, "/");
  assert.equal(redirect.searchParams.get("reason"), "session-expired");
  assert.equal(redirect.searchParams.get("next"), "/bots/bot-1?preview=web#desktop");
});
