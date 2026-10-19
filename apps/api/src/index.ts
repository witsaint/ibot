/**
 * apps/api entrypoint. Validate env → build the context → serve.
 *
 * Sandbox lifecycle across restarts:
 *  - On boot we re-arm keepalive for every box that was `active` (rearmActive), so a
 *    deploy / crash / dev hot-reload doesn't leave boxes coasting to TTL reclamation.
 *  - On shutdown we DETACH handles (stop keepalive) but do NOT kill the boxes — they
 *    keep running on their current grant for the next process to reconnect. Killing on
 *    every SIGTERM is exactly what made a bot's desktop vanish after a restart.
 */
import { serve } from "@hono/node-server";
import { buildContext } from "./context.js";
import { loadApiEnv } from "./env.js";
import { syncBuiltinPlugins } from "./plugins/builtin.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadApiEnv();
  const ctx = buildContext(env);
  const app = createServer(ctx);

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    ctx.logger.info({ port: info.port, env: env.NODE_ENV }, "i-bot api listening");
  });

  // Re-arm keepalive for boxes that were active before this process started. Background
  // (never blocks serving); a failure per-box is logged and reconciled inside.
  void ctx.sandboxes.rearmActive().catch((err: unknown) => {
    ctx.logger.error({ err: err instanceof Error ? err.message : err }, "rearmActive failed");
  });

  // Reconcile background jobs left `running` by a previous process (their worker is gone) —
  // flip them to `error` so the UI stops showing a phantom in-flight task. Background.
  void ctx.jobs.reclaimOrphans().catch((err: unknown) => {
    ctx.logger.error({ err: err instanceof Error ? err.message : err }, "reclaimOrphans failed");
  });

  // Sync the plugins we ship with the code into the DB and make sure existing users have them
  // installed. Idempotent, so it runs every boot; it never re-enables a builtin a user switched off.
  // Background — plugins resolve per run, so serving never waits on this.
  void syncBuiltinPlugins(ctx.db, { logger: ctx.logger })
    .then((counts) => ctx.logger.info(counts, "builtin plugins synced"))
    .catch((err: unknown) => {
      ctx.logger.error(
        { err: err instanceof Error ? err.message : err },
        "syncBuiltinPlugins failed",
      );
    });

  ctx.automations.start();

  const shutdown = (signal: string): void => {
    ctx.logger.info({ signal }, "shutting down (detaching sandboxes, leaving boxes alive)");
    ctx.automations.stop();
    server.close();
    ctx.sandboxes.detachAll();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("api failed to start:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
