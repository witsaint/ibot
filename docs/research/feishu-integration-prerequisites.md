# 飞书接入前置条件

首次核实日期：2026-09-30；范围更新：2026-10-13。首期范围：一个公司的企业自建应用；飞书登录、成员与部门同步、机器人通知和任务回复；先本地联调，正式域名以后配置。下述平台事实来自飞书官方文档和官方 Node SDK；实现建议单独说明。

## 当前公司配置状态

用户于 2026-09-30 补充：飞书管理员配置，以及应用的组织架构/通讯录读取权限可能尚未具备。该状态待管理员确认，尚未验证权限是否已生效及通讯录数据范围是否已配置。

成员与部门同步的真实联调、验收依赖上述配置完成；可先开发接口及模拟联调。本文列出的权限是接入要求，不代表当前公司应用已获得这些权限。登录、机器人消息和卡片回调的配置状态需分别确认。

2026-10-13 用户补充：当前没有公司管理员可配合，组织资料优先通过已有 Triage 机器人接入，个人飞书长期连接作为基础能力规划。处理方式调整为：先复用获准接口与部分组织资料，个人账号授权/浏览器登录先行，完整公司组织同步不作为个人使用的前提。

前次 Triage 核查记录显示：已知 OpenID 用户资料查询成功，根部门接口返回 `40004: no dept authority error`，没有证明全公司目录可用。来源是 2026-09-30 的检查记录，本轮没有在 Triage 生产运行环境重测，当前身份、接口和数据范围仍需维护者复核。不能用个人 CLI 的登录状态代替 Triage 机器人权限证明，也不能自动切换身份绕过权限失败。

