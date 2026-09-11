AIProxy Sandbox + 轻部署 Agent 使用指引
本文给用户侧 Agent。目标：只凭用户自己的 AIProxy Key，通过 AIProxy 网关完成 Sandbox 开发和轻部署发布。
用户只需要提供一项内容
export AIPROXY_API_KEY="<替换为你的 AIProxy Key>"

Agent 不要向用户索要：上游 PPIO Key、Artifact / 轻部署上游 Key、渠道 ID、上游 base URL、runtime domain、内网 allowlist、Sandbox 模板 ID。这些都由管理员在网关侧配置好，或由本文流程自动发现。
鉴权
手写 HTTP 请求统一用：
Authorization: Bearer ${AIPROXY_API_KEY}

只能携带一种用户凭据。 同时发送 Authorization 和 X-API-KEY 会被网关拒绝（sandbox_gateway_conflicting_credentials）。轻部署若需上游额外鉴权，由渠道配置在南向请求中注入，Agent 不处理。
选择入口
Sandbox 控制面地址必须带渠道 slug，形如：
能力
地址
Sandbox 控制面
https://apiproxy.paigod.work/sandbox/c/{slug}
轻部署
https://apiproxy.paigod.work/lite/internal-lite

{slug} 由管理员或用户给出，已知两个值：ppio-sandbox-internal（runtime 域 sandbox.paigod.work，网关代理域）和 ppio-sandbox-public（runtime 域 sandbox.ppio.cn，上游直连域）。两者的 runtime 域不通用，用错会在 envd 阶段得到 502 The sandbox was not found，详见第 6 节。拿不到 slug 时向管理员要，不要自己猜。
不要用不带渠道的 https://apiproxy.paigod.work/sandbox。 那个短别名只在 workspace 恰好启用一个 ppio 渠道时可用；启用了第二个之后，它对所有 Sandbox 生命周期路径返回 409 ambiguous_sandbox_channel。这是有意的 fails-closed 设计——网关在有多个候选时拒绝替你猜，而不是随机挑一个。该条件自 2026-08-14 起在本网关上已成立，所以现在把它当默认值会在第 4 节的模板发现那一步就失败。
slug 路由指向特定渠道，不同渠道的能力和限制不同（可用模板、运行时长上限、runtime 域名、envd 版本都可能不一样）。不要假设本文某个实测数字在所有渠道上成立——用第 4、5 节的方法现场确认。
条件允许时先读网关自述配置：
GET https://apiproxy.paigod.work/api/enterprise/my-access/runtime
Authorization: Bearer ${AIPROXY_API_KEY}

响应里的 agent_gateway 给出 sandbox_base_url、template_discovery_paths、template_selection、lite_base_url、lite_deployments_url。该接口从公网通常不可达（实测返回 nginx 的 {"error": "forbidden"}，说明请求没进到应用层），读不到就用用户或管理员给的 slug 地址继续，不要卡在这一步，也不要退回不带渠道的 /sandbox——那条路径会 409。
SDK 接入：必须覆盖控制面 api_url
用 PPIO / E2B 兼容 SDK 时，先设环境变量：
export PPIO_API_KEY="${AIPROXY_API_KEY}"   # 值是 AIProxy Key，不是上游 PPIO Key
export E2B_API_KEY="${AIPROXY_API_KEY}" # 仅 E2B 兼容 SDK 需要

然后在 SDK 初始化时显式覆盖控制面 base URL：
api_url / base_url = <第 2 节确定的 Sandbox 控制面地址>

不要用 domain 参数代替 api_url。 SDK 通常把 domain 拼成 https://api.{domain}，把网关地址填进 domain 会得到 https://api.apiproxy.paigod.work/sandbox 这种错地址。domain 只用于 runtime/envd，取值见第 6 节。
覆盖只影响控制面（模板发现、创建、查询、删除、connect、timeout）。创建成功后 files._、commands._、getHost 走 runtime/envd，用响应里返回的 host 和 token。
ID 有三个，语义不同，不可互换：
ID
来源
用途
X-AIProxy-Sandbox-ID
create 的响应头
AIProxy 控制面操作（GET / DELETE / connect / timeout）
sandboxID
create 的响应体
轻部署 artifactsSource.sandboxId
sandboxID-clientID
响应体两字段拼接
envd runtime host；部分渠道的 DELETE 也接受它

选模板并创建
不要让用户填模板 ID。按顺序确定：
先发现账号可见模板：
GET <sandbox base>/v2/templates

