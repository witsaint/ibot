# 网页图片与 tab 图标

当前工具包含 generate_web_image 时，可通过 AiProxy GPT Image 2 为本项目生成 PNG。接口为 POST https://apiproxy.paigod.work/v3/gpt-image-2-text-to-image；鉴权由平台处理。不要从 sandbox 搜索平台密钥，也不要把密钥放到网页或文档。

## tab 图标

- 已有合适的用户或项目图标优先复用；没有时根据主题生成一个图标。每个项目默认一次，失败后使用字母/汉字与 CSS 圆形兜底，不反复生成。
- 只表达一个对象或象征：例如徒步用山与路径、阅读用一本书。两三个大形状，24–32px 下仍清楚。
- 正方形构图，主要形状居中，四周约 18% 安全留白。宿主会圆形裁切，四角不要放重要信息。
- 无文字、无微小细节、无水印、无画中边框，不生成与真实品牌混淆的标识。
- 配色与项目主题协调，同时在浅色和深色宿主中可辨认。背景使用干净纯色或柔和色；当前已验证 opaque，不声称 API 支持透明输出。
- 调用 generate_web_image：purpose=icon、projectDir=实际目录、prompt=完整主题说明，默认 low、1024x1024。工具返回 assetPath 和 filePath 后，检查输出再调用 preview_web，iconPath=assetPath。不要伪造路径。
- 输出图标默认复用，更新同一网页不要每次换图标或换兜底颜色。图标加载失败时宿主自动显示兜底。

示例提示词：
> Tiny website tab icon for a weekend hiking guide. One bold pine-green mountain and a mint winding path, centered on a soft ivory background. Minimal graphic with two broad shapes, strong silhouette readable at 24 pixels, square composition, 18 percent safe padding for circular crop. No text, letters, watermark, border, or fine detail.

## 网页中的其他图片

generate_web_image 也支持 purpose=image、横图/竖图与质量设置。根据真实位置决定构图、留白、主题和尺寸。尽早确认图片是否真的增加信息，不为每个区块都生成装饰图。

生成图片只是视觉素材，不能作为真实活动照片、真实产品证据或客户背书。将可授权来源和生成用途写入 design.md。页面直接引用项目 /assets/ 路径，不能使用会过期的上游下载链接。

## 运行与保存

服务端密钥不会传给模型或 sandbox。平台下载 PNG 后写到该项目的 public/assets；配置对象存储时另存到 bot 所属路径，消息中只保存文件和对象引用。项目没有对象存储时素材随 sandbox 生命周期保留。当前没有自动备份后恢复整站的功能。

接口超时、鉴权失败、下载/保存失败时保留可用页面，说明图片未完成，不捏造生图成功。保持页面兜底和预览，不让图标阻挡交付。
