# 网页主题、design.md 与参考来源

核实日期：2026-09-29。下列外部数量是当日官方页面的声明，会随版本改变；不是本插件已安装的数量。

## 修改前实际有什么

检查范围：`plugins/web-creator/skills/web/`。

- 内置完整视觉主题：**0 套**。
- 项目 design.md 结构模板：**1 个**。
- 阶段参考文件：**6 个**，分别负责内容、设计、规范模板、开发、验收、资源入口；它们不是六种风格。
- 当前流程由 agent 提炼用途、受众、内容密度、图像需求、中文长度、主要操作等条件，浏览约三个候选，选一个主要方向及最多两个局部参考，随后写项目 design.md。
- 资源入口目前包含 Refero、freeDesignMD、VoltAgent、Land-book、Lapa、Awwwards、Curated 等；没有内置 StyleKit 数据或 UI UX Pro Max 搜索程序。现有逻辑是提示词指导的场景推断和检索，不是固定行业映射算法。

## 三个来源怎样用

| 来源 | 核实的内容 | 适合承担的部分 |
| --- | --- | --- |
| [StyleKit 风格目录](https://www.stylekit.top/zh/styles) | 官方目录显示 148 个结果，提供场景筛选、预览、配色与实现规则 | 找方向、看真实效果，再取得选中风格的具体数值 |
| [VoltAgent 原始集合](https://github.com/VoltAgent/awesome-design-md) | 社区分析网站的 DESIGN.md；当前 README 有些入口跳转到 getdesign.md，不能把所有条目都当作无需条件的本地文件 | 借鉴规范的写法与视觉组织，不等于原品牌官方规范 |
| [UI UX Pro Max 原始仓库](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/README.md) | 当日 README 标明 79 个可检索风格，其中 50 个为默认推荐；提供产品、布局、颜色、字体的匹配与 Markdown 输出 | 帮助缩小候选范围，提供可用性检查；结果还要按真实内容和中文排版调整 |

StyleKit 的 [HTTP API 文档](https://github.com/AnxForever/stylekit/blob/main/docs/API.md) 支持按 slug 读取风格、tokens、组件配方。其 [MCP 文档](https://github.com/AnxForever/stylekit/blob/main/packages/mcp/README.md) 提供搜索、取得规范、组件配方及规则检查工具。可按需读取一至两个候选，不需要向模型塞入整个目录。

UI UX Pro Max 可以用 `search.py ... --design-system -f markdown` 生成候选规范，也支持按 style、typography、ux、stack 分别搜索。若以后接入，外部输出仍须整理进当前项目的 design.md，避免再建立一套相互冲突的项目规范。[命令与输出说明](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/README.md)

## workflow 和 design.md 各自负责什么

workflow 决定先做什么、搜什么、为何采用或放弃某个方向、怎样验收；design.md 保存最终采用的具体约定。用户截图的九个章节适合成为 design.md 的固定检查范围：氛围、颜色角色、排版、组件状态、布局、层次、可行与禁忌、响应式、实施提示。

再保留当前已有的内容事实、技术命令、服务端口和实际验证结果。九个章节是规范的完整性要求，不是要求每个网页套用同一审美。颜色要写用途和数值，组件要写状态，手机规则要写实际重排方案。

## 建议的实现边界

建议采用**固定规范范围、少量自编方向、按场景检索和生成**：

1. 固定内容真实性、键盘操作、响应式、主要功能验收，以及上述 design.md 范围。
2. 先自编六个基础方向：内容阅读、资料比较、轻量工具、作品展示、活动介绍、自然生活。每个方向只写适用条件、布局/文字/媒体侧重点和避免事项，不复制六套品牌皮肤。这是调研建议；本轮落实情况见文末。
3. agent 根据用户内容选方向；用户指定风格优先。内容不足时使用明确标注的示例，不为视觉效果杜撰事实。
4. 需要更具体参考时，再搜索 StyleKit 或公开页面。一个主方向统一字体、圆角、颜色和间距，局部参考只解决具体组件问题。
5. 将参考改写成该项目的实际 design.md，编码时读取，浏览器检查后同步修正。
6. 外部规则与项目要求冲突时明确调整。比如 [StyleKit Editorial](https://www.stylekit.top/zh/styles/editorial) 的规则禁止渐变、彩色强调、大圆角，不能把这些禁令带入用户已经指定渐变圆形图标的 i-bot 标签栏。

单独的 i-bot 工作区标签栏使用宿主项目的设计 tokens。生成网页的设计系统负责 iframe 中的页面；它不改变宿主标签栏的颜色和形状。

## 取用和分发

[StyleKit](https://github.com/AnxForever/stylekit/blob/main/LICENSE)、[VoltAgent](https://github.com/VoltAgent/awesome-design-md/blob/main/LICENSE)、[UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/LICENSE) 的仓库均标明 MIT。若实际分发其正文或实质部分，保留对应版权与许可。记录来源、取得日期、版本或 commit，以及采用部分；品牌标识、照片、专用字体另行核实。当前插件没有整库打包上述内容。

## 本轮落实

插件 1.0.3 已新增六个自编场景方向与图像指导，目前有八份阶段参考文件；没有内置完整视觉主题或外部风格数据，也没有安装 UI UX Pro Max 运行器。design.md 模板已落实九项范围，并保留内容事实、图片、技术和验证。宿主圆形标签和浅色状态独立实现。AiProxy 接口实际返回 PNG，generate_web_image 已接入主动 /web 工具，鉴权仅在 API 服务端。
