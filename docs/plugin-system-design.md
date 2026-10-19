# Plugin System — 完整设计

> 状态：设计稿 v1（2026-09-22）。目标是一步到位把"能力扩展"这件事定清楚：数据模型、运行时装配、沙箱物化、前端交互、安全边界、迁移路径。实现分阶段，但每一阶段都在这个终态之内，不做中间形态。

---

## 0. 一句话

**Plugin 是能力的唯一打包单位。** 一个 plugin = `skills[] + mcpServers[] + agents[] + ui[] + setupSteps[] + hooks[] + files[]`，作为整体安装、启用、升级、卸载。平台自带能力也是 plugin（`builtin` 源，不可卸载）；用户录出来的经验自动进每个 bot 的 `local` plugin（唯一可编辑的地方）；第三方从社区格式（Claude Code plugin 目录）导入。

**两个面，一条线：控制面只接受声明，执行面接受一切。** 平台 API 进程（控制面）读到的 plugin 永远是纯数据——manifest、模板、文件内容；它从不执行 plugin 里的任何东西。plugin 携带的**代码**（stdio MCP server、hook 脚本、skill 的 glue 脚本、安装脚本）全部**物化到该 bot 的沙箱里执行**——那是租户自己的盒子，模型每天在里面 `run_command`，plugin 代码跑在同一个信任面上，不新增任何攻击面。这条线让 Claude Code 格式几乎可以全兼容（stdio、command hook、`${CLAUDE_PLUGIN_ROOT}` 都有落点），而多租户隔离依然靠"平台主机上零执行"成立。

---

## 1. 现状盘点（设计的约束条件）

### 1.1 已有的三层，各自独立挂载

| 层                | 存储                                              | 挂载时机                                        | 模型看到什么                                                                                                                    |
| ----------------- | ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 内置 tool（9 个） | 代码 `apps/api/src/agent/tools.ts` `buildTools()` | 每次 run                                        | `browser_action` `desktop_action` `screenshot` `render_ui` `run_command` `spawn_task` `request_handoff` `save_skill` `bind_mcp` |
| MCP               | `bot_mcp_servers`（per-bot 行）                   | run 开始 `connectBotMcpTools`                   | `mcp__<server>__<tool>`（dynamicTool）                                                                                          |
| Skill             | `skills`（`scope: bot\|user\|org\|public`）       | run 开始 `loadBotSkills → composeSkillPreamble` | system prompt 里一段 `## Your skills` 文本                                                                                      |

另有 `bot_setup_steps`（apt/pip/npm/cmd/download，bootstrap 重放）和 `tenant_secrets`（AES-GCM 保险库，`{{secrets.NAME}}` 引用）。

### 1.2 现状的四个结构性问题

1. **没有打包单位。** 一个真实能力 = 知识 + 连接 + 卡片 + 也许一个专家 subagent。现在四样各挂各的，装一个能力四个动作，卸载也是，版本无法对齐。
2. **Skill 不能贡献任何 tool。** 它只是 prompt 文本。"UI 模板做成 skill"在现架构下不成立：skill 说"用 render_ui 画一张选择卡"，模型还得手写 2000 token 的 A2UI JSON，错误率、流式打断一个都没解。
3. **"谁能改"边界模糊。** `skills.scope` 混着"用户录的"和"我们出厂的"，同表两种性质；`public` 没有 owner。
4. **subagent 没有"身份"。** `spawn_task` 的 subagent 继承父 run 的一切（同 systemPrompt、同 model、同 MCP），只是 history 换成 goal。没有预定义的"专家"（自己的 prompt、工具白名单、模型）。

### 1.3 必须尊重的既有决策（不推翻）

- **DB 是 ledger，沙箱 `.ibot/` 是可重建缓存**（沙箱不可靠持久）。bootstrap 从 DB 重渲染。
- **MCP stdio 在平台服务端被拒**（会在平台主机起子进程，破坏租户隔离）；box-local 是"本地"的唯一形态（跑在租户自己的盒子里）。**本设计把 stdio 变成 box-local 的一种启动方式**（§4.7）：进程在盒子里起，平台仍只通过 HTTP 连它——`makeTransport` 拒 stdio 的规则不变。
- **secrets 永不进模型/命令串**：`{{secrets.NAME}}` 服务端解析 → 命令 env 通道注入；`guardSecretReadback` 拦 env/printenv/proc 读取。
- **AI SDK toolset 在 run 开始固定**：中途注册的能力下一回合生效。
- **A2UI catalog 是安全边界**：模型只能引用预批准组件。
- **一个 bot 一个前台声音 + N 个后台任务 + 一把 GUI 租约**（`SandboxManager`）。

---

## 2. 概念模型

```
Plugin (id, name, version, source, manifest, files)
 ├── skills[]        知识：SKILL.md → {name, description, playbook, secretRefs[]}      → 进 prompt（控制面）
 ├── mcpServers[]    连接：{name, transport: http|sse|stdio, url | command+args+env, headers{{secrets}}, toolFilter}
 │                     http/sse = 平台直连远端；stdio = 在盒子里起进程，包成 box-local，平台连 getHost(port)
 ├── agents[]        专家：{name, description, prompt, tools[] 白名单, model?, maxTurns?, needsDesktop}
 ├── ui[]            卡片模板：{name, description, input: JSON Schema, template: A2UI JSON with ${placeholders}}
 ├── setupSteps[]    盒子里要装的：{kind: apt|pip|npm|cmd|download, spec}                 → 盒子里执行
 ├── hooks[]         触发器：{on, match, do: {tool,args} | {command}}  command 类在盒子里执行
 └── files[]         plugin 目录的全部文件（脚本、配置、二进制 base64）                    → 物化到 ${PLUGIN_ROOT}
     requires[] / requiredSecrets[] / userConfig{}

Installation (pluginId, ownerType: user|org, ownerId, enabledForBots: uuid[] | "*", config)
```

**控制面 / 执行面的归属一眼看清：** 进 prompt 的（skills 文本、agents prompt）、进 AI SDK toolset 的（ui 模板展开、agent 调度、MCP 客户端连接）在平台；**一切"跑起来"的东西**（stdio MCP 进程、hook 脚本、setup 步骤、skill glue 脚本）在沙箱。平台和沙箱之间只有两条通道，都是既有的：`handle.run`（envd 命令）和 `getHost(port)`（HTTP）。

**三种 source：**

| source      | 谁写                   | 谁改                            | 例子                                                                                |
| ----------- | ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `builtin`   | 我们，随代码发布       | 不可改不可卸；可关（除 `core`） | `@ibot/core`（9 个原语）、`@ibot/ui`（`render_choice/form/table`）、`@ibot/search`… |
| `installed` | 社区 / 租户上传        | 不可改；可升级/卸载             | 从 Claude Code plugin 目录导入的任何东西                                            |
| `local`     | 用户在该 bot 上录/写的 | **唯一可编辑**                  | 每个 bot 自动一个 `local`，`save_skill` / 录制分析 / 手写都进这里                   |

