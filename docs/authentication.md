# 登录会话与续期

## 当前策略

- 使用 Better Auth 的 HttpOnly Cookie 和 Postgres 会话，不使用 access token / refresh token 双 token。
- 会话有效期为 7 天。会话仍有效且距离上次续期超过 24 小时，访问受保护接口会将有效期延长到当前时间之后 7 天。
- API 鉴权中间件将 Better Auth 产生的每条 `Set-Cookie` 返回浏览器，数据库和 Cookie 的有效期一起更新。过期时同样返回清除 Cookie 的响应头。
- API 重启不会清除数据库会话。保持数据库和 `BETTER_AUTH_SECRET` 不变，已有有效登录继续可用。

## 页面行为

- 工作区和设置页在打开、恢复到前台、网络恢复时检查会话；可见期间每 15 分钟检查一次，相邻的前台事件合并处理。
- 会话过期的响应是 HTTP 401，包含 `error: "unauthenticated"` 和中文提示。普通 API 请求和聊天请求统一处理此错误。
- 过期后跳转到登录页，保留当前路径、查询参数和页内位置；登录成功返回原页面。
- 返回地址只接受站内的工作区和设置页，拒绝外部链接和登录页，防止跳转到外站或循环跳转。
- 网络错误、服务端错误、密码错误不会被当成会话过期。登录恢复后不自动重放聊天、启动桌面或其他修改操作。
- 已经超过有效期的会话不能继续续期，需要重新登录。

## 验证

前端请求与返回地址测试：

```sh
pnpm --filter @i-bot/api exec tsx --test ../web/tests/session.test.ts
```

真实登录与续期集成测试（仅允许本地 Postgres，通过环境变量提供 `DATABASE_URL`）：

```sh
AUTH_DB_TEST=1 pnpm --filter @i-bot/api exec vitest run src/middleware/auth.integration.test.ts
```

集成测试创建独立临时数据库并执行迁移，结束后删除，覆盖普通接口与事件接口续期、过期拒绝与 Cookie 清除、未到续期时间的会话。
