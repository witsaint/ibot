# 个人账号插件与网页登录状态

核实日期：2026-10-13。本文只核实 Google OAuth 和 Playwright 官方文档；没有登录私人账号、调用业务 API、发送消息或验证携程。下述产品安排是建议，不代表 i-bot 已实现。

## 用户已经确定的范围

i-bot 由本人操作，个人 bot 不共享。通讯录用于飞书机器人或 webhook 接收外部请求时判断请求者可以调用哪些能力；不是个人 bot 的共享成员列表。这是本次用户要求，不是外部平台规则。

## 一个应用插件可以包含多少能力

建议将 Google 邮件、文件和日历工具放在一个 Google 插件中，用户连接一次账号，随后按具体任务补充授权。一个 OAuth 访问令牌可以覆盖多个 API，但覆盖范围取决于实际获准的 scope。[Google Drive 授权][drive]

**一个插件包含多个工具，不等于用户已经同意全部权限。**插件中有工具、应用配置允许申请权限、账号实际授予权限和用户要求执行当前操作，需要分别判断。Google 允许用户只同意部分 scope；工具调用前应检查实际返回的 scope。[Google OAuth][oauth]

飞书插件也可以在产品上作为一个应用入口；其应用权限、用户授权和资源可见范围按 [飞书个人账号连接与长期授权](./feishu-personal-account-connection.md) 单独核实，不能套用 Google 的规则。本文没有再次核实飞书。

## Google 按任务授权

Google 推荐在需要相应功能时申请权限；`include_granted_scopes=true` 可以在增量授权后纳入之前已授予的范围。第一次只连接身份，不应据此认定可以读取邮件或全部文件。[Google OAuth][oauth]

以下为权限选择示例，不是完整工具清单；接口仍需逐项核实支持的 scope。

| 用户需要的操作       | 可评估的 scope             | 范围与限制                                                                                 |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| 查看邮件             | `gmail.readonly`           | 读取邮件和设置；属于受限权限。[Gmail scope][gmail]                                         |
| 发送邮件             | `gmail.send`               | 发信权限，属于敏感权限；不自动取得读取全部邮件权限。[Gmail scope][gmail]                   |
| 处理本人选择的文件   | `drive.file`               | 新建文件，以及用户向应用开放或通过应用打开的文件；不覆盖所有已有文件。[Drive scope][drive] |
| 读取全部 Drive 文件  | `drive.readonly`           | 查看和下载全部 Drive 文件；属于受限权限。[Drive scope][drive]                              |
| 查看日程             | `calendar.events.readonly` | 查看所有日历中的事件。[Calendar scope][calendar]                                           |
| 修改本人日历中的日程 | `calendar.events.owned`    | 查看、新建、修改和删除本人拥有的日历中的事件。[Calendar scope][calendar]                   |

因此可以提供一个 Google 插件，先开放已授权功能；用户需要新功能时再申请权限。它不能承诺“装一次就能调用 Google 的所有能力”。公开应用涉及敏感或受限权限时还需遵循相应验证要求。[Gmail scope][gmail]、[Drive scope][drive]

## Google 后台持续访问

需要本人离开网页后继续调用 API 时，服务端授权请求使用 `access_type=offline`，取得并安全保存 refresh token；它用于换取新的 access token，不是网页登录 cookie。Google 文档说明首次授权返回 refresh token，不能假定每次回调都会重新返回。[Google OAuth][oauth]

refresh token 可能因撤销、六个月未使用、涉及 Gmail 的账号改密、令牌数量限制或限时授权到期而失效；外部类型且处于 Testing 状态的应用，除仅请求基本身份 scope 的例外，refresh token 通常七天过期。持续刷新不能被描述为永久授权。[令牌过期][expiry]

实现建议：保存账号标识、实际 scope、到期时间与加密令牌；刷新失败时给出“需要重新授权”及具体原因。API 连接状态与网站浏览器登录状态分别记录。

## 通用网站登录后可以直接操作网页

对于携程这类网站，产品应允许本人在 bot 的浏览器中输入密码、扫码或完成验证；确认登录后，agent 继续使用该浏览器做网页动作。Playwright 提供点击、输入和选择等通用动作，并支持复用登录状态；这些动作不要求安装该网站的专用 API 插件。[Playwright 动作][actions]、[登录状态][auth]

这一结论是基于通用浏览器能力的设计判断：网站会话有效且网页动作可以执行时，缺少网站 API 插件不能成为阻止网页操作的产品条件。网页会话不会自动给 agent 该网站的官方 API 授权。携程实际页面、登录有效期、验证码和风控行为需另行实测。

## 浏览器状态保存与恢复

| 方式                                   | 官方支持与边界                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 继续使用现有浏览器上下文               | 沿用当前登录状态；网站仍需认可该会话。[登录状态][auth]                                                                                                                           |
| `storageState` 保存和载入              | 保存 cookies、localStorage；需要 IndexedDB 中的认证数据时显式启用 `indexedDB: true`，该选项自 v1.51 提供。接入时核对安装版本。[BrowserContext][state]                            |
| `sessionStorage`                       | Playwright 没有直接持久化 API；官方提供手动读取、按网站在新上下文中注入的示例。不能承诺 `storageState` 自动覆盖它。[登录状态][auth]                                              |
| `launchPersistentContext(userDataDir)` | 用指定目录保存 cookies、localStorage 等浏览器会话数据；同一目录不能由多个浏览器实例同时启动。使用独立自动化目录，不能直接使用日常 Chrome 默认资料目录。[BrowserType][persistent] |

已保存状态仍可能过期，官方明确要求过期后重新认证。持久目录或状态文件的存在不证明网站仍认可会话，也不证明换浏览器或重建沙箱后恢复成功。[登录状态][auth]

实现建议：同一 bot 使用其独立浏览器资料目录；登录后验证页面显示的账号，再保存必要状态；恢复后再次验证。沙箱重建前需要持久保存可恢复的数据，重建后仍应允许本人重新登录。状态文件可用于冒用账号，不能进 Git、模型上下文或普通日志。[登录状态][auth]

## 验收范围

待实现并验收：Google 部分 scope 授权、增量授权、后台刷新及撤销；网站手动登录、浏览器重开、沙箱重建后的状态恢复与过期重登。成功登录一次不能替代这些检查。本次只完成规则研究；不承诺携程 API、长期免登录或风控通过。

[oauth]: https://developers.google.com/identity/protocols/oauth2/web-server
[expiry]: https://developers.google.com/identity/protocols/oauth2#expiration
[gmail]: https://developers.google.com/workspace/gmail/api/auth/scopes
[drive]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[calendar]: https://developers.google.com/workspace/calendar/api/auth
[actions]: https://playwright.dev/docs/input
[auth]: https://playwright.dev/docs/auth
[state]: https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state
[persistent]: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