/v2/templates 不适配就试 <sandbox base>/templates。返回 403 表示没有发现权限，不影响下一步。
列表里有合适的就用它返回的真实 templateID。
列表为空或没有你要的规格，不代表不能用。 公共别名和部分模板不出现在账号私有列表里，但 templateID 可以直接创建成功。已知可用值：
e2b/base（公共别名，必须写全，不能简写成 base / default）
用户或管理员直接给你的 templateID
拿到一个不在列表里的 templateID 时，直接尝试创建，不要因为「列表里查不到」就报告不可用。
只有当创建也返回 template not found 或明确权限错误时，才报告模板不可用。
创建：
POST <sandbox base>/sandboxes
Authorization: Bearer ${AIPROXY_API_KEY}
Content-Type: application/json

{
"templateID": "<template id>",
"timeout": 3600,
"metadata": { "long_running": "true" }
}

timeout 取值见第 5 节；long_running 的含义和不可逆性见第 5 节。
规格由模板唯一决定。 请求体里传 cpuCount / memoryMB 会被静默忽略——返回 201，但 GET 出来仍是模板的规格。想换 CPU / 内存只能换模板，不要试图在创建请求里指定，也不要因为返回 201 就认为生效了。
创建后记录：响应头 X-AIProxy-Sandbox-ID，响应体 sandboxID、clientID、templateID、domain、envdVersion。
确认真实规格（同时也验证创建结果）：
GET <sandbox base>/sandboxes/{X-AIProxy-Sandbox-ID}

看 cpuCount、memoryMB、diskSizeMB、state、endAt。
存活时长与保活
运行时长上限按渠道不同，必须现场测，不要假设。 已知两种形态：
渠道形态
create 带 timeout=14400
续期带 14400
有 1 小时上限的
硬失败 400 Timeout cannot be greater than 1 hours
返回 204 但静默钳制（实测请求 240 分钟只给 56 分钟）
放开到 4 小时的
201，实际窗口 240 分钟
204，实际给足 240 分钟

判定方法：create 时先试你需要的 timeout；若报 400，降到 3600 重试。
续期后必须重新 GET 用 endAt 核实真实窗口。 静默钳制的渠道上，204 不代表窗口生效——只看状态码会以为拿到了 4 小时，实际不到 1 小时就丢盒子。判据是 endAt - startedAt，或 endAt 距当前时间的差值。
保活规则：
续期接口：POST <sandbox base>/sandboxes/{X-AIProxy-Sandbox-ID}/timeout，body {"timeout": <seconds>}。
续期间隔要明显小于实际窗口，留足重试余量。窗口 1 小时就每 5 分钟续一次，窗口 4 小时可以放宽到 15 分钟。
保活进程不要和长任务共用一把锁。续期是一次亚秒级 HTTP 调用，让它排在一个几十分钟的 CI 任务后面，等于让盒子在任务跑到一半时被回收。
long_running 元数据：
只能在 create 时通过 metadata 传入，事后无法添加；resume / clone 会继承。要用就必须第一次创建时带上，否则只能销毁重建。
网关不阻碍它。只有 aiproxy_workspace_id、aiproxy_actor_hash、aiproxy_channel_id、aiproxy_request_id 四个保留键会被拒绝，其余原样透传。设置成功后能在 GET 响应的 metadata 里看到。
它不一定解除运行时长上限——在有 1 小时上限的渠道上带了也无效。它的确定作用是让 infra 承认这是长命盒子。
代价：infra 每 24 小时对 long running 沙箱做一次 restart（pause + resume）。盒内长期进程必须能扛过这次中断，或由外部 controller 在 restart 后重建工作区。
副作用：沙箱寿命可能超过渠道 max_ttl_seconds，网关记的 binding expires_at 会先到期而沙箱还活着。归属判定不看 expires_at，控制面操作仍然通。
在 Sandbox 内工作
connect 拿运行时信息：
POST <sandbox base>/sandboxes/{X-AIProxy-Sandbox-ID}/connect
Content-Type: application/json

{ "timeout": 3600 }

请求体必须带 timeout，不带会 400。
runtime 域名用响应里返回的 domain，不要硬编码。 不同渠道不一样：有的返回 sandbox.paigod.work（网关代理域），有的返回 sandbox.ppio.cn（上游直连域），且两者不通用——用错会得到 502 The sandbox was not found。domain 为空或 null 时网关会按渠道配置补齐；仍为空说明渠道配置有问题，应检查网关而不是在 Agent 侧猜。
envd host 形如：
https://49983-{sandboxID}-{clientID}.{domain}

