import { createHmac, timingSafeEqual } from "node:crypto";
import type { AutomationTrigger, WebhookCondition } from "@i-bot/types";
import { CronExpressionParser } from "cron-parser";

export function nextRunAt(trigger: AutomationTrigger, now = new Date()): Date | null {
  if (trigger.type !== "schedule") return null;
  const s = trigger.schedule;
  if (s.kind === "interval") return new Date(now.getTime() + s.minutes * 60_000);
  if (s.kind === "once") return new Date(s.at) > now ? new Date(s.at) : null;
  const [hour, minute] = s.time.split(":");
  const cron = `${minute} ${hour} * * ${s.kind === "weekly" ? [...new Set(s.days)].join(",") : "*"}`;
  return CronExpressionParser.parse(cron, { currentDate: now, tz: s.timezone }).next().toDate();
}
export function signWebhook(
  secret: string,
  eventId: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${eventId}.${timestamp}.${body}`).digest("hex")}`;
}
export function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  now = Date.now(),
): boolean {
  const event = headers.get("x-ibot-event-id") ?? "";
  const timestamp = headers.get("x-ibot-timestamp") ?? "";
  const signature = headers.get("x-ibot-signature") ?? "";
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(event) ||
    !/^\d{10}$/.test(timestamp) ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  return timingSafeEqual(
    Buffer.from(signWebhook(secret, event, timestamp, body)),
    Buffer.from(signature),
  );
}
export function matchesConditions(
  payload: Record<string, unknown>,
  conditions: WebhookCondition[],
): boolean {
  return conditions.every((c) => {
    let value: unknown = payload;
    for (const part of c.path.split(".")) {
      if (
        ["__proto__", "prototype", "constructor"].includes(part) ||
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, part)
      ) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (c.operator === "exists") return value !== undefined;
    if (c.operator === "contains")
      return typeof value === "string" && typeof c.value === "string" && value.includes(c.value);
    return value === c.value;
  });
}