个人用户 OAuth 是独立连接：应用已开放相应用户身份权限并获本人授权后，通讯录调用按本人组织架构可见范围处理；这与机器人应用身份的数据范围不同，不要求把机器人直接扩权为全员。未开放的 API 权限仍需应用配置，个人授权不会提升本人不可见数据的访问权。[通讯录权限范围](https://open.feishu.cn/document/ukTMukTMukTM/uETNz4SM1MjLxUzM/v3/guides/scope_authority)

长期连接的官方 OAuth、浏览器状态、CLI 与无管理员情况下的选择见 [个人飞书账号连接研究](./feishu-personal-account-connection.md)。i-bot 接入建议见 [开发计划](../plans/personal-agent-platform-development-plan.md)。

## 现在需要准备什么

| 事项                | 谁准备、在哪里准备                                                          | 首期要求                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 飞书企业与管理员    | 公司飞书管理员；[企业管理后台](https://www.feishu.cn/admin)                 | 确认目标企业，以及能审核自建应用、权限和数据范围的管理员。[发布流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)                                                                                                                                                                                                       |
| 企业自建应用        | 应用开发者；[开发者后台](https://open.feishu.cn/app)                        | 创建应用，添加开发协作者，启用机器人；若要从飞书工作台打开 i-bot，再配置网页应用能力与主页。[发布流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)                                                                                                                                                                     |
| App ID、App Secret  | 应用详情 → 凭证与基础信息                                                   | App ID 可用于配置；App Secret 放到后端的本地环境变量或密钥配置，不写入文档和前端。凭据取得位置见[获取用户令牌](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)。                                                                                                                                                            |
| 测试员工、部门与群  | 企业管理员、测试人员                                                        | 明确哪些人可使用应用，哪些成员和部门可被同步；机器人加入目标测试群。可用范围与通讯录数据范围分别配置。[可用范围](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability)、[通讯录范围](https://open.feishu.cn/document/ukTMukTMukTM/uETNz4SM1MjLxUzM/v3/guides/scope_authority)、[发消息条件](https://open.feishu.cn/document/server-docs/im-v1/message/create) |
| 本地 OAuth 回调 URL | 开发者先确定协议、主机、端口与路径，再由应用管理者加入安全设置 → 重定向 URL | 必须与实际 `redirect_uri` 匹配。**官方文档未明确承诺 localhost / 127.0.0.1 的接受条件，需在控制台保存并完成一次浏览器授权验证。**若不能保存或跳转，再准备临时可访问地址。[重定向 URL](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN)                                                                                                                                               |
| 本地后端运行环境    | 开发者                                                                      | Node 服务能访问飞书公网 HTTPS/WebSocket；使用官方 `@larksuiteoapi/node-sdk`。企业自建应用配置 `AppType.SelfBuild`、`Domain.Feishu`、App ID 与 App Secret。[官方 SDK](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)、[长连接事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)                                              |

实现建议：此刻先提供企业名称、管理员联系人、App ID、试点成员/部门、测试群，以及上述应用配置是否已完成。App Secret 由应用管理者写入后端密钥配置。`tenant_access_token`、用户令牌和群成员 ID 由接入过程获取，不要求人工复制长期固定令牌。

## 配置顺序与审批

1. 创建企业自建应用，确认应用所有者与开发成员，启用机器人能力。
2. 根据下表申请**应用身份**权限；另行设置应用可用范围与通讯录数据范围。仅登录且无需持续代用户调用 API 时，可以先不申请用户身份业务权限和 `offline_access`。
3. 开发者确定本地 OAuth 回调 URL，在安全设置登记；完成浏览器登录、换令牌和获取登录用户信息。localhost 是否被接受需实测。
4. 本地后端启动 SDK 长连接；事件订阅与回调订阅分别选择长连接，添加 `im.message.receive_v1` 与新版 `card.action.trigger`。官网要求配置长连接时保持客户端在线。[事件配置](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)、[回调配置](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address)
5. 按公司应用审核规则创建版本，写明使用场景、权限用途、可用范围和数据范围，提交管理员审核；通过后用试点成员与群验证登录、同步、通知和任务回复。[权限申请](https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN)、[自建应用发布](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)

审批边界：企业自建应用由企业管理员审核，无需飞书团队审核。权限是否免审由企业规则决定，不能仅凭 scope 名称保证免审；需审核权限要发布版本才生效。官方测试联调机制存在，但应用开发者使用自己的用户令牌免审调试，并不能证明机器人使用应用令牌已经可用。应用开发者变更可用范围需版本审核；企业管理员可在管理后台直接调整可用范围。[权限规则](https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN)、[可用范围](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability)

## 首期权限与接口

以下权限名已对照对应 API / 事件官方正文核实。通讯录建议使用具体读取权限组合，并把数据范围限定到试点部门；不要为同步读取申请通讯录写入权限。

| 用途                                             | 应用身份 scope / 配置                                            | 官方依据                                                                                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 查询已授权的通讯录范围                           | `contact:contact.base:readonly`                                  | [获取通讯录授权范围](https://open.feishu.cn/document/server-docs/contact-v3/scope/list)                                                                                                                                                 |
| 部门名称、状态                                   | `contact:department.base:readonly`                               | [获取子部门列表](https://open.feishu.cn/document/server-docs/contact-v3/department/children)                                                                                                                                            |
| 父部门关系、部门负责人                           | `contact:department.organize:readonly`                           | [获取子部门列表](https://open.feishu.cn/document/server-docs/contact-v3/department/children)                                                                                                                                            |
| 员工姓名、头像                                   | `contact:user.base:readonly`                                     | [获取部门直属用户列表](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department)                                                                                                                                  |
| 员工所属部门、直接主管                           | `contact:user.department:readonly`                               | [获取部门直属用户列表](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department)                                                                                                                                  |
| 员工离职、冻结等状态，用于成员停用               | `contact:user.employee:readonly`；如果首期同步状态，加入首期权限 | [用户列表的 status 字段](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department)                                                                                                                                |
| 机器人发通知、文本或普通 JSON 卡片、回复任务消息 | `im:message:send_as_bot`；机器人能力必须启用                     | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)、[SDK 卡片示例](https://github.com/larksuite/node-sdk/blob/main/README.zh.md) |
| 接收用户单聊任务                                 | `im:message.p2p_msg:readonly`；订阅 `im.message.receive_v1`      | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)                                                                                                                                                    |
| 接收群里 @机器人的任务                           | `im:message.group_at_msg:readonly`；同一消息事件订阅             | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)                                                                                                                                                    |
| 卡片按钮响应                                     | 回调订阅 `card.action.trigger`；这是回调名称，不是权限名         | [新版卡片回传交互](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)                                                                                                                      |

通讯录接口也接受较宽的 `contact:contact:readonly_as_app`，它能满足上述多个字段的读取条件；如果管理员选择这个方案，不必机械叠加所有对应字段权限。无论哪种方案，授权的数据范围仍然生效。查询根部门 `0` 时，应用必须有全员通讯录权限；部门试点应从被授权部门查询。[部门列表](https://open.feishu.cn/document/server-docs/contact-v3/department/children)、[员工列表](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department)

可选权限：按需读取邮箱 `contact:user.email:readonly`、手机号 `contact:user.phone:readonly`、租户内 `user_id` 字段 `contact:user.employee_id:readonly`。只有需要读取群内所有用户消息时，才评估敏感权限 `im:message.group_msg`。长期代用户调用 API 时，在**用户身份**申请 `offline_access`，并在用户授权的 `scope` 中请求它。[员工字段权限](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department)、[消息权限](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[刷新用户令牌](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)

## 登录与令牌

| 项目                  | 已核实行为                                                                                                                                                                                                                                              | 来源                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_access_token` | 代表应用在企业内操作；企业自建应用用 App ID / App Secret 向 `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal` 获取。最大有效期 2 小时，按响应 `expire` 管理；到期重新获取，不走用户 `refresh_token`。SDK提供令牌获取与缓存。 | [租户令牌](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)、[SDK](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)                                                                       |
| 飞书网页登录          | 浏览器打开 `https://accounts.feishu.cn/open-apis/authen/v1/authorize`，传 `client_id`、登记过的 `redirect_uri`，校验往返 `state`；服务端用一次性 code 换取用户令牌。code 有效 5 分钟，只能用一次。                                                      | [授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)、[换用户令牌](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)                                |
| 当前用户令牌接口      | 新接入使用 `POST https://accounts.feishu.cn/oauth/v3/token`，`grant_type=authorization_code` 换令牌、`grant_type=refresh_token` 刷新。旧 `/open-apis/authen/v2/oauth/token` 的官方文档已标为历史版本。                                                  | [v3 获取](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)、[v3 刷新](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3) |
| `user_access_token`   | 代表授权用户，以该用户的权限操作；获取登录身份可调用 `GET /open-apis/authen/v1/user_info`，返回 `open_id`、`tenant_key` 等。该接口本身不要求额外 API scope，邮箱、手机号等敏感字段有单独权限。                                                          | [获取用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)                                                                                                                                                       |
| 用户令牌刷新          | 有效期以 `expires_in` / `refresh_token_expires_in` 为准。获得刷新令牌需后台开通并由用户授权 `offline_access`；刷新令牌只能使用一次，刷新后需保存新令牌；授权达到 365 天需重新授权。后台若存在刷新安全开关，需确认已启用且配置已生效。                   | [v3 刷新](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)                                                                                                                                   |

实现建议：飞书完成身份确认后，由 i-bot 创建自己的登录会话。按 `app_id + tenant_key + open_id` 绑定身份，首次联调确认目标 `tenant_key`；不要凭邮箱相同自动合并账号。`open_id` 随应用而异，`user_id` 随企业而异。飞书返回的邮箱和手机号为管理员导入资料，官方不建议直接作为登录凭据。[身份说明](https://open.feishu.cn/document/home/user-identity-introduction/introduction)、[登录用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)

## 本地长连接与未来 HTTP 接入

- **本地消息、卡片可用长连接。**企业自建应用支持 WebSocket 接收事件与新版 `card.action.trigger` 回调，无需接收入站请求的公网 IP / 域名。旧 `card.action.trigger_v1` 卡片回调只支持 HTTP。官网有 Node SDK 新版回调示例；SDK README 的旧段落仍写“长连接不支持回调”，与最新官网说明不一致，按官网新版回调配置联调。[长连接事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)、[长连接回调](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address)、[SDK README](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)
- **短时间确认接收，再处理任务。**事件需 3 秒内处理成功，否则会重推；卡片交互需 3 秒内响应，回调没有事件式的补推机制。实现建议先记录消息和任务、返回确认，再异步执行耗时任务。多连接为集群投递，随机一个客户端收到，不能假定所有实例都会收到；每应用最多 50 个连接。[事件限制](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)、[回调机制](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/callback-overview)
- **长连接不替代 OAuth 回调。**网页登录的浏览器仍需能跳转到登记的回调 URL；正式域名以后登记。本地是否可登记 localhost 仍待控制台验证。[OAuth 重定向](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN)
- **未来改用 HTTP 时**准备飞书可访问的回调地址、Verification Token、Encrypt Key；地址验证请求含 `type=url_verification`、`token`、`challenge`，按文档在 1 秒内原样返回 challenge。新版事件/回调使用 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature`；签名按 timestamp + nonce + Encrypt Key + 原始 body 的 SHA256 核验，配置加密时解密 `encrypt` 字段。旧版卡片签名使用 Verification Token，与新版不同。[HTTP 回调配置](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server)、[新版验签](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)、[旧版卡片验签](https://open.feishu.cn/document/ukTMukTMukTM/uYzMxEjL2MTMx4iNzETM)

## 单企业与未来多企业

企业自建应用仅在创建它的企业内使用，适合首期单企业试点。未来以一个商店应用服务多个企业，需要应用商店发布审核、各企业安装和管理员授权；SDK 使用 `AppType.ISV` 并在调用时指定 `tenant_key`，还涉及 `app_ticket`、各企业令牌与安装状态。长连接仅支持企业自建应用，商店应用需采用 HTTP 事件接收地址。[SDK 的应用类型与租户配置](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)、[权限与商店审核](https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN)、[长连接限制](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)

未验证事项：目标公司的审批规则、实际已生效权限、试点数据范围、localhost 重定向可用性、所选 SDK 版本与真实卡片交互。本文只核实公开接入前置条件，未读取本机飞书凭据，未创建应用、发消息或变更企业权限。