用 /health 验证连通（期望 204）；/metrics 返回 cpu_count、mem_total_mib、mem_used_mib，是确认真实可用内存最快的方式。
SDK 能力在 Sandbox 实例上，不在包顶层：sandbox.files.*、sandbox.commands.run、sandbox.getHost(port)。
先确认 SDK 与 envd 版本匹配。 envdVersion 低于 0.5.0 时，connect 可能不返回 envdAccessToken，新版 SDK 会以 401 invalid token 失败。此时不要反复重试或让用户换 Key——那是版本不匹配，不是凭据问题。可改用 envd 的 HTTP 接口：
文件：GET/POST <envd host>/files?username=user&path=<abs path>（上传用 multipart）
执行：POST <envd host>/process.Process/Start，connect-rpc 帧格式（5 字节信封：1 字节 flag + 大端 4 字节长度，后接 JSON body），头 Content-Type: application/connect+json、connect-protocol-version: 1，basic auth 用户名 user（空密码；只接受 user / root）。
开始正式工作前最小验证一遍：创建目录、写入并读回文件、跑一条命令拿到 stdout / exit code、启一个后台进程确认仍在跑、getHost(port) 返回可访问地址。
工具链要现场确认。基础模板往往只有 git、python3、gcc、make，没有 Go / Node / pnpm / lint 工具，也可能没有 docker。装之前先 command -v 探一遍，别假设存在。若上游源不通（例如 proxy.golang.org 不可达），改用可达镜像。
轻部署
项目目录固定 /app，至少包含：监听 HTTP 端口的应用入口、健康检查接口（建议 /api/health）、能从 /app 构建启动的 Dockerfile。部署前先在 Sandbox 内确认应用能起、健康检查能访问。
创建项目（路径不带 /v1）：
POST <lite base>/projects

部署：
POST <lite base>/projects/{projectId}/deploy
Content-Type: application/json

{
"metadata": { "httpPort": 3000, "checkHealthPath": "/api/health" },
"message": "deploy from AIProxy agent",
"artifactsSource": {
"sandboxId": "<create 响应体里的 sandboxID>",
"path": "/app"
},
"dockerfile": "FROM node:20-alpine\nWORKDIR /app\nCOPY . /app/\nENV PORT=3000\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]"
}

artifactsSource.sandboxId 用响应体里的基础 sandboxID，不要填 X-AIProxy-Sandbox-ID、Lite project ID、getHost 域名或复合 ID。httpPort 和 checkHealthPath 必须与应用实际一致。
轮询 GET <lite base>/projects/{projectId} 到 active / ready，再访问返回的 endpoint。首次访问看到冷启动或 Starting Service 属正常，等待重试。
清理
DELETE <sandbox base>/sandboxes/{X-AIProxy-Sandbox-ID}

SDK 提供 kill() 时优先用它，但控制面 base URL 仍须是第 2 节确定的地址。部分渠道的 DELETE 也接受复合 ID sandboxID-clientID（裸 sandboxID 会 404）。
开发用 Sandbox 在部署验证完成后必须清理。
如果配置过保活进程（launchd / systemd / cron 等），删掉 Sandbox 不等于停止计费。 这类进程会在下次登录或重启时把盒子静默重建。不再需要时，除了 DELETE，还必须停掉并移除保活进程的注册项，然后重新列一次账号下在跑的 Sandbox 确认归零。
可直接给 Agent 的任务描述
请通过 AIProxy 完成 Sandbox 开发和轻部署发布。用户只提供 AIPROXY_API_KEY。

地址：

- Sandbox 控制面：https://apiproxy.paigod.work/sandbox/c/{slug}
  （{slug} 由用户或管理员给出，例如 ppio-sandbox-internal 或 ppio-sandbox-public；
  不要用不带 /c/{slug} 的 /sandbox，那条路径在多渠道下恒返回 409）
- 轻部署：https://apiproxy.paigod.work/lite/internal-lite

规则：

1. 手写请求用 Authorization: Bearer ${AIPROXY_API_KEY}；只带一种凭据，不要同时发 X-API-KEY。
2. 不索要、不保存任何上游 PPIO / Artifact Key；不让用户填渠道 ID、上游 URL 或模板 ID。
3. 用 SDK 前设 PPIO_API_KEY=${AIPROXY_API_KEY}（E2B 兼容 SDK 另设 E2B_API_KEY），并显式把控制面
   api_url 覆盖为上面的地址。不要用 domain 代替 api_url。
4. 先 GET /v2/templates 或 /templates 发现模板。列表为空或查不到某个 templateID，不代表不能用——
   直接尝试创建。公共别名写全 e2b/base。
5. 创建请求里传 cpuCount / memoryMB 会被静默忽略，规格只能由模板决定。创建后 GET 一次确认真实规格。
6. 运行时长上限按渠道不同：先试所需 timeout，报 400 就降到 3600。续期后必须重新 GET 用 endAt 核实真实
   窗口，204 不代表生效（某些渠道静默钳制）。需要长命盒子就在 create 时带 metadata.long_running=true，
   事后无法添加。
