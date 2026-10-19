# i-bot Agent 框架与 SDK 选型回顾

原始讨论日期：2026-09-11（Asia/Shanghai）。整理日期：2026-10-13。

本文整理 Claude Code 中围绕 i-bot 的两轮 Agent 框架与 SDK 调研，覆盖 Vercel AI SDK、Mastra、OpenAI Agents SDK、Claude Agent SDK、LangGraph.js、Eve 和 Google ADK。讨论最终形成的选择是：**Vercel AI SDK 负责模型调用与流式消息，Mastra 负责 Agent 编排，Postgres 保存 Skill，Eve 作为 Bot 能力组织方式的参考。**

这里记录的是当时的需求、评价和决定，不是对这些框架最新版本的重新选型。原讨论没有提供统一条件下的运行测试、性能数据或完整多租户验收。本文保留选择理由，但不把当时的推断改写成已验证的能力；当前代码与该选择的差异见第七节。

## 一 当时要解决的问题

i-bot 的目标不是仅在本地运行一个编码 Agent，而是提供多租户的电脑操作 Bot 平台。用户可以在界面中创建独立 Bot，每个 Bot 使用独立的 PPIO sandbox，服务端运行 Agent，网页展示对话和桌面。

两轮讨论围绕以下要求比较技术方案：

- 同时运行多个用户的 Bot，并按用户和 Bot 隔离数据、凭据和执行环境。
- 后端通过远程工具操作 sandbox，支持浏览器、桌面和终端任务。
- 将模型文本和工具执行过程流式传给 Web。
- 保留更换模型提供方的空间，不把平台主流程绑定到某一家的编码 Agent。
- 从任务经验中保存 Skill，再在后续任务中按需加载。
- 遇到登录、验证码或需要人工操作的步骤时暂停，用户完成操作后继续。
- 使用 TypeScript，在独立后端中运行；当时规划为 NestJS，曾讨论 Railway 部署。

Skill 与人工参与后的继续执行需求改变了最初只使用 AI SDK 的建议：除模型调用和工具循环外，还需要处理会话状态、Skill 加载和暂停恢复。

## 二 第一轮比较

2026-09-11 10:52，用户要求比较 Agent SDK，并解释为什么使用 Vercel AI SDK。10:55 的回复比较了五个候选。

原回复把 AI SDK 视为模型调用与工具执行层，把 Mastra、OpenAI Agents SDK、Claude Agent SDK 和 LangGraph.js 视为提供更多执行管理能力的候选。因此，针对 i-bot，主要问题是：**直接使用 AI SDK 并自行实现状态管理，还是在模型调用之外引入 Agent 框架。** 这不表示所有候选都依赖 Vercel AI SDK。

| 候选              | 当时关注的用途                                         | 当时认为适合 i-bot 的地方                                                                   | 当时的顾虑与结论                                                                                            |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Vercel AI SDK     | 模型接口、工具调用、流式消息                           | 可对接不同模型提供方；模型提出动作后，由服务端执行远程 sandbox 工具；方便接入 Web 流式聊天  | Skill 检索、业务状态和暂停恢复仍需平台实现；保留为模型调用基础                                              |
| Mastra            | TypeScript Agent、memory、workflow                     | 希望复用记忆、工作流和 suspend/resume，减少自行实现执行状态的工作；当时认为便于嵌入独立后端 | 增加框架依赖，需要适配存储和执行方式；成为优先候选                                                          |
| OpenAI Agents SDK | OpenAI Agent 编排、工具和 handoff                      | 可以作为专门的 Agent 能力供平台调用                                                         | 原回复认为其与 OpenAI 绑定过强，因此没有选为主编排框架；这是当时的评价，不能据此断言该 SDK 无法使用其他模型 |
| Claude Agent SDK  | Claude Code 类执行能力、文件工具、MCP、子 Agent 和权限 | 当时认为适合在独立机器或文件系统中执行编码任务                                              | 原回复担心 Claude 依赖及平台适配工作；倾向作为可选编码能力，不作为多租户平台主框架                          |
| LangGraph.js      | 显式状态图、检查点和流程控制                           | 当时认为适合需要细致控制状态转换的复杂流程                                                  | 原回复认为 MVP 接入成本较高；保留为复杂执行流程的候选，没有做性能或开发成本实测                             |

