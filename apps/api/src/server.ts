/**
 * Hono app assembly. Wires CORS (credentialed, to the web origin), the better-auth
 * handler (mounted at /api/auth/*), and the authenticated bot/chat routes. The context
 * singleton is attached to every request so handlers reach db/auth/sandbox via `c.get`.
 *
 * better-auth ships a framework-agnostic `handler(request) → Response`, so it mounts on
 * Hono with zero adapter — we hand it the raw Request and return its Response.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings, AppContext } from "./context.js";
import { requireAuth } from "./middleware/auth.js";
import { botsRoutes } from "./routes/bots.js";
import { chatRoutes } from "./routes/chat.js";
import { settingsRoutes } from "./routes/settings.js";
import { skillsRoutes } from "./routes/skills.js";

export function createServer(ctx: AppContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // attach context to every request
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });

  // CORS — credentialed so the browser sends the better-auth session cookie
  app.use(
    "*",
    cors({
      origin: ctx.env.WEB_ORIGIN,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // health — unauthenticated
  app.get("/health", (c) => c.json({ ok: true, service: "i-bot-api" }));

  // better-auth: sign-up / sign-in / session / sign-out live under /api/auth/*
  app.on(["GET", "POST"], "/api/auth/*", (c) => ctx.auth.handler(c.req.raw));

  // authenticated API surface
  const api = new Hono<AppBindings>();
  api.use("*", requireAuth);
  api.get("/me", (c) =>
    c.json({
      userId: c.get("userId"),
      // Fleet default for the "public egress" toggle — a new bot's checkbox initialises to this.
      sandboxPublicDefault: c.get("ctx").sandboxConfig.defaultPublic,
    }),
  );
  api.route("/bots", botsRoutes);
  api.route("/chat", chatRoutes);
  api.route("/settings", settingsRoutes);
  api.route("/skills", skillsRoutes);

  app.route("/api", api);

  return app;
}
