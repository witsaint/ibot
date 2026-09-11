import { type DestinationStream, pino, type Logger, type LoggerOptions } from "pino";

/**
 * Structured logging for the platform. One place to configure levels, redaction,
 * and pretty-printing so nothing scatters `console.log` while driving sandboxes.
 *
 * Secrets must never be logged — `redact` scrubs the common key names defensively
 * even if a caller passes a whole config object by mistake.
 */
const SECRET_KEYS = [
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "secret",
  "authorization",
  "AIPROXY_API_KEY",
  "PPIO_API_KEY",
  "ANTHROPIC_API_KEY",
  "DATABASE_URL",
  "REDIS_URL",
];

/**
 * pino's `*` matches exactly one level, so each key needs both the bare form
 * (secret logged at the top level, e.g. `log.info({ apiKey }, ...)`) and the
 * `*.`-nested form (secret one level down, e.g. under `headers` / `env` / `config`).
 */
export const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`]);

export interface CreateLoggerOptions {
  /** service/package name, tagged on every line */
  name: string;
  /** defaults to LOG_LEVEL env, else "info" */
  level?: LoggerOptions["level"];
  /** pretty-print for local dev; defaults to on when NODE_ENV !== "production" */
  pretty?: boolean;
  /**
   * Sink for log lines. Defaults to stdout. Passing a stream disables the
   * pretty transport (transports can't attach to an arbitrary destination) —
   * used by tests to capture raw JSON, and by callers redirecting output.
   */
  destination?: DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const pretty = opts.destination ? false : (opts.pretty ?? process.env.NODE_ENV !== "production");
  const options: LoggerOptions = {
    name: opts.name,
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export type { Logger };
