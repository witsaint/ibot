import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

/**
 * Create a Drizzle client bound to a Postgres connection.
 * Pass the connection string explicitly (from the caller's validated env) so this
 * package stays free of env-reading side effects.
 */
export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { prepare: false });
  return drizzle(sql, { schema });
}
