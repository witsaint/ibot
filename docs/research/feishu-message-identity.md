# 飞书消息发送身份与个人授权边界

核实日期：2026-10-13。依据飞书官方当前 Markdown 文档，必要处用飞书官方 CLI 文档交叉确认。本文核实规则并提出实现建议；未读取应用密钥、用户令牌或浏览器 cookie，未调用企业业务 API、未发送消息，也未验证 Triage 当前获批权限。

## 已确认的身份与接口

飞书提供正式的用户身份发送能力。`send_as_user` 在此是权限名称的一部分，不是独立的消息发送接口。`create` 和 `reply` 的请求头都允许 `user_access_token`；使用该身份发送时必须同时具备 `im:message` 与 **`im:message.send_as_user`**。后一个权限中，`message` 与 `send_as_user` 之间是点。官方 CLI 也明确说明，以 `--as user` 调用时发送者是完成授权的用户。[发送消息][create]、[回复消息][reply]、[官方 CLI 发送文档][cli-send]

| 接口       | 请求方式                                             | 官方列出的访问凭证                           | 发送身份及权限                                                                                                                                                          |
| ---------- | ---------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发送新消息 | `POST /open-apis/im/v1/messages`                     | `tenant_access_token` 或 `user_access_token` | 应用身份：`im:message`、`im:message:send_as_bot`、历史权限 `im:message:send` 三者之一。用户身份：同时需要 `im:message` 与 `im:message.send_as_user`。[发送消息][create] |
| 回复消息   | `POST /open-apis/im/v1/messages/:message_id/reply`   | `tenant_access_token` 或 `user_access_token` | 应用身份和用户身份的权限规则与发送新消息相同；回复还要求原消息可见。[回复消息][reply]                                                                                   |
| 转发消息   | `POST /open-apis/im/v1/messages/:message_id/forward` | 仅 `tenant_access_token`                     | `im:message` 或 `im:message:send_as_bot` 二者之一。当前文档没有给出用户令牌转发能力。[转发消息][forward]                                                                |

`tenant_access_token` 代表应用身份；`user_access_token` 代表应用使用者身份，能操作的资源受对应身份限制。通过 Triage 的应用令牌发送，发送者是该应用机器人；修改正文、签名或显示文案不会将其变成本人的平台身份。消息请求体没有供调用者任意指定发送者的字段，返回体区分 `sender_type=user/app` 与相应用户或应用 ID。[访问凭证选择][choose-token]、[发送消息][create]

转发是在指定原消息基础上生成一条转发消息，不能替代以本人身份创建新消息。转发要求原消息对操作者可见；红包、投票、语音、系统消息、加密消息等存在转发限制。[转发消息][forward]

## 群聊、单聊与消息类型的限制

`create` 接口支持指定用户或群聊：收件人类型包括 `open_id`、`union_id`、`user_id`、`email`、`chat_id`。官方 CLI 的发送文档同样说明支持用户身份或机器人身份向群聊和单聊发送消息。因此可以将“本人发送到公司内的普通群聊或单聊”作为产品目标，但仍须逐个验证真实应用、授权用户和目标会话。[发送消息][create]、[官方 CLI 发送文档][cli-send]

官方 `create` 前提条件要求应用开启机器人能力并发布；向用户发消息要求用户在机器人可用范围内；向群发消息要求机器人在群内且有发言权限。`reply` 也列出可用范围、机器人在群和发言权限条件。**这些页面在前提条件中没有单独说明使用用户令牌时，机器人是否也必须在群内，以及收件人可用范围是否采用完全相同的判定。**实施时保留这些官方条件，不据此承诺用户令牌可以向机器人未加入的任意群发送。此差异需要试点实测或飞书官方确认。[发送消息][create]、[回复消息][reply]

应用可用范围决定哪些人能够使用应用；应用权限申请、发布审核与用户 OAuth 授权是不同步骤。用户不能通过个人授权为应用开通尚未申请的权限。即使本人在飞书网页能够打开某个会话，也不能据此证明对应 OpenAPI 操作已经获权。[可用范围][availability]、[API 权限][permissions]、[授权码][authorize]