第一轮给出了两条路线：

1. **直接使用 AI SDK。** 模型调用、工具执行与消息流保持直接控制；平台自行实现 Skill 加载、会话管理及暂停恢复。
2. **Mastra 配合 AI SDK。** 尝试复用框架的 memory 和 workflow 能力，同时保留 AI SDK 的模型接口和消息传输方式。

当时更倾向第二条路线，因为 Skill 保存与检索、人工参与后的继续执行都是近期需求。原回复曾提出用同一个“截图、点击、回传”任务做最小对照实现，但本次整理的两轮记录中没有该实验的结果。

## 三 第二轮补充 Eve 和 Google ADK

2026-09-11 11:02，用户补充要求比较 `eve.dev` 和 Google ADK。11:04 的回复将它们加入比较。

### Eve 的参考价值

原回复根据 Eve 的快速开始资料，记录其依赖包含 `eve`、`ai`、`zod`，并将其理解为通过目录约定组织 Agent 能力的框架。以下是当时提取的结构及其与 i-bot 的对应关系，具体 API 和支持范围需要按采用版本核实。

| 当时记录的 Eve 结构或能力 | 在 i-bot 中对应的需求                  |
| ------------------------- | -------------------------------------- |
| `channels/`               | HTTP 或消息平台入口，例如接收 Bot 消息 |
| `skills/`                 | 按需加载的任务方法、脚本和相关资料     |
| `sandbox/`                | Agent 的工作目录及运行资源             |
| `subagents/`              | 将任务交给具有独立职责的子 Agent       |
| `schedules/`              | 定期执行任务                           |
| `hooks/`                  | 处理生命周期和执行事件                 |
| 人工审批、等待和继续执行  | 需要人工决定或操作后继续的流程         |

当时认为 Eve 的能力组织方式与 i-bot 较接近，但没有直接采用，原因是 **文件定义的 Agent 如何适配动态创建的多租户 Bot 尚未验证**。

i-bot 需要允许用户在界面中新建 Bot、增加 Skill 和修改配置。如果以文件目录作为定义，需要明确目录生成、更新、加载、权限和隔离机制。数据库中的 Skill 如何生成运行时文件，也需要接入实现。原讨论没有证明 Eve 无法支持这些需求，而是将这些问题列为采用前必须验证的条件。

因此，Eve 当时被保留为架构参考和可能的单 Bot 执行引擎；没有把它作为 MVP 的必要依赖。

### Google ADK 的评价

原回复重点讨论 Google ADK 的 TypeScript 路径 `adk-js`，关注代码定义 Agent、多 Agent 编排及 Google 生态集成。

当时没有优先采用，是因为 i-bot 希望轻量起步并保持模型提供方可替换，尚未选择围绕 Gemini、Vertex AI 或 Google Cloud 构建平台。原回复认为 Google ADK 的集成方向与该阶段目标不够一致。这是项目适配判断，不等于 Google ADK 只能调用 Gemini，也不是对其能力不足的结论。

### 两轮合并后的选择

| 方案              | 当时给它的角色                            | 没有直接替代 Mastra 和 AI SDK 的原因                               |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Vercel AI SDK     | 模型与工具调用、流式消息的基础            | 单独使用时，仍需自行实现业务状态和恢复逻辑                         |
| Mastra            | 优先尝试的 Agent 编排框架                 | 需要将其能力接入 i-bot 的存储、权限与 sandbox 契约，不能只安装依赖 |
| Eve               | Bot 能力目录的参考；可能的单 Bot 执行引擎 | 动态 Bot、动态 Skill、多租户隔离和框架成熟度需要验证               |
| Google ADK        | Google 生态下的备选框架                   | 当时没有选择 Google Cloud 为主要平台，接入收益不明确               |
| OpenAI Agents SDK | 可选的专门 Agent 能力                     | 当时对模型依赖和主平台适配有顾虑                                   |
| Claude Agent SDK  | 可选的编码 Agent 能力                     | 当时更倾向将其用于独立编码任务，平台仍需管理租户与状态             |
| LangGraph.js      | 复杂状态流程的备选框架                    | 当时认为 MVP 尚不需要付出显式状态图的接入成本                      |

