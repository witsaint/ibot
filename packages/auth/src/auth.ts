import { accounts, type Database, sessions, users, verifications } from "@i-bot/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export interface AuthConfig {
  /** drizzle client from `@i-bot/db` createDb() */
  db: Database;
  /** signing secret (BETTER_AUTH_SECRET); required in every environment */
  secret: string;
  /** canonical origin of the auth server, e.g. https://api.example.com */
  baseURL: string;
  /** extra origins allowed to call auth endpoints (the web app's origin) */
  trustedOrigins?: string[];
}

/**
 * Build the better-auth instance for the platform.
 *
 * The drizzle adapter is given an explicit singular→table remap because
 * better-auth looks tables up by singular model name (`user`) while our schema
 * exports are plural (`users`). This is unambiguous and survives version bumps
 * without depending on the adapter's `usePlural` heuristics.
 *
 * Auth method: email + password (MVP). Social providers can be added here later
 * without a schema change — the `accounts` table already stores provider identities.
 */
export function createAuth(cfg: AuthConfig) {
  return betterAuth({
    secret: cfg.secret,
    baseURL: cfg.baseURL,
    ...(cfg.trustedOrigins ? { trustedOrigins: cfg.trustedOrigins } : {}),
    database: drizzleAdapter(cfg.db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    emailAndPassword: { enabled: true },
  });
}

export type Auth = ReturnType<typeof createAuth>;
