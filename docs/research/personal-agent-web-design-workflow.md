# Personal agent 网页创作：design.md、skills 与执行标准

日期：2026-09-28。状态：网页创作指导已封装为 `plugins/web-creator` 插件，通过 `/web` 或聊天菜单主动调用；自动发布和维护中的前端初始化模板仍需后续实现。资源能力依据官方页面和公开仓库核对，尚未进行同一任务的生成效果对比。

## 目标与范围

用户通过对话得到美观、可操作的网页，查看结果并继续提出修改；交付预览或发布链接。不增加网页管理列表或可视化编辑器。内部保存执行上下文、代码和必要数据，支持恢复与维护。

本流程的设计规范位于 bot 的 sandbox 内生成的前端项目目录，例如 `/root/projects/activity-page/design.md`；该路径只是建议示例。它与源码、主题配置一起属于该前端项目。生成和修改时读取该文件。项目规范独立于 i-bot 平台本身的规范，不同时保存仅大小写不同的两份文件。接入要求固定大写文件名的工具时统一该项目命名，避免两份文件。

## 从场景和内容寻找合适设计

设计选择需要前置过程：读取需求与内容 → 提炼使用场景与视觉要求 → 检索 → 看实际候选 → 选择与组合 → 形成项目规范。此过程不能仅靠品牌名称或主题标签完成。

## 内容创作与设计共同推进

用户提供主题时，agent 需要创作实际内容，不只是选择主题或填充模板。在设计检索前明确页面要讲什么、访客需要理解什么以及各区块的作用；选择设计后用真实文案和素材落实，再按实际布局调整篇幅。此过程允许反复修订，不固定为先写完全部文案再排版。

### 内容依据与缺失信息

区分用户给定事实、可追溯资料、agent 创作表达与未确认事项。agent 可以创作标题、描述、叙事结构和建议，但不能把虚构客户、评价、销量、价格、履历、活动时间、报名名额等写成已确认事实。仅有主题时先完成有依据的内容和合适的创意表达；会影响主要服务的信息缺失时提问，或在私人初稿中明确待补，不以假数据伪装已完成内容。

内容要求可在任务上下文中维护为小纲要，无须建立网页管理列表或强制增加大量文件。较长任务可在生成项目中使用简短的 content.md；它属于该项目，design.md 引用其内容约束。内容事实与产品行为不重复塞入视觉参数，也不让视觉参考提供当前项目的业务事实。

### 首屏与后续区块

首屏应清楚表达主题/身份、访客价值、需要的关键背景；存在主要操作时提供真实可执行的入口。表达形式由内容决定，可以是标题与说明、作品大图、产品演示、关键结论或可直接使用的小工具。没有行动需求时不强加注册或购买按钮。

后续区块按访客问题安排，每块回答一个问题，并增加有用信息：这是什么 → 有什么具体内容 → 为什么可信/适合我 → 怎么参与/使用。活动、作品、报告和工具应各自采用合适的顺序，不能统一套用销售页面框架。

每块定义：目的、核心信息、内容依据、标题与正文、表达元素、可用素材、实际交互。元素可以是摄影、文字、图表、地图、时间线、对比、产品截图、案例或表单；由它是否改善理解与操作决定，不为了填满版面增加卡片。

例如私人徒步活动页可采用：

| 区块 | 访客需要什么 | 内容与表达 | 依据 |
| --- | --- | --- | --- |
| 首屏 | 知道活动及是否想参加 | 有关具体路线的标题、简短说明、真实地点/时间、路线图片、报名入口 | 用户给定活动信息；图片来自可用素材 |
| 路线与安排 | 判断行程是否适合 | 路线图、停留点、时间线 | 用户资料或可追溯路线来源 |
| 参与说明 | 判断体力、准备和条件 | 简明说明、装备清单、天气/取消安排 | 已确认规则；缺失重要规则待确认 |
| 报名 | 知道填写什么和完成后结果 | 必要字段、校验、提交反馈 | 实际服务行为 |

此示例不暗示所有活动都需要四块；内容短则合并，内容复杂则展开。