Cloudflare Agents 和 Inngest AgentKit 在准备第二轮比较时被提及，但两轮最终回复没有给出它们的具体对比；不将它们补写为已完成调研的候选。

## 四 为什么选择 Vercel AI SDK

当时选择 AI SDK，主要基于三个预期收益。

首先，模型接口与 sandbox 操作可以分开。模型返回工具调用，i-bot 的工具实现负责浏览器操作、截图、点击和命令执行，PPIO sandbox 提供运行环境。这样无需为了模型调用而把整个后端迁入某一家的编码 Agent。

其次，AI SDK 的流式消息方式与 Web 聊天需求相符。服务端输出文本和工具过程，前端可以沿用 AI SDK 的消息流消费方式；当时计划进一步通过 Mastra 与 assistant-ui 的适配连接聊天界面。

最后，希望为不同模型提供方保留统一的接入方式。**框架提供接口并不表示 i-bot 已实现多提供方切换。** 模型能力差异、消息转换、工具协议、凭据和错误处理仍需要项目完成适配。

## 五 为什么选择 Mastra

当时选择 Mastra，是为了在模型调用之外复用 Agent 执行管理能力，而不是为了替代 sandbox。

1. **Skill 与记忆需求。** 原讨论希望利用 memory 能力帮助加载任务经验，减少完全自行构建检索流程的工作。Skill 的权威数据仍保存在 Postgres，按用户和 Bot 的范围读取。
2. **暂停与恢复需求。** 原讨论希望用 workflow suspend/resume 表达等待人工操作、保存状态和继续执行，减少自行设计流程状态的工作。
3. **TypeScript 与独立后端。** 当时认为库形式的 Mastra 更容易嵌入规划中的 NestJS 后端，而无需以目录生成方式管理所有 Bot。
4. **与 AI SDK 和聊天界面的连接。** 当时规划通过 `@mastra/ai-sdk` 输出 AI SDK UI message stream，再由 `@assistant-ui/ai-sdk` 消费。这里是选定的接入方向，不是已完成的联调结果。

需要保留两个边界：Mastra 的 memory 不自动等于 i-bot 的 Skill 管理系统；workflow 的暂停恢复也不自动实现 VNC 桌面接管。数据库所有权、租户授权、运行状态和桌面控制权仍归平台管理。

## 六 用户确认与项目约定

2026-09-11 11:14，用户明确确认：

> 那就是使用Mastra，那还是走db ，结合vercel ai 作为底座

同一条消息还要求使用 assistant-ui 等聊天界面方案，并参考 Next.js、Vercel、Supabase 的视觉风格。这将之前的候选建议转为明确的项目选择。

随后规划的职责是：

| 部分              | 当时的选择                       | 职责                                 |
| ----------------- | -------------------------------- | ------------------------------------ |
| Web               | Next.js、assistant-ui            | 聊天、工具结果和人工参与界面         |
| API 与 Agent 编排 | NestJS、Mastra                   | HTTP 服务、Agent 运行和工作流状态    |
| 模型接口          | Vercel AI SDK                    | 模型调用、工具协议和消息流           |
| 执行环境          | 通过 AIProxy 访问的 PPIO sandbox | 浏览器、桌面、终端和文件操作         |
| 数据存储          | Postgres、Drizzle                | 用户、Bot、Skill、会话和相关业务记录 |

目前 [AGENTS.md](../../AGENTS.md) 仍记录 Mastra、AI SDK、NestJS 和 assistant-ui 的架构约定。同时，它明确规定：**MVP 不使用 pgvector；Skill 按作用范围加载，`embedding` 仅为未来预留；所有表和迁移由 Drizzle 管理。** 原讨论曾把语义记忆与 Skill 检索近似等同，并提到向量检索，不能据此覆盖当前项目约定。

## 七 与当前代码的区别

2026-10-13 整理时，按当前工作目录的依赖声明和源码核对了下列路径；这不是生产部署验收。