“支持以本人发送”不代表所有消息类型、会话或消息管理操作均支持用户身份：

- **系统消息 `system`**：仅允许 `tenant_access_token`，除发送接口权限外还需 `im:message:send_sys_msg`；当前分割线类型只在机器人与用户的单聊中生效。不能用它作为本人发送能力。[发送消息内容][content]
- **普通媒体和卡片**：发送接口列出文本、富文本、图片、文件、音频、视频、表情、卡片和名片等类型，但资源上传、资源归属及各类型格式仍有条件；不能只因拥有发送权限就承诺任意现成资源都可发送。首期建议先验收文本，再按所需类型逐项核实上传接口及授权。[发送消息][create]、[发送消息内容][content]
- **目标会话限制**：发送和回复的错误码列出跨租户单聊被禁止、密聊及密盾聊不支持、群禁言或租户沟通权限拒绝等情况；回复还可能因原消息不可见、已撤回、定时删除或话题条件失败。不能承诺覆盖所有会话。[发送消息][create]、[回复消息][reply]

本次只核实了发送、回复和转发接口。编辑、撤回、加急、Pin 等操作必须分别核实其访问凭证与权限，不能由 `im:message.send_as_user` 推导出全部操作能力。

## 多个个人 i-bot 与飞书机器人数量

机器人能力是在飞书应用上开启的，应用身份消息返回发送应用的 `app_id`。据此，**如果公司复用同一个 Triage 应用，多名员工各自拥有一个 i-bot，不会自动产生每人一个飞书机器人**：飞书侧仍使用该应用的机器人身份，i-bot 后端负责按用户区分 bot、任务、会话和授权。这个结论是依据应用机器人模型作出的设计推论，不是已验证的 Triage 部署事实。[启用机器人能力][enable-bot]、[发送消息][create]

每人单独完成 OAuth 授权后，同一应用可以在执行个人操作时选择该员工的 `user_access_token`；发送者因此是对应授权用户。用户令牌不能相互替换，也不能将一人的授权用于另一人的个人 agent。若产品要求每人拥有不同名称和头像的独立应用机器人，需要另行配置对应的飞书应用机器人；这属于应用管理方案，不由个人 OAuth 授权自动完成。[访问凭证选择][choose-token]、[启用机器人能力][enable-bot]

实现建议：在执行记录中明确保存“应用机器人发送”或“授权用户发送”、来源应用、所属用户、目标会话和返回的消息 ID。选择应用身份时走受控的 Triage 发送接口；选择用户身份时走所属用户的授权连接。身份必须由业务请求明确选择，不能在用户令牌缺失时静默改成机器人发送。

## 最小权限与持续授权

| 首期需求                        | 建议申请的最小权限                                | 额外条件                                                                                                                                               |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Triage 应用机器人发送或回复文本 | 应用身份 `im:message:send_as_bot`                 | 应用机器人能力已发布；满足可用范围、群成员及发言条件。不为单纯发通知先申请更宽的 `im:message`。[发送消息][create]、[回复消息][reply]                   |
| 本人发送或回复文本              | 用户身份 `im:message` + `im:message.send_as_user` | 应用已开通相应用户权限，用户完成 OAuth，实际令牌包含这两个 scope，并对目标资源有权操作。[发送消息][create]、[回复消息][reply]、[API 权限][permissions] |
| 无新对话时仍能持续调用用户 API  | 上述业务权限 + `offline_access`                   | 应用开通并在授权 URL 请求 `offline_access`；遵循实际到期时间及刷新配置。[刷新令牌][refresh]                                                            |
| 只需要收件人的 `open_id`        | 不因发送文本额外申请员工 `user_id` 权限           | 使用 `user_id` 或需要返回该敏感字段时，才按接口要求申请 `contact:user.employee_id:readonly`。[发送消息][create]                                        |

