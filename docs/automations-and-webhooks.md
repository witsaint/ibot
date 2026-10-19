# 自动化和 webhook

## 已实现的使用方式

在 bot 工作区右上角点击「自动化」。规则决定这个 agent 做什么、何时执行，以及把结果留在哪个已有对话中。用户无需指定项目路径、开发框架、端口或内部工具名。

- 定时：每天、每周、固定间隔（最少 5 分钟）、单次执行。每天和每周使用明确的 IANA 时区，包含夏令时处理。
- 外部事件：公司系统发送带签名的 JSON webhook。可按字段筛选事件；所有条件同时满足才执行。
- 管理：创建、编辑、启用、暂停、删除；运行一次；查看结果、运行记录和回调状态；停止；补充说明后继续。
- 对话：agent 可通过 `create_automation` 保存暂停的草稿，通过 `list_automations` 查看规则、`get_automation_runs` 查看结果，通过 `pause_automation` 暂停。用户在面板中检查并启用草稿。
- 结果：assistant 输出使用原来的 `messages.parts` 保存，运行记录引用结果消息。页面通过现有 SSE 更新对话；工作区显示未读结果数量。
- 公司系统：可配置公网 HTTPS 回调地址，生成独立的回调签名密钥，接收结果、失败和需要用户参与的状态。

内置场景提供「每日工作准备」「公司系统事件」「定期检查」的可编辑任务说明。它们需要使用用户实际连接的日历、资料和系统；没有连接或没有提供目标时，agent 应说明缺失信息。

## 执行和恢复

规则和执行记录保存在 Postgres。API 进程每 2 秒检查到期规则、待执行任务和回调。

1. 到期规则或签名通过的事件创建运行记录；同一规则的事件 ID 唯一，重复请求返回已有记录。
2. 同一个 bot 同时只执行一项自动化；已有前台回复、后台任务、用户桌面接管或待处理的自动化会使新任务排队。
3. 自动化使用 bot 所有者的模型密钥、该 bot 的技能、MCP 和 sandbox。服务不会借用其他用户或平台模型密钥。
4. 执行自动化时不提供创建新规则的工具，避免自动化自行扩展。外部 JSON 被标记为任务输入，不能作为扩大用户授权的依据。
5. 登录、验证码等阻碍通过 `request_handoff` 标记为「需要你处理」。没有模型密钥或桌面未启动也进入这个状态。补充说明并点击「继续运行」后，沿用对话历史继续；也可停止此次运行。
6. 服务重启后，排队任务仍保留；运行中的任务在 120 秒租约失效后标记为中断并暂停该规则，需要用户检查已有操作后继续。不会自动重做中断的操作。
7. 漏掉的周期执行合并为一次，下一次按当前时间计算，避免重启后积压大量过去的任务。单次任务只入队一次。
8. 连续三次执行失败会暂停规则。暂停取消尚未开始的任务，正在执行的任务继续；需要停止时点击该运行的「停止」。

默认每条规则 24 小时内最多创建 20 次运行、单次最多 15 分钟；可在面板调整，上限分别为 100 次、30 分钟。每个 bot 最多 50 条规则；每条规则最多 50 次未结束的排队/执行记录，每 24 小时最多接收 200 条不同事件（含被忽略的事件）。

当前运行状态、桌面租约、SSE 仍使用项目原有的进程内管理，因此部署应运行一个 API 实例。Postgres 中的自动化去重、队列和租约有事务保护，但这不等于整个桌面控制已支持多 API 实例。

## 接收 webhook

管理 API 需要用户会话，并沿 bot 所有权验证对话、规则和运行。接收 webhook 不使用浏览器会话，改用每条规则独立的 HMAC 签名认证；未通过签名的请求不会入队。

在面板中创建 webhook 规则，再展开「接入公司系统」生成接收密钥。密钥只在生成时返回一次，服务端使用现有 AES-256-GCM 加密保存。更换密钥后旧密钥失效。

```text
POST /api/webhooks/automations/{automationId}
Content-Type: application/json
X-Ibot-Event-Id: ticket-123
X-Ibot-Timestamp: 1790640000
X-Ibot-Signature: sha256={64位小写十六进制签名}
```

签名内容：`eventId + "." + timestamp + "." + 原始 JSON 正文`，算法为 HMAC-SHA256。时间戳单位为 Unix 秒，与服务时间差不能超过 5 分钟；正文必须为 JSON 对象，最大 64 KiB。

调用示例（Node.js）：