一个 bot 的有效能力 = `core` ∪ 启用的 `builtin` ∪ 为它启用的 `installed` ∪ 它自己的 `local`。同名冲突：`local` > `installed` > `builtin`（越靠近用户越优先），命名空间见 §4.3。

---

## 3. 数据模型

### 3.1 新表（migration `0007_plugins`，纯增量）

```sql
create type plugin_source as enum ('builtin','installed','local');
create type plugin_owner  as enum ('user','org');            -- 复用 secret_owner 的思路，但 plugin 无 bot 级 owner

create table plugins (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,             -- 稳定标识 "@ibot/ui" / "acme/crm" / "local:<botId>"
  version       text not null,             -- semver
  source        plugin_source not null,
  display_name  text not null,
  description   text not null default '',
  author        jsonb,                     -- {name,email,url}
  homepage      text,
  manifest      jsonb not null,            -- 归一化后的 PluginManifest（§3.3），单一真源
  content_hash  text not null,             -- manifest 的 sha256，升级判等
  requires      jsonb not null default '[]', -- [{plugin:"@ibot/ui", version:"^1"}]
  required_secrets jsonb not null default '[]', -- ["CRM_TOKEN"] 安装时提示
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (key, version)
);

create table plugin_installs (
  id            uuid primary key default gen_random_uuid(),
  plugin_id     uuid not null references plugins(id) on delete cascade,
  owner_type    plugin_owner not null,
  owner_id      text not null,             -- users.id | org id
  enabled       boolean not null default true,
  enabled_bots  jsonb,                     -- null = 该 owner 所有 bot；否则 uuid[]
  config        jsonb not null default '{}', -- 用户填的 userConfig（非 secret）
  installed_at  timestamptz not null default now(),
  unique (plugin_id, owner_type, owner_id)
);
create index on plugin_installs (owner_type, owner_id);

-- 现有三张表加一个可空 FK：行由哪个 plugin 展开而来。null = 历史数据 / 迁移前
alter table skills          add column plugin_id uuid references plugins(id) on delete cascade;
alter table bot_mcp_servers add column plugin_id uuid references plugins(id) on delete cascade;
alter table bot_setup_steps add column plugin_id uuid references plugins(id) on delete cascade;
create index on skills (plugin_id); create index on bot_mcp_servers (plugin_id); create index on bot_setup_steps (plugin_id);
```

**为什么保留三张旧表而不是全塞 manifest jsonb：** 运行时热路径（`loadBotSkills`、`connectBotMcpTools`、`gatherBotDefs`）已经按这三张表写好并测过；`bot_mcp_servers.headers` 已标记加密；`bot_setup_steps` 有 `status/last_error` 的重放状态。**manifest 是声明，三张表是"为某个 bot 展开后的实例"**（materialized）。安装/启用时展开，卸载时 cascade 删除。这样旧代码路径零改动，新代码只负责展开。

**agents / ui / hooks 不落旧表**：它们是新东西，运行时直接从 `plugins.manifest` 读（run 开始时一次），不需要 per-bot 实例状态。

### 3.2 `skills` 表的 scope 语义收敛（含一处必须改的查询）

`loadBotSkills`（`apps/api/src/agent/skills.ts:19`）现在的 WHERE 是 `(scope='bot' AND owner_ref=botId) OR scope='public'` — **`public` 无 owner 过滤**。今天没问题（表里没有 public 行），但一旦 plugin 展开出的行用 `public`，所有租户互相可见。所以：

- **每一条 plugin 展开出的 skill 行都是 per-bot 的**：`scope='bot'`, `owner_ref=botId`, `plugin_id=<plugin>`。和 local 的行只差 `plugin_id` 指向谁。`loadBotSkills` 只保留 `scope='bot' AND owner_ref=botId` 这一支，`public` 支删掉（同时把 `bot_mcp_servers`/`bot_setup_steps` 本来就是 per-bot 的，不用动）。
- `skill_scope` 的 `user`/`org`/`public` 三个值停用（不删 enum 值，避免迁移风险；代码里不再写入）。"公共"这个概念上移到 plugin 层（`source=builtin`），不再在 skill 行上表达。
- 代价：一个 builtin skill 在 N 个 bot 上是 N 行。skill 行很小（文本），N 在千级以内没有问题；换来的是**租户隔离靠 SQL WHERE 成立**（和 secrets vault 同一原则），以及每个 bot 可以独立开关。

### 3.3 `PluginManifest`（`@i-bot/types`，归一化格式）

```ts
export const PluginManifest = z.object({
  key: z.string().regex(/^[a-z0-9@][a-z0-9@/_.-]*$/),
  version: z.string(), // semver
  displayName: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  author: z
    .object({ name: z.string(), email: z.string().optional(), url: z.string().url().optional() })
    .optional(),
  homepage: z.string().url().optional(),
  defaultEnabled: z.boolean().default(true),

  skills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        playbook: z.string(),
        files: z
          .array(z.object({ path: z.string(), content: z.string(), mode: z.string().optional() }))
          .default([]),
        secretRefs: z.array(z.string()).default([]),
        /** true = 只由 hooks/agents 引用，不进模型的 skill 列表（对应 disable-model-invocation） */
        hidden: z.boolean().default(false),
      }),
    )
    .default([]),

  mcpServers: z
    .array(
      z.object({
        name: z.string(),
        transport: z.enum(["http", "sse", "stdio"]),
        // http/sse：平台进程直连远端
        url: z.string().url().optional(),
        headers: z.record(z.string()).optional(), // 值必须是 {{secrets.NAME}} 或非敏感字面量
        // stdio：在盒子里起进程（§4.7）。command/args 里的 ${PLUGIN_ROOT} 物化时替换；
        // env 值可以是 {{secrets.NAME}}（bootstrap 经 handle.run 的 env 通道注入，不进命令串）
        command: z.string().optional(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string()).optional(),
        toolFilter: z.array(z.string()).optional(),
      }),
    )
    .default([]),

  agents: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        prompt: z.string(),
        tools: z.array(z.string()).optional(), // 白名单；缺省 = 继承父 run（去掉 spawn_task 防递归）
        model: z.string().optional(),
        maxTurns: z.number().int().positive().max(60).optional(),
        needsDesktop: z.boolean().default(false),
        skills: z.array(z.string()).optional(), // 只加载这些 skill（按 name）
      }),
    )
    .default([]),

  ui: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        input: z.record(z.unknown()), // JSON Schema（模型调用参数）
        template: z.array(A2uiMessage), // 含 ${input.x} / ${each input.items as item}… 占位
      }),
    )
    .default([]),

  setupSteps: z
    .array(
      z.object({
        kind: z.enum(["apt", "pip", "npm", "cmd", "download"]),
        spec: z.record(z.unknown()),
      }),
    )
    .default([]),

  hooks: z
    .array(
      z.object({
        on: z.enum(["turn.start", "tool.before", "tool.after", "form.submit", "bootstrap.done"]),
        match: z.string().optional(), // tool.*: tool name glob; form.submit: surfaceId/name glob
        do: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("tool"),
            tool: z.string(),
            args: z.record(z.unknown()).default({}),
          }),
          // 在盒子里执行；stdin 收到事件 JSON；stdout JSON {decision?:"block", reason?, note?} 回到平台
          z.object({
            type: z.literal("command"),
            command: z.string(), // ${PLUGIN_ROOT} 可用
            timeoutMs: z.number().int().max(30_000).default(10_000),
          }),
        ]),
      }),
    )
    .default([]),

  /** plugin 目录的全部文件（manifest 自身除外）。物化到盒子 ${PLUGIN_ROOT}；单个 ≤ 2MB，总 ≤ 20MB */
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        mode: z.string().optional(),
      }),
    )
    .default([]),

  requires: z.array(z.object({ plugin: z.string(), version: z.string().optional() })).default([]),
  requiredSecrets: z.array(z.string()).default([]),
  userConfig: z
    .record(
      z.object({
        type: z.enum(["string", "number", "boolean", "enum"]),
        description: z.string(),
        default: z.unknown().optional(),
        enum: z.array(z.string()).optional(),
      }),
    )
    .default({}),
});
```

