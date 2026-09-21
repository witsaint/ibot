import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The API base the browser talks to (better-auth + REST + chat stream).
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787",
  },
};

export default config;