```js
import { createHmac } from "node:crypto";

const url = process.env.IBOT_WEBHOOK_URL;
const secret = process.env.IBOT_WEBHOOK_SECRET;
const eventId = "ticket-123"; // 重试同一业务事件时保持不变
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({ type: "ticket.created", ticket: { id: 123, title: "客户反馈" } });
const signature = createHmac("sha256", secret)
  .update(`${eventId}.${timestamp}.${body}`)
  .digest("hex");
const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-ibot-event-id": eventId,
    "x-ibot-timestamp": timestamp,
    "x-ibot-signature": `sha256=${signature}`,
  },
  body,
});
console.log(response.status, await response.json());
```

成功接收返回 HTTP 202：`{ runId, status, duplicate }`。`status: ignored` 表示规则已暂停或条件不匹配；`duplicate: true` 表示事件已接收过，不会再次执行。202 表示已接收，不表示 agent 已完成工作。超过数量上限返回 429。

筛选示例：

```json
[
  { "path": "type", "operator": "equals", "value": "ticket.created" },
  { "path": "ticket.title", "operator": "contains", "value": "客户" },
  { "path": "ticket.id", "operator": "exists" }
]
```

只支持对象字段的点分路径；`equals` 区分类型；`contains` 用于字符串；`exists` 检查字段是否存在。原生使用其他签名协议的 GitHub、飞书等事件来源，需要在发送端或接入服务中转换成上述协议，本版没有冒充这些平台的直接接入。

## 结果回调

在规则中填写 HTTPS 地址，保存后生成回调密钥。没有密钥时不投递。回调使用相同的三个签名头，接收方需要验证签名、时间戳并按事件 ID 去重。

```json
{
  "eventId": "运行ID:执行次数",
  "type": "automation.succeeded",
  "automationId": "规则ID",
  "runId": "运行ID",
  "conversationId": "对话ID",
  "status": "succeeded",
  "summary": "结果摘要",
  "error": null,
  "resultMessageId": "结果消息ID"
}
```

`type` 对应 `succeeded`、`failed`、`waiting` 或执行中被停止的 `canceled`。排队时被取消、筛选忽略和过期租约中断显示在面板，不投递回调。

执行结束时在同一事务中保存运行状态和待投递内容；回调正文、地址和加密密钥保存为当时的值，重试不重新运行 agent。回调共尝试最多 5 次，重试间隔为 30、60、120、240 秒。服务重启后继续未完成的投递。修改回调地址或更换回调密钥会取消尚未完成的旧投递；已发出的请求无法撤回。

回调仅支持公网 HTTPS，拒绝内网、回环、保留地址和跳转。DNS 解析结果在连接时固定，不能在验证后通过重新解析切换到内部地址。

## 管理 API

| 方法           | 地址                                             | 用途                                |
| -------------- | ------------------------------------------------ | ----------------------------------- |
| GET / POST     | `/api/automations/bots/{botId}`                  | 列出 / 创建规则                     |
| GET            | `/api/automations/bots/{botId}/attention`        | 未读及待处理数量                    |
| PATCH / DELETE | `/api/automations/{id}`                          | 修改 / 删除规则                     |
| POST           | `/api/automations/{id}/keys/{webhook或callback}` | 生成或更换密钥                      |
| GET            | `/api/automations/{id}/runs`                     | 最近 50 次运行                      |
| POST           | `/api/automations/{id}/test`                     | 实际执行一次，不改变启停状态        |
| POST           | `/api/automations/{id}/runs/{runId}/cancel`      | 请求停止                            |
| POST           | `/api/automations/{id}/runs/{runId}/resume`      | 补充 `{ "message": "说明" }` 后继续 |
| POST           | `/api/automations/{id}/runs/{runId}/read`        | 标记已读                            |

Zod 契约在 `packages/types/src/automation.ts`，Drizzle 表与迁移在 `packages/db`。迁移 `0008_automations.sql` 必须在部署新 API 前执行。

## 验证

```sh
pnpm lint
pnpm check-types
pnpm --filter @i-bot/web build
# 显式启用真实 Postgres 测试；.env 指向本地开发库
AUTOMATION_DB_TEST=1 node --env-file=.env apps/api/node_modules/vitest/vitest.mjs run --root apps/api src/automations
```

测试在本地 Postgres 中创建并迁移一个临时数据库，结束后删除；不会与开发服务的自动化队列混用。数据库账号需要创建数据库的权限。覆盖签名、正文篡改、体积限制、筛选、重复事件、租户隔离、时区和夏令时、排队、停止、等待及继续、重启、连续失败暂停、回调重试和 DNS 地址固定；其中一项通过本地 Anthropic 协议服务执行真实 AI SDK、工具调用和消息持久化，外部模型和真实桌面边界由测试服务替代。

本版通知为工作区未读提示、对话结果和可选回调。企业组织权限、跨用户 agent 协作、操作系统推送、飞书或邮件通知、网页正式发布不属于本版已实现能力。
