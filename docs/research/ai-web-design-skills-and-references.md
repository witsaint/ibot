# AI 生成网页：设计技能、参考网站与验收标准

调研日期：2026-09-28。核对了官方仓库 README、部分 SKILL.md、作者网站和 skills.sh 目录。本文的适用性排序是分析判断，不是同一模型下的效果测试。未安装或更新技能，未修改应用。

## 结论

建议采用「项目事实与设计约束 → 参考与设计方案 → 实现 → 浏览器验收 → 打磨」的工作流程。选择一个主要的设计技能，另配质量检查；不要把多个技能的全部审美规则一起注入。技能能提供方法，不能替代真实交互、不同屏幕尺寸和内容状态的验证。

## 技能选择

| 技能与来源 | 已核实的能力 | 适用情况 | 使用边界与建议 |
| --- | --- | --- | --- |
| [frontend-design / Anthropic](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | 按产品、受众和真实内容决定字体、色彩、布局；先设计方案，再实现与批评；避免固定模板表现 | 新页面、品牌网站、已有界面改版 | 通用设计指导，不是功能测试或完整可访问性审计工具 |
| [Impeccable / pbakaus](https://github.com/pbakaus/impeccable) | 当前主线提供一个技能、24 个命令、61 条确定性检测规则；init 记录 PRODUCT.md，document 记录 DESIGN.md；包含 critique、audit、polish、harden、adapt | 对 AI 生成界面做持续检查和改进 | 本次未实测检测器效果；部分审美禁用规则不能压过项目品牌约束。最新安装器还包含引擎与 hooks，不能只按一份提示词理解 |
| [Taste Skill / leonxlnx](https://github.com/leonxlnx/taste-skill) | 先判断需求、受众和风格，再决定布局变化、动效和密度；新主线 v2 标为 experimental | 落地页、作品集、创意网站、改版 | 本地技能明确不面向 dashboard、数据表和多步骤产品界面；不建议作为 i-bot 整个产品的唯一规则 |
| [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | Python + BM25 检索样式、配色、字体和 UX；按产品类型生成设计系统；提供框架相关指导 | 从零探索方向，比较行业方案，补充常见 UX 规则 | 检索推荐依赖关键词与内置数据；不是用户研究结果。已有设计系统时避免生成第二套全局规范 |
| [web-design-guidelines / Vercel](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) | 每次读取最新规则，对代码检查键盘、焦点、表单、动效、图片、导航等 | 产品界面实现后检查 | 属于工程与体验规则，不能独立决定品牌风格，也不能证明全部用户流程已通过 |
| [react-best-practices / Vercel](https://github.com/vercel-labs/agent-skills) | React/Next.js 的请求瀑布、体积、服务端、渲染等性能规则 | React/Next.js 网站的性能改进 | 按实际瓶颈使用，不是视觉设计技能 |
| [emil-design-eng / Emil Kowalski](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md) | 组件细节、动画曲线、时长、动效频率；作者另提供移动端体验及动效审查技能 | 菜单、弹窗、提示、移动端等细节打磨 | 有作者个人偏好；按交互频率和任务需要应用，不应给所有元素添加动画 |

### 社区使用情况

[skills.sh](https://skills.sh/) 当日显示的安装数约为：frontend-design 930K、vercel-react-best-practices 749K、web-design-guidelines 674K、design-taste-frontend 530K、ui-ux-pro-max 374K、emil-design-eng 303K、impeccable 298K。数字会变，安装数不是设计效果、活跃用户数或质量测试。

通过 GitHub 仓库 API 核对，以上来源仓库均超过 100 stars；Anthropic、Vercel 属于官方维护来源，其余为作者或社区项目。仓库规模包含其他技能，不能当作单项技能质量排名。

### 安装入口（本次未执行）

```sh
npx skills add anthropics/skills --skill frontend-design
npx skills add vercel-labs/agent-skills --skill web-design-guidelines
npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices
npx skills add leonxlnx/taste-skill --skill design-taste-frontend
npx skills add nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max
npx skills add emilkowalski/skills --skill emil-design-eng
```

目录中的名称可能与仓库文件夹名称不同，应按安装时发现的技能名称核对。Impeccable 最新 README 推荐从项目目录执行 `npx impeccable install`，再在所用工具中执行 `/impeccable init`；安装内容及命令以其[官方说明](https://github.com/pbakaus/impeccable#installation)为准。

## 针对 i-bot 的建议

1. 产品界面：以现有 design.md、design tokens 和真实组件为约束。选 Impeccable 的审查/打磨流程，配 Vercel 界面规范。新增工具写 DESIGN.md 时须先协调现有小写 design.md，避免两份规范在不同文件系统中产生歧义。
2. 落地页：按任务选 frontend-design 或 Taste Skill；产品界面和宣传页面可有不同动效强度，但共享品牌资产。
3. 改进顺序：先确认关键流程可完成，再修层级、字体、间距和对齐，最后加有用途的动效和图片。当前 design 展示页应继续使用实际组件及实际状态。
4. 参考输入：提供 2–3 个同类型参考，明确各取什么，例如布局、内容层级或菜单交互；不要只说「高级」「科技感」。
5. 浏览器验收：覆盖窄屏/宽屏、中文长文本、空数据、加载、错误、禁用、键盘、触摸；真实完成创建 bot、启动桌面、对话、人工接管等流程。静态截图只能证明特定状态的外观。

## 可复用任务说明

> 先阅读项目设计规范和已有组件，明确页面受众、用户要完成的任务与真实内容。比较两种适合的布局方向并选择其一，说明字体、层级、密度和交互依据。实现后在浏览器检查不同屏幕尺寸、键盘操作、加载、空数据、错误与长文本；完成主要用户流程。最后检查间距、对齐、对比度、性能与减少动态效果设置，记录尚未验证的内容。


## 参考网站

| 资源 | 官方内容与来源 | 推荐使用方式（判断） | 费用与局限 |
| --- | --- | --- | --- |
| Awwwards | 获奖案例展示 Design、Usability、Creativity、Content 四项评分，同时 Developer Award 包含 Accessibility、WPO、Responsive 等维度。[官方案例](https://www.awwwards.com/sites/self-aware) | 品牌官网、作品集、活动页：学习艺术方向、排版、滚动表现和动效；查看真实网站而非只看缩略图。 | 本次案例可公开查看；Pro/投稿付费情况未确认。获奖分数不能证明适合聊天、管理后台等任务密集产品，也不能代替 WCAG 检查。 |
| Godly | 当前 [godly.design](https://godly.design/) 展示精选 web、app、UI 与视觉作品；旧 [godly.website 案例](https://godly.website/website/644-user-interface-gallery) 可见样式、字体、框架等标签。 | 寻找主视觉、字体组合、构图、细节与独特风格；建议从同类产品选 2–3 个例子。 | 本次取得公开内容；完整价格政策未确认。新旧域名信息并存，使用当前入口时需留意改版；精选不等于产品可用性认证。 |
| Siteinspire | [官方首页](https://www.siteinspire.com/?app=1) 提供 Typographic、Grid Layout、Minimal、Unusual Layout、Portfolio 等分类。 | 尤其适合系统学习排版、网格与克制布局；适合官网、内容页、作品集。 | 公开浏览已确认；是否有付费扩展未确认。主要是完整网站展示，复杂流程/错误状态需另查。 |
| Landbook | [官方 Pro 页](https://land-book.com/pro) 支持页面类型、sections、motion、字体/行业/样式过滤、boards、移动预览、历史版本和截图下载。 | 从页面到单个 section 拆解；研究首页、pricing、signup、about 等布局，适合向 AI 提供具体参考段落。 | 免费功能有限；Pro 当前 $9/月或 $72/年。不能从图库截图推断交互是否正确。 |
| Lapa Ninja | [官方价格页](https://www.lapa.ninja/pro/)：精选 landing pages，每日更新；免费访问 7,000+ 网站，5 个 boards、每 board 20 个保存；Pro 提供无限 boards/saves、去广告。 | 适合 SaaS 落地页、营销内容结构与不同视觉风格；免费起步门槛低。 | 免费有广告与保存限制，Pro 当前 $9/月。落地页参考对管理后台、聊天流程覆盖有限。[官方政策](https://www.lapa.ninja/policy/)注明图库和内容所有权，不应照搬整个站点或资源。 |
| Mobbin | [官方首页](https://mobbin.com/) 提供真实 iOS/Web apps、screens、UI elements、flows、截图文字搜索、interactive hotspots、Figma 复制与 collections。 | i-bot 的创建 bot、设置、空状态、登录、订阅等产品流程优先参考；比只看 homepage 更接近真实产品使用。 | 官方确认可免费使用，完整访问需付费方案；具体当前价格未确认。流程记录提供参考，不能证明这些产品模式适合本项目；截图可能不是最新版本。 |
| Refero | [官方首页](https://refero.design/) 已定位为 AI 时代设计研究：真实 screens、flows、UX patterns、UI elements；支持按任务描述获得分析/参考，并提供 Refero MCP。[价格入口](https://refero.design/pricing) 本次页面正文不可读取。 | 适合 AI 编码前按“任务/流程/元素”检索；例：聊天输入框、侧栏、表格、空状态、billing。MCP 可减少依赖人工粘贴截图。 | 具体免费/付费边界和 MCP 条件本次未确认。官方关于改善生成效果属于产品宣称，本次未实测质量或 agent 接入。 |

Page Flows 的官方主页本次打开出现 Internal Error，搜索也未取得其当前官方内容。社区条目称其提供 user flow 视频，但不足以作当前一手核实，因此不把它列入确认推荐，也不报告未经核实的价格。

## 验收标准

建议项目将 WCAG 2.2 AA 作为可访问性目标；这是建议，并非本次已经证明项目符合该标准。[W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) 是规范；[WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/about/introduction/) 是解释与组件行为指导，官方明确它不是完整设计系统，也不是生产组件库。

可直接放入 design.md 的具体检查：

- 普通文字对比度至少 4.5:1，大字号至少 3:1；存在禁用/纯装饰/logo 等例外。[WAI 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- 指针目标一般至少 24×24 CSS px，或满足间距/等效操作等例外。44×44 可作为项目对关键触控按钮的更高目标，但不能把它误写成 WCAG 2.2 AA 的统一最小值。[WAI 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- 页面需检查窄屏和缩放重排，避免普通内容同时依赖两个方向滚动；表格/图示等存在例外。[WAI Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
- menus、dialogs、tabs 等按 APG 确认键盘操作、语义、可访问名称和焦点管理，并用实际键盘验证。[WAI APG](https://www.w3.org/WAI/ARIA/apg/about/introduction/)
- 实际用户性能的目标是第 75 百分位：LCP≤2.5 秒、INP≤200 ms、CLS≤0.1；实验室单次分数不是线上真实用户指标的等价证明。[web.dev 官方阈值](https://web.dev/articles/defining-core-web-vitals-thresholds)

## 检查工具

- **Lighthouse**：Chrome DevTools、CLI 或 Node 都可运行，提供性能、可访问性等审计。[官方文档](https://developer.chrome.com/docs/lighthouse)；可访问性分数不包含手动审计，所以 100 分不等于 WCAG 完整合规。[官方评分说明](https://developer.chrome.com/docs/lighthouse/accessibility/scoring)
- **axe DevTools / axe-core**：免费浏览器扩展可查常见问题，也有付费扩展与团队方案；官网现在还列出 Axe MCP。[官方扩展说明](https://www.deque.com/axe/devtools/extension/)。选择工具/接入 CI 前再查具体套餐与许可证。
- **人工检查**：纯键盘完成主要任务、屏幕阅读器读标签和状态、不同屏幕宽度与缩放、错误/空/加载/成功状态、真实内容长度。W3C 明确工具不能自动覆盖全部可访问性，需要人的判断。[WAI 工具能力边界](https://www.w3.org/WAI/test-evaluate/tools/selecting/)；Chrome 同样要求实际使用键盘/屏幕阅读器检查导航能力。[DevTools 说明](https://developer.chrome.com/docs/devtools/accessibility/reference)

