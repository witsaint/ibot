# AIProxy 轻部署接入评审

核实日期：2026-09-30。

来源：[AIProxy Sandbox + 轻部署 Agent 使用指引](https://ppio-cloud.feishu.cn/file/HZy6bJwNgoKFOZxexjVc6JPCnpd)，文件名 `aiproxy-sandbox-lite-agent-gateway.md`。使用 `lark-cli drive +inspect` 确认是 file，再用 `lark-cli markdown +fetch --file-token ... --format json` 读取正文。

本轮只读取文档、检查现有实现和更新评审，没有创建轻部署项目、实际发布或删除 sandbox。文件中的 Agent 任务描述及清理要求属于参考流程，不是本轮用户授权的执行指令。

## 1. 文档确认的发布方式

轻部署经 AIProxy 网关完成，入口为：

```text
https://apiproxy.paigod.work/lite/internal-lite
```

使用现有 AIProxy Key，服务器发 `Authorization: Bearer <key>`。不能同时发 `X-API-KEY`。上游部署凭据由网关注入，用户不需要另提供 PPIO 或 Artifact Key。

| 步骤         | 文档给出的接口或条件                                           | 要检查的结果                                                 |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 准备应用     | `/app` 下的应用、构建方式和 Dockerfile；有 HTTP 端口及健康检查 | 应用在 sandbox 中能启动，健康检查可访问                      |
| 创建部署项目 | `POST /projects`                                               | 保存返回的 projectId；创建请求体与完整响应字段未在该文档展开 |
| 发布         | `POST /projects/{projectId}/deploy`                            | 提交真实端口、健康路径、sandbox 来源和 Dockerfile            |
| 查询部署状态 | `GET /projects/{projectId}`                                    | 文档描述等待 active / ready；具体响应结构和状态枚举仍需核实  |
| 检查访问     | 使用响应里的 endpoint                                          | 页面与健康检查实际可访问；首次冷启动允许有界等待             |

以上接口相对于轻部署入口，路径**不带 `/v1`**。部署请求的核心字段为：

```json
{
  "metadata": {
    "httpPort": 3000,
    "checkHealthPath": "/api/health"
  },
  "message": "publish verified application",
  "artifactsSource": {
    "sandboxId": "<create 响应体中的基础 sandboxID>",
    "path": "/app"
  },
  "dockerfile": "<与项目实际构建和启动方式匹配的 Dockerfile 内容>"
}
```

`3000` 与 `/api/health` 是示例，不能套用所有项目。Vite 开发预览端口与发布后应用端口也不必相同；发布配置必须与最终服务一致。

发布后的 endpoint 是独立部署结果，应与开发 sandbox 的 `getHost(port)` 预览分开登记。长期可用性的保留期限、计费、配额等未由文档明确承诺，不能据此保证永久在线。

## 2. 与 i-bot 当前实现的关系

[现有 AIProxy 说明](../aiproxysandbox.md) 已包含基本轻部署流程，但当前 API、core 和 types 未发现对应的完整发布功能。已有文档不代表已有用户入口和执行集成。

### 项目目录与发布目录

网页继续保存在 `/root/projects/<projectId>`，独立 `design.md` 与项目配置不迁移。参考文档指定从 `/app` 发布，接入时可在发布前从选定项目准备该目录，只放本次构建需要的文件。

同一 sandbox 有多个网页时，必须明确项目 ID 与版本，串行使用 `/app`，在部署方确认源码读取完成前不覆盖。不能根据当前可见的 tab 猜发布哪个项目。是否支持直接从其他路径发布，该文档未明确说明，需验证后再采用。

准备发布源码时排除 `.env`、平台密钥、浏览器 profile 及与构建无关的内容。依赖构建、生产启动及健康检查由项目类型决定，不直接发布开发服务器。

### sandbox ID 必须明确

| 值                          | 当前含义                                  | 是否可用于 `artifactsSource.sandboxId` |
| --------------------------- | ----------------------------------------- | -------------------------------------- |
| `SandboxHandle.id`          | i-bot 自己的 sandbox 行 ID                | 否                                     |
| `X-AIProxy-Sandbox-ID`      | 网关控制面 ID                             | 否                                     |
| create 响应体的 `sandboxID` | 基础 sandbox ID                           | 是                                     |
| SDK instance 的 `sandboxId` | 当前实现中的 `sandboxID-clientID` 复合 ID | 否                                     |

[handle.ts](../../packages/core/src/sandbox/handle.ts) 当前将 SDK 复合 ID 作为 `providerSandboxId`；[meta.ts](../../packages/core/src/sandbox/meta.ts) 也说明该值用于重连。[数据库 schema 的字段注释](../../packages/db/src/schema.ts) 仍把它描述为基础 ID，与实际赋值有差异。

因此发布功能不能直接传 `handle.providerSandboxId`。需要在 provider 边界获取并明确保存基础 ID，核实旧记录的恢复方式；不能靠字段名字或未经验证的字符串拆分推断。本轮只记录这一接入问题，没有修改 ID 或生命周期实现。

### 发布与 bot 生命周期

来源文档要求部署后清理开发 sandbox。其流程是一次性开发发布；i-bot 的 sandbox 承载个人 bot、桌面、登录状态和其他项目，不能因此自动销毁或停止其保活。

如果发布另外创建了临时构建 sandbox，检查部署和成果保存成功后，可按该临时资源的生命周期清理。bot 原有 sandbox 是否停止由用户及现有生命周期策略决定。

### 归属与权限

服务器持有共同的 AIProxy Key，网关 Key 所有权不能隔离 i-bot 用户。部署项目、版本与 endpoint 必须绑定 owner、bot、应用项目及目标；查询和发布先校验归属，不能信任用户或模型直接传入的 Lite projectId。

部署成功不代表访问权限已完成。公开访问、公司内部访问和私有访问如何配置，文档没有说明；需要分别确认。

## 3. 建议的产品流程

这是待实现设计：

1. 用户看到已验证的网页预览，选择“发布”；明确目标项目和访问范围。
2. 复用已授权的发布要求；需要人工确认时创建对应请求，等待期间继续允许构建、测试等独立工作。
3. 检查应用，准备发布目录和生产配置，创建或选择属于该用户的部署项目。
4. 发起发布，保存运行记录与返回标识，查询状态并检查 endpoint；不能只凭提交成功显示“已发布”。
5. 显示发布状态和访问链接，关联该版本源码与可下载成果；开发预览仍保留为独立状态。

发布任务可以由聊天或外部接口发起，但都使用同一项目归属、授权、执行状态和成果记录。用户不需要填写端口、sandbox ID、Dockerfile 或网关凭据。

## 4. 正式接入前仍需核实

- 当前 Key 是否有轻部署权限，具体账号配额、资源规格、费用及服务保留策略。
- 创建项目的请求与响应、部署 ID、状态与错误、构建日志的完整接口契约。
- 是否可直接读取 `/root/projects/<projectId>`，以及发布方何时完成源码读取。
- 再次发布、版本历史、回滚、删除项目的行为和接口；不能根据同一 deploy 路径猜测其语义。
- endpoint 的域名、HTTPS、自定义域名、访问控制、冷启动与健康检查规则。
- 静态网页和有后端的应用支持范围，以及数据库、持久磁盘、运行密钥注入方式。
- 部署完成后关闭开发 sandbox，endpoint 是否仍可访问；这是独立长期部署的关键验收。

这些是接入前的验证项，不影响把轻部署确定为现有评审中的发布方向。此次未做实际请求验证，不能声明当前 Key 已能成功部署。
