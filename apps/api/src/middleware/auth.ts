/**
 * Authentication + tenant-isolation middleware.
 *
 * `requireAuth` resolves the better-auth session from the request cookies and pins the
 * user id onto the context; every non-public route uses it. `ownerOfBot` is the sandbox
 * layer's load-bearing guard: it resolves a bot id through `bots.ownerId` and 403s unless
 * the session user owns it — run before ANY sandbox control-plane call or bot mutation.
 * No query trusts an id it didn't resolve through the ownership chain (AGENTS.md).
 */
import { bots } from "@i-bot/db";
import type { Context, MiddlewareHandler, Next } from "hono";
import { eq } from "drizzle-orm";
import type { AppBindings } from "../context.js";

/** 401 unless a valid better-auth session is present; sets `userId`. */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next: Next) => {
  const { auth } = c.get("ctx");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("userId", session.user.id);
  await next();
};

/**
 * Resolve `:botId` from the path and assert the session user owns it. Returns the bot row
 * (attached via a fresh lookup by callers as needed). 404 when the bot doesn't exist OR
 * isn't owned by the user — we never reveal existence of another tenant's bot.
 */
export async function assertOwnerOfBot(
  c: Context<AppBindings>,
  botId: string,
): Promise<{ id: string; ownerId: string } | null> {
  const { db } = c.get("ctx");
  const userId = c.get("userId");
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    columns: { id: true, ownerId: true },
  });
  if (!bot || bot.ownerId !== userId) return null;
  return bot;
}
