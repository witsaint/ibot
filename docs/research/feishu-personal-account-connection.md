# 飞书个人账号连接与长期授权

核实日期：2026-10-13。本文补充 [飞书接入前置条件](./feishu-integration-prerequisites.md)，讨论缺少公司管理员配合时，复用 Triage 已有应用能力、连接个人账号的可行范围。平台规则仅引用飞书官方 Markdown 文档；下述方案与存储方式是实现建议。本次未读取密钥、未调用企业 API、未发起用户授权、未发送消息，未验证 Triage 当前权限或 i-bot 接入状态。

## 可以先做什么

可以复用已经批准且实际可用的应用权限，查询 Triage 获准访问的组织信息。若应用已经开通需要的用户身份权限、用户在应用可用范围内，则用户可以通过 OAuth 授权个人 agent 代其调用对应 API。个人授权不能为应用新增尚未开通的权限，也不能提升用户在公司中的组织架构可见范围。[授权码][authorize]、[API 权限][permissions]、[通讯录范围][contact-range]

这里有一个必须区分的事实：**应用身份**读取通讯录受应用的数据范围限制；**用户身份**读取通讯录不受应用的通讯录数据范围限制，而受当前用户的组织架构可见范围限制。后者仍要求对应 API 支持用户令牌、应用已开通对应用户身份权限、用户完成授权。因此个人连接可能取得与机器人不同的合法数据范围，但不会增加机器人权限。[通讯录范围][contact-range]、[API 权限][permissions]

“长期连接”可以实现后台持续刷新用户令牌；它仍有授权期限、撤销、用户停用和应用停用等条件，需要重新授权时必须提示用户。它不代表永久登录。[刷新令牌][refresh]

## 三种连接的用途

| 方式                          | 能完成什么                                                                    | 必须具备的条件                                                                       | 不能据此认定的能力                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 飞书 OAuth 登录 i-bot         | 换取令牌，获取登录用户身份，再由 i-bot 建立自己的会话                         | 可使用的应用、已登记的回调地址；用户完成授权；后端完成 code 交换与 `state` 校验      | i-bot 登录会话不会自动授权读取文档、消息或全公司通讯录。[授权码][authorize]、[用户信息][userinfo]                                                                            |
| OAuth 代用户调用 API          | 使用 `user_access_token` 执行已授权的读取或写入；有 `offline_access` 时可刷新 | 应用已开通对应用户身份 API scope、用户同意、接口支持用户令牌，且用户对资源本身有权限 | 用户点击授权不会新增应用权限、不会突破公司可见范围。[API 权限][permissions]、[通讯录范围][contact-range]                                                                     |
| 在 sandbox 浏览器登录飞书网页 | 在用户已经登录的网页会话内操作 UI                                             | 用户交互登录，网站仍认可浏览器会话；sandbox 与浏览器状态仍保留                       | 浏览器 cookie 不是 OAuth 刷新令牌，不能证明已有 OpenAPI 权限。本文未查到官方对网页 session 保持天数的承诺，不设固定天数，也不承诺 sandbox 重建后仍登录。此项为实现边界建议。 |

仅识别登录用户时，`GET https://open.feishu.cn/open-apis/authen/v1/user_info` 本身不要求额外 API 权限；手机号、邮箱、受雇信息及 `user_id` 等字段有单独的字段权限。不要为了登录先申请整套通讯录权限。[用户信息][userinfo]

## 没有公司管理员时的条件

| 当前条件                                        | 可以推进的范围                                                                               | 仍需谁完成什么                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Triage 是已经发布的企业自建应用，现有权限已生效 | 在已批准的 API 权限和数据范围内复用能力；已有用户身份权限时，可增加用户授权接入              | 应用管理者配置 i-bot 回调与合法的凭据使用方式；必要的新配置、权限或版本仍按企业审核规则处理。自建应用只在本企业发布和使用。[自建应用][self-app]、[API 权限][permissions] |
| 自建应用缺少用户身份业务权限或 `offline_access` | 可先实现连接页面、回调、令牌存储与模拟验收；若申请项属于企业已配置的免审权限，可在申请后生效 | 免审规则由企业管理员设置，不能预先保证某个 scope 免审；需审核权限要提交版本并通过审核。[API 权限][permissions]                                                           |
| 本人是应用开发者，需要调试用户 API              | 官方允许部分权限使用应用开发者自己的 `user_access_token` 免审调试                            | 敏感权限可能不支持免审；仅支持应用身份的接口不适用；这不证明正式用户、机器人或正式版本都已获权。正式发布仍遵循企业规则。[API 权限][permissions]                          |
| 企业已有可使用的商店应用                        | 按该应用已开放的功能及现有用户授权使用                                                       | 商店应用上架和租户安装/更新涉及平台与租户审核；不能认定换成商店应用就免公司审批。应用可用范围仍受企业配置约束。[API 权限][permissions]、[可用范围][availability]         |
| 希望发布自己的商店应用，供多个企业使用          | 可走商店应用发布流程                                                                         | 自己发布应用不是普通用户点一次授权；需应用发布、审核和企业安装条件。[商店应用发布][store-app]                                                                            |
| 自建测试企业或使用测试版本                      | 可以验证自己控制的测试数据与接口                                                             | 测试企业权限不自动生效于公司正式应用，更不能访问公司未授权的数据。[自建应用][self-app]、[API 权限][permissions]                                                          |