`offline_access` 使应用能够取得刷新令牌，不代表永久授权。刷新令牌只能使用一次，刷新成功会返回新令牌；应用应保存返回的实际 scope 和有效期，不能硬编码为永久或固定天数。官方要求用户授权达到 365 天后重新授权；撤销、到期、停用和可用范围变化也需要处理。[获取令牌][token]、[刷新令牌][refresh]

以下为安全持久化的实现建议，尚未完成代码或验收：

1. 后端持久化系统加密保存每名用户的授权连接、实际 scope、access/refresh 到期时间和状态；按 i-bot 所属用户、飞书应用、企业和授权用户绑定。授权令牌不进入模型上下文、普通日志或可下载的 sandbox 文件。
2. 同一授权连接的刷新只允许一个执行者；成功轮换时原子保存新令牌，服务重启后使用持久化记录恢复。遇到授权撤销或刷新失效时，停止相关任务并明确提示重新授权。[刷新令牌][refresh]
3. 每次调用先校验任务所属用户与授权连接所属用户一致。取得账号连接不等于用户已经要求发送消息；任务还应记录其明确授权的收件人、内容与发送身份。

## OAuth 身份与网页登录不能互换

OAuth 授权码交换取得的是用来调用 OpenAPI 的 `user_access_token` 和可选 `refresh_token`；消息接口要求这些访问凭证出现在 `Authorization` 请求头。官方这些接口没有把飞书网页 cookie、SSO 会话或浏览器登录状态定义为访问凭证。[获取令牌][token]、[发送消息][create]、[访问凭证选择][choose-token]

因此应分别处理以下三种状态；这是依据官方接口契约作出的实现判断：

- **i-bot 登录状态**：谁登录 i-bot，以及其能操作哪个 bot。
- **飞书 API 授权状态**：应用代表哪个用户、有哪些实际 scope、令牌是否仍有效。
- **sandbox 浏览器登录状态**：目标网页是否仍认可当前 cookie/SSO 会话，是否要求用户重新登录。

用户通过飞书 OAuth 登录 i-bot，不能自动认定其 sandbox 浏览器已经登录飞书网页；保存网页 cookie 也不能获得 OpenAPI scope 或刷新令牌。OAuth 后台刷新只维护 API 访问能力，网页任务能否持续执行需要单独验证。若需跨 sandbox 重建保留浏览器状态，应另行设计加密存储、所属用户校验、恢复和失效提示；本次没有核实飞书网页 session 的最长有效期，不承诺永久登录。[获取令牌][token]、[刷新令牌][refresh]

## 尚待实测和确认

1. 确认 Triage 实际 App ID、是否为应用机器人、当前已发布的应用权限和用户权限；验证 `im:message.send_as_user` 是否允许该应用申请、是否已获批准。不以已有机器人发送成功证明用户发送权限已开通。[API 权限][permissions]
2. 用试点员工授权完成一次本人文本发送到内部单聊和内部群聊，以及一次回复；记录真实 `sender_type`、发送者 ID、收件人和消息 ID，并在飞书客户端核对发送身份。本报告没有执行这些写入。
3. 对照测试应用机器人在群内/不在群内、收件人在可用范围内/外时的用户身份发送结果。当前文档的前提条件没有分拆这两种身份，不先下结论。
4. 分别验收 Triage 机器人发送与本人发送的身份选择、授权失败、目标会话拒绝、重复请求处理。发送接口的 `uuid` 去重有效时间为一小时，长期任务仍需要自身的发送记录。[发送消息][create]
5. 验证授权刷新轮换、并发刷新和服务重启恢复；另行验证浏览器重开、登录失效与 sandbox 重建后的网页任务恢复。API 验收不替代网页验收。

[create]: https://open.feishu.cn/document/server-docs/im-v1/message/create.md
[reply]: https://open.feishu.cn/document/server-docs/im-v1/message/reply.md
[forward]: https://open.feishu.cn/document/server-docs/im-v1/message/forward.md
[content]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json.md
[choose-token]: https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-choose-which-type-of-token-to-use.md
[permissions]: https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN.md
[availability]: https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability.md
[enable-bot]: https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability.md
[authorize]: https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code.md
[token]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3.md
[refresh]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3.md
[cli-send]: https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md
