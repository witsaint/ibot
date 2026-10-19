/* eslint-disable no-await-in-loop -- Read the incoming body in order and stop before exceeding the size limit. */
import { randomUUID } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { automations } from "@i-bot/db";
import {
  AutomationDefinition,
  AutomationPatch,
  ResumeAutomationRun,
  AUTOMATION_WEBHOOK_MAX_BYTES,
} from "@i-bot/types";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppBindings } from "../context.js";
import { AutomationError } from "../automations/manager.js";
import { verifyWebhook } from "../automations/protocol.js";
import { decryptSecret } from "../crypto.js";

const uuid = z.string().uuid();
export const automationsRoutes = new Hono<AppBindings>();
automationsRoutes.use("*", bodyLimit({ maxSize: 64 * 1024 }));
automationsRoutes.use("*", async (c, next) => {
  for (const name of ["id", "botId", "runId"]) {
    const value = c.req.param(name);
    if (value && !uuid.safeParse(value).success) return c.json({ error: "无效的 ID" }, 400);
  }
  await next();
});
automationsRoutes.onError((err, c) => {
  if (err instanceof AutomationError) return c.json({ error: err.message }, err.status);
  c.get("ctx").logger.error("automation management request failed");
  return c.json({ error: "自动化请求失败" }, 500);
});
automationsRoutes.get("/bots/:botId", async (c) =>
  c.json(await c.get("ctx").automations.list(c.get("userId"), c.req.param("botId"))),
);
automationsRoutes.get("/bots/:botId/attention", async (c) =>
  c.json(await c.get("ctx").automations.attention(c.get("userId"), c.req.param("botId"))),
);
automationsRoutes.post("/bots/:botId", async (c) => {
  const parsed = AutomationDefinition.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "规则格式不正确", issues: parsed.error.issues }, 400);
  return c.json(
    await c.get("ctx").automations.create(c.get("userId"), c.req.param("botId"), parsed.data),
    201,
  );
});
automationsRoutes.patch("/:id", async (c) => {
  const parsed = AutomationPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "规则格式不正确", issues: parsed.error.issues }, 400);
  return c.json(
    await c.get("ctx").automations.patch(c.get("userId"), c.req.param("id"), parsed.data),
  );
});
automationsRoutes.delete("/:id", async (c) => {
  await c.get("ctx").automations.remove(c.get("userId"), c.req.param("id"));
  return c.body(null, 204);
});
automationsRoutes.post("/:id/keys/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (kind !== "webhook" && kind !== "callback") return c.json({ error: "无效的密钥类型" }, 400);
  return c.json(await c.get("ctx").automations.rotateKey(c.get("userId"), c.req.param("id"), kind));
});
automationsRoutes.get("/:id/runs", async (c) =>
  c.json(await c.get("ctx").automations.runs(c.get("userId"), c.req.param("id"))),
);
automationsRoutes.post("/:id/test", async (c) => {
  const manager = c.get("ctx").automations;
  await manager.ownedRule(c.get("userId"), c.req.param("id"));
  // A test really executes the user's saved task; it does not silently enable the rule.
  return c.json(await manager.trigger(c.req.param("id"), "manual", `manual:${randomUUID()}`), 202);
});
automationsRoutes.post("/:id/runs/:runId/:action", async (c) => {
  const action = c.req.param("action");
  if (!["cancel", "resume", "read"].includes(action)) return c.json({ error: "无效的操作" }, 400);
  let message: string | undefined;
  if (action === "resume") {
    const parsed = ResumeAutomationRun.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "请补充继续执行的说明", issues: parsed.error.issues }, 400);
    message = parsed.data.message;
  }
  await c
    .get("ctx")
    .automations.actOnRun(
      c.get("userId"),
      c.req.param("id"),
      c.req.param("runId"),
      action as "cancel" | "resume" | "read",
      message,
    );
  return c.body(null, 204);
});

export const automationWebhookRoutes = new Hono<AppBindings>();
automationWebhookRoutes.post("/:id", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "签名无效" }, 401);
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return c.json({ error: "请使用 application/json" }, 415);
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > AUTOMATION_WEBHOOK_MAX_BYTES) return c.json({ error: "事件不能超过 64 KiB" }, 413);
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AUTOMATION_WEBHOOK_MAX_BYTES) {
          await reader.cancel();
          return c.json({ error: "事件不能超过 64 KiB" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const ctx = c.get("ctx");
  const row = await ctx.db.query.automations.findFirst({
    where: eq(automations.id, c.req.param("id")),
  });
  let valid = false;
  try {
    valid =
      !!row?.webhookKey &&
      row.trigger.type === "webhook" &&
      verifyWebhook(decryptSecret(row.webhookKey), c.req.raw.headers, body);
  } catch {
    /* invalid key fails closed */
  }
  if (!valid || !row) return c.json({ error: "签名无效" }, 401);
  const parsed = z.record(z.string(), z.unknown()).safeParse(
    await Promise.resolve()
      .then(() => JSON.parse(body))
      .catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "事件正文必须是 JSON 对象" }, 400);
  try {
    return c.json(
      await ctx.automations.trigger(
        row.id,
        "webhook",
        c.req.header("x-ibot-event-id")!,
        parsed.data,
        row.webhookKey!,
      ),
      202,
    );
  } catch (err) {
    if (err instanceof AutomationError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});
