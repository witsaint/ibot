import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // drizzle-kit reads env directly; the runtime client takes the string explicitly.
    url: process.env.DATABASE_URL!,
  },
});
