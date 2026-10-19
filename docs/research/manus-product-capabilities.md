# Manus 2.0 与当前公开产品能力

调研日期：2026-09-29。范围：官方发布文章、产品文档、帮助中心与 API v2 文档。这里记录的是公开声明和接口契约；没有登录 Manus、购买资源、执行任务或实测发布。

## 1. 版本与发布日期

- Manus 官方博客将 **Introducing Manus 2.0** 标为 **2026-09-28**；帮助中心称它为当前版本。[官方博客索引](https://manus.im/blog)、[2.0 发布文章](https://manus.im/blog/introducing-manus-2-0)、[2.0 帮助说明](https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0)
- 2.0 首发强调 Cascade 按需装入专门能力、Manus Studio、视频编辑、游戏开发、远程控制、事件触发 Automations 和独立的 Cue。[2.0 发布文章](https://manus.im/blog/introducing-manus-2-0)
- 网页构建、发布、自定义域名、定时任务、Cloud Computer 不是全部在 2.0 才首次出现：官方索引已有 2025-12 自定义域名、2026-04 Cloud Computer、2026-05 Scheduled Tasks 2.0、2026-06 Hosting Modes、2026-07 Auto-Publish。[官方产品索引](https://manus.im/blog/product)
- Cascade 的效率数字来自官方单个测试配置，不能解释为所有任务的平均提升；本研究不采用这些数字作为产品选择依据。[2.0 帮助说明](https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0)

## 2. 2.0 首发重点

| 能力 | 官方描述 | 边界与对 i-bot 的启发 |
| --- | --- | --- |
| Cascade | 项目保持连贯，在需要时加入专门能力。 | 可以让网页创作、文档、自动化分别按需加载；不意味着每次对话都加载所有技能。[发布文章](https://manus.im/blog/introducing-manus-2-0) |
| Studio | 人与 AI 共用的创作工作区，根据作品需要加入专业工具；用户修改作品后可交回 agent 继续完善。 | 核心是人与 agent 在同一作品上持续修改。i-bot 可以围绕网页、文件与任务继续工作，用户已明确不需要网页视觉编辑器。[发布文章](https://manus.im/blog/introducing-manus-2-0) |
| Remote Control / Computer Use | 手机语音指令；电脑画面直播；在获准的独立工作区执行。 | 是授权本机执行的产品能力，不能等同于任意第三方账号操作都无需确认。[发布文章](https://manus.im/blog/introducing-manus-2-0) |
| Automations | 从只按时间运行，扩展到连接服务的事件触发。 | 对 i-bot 最直接的方向是让现有 agent 在时间和事件到来时继续原任务。[发布文章](https://manus.im/blog/introducing-manus-2-0) |
| Cloud Computer | 给需常驻的自动化或多人游戏提供独立运行环境。 | 持续运行的服务与临时开发环境有不同生命周期。[帮助说明](https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0) |
| Cue | 独立的个人 agent 产品；每个 agent 有邮箱、电话、钱包、电脑，可组队协作。 | 官方说明仍需邀请码。未核实国家覆盖、消费限制、各身份能力的完整 API 或 SLA，不应直接承诺这些能力。[发布文章](https://manus.im/blog/introducing-manus-2-0)、[帮助说明](https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0) |

## 3. 网页从预览到可持续使用

### 发布与域名

- 构建后从预览确认，再点击 Publish；平台处理生产构建、部署和托管。域名可连接已有域名或在产品内购买，自动配置 SSL。已有域名仍需要用户在注册商处添加提供的 DNS 记录。[Publishing](https://manus.im/docs/website-builder/publishing)
- 较新的帮助中心（2026-07-24）称自定义域名完整支持付费用户；早期发布文章曾写所有用户可用。以较新的帮助说明保留付费边界，不将旧文章当作当前权益承诺。[域名帮助](https://help.manus.im/en/articles/11711203-how-can-i-connect-the-website-created-by-manus-to-my-custom-domain)、[早期域名公告](https://manus.im/blog/manus-custom-domains)
- Auto-Publish 是用户主动开启的选项，默认关闭；成功构建后自动发布，失败构建保持上一稳定版本。可以关掉并回到手动发布。[Auto-Publish](https://manus.im/blog/manus-auto-publish)

### 托管与后端

- 当前文档将网页托管分为 Autoscale 与 Reserved。Autoscale 在请求到来时启动并弹性扩容；Reserved 是常驻单进程，适合 WebSocket、后台 worker、机器人与长任务。不要把临时 sandbox URL 当成已发布服务。[Publishing / Hosting Modes](https://manus.im/docs/website-builder/publishing#hosting-modes)
- 网页应用可以有后端、持久数据库、文件存储，支持登录、表单处理与外部 API；这是一套应用基础设施，超过单纯前端预览。[Cloud Infrastructure](https://manus.im/docs/website-builder/cloud-infrastructure)
- 提供代码复制与完整前后端源码下载；GitHub 集成可导出到新建私有仓库，并在其 main 分支推送及修改前拉取。文档提示仓库改名或转移 owner 可能断开连接。[Code Control](https://manus.im/docs/website-builder/code-control)、[GitHub Integration](https://manus.im/docs/website-builder/github-integration)
- 内置分析记录访问者、浏览量、来源等；数据库功能有可查询、编辑记录的界面。[Project Analytics](https://manus.im/docs/website-builder/project-analytics)

### 应用自己可以执行任务

- 应用可以创建自己拥有的定时任务，也可以让应用终端用户创建自己的提醒、邮件或报告任务。agent 会写后端逻辑并登记 cron。[App Schedules](https://manus.im/docs/website-builder/schedules)
- 当前文档列出最小 1 分钟、每应用最多 5 个 schedule、UTC 时间，并称失败会指数退避重试、最多总计 3 次。管理界面有下次运行、成功率、耗时与运行历史，以及 Investigate 错误分析入口。[App Schedules](https://manus.im/docs/website-builder/schedules)
- 网页数据事件可触发通知，例如新表单、销售、评论、注册；默认邮件和站内消息，移动 app 可接收推送。[Notifications](https://manus.im/docs/website-builder/notifications)

## 4. 自动化：三种启动方式，共用结果与异常处理

当前官方 Automations 文档公开三种类型：Schedule、Triggered task、Advanced automation（Beta）。最后一种从自然语言生成包含多个来源、条件与动作的流程，用户启用前核对时间、条件、动作和账号。[Automations](https://manus.im/docs/automations)

- 事件来源包括 GitHub、Shopify、Gmail、Outlook、Notion、Calendar、RSS、Webhook 等，但实际选项依连接账号和产品可用性决定。[Automations](https://manus.im/docs/automations)
- 不能统称所有触发源为实时：受支持的 GitHub、Shopify、Webhook、Mail Manus 事件可以及时送达；部分其他来源是周期性检查。各来源的事件和条件字段不同。[Automations](https://manus.im/docs/automations)
- 管理入口有暂停、试运行、查看原任务、编辑和删除；Updates 展示时间、状态、结果摘要。可以测试匹配事件和不匹配事件；连续重复失败可能暂停触发器。[Automations](https://manus.im/docs/automations)
- 若提供运行选项，可继续同一任务，沿用消息、文件、决定和待更新作品；独立运行则创建新任务。[Automations](https://manus.im/docs/automations)
- 2026-05 的 Scheduled Tasks 2.0 已支持继续原任务，以及使用 Project 的文件、skills、连接器和输出标准；2.0 将这些时间触发统一到 Automations。[Scheduled Tasks 2.0](https://manus.im/blog/manus-schedules)

说明：浏览工具无法直接解析 Automations 页面；直接 HTTPS 获取官方 `https://manus.im/docs/automations.md` 返回 200 和完整 Markdown，以上事实据该一手文档核对。

## 5. 帮用户执行与账户连接

- Cloud Browser 可访问、填写表单和执行跨网页操作；用户登录后可使用已授权账号。验证码、短信或多因素验证需要通知用户 Take Over，用户完成后交回 agent。[Cloud Browser](https://manus.im/docs/features/cloud-browser)
- 官方承认 Cloud Browser 使用数据中心 IP，部分网站会增多验证或检测为自动操作；不能把浏览器执行的成功率当作保证。[Cloud Browser](https://manus.im/docs/features/cloud-browser)
- Browser Operator 是本机浏览器扩展，使用现有登录会话。每次控制会话要授权，可关闭 tab 停止；从手机发起时，桌面浏览器仍需在线。[Browser Operator](https://manus.im/docs/features/browser-operator)
- 本机 My Computer 要选择授权目录；文档列出 Allow Once / Always Allow 命令许可。电脑开机且 app 运行时可远程分配任务。这与云端常驻服务的在线条件不同。[Desktop](https://manus.im/docs/features/desktop)
- MCP 连接器支持读取和服务允许的有限写入，如更新票据、创建事项。连接的 OAuth 授权与每次具体动作确认是两件事；不能因连接成功就推断所有外部写入免确认。[MCP Connectors](https://manus.im/docs/integrations/mcp-connectors)、[Task Lifecycle](https://open.manus.im/docs/v2/task-lifecycle)
- API 支持显式选连接器；未指定时按项目默认、用户默认选择。续聊若未重新指定，复用任务既有连接器配置。[API Connectors](https://open.manus.im/docs/v2/connectors)

## 6. API 与 Webhook：输入和输出要分开

### 外部系统启动 agent

- API v2 支持异步创建任务、续聊、读取进度和结果、停止、项目、文件、skills、agents 等；当前官方介绍称 v1 已弃用。[API Introduction](https://open.manus.im/docs/v2/introduction)
- 入站事件可以经 Automations 的 Webhook 触发任务；另一方式是外部程序或 Zapier 收到事件后调用任务创建 API。公开 Zapier 文档将第三方事件、agent 任务和结果后续处理串起来。[Automations](https://manus.im/docs/automations)、[Zapier](https://manus.im/docs/integrations/zapier)

### agent 状态通知外部系统

- API 出站 webhook 将 HTTP POST 送到调用方的 callback，事件为 `task_created`、`task_stopped`。后者区分 `finish` 与 `ask`，并可包含文件、问题选项和结构化输出。[Webhooks Overview](https://open.manus.im/docs/v2/webhooks-overview)
- `ask` 不能视为完成。普通问题通过 `task.sendMessage` 回答；支持的动作通过 `task.confirmAction` 按具体 schema 确认；OAuth 与配置等待可能需 UI 或外部授权。主 agent 停止后后台工作仍可能继续，需检查 `has_running_background_jobs`，未知值不能当成没有后台任务。[Task Lifecycle](https://open.manus.im/docs/v2/task-lifecycle)
- Webhook 签名使用 RSA-SHA256，包含时间戳和请求 URL / 原始 body 的摘要；文档要求验证来源及约 5 分钟的新鲜度。这里只核实了契约，未测试消息投递。[Webhook Security](https://open.manus.im/docs/v2/webhooks-security)

### 网站发布 API

- `website.status`、`website.listCheckpoints`、`website.publish`、`website.update` 构成查状态、看版本、发布、改配置。发布是异步操作，需查询最终状态和实际 URL。[Website API](https://open.manus.im/docs/v2/website)
- 网站有独立 `website_id`，与任务 ID 区分；URL 可含 Manus 默认域名、配置子域名、已绑定自定义域名。API 发布默认公开，非公开再次发布需要明确携带 visibility。[Website API](https://open.manus.im/docs/v2/website)
- API 只能发布最新 checkpoint，不能选择旧 checkpoint；公开 API 目前没有 unpublish 端点。一个 session 预期只有一个网站，若有多个只取第一个。这些是接口边界，不适合照搬为 i-bot 的多网页识别方式。[Website API](https://open.manus.im/docs/v2/website)

## 7. 常驻计算与临时开发分开

官方 Cloud Computer 文章将临时 sandbox、本机 Desktop、长期 Cloud Computer 分开：长期环境保存文件和已安装工具，可运行脚本、数据库与 24 小时机器人；每个任务仍从临时 sandbox 开始，再根据需要选择长期环境。公告提供 SSH / Web Terminal，称当前是命令行环境。[Cloud Computer](https://manus.im/blog/manus-cloud-computer)

这篇文章还称停止付费会关闭持久 sandbox 并删除工作文件，而已经交付的结果保留在任务中。这里没有核实恢复、备份、网络开放、SLA 或账单细节，不将“持续运行”理解为永久无条件保存。[Cloud Computer](https://manus.im/blog/manus-cloud-computer)

## 8. 给 i-bot 的建议（推断，非 Manus 已实测事实）

1. **先完善交付。** 网页预览之后提供独立发布地址、访问权限、更新和撤下，代码与资源可以从临时 sandbox 恢复；有长期后端再选择合适托管方式。用户无需理解端口或平台。
2. **让结果可以持续更新。** 自动化指向已有 bot / 任务 / 网页，不强迫每次产生新对话。保留必要的作品 ID、发布版本和资源引用即可，无需加网页记录管理页面。
3. **用统一执行入口连接触发方式。** 手动消息、定时、Webhook、应用按钮只是不同输入；共用队列、权限、状态、取消、超时、失败处理与结果通知。
4. **建立授权与人工接手。** OAuth / 登录、自动执行范围、单次动作确认、验证码接手和撤销控制要分别呈现。需要用户时说明目标和原因，用户回答后继续。
5. **让常见自动化可先试一次。** 创建时显示自然语言规则、账号、条件、结果去向；匹配和不匹配测试后启用。界面主要呈现下次运行、最近结果与异常，不必先做复杂流程画布。
6. **按需引入技能。** 延续 `/web` 插件结构，分别扩展发布、连接服务与自动化技能；底层工具负责权限和确定性参数，agent 负责内容、步骤判断和结果解释。

## 9. 未确认项

- Manus 2.0 上线仅一天：套餐、地区、账户批次差异未在真实账号验证。
- 自动化各连接器的完整事件列表、轮询时间、去重、重试、并发限制和配额未找到统一可核实的公开规格。
- 入站 Webhook 的具体鉴权、重放防护、事件 schema 和租户隔离未从 Automations 概览得出；出站 webhook 的签名文档不能代替入站规格。
- 自动化失败的通知渠道、节流、去重和跨渠道可达性没有实测；网页活动通知与 agent 任务通知不能混为一项。
- 当前网站 API 文档所列 visibility、默认公开、无法指定旧版本与无法 API 撤下已明确；UI 是否提供完整回滚和撤下未进行账号检查。
- Cloud Computer 的购买价格、资源选择、备份与停付后的恢复策略未实测；不要在 i-bot 需求里假设临时 sandbox 天然具备这些保障。
- Cue 身份、支付、外部电话号码和多 agent 协作只确认官方发布说明，尚未核实完整使用边界。
