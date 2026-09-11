import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";

// Both domain and better-auth tables must be registered so `db.query` and
// `db._.fullSchema` expose every table — the better-auth drizzle adapter relies on them.
const fullSchema = { ...authSchema, ...schema };

export type Database = ReturnType<typeof createDb>;

/**
 * Create a Drizzle client bound to a Postgres connection.
 * Pass the connection string explicitly (from the caller's validated env) so this
 * package stays free of env-reading side effects.
 */
export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { prepare: false });
  return drizzle(sql, { schema: fullSchema });
}
