import { z } from "zod";

export const AutomationTimezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions();
      return true;
    } catch {
      return false;
    }
  }, "请填写有效的 IANA 时区，例如 Asia/Shanghai");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式为 HH:mm");
export const AutomationSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(10080) }),
  z.object({ kind: z.literal("daily"), time: clock, timezone: AutomationTimezone }),
  z.object({
    kind: z.literal("weekly"),
    time: clock,
    timezone: AutomationTimezone,
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({ kind: z.literal("once"), at: z.string().datetime({ offset: true }) }),
]);
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;
export const WebhookCondition = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/)
      .refine(
        (v) => !v.split(".").some((s) => ["__proto__", "prototype", "constructor"].includes(s)),
      ),
    operator: z.enum(["equals", "contains", "exists"]),
    value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]).optional(),
  })
  .refine((c) => c.operator === "exists" || c.value !== undefined, "比较条件需要填写值");
export type WebhookCondition = z.infer<typeof WebhookCondition>;
export const AutomationTrigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schedule"), schedule: AutomationSchedule }),
  z.object({
    type: z.literal("webhook"),
    conditions: z.array(WebhookCondition).max(8).default([]),
  }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;
export const AutomationDefinition = z.object({
  name: z.string().trim().min(1).max(100),
  instruction: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid(),
  trigger: AutomationTrigger,
  enabled: z.boolean().default(false),
  needsDesktop: z.boolean().default(true),
  maxRunsPerDay: z.number().int().min(1).max(100).default(20),
  maxDurationSeconds: z.number().int().min(30).max(1800).default(900),
  callbackUrl: z
    .string()
    .url()
    .max(2000)
    .regex(/^https:\/\/[^/@?#]+(?:[/?][^#]*)?$/, "回调需要无用户名、密码和片段的 HTTPS 地址")
    .nullable()
    .default(null),
});
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;
export const AutomationPatch = z
  .object({
    ...AutomationDefinition.shape,
    enabled: AutomationDefinition.shape.enabled.removeDefault(),
    needsDesktop: AutomationDefinition.shape.needsDesktop.removeDefault(),
    maxRunsPerDay: AutomationDefinition.shape.maxRunsPerDay.removeDefault(),
    maxDurationSeconds: AutomationDefinition.shape.maxDurationSeconds.removeDefault(),
    callbackUrl: AutomationDefinition.shape.callbackUrl.removeDefault(),
  })
  .partial();
export type AutomationPatch = z.infer<typeof AutomationPatch>;
export const Automation = AutomationDefinition.extend({
  id: z.string().uuid(),
  botId: z.string().uuid(),
  nextRunAt: z.string().datetime().nullable(),
  pauseReason: z.string().nullable(),
  hasWebhookKey: z.boolean(),
  hasCallbackKey: z.boolean(),
  webhookUrl: z.string().url(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Automation = z.infer<typeof Automation>;
export const AutomationRunStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "waiting",
  "interrupted",
  "canceled",
  "ignored",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;
export const AutomationRun = z.object({
  id: z.string().uuid(),
  automationId: z.string().uuid(),
  conversationId: z.string().uuid(),
  status: AutomationRunStatus,
  source: z.enum(["schedule", "webhook", "manual"]),
  eventId: z.string(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  resultMessageId: z.string().nullable(),
  attempts: z.number(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  deliveryStatus: z.enum(["pending", "delivered", "failed"]).nullable(),
  deliveryAttempts: z.number(),
  deliveryError: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;
export const AutomationKey = z.object({ secret: z.string(), url: z.string().url() });
export type AutomationKey = z.infer<typeof AutomationKey>;
export const ResumeAutomationRun = z.object({ message: z.string().trim().min(1).max(4000) });
export const AUTOMATION_WEBHOOK_MAX_BYTES = 64 * 1024;

export const AutomationAttention = z.object({
  unread: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});
export type AutomationAttention = z.infer<typeof AutomationAttention>;