应用可用范围决定哪些用户能使用；通讯录数据范围决定应用身份能读哪些成员/部门，两者不是同一个配置。用户不在可用范围时，换令牌和刷新均可能返回 `20010`。[可用范围][availability]、[获取令牌][token]、[刷新令牌][refresh]

## 官方 CLI 与个人远程 MCP

**已有 Triage 应用时，可先评估官方 CLI 的用户授权。**官方指南支持在配置时选择已有应用，执行 `lark-cli auth login` 后由用户在飞书确认，再把 CLI 接入脚本或 agent 平台。指南同时明确，CLI 创建应用和使用应用仍受企业统一管控；缺少权限时要补充用户授权或申请应用权限。因此它能减少接入开发工作，不能承诺绕过公司审核。只需查状态时使用 `auth status`、`auth check`，正式授权由用户在既定流程内完成。[官方 CLI][cli]

实现建议：本地单用户原型可将现有应用配置为独立 profile，逐项检查支持的用户权限，再选择一项只读能力验收；接入多租户 i-bot 后，应为每个所属用户单独管理授权记录和执行 profile，并在调用时明确选择 profile。不要把 Triage 的机器人成员配置文件直接复制进所有用户的 sandbox。CLI 的自动刷新及本机凭据存储应另行核实安装版本，不能只因一次 `auth login` 成功就认定长期连接已验收。[官方 CLI][cli]

**个人远程 MCP 可以作为短期验证，当前不建议作为持续连接首选。**官方文档说明个人托管 MCP Token 将逐步下线，推荐使用 CLI；新创建的 MCP 服务自 2026-02-24 起有效期为 7 天，过期需重新授权，且配置平台仍标为内测。其 URL 相当于个人密钥。工具列表目前以云文档为主，基础人员工具返回姓名、头像、open ID，受本人可见范围限制；不能据此声明已支持完整组织树、日历或全部消息业务。[个人 MCP][personal-mcp]、[MCP 工具][mcp-tools]

## OAuth v3 与有效期

| 项目           | 官方规则                                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 授权入口       | `https://accounts.feishu.cn/open-apis/authen/v1/authorize`；传入 `client_id`、`response_type=code`、登记过的 `redirect_uri`、随机 `state`，按需附加以空格分隔的 `scope`。回调必须验证 `state`。code 仅可用一次，5 分钟过期。[授权码][authorize]       |
| 换令牌         | `POST https://accounts.feishu.cn/oauth/v3/token`，`grant_type=authorization_code`；开放平台创建的应用都是 Confidential Client，后端需要 `client_secret`。Public Client 尚未开放注册，官方文档仅列飞书官方 MCP 应用为 Public Client。[获取令牌][token] |
| 刷新           | 同一 v3 端点，`grant_type=refresh_token`。获取刷新令牌必须在应用后台开通 `offline_access`，并在授权 URL 的 `scope` 中请求该权限。[刷新令牌][refresh]                                                                                                  |
| 刷新安全配置   | 若控制台显示“刷新 user_access_token”开关，需要开启并发布应用使配置生效；看不到开关时，文档说明默认开启。[刷新令牌][refresh]                                                                                                                           |
| 令牌有效期     | 依据 `expires_in` 和 `refresh_token_expires_in` 计算绝对到期时间。官方样例中的 `7200` 秒和 `604800` 秒均注明非固定值，不应写成保证的 2 小时/7 天。[获取令牌][token]、[刷新令牌][refresh]                                                              |
| 单次轮换       | `refresh_token` 只能使用一次。成功刷新后立即保存新的 access token 与 refresh token，旧 refresh token 立即失效；旧 access token 在其原到期时间前仍可使用。[刷新令牌][refresh]                                                                          |
| 最长授权周期   | 用户授权应用达到 365 天后，必须重新授权取得令牌；持续刷新不能消除该限制。[刷新令牌][refresh]                                                                                                                                                          |
| 实际权限       | 以响应 `scope` 为准，服务端可能裁剪申请范围；交换/刷新时的 scope 只能缩减已授权范围。[获取令牌][token]、[刷新令牌][refresh]                                                                                                                           |
| 应用或账号状态 | 未安装应用、无可用权限、用户不存在/状态非法、应用不存在/未启用均可能导致失败；刷新到期或撤销后需重新授权。[获取令牌][token]、[刷新令牌][refresh]                                                                                                      |