| 项目             | 当前代码证据                                                                                                        | 与历史选择的关系                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Agent 主循环     | [run.ts](../../apps/api/src/agent/run.ts) 直接调用 AI SDK 的 `streamText`                                           | AI SDK 已进入主要执行路径                                     |
| 模型提供方       | [model.ts](../../apps/api/src/agent/model.ts) 使用 `createAnthropic`                                                | 当前检查到的是 Anthropic 协议路径，不能视为已完成多提供方适配 |
| Mastra           | [core 依赖](../../packages/core/package.json) 声明 `@mastra/core`；在检查的 `apps` 和 `packages` 源码中未发现其导入 | 声明依赖不能证明 memory、workflow 或 suspend/resume 已接入    |
| HTTP 服务        | [server.ts](../../apps/api/src/server.ts) 使用 Hono                                                                 | 与规划的 NestJS 不一致                                        |
| 聊天界面         | [ChatPanel.tsx](../../apps/web/src/components/ChatPanel.tsx) 使用 `@ai-sdk/react` 的 `useChat` 和自有组件           | 与规划的 assistant-ui 不一致                                  |
| 浏览器与 sandbox | [core 依赖](../../packages/core/package.json) 声明 `playwright-core`、`ppio-sandbox`                                | 执行环境仍与 Agent 框架分开管理                               |

因此，“当时选择 Mastra 和 AI SDK”描述的是架构决定；不能据此宣称当前实现已经具备 Mastra 的记忆和工作流能力。后续相关评审见 [目标执行、会话与成果交付评审](./personal-agent-harness-review.md)。

## 八 原始记录与参考资料

### Claude Code 记录

原始工作目录为 `/Users/mac/Desktop/workspace/sandbox/i-bot`。本次从本机 Claude Code 会话直接读取原文；下表中的时间均为 Asia/Shanghai。

会话文件：`~/.claude/projects/-Users-mac-Desktop-workspace-sandbox-i-bot/6173426c-5f28-4f72-9a26-b4c4f8142c5e.jsonl`。该路径仅供本机追溯，文档本身不依赖读者访问完整会话。

| 日期与时间       | JSONL 行号 | 内容                                                                     |
| ---------------- | ---------- | ------------------------------------------------------------------------ |
| 2026-09-11 10:52 | 259        | 用户要求比较 Agent SDK，解释为什么使用 AI SDK                            |
| 2026-09-11 10:55 | 272        | 第一轮五个候选的比较，提出直接使用 AI SDK 和 Mastra 配合 AI SDK 两条路线 |
| 2026-09-11 11:02 | 275        | 用户补充 Eve 和 Google ADK                                               |
| 2026-09-11 11:04 | 287        | 第二轮补充比较，说明 Eve 的能力目录及多租户适配问题                      |
| 2026-09-11 11:14 | 295        | 用户确认 Mastra、数据库与 AI SDK 的组合                                  |
| 2026-09-11 11:17 | 305        | 后续补充 assistant-ui 与独立后端的接入规划                               |

根目录的 [架构报告](../../research-report.html) 主要保留了更早的 AI SDK 与 Codex 比较，没有收录上述两轮完整的 Eve、Google ADK 等选型内容。

### 原讨论引用的资料

这些链接保留原讨论的来源线索；网页内容可能变化，本次没有重新核实其最新能力或版本。

- [Eve 快速开始](https://eve.dev/docs/getting-started)
- [Google ADK TypeScript 快速开始](https://google.github.io/adk-docs/get-started/typescript/)、[google/adk-js](https://github.com/google/adk-js/)、[TypeScript ADK 发布说明](https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/)
- [Claude Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk)
- [Speakeasy Agent 框架对比](https://www.speakeasy.com/blog/ai-agent-framework-comparison)
- [Langfuse Agent 框架对比](https://langfuse.com/blog/2025-03-19-ai-agent-comparison)
- [DevOps Daily 框架文章](https://devops-daily.com/posts/top-5-ai-agent-frameworks-2026)
- [Ry Walker 框架分析](https://rywalker.com/research/agent-frameworks)

原对比没有为每一项评价提供固定版本的官方源码或测试证据。尤其是“锁定某家模型”“多租户能力内建”“安装后即可获得 Skill 检索和人工接管”“退出框架成本很低”等说法，后续采用时需要分别验证，不能仅凭历史评价决定实现。