---

## 4. 运行时装配（`buildAgentRun`）

### 4.1 一次 run 的装配顺序（落在 `buildAgentRun`，`apps/api/src/agent/run.ts:202`）

现状：`buildAgentRun(args: RunAgentArgs)` → `buildTools(handle, {mode, isHumanInControl, acquireGui, releaseGui, spawnTask, onHandoff, workdir, tenant:{db,botId}})`（`tools.ts:234`，`SandboxToolsOptions` 见 `tools.ts:181`）→ `connectBotMcpTools` 合并 → `loadBotSkills → composeSkillPreamble` → `composeSystemPrompt(persona, skills) + mcpNote`。`mode` 由调用方决定：foreground = `full`；`jobs.ts:192` 按 `needsDesktop` 给 subagent `full` 或 `concurrent-safe`。

新增（在同一个函数里，`buildTools` 之后、`streamText` 之前）：

```
const plugins = await resolvePluginsForBot(db, botId)       ← 新：core ∪ enabled builtin ∪ enabled installed(for bot) ∪ local
                                                              返回 { manifests: PluginManifest[], byKey, toolNames: Set }
  │
  ├─ skills:   loadBotSkills(db, botId)                      ← 查询改为只取 scope='bot' AND owner_ref=botId（§3.2）
  │            过滤 manifests[].skills[].hidden；args.skillNames（agent 白名单）再过滤一次
  ├─ mcp:      connectBotMcpTools(db, botId, boxEndpoints)   ← 不变（读 bot_mcp_servers，plugin 展开的行已在表里）
  ├─ tools:    buildTools(handle, opts)                      ← 不变的 9 个
  │            + buildUiTemplateTools(plugins, renderUiTool) ← 新：每个 manifest.ui[] → `ui__<plugin>__<name>`
  │            + buildAgentTools(plugins, spawnAgent)        ← 新：每个 manifest.agents[] → `agent__<plugin>__<name>`
  │                                                            仅当 opts.spawnTask 有（即 foreground）— 和 spawn_task 同门禁
  │            + applyToolAllow(tools, args.toolAllow)       ← 新：agent 白名单（`SandboxToolsOptions.toolAllow?: string[]`）
  ├─ prompt:   composeSystemPrompt(persona, skillPreamble, pluginNotes) + mcpNote
  │            pluginNotes = "## Installed plugins"：每个 plugin 一行 displayName + description
  │                         + 它贡献的 ui__/agent__/mcp__ 工具名（模型知道有什么可用、来自哪）
  └─ hooks:    installHooks(plugins, { prepareStep, onUiEvent })  ← 新：挂到现有 prepareStep（steer 注入点）
```

`RunAgentArgs` 新增可选字段：`toolAllow?: string[]`、`skillNames?: string[]`、`maxTurns?: number`、`agentRef?: string`——只有 `agent__` 起的 subagent 会带；foreground 和匿名 `spawn_task` 不带，行为完全不变。

### 4.2 UI 模板 → tool（`@ibot/ui` 是第一个 builtin plugin）

`buildUiTemplateTools` 为每个 `manifest.ui[i]` 生成：

```ts
tool({
  description: ui.description,
  inputSchema: jsonSchema(ui.input),
  execute: (input) => {
    const messages = expandTemplate(ui.template, { input, ids: stableIds(surfaceId) });
    return renderUiTool.execute({ messages }); // 复用 render_ui 的校验 + output 管道
  },
  toModelOutput: renderUiTool.toModelOutput,
});
```

- **`expandTemplate`** 是受限展开器：只支持 `${input.path}`、`${each input.list as x}`（数组展开成 children）、`${if input.flag}`。不是 JS，不能执行。输出再过一遍 `a2ui-validate`，坏模板在安装时就被拒（安装期对 `input` 的示例值跑一次展开 + 校验）。
- **稳定 id**：`surfaceId = ${plugin}:${name}:${toolCallId}`，组件 id = 模板里写死的字面 id 前缀化。这样模型后续 `render_ui` delta 能精确打到 `status` 行。
- **`@ibot/ui` 的三个模板**：`render_choice({question, options[{label,value,hint?}], multi?})`、`render_form({title, fields[{name,label,type,options?,required?}], submitLabel?})`、`render_table({title?, columns[], rows[][]})`。这三个消掉 90% 手写 A2UI 的场景；`render_ui` 保留为逃生口。
- **前端零改动**：输出走 `render_ui` 同一条 tool part 通道；`ChatPanel` 按 `toolName.startsWith("ui__") || toolName === "render_ui"` 渲染 `A2uiPanel`。

### 4.3 命名空间与冲突

| 来源    | tool 名                                                                                           | 说明                               |
| ------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| core    | 裸名 `browser_action` …                                                                           | 保留字，plugin 不得声明            |
| MCP     | `mcp__<server>__<tool>`                                                                           | 已有                               |
| UI 模板 | `ui__<pluginKey>__<name>`                                                                         | pluginKey 去掉 `@`/`/` 后 sanitize |
| Agent   | `agent__<pluginKey>__<name>`                                                                      | 同上                               |
| Skill   | 不是 tool，进 prompt；同名 skill 按 `local > installed > builtin` 只保留一个，preamble 里标注来源 |

### 4.4 Agents（预定义专家）→ `spawn_task` 的特化

现在 `spawn_task(goal, needs_desktop)` 起一个继承父 run 的 subagent。加 `agent__<plugin>__<name>(goal)`：