文档有一处更新不同步：v3 换令牌文档已列出 `code_verifier` 并说明 PKCE；授权码文档仍写 PKCE 暂配 v2、后续支持最新端点。i-bot 服务端可以保存应用密钥，建议首期使用 Confidential Client 的服务端交换，并校验 `state`；若采用 PKCE，应另行完成 v3 实测，不因文档样例认定无密钥接入已经可行。[授权码][authorize]、[获取令牌][token]

## i-bot 的建议配置与实现

**必要配置：**选择一个可使用的应用，确认应用管理者能登记 OAuth 回调；准备 App ID、后端 App Secret 配置、回调 URL、目标企业与试点用户；列出首期具体用户操作，对照 API 开通最少的用户身份 scope。需要持续 API 连接时增加 `offline_access` 并确认刷新设置生效。是否需要提交新版本，按上面的企业规则和控制台状态核实。仅登录不要求 `offline_access`。[授权码][authorize]、[刷新令牌][refresh]、[API 权限][permissions]

以下为实现建议：

1. 在 i-bot 的持久化连接记录中绑定所属用户、`app_id`、`tenant_key`、`open_id`；将 i-bot 登录会话与飞书 API 授权分开管理。`open_id` 为应用内用户标识；不要以相同邮箱自动合并账号。[用户信息][userinfo]
2. 加密保存用户令牌、实际 scope、access/refresh 到期时间、初次授权时间与连接状态。令牌存储在后端的持久化系统，sandbox 只按需领取执行能力。应用密钥与用户令牌不进入模型上下文或普通日志。
3. 后台在两种令牌到期前安排刷新，包含用户长时间没有新任务的情况；同一个授权记录同时只能进行一次刷新，通过锁或版本检查避免多 worker 消耗同一个 refresh token。成功后在同一次数据库事务中更新新令牌和到期时间。
4. `20037`、`20064`、`20073` 等到期、撤销或已使用情况进入“需要重新授权”；`20009`、`20010`、`20069` 等记录为应用/可用权限问题。请求失败或响应丢失时，不盲目反复使用同一个一次性 refresh token；提示需要重新连接的原因。[刷新令牌][refresh]
5. 每次工具调用解析连接所属用户，并按该用户的令牌和实际 scope 决定能力。写入、发送消息等操作另外取得用户对该操作的授权；连接飞书账号本身不等于要求 agent 发送消息。
6. Triage 的组织查询保存来源应用、调用身份、来源时间、返回字段与授权范围。只查获准的数据；已知员工查成功不能证明全员同步完成。个人用户连接另行验收，不将其读取结果作为机器人新增权限的证据。
7. Triage 现有事件与消息入口继续由其现有服务处理。i-bot 首期用授权 API 实现个人连接；是否新增机器人事件订阅应另行设计并取得相应配置，不从令牌刷新推导事件已接入。

## 分别验收

- **登录：**回调 `state` 不匹配、code 重用、用户拒绝时均有明确结果；成功后绑定预期用户与企业，i-bot 会话可以正常恢复。
- **用户读取：**用授权用户令牌完成一项具体只读 API；记录实际 scope，验证一个本人无权访问的资源仍被拒绝。应用身份与用户身份分别记录结果。
- **持续刷新：**按真实返回的有效期完成一次成功轮换；服务重启后使用保存的新令牌继续读取；并发刷新不会消耗两次同一令牌；用模拟状态验证到期、撤销及 365 天重新授权提示。一次刷新不代表已经完成一年运行验收。
- **机器人组织查询：**分别记录已知用户查询、部门查询、成员列表与授权范围的结果；只有经过对应权限和覆盖性检查，才声明取得全员组织信息。
- **浏览器操作：**单独验证用户登录、浏览器重开与 sandbox 重建后的状态；API 刷新成功不能代替网页登录验收。

本报告只完成官方规则与方案核实；上述配置、接口联调、刷新运行和线上验收均尚未完成。

[authorize]: https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code.md
[token]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3.md
[refresh]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3.md
[userinfo]: https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get.md
[permissions]: https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN.md
[contact-range]: https://open.feishu.cn/document/ukTMukTMukTM/uETNz4SM1MjLxUzM/v3/guides/scope_authority.md
[availability]: https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability.md
[self-app]: https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process.md
[store-app]: https://open.feishu.cn/document/uMzNwEjLzcDMx4yM3ATM/uYjMyUjL2IjM14iNyITN.md
[cli]: https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu.md
[personal-mcp]: https://open.feishu.cn/document/mcp_open_tools/end-user-call-remote-mcp-server.md
[mcp-tools]: https://open.feishu.cn/document/mcp_open_tools/supported-tools.md
