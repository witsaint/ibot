import { pino, type Logger, type LoggerOptions } from "pino";

/**
 * Structured logging for the platform. One place to configure levels, redaction,
 * and pretty-printing so nothing scatters `console.log` while driving sandboxes.
 *
 * Secrets must never be logged — `redact` scrubs the common key paths defensively
 * even if a caller passes a whole config object by mistake.
 */
const REDACT_PATHS = [
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.password",
  "*.secret",
  "*.authorization",
  "*.headers.authorization",
  "*.AIPROXY_API_KEY",
  "*.PPIO_API_KEY",
  "*.DATABASE_URL",
];

export interface CreateLoggerOptions {
  /** service/package name, tagged on every line */
  name: string;
  /** defaults to LOG_LEVEL env, else "info" */
  level?: LoggerOptions["level"];
  /** pretty-print for local dev; defaults to on when NODE_ENV !== "production" */
  pretty?: boolean;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const pretty = opts.pretty ?? process.env.NODE_ENV !== "production";
  return pino({
    name: opts.name,
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

export type { Logger };