```ts
ctx.jobs.launchTask({
  kind: "subagent",
  needsDesktop: agent.needsDesktop,
  goal,
  run: {
    ...turnRun,
    systemPrompt: agent.prompt, // 专家自己的 prompt（不继承 persona）
    modelId: agent.model ?? turn.modelId,
    toolAllow: agent.tools, // 新：buildTools 按白名单过滤
    skillNames: agent.skills, // 新：loadBotSkills 只取这些
    maxTurns: agent.maxTurns,
    history: [{ role: "user", parts: [{ type: "text", text: goal }] }],
  },
});
```

结果回流沿现有 `#deliverTaskResult → steer → task.done` 不变。`agent_jobs` 加一列 `agent_ref text`（`"<plugin>/<name>"`，null = 匿名 spawn_task）用于前端任务条显示"CRM 专家 · 运行中"而不是 goal 截断。

### 4.5 Hooks（两种 `do`：平台里调 tool，或盒子里跑 command）

| `on`             | 触发点                                            | 典型用途                                                                                                   |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `turn.start`     | run 开始、模型第一步前                            | `command` 在盒子里读状态（git 分支、当前目录、上次任务）→ 输出 `note` 追加进本回合 prompt                  |
| `tool.before`    | 某 tool 即将执行（`match` = tool 名 glob）        | `command` 审查参数 → `{decision:"block", reason}` 阻止（对应社区 PreToolUse）；如禁止 `run_command rm -rf` |
| `tool.after`     | 某 tool 返回后                                    | `tool`：自动接一个调用，如 `browser_action` 后自动 `screenshot`；`command`：格式化/校验刚写的文件          |
| `form.submit`    | `data-uiEvent` 到达且 `match` 命中 surfaceId/name | `tool`：调 `ui__…` 模板把卡片改成"处理中"，模型不用先手动回一句                                            |
| `bootstrap.done` | 该 plugin 在盒子里物化完成                        | `command`：初始化（登录 CLI、拉配置、warm cache）                                                          |

- **`do.type: "tool"`**：平台里执行。`tool` 必须是该 bot 当前可见的 tool 名，不存在则装配时丢弃并 warn。实现 = 在现有 `prepareStep`（steer 注入点）把调用塞进下一步。
- **`do.type: "command"`**：**在盒子里执行**——`handle.run(command, {env, timeoutMs})`，cwd = `${PLUGIN_ROOT}`，stdin 收到事件 JSON（`{on, tool, args, result, botId, conversationId}`），stdout 解析为 `{decision?, reason?, note?}`。超时/非零退出 = 忽略该 hook 并记 warn，**永不阻塞 run**（除了 `tool.before` 明确返回 `block`）。`tool.before` 是 run 内的同步等待点，所以硬上限 `timeoutMs ≤ 30s`、默认 10s。
- 每回合每 hook 最多触发一次（防 hook 触发 tool 再触发 hook 的循环）。`command` hook 只对沙箱在线的 bot 生效；盒子没起来时跳过。

### 4.6 Bootstrap（沙箱物化，plugin 是一等公民）

`bootstrapBot(target, db, botId, defs)` 现在按 skill 文件 / setup 步骤 / box-local MCP 三类扫。加一类：**plugin 目录**。每个对该 bot 启用的 plugin 物化到

```
/root/.ibot/plugins/<pluginKey-sanitized>/      = ${PLUGIN_ROOT}
  ├── <files[] 原样>                             脚本、配置、二进制（base64 → base64 -d）
  ├── skills/<n>/                                SKILL.md 同目录文件（skill.files 就是这些，不再单独放 skillDir）
  └── .ibot-plugin.json                          {key, version, contentHash, materializedAt}  ← 幂等判据
/root/.ibot/plugins/<key>/data/                  = ${PLUGIN_DATA}，升级不清（对应 CLAUDE_PLUGIN_DATA）
```

幂等：`.ibot-plugin.json.contentHash` 等于 DB 里的 → 跳过该 plugin；不等 → 删目录（保留 `data/`）重渲染，再跑 `setupSteps`（`bot_setup_steps` 表按 `plugin_id` 分组记 `status/last_error`），再起 stdio MCP（§4.7），最后触发 `bootstrap.done` hooks。`skillDir(skillId)` 保留给 `local` plugin 里手写/录制的 skill（它们没有 plugin 目录）。

### 4.7 stdio MCP → 盒子里的 box-local（执行面的核心机制）

这是把 Claude Code 生态"直接拿来用"的关键。社区 plugin 的 MCP 绝大多数是 `command: "npx @foo/mcp-server"` 这种 stdio；我们不能在平台起它，但完全可以在盒子里起。做法：**平台不实现 stdio 客户端，而是在盒子里放一个通用的 stdio→HTTP 桥**，每个 stdio server 一个桥进程，平台像连任何 box-local MCP 一样连 `getHost(port)`。

```
盒子内                                                    平台
┌──────────────────────────────────────────────┐
│ /opt/ibot-mcp-bridge  (node, 无依赖, 随 provision 装)   │
│   --port 47001 --cwd ${PLUGIN_ROOT}           │
│   -- npx @foo/mcp-server --flag               │   ←── StreamableHTTP ──  connectBotMcpTools
│  ┌────────────┐  JSON-RPC over stdio  ┌──────┐│         getHost(47001)/mcp     （现有代码，零改动）
│  │ child proc │ ←──────────────────→  │bridge││
│  └────────────┘                       └──────┘│
│   健康: GET /health → 200 当 child 在跑且 initialize 成功  │
└──────────────────────────────────────────────┘
```

- **桥**：~150 行 Node，随 `provision.ts` 写到 `/opt/ibot-mcp-bridge.js`（和 `cdp-proxy.js` 同一模式）。功能只有三件：spawn child（`cwd=${PLUGIN_ROOT}`，`env` 合并 plugin 声明的 env + bootstrap 注入的 secrets）；把 HTTP POST body 一行一 JSON-RPC 写进 stdin，把 stdout 的 JSON-RPC 回包按 `id` 配对回 HTTP response（StreamableHTTP 的请求-响应子集，够 `initialize`/`tools/list`/`tools/call`）；child 退出则 `/health` 变 503 并按退避重启（≤5 次）。不做 auth（和 CDP、现有 box-local 同一"主机名熵"模型；v2 可加 per-box token，见 skill-mcp 备忘）。
- **端口**：bootstrap 从 `47001` 起为每个 stdio server 顺序分配，写回 `bot_mcp_servers.box_local = {start:"node /opt/ibot-mcp-bridge.js …", port, health:"/health", path:"/mcp"}`——**复用现有 `boxLocal` 字段和 `startBoxMcp`**，所以 `gatherBotDefs`/`connectBotMcpTools`/`BoxMcpEndpoint` 一行不改。导入器只是把 `transport:"stdio"` 翻译成 `transport:"http" + box_local`。
- **secrets**：`env: {GITHUB_TOKEN: "{{secrets.GITHUB_TOKEN}}"}` → bootstrap 起桥时经 `handle.run` 的 `env` 通道注入（Phase B 已有），桥再传给 child。值不进命令串、不进 DB 明文、模型看不到。**但 child 进程能读到自己的 env**——这和模型在盒子里 `run_command` 时能读到的东西是同一等级，没有新增暴露（`guardSecretReadback` 拦的是模型直接 `printenv`，一个 MCP server 拿它自己的 token 调 API 是预期用途）。
- **依赖**：`npx`/`uvx` 需要 node/python 在盒子里——e2b/base 和 codex 模板都有 node；python 用 `setupSteps` 装。首次 `npx` 下载慢 → `bootstrap.done` 之前就把桥起了，`health` 轮询 90s 上限，超时标 `failed` 不阻塞其它 plugin。
- **生命周期**：盒子 pause/resume 后进程还在（和 Chrome 一样，pgrep 守卫）；盒子重建 → bootstrap 从 DB 全量重来。plugin 禁用/卸载 → `stopBoxMcp`（新增：`pkill -f "ibot-mcp-bridge.*--port <port>"`，两次 `handle.run`，见 pkill 备忘）。

