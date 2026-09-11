import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Barrel re-exports both auth-schema (better-auth tables) and schema (domain
  // tables) so every table is emitted — pointing at schema.ts alone would drop
  // users/sessions/accounts/verifications and leave the ownership FKs dangling.
  schema: "./src/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // drizzle-kit reads env directly; the runtime client takes the string explicitly.
    url: process.env.DATABASE_URL!,
  },
});