7. runtime/envd 的 domain 用 create/connect 返回值，不要硬编码；connect 请求体必须带 timeout。
   envdVersion < 0.5.0 时新版 SDK 会 401，属版本不匹配，改用 envd HTTP 接口。
8. files / commands / getHost 是 Sandbox 实例能力，不是顶层导出。
9. 工具链先 command -v 探测再装，不要假设 Go / Node / docker 存在。
10. 轻部署路径不带 /v1；artifactsSource.sandboxId 用响应体基础 sandboxID。
11. 完成后清理 Sandbox；若配过保活进程，一并停掉并确认在跑数量归零。

执行顺序：读网关配置（不可达则用固定地址）→ 发现模板 → 创建并 GET 确认规格 → 验证 files/commands/
背景进程/getHost → 创建轻部署项目 → 从 /app 部署 → 轮询状态 → 验证 endpoint 健康检查 → 清理。

输出：X-AIProxy-Sandbox-ID、基础 sandboxID、clientID、复合 runtime ID、真实 cpuCount/memoryMB、
projectId、endpoint、各步验证结果、清理结果。

常见失败处理
现象
处理
任何 Sandbox 路径返回 409 ambiguous_sandbox_channel
base URL 用了不带渠道的 /sandbox，而 workspace 启用了多个 ppio 渠道。改用 /sandbox/c/{slug}。这不是故障，是网关拒绝替你猜渠道。
/sandbox/c/{slug} 返回 404 sandbox_gateway_channel_not_found
slug 拼错或该渠道已删除。向管理员确认当前 slug，不要枚举尝试。
返回 403 sandbox_gateway_ownership_denied
该 sandbox 不属于当前 Key 的持有者。只能操作自己创建的实例。
SDK / CLI 提示缺少 API Key
官方 SDK 读 PPIO_API_KEY，设为 ${AIPROXY_API_KEY}；不要索要上游 Key。
请求打到 https://api.<网关域>/sandbox
只设了 domain。必须覆盖控制面 api_url。
sandbox_gateway_conflicting_credentials
同时发了 Authorization 和 X-API-KEY，只留前者。
create 响应 domain 为 null 或缺失
网关会按渠道配置补齐。仍为空说明渠道 runtime domain 配置或部署版本不对，检查网关配置，不要在 Agent 侧猜域名。
envd 请求 502 The sandbox was not found
domain 用错了（渠道之间的代理域与直连域不通用），或只用了裸 sandboxID 拼 host。改用 create/connect 返回的 domain 和复合 sandboxID-clientID。
connect 返回 400
请求体缺 timeout。
SDK Sandbox.connect() 返回 401 invalid token
envdVersion 与 SDK 不匹配（旧 envd 不返回 envdAccessToken）。不是凭据问题，改用 envd HTTP 接口。
GET /v2/templates 返回 403 或列表为空
不代表无法创建。直接用 e2b/base 或手上的 templateID 尝试创建。
create 返回 404 template not found
先确认没简写成 base / default。若是别处拿到的 templateID，可能是模板按 team 隔离（public: false 跨 team 不可见），需要在当前渠道所属 team 下的模板。
传了 memoryMB / cpuCount 但规格没变
设计如此，被静默忽略。换模板，别改请求体。
create 返回 400 Timeout cannot be greater than 1 hours
该渠道上限 1 小时。降到 3600，靠续期保活。
续期回 204 但盒子提前消失
该渠道静默钳制。用 endAt 核实真实窗口并按实际窗口缩短续期间隔。
想给已有盒子加 long_running
做不到，只能 create 时设。需要就销毁重建。
命令跑到一半整个实例失联、工作区丢失
多为 OOM 打死整盒（不是单命令失败）。用 /metrics 看 mem_total_mib；重负载前把工作区在盒外留可恢复快照，或换更大规格的模板。
前端构建退出码 134
V8 abort，内存不足。调大 --max-old-space-size 不解决，只会从 abort 变成无限挣扎，需要更大模板。
脚本报找不到 docker
基础模板常无 docker。若 podman 也没有或守护进程起不来（内核缺 nftables 时 dockerd 无法初始化 bridge），改用不依赖容器的等价方案，例如直接安装所需服务。
POST <lite base>/v1/projects 返回 404
Lite 不带 /v1，用 <lite base>/projects。
Lite deploy 报 sandbox_id cannot be empty
artifactsSource.sandboxId 用响应体基础 sandboxID，不是 X-AIProxy-Sandbox-ID 或复合 ID。
找不到 files.makeDir / commands.run
先创建 Sandbox 实例，再从实例调用。
endpoint 冷启动 / 健康检查失败
冷启动等待重试；持续失败回到 Sandbox 检查端口、启动命令、Dockerfile 和健康检查路径。
