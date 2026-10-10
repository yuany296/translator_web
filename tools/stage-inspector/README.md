# 阶段检视台（Stage Inspector）

把一页漫画从**检测**到**送去翻译的载荷**的每个阶段摊在同一个页面上，逐层开关、逐条看结局与原因，
并能现场改参数看结果怎么变 —— 目的是「看完再提改动建议」，而不是在插件里显示中间结果。

## 启动

1. 先起本地 OCR 服务：项目根目录双击 `start_local_ocr_gpu.bat`。
2. 双击本目录的 `run_stage_inspector.bat`（= `node tools/stage-inspector/serve.mjs` 然后打开
   <http://127.0.0.1:8099/stage-inspector/>）。
3. 起过一次之后，`http://127.0.0.1:8099/` 就是**工具索引页**，三个调试页面都在那里。

命令行等价写法：

```powershell
node tools/stage-inspector/serve.mjs                 # 默认 :8099，服务 http://127.0.0.1:8765
node tools/stage-inspector/serve.mjs --port 8100 --service http://127.0.0.1:8765
```

## 为什么要有一个服务器（而不是双击 HTML）

本地 OCR 服务的 CORS 白名单只允许扩展来源（`EXTENSION_ORIGIN_PATTERN = ^chrome-extension://[a-p]{32}$`）。
浏览器实测：从 `file://`（`Origin: null`）或从 `http://127.0.0.1:8099` **直接** `fetch`
`http://127.0.0.1:8765/health` 都是 `TypeError: Failed to fetch`。所以这里的做法是**同源反代**：
页面只跟本服务器说话，服务器再转发到 OCR 服务。

**没有**去放宽服务端白名单 —— `Origin: null` 必须继续挡着，否则任意网页里的 sandbox iframe
都能读你本地的术语库与译文库。

顺带把既有的 `tools/ocr-debug-tool/index.html` 也救回来了：把它的 `serviceUrl` 填成
`http://127.0.0.1:8099` 即可（它请求的 `/ocr` 会被同一个反代接住）。

## 阶段与图层

| 图层 | 数据来源 | 含义 |
| --- | --- | --- |
| ① 全部检测 | 服务 `rawItems` | 检测到的一切文字框（含噪声） |
| ② 识别下限丢弃 | `score < 下限` | 低于识别硬下限（默认 0.4）的一律不进结果 |
| ③ 到达结果筛选 | 服务 `items` | 扩展侧真正拿到的一批 |
| ④ 结果筛选丢弃 | **真代码** `keepOrTraceOcrWord` | 低分例外、面积、宽高比、乱码等拒因 |
| ⑤ ルビ丢弃 | **真代码** `filterRubyAnnotationWords` | 判定为振り仮名注音，连同它的宿主汉字列一起给出 |
| ⑥ 合并后的文本块 | **真代码** `buildLocalPaddleBubbleItems` | 同一气泡的多列按「自右向左、列内自上而下」拼成一句 |
| ⑦ 服务端区域 | 服务 `regions` | `speech_bubble` + 底色 = 实底（纯色遮，不走清理图） |

选中任一**检测**框时，右侧会显示服务端真正送进识别器的那张裁剪图
（`.local-data/debug/slice_crops/slice-<stem>-<检测序号>.png`）—— 判断「为什么这条分数低/认错」看的就是它。

## 两个数据入口

- **拖入新图片**：跑一次真 OCR（服务端检测+识别），然后做阶段回放。会写 `debug` 产物。
- **线上快照**：`GET /api/snapshots` 列出 `.local-data/debug/plugin_input/*.png` 里**线上真实跑过**的页
  （配套 `result_json` 一起读）。选它即可回放，不重跑 OCR、不额外花钱。

## 参数面板

「只重跑阶段（不重跑 OCR）」把 `confidenceThreshold / minBoxArea / maxBoxArea / minBoxWidth /
minBoxHeight / maxAspectRatio / mergeLineGap` 交给**真代码**重算，所以看到的就是线上会发生的效果。
实测（`tmp-cmoa/page139.png`，71 条检测）：阈值 0.72 → 结果筛选丢 16 / ルビ 4 / 合并 17 块；
0.60 → 丢 11 / ルビ 6 / 19 块；0.90 → 丢 19 / ルビ 2 / 16 块。

## 一次性静态报告（可离线分享）

```powershell
node tools/stage-inspector/stage-core.mjs --ocr tmp-cmoa/page139.ocr.json `
     --image tmp-cmoa/page139.png --out tmp-cmoa/stage-report.html
```

`--ocr` 那份 JSON 是本地 OCR 服务的**完整**返回（`tmp-cmoa/run_page_ocr.py` 就是干这个的）。

## 接口（`serve.mjs`，只监听 127.0.0.1）

| 路径 | 说明 |
| --- | --- |
| `GET /` | 工具索引页 |
| `GET /api/meta` | 服务状态 + bundle（`dist/test/background.iife.js`）mtime 与几何版本 |
| `POST /api/ocr` | 同源调 OCR，自动带 `debug:true` + `debug_id`（响应头 `x-debug-stem` 给出产物 stem） |
| `POST /api/stages` | `{payload, tuning}` → 只重跑阶段回放 |
| `GET /api/snapshots` `/api/snapshot?stem=` | 线上快照清单 / 读取 |
| `GET /api/artifacts?stem=` `/api/artifact?rel=` | 产物清单 / 读取（白名单根 = `.local-data/debug/`） |
| `/ocr` `/health` `/ocr/timings` `/debug-background` | 纯反代（给既有调试页面直接用） |

## 两个「位置」的陷阱（改这个页面时必读）

1. **画框的坐标系**：多边形的坐标是**源图像素**（如 979×1324），所以 `<svg>` 必须显式设
   `viewBox="0 0 979 1324"`（+ `preserveAspectRatio="none"`）。少写 viewBox 时 SVG 的用户单位是元素自身的
   CSS 像素，框会按「显示宽度 ÷ 源宽度」的比例系统性偏移 —— 越往右下漂得越多（实测右下角差约 100px），
   症状就是「框框的位置有问题」。`index.html#applyStages` 里设置，`stage-core.mjs` 生成的静态报告同样有。
2. **合并块的 `box` 是屏幕轴，不是原始 `location`**：竖排合并块的 `location/rawBox` 是**文字轴**几何
   （宽高与屏幕正好互换：一个两列气泡 rawBox=137×61，屏幕上的四边形是 58×132）。`stage-core.mjs` 已经把
   `box` 归一成多边形的屏幕轴包围盒，原始值放在 `textAxisBox`；表格「位置」与「最近邻放大」都用屏幕轴那一份。

## 已知近似（页面右下角也写着）

阶段回放在 Node 里跑，没有 `createImageBitmap`/`OffscreenCanvas`，`analyzeLocalOcrImage` 返回 null：
**扩展侧兜底取色**（`applySampledBubbleColors`）与**吃像素的聚类判据**不生效。
块的**边界**可能与线上略有差别；块的**文本**、丢弃原因、ルビ判定与线上是同一份代码。
每次回放都会在页头显示所用 bundle 的 mtime 与几何版本，改了扩展源码先 `npm run build` 再刷新。
