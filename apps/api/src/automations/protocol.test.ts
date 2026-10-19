import { describe, expect, it } from "vitest";
import { AutomationDefinition, AutomationPatch } from "@i-bot/types";
import { matchesConditions, nextRunAt, signWebhook, verifyWebhook } from "./protocol.js";
import { isPublicAddress } from "./delivery.js";
describe("automation schedules", () => {
  it("uses the specified timezone and weekday", () => {
    expect(
      nextRunAt(
        { type: "schedule", schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" } },
        new Date("2026-09-29T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-09-29T01:00:00.000Z");
    expect(
      nextRunAt(
        {
          type: "schedule",
          schedule: { kind: "weekly", time: "09:00", timezone: "Asia/Shanghai", days: [1] },
        },
        new Date("2026-09-29T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-05T01:00:00.000Z");
  });
  it("follows daylight saving changes", () => {
    const trigger = {
      type: "schedule" as const,
      schedule: { kind: "daily" as const, time: "09:00", timezone: "America/New_York" },
    };
    expect(nextRunAt(trigger, new Date("2026-03-07T15:00:00Z"))?.toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    );
    expect(nextRunAt(trigger, new Date("2026-10-31T15:00:00Z"))?.toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });
  it("coalesces intervals and does not repeat past one-time tasks", () => {
    expect(
      nextRunAt(
        { type: "schedule", schedule: { kind: "interval", minutes: 5 } },
        new Date("2026-09-29T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-09-29T00:05:00.000Z");
    expect(
      nextRunAt(
        { type: "schedule", schedule: { kind: "once", at: "2026-09-28T00:00:00Z" } },
        new Date("2026-09-29T00:00:00Z"),
      ),
    ).toBeNull();
  });
});
it("authenticates the exact body, event id and timestamp", () => {
  const body = '{"type":"ticket.created"}';
  const event = "ticket-1";
  const timestamp = "1790640000";
  const secret = "test-secret";
  const headers = new Headers({
    "x-ibot-event-id": event,
    "x-ibot-timestamp": timestamp,
    "x-ibot-signature": signWebhook(secret, event, timestamp, body),
  });
  expect(verifyWebhook(secret, headers, body, Number(timestamp) * 1000)).toBe(true);
  expect(verifyWebhook(secret, headers, body + " ", Number(timestamp) * 1000)).toBe(false);
  expect(verifyWebhook(secret, headers, body, (Number(timestamp) + 301) * 1000)).toBe(false);
  expect(verifyWebhook("other", headers, body, Number(timestamp) * 1000)).toBe(false);
  headers.set("x-ibot-event-id", "ticket-2");
  expect(verifyWebhook(secret, headers, body, Number(timestamp) * 1000)).toBe(false);
  headers.set("x-ibot-signature", "bad");
  expect(verifyWebhook(secret, headers, body, Number(timestamp) * 1000)).toBe(false);
});
it("only matches own properties with explicit primitive comparisons", () => {
  expect(
    matchesConditions({ type: "ticket.created", ticket: { title: "网络问题" } }, [
      { path: "type", operator: "equals", value: "ticket.created" },
      { path: "ticket.title", operator: "contains", value: "网络" },
    ]),
  ).toBe(true);
  expect(matchesConditions({}, [{ path: "constructor", operator: "exists" }])).toBe(false);
  expect(matchesConditions({ n: 1 }, [{ path: "n", operator: "equals", value: "1" }])).toBe(false);
  expect(matchesConditions({ n: null }, [{ path: "n", operator: "exists" }])).toBe(true);
});
it("patches never reintroduce creation defaults", () => {
  expect(AutomationPatch.parse({ enabled: false })).toEqual({ enabled: false });
  expect(AutomationPatch.parse({ name: "改名" })).toEqual({ name: "改名" });
});
it("rejects unsafe callback schemes and invalid timezones", () => {
  expect(
    AutomationDefinition.safeParse({
      name: "x",
      instruction: "x",
      conversationId: "00000000-0000-4000-8000-000000000001",
      trigger: {
        type: "schedule",
        schedule: { kind: "daily", time: "09:00", timezone: "bad/zone" },
      },
    }).success,
  ).toBe(false);
  for (const callbackUrl of [
    "http://example.com",
    "https://user:secret@example.com/cb",
    "https://example.com/#fragment",
  ])
    expect(AutomationPatch.safeParse({ callbackUrl }).success).toBe(false);
});
it("rejects private, mapped IPv6 and reserved callback addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
  ])
    expect(isPublicAddress(address), address).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
});
