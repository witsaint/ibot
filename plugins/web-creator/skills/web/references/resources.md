# 设计资源与指导来源

StyleKit 已接入只读检索与所选风格工具；其他来源是搜索入口，是否可访问取决于当前浏览器与账号，也不是允许完整复制网站的授权。资源可变，使用时核对页面与许可；不需要遍历所有来源。

## 规范与创意参考

| 来源 | 用途 | 使用方式与限制 |
| --- | --- | --- |
| https://www.stylekit.top/zh/styles | 风格目录、tokens、组件配方 | 先看候选预览，再按需读取所选风格；公开 API 见 https://github.com/AnxForever/stylekit/blob/main/docs/API.md 。不全量注入风格正文，不把外部禁令套到宿主。 |
| https://refero.design/ | Styles、实际界面与流程 | 营销网页找 Styles；内部产品界面找 screens/flows。若工具清单实际包含 refero_search_styles，用 3–5 个检索角度搜索，再用 refero_get_style 取得少量候选规范；否则浏览公开页面。可能需要账号。 |
| https://freedesignmd.com/ | 可获取的社区 DESIGN.md | 查看预览，再按当前中文内容调整规范；布局另见 /patterns。逐项核对下载与许可。 |
| https://github.com/VoltAgent/awesome-design-md | 社区设计规范集合 | 是社区整理，不能称作原网站官方设计系统。 |
| https://land-book.com/ | 落地页与区块灵感 | 按用途、行业、风格寻找具体页面；部分筛选收费。 |
| https://www.lapa.ninja/ | 落地页布局 | 查看全页节奏，避免仅照搬首屏。 |
| https://www.awwwards.com/ | 视觉与交互创意 | 展示性强；评估手机、性能和阅读成本。 |
| https://www.curated.design/ | 精选网页 | 用作视觉方向，不直接复制品牌与素材。 |

## 取用的方法

- https://github.com/anthropics/skills/tree/main/skills/frontend-design ：场景驱动的视觉方向、真实内容、完整实现。
- https://github.com/Leonxlnx/taste-skill ：落地页和作品集的审美判断；不强制用于后台工具界面。
- https://github.com/pbakaus/impeccable ：shape 的目的/受众/结果分析，clarify 的操作与状态文案，polish/typeset/harden 的针对性检查；不采用强制确认后停止的流程。
- https://github.com/coreyhaines31/marketingskills ：按需要取 product-marketing-context、copywriting、copy-editing、page-cro 的内容思考；个人报告和工具不套用完整销售页面。
- https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines ：可用性与界面检查。
- https://github.com/referodesign/refero_skill ：参考检索步骤及工具说明；未安装 MCP 时不得伪造调用。

本插件的说明是针对 i-bot 自行编写的流程摘要，没有打包上游技能正文、收费规范或品牌素材。以后分发上游文件前逐一核对许可证和版本。

- https://github.com/nextlevelbuilder/ui-ux-pro-max-skill ：产品、风格、颜色、字体与可用性匹配。当前未安装其搜索程序；仅作为参考来源，不伪造运行结果。以后按需接入时输出仍要整理为项目自己的 design.md。