### 提升品味的检查

品味不能只靠固定配色或「禁止某种风格」实现。执行时比较：页面是否表达主题独特之处；首屏焦点是否明确；各区块是否增加新信息；大图、密集信息和留白是否有节奏；文字是否具体清楚；素材、字体和交互是否属于同一视觉方向；动效是否帮助理解。适合时为首屏在同一规范内比较两个构图，再选择更能承载真实内容的一个，无需每次生成两个完整网站。

第一轮检查看内容意义与主要操作；第二轮看层级、排版与阅读；最后再做细节和动效。删除重复标题、泛泛宣传、无用途装饰和不影响决策的区块，比单纯添加特效更有助于结果。禁止规则不自动覆盖用户指定风格。

### 已核对可复用的技能部分

| 来源 | 可以复用 | 需要限制的部分 |
| --- | --- | --- |
| [Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | Ground your designs in the subject matter；More on writing in design：从用户视角写、内容服务理解、具体操作文案、一致术语 | 视觉部分遵循当前项目 design.md；其举例或风格偏好不是绝对禁令 |
| [Impeccable shape](https://github.com/pbakaus/impeccable/blob/main/skill/reference/shape.md) | purpose/people/outcome、真实材料、范围与状态、最小 brief 的结构 | 原流程有稀疏需求至少询问一轮、显式确认后停止；本平台仅复用分析清单，不原样挂载其强制停顿流程 |
| [Impeccable clarify](https://github.com/pbakaus/impeccable/blob/main/skill/reference/clarify.md) | message hierarchy、按功能写操作/表单/错误/空/成功文本、全流程术语一致、长文本验证 | 用于界面清晰度，不替代页面叙事或营销内容创作 |

这些部分可以形成平台自己的网页内容指导，保留上游来源与版本说明；采用原文或分发技能前核对许可。不是把所有 skill 的完整指令叠加，也不把第三方默认行为包装成已实现的平台能力。

### 需求引导

agent 从用户描述、已有对话与素材推断：受众、网页的主要任务、内容类型与长度、可用图片、主操作、视觉感受、语言与设备。用户已提供的要求无需再次询问；能够合理推断时先简短说明设计方向并执行。只有明显不同方向会影响结果时提供两个带实际预览的选项。

例如：活动介绍与报名 → 手机阅读、时间地点优先、摄影图片与清楚报名入口；长篇调研 → 可读排版、目录、图表、较低装饰密度；摄影作品集 → 图片主导、留白与浏览节奏；工具产品介绍 → 产品演示、功能证据与清楚试用入口。关键词相同的行业也会因用户任务不同采用不同布局。

### Agent 如何知道有哪些设计

建议维护小规模、人工检查过的设计参考索引，初期约 12–20 项。每项记录实际预览、规范来源、适合用途、内容结构、密度、字体/配色特点、图片要求、动效强度与已知局限。索引是内部设计资源，不是用户网页列表。技能及资源索引的持久来源放在平台数据库/版本化资源中，按需提供给 bot；sandbox 中放本次选中的规范与素材，避免唯一副本留在临时环境。

先检索已有索引；不匹配时再去外部库搜索，不要求每次遍历所有网站。获取的外部资源明确区分官方文件、社区分析和提取内容，不因文件存在就标注已验证。

Refero 官方技能已提供可用的检索方法：[MCP 工具说明](https://github.com/referodesign/refero_skill/blob/master/skills/refero-design/references/mcp-tools.md)。`refero_search_styles` 按视觉、行业、受众等自然语言语义检索，返回 style ID、描述、来源和预览；`refero_get_style` 再取得完整规范。建议先使用 3–5 种不同检索角度，随后详细查看约 3 个候选。当前 i-bot 未因此自动具备这些工具，实际接入要核对账号、MCP 配置和访问条件；缺少连接时可通过浏览器查看公开页面，不逆向未公开 API。

官方说明 Styles 主要覆盖营销、产品介绍、pricing、editorial 等网页，不覆盖 dashboard、auth、settings 等产品内部界面的完整样式体系；这些场景还需 screens/flows 参考。Free design.md 可按主题选规范，另有 [PATTERN.md 布局库](https://freedesignmd.com/patterns)；Landbook 按行业、风格、网站类型与字体等检索，并参考具体区块，[官方说明](https://land-book.com/pro)。

### 检索与选择示例

用户要求「把周末徒步活动做成能报名的网页」：

- broad aesthetic：`warm nature photography editorial landing page`。
- domain/task：`outdoor event landing page itinerary registration mobile`。
- alternative composition：`minimal travel event page clear schedule signup`。

检索词是建议示例，不是已运行查询。候选比较优先判断任务契合、现有内容能否适配、层级与阅读、手机布局、组件状态和素材成本；不通过首图好看就直接决定。先排除长文本难读、需要大量缺失图片、隐藏关键操作等候选，再比较视觉表达。无足够候选时使用已检查的基础方案，不编造参考或宣称已浏览。

### 组合落地页

选择一个主要规范，统一字体、配色、密度、圆角与基础组件；最多从其他来源补充 1–2 个明确部分，例如首屏构图或时间表布局。将参考部分转换到同一套参数后写入项目 design.md，避免拼接三套完整规范。

页面区块由真实内容决定：活动页可为首屏 → 时间地点 → 路线/安排 → 必要说明 → 报名；没有价格、用户评价或客户数据就不添加对应区块。图片强的内容可以突出摄影，文字强的内容可以突出阅读与结构。初稿须按真实内容验证，确保换成当前内容后设计仍成立。

## 职责与冲突处理

| 内容 | 职责 |
| --- | --- |
| 用户需求与真实内容 | 网页给谁使用、完成什么、有哪些数据与交互 |
| 项目的 design.md | 本次网页的视觉参数、组件、布局和交互规范 |
| 技术模板 | 项目结构、验证过的依赖版本、基础组件、启动与构建命令 |
| Skills | 设计、实现、审查的方法，不自行覆盖项目设计决策 |
| Workflow | 阶段、必需产物、检查条件、失败恢复 |

用户的新要求优先；出现与平台硬性访问权限、可靠数据处理或可访问性要求冲突时明确说明并选择满足需求的替代实现。项目 design.md 优先于外部 skill 的通用审美偏好。现有实现与规范不符时检查并修复，不默认用新实现反向覆盖规范。用户修改主题时先更新规范，再同步实现。

## 可直接采用的规范应如何适配

外部 DESIGN.md 只作为参考输入。保留来源 URL、获取时间、官方/社区分析/提取的类型；检查文件、素材和字体的使用条件。选一个主要设计来源，其他参考只补充明确维度，避免混合互相矛盾的字体、密度和布局。

规范至少应包含：

1. 用途、受众与页面类型。
2. 内容结构和主要操作；展示数据、输入数据与真实数据处理方式。
3. 色彩角色与具体参数；正文、次要文本、按钮文字和背景的配对。
4. 中文与英文的字体、备用字体、字号层级、行高。
5. 内容宽度、间距、圆角、边框、阴影和移动端布局。
6. 按钮、表单、导航、卡片等所需组件及其状态。
7. 动效用途、频率及减少动态效果设置。
8. 图片、图标和内容要求。
9. 明确的验收条件。

固定参数由 CSS variables 或主题配置集中实现；design.md 说明参数及用途，并引用相应文件。调整固定参数时同步更新规范与代码。参考品牌 logo、虚构评价、指标、业务文案不应直接成为当前网页内容。

## 推荐工作流

实际顺序为：理解主题与事实 → 内容纲要和主要操作 → 参考检索 → 内容与设计共同形成方案 → 项目 design.md → 真实内容开发 → 内容/视觉/功能验收 → 反馈与交付。内容纲要先于样式选择，详细文案与设计共同调整。

| 阶段 | Agent 行为 | 阶段产物 | 完成条件 |
| --- | --- | --- | --- |
| 1. 理解与初始化 | 读取对话和现有文件，判断展示/交互/服务；整理事实、内容纲要与操作；创建独立项目，选择固定技术模板 | 用途、内容纲要、主要操作及可启动项目 | 关键需求明确，环境能够执行 |
| 2. 选择参考与主题 | 优先用户已有规范；其次适合的资源库；无合适规范时生成；简短说明方向 | 参考和设计方向 | 方向符合内容、受众、屏幕与使用频率 |
| 3. 形成项目 design.md | 读取实际参考文件，适配内容、中文和交互；确定 tokens 与组件状态 | 项目规范及主题配置 | 无明显冲突，参数可实现，必要状态完整 |
| 4. 设计与开发 | 按任务加载内容指导、一个主要设计 skill 和技术模板说明；写实际文案、准备素材，在 sandbox 实现并尽早运行初稿 | 页面内容、源码和初稿 | 页面可打开，主要内容与操作出现 |
| 5. 浏览器验收 | 读取规范并检查宽/窄屏、长文本、交互、键盘、控制台和网络错误；按需加载专项 skill 修复 | 检查证据与修复结果 | 主要操作通过，必要状态与布局正确 |
| 6. 用户反馈 | 展示网页，理解修改意图；局部需求局部修改，整体主题变化同步规范 | 更新后的实际页面 | 受影响范围重新验证 |
| 7. 交付 | 构建并验证产物；按用户需求预览或发布；验证最终链接 | 可访问结果与真实状态说明 | 链接与承诺功能可用，说明依赖与未完成项 |

不会要求用户逐步批准。缺失信息足以影响数据接收人、访问范围或主要功能时提问；布局和默认技术选择由 agent 决定。重新进入修改任务时继续使用现有规范与项目，不重建全部流程。

## Skills 组合

- 新展示网页：`frontend-design` 或 `design-taste-frontend` 二选一，受项目规范约束。
- 表单/小工具/服务网页：主要设计指导结合 Impeccable 的状态与体验检查；Taste Skill 不作为复杂产品的唯一指导。
- 创建/提取规范：[Google Stitch design-md skill](https://github.com/google-labs-code/stitch-skills/blob/main/plugins/stitch-utilities/skills/design-md/SKILL.md) 或 Impeccable 的 document/extract。前者有 Stitch 上下文要求，不能假设普通网页 URL 能直接使用。
- 实现后：Vercel `web-design-guidelines`。
- 间距、层级、溢出、文案等问题：按需使用 Impeccable 的 layout/typeset/harden/clarify/polish。
- 动效细节：按需使用 Emil 的设计工程和动画指导。
- 配色/字体/行业方向缺乏依据时：UI UX Pro Max 检索提供候选，不自动创建第二份全局规范。

来源与进一步比较见 [技能调研](./ai-web-design-skills-and-references.md)。外部文件或 skill 中的风格偏好不能覆盖用户要求或项目规范。文件放在根目录不能保证模型会读取，必须在任务入口、开始实现、恢复执行和修改主题时明确装配上下文。

## 技术与预览默认值（建议）

生成项目独立于 i-bot 应用：展示和浏览器交互默认 React + TypeScript + Vite；确需服务端逻辑时使用维护好的 Next.js 模板及明确的数据接口。平台不改变自身锁定技术栈。模板统一包管理器和 lockfile，定期验证依赖与启动/构建；简单页面不引入不需要的后端。

通过 sandbox 命令和后台任务开发，通过 CDP 操作实际网页。预览从已授权的项目进程和端口获得，不接收任意目标 URL 进行转发；隔离生成页面与平台凭据。公开访问的生命周期和授权独立于开发桌面，不把开发服务器当正式服务。[Vite 构建](https://vite.dev/guide/build)、[Vite 预览限制](https://vite.dev/guide/static-deploy)、[Next.js 静态导出限制](https://nextjs.org/docs/app/guides/static-exports)。

## 执行与验收标准

编排层保存当前任务阶段、工作目录、设计规范版本或内容标识、所选技能和检查结果。这是内部执行状态，不是用户面对的网页记录功能。现有 [技能加载](../../apps/api/src/agent/skills.ts) 会注入适用技能的完整 playbook；实现本方案需按任务阶段筛选上下文，不声称当前已支持。

程序核实：项目存在、进程运行、HTTP 可达、构建成功、最终链接可访问。Agent 核实：视觉层级、参考契合、真实内容、完整用户操作。不要凭进程启动断言功能通过，不凭静态截图断言表单数据已保存。

首轮至少覆盖：约 390px 与 1440px 宽度、中文长文本、必要的加载/空/错误/成功状态、键盘主要操作、控制台异常、主要业务流程；无需为了展示把全部不存在的状态造出来。正式可访问性目标与自动工具限制见技能调研中的 WCAG/APG 章节。

需要可执行的验收条目，如「报名必填校验与真实保存通过」「窄屏导航可打开关闭」，避免仅填写「好看」「响应式已完成」。视觉问题修复后复查相关尺寸；功能变化重新验证受影响操作。重复失败应诊断或说明具体阻塞，不无限循环重生成。

## 可复制的 design.md 来源

核对日期：2026-09-28。来源名称不代表品牌字体、Logo 和图片可直接用于自己的网页。

| 来源 | 性质 | 复制方式与核对结果 | 使用边界 |
| --- | --- | --- | --- |
| [Refero Styles](https://styles.refero.design/) | 对真实网站风格的提取和解释，非被参考品牌官方规范 | [OpenAI 样例](https://styles.refero.design/style/dc541737-8bf2-4b31-b729-0352f696e82f) 有 Copy.md、Compact/Extended，以及 CSS Variables、Tailwind v4、Design Tokens 输出；实际 Markdown 包含颜色角色、字体、间距及规则 | 页面明确声明测量经归一化、角色和建议经解释、HTML 是重建。公开样例可读；完整复制权限、法律许可和订阅边界未确认 |
| [freedesignmd](https://freedesignmd.com/) | 网站提供的策划设计系统与布局方案，非品牌官方文件 | [Linear Orbit](https://freedesignmd.com/system/linear-orbit) 有 Copy .md、Download .md；已核对配色、字体、间距、按钮、表单等实际预览 | 网站声明无需账户、免费复制/修改/商业使用且无需署名；独立法律许可文件未确认。不能将 Linear Orbit 认作 Linear 官方规范 |
| [VoltAgent awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | 社区维护的真实网站分析集合 | 复制 GitHub 文件或下载 Raw。[Linear 实际文件](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md) 有 YAML tokens、设计理由、状态、响应式和迭代说明，名称明确为 Linear-design-analysis | [仓库 MIT](https://github.com/VoltAgent/awesome-design-md/blob/main/LICENSE)；品牌资产不因此获得许可。文件说明自有字体未公开分发，并提供替代字体建议 |
| [VoltAgent official-design-md](https://github.com/VoltAgent/official-design-md) | 指向企业/项目自身发布文档的目录 | 跟随原站链接复制。[Microsoft FAST 实际文件](https://github.com/microsoft/fast/blob/main/examples/design-system/DESIGN.md) 已核对，包含 CSS 语义变量、主题、状态和 agent 修改规则；并非 Google YAML 格式 | 目录 MIT 只覆盖目录，链接文档仍属各自所有者。采用时核对原文件许可及依赖；不必照搬来源技术体系 |
| [Google DESIGN.md](https://github.com/google-labs-code/design.md) | Google Labs 官方格式与工具，非主题目录 | YAML 精确值配 Markdown 理由；支持 lint、diff、导出 Tailwind v3/v4 和 DTCG。[官方发布说明](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) | 格式仍为 alpha，需固定采用版本。同名文件不一定能直接通过 CLI；结构检查不能代替网页实际验收 |

实际核对发现：awesome-design-md 的 Linear 是接近黑色背景、薰衣草蓝强调的营销网站方案，freedesignmd 的 Linear Orbit 是浅色方案。主题必须按实际内容和任务用途选择，不能只按品牌名称匹配。

Google 当前命令为 `npx @google/design.md lint DESIGN.md`、`npx @google/design.md diff DESIGN.md DESIGN-v2.md`、`npx @google/design.md export --format css-tailwind DESIGN.md`。官方说明 export 不以 lint 结果阻止导出；因此应先 lint 再导出，最后验收真实网页。对比度检查只覆盖文档中可检查的颜色组合，不能证明整个网页符合 WCAG。[官方 CLI 文档](https://github.com/google-labs-code/design.md)

官方 [design-md skill](https://github.com/google-labs-code/stitch-skills/blob/main/plugins/stitch-utilities/skills/design-md/SKILL.md) 通过 Stitch MCP 从已有页面获取 HTML、截图和主题；[extract-design-md skill](https://github.com/google-labs-code/stitch-skills/blob/main/plugins/stitch-design/skills/extract-design-md/SKILL.md) 从已有前端源码提取，无须启动应用。已有代码任务更适合后者；它们都不保证完成产品交互、运行和发布。

## 内容技能来源补充

2026-09-28 核对 marketingskills 当前源码：现名为 `product-marketing` 和 `cro`，此前的 `product-marketing-context`、`marketing-context`、`page-cro` 文件路径返回 404。以下为适配方案，不代表已接入。

| 技能与实际章节 | 可复用部分 | 条件与边界 |
| --- | --- | --- |
| [product-marketing](https://github.com/coreyhaines31/marketingskills/blob/main/skills/product-marketing/SKILL.md)：`Sections to Capture` 中的受众、场景、用户措辞、语气、事实依据、目标 | 从对话和材料起草内容上下文；原文支持自动起草，并允许跳过不适用章节 | 通用网页保留上述信息；采购角色、竞争对手、替代成本、销售异议只用于相关商业页面。不照搬每节确认的流程 |
| [copywriting](https://github.com/coreyhaines31/marketingskills/blob/main/skills/copywriting/SKILL.md)：`Before Writing`、`Above the Fold`、`One Idea Per Section`、`Voice and Tone`、`CTA Copy Guidelines` | 首屏标题、副标题、主要操作；后续区块各自传达一个重点；用操作文字说明用户得到什么 | 行动可以是查看路线、浏览作品、开始计算；普通报告无需购买导向。原文要求真实，禁止伪造统计与评价；不将营销标题公式作为所有网页的固定句式 |
| [copy-frameworks](https://github.com/coreyhaines31/marketingskills/blob/main/skills/copywriting/references/copy-frameworks.md)：`Landing Page Section Types`、`Section Writing Tips`、`The Perception Gap` | 作为区块候选库：步骤、案例、场景、FAQ、对比、故事、演示；检查措辞是否符合受众 | 根据真实内容选择，不照搬 11 区块销售模板、客户 Logo、评价、保证和紧迫感。文件中的转化提升数字没有给出研究出处，不作为效果证据 |
| [copy-editing](https://github.com/coreyhaines31/marketingskills/blob/main/skills/copy-editing/SKILL.md)：`Clarity`、`Voice and Tone`、`Prove It`、`Specificity`、`Quick-Pass Editing Checks` | 默认检查清晰、语气、依据和具体程度，重要内容先写，保留原意 | 数字无依据就删除或标明未知；不为了具体而补造数字。中文不照搬英文词数限制；恐惧、FOMO、退款保证和模拟专家分数不作为通用验收要求 |
| [cro](https://github.com/coreyhaines31/marketingskills/blob/main/skills/cro/SKILL.md)：`Visual Hierarchy and Scannability`、`CTA Placement, Copy, and Hierarchy`、`Friction Points` | 检查用途是否清楚、图片是否支持内容、主要操作是否容易找到、表单与手机体验是否妨碍使用 | 对商业落地页再检查转化目标与销售异议；报告需要目录和阅读路径，不照搬单 CTA、移除导航等广告页规则 |

推荐编写自己的网页内容 skill，记录借鉴章节与触发条件。它负责用途、结构、正文、依据和素材用途；设计 skill 负责布局、字体、颜色、构图；项目 `design.md` 固定已经选定的视觉与交互规范。按阶段加载，避免把完整营销规则注入每个个人网页任务。
