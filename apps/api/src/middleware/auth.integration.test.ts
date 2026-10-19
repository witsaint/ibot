/** Real auth cookies and session renewal against a disposable local Postgres database. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAuth } from "@i-bot/auth";
import { createDb, sessions, type Database } from "@i-bot/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppBindings, AppContext } from "../context.js";
import { requireAuth } from "./auth.js";

describe.runIf(process.env.AUTH_DB_TEST === "1" && !!process.env.DATABASE_URL)(
  "session renewal and expiry",
  () => {
    let db: Database;
    let admin: Database;
    const name = `ibot_auth_test_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:8787";
    function app() {
      const auth = createAuth({ db, secret: "isolated-auth-test-secret", baseURL: origin });
      const router = new Hono<AppBindings>();
      router.use("*", async (c, next) => {
        c.set("ctx", { auth } as AppContext);
        await next();
      });
      router.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
      router.use("/api/private/*", requireAuth);
      router.get("/api/private/me", (c) => c.json({ userId: c.get("userId") }));
      router.get("/api/private/events", (c) =>
        streamSSE(c, async (stream) => {
          await stream.writeSSE({ data: "ready" });
        }),
      );
      return router;
    }
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Auth integration tests require local Postgres");
      admin = createDb(url.toString());
      await admin.$client.unsafe(`CREATE DATABASE "${name}"`);
      url.pathname = `/${name}`;
      db = createDb(url.toString());
      await migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL("../../../../packages/db/drizzle", import.meta.url),
        ),
      });
    });
    afterAll(async () => {
      await db?.$client.end();
      if (admin) {
        try {
          await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
        } finally {
          await admin.$client.end();
        }
      }
    });
    async function login() {
      const router = app();
      const response = await router.request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: `${randomUUID()}@example.invalid`,
          password: "isolated-test-password",
          name: "Auth test",
        }),
      });
      expect(response.status).toBe(200);
      const { user } = (await response.json()) as { user: { id: string } };
      const userId = user.id;
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      return { router, cookie, userId };
    }
    for (const endpoint of ["me", "events"]) {
      it(`renews both database expiry and browser cookie on ${endpoint}`, async () => {
        const { cookie, userId } = await login();
        // Five days left means the 24-hour refresh threshold has passed.
        await db
          .update(sessions)
          .set({ expiresAt: new Date(Date.now() + 5 * 86400_000) })
          .where(eq(sessions.userId, userId));
        // A new auth instance also proves API process restarts preserve the session.
        const response = await app().request(`${origin}/api/private/${endpoint}`, {
          headers: { Cookie: cookie },
        });
        expect(response.status).toBe(200);
        if (endpoint === "events") expect(await response.text()).toContain("data: ready");
        expect(
          response.headers
            .getSetCookie()
            .some(
              (value) =>
                value.includes("session_token=") &&
                value.includes("Max-Age=604800") &&
                value.includes("HttpOnly"),
            ),
        ).toBe(true);
        const session = await db.query.sessions.findFirst({ where: eq(sessions.userId, userId) });
        expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
      });
    }
    it("rejects expired sessions and clears the browser cookie", async () => {
      const { router, cookie, userId } = await login();
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.userId, userId));
      const response = await router.request(`${origin}/api/private/me`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe("unauthenticated");
      expect(
        response.headers
          .getSetCookie()
          .some((value) => value.includes("session_token=") && value.includes("Max-Age=0")),
      ).toBe(true);
    });
    it("keeps a fresh session valid without resetting its lifetime on every request", async () => {
      const { router, cookie } = await login();
      const response = await router.request(`${origin}/api/private/me`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      expect(
        response.headers.getSetCookie().some((value) => value.includes("session_token=")),
      ).toBe(false);
    });
  },
);
