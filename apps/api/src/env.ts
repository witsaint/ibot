/**
 * apps/api runtime configuration. One validated bag, parsed once at boot, so a
 * missing var fails loud at startup — never mid-request. Sandbox-specific env
 * (AIPROXY_API_KEY, SANDBOX_CONTROL_PLANE_URL, …) is validated separately by
 * `@i-bot/core`'s `loadSandboxConfig`; we only assert the vars this app owns.
 */
import { z } from "zod";

export const ApiEnv = z.object({
  /** Postgres connection string (Drizzle owns the schema). */
  DATABASE_URL: z.string().url("DATABASE_URL must be a postgres:// URL"),

  /** better-auth signing secret; required in every environment. */
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be >= 16 chars"),
  /** Base64-encoded 32-byte key for AES-256-GCM encryption of per-user secrets (model keys). */
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .min(44, "SECRETS_ENCRYPTION_KEY must be a base64-encoded 32-byte key"),
  /** Canonical origin of this API server, e.g. http://localhost:8787. */
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a URL"),
  /** The web app origin allowed to call auth + API with credentials. */
  WEB_ORIGIN: z.string().url("WEB_ORIGIN must be a URL").default("http://localhost:3000"),

  /** R2 / S3-compatible object storage for chat media + screenshots. */
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  /** HTTP port. */
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});
export type ApiEnv = z.infer<typeof ApiEnv>;

/** Parse + validate `process.env` (or an explicit bag) into the typed config. */
export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return ApiEnv.parse(env);
}

/** True when all four R2 vars are present — storage is optional in dev. */
export function hasStorage(
  env: ApiEnv,
): env is ApiEnv &
  Required<
    Pick<ApiEnv, "R2_ENDPOINT" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_BUCKET">
  > {
  return Boolean(
    env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET,
  );
}
