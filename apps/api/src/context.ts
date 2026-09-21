/**
 * The application context: every long-lived singleton, built once at boot and threaded
 * through Hono via `c.get(...)`. Keeping construction here (not scattered import-time
 * side effects) means env is validated first and tests can build a context explicitly.
 */
import { type Auth, createAuth } from "@i-bot/auth";
import { loadSandboxConfig, type SandboxConfig } from "@i-bot/core";
import { createDb, type Database } from "@i-bot/db";
import { createLogger, type Logger } from "@i-bot/logger";
import { Storage } from "@i-bot/storage";
import type { ApiEnv } from "./env.js";
import { hasStorage } from "./env.js";
import { JobManager } from "./agent/jobs.js";
import { ConversationEventBus } from "./events/bus.js";
import { SandboxManager } from "./sandbox/manager.js";

export interface AppContext {
  env: ApiEnv;
  logger: Logger;
  db: Database;
  auth: Auth;
  storage: Storage | null;
  sandboxConfig: SandboxConfig;
  sandboxes: SandboxManager;
  jobs: JobManager;
  /** in-process per-conversation SSE event bus (task/run lifecycle notifications) */
  events: ConversationEventBus;
}

/** Variables exposed on the Hono context (`c.get`/`c.set`). */
export interface AppBindings {
  Variables: {
    ctx: AppContext;
    /** the authenticated user id, set by requireAuth middleware */
    userId: string;
  };
}

export function buildContext(env: ApiEnv): AppContext {
  const logger = createLogger({ name: "api" });
  const db = createDb(env.DATABASE_URL);
  const auth = createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.WEB_ORIGIN],
  });

  // Sandbox config validates AIPROXY_API_KEY + control-plane slug from the same env.
  const sandboxConfig = loadSandboxConfig();

  const storage = hasStorage(env)
    ? new Storage({
        endpoint: env.R2_ENDPOINT,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
      })
    : null;

  const sandboxes = new SandboxManager({ db, sandboxConfig, logger });
  const events = new ConversationEventBus();
  const jobs = new JobManager({ db, logger, sandboxes, events });

  return { env, logger, db, auth, storage, sandboxConfig, sandboxes, jobs, events };
}