**为什么不在平台起 stdio、加 seccomp/容器隔离？** 因为盒子已经是租户的隔离边界，再造一个是重复建设；而且盒子里有租户的浏览器会话、文件、已装软件，MCP server 在里面才"够得着"这些（一个操作本地 git 仓库的 MCP 在平台上毫无意义）。

**为什么不让平台的 MCP 客户端直接走 envd 的 PTY 当 stdio？** envd `commands.run` 是一次性命令流，不是双向长连接，做 JSON-RPC 的 framing 会很脆；HTTP 桥用的是已经验证过的 `getHost(port)` 路径。

---

## 5. 安装 / 展开 / 卸载

### 5.1 安装流程（`installPlugin`）

安装分两段，**识别/校验在平台，安装/执行在盒子**：

```
控制面（平台 API 进程，纯数据）
1. 解析来源 → PluginManifest + files[]（§6 导入器）。这里只读文件、解析 frontmatter/JSON，不执行任何东西
2. 校验：schema；headers/env 值只能是 {{secrets.X}} 或非敏感字面量（高熵串拒）；ui[] 模板试展开 + a2ui-validate；
   agents[].tools ⊆ 已知 tool 名；requires 已装且版本满足；files 尺寸上限；command/args 里只允许 ${PLUGIN_ROOT}/${PLUGIN_DATA} 占位
3. upsert plugins (key, version)；content_hash 判等
4. insert plugin_installs (owner=当前用户, enabled_bots)
5. requiredSecrets 缺失 → {ok:true, missingSecrets:[…]}，前端引导（不阻塞安装，阻塞用到它的 MCP/hook）
6. materialize（仍是纯数据）：对每个 enabled bot → skills 行（playbook 文本）/ bot_mcp_servers 行
   （http/sse 原样；stdio → transport:"http" + box_local{start:"node /opt/ibot-mcp-bridge.js …", port}）/
   bot_setup_steps 行，plugin_id 指回

执行面（该 bot 的沙箱，通过 handle.run）
7. 沙箱在线 → 立即增量 bootstrap 该 plugin：写 ${PLUGIN_ROOT} 文件 → 跑 setupSteps → 起桥+stdio MCP →
   health 轮询 → 触发 bootstrap.done hooks → 写 .ibot-plugin.json。每步结果写回 bot_setup_steps.status /
   bot_mcp_servers（新增 last_health, last_error 两列）。沙箱离线 → 状态 "pending"，下次连接 bootstrap 自然补齐
8. 前端安装结果 = 控制面成功 + 每个 bot 的执行面状态（pending / ready / failed + 原因），不是一个笼统的 ✓
```

"安装"这个词在 UI 里对应第 7 步：一个 plugin 在 bot A 上 ready、在 bot B 上 failed（比如 B 没起桌面所以没跑）是正常状态，详情页按 bot 展示。

### 5.2 启用/禁用某 bot

`enabled_bots` 变化 → 对新增 bot 执行 materialize；对移除 bot 删除该 plugin_id 的三张表行（cascade 不够，因为 install 行还在）。在线沙箱：删 `.ibot/skills/<id>/`、停 box-local MCP 进程（bootstrap 已有 start，补一个 stop）。

### 5.3 升级

新版本 = 新 `plugins` 行（`unique(key,version)`）。`plugin_installs.plugin_id` 指向新行 → 旧行的展开物删、新行展开。旧 `plugins` 行若无 install 引用则 GC。`local` plugin 不走版本，直接原地改（`version` 固定 `0.0.0-local`）。

### 5.4 卸载

删 `plugin_installs` 行 → 手动删该 (plugin, owner 的 bots) 的展开行 → 在线沙箱清理。`plugins` 行按引用计数 GC。

### 5.5 `local` plugin 的自动维护

- bot 创建时自动 `plugins{key:"local:<botId>", source:"local"} + plugin_installs{enabled_bots:[botId]}`。
- `save_skill` tool、录制分析发布、手写 skill → 都写 `skills{plugin_id: local.id, scope:"bot"}`。**现有 `save_skill` 代码只需多填一个 `plugin_id`。**
- `bind_mcp` tool → `bot_mcp_servers{plugin_id: local.id}`。
- 用户在 UI 里"导出 local 为 plugin"→ 生成 `installed` 格式的目录 zip（§6 反向），可以分享给其它 bot / 别人。这是"录制 → 经验 → 可分发能力"的闭环。

---

## 6. 导入器：兼容 Claude Code plugin 目录

输入是一个目录（zip 上传 / git URL / builtin 的代码内目录）。映射：

