import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

/** Collect each JSON line pino writes so we can assert on the serialized output. */
function capture(): { lines: () => Record<string, unknown>[]; write: (s: string) => void } {
  const raw: string[] = [];
  return {
    write: (s: string) => raw.push(s),
    lines: () =>
      raw
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

describe("createLogger redaction", () => {
  it("censors secret-bearing keys but keeps benign fields", () => {
    const sink = capture();
    const log = createLogger({ name: "test", level: "info", destination: { write: sink.write } });

    log.info(
      {
        botId: "bot_123",
        apiKey: "sk-live-should-not-appear",
        headers: { authorization: "Bearer super-secret" },
        AIPROXY_API_KEY: "aip-secret",
      },
      "provisioning",
    );

    const [entry] = sink.lines();
    expect(entry).toBeDefined();
    expect(entry.msg).toBe("provisioning");
    // benign field survives
    expect(entry.botId).toBe("bot_123");
    // secrets are censored, never emitted verbatim
    expect(entry.apiKey).toBe("[redacted]");
    expect((entry.headers as Record<string, unknown>).authorization).toBe("[redacted]");
    expect(entry.AIPROXY_API_KEY).toBe("[redacted]");
    expect(JSON.stringify(entry)).not.toContain("super-secret");
    expect(JSON.stringify(entry)).not.toContain("sk-live-should-not-appear");
  });

  it("tags every line with the logger name", () => {
    const sink = capture();
    const log = createLogger({ name: "sandbox-svc", destination: { write: sink.write } });
    log.info("hello");
    expect(sink.lines()[0]?.name).toBe("sandbox-svc");
  });
});