| 目录里的                               | → manifest                                                                                                                                                                                                | 处理                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`           | `key name version displayName description author homepage defaultEnabled`                                                                                                                                 | 缺 plugin.json 时 name = 目录名                                                                                                                                                                                     |
| `skills/<n>/SKILL.md`                  | `skills[]`：frontmatter `name description`；正文 = playbook；同目录其它文件 = `files[]`（文本内嵌，二进制 base64，>512KB 拒）                                                                             | frontmatter `disable-model-invocation: true` → `hidden`                                                                                                                                                             |
| `agents/<n>.md`                        | `agents[]`：frontmatter `name description model maxTurns tools disallowedTools skills`；正文 = prompt                                                                                                     | `tools` 名映射到我们的 tool 名（`Bash`→`run_command`，`Read/Write`→`run_command`，`WebFetch`→`browser_action`，未知名丢弃并 warn）；`isolation/memory/hooks/mcpServers` 忽略                                        |
| `.mcp.json` / `plugin.json.mcpServers` | `mcpServers[]`                                                                                                                                                                                            | `command` 存在 → `transport:"stdio"`，物化时翻成盒子里的桥 + box_local（§4.7）；`${CLAUDE_PLUGIN_ROOT}` → `${PLUGIN_ROOT}`；`env`/`headers` 里明文疑似密钥（≥20 位高熵串）→ 拒并要求 `{{secrets.X}}`；`type: "http" | "sse"` 原样 |
| `commands/*.md`                        | 忽略（聊天形态没有 slash）                                                                                                                                                                                | 记录到 `manifest.ignored[]` 给用户看                                                                                                                                                                                |
| `hooks/hooks.json`                     | `type: "command"` → `do.type:"command"`（盒子里跑，`${CLAUDE_PLUGIN_ROOT}`→`${PLUGIN_ROOT}`）；`type: "mcp_tool"` → `do.type:"tool"`, `tool:"mcp__…"`；`prompt`/`agent`/`http` 类型忽略并记入 `ignored[]` | 事件名映射 `SessionStart`→`turn.start`，`PreToolUse`→`tool.before`，`PostToolUse`→`tool.after`；`matcher` → `match`，工具名同 agents 的映射表                                                                       |
| 其它所有文件                           | `files[]`                                                                                                                                                                                                 | 原样进 `${PLUGIN_ROOT}`，文本 utf8、二进制 base64；单个 >2MB 或总 >20MB 拒                                                                                                                                          |
| `ui/*.json`（**我们的扩展**）          | `ui[]`                                                                                                                                                                                                    | 社区标准没有；我们自己的 plugin 目录多一个 `ui/`                                                                                                                                                                    |
| `setup/*.json`（**我们的扩展**）       | `setupSteps[]`                                                                                                                                                                                            | 同上，盒子里要装的软件                                                                                                                                                                                              |

`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` 在任何位置（skill 正文、command、args、env、url）→ `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`，物化时替换成 `/root/.ibot/plugins/<key>/` 和 `…/data/`；skill preamble 里给模型的路径也是这个（`composeSkillPreamble` 时替换）。`${CLAUDE_PROJECT_DIR}` → 盒子 cwd。

**识别**（导入前给用户看的预览，`POST /plugins/inspect`）：目录 → manifest 的过程本身就是识别，输出一份"这个 plugin 会带来什么"清单：N 个 skill / M 个 MCP（几个远端、几个要在盒子里起进程 + 各自的 command）/ K 个 agent（各自的工具白名单）/ 几个 hook（哪些是盒子里跑命令的）/ 需要哪些 secrets / 哪些内容被忽略了。用户看完这张单子再点安装——盒子里要跑的命令是**显式列出来**的，不是藏在 zip 里。

**反向（导出）**：`local` plugin → 上述目录结构 zip，让"录制的经验"可以分发。

---

## 7. Builtin plugins（随代码发布）

代码内目录 `apps/api/plugins/<key>/`，与 installed 同格式，服务启动时 `syncBuiltinPlugins()`：读目录 → manifest → upsert `plugins(source:"builtin")` → 为**每个 owner** 自动建 `plugin_installs`（core 强制 enabled，其余按 `defaultEnabled`）。这样 builtin 和 installed 走完全同一条装配路径，没有特例。

| key                                       | 内容                                                                                                                                           | defaultEnabled |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `@ibot/core`                              | 9 个原语的**声明**（tool 实现仍在代码里；manifest 只列名字 + 描述，供 UI 展示和 agents 白名单校验）                                            | 强制，不可关   |
| `@ibot/ui`                                | `render_choice` `render_form` `render_table` 三个 ui 模板 + 一段 skill "何时用卡片 vs markdown"（把 §分工规则从 PLATFORM_PROMPT 挪出来，可关） | true           |
| `@ibot/handoff`                           | `request_handoff` 的声明 + 一段 skill（何时交接）                                                                                              | true           |
| `@ibot/web-research`                      | agent `researcher`（无桌面、只 browser_action+run_command、sonnet）+ skill                                                                     | false          |
| 后续：`@ibot/notify-lark`、`@ibot/files`… |                                                                                                                                                |                |

`@ibot/core` 里 tool 的**实现**留在 `tools.ts`，不搬——搬会为了形式牺牲可读性。manifest 只是让"core 也是 plugin"在数据和 UI 上成立。

---

## 8. 前端交互

### 8.0 现状（决定了下面要新建什么）

- `/settings` 只有一页：模型凭据 + 拉取模型列表。**没有** secrets 的 UI（API 已有 `GET/PUT/DELETE /settings/secrets` 和 `/bots/:botId/secrets`，前端 `api.ts` 里没有对应方法）。
- `bots/[botId]/page.tsx` = 头部（头像/名/模型）+ `ChatPanel` + `DesktopPanel`。**没有** bot 设置 sheet/tab；bot 字段的编辑散在头部和 `CreateBotDialog`。
- `ComposerMenu` 已有三组：添加（附件、录制技能）/ 技能（该 bot 的 skills，点选往输入框插入 `用「X」这个技能:`）/ **插件（GitHub、GitLab 两项 disabled 占位，注释写明"等 MCP 有 list endpoint 就接进来"）**。
- 现有 dialog 模式：`CreateBotDialog`、`SkillReviewDialog`（居中 modal，`.card` 风格）。没有右侧 sheet 组件。

所以：secrets UI、bot 设置面、plugin 页都要**新建**，不是"加一个 tab"。

### 8.1 入口（三处）

1. **全局 `/settings/plugins`**（新路由；`/settings` 页顶部加一行 tab：`模型` | `凭据` | `插件`，把现有内容归到"模型"）。Marketplace 风格：上半"已安装"（builtin 灰标 + installed），下半"可安装"（`GET /plugins/catalog`：未启用的 builtin + 硬编码推荐 + "上传 zip / 输入 git URL"）。每项：名称、版本、作者、贡献摘要（`3 skills · 1 MCP · 2 agents · 1 card`）、启用开关、"应用到哪些 bot"多选（默认全部）。
2. **`/settings/secrets`**（新，同页第二个 tab）：用户级凭据表；bot 级凭据在 bot 设置面里。这是 plugin 缺 secret 引导的落点，也补上了 vault 一直没有的前端。
3. **bot 设置面**（新：点 bot 头部的名字/模型打开一个 modal，沿 `SkillReviewDialog` 的样式；tabs：`基本`（名/描述/头像/模型/公网出口/系统提示，把散落的编辑收进来）| `能力`（该 bot 的 plugin 启用矩阵 + `local` plugin 的可编辑内容：skills 列表、MCP 列表）| `凭据`（bot 级 secrets））。
4. **composer `+` 菜单 → 插件组**：把两个 disabled 占位替换为该 bot 有效能力里的 ui 模板和 agents（数据来自 `GET /bots/:botId/plugins`）。点 ui 模板 = 直接打开一张空表单卡让用户填并触发（不经模型，走 `render_ui` 同一输出通道 + `data-uiEvent` 回传）；点 agent = 输入框插入 `让「<agent>」处理:`（复用技能组的插入模式）。

### 8.2 插件详情

复用 modal 样式（`SkillReviewDialog` 那套），tabs：Skills（playbook 只读 + 文件列表）/ MCP（server、transport、需要的 secrets ✓/✗）/ Agents（prompt、工具白名单、模型）/ Cards（每个模板渲染一次示例——`A2uiPanel` + 示例 input，就是 `/dev/design` 那套）/ Setup（步骤 + 每个 bot 的 `status/last_error`）。`local` plugin 的 Skills/MCP tab 可编辑。

### 8.3 缺 secret 的引导

安装返回 `missingSecrets` → 详情顶部 `Chip tone=warn`"需要 2 个凭据"→ 点开内嵌 secrets 表单（写 `PUT /settings/secrets/:name` 或 `PUT /bots/:botId/secrets/:name`，前端补 `api.putSecret/listSecrets/deleteSecret`）。填完自动 re-materialize。

### 8.4 聊天里的可见性

- 任务条：`agent_ref` 有值时显示 `<plugin displayName> · <agent name>` 而不是 goal 截断。
- ui 模板卡片和 `render_ui` 卡片外观一致（同 `A2uiPanel`）。
- `pluginNotes` 让模型知道能力来源，模型说"我用 CRM 插件查一下"时用户能对上。

---

## 9. API

```
GET    /plugins                         已安装（当前用户）：plugin + install + 每个 bot 的启用 + 缺失 secrets
GET    /plugins/catalog                 可安装：builtin 未装 + 推荐源
POST   /plugins/install                 {source: "upload"|"git"|"builtin", ref, enabledBots?}  → {plugin, install, missingSecrets, warnings[]}
PATCH  /plugins/:installId              {enabled?, enabledBots?, config?}
POST   /plugins/:installId/upgrade      {ref}  → 同 install 返回
DELETE /plugins/:installId
GET    /plugins/:pluginId               详情（manifest + 每 bot materialize 状态 + setup step status）
POST   /plugins/:pluginId/preview-ui    {name, input} → A2UI messages（详情页示例卡渲染用，走 a2ui-validate）
GET    /bots/:botId/plugins             该 bot 的有效能力快照（= run 时 resolvePluginsForBot 的输出，前端 composer 菜单用）
POST   /bots/:botId/local/export        local plugin → zip
```

现有 `/skills/*`、`/bots/:botId/secrets/*` 不动；`POST /skills`（发布录制稿）内部改为写进 local plugin。错误码沿 `{error, message}` 模式，`FAIL` 表放 `routes/plugins.ts`。

---

## 10. 安全边界（逐条）

| 面         | 规则                                                                                                                                                                                    | 落在哪                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 平台零执行 | 平台 API 进程对 plugin 只做解析/校验/存储/展开模板，**从不 spawn、eval、require plugin 里的任何东西**。所有 command/stdio/setup 都经 `handle.run` 进盒子                                | 导入器 + `makeTransport` 仍拒 stdio（平台侧）；代码审查项 |
| 盒子里执行 | plugin 代码在**租户自己的盒子**里跑，和模型 `run_command` 同一信任面：能读到的 secrets、文件、网络都一样，不新增暴露。盒子被 plugin 搞坏 = bootstrap 从 DB 重建，DB 是 ledger           | 既有沙箱边界；§4.6 幂等重建                               |
| 显式可见   | 盒子里会跑的每条命令（setupSteps、stdio command、hook command）在**安装前的识别清单**里逐条列出，用户看过才装；升级 diff 同样列出命令变化                                               | `POST /plugins/inspect` + 升级 diff                       |
| 管理面     | 桥进程和 hook command 只绑 `0.0.0.0:<port>`/本地，永不改路由、resolv.conf、iptables；`setupSteps` 的 `cmd` 类型经启发式拦 `ip route`/`iptables`/`resolv.conf` 写入（会切断 noVNC/envd） | 导入器 warn + 拒                                          |
| 凭据       | manifest 里不允许明文密钥：`headers/env` 值必须 `{{secrets.X}}` 或匹配非敏感白名单（`Content-Type` 等）；启发式（≥20 位高熵串）拒并提示                                                 | 导入器                                                    |
| 租户隔离   | `plugin_installs.owner` 决定可见；materialize 只对 owner 的 bot；`resolvePluginsForBot` 走 `bots.owner_id` JOIN                                                                         | SQL 层                                                    |
| 模板逃逸   | `expandTemplate` 不是 JS；输出必过 `a2ui-validate`；catalog 边界不变                                                                                                                    | 展开器 + 安装期预校验                                     |
| Agent 权限 | `tools` 白名单 ⊆ 该 bot 可见 tool；agent 不能带 `spawn_task`（防递归）；`maxTurns ≤ 60`                                                                                                 | 装配期                                                    |
| Hook       | `tool` 类只能触发已知 tool；`command` 类超时 ≤30s、非零退出=忽略、只有 `tool.before` 能 block；每回合每 hook 最多触发一次（防循环）；盒子离线跳过                                       | `installHooks`                                            |
| 资源       | manifest ≤ 2MB；files 单个 ≤ 2MB、总 ≤ 20MB；ui 模板展开后组件 ≤ 200；每 bot stdio MCP **≤ 4 个**（实测一个 npx server 全树 269MB，盒子 available ~1.5GB —— 原写 8 个是按更乐观的估算）；桥 child 重启 backoff 封顶 30s，不设次数上限（DB 行才是"该不该跑"的真相） | 导入器 + bootstrap                                        |
| 供应链     | `content_hash` 记录；升级显示 diff（skills 数/MCP url 变化/新增 agents）要用户确认                                                                                                      | 升级 API + UI                                             |

---

## 11. 迁移路径（一次性，可回滚）

1. 跑 `0007_plugins`（全部 `add column … null` / 新表，零锁风险）。
2. `syncBuiltinPlugins()` 首次运行：建 `@ibot/core` `@ibot/ui` `@ibot/handoff` 行 + 给每个已有用户建 install。
3. 数据回填脚本（幂等）：每个 bot 建 `local` plugin；`skills where scope='bot' and plugin_id is null` → 归到该 bot 的 local；`bot_mcp_servers where plugin_id is null` → 同上；`skills where scope='public'` → 归到一个 `@ibot/legacy-public` builtin plugin（若有数据）。
4. 代码切换：`save_skill`/`bind_mcp`/`POST /skills` 写 `plugin_id`；`buildAgentRun` 加 `resolvePluginsForBot` + 三个新 builder；`ChatPanel` 的 `render_ui` 判定加 `ui__` 前缀。
5. 回滚 = 不读新表即可，旧路径完整保留（这就是 §3.1 保留三张旧表的收益）。

---

## 12. 分阶段实现（每一阶段都是终态的子集）

| 阶段                              | 内容                                                                                                                                                                                                                                             | 交付验证                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 数据 + 装配骨架**            | migration；`PluginManifest` 类型；`plugins/plugin_installs` 仓储；`resolvePluginsForBot`；`syncBuiltinPlugins` 只带 `@ibot/core`（声明）；回填脚本；`save_skill`/`bind_mcp`/`POST /skills` 写 `plugin_id`                                        | 现有 141+ api 测试不变绿；新增 resolve/回填测试；`GET /plugins` 能列出 core + local                                                                                                                                                                 |
| **P2 UI 模板 tool**               | `expandTemplate` + 安装期预校验；`buildUiTemplateTools`；`@ibot/ui` 三个模板；`ChatPanel` 前缀判定；PLATFORM_PROMPT 精简（删 A2UI prop 契约大段，改成"优先用 ui__ 工具，render_ui 兜底"）                                                        | 单测：展开/校验/稳定 id；Playwright：模型调 `ui__ibot_ui__render_choice` → 卡片 → 点选 → chip；token 对比                                                                                                                                           |
| **P3 导入器 + 安装 API + 执行面** | 目录→manifest+files（含识别清单 `inspect`）；install/patch/upgrade/delete；materialize/dematerialize；**`ibot-mcp-bridge.js` 进 provision**；bootstrap 加 plugin 目录物化 + stdio→桥 + `stopBoxMcp`；`bot_mcp_servers` +`last_health/last_error` | 单测：桥的 JSON-RPC 配对/重启/health（本地 spawn 一个 echo server）；E2E：导入一个真实社区 plugin（含 skills + 一个 `npx` stdio MCP + 一个 http MCP）到公网 bot → 下一回合两类 `mcp__` 工具都出现并可调；卸载后进程消失、工具消失；secrets 缺失引导 |
| **P4 Agents + Hooks**             | `buildAgentTools`；`agent_jobs.agent_ref`；`toolAllow/skillNames/maxTurns` 穿到 run；`installHooks` 五种事件、两种 do（`command` 经 `handle.run`，stdin/stdout JSON 协议）；`@ibot/web-research` 示例                                            | 单测：白名单过滤、无递归、hook 单次触发、`tool.before` block、command 超时=忽略；E2E：专家 subagent 结果回流 + 任务条名字；一个 `PreToolUse` 社区 hook 在盒子里拦下一条命令                                                                         |
| **P5 前端**                       | `/settings/plugins`；bot 设置"能力"tab；composer 插件组；详情 sheet（含 Cards 示例渲染）；secrets 引导；local 导出                                                                                                                               | 手测 + 设计页新增 plugin 卡样例                                                                                                                                                                                                                     |

P1 → P2 是杠杆最大的一段（立刻解决 A2UI 手写问题），P3 让社区生态可用（stdio 桥是它的核心，也是最需要真机验证的一块：`npx` 在盒子里的冷启动时长、1GB 内存下几个 MCP 进程能共存），P4/P5 补全体验。每阶段独立 changeset，`@i-bot/types`/`@i-bot/db`/`@i-bot/templates`（桥脚本）minor。

**P3 前置的真机实验 —— 已做完（2026-09-22，公网盒子 `iz52q38dlposb8y8rxh43`，`@modelcontextprotocol/server-filesystem` over `npx -y`）。** 实测数字，以及它们改掉的两个设计假设：

| 量 | 实测 | 结论 |
| --- | --- | --- |
| 冷启动（npx 缓存为空 → 桥报 healthy） | **29.3s** | 原定 health 20×1s 一定超时。改成 **60 次 × 1s**；并把 `npm cache add <pkg>` 放进 `boxLocal.install`（装的时候等，用户本来就在等），失败 `|| true` 退化成冷启动 |
| 热启动（缓存命中） | **2.4s** | 正常路径没有感知延迟 |
| 常驻内存（桥 + child 全树） | **269MB**（冷跑那次 399MB），bridge 1 进程 + child 4 进程 | 盒子 3.9GB / available 1.5GB。§11 的"每 bot stdio MCP ≤ 8 个"按 269MB 估算要下调到 **≤ 4 个**，或按"总 RSS ≤ 1GB"判 |
| pause/resume 后进程 | 存活；`provisionDesktop` 在 connect 也跑，桥脚本自动补回 | 不需要额外记账。`startBoxMcp` 的 already-healthy 短路就是为这条 |

两个被实测推翻的假设，都已修掉：

1. **`ready` 不能等于"进程 fork 了"。** `npx` 的 fork 是瞬时的，npm 之后花几十秒拉包，这段时间写进 stdin 的字节只是躺在管道里。而 bootstrap 一看到 `/health` 200 就把 endpoint 交给平台 → 第一个真实调用必然超时（真机上就是 30s `-32001`）。桥改成**自己向 child 发 `ping`（保留 id `__ibot_ready__`）直到它回任何东西**（回 error 也算：证明有人在读 stdin、写 stdout），才报 healthy。
2. **后台启动不能写成 `mkdir … && nohup … &`。** `&` 作用在整条 list 上，bash 会 fork 一个子 shell 去 wait child，而那个子 shell 持着 envd 的 stdout 管道 → envd 永远等不到 EOF，`handle.run` 超时抛错，`reconcileBox` 把一个**其实起来了**的 server 报成 install 失败。改成：`mkdir` 单独一条；启动用 `setsid … < /dev/null > log 2>&1 &`（三个 fd 全部重定向）。

同一类 shell 坑还咬了第三次：`pkill -f 'ibot-mcp-bridge…'` 会匹配到**执行这条命令的 shell 自己的 argv**（真机验证：没有任何桥在跑时 `pgrep -fc 'ibot-mcp-bridge'` 答 1，写成 `'[i]bot-mcp-bridge'` 答 0）。所有 pkill/pgrep 模式一律写 `[i]bot-…`。

---

## 13. 明确不做的

- **不做** 平台侧执行 plugin 代码（哪怕 wasm/vm2）。plugin 要"跑"只有一个地方：盒子。需要新的**平台侧**逻辑（改 AI SDK 工具装配、新的服务端 tool）= 我们写 builtin plugin + 代码里的 tool。
- **不做** plugin 自定义 AI SDK tool 实现。plugin 想给模型新工具的唯一方式是 MCP（stdio 在盒子里、http 远端）——这正是 MCP 存在的意义，不发明第二套。
- **不做** plugin 之间的进程隔离。它们都在同一个盒子里，和模型同一信任面；一个 plugin 能读另一个的 `${PLUGIN_ROOT}`，这和 Claude Code 单机一致。
- **不做** `commands/` slash 命令——聊天形态用 composer 菜单代替。
- **不做** 版本范围自动升级——升级永远是用户点的，带 diff 确认。
- **不做** pgvector 检索——skill 数量级未到；`embedding` 列继续留空。

---

## 14. 待确认的决策点

1. **org 作用域**：`plugin_owner` 预留了 `org`，但现在没有 org 表。P1 只实现 `user`，enum 先占位。OK？
2. **builtin 是否允许用户关 `@ibot/ui`**：关了模型就回到手写 `render_ui`。我建议允许（有人可能只要 prose），默认开。
3. **`local` 导出后的归属**：导出的 zip 装回来是 `installed`（不可编辑）。想继续编辑得改 local。这符合"skill 理论上不给用户改"的原则；确认。
4. **Marketplace 源**：v1 只有"上传 zip / git URL / builtin 目录"，我们不维护一个中心索引。推荐列表先硬编码几条。够不够？
