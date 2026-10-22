# Operations Log

## 2026-10-16（续 2）—— 「盖板还是透明的」的最后一截：实底判定与采样色分属不同载体，渲染前没人把颜色找回来

- **现场**：同一条跨页气泡（`.mt-cross-page-text` + `.mt-cover-segment`）盖板仍整块透明。
  chrome-devtools 直连 + 直接读扩展持久缓存（复制 profile 的 leveldb、用 classic-level 解析）实锤：
  接缝观测是 `bgType=solid, bgColor=""`，且这条缓存被写过 4 次（23:56、00:25:10 旧构建；00:25:35 新构建）
  **内容逐字节相同** —— 不是缓存过期、也不是「没重载扩展」；前两轮「第一份有效色」修复（配对 / 区域组）没覆盖这一例。
- **根因**：跨页观测由「接缝配对 / 区域组合并」合成，`bg_type` 与 `bg_color` 来自不同载体 —— 颜色一旦在合成时落空，
  候选就带着「声明实底但没有颜色」的矛盾状态走到渲染；渲染侧按既定口径「没有采样色就透明（不兜底纯白）」→ 整块透明。
  而**颜色其实就在同一 canonical 的证据组里**：同一气泡的两条页面观测是 `#fbffff` / `#f3fbfd`，
  只是没有一处按「组内第一份有效色」把它找回来。
- **修复**（三处同口径 + 对已有缓存立即生效）：
  - 新增 `extension/src/shared/solid-color.js`：采样色判据唯一定义（`#rgb`/`#rrggbb` 归一；
    `firstSolidColor` 取第一份有效色；`solidObservationColor` 只认自己声明实底的观测，复杂背景兜底色不借）。
  - `canonical/modules/projection-utils.js#buildSeamSurfaceBubble`：实底观测自身颜色无效时，从同一 canonical 的
    其它实底观测借第一份有效色；**不改 `bg_type`**（不动清理图要求，避免整层等图）；都找不到才留空。
    canonical 每次渲染都重建 → 不需要清缓存 / 重跑 OCR。
  - `background/modules/seam-handling.js#buildSeamCrossPairCandidate`、`translation-coalesce.js#groupColor`
    改走同一判据（顺带接受 `#rgb` 与 `bgColor` 别名），收窄「solid 无颜色」的再产出。
- **回归**：新增 `tests/seam_solid_color_fallback.test.mjs`（5 例：借色正例 / 自身优先并归一 / 全组无色留空 /
  非实底兄弟不借 / 非实底接缝直通）；`seam_cross_pair_color`、`ocr_merge_group_color` 各加一例 `#rgb` 归一。
- **验证**：`npm run verify` 全绿（行数门禁 / ESLint / Pylint / 构建 / Node / Python 188 passed + 1 skipped）；
  真机缓存回放（真实 seam/page 观测 JSON 直接调构建器）→ `bg_color: #fbffff`；
  真机复核：刷新漫画页（内容脚本改动，无需重载扩展）→ 遮罩段计算色 `rgb(243,251,253)`，用户确认「它好了」。
- **文档**：CLAUDE.md / AGENTS.md 的实底遮罩条追加「颜色以 canonical 为组取证」一条口径。

## 2026-10-16（续）—— 「盖板还是透明的」：合并候选只取第一行的背景色

- **现场**：用户在同一页仍看到一块**透明**的跨页盖板（`.mt-cover-segment` 有节点、位置正确、
  `data-cover-tilted="false"`，但 `background`/`background-image` 都是空的）。该气泡的
  `--mt-adaptive-bg` 与 `--mt-region-clip` **都是空的** —— 颜色与多边形一起丢了，指向"合并/配对候选"。
- **根因 A（本次修）**：`background/modules/translation-coalesce.js#mergeOcrCandidateGroup` 的背景色
  只取 `sorted[0].bg_color`；文字色/描边色早在同一个函数里就是「整组找第一份有效值」。`sorted[0]` 只是
  视觉第一行，它的容器未必采到色 → 区域组（含接缝的区域组合并）产出 `bg_type=solid` + `bg_color=""`
  → 渲染侧「没有采样色就透明、也不兜底纯白」→ 整块透明。
- **根因 B（同日已修）**：接缝**跨页配对**（`seam-handling.js#buildSeamCrossPairCandidate`）同样要求
  两半颜色逐字符相同。用户气泡的 `--mt-region-clip` 为空（配对候选把 `polygon`/`region_polygon` 都置空），
  说明这一例走的就是配对路径。
- **修复**：`bg_color: groupColor("bg_color")`（与文字色/描边色同口径）。
- **回归**：`tests/ocr_merge_group_color.test.mjs`（新，3 例：整组第一份有效值、全空仍留空、
  非实底组同样保留）。**负向验证**：`translation-coalesce.js` 临时回旧版 → 2/3 失败；换回修复版 3/3 通过。
- **待用户操作**（两处都在 **background**，一次即可）：`chrome://extensions` 点「重新加载」→ 刷新漫画页。
  内容脚本那半边（裁剪顶点、截图显隐、并发交错）刷新页面即生效。

## 2026-10-16 —— 「还是没有」的第三处：并发截图把扩展节点永久停在 visibility:hidden

- **现场**（用户同一张 KakaoPage 标签页，chrome-devtools 只读取证）：跨页气泡的盖板这次**在 DOM 里、
  白底、位置正确**，但 `style="...; visibility: hidden"`；进一步统计：整页 **64 个
  `[data-manga-translator-overlay]` 节点里 62 个 `hidden`**（含 `.mt-cover-segment`、`.mt-overlay-root`、
  跨页文本层），而 `.mt-overlay-layer` 本身是 visible。
- **根因**：`content/modules/capture-payload.js#withOverlayLayerHidden` 截图前把**所有**
  `[data-manga-translator-overlay]` 节点隐藏（免得自己的覆盖层被截进 OCR 图），截完照**自己的快照**还原。
  这个阅读器页级 OCR 与接缝 OCR 的截图会**并发**：A 先隐藏 → B 进来时快照到的是 `"hidden"`（A 设的）→
  B 结束得更晚，把 `"hidden"` 写回去 → 节点永久隐藏。遮罩段/覆盖层 root 都是**复用节点**，
  之后每次渲染只改 left/top/宽高/背景/clip-path，`visibility` 没人再碰 —— 于是"盖板明明在那儿就是看不见"。
  （同一个 `overlayHideDepth` 计数保护的是**图层**，覆盖层节点的显隐没有对应保护。）
- **修复**：`state.captureHideDepth` 计数，**只有最外层**截图留快照、隐藏、还原；内层原样透传。
  图层那半边仍走原来的 `overlayHideDepth`（行为不变）。
- **回归**：`tests/capture_overlay_hide_nesting.test.mjs`（新，2 例：并发交错结束时必须回到可见、
  内层不得改写外层快照）。**负向验证**：把 `capture-payload.js` 临时回到旧版跑该用例 —— 2/2 失败；
  换回修复版 2/2 通过。
- **验证**：`npm run verify` 全绿（行数门禁 / ESLint / Pylint / 构建 / Node 1705 / Python 188 passed + 1 skipped）。
- **待用户操作**：这是**内容脚本**的修复 —— 刷新漫画页即可（不必重载扩展）；那张已经卡住的老页面
  刷新后会重建全部节点。上一条的接缝采样色在 **background**，仍需要「重新加载扩展」一次。

## 2026-10-15 —— 跨页气泡「没有盖板」两处连修：裁剪顶点被截断 + 接缝采样色要求逐字符相同

- **现场**（KakaoPage「괴담에 떨어져도 출근을 해야 하는구나」29 話，ocronly 模式；用户两张截图 +
  另一个「여기 마스코트, 정의의 화신처럼 구니까 조심해라.」）：跨页气泡的白色盖板整块不见了，
  韩文原文露在译文下面。chrome-devtools 直连取证（新标签页复现）：
  - 气泡 A（`일단바닥에 늙히시는게`）：`.mt-cover-segment` 在 DOM 里、白色背景、`data-cover-tilted="true"`，
    但 `clip-path` 是贴左边的一条楔形 —— 实测**交集 0.87、画出来只有 0.14**。
  - 气泡 B（`여기 마스코트…`）：两个遮罩段的 `background` 与 `background-image` **都是空的**，
    文字节点的 `--mt-adaptive-bg` 也是空的 → 整块透明。
- **根因 1（裁剪顶点被截断）**：`clipConvexPolygonToRect`（Sutherland–Hodgman）的输出是**多边形**
  （四边形与矩形求交最多 8 个顶点），而 `polygonClipPathPercent` 走 `normalizePoints` → `slice(0, 4)`：
  不相邻的顶点被连成一条**根本不存在的边**，`clip-path: polygon(...)` 于是画出一个楔形/八字形。
  这里最容易骗人的是：为了反解"到底是多边形错还是映射错"，用生产模块做了数值拟合，
  拟合出的四边形有一条 56° 的"不可能存在的边" —— 正是顶点被跳连的症状。
- **根因 2（接缝两半的采样色要求逐字符相同）**：`seam-handling.js#buildSeamCrossPairCandidate`
  只在 `upper.bg_color === lower.bg_color` 时保留颜色；而两半各自在原图上采样，同一个白气泡实测就是
  `#f6fbfe` vs `#f4fcfe`（差 1~2 级）→ `bg_type=solid` 却 `bg_color=""`。渲染侧按既定规则
  「没有采样色就保持透明（不兜底纯白）」→ 透明的盖板；而 `requiresCleanedImage` 只看
  `bg_type === "none"`，**solid 永远不会去要清理图** —— 所以这条链路上没有清理图可用，不是漏画。
- **修复 1**（`rendering/cover-geometry.js#polygonClipPathPercent`）：原样保留全部顶点（顶点沿边界连续，
  `clip-path: polygon()` 直接可用）；`renderer-cover.js` 的四边形路径（恒 4 点）行为不变。
- **修复 2**（`background/modules/seam-handling.js#buildSeamCrossPairCandidate`）：两半都是实底时取
  **第一份合法的 `#rrggbb`**（与页面级 `translation-coalesce` 的「第一份有效颜色」同口径），
  只有两半都没有才留空。留空仍是透明（不兜底纯白），规则不变。
- **为什么不顺手给 solid-无颜色补清理图**：那要同时改「索要清理图」的判定（`requiresCleanedImage`、
  `seamBubbleRequiresCleanedImage`、清理掩膜计划），而 seam surface 的渲染门槛是"要不要清理图"——
  扩成 solid-无颜色会让**整块跨页覆盖层（含译文）等图**，图产不出来时译文也一起不显示。
  两处根因修掉后这条支路已很难走到，先不动（待用户定）。
- **回归**：`tests/seam_cover_clip_vertices.test.mjs`（新，2 例：现场四边形必须画出 7 个顶点、覆盖率 > 0.8；
  真斜排仍裁剪）、`tests/seam_cross_pair_color.test.mjs`（新，3 例：差 1~2 级要保留、只一半有颜色时用另一半、
  两半都不是实底不借颜色）。`tests/cross_page_overlay_dom.test.mjs` 保持 8 例不动。
- **验证**：`npm run verify` 全绿（行数门禁 / ESLint / Pylint / 构建 / Node 1703 / Python 188 passed + 1 skipped）。
  真机复核（新标签页，无需重载扩展即吃到新构建，因为改的是内容脚本）：气泡 A 的遮罩段
  `data-cover-tilted="true"` + **7 个顶点 / 覆盖率 0.991**（修复前 4 个顶点 / 0.14）。
- **待用户操作**：修复 2 在 **background**（service worker）里，需要 `chrome://extensions` 点
  「重新加载」再刷新漫画页，那条「여기 마스코트…」才会变成实底白盖板。

## 2026-10-14（续4）—— 原文语言删除「自动识别」选项 + 不可翻译文本直通

- **「自动识别」选项下线**（用户定版：与其做不准的多语言自动检测，不如显式选择）：
  设置页与 quick-popup 的原文语言下拉删除 `auto`，语义保持**完全统一**——设置继续治理所有模式
  （漫画 OCR 选模型、翻译申报源语言、译文库/术语库按语言对匹配），读什么语言切什么设置。
  `auto` 降级为内部哨兵值（`SOURCE_LANGUAGES` 仍含、文本判定与缺配置兜底仍在用），
  存储边界唯一迁移点在 `config/schema.js#normalizeTranslationConfig`：归一化结果为 auto 的
  存档值改写为 `languages.DEFAULT_SOURCE_LANGUAGE`（用户选了 `en`）。翻译侧判定代码零改动。
  效果：漫画 OCR 永远单模型直跑（不再日韩双跑），日文站 manga-ocr 引擎直接生效。
- **不可翻译文本直通**：新增 `shared/non-translatable.js`（保守判定：纯数字/时钟/日期/URL/邮箱/
  纯符号含 emoji/单字母/字母数字编码；含任何 CJK/假名/谚文一律可翻译；带空格的 Level 5、
  Chapter 12 保留）。接入点唯一：`ocr-pipeline.js#handleTranslateTextBlocks` 归一化 items 时标记
  `non_translate`，直通分支（`translated_text = 原文`、passthrough 指纹）是既有行为——漫画/小说/
  网页三条链路同一入口生效，页码与水印气泡不再烧 API。不加设置开关。
- 顺带：`ocr-pipeline.js` 已顶 400 行门禁，把一个多行 `timing` 块合并成单行抵消新增 import。
- 文档：CLAUDE.md / AGENTS.md Key Contracts 新增两条契约（无 auto 选项、不可翻译直通）。
- 验证：`npm run verify` 全绿。

## 2026-10-14（续3）—— 关闭参数修改途径：OCR 调参入口下线 + 旧 popup 死代码删除

- **设置页 OCR 调参入口移除**（只关 UI，存储值与默认值原样保留）：「OCR 服务」卡删掉
  检测参数三件套（detThresh / detBoxThresh / detUnclipRatio）；「结果筛选」卡整卡删除
  （confidenceThreshold、minBoxArea、maxBoxArea、mergeLineGap、minBoxWidth、
  minBoxHeight、maxAspectRatio、novelImageMergeLines）。`settings/controller.js` 的
  `fill()` 不再回填这些字段，`collectOcr()` 里 `tuning` 改为整块透传存储值
  （`{ ...configuration.ocr.tuning }`）、localPaddle 只留 baseUrl/mode/debug/recEngine；
  归一化仍在 `schema.js` 兜底。值不变则 OCR 缓存键不变，无缓存影响。
- **旧 popup 死代码删除**：manifest 早已指向 quick-popup（popup.html 只剩 meta-refresh
  重定向，不可达）。删除 `public/popup.html` 与 `src/popup/`（index.js + controller.js）；
  同步：`build-extension.mjs` 构建入口数组、`check-file-lengths.mjs` entrypoints、
  `check-extension-dist.mjs` 产物名单、`build-novel-mobile.mjs` 剔除名单（手机版不再需要）、
  两个测试断言（`kakao_pipeline.part01` 构建入口数组改为钉「popup 不在名单」的存在性，
  `settings_ui` 的 meta-refresh 断言改为钉 popup.html 必须保持删除）。
- **文档**：CLAUDE.md / AGENTS.md 域目录清单 17→16、public 资源与模块表去掉 popup。
- 验证：`npm run verify` 全绿。

## 2026-10-14（续2）—— 气泡译文「一行只剩一个字」：DOM 路径不再人工预分行，交给浏览器 balance

- **现场**（用户截图，就是上一条那个跨页气泡）：译文被拆成 `听说新沙洞的奥 / 利弗要是那边组 / 织 /
  的人,你打算怎么 / 收场才那么干的?` —— 第三行只有「织」。
- **根因**：DOM 路径按**原文字数**预分行（`createBubbleNode` → `formatTranslationForOriginalLines`，
  该气泡 source_line_count=4 → 7/8/8/8 字），而字号拟合的探针按「软换行后的总行数」测高（5 行
  149px ≤ 158px 就算通过），并不保证每个预分行都能放下。于是那一个多出 1 字的预分行（`利弗要是那边组织`
  8 字）被浏览器再拆一次 → 7+1，孤字「织」。fb 实测：24.7px、内容宽 194px、8 个 CJK = 197.6px > 194px。
- **修法**：DOM 覆盖层**不预分行**（`contentNode.textContent = displayText`，双语 `\n` 保留），
  换行交给浏览器 + `.mt-bubble-content { text-wrap: balance }`。实测同一文本：预分行 `[173,173,25,181,186]`
  （孤字）→ 软换行 greedy `[173,173,181,173,37]`（末行 2 字）→ **balance `[148,148,156,148,136]`**
  （5 行均匀）。Chromium 的 balance 只在 ≤6 行生效（实测 6 行均衡、7 行起回退贪心），`vertical-rl`
  竖排下实测无副作用（4 列均 213/213/210/213，与不设时一致）。
- `formatTranslationForOriginalLines` 保留给**画布渲染器**（`renderer-embed`）：canvas 没有 CSS 换行，
  必须显式给固定行数；`content_runtime` 的两条 DP 单测继续钉它。
- 测试更新：`bubble_text_layer`（内层 textContent 不再含人工 `\n`）、`overlay_style`（新增
  `text-wrap: balance` 与「不得再预分行」两条断言）。现场复核（干净重载 + 滚动到接缝）：5 行均匀、
  遮罩完整盖住原文（上一条的裁剪修复同时生效：两个 cover 段 `coverTilted=false`、无 `clip-path`、
  下页段恢复 145px）。
- 验证：`npm run verify` 全绿（行数门禁 / ESLint / Pylint / 构建 / Node 1692 / Python 188 passed + 1 skipped）。

## 2026-10-14（续）—— 跨页遮罩被判成「斜排」裁到只剩顶部 ~18%：倾角必须在像素空间量

- **现场**（接上一条的「顺带记录」，Lezhin 53 話）：canonical `canonical_4bd45cfca82a19bde529e73ac92a6a35`
  （`…:seam`）的下页 `.mt-cover-segment` 只剩顶部 17.8~18.2%，下页 4 行原文只遮住第一行。触发链：
  `data-cover-tilted="true"` + 气泡 `data-rotation-deg=89.9656`（竖排语义 → `rotationTilted` 为假），
  所以裁剪只可能来自 `polygonTilted`。
- **取证**（chrome-devtools 直连 + 隔离世界读 canonical store）：该 canonical 的选中断言是该接缝观测，
  polygon 顶点在**拼接图像素空间**是 (674.8,77)(955,76)(955.3,140)(675,141) —— 299.6×69.1 的文字框
  只在像素空间歪 **0.2°**（服务端 `rotationDeg=-0.2`，rawBox 299.6×69.1）。百分比空间里：最长边
  89.9656°（= 90 − 0.0344°，与 DOM 上 `data-rotation-deg` 逐位吻合），而横边倾角是 **1.36°**。
- **根因**：`polygonTiltDeg` 在 percent 空间量角度，而 1280×192 的两轴不等比（6.67×）把「横边的
  像素级微倾」放大 6.7 倍（竖边反向压缩）。0.2° → 1.36° 越过 `COVER_TILT_TOLERANCE_DEG=0.5` →
  气泡被当成斜排 SFX → 跨页遮罩按「接缝带里那一行」的四边形裁剪：下页遮罩段高 145px（页级 OCR
  读到 4 行 = 258 页像素），被裁到只剩顶部 ~26px。**同一形状在像素空间根本没歪**。
- **修法**：`polygonTiltDeg(points, scaleX=1, scaleY=1)` 先换算到同一物理空间再量（`polygonRotationDeg`
  的轴对齐门槛同步带上比例）；`resolveCoverQuad` / `resolveBubbleCoverGeometry(bubble, { scaleX, scaleY })`
  接受并透传；知道坐标空间长宽的调用方必须传：跨页 `buildCrossPageBubbleGeometry` 传
  `canvasWidth×canvasHeight`，嵌入式画布（`renderer-embed`）传 `canvasWidth/Height`，RenderScene
  （`scene-builder#cleanupGeometry`）传 `surface.width/height`。不传 = 旧口径（DOM 覆盖层路径没有
  长宽可传，保持原样）。真正的斜排 SFX（夹具 12°/20°/35°）带不带比例都仍判成斜排。
- **验证**：单测钉现场数值（不带长宽 1.36° / 带 1280×192 0.23°；`resolveCoverQuad` 不裁 + 12° 对照裁）；
  跨页端到端用例（真 `lifecycle-cover` + `scene-crosspage` + `crosspage-cover`，现场 surface：
  0.2° 时两个遮罩段都不设 `clip-path` 且下页段保持 145px，同一形状像素空间转 3° 的对照仍裁剪）。
  把 scene-crosspage 的 scale 传参临时去掉后新用例确实失败（负向验证）。`npm run test:node` 1692/1692、
  `check:lines`、`lint:js` 全绿；构建已更新 `dist/`。
- **待确认**：浏览器需重载扩展 + 刷新漫画页（旧页面内容脚本仍是旧构建）才能看到现场修复。
  复现物在 `%TEMP%\opencode\`（composite.jpg / pageA.jpg / pageB.jpg / seam-probe.mjs / cdp-run.mjs）。

## 2026-10-14 — 「응?」被识别成「$?」丢掉（韩文短台词）；跨页碎片吸收与图层可见性两修

- **「응?」不是没识别、也不是被过滤器误伤**：用 chrome-devtools 抽出该页原图（1007×1536，与扩展同参数）
  重跑本地 OCR —— 检测到了（box 549,741 65×67），但 `korean_PP-OCRv5_mobile_rec` 把它读成 `"$?"`
  （0.785），被服务端符号/噪声过滤丢掉；同页底部「응」气泡读成 `"\"` 0.944 / `"응f"` 0.479 也丢了
  （它最后显示「嗯」是**接缝链路**在页边界复合图上重读的）。客户端过滤器对谚文是放行的
  （`isReliableMeaningfulShortOcrText` 对 Hangul 直接 true），所以问题在识别器，不在筛子。
- **模型 A/B（同图同检测模型，只换识别模型）**：`응?` → v3-mobile **`"응?"` 0.718 ✅** / v5-mobile `"$?"` 0.785 ❌；
  `탐정님` → v3 0.996 / v5 0.906；`안 추워요?` → v5 0.941 ✅ / v3 0.875（측 误读）。两代各有胜负；
  `PP-OCRv5_server_rec` 换不了韩文（其字符表只有 2 个 Hangul 字符，实测 `inference.yml`）。
  服务里已有 `LOCAL_OCR_KOREAN_V3_FALLBACK`（binary_text_2x 变体走 v3），但只在变体恢复里跑且要求 ≥0.88。
- **已完成（服务侧，v12）**：pipeline/degenerate_rescue.py —— 识别结果退化成符号/无意义文本（空/纯符号/
  低于识别下限，与最终筛同一口径）时，换该语言的备用模型对**同一 crop** 重试一次，只有「实打实该语言文字 +
  过识别下限」才替换（LOCAL_OCR_DEGENERATE_RESCUE=off 可关，counts.degenerate_rescued 可观测）。
  真图实测（同一张 Lezhin 页 1007×1536）：degenerate_rescued=1，「응?」→ 응? 0.711 进 items、
  底部「응」→ 0.671 进 items（此前两者都被丢）；안 추워요? 仍是 v5 的 0.939，未被替换 ✓。
  返回 items 变了 → **代次 v11 → v12**（dependencies.py + config/versions.js 两侧同步；
  `test_ocr_debug_part01.py` / `background_runtime.part06.test.mjs` 的字面量与 CLAUDE/AGENTS 文档同步更新）。
  测试：Python 188 passed（新增 `tests/test_degenerate_rescue.py` 6 例）/ Node 1685 passed / pylint 10.00。
- **轻量硬化（用户报告"loading 不停闪烁"）**：根因是**永久性服务故障被当成临时错误无限重试** ——
  扩展升到 v12、服务仍是 v11（没重启）→ 每个请求 409 `contract mismatch` → 恢复扫描（650ms 节流）
  与自动重试把失败当"再试一次就好"，0.5~1.5 秒一轮「入队→失败→清 loading→再入队」（实测 15 秒
  211 次 loading 卡增删，`mtLastTranslatedKey` 永远为空），且自动模式不弹错误 → 用户只见闪烁不见原因。
  修法：①`shared/ocr-service-fault.js` 唯一判据（`mismatch`/`offline`/`invalidated` 三类 + 可操作提示）；
  ②`content/modules/ocr-service-fault.js` 状态机：一次提示（悬浮球浮层）+ 停本页自动翻译 + 60 秒冷却；
  ③冷却期内 `queuePageAutoTranslate` / `scheduleAutoTranslateRetry` / `recoverRenderedTargets` 早退；
  ④OCR 成功一次即解除（不必刷新页面）；⑤`ocr-provider.js` 把服务端 `detail` 透出来（409 的说明
  以前被丢掉，只剩 "409 Conflict"）。回归测试 `tests/ocr_service_fault.test.mjs` 5 例（Node 1690 全绿）。
- **复核（用户重启服务 + 刷新后）**：服务 `/health` = v12 ✓；页面 8 秒内 **0** 次 loading 卡新增
  （闪烁前是 15 秒 211 次）；`응?` → **嗯?**、底部 `응` → 嗯 ✓（页级识别救援生效，不再靠接缝）；
  其余气泡（탐정님→侦探大人、안 추워요?→不冷吗?）不变 ✓。
- 本次新增文件：`shared/ocr-service-fault.js`、`content/modules/ocr-service-fault.js`、
  `pipeline/degenerate_rescue.py`、`tests/test_degenerate_rescue.py`、`tests/ocr_service_fault.test.mjs`
  （`content/modules` 与 `shared` 文件数各 +1；CLAUDE/AGENTS 的数量表是审计时点快照）。
- **修 1（跨页已合并气泡 vs 页级碎片，用户截图「真是没救了。」）**：同一气泡被翻了两遍 —— 跨页链路
  合成第 1~2 行，下页页级 OCR 把被页边界切掉的半行读成 `ᅥ|고그 없네.` 又单独翻一句。文本关系门槛对
  被切断的乱码永远过不了，故在 `seam-residuals.js#findSeamCoveredResidualCanonicals` 增加**残字通道**：
  贴页边（上下 4% 内）+ 残字证据（组合/兼容字母、�、混入符号且含 CJK/韩文）+ 几何几乎完全落在 winner
  框内（overlap ≥0.9）+ 面积 ≤ winner 0.85 → 按 fragment 吸收（不并入译文，只摘掉页级投影）。
  **刻意不按纯几何放开**：canonical_render_plan 的反例正是"贴页边的无关整块文本"（`외부`），
  干净字词仍走文本关系路径。回归测试 +1（含反例对照），1685/1685 全绿。
- **修 3（图层可见性死代码）**：`controls-ui#setOverlayLayerVisibility` 的 hide 分支是死代码
  （`else if (visible && depth === 0)` 永远不可达 → 「隐藏译文覆盖层」只涨 depth 不隐藏）；
  且 `overlayHideDepth > 0` 会挡住 `ensureExtensionUiMounted` 的可见性复位守卫 —— 与
  `withOverlayLayerHidden`（depth>0 进入时既不保存也不回滚）组合可造成**图层永久 hidden**：
  译文与 loading 卡整层不可见。修复：隐藏/显示做成成对操作并**逐图层**记住原值
  （`overlay-host.js#hideOverlayLayers / restoreOverlayLayers`，语义搬到这里、controls-ui 只调）；
  `ensureExtensionUiMounted` 改为逐层复位（不只主图层）。回归测试 +1。
- 行数门禁：controls-ui 一度 405 行，把两个纯图层操作（get/setOverlayLayerVisibility）搬到
  `overlay-host.js` 后回到限内。

## 2026-10-13 — 覆盖层宿主被解析进推荐位轮播：译文与 loading 框整层被裁掉（Lezhin 实测）

- 用户报（lezhin 韩漫阅读中）：译文突然全部消失 → 翻页不再出现译文 → 点悬浮球停/开也没用
  → 连 loading 框都不出现。现场由 chrome-devtools 直连取证（未刷新页面、未改代码先取证）：
- **事实一**：译文一切正常、只是看不见。`.mt-bubble-content` 里中文文本完整
  （「两人是老人，一人是外来务工的简单劳动者。」），坐标也对（截图位置与气泡重合）。
- **事实二**：两条 `.mt-overlay-layer` 中，承载正文译文的那条的宿主是推荐位轮播内部的
  `div.flex`，其父 `carousel__GXXM_` 是 `overflow:hidden` —— 整层被裁。把该 overflow
  临时改成 `visible`，译文立刻显示（前后截图对比），根因实锤。
- **根因**：`renderer-crosspage.js#findCommonAncestor` 只比较**前两个**目标的共同祖先
  （命中即返回），而调用方 `resolveOverlayHost` 传的是 `overlaysById` 的插入顺序 —— 一对
  「碰巧同属轮播小盒子」的推荐位缩略图就决定了**全体**覆盖层的宿主；正文页的 root 落在该
  宿主盒外，再被 `carousel` 裁掉。loading 卡走同一个 `ensureOverlayLayer()`，一起被裁，
  所以「连 loading 框都没有」。悬浮球/点击链路正常（toast 正常）也由此解释。
- **修复**：`findCommonAncestor` 改为对**全体**目标逐级求交（顺序无关，空集提前退出），
  宿主必然包含所有目标；`hostDoesNotClip` 的向上回退保持不变（裁剪祖先仍会被绕开）。
- **回归测试**：`tests/crosspage_overlay_host.test.mjs`（4 例：全体共同祖先 / 顺序无关 /
  裁剪祖先继续上溯 / 单目标退化保持既有行为）。`npm run check:lines` 通过，构建已更新。
- **待浏览器端确认**：需重载扩展 + 刷新漫画页（旧页面的内容脚本仍是旧构建；重注入在
  `content/index.js` 只信 `existing.invalidated`，扩展重载后该字段仍为 false → 只跑一次
  rescan 就退出，见下条）。
- **顺带修掉的第二处（用户截图）**：气泡「随时都行?真是个不折不扣的花花公子。」第一行原文叠在译文下面。
  实测：该气泡是跨页（seam）气泡，上页那段遮罩被 `clip-path: polygon(0% 100%, 0% 56.82%, …)` 裁掉上半截，
  只留下 56.8% 以下的一条横带；触发条件是 `rotation_deg = -0.6°`（识别噪声）被判成「斜排」——
  `COVER_TILT_TOLERANCE_DEG = 0.5` 太贴近噪声。修复：`cover-geometry.js` 新增
  `COVER_ROTATION_NOISE_DEG = 2`（旋转噪声地板），`resolveCoverQuad` 的 rotation 分支改用它：
  亚度级角度一律按轴对齐处理（不旋转、不裁剪）。真正的斜排 SFX（夹具 12°/20°/35°）不受影响；
  回归测试 `tests/cleaned_mask_tilt.test.mjs` +1（`npm run test:node` 1683/1683）。
- **顺带记录（本次未修，另行处理）**：
  - **同一气泡被翻两次（Lezhin 跨页）**：跨页链路把气泡第 1~2 行合成一句，而**下页**页级 OCR 把被页边界
    切掉的半行读成乱码（`ᅥ|고그 없네.`）又单独翻了一句「真是没救了。」画在同一气泡里。接缝已合并的气泡
    没有把页级碎片挤掉（Lezhin 不是 tiledStrip，走不到 `dedupeKakaoResultByPageCoordinates` 那条跨图去重）。
    隐藏跨页层截图取证：原图三行 = 언제든? / 난봉꾼이 따로 / 真是没救了。 —— 页级那半行是被页边界切断的碎片。
  - `content/index.js`：扩展重载后旧 runtime 的 `invalidated` 不为人知地保持 false，
    重注入只 `existing.rescan()` 就退出 —— 本页要刷新才能吃到新构建；孤儿 runtime 的
    `chrome.runtime` 已死，所有请求都会瞬间失败且被 `CONTEXT_INVALIDATED_RE` 静默吞掉。
  - `controls-ui.js#setOverlayLayerVisibility`：hide 分支是死代码（`else if (visible && depth === 0)`
    不可达，点「隐藏译文覆盖层」只涨 `overlayHideDepth` 不隐藏图层），而 `overlayHideDepth > 0`
    会让 `ensureExtensionUiMounted` 的图层可见性复位守卫失效；与 `withOverlayLayerHidden`
    组合可造成「图层永久隐藏」。

## 2026-10-12（续3）— ルビ过滤三修定版：宿主比 0.8 + 块级注音剥除 + 阶梯拆分

- 完成审计后补的最后一块：几何漏网的 ruby（れい/まん いち/せいこう/だいがく/ゆうかい/
  げんざいひとりぐ——宿主厚度差不足、或中间列规则/跨度判定没接住的）在**块级**收口：
  聚类合并前，≥3 列的竖排块（含 ≥2 条汉字列）里 ≤8 字的全假名列按注音剥掉。
  `stripFuriganaLikeClusterEntries`（ocr-ruby.js；从 ocr-clustering.js 搬过去是行数门禁）。
  横排/聊天区/汉字列不足两列保守豁免。near-p3/4/6 回放：块内 ruby 泄漏 0（此前 2~4 条/页）。
- 三修合起来（宿主比 0.8 / 中间隔列拒绝 / 阶梯错位拆分 + 块级剥除兜底）在凶乱令嬢 10 页
  与転スラ 18 页上：对话识别完整、ruby 丢弃全部正确、无明显两段误并、无块内注音泄漏。
  `npm run verify` 全绿（Python 181 / Node 1676 / 行数门禁 / lint）。
- 已知残留：目录页码/花体署名/SFX 小假名的模型级误读；大字号气泡仍会碎片化（阶梯规则的
  保守面）。扩展与构建均为最新，用户重载即生效。

## 2026-10-12（续2）— ルビ宿主比引擎化（0.8）+ 检视台卡顿根治 + 凶乱令嬢复测确认

- 用户报：还有很多最后没识别到的地方、有些 ruby 没被丢弃、检视台切快照卡住。
- **卡住根因**：测试把 .local-data/debug 塞到 3.3GB（slice_crops 8600 文件、3035 组快照）。
  /api/snapshots 每次要 parse 200 个完整结果 JSON（1.7s）。修复：①300 组以外归档到
  `.local-data/debug-archive/`（2698 组、1.8GB，可删）；②serve.mjs counts 按 (stem,mtime)
  缓存。实测 list 1.71s→0.87s（重启检视台后生效）。**教训：清理脚本的模式把要保留的
  near-p*/cmoa-p* 复测快照也删了（好在拼接页图还在，重跑 OCR 即恢复）——清理与保留
  清单要互相核对。**
- **ruby 泄漏量化**：near-p3 存活全假名薄列 せお/からだ/かのじょ——宿主 この身体を、(27px)
  对 からだ(20px) 是 1.35×，0.7 判据（要求 1.43×）差 1.6px 漏掉。修复：宿主厚度比引擎化
  （manga_ocr 0.8 / paddle 0.7），engine 参数穿透 findRubyHost。near-p3 全量验证：16 条
  丢弃全部正确配对、零误伤、泄漏清零。
- 复测结论（凶乱令嬢 10 页，重跑恢复快照）：对话页全部完整，ruby 丢弃全部正确，阶梯拆分
  符合预期。`npm run verify` 全绿。

## 2026-10-12 — 凶乱令嬢（用户正在看的漫画）10 页复测

- 用户在 CMOA 打开 凶乱令嬢ニア・リストン 1巻 無料試し読み（マンガUP！版，1352 宽分条），
  要求对新开的漫画再测。同流程：canvas 导出 30 条 → 10 页拼回 → manga-ocr（扩展同参数）。
- **识别**：对话页全部完整——第 6 页长对话页（正是最初误删 そういえば、あなたが… 的同类页）
  全文捕获、第 1 页序章独白（好きな調味料は塩で…将来の夢は大きなステーキを食べること）完整、
  第 4 页使用人页 そういえば、使用人もいる 正确保留。第 7/8/9 章节页/插图页正确稀疏。
  残留小错：わかったわかんった（り→ん）、自浄効果といない（いい→ない）、列漏の星（术语乱码）
  ——单点模型级，非系统性。
- **客户端层**：ruby 丢弃 13+8+21 处全部正确配对（わたし→私がニアとして、たいさん→大金で
  俺を雇った…），零误删；そういえば 正确成块。**已知权衡**：阶梯错位规则会把大字号气泡的
  自然错位列拆成多块（page 3 的独白气泡拆成两句组）——翻译上下文有损但文本不丢，是「跨气泡
  误并」与「大气泡碎片化」之间的取舍，当前按用户诉求（两段不合并）偏保守拆分。

## 2026-10-11（续5）— CMOA 无料漫画 18 页实测 + 排版两修（阶梯错位拆分 / 字号下探）

- 用户目标：①随机几页漫画不能出现识别错误/丢弃失误（用 CMOA 无料漫画实测）；②排版两修：
  译文超出气泡框、明显两段不合并。
- **实测方法**：内置浏览器打开 CMOA 免费试读（転生したらスライムだった件 1 巻），页面以
  blob URL 分条渲染（1127×536×3 条/页），页面内 canvas 导出 → 3 条一页拼回 → 18 页全部
  送本地服务（lang=japan + rec_engine=manga_ocr，扩展同参数）。我自己读原图当地面真值。
- **识别结论**：对话页（1/4/5/6/7/9/10/11/14/15）台词全部完整正确——含第 4 页大段独白、
  第 6 页多气泡页。第 8 页动作页 3 条全对（大 SFX + ちっ…）、第 12 页全黑转场页 0 条正确、
  13/14 稀疏页正确。残留错误集中在**低利害场景**：目录页码（第四話→第回話）、花体署名
  （川上泰樹→川上奈崎）、SFX 小假名（ぽよっ→ぽょっ）——模型级极限，非管线问题。
  幻觉细列（8~11px 边缘噪声读出 そういえば、0.50/0.51）被既有纵横比门（25>18）与
  面积门（0.00094<0.0012）拦掉，未泄漏。
- **排版修 1（明显两段不合并）**：第 6 页两个跨气泡过度合并实锤（んん?なんだ…田村か? ×
  血液が不要…??；田村あー!! × 俺が死んだら・・）。判据：同一气泡的正文列顶端对齐（读序
  起点差 ≈0），跨气泡列起点错位 60~123px。`shouldMergeLocalPaddleParagraphLines` 加
  「阶梯错位拒绝」：双方都非全假名 + 起点错位 >1.2×细列厚度 → 拒绝合并（全假名豁免——
  ruby 与宿主的自然错位有半列长）。阈值 0.8 会误伤正确气泡的自然错位（29px 案例），
  1.2 定版。回放 6 页验证：两案例拆开、正确气泡完整。
- **排版修 2（译文超出气泡框）**：`fitBubbleFontSize` 的扩盒兜底是主因——最小字号 10px
  clamp 会把字号抬回去，长译文 10px 放不下就走 `expandBubbleForTextOverflow` 把盒子撑到
  气泡外。修复：扩盒前先下探字号（10 → 7.5px，0.5 步进），真放不下才扩。
- `npm run verify` 全绿。扩展需重载，服务已重启。

## 2026-10-11（续4）— 误删正文（そういえば）与批量空读（以前/ベデリオが）双修

- 用户报：识别不到的部位 + 丢弃的识别错误了（截图：ルビ「そういうえば」→ 注在「言っていたな…」
  粗细比 0.68）。用用户的线上快照（page-1aad437b）回放全链路，两个根因都实锤：
- **误删正文**：そういえば(25px) 与宿主 言っていたな...(46px 大字号) 之间隔着 ruby 列
  いぜん(13px)，间距 37 ≤ 25×1.6=40 通过了间距检查——ルビ过滤没有「中间隔列」防线。
  修复：findRubyHost 加中间列判定（盒中心落在候选与宿主之间的带内 + 自身跨度的一半以上
  落在候选的文字轴范围内），隔着列就拒绝配对。**中间列跨度归一用中间列自身**（用候选归一
  会因短ルビ列 0.28<0.6 漏判）。
- **批量空读**：7/82 列 manga-ocr 返回空文本 score 0.000（det 0.61~0.86 明明框到了）——
  同一批裁剪**单张跑全对**（そういえば 0.9999）。这是批量解码的浮点归约顺序与单张不同、
  低裕度步被翻转后级联成「立即 EOS」的彩票效应。修复：worker 对可疑行（空文本/置信 <0.6）
  **单张重跑一次**（单张是基准），仍空才算真读不出。
- 回归用例：ocr_ruby_filter 新增「中间隔列拒绝配对」真案例（実座標），正反两个断言
  （去掉中间列后同样几何恢复ルビ判定——证明规则只对隔着列的情况生效）。
- 真实快照回放验证：そういえば 保留并与 いぜん 成块（不再消失）。`npm run verify` 全绿，
  服务已重启加载新 worker。扩展需重载。
- 遗留：いぜん 这类与宿主框重叠的短 ruby 读法仍会漏进气泡文本（它的宿主框与候选框互相
  压住，间距判定进不去）；等攒够多页快照统一重校 ruby 过滤。

## 2026-10-11（续3）— 扩展主链路接上 manga-ocr 并设为日文默认（用户确认源语言选的是日文）

- 用户反馈「插件日语识别还是很多错误」——根因：`rec_engine` 只接了服务端和检视台，**扩展主链路
  一直在发 paddle**。本回合把它接进扩展并设为日文默认。
- 接线清单（全部落位）：①schema `localPaddle.recEngine` 默认 `"manga_ocr"` + 归一化；②store
  `toLegacySettings` → `localOcrRecEngine`；③`getLocalOcrParams` → `rec_engine`；④**请求体**补
  `rec_engine` 字段（客户端是逐字段构造 body，漏了这步服务端永远收到空串——端到端测试当场抓出
  rec_engine: paddle）；⑤`buildOcrCacheKey` 加 `localOcrRecEngine`（切引擎不再命中旧缓存，回切
  paddle 旧条目依然有效——所以**不需要换代次**）；⑥设置页「日文识别引擎」下拉（默认 manga-ocr）；
  ⑦ルビ过滤阈值按引擎分开（manga_ocr 0.9 / paddle 0.8）——manga-ocr 对 ruby 列也是高置信，
  原先靠低分过滤挡住的 ruby 会活到过滤面前，0.9 档接住 0.84~0.89 的泄漏（新增回归用例钉住
  0.84 边界：local_paddle 保留 / manga_ocr 丢弃）；⑧服务端 worker 起不来时**循环前探活回退
  paddle**（识别期才回退会拿到 manga 路径的未旋转候选，paddle 读到侧躺文本）。
- 用户澄清源语言选的是「日文」而非 auto——服务端引擎开关只认 japan 正好命中，auto 兼容方案
  （japan 主跑 manga-ocr + korean 补跑 paddle）不做，保持简单；auto 语言下 manga-ocr 不生效，
  想用就把原文语言选成日文。
- 端到端验证（扩展确切请求体，lang=japan + rec_engine=manga_ocr）：rec_engine=manga_ocr ✓、
  72 items、四个关键残留文本全对（全部潰してこい/調子に乗った/返り討ちに遭い/まあ言っちまえば）。
  首次请求含 worker 模型加载 ~14s，预热后 2.2~2.6s。`npm run verify` 全绿。

## 2026-10-11（续2）— 速度：paddle 0.9~1.7s、manga-ocr 2.2~2.6s（目标 1~3s 达成）

- 用户三点：①检视台看到 全部り潰い，另一会话说 manga-ocr 是对的——怀疑检视台没走 manga-ocr
  （对：serve.mjs 是长驻进程，改完透传代码必须重启；浏览器标签页也要刷新才有引擎下拉框；
  服务重启前旧链路会静默忽略 rec_engine）；②manga-ocr 慢一倍怎么解决；③paddle 也变慢了，
  目标 1~3s。
- **实测定位**（/ocr 响应自带分阶段 timings）：paddle 的 `crops` 阶段 1095ms 是最大头——
  `_deskew_crop_region` 逐 crop 调用却每次 `cv2.imdecode` 整页 PNG（~82 次 × 12ms）；
  manga-ocr 的 `recognize` 3276ms 是逐列串行 generate（~40ms/列）。这不是新引入的回归——
  crops 的浪费一直在，列拆分又加了 11 个 crop。
- **两个修复**：①整页只解码一次，`_deskew_crop_region` 加 `source_image` 参数复用（crop 结果
  带上 `imageArray`，省掉 per-crop PNG 编码+解码），paddle crops 1095ms → ~150ms；②worker
  改批量协议（{"images":[...]} 进、{"results":[...]} 出，8 列/批，`LOCAL_OCR_MANGA_OCR_BATCH`），
  压扁后批内全部 224×224 无尺寸差。
- **批量引出的第三个模型坑**：transformers 5.x 批量下 `output_scores` 的 scores 行与
  sequences 行不同序（argmax 实测逐帧错乱，第 2/3 行置信度 0.17/0.34）——弃用 output_scores，
  改 teacher-forced 前向（logits[:, i] 预测 sequences[:, i+1]，按构造对齐）算置信度；代价一次
  解码器前向。`encoder_outputs` 复用在该模型上有维度坑（12 vs 48），老实重过编码器。
- **定版数字**（page139，预热后各两轮）：paddle 0.90~1.72s（57 items）、manga-ocr 2.22~2.57s
  （72 items）——**1~3s 目标达成**，manga-ocr 只慢 ~1.5x 而识别质量全面占优。批量与单张的
  文本+置信度完全一致（worker 内 A/B 验证）。
- 手机版说明：novel-mobile 是小说构建，漫画 OCR 始终跑在 PC 本地服务上，手机端不改变 OCR 速度。
- 教训：`pytest.importorskip("transformers")` 在文件运行时会让主进程炸（transformers 5.x 顶层
  import torch）；契约测试的 `_deskew_crop_region` 桩签名随生产契约同步加 `source_image`。

## 2026-10-11（续2）— 识别引擎 A/B 评判：manga-ocr 文本质量赢，但ルビ泄漏没过关

- 方法：同一张图、受控实例（端口 8891~8894）、`rec_engine` 只切引擎；两页各跑 paddle / manga_ocr：
  `page139`（CMOA 凶乱令嬢，硬骨头页）与 `page_real`（另一页真实漫画）。
  脚本 `tmp-cmoa/ab_engine.py` + 报告 `ab_engine_report.txt` / `ab_engine_junk.txt`。
- **文本质量：manga-ocr 胜**（page139 平均分 0.798 vs 0.603，≥0.9 的 30 → **54**，含非日文字符 2 → **0**）。
  逐条真值（我读过原图）：
  | 真值 | paddle | manga-ocr |
  | --- | --- | --- |
  | 全部潰してこい | —（全部り潰い 碎片） | **1.00** |
  | 返り討ちに遭い | —（返討） | **0.99** |
  | 潰させた | —（潰せ） | **1.00** |
  | スキャンダルで / アンゼルなら | 0.92 / 0.95 | **1.00 / 1.00** |
  | 問題ないだろ / 誘拐された娘を / 揉めに揉めた末 / 筋書きはこうだ | ✓ | ✓（个别多出「一」「。」） |
  page_real 上它还把 `Jこ5年`→**ここ5年**、`交わしてなかた`→**交わしてなかった**、`早`→**早く**、`始ろ`→**始めろ** 修对。
- **不通过的三条（可量化）**：
  1. **ルビ泄漏**：page139 的 `rubyDrops` 4 → **17**，且**合并块里漏进 6~7 个短假名块**
     （ヤッ / ッ / すじが / さしん / ゆうかい / こらの…；paddle 侧 0）。page_real 漏 2 个（スッ / よい）。
     原因：manga-ocr 对ルビ列也高置信，于是 «低分过滤» 不再提前挡掉它们，全压到ルビ过滤上，而过滤的
     厚度判据是按 paddle 几何校准的（文档自己也记了 4 条漏网：ゆうかい 0.84 / すじが 1.05）。
  2. **更碎**：page139 合并块 13 → **20**，page_real 9 → 10 → 翻译单元变多（费用）且按碎片译。
  3. **慢 2.4~4.9×**：page_real 2.6s → **12.6s**；page139 8.2s → **19.6s**（worker 协议是一图一往返，可批量化）。
- **两个反例（别一刀切换引擎）**：竖排片假名 `バブテスマ` paddle 对、manga-ocr 吐 `リバブ・テス・マ・`；
  `今は…` 0.97 → `今は:` 0.60（**没丢**，我复查了同一框的 manga 结果，只是分数掉+没并进同一块）。
- **建议（按优先级）**：① 先按 manga-ocr 几何重校ルビ过滤（唯一硬门槛，修好即可让 japan 默认走 manga-ocr）；
  ② 若不修过滤，就做「paddle 主跑 + 只对读弱的 crop 用 manga-ocr 复读」，但**必须先做完ルビ判定再送修复**，
  否则一样漏；③ worker 批量化（一次往返多张 crop）压掉 2.4~4.9× 的差距；④ 横排/片假名 SFX 与日文以外语言仍用 paddle。


## 2026-10-11（续）— manga-ocr 识别引擎接入（用户拍板「换 manga-ocr」）

- **架构**：`manga_ocr_provider.py`（引擎开关 `manga_ocr_engine_enabled`：lang=japan 且
  `rec_engine=manga_ocr`，或 `LOCAL_OCR_REC_ENGINE` 环境变量默认）+ `manga_ocr_worker.py`
  独立进程。默认 paddle 逐字不变，korean/auto 不受影响；检视台参数面板加「识别引擎」下拉。
- **DLL 冲突实录**：torch 与 paddle 的 CUDA DLL 同进程两种加载顺序都炸（WinError 127，
  cudnn_cnn64_9 / cublas64_12 互相踩）→ worker 进程隔离。worker 还要**清洗继承的 PATH**
  （paddle 导入时把自己的目录塞进 PATH，torch 会错拿它的 cudnn——这个污染在两层子进程
  链里依然传播）。
- **transformers 5.x 三坑**（都靠逐帧 debug 实锤）：①`size:224` = 短边+中心裁剪，竖排长列被
  截断 → 显式压扁 224×224；②fast tokenizer 转换对 BertJapaneseTokenizer 走不通 → 慢分词器
  decode 即可（generate 只需要 id→text），字间空格去掉；③scores/sequences 错位一格 → 长列
  平均概率趋 0 → 识别下限整批误杀（一度让「主列全部消失、只剩 ruby 列」）。
- **定版实测**（page139，RTX 5070 Ti，全页 14s）：manga-ocr 70 条分数普遍 0.95+；paddle 的
  三类残留全破：全部潰してこい 0.999（无通道多列块）、返り討ちに遭い 0.995（paddle 误读返討——
  真值揭示）、まあ言っちまえば 0.997 全字符；聚类回放 20 块、大气泡全部完整。
- **遗留**：①ruby 列泄漏 4 条（manga-ocr 高置信让它们活到ルビ过滤，0.8 厚度阈值按 paddle 几何
  校准的，需要按 manga-ocr 几何重校）；②`pytest.importorskip("transformers")` 绝不能进主进程
  （transformers 5.x 顶层 import torch，paddle 先加载的主进程当场 WinError 127——冒烟测试因此
  必须全程子进程化）；③引擎未进缓存键/未换代次（默认 paddle，结果不变；若用户拍板转默认，
  rec_engine 进 `buildOcrCacheKey` 并换代次）。
- 测试：`tests/test_manga_ocr_provider.py`（5 例，含真模型冒烟——全程子进程，主进程零 torch）。
  `npm run verify` 全绿（Python 181、Node 1676、行数门禁、lint）。

## 2026-10-11 — v11：放大上限收回 2x + 竖排气泡聚类合并（用户三点反馈的收尾）

- 用户三点：①「放大别再超过 2×」；②「拆出来的列要能并回同一个气泡，合并有点问题」；③识别仍有残留，
  并问换 OCR 会不会更好。
- **①上限收回**：`prepare_recognition_image` 恢复 `min(2.0, …)`。此前「无上限精确到 48」的动机
  （拆分窄列 12~23px 需要足额放大）与用户判断冲突，定版从用户：≥24px 列仍精确到 48，12~23px 只到
  24~46px。换代次 v10 → **v11**（识别输入又变了；两侧逐字同步 + 钉值测试同步）。
- **②合并问题的三层诊断**（全部用真 bundle 回放 + 逐对门检验定位，不猜）：
  - 段落层：列厚比门 0.65 对细列过严（ますかね 32px × うまくいって 18px = 0.56 被拒）→ 放宽到 0.5。
  - 段落层：`shouldMergeLocalPaddleParagraphLines` 的「聊天上小下大」拒并门在竖排投影下误伤——竖排的
    inline=竖直，任意两列都有先后关系、相邻列 lineGap 天然极小，`揉めに揉めた末×返討`（hRatio 0.738
    恰好压线 1/1.35=0.7407）所有几何门都过却被它拒掉。修复：横排（|median rotation| <45°）才启用。
  - 样式层（最后一级，最隐蔽）：`splitLocalPaddleVisualStyleClusters` 的 `hasStackedStylePair` 在竖排下
    **恒真**——段落明明已连通成整气泡（连通组验证 {揉め,返討,地元,貴人} 四列），还是被按列厚拆成
    [地元+貴人] // [揉め+返討]。竖排跳过样式拆分（时间戳仍可拆；竖排漫画没有聊天时间戳）。
  - 容器层：`areLocalPaddleRegionsCompatible` 要求同 id/可统一，但服务端**按列**发容器——同气泡各列
    id 必不同、类型还在 speech_bubble/caption_panel 间漂移（同一白气泡实测三种类型并存）。竖排下
    同/异类型 bubble-like（conf ≥0.75 + 底色差 ≤24）视为兼容。**只对竖排放宽**：横排的容器 id 是
    可靠信号，放宽会让相邻字幕并进气泡（`background_runtime.part02` 的既有测试当场抓住，正确行为）。
  - 行数门禁：ocr-lines.js 超 400 → 容器兼容函数族（~106 行）搬去 ocr-regions.js（本来就是 region 语义）。
  - 实测（v11 识别 + 真聚类回放）：22 块 → **13 块**；大气泡六列完整成块「筋書きはこうだ/調子に乗た/
    貴人の娘が/地元のチンピラと」——v8 同一区域也只有 2~3 列的碎片组，这里是净改善。Node 1676 全绿。
- **③残留与换 OCR 评估**（未实施）：全部り潰い/キどものチ 两处 crop 内无干净通道，列拆分无效；
  「0.5× 邻居遮挡候选」（续5 提案，n=1 证据）仍是候选。换引擎评估写在会话总结：manga-ocr 是日漫
  竖排的专用模型（det+column crop 已由列拆分备好），是最对口的下一步，但属独立工程。

## 2026-10-10（续7）— v10 复测：列拆分是真赢，但有两个新问题

- 复测条件：同一页 `tmp-cmoa/page139.png`、端口隔离的受控实例（8765 上仍是别人的实例，我没动），
  五份载荷：v8 基线 / v9 放大(无门) / v10 默认 / v10 关列拆分 / v10 关放大。
  **注意**：v10 默认的检测框与 v8 **不一致**（列拆分新增 11 条检测，raw 71 → 82），
  所以必须按 IoU 配对比较，按序号比会整片错位（我第一版报告就踩了这个坑）。
  `tmp-cmoa/ab_v10_matched.mjs` 是配对版，`ab_v10_report.txt` 是五方对照。
- `npm run verify` 绿：**1676 Node / 176 Python +1 skipped** + 行数门禁 + lint + build（含对方新增的
  `tests/test_crop_columns.py`、`tests/test_rec_preprocess.py`）。seam 分支的悬空引用 bug 已修（append 回到 `is not None` 守卫内）。
- **v10 修好的（逐条读图核对过真值）**：
  - 列拆分（`crop_columns.py`）修好 8 处以上，新条目分数 0.91~1.0：`問題ないだろ` 0.948（原 問う題 0.67）、
    `揉めに揉めた末` 0.925（原 揉にん末 0.52）、`誘拐された娘を` 0.917（原 誘拐娘 0.84）、
    `筋書きはこうだ` 0.997（原 筋書はこうだ）、`地元のチンピラと` 0.999、`貴人の娘が` 0.997、
    `被害者をかさ増し` 0.984、`ァンゼルにガキどもも` 0.942、`うまくいって` 0.914。
    `tmp-cmoa/v10_column_split_crops.png` 是 crop 级证据：v8 的 crop 里混着ルビ/邻列出血，v10 拆出来的列是干净的。
  - 几何门（短边 ≤11px 不放大）有效：v9 的三个「办」只剩 1 个、`い→2` 恢复 `い`、`号→办元` 恢复 `号`；
    非日文字符命中 3 → 1。
- **新问题一：放大的 2× 上限被去掉，12~16px 这一档变成 3~4×，出现新退步。**
  `prepare_recognition_image` 现在是 `scale = floor / short_side`（v9 是 `min(2.0, floor/short_side)`）。
  同框同图只切放大：`もう`(12×32) 0.97 → **`vc` 0.19**；`みさ` → `さ`；`かんたん` → `かんん`。
  与文档里自己的结论（"放大过头会被模型缩回反而丢字"）一致 —— 建议对这一档恢复 2× 上限，几何门保留。
- **新问题二：列拆分把短列切坏，并把气泡拆碎（客户端后果）。**
  - 切坏：`潰させた`(28×90, 0.76) → **`潰せ` 0.87**（关列拆分时是 `潰させた`，所以确定是拆分导致）；另有一条
    8×165 的带被建成条目却识别为 **0.00**（`COLUMN_DET_MIN_WIDTH=8` 刚好卡在边缘）。
  - 气泡数：合并块 **17 → 22**（`うまくいって`/`ますかね`、`するために`/`潰せ`、`調子に乗た`/`貴人の娘が`/
    `地元のチンピラと`/`揉めに揉めた末` 被拆成多个块）。**mergeLineGap 2.2/3/4/6/8 都试过，块数不变**（v8 也一直 17）
    —— 不是这个旋钮能解决的。
  - 根因：拆出来的子条目只带 `region_id=region-0079-…`（父是 `region-0063`），**没有父线索**，客户端无从知道
    这几列原本属于同一气泡。最小改动：子条目带 `column_parent_index`（或复用父 region 前缀），客户端按父并回一个气泡 ——
    既保住识别收益，又不增加气泡数（不额外花翻译费）。
  - 顺带：`regions 15 → 14`（实底采样区少一块，需盯遮罩是否仍贴）。
- 其它：仓库根目录出现未跟踪的 `.zcode/` 与 `.zcodeignore`（另一个会话的工具目录），建议加进 `.gitignore` 或清掉。

## 2026-10-10（续6）— v10：竖排列拆分落地 + seam 恢复分支的悬空引用修复

- **先修别人续5里发现的真 bug**：`crop_recognition.py` seam_recovery 分支的 `candidate_rows.append(...)`
  确实在 `if repaired_crop is not None:` 之外（git diff 对 HEAD 可证）——`repaired_crop` 为 None 时首轮回
  UnboundLocalError、后续轮复用上一轮残留的 `repaired_image`（张冠李戴）。已把 append 还原进 if 块。
  `CLAUDE.md`/`AGENTS.md` 实底那条的「现为 v8」也已改为「现为 v10」。
- **竖排列拆分**（上一轮的遗留项，本轮主任务）：新模块 `crop_columns.py`，接在检测合并之后、识别之前。
  - `detect_column_bands`：列向墨水投影找列带。两轮实测调参——初版 `min_gap_width=2` 在真页上**一个都
    拆不开**，投影剖面显示真实列缝只有 1px（ルビ紧贴正文/邻列出血），于是 1px 通道即列界、去掉合并
    步骤；碎带下限 4px。`column_detection_polygons` 走 deskew 契约的 cropToSource 把列带映射回原图
    四边形。
  - 接线方式：列检测**追加进检测队列由同一 while 循环体处理**——初版做成独立预检（每个检测多裁一次）
    被 `test_ocr_geometry_contract` 的 `crop_calls == 1` 打回，改成队列后零二次裁剪、契约测试原样通过。
  - 两级阈值：拆分判定 4px / 建条目 8px（`COLUMN_DET_MIN_WIDTH`）。中间版本曾产出 `a`(4px)、`.业`(10.7px,
    0.514 蹭过客户端低分例外) 这类垃圾条目；8px 门槛后消失，真ルビ列 8~11px 不受影响（照旧交给客户端
    ルビ过滤）。全部碎带不足 8px 时回退整列识别。
  - **放大与拆分的联动**：拆分后的窄列（12~20px）被 2x 上限压在 36~40px、不到模型原生 48px，实测丢字
    （「うまくいって」→「うまくいて」）；去掉上限、12~47px 一律精确放大到 48 后恢复。续5 的「floor=64
    倒退」由此也有了解释：不是 64 太大，是 2x 上限让 26px 只到 52px 再被模型缩回。
- **实测**（同一页 page139，v10 最终版 vs v8 基线）：8 处多列混读修好 6 处——問う題→**問題ないだろ**
  (0.651→0.948，正是续5 里「要靠 0.5× 缩小才对」的 #63，列拆分直接救活)、誘拐娘→**誘拐された娘を**、
  揉にん末→**揉めに揉めた末**、被害増し→**被害者をかさ増し**、筋書はこうだ→**筋書きはこうだ**(0.997)、
  アンゼルにガキもも→**アンゼルにガキどもも**；加上 v9 已修的 スキャンダルで/まあ言ちまえば。
  残餘 2 处（全部り潰い、キどものチ）crop 内**没有贯穿高度的干净通道**，列拆分无能为力——续5 的
  「0.5×/邻居遮挡候选」仍是这类的好候选（n=1 证据，未实施）。
- **已知抖动**：低分碎片条目（潰せ/潰させた、かんん/かんたん、調子に乗った/乗た）在输入几乎不变的两次
  运行间摆动——PaddleOCR rec 按 batch ≤16 组批、组内按最大宽度 padding，拆分改变了批次划分 → 同一
  crop 的分数微移 → ±90 选优翻转。结构级修复跨运行稳定；逐字稳定要动组批策略（按尺寸排序组批），
  未实施。`調子に乗った→乗た` 是本轮唯一一次真台词抖动，0.992 自信错读，留观。
- 换代次 v9 → **v10**（拆分 + 放大几何门都改服务端返回；v9 未及发布，但用户已用 v9 跑过页面、缓存已热，
  不换代读回旧结果）。两侧逐字同步 + 两处钉字面值测试同步。
- 验证：新增 `tests/test_crop_columns.py`（8 例）、`test_rec_preprocess.py` 补 skip 门/无上限用例；
  Python 176、Node 1676、行数门禁 + lint 全绿（`npm run verify`）。A/B 用 8766 独立实例（8765 是用户的
  v10 服务，没动）。

## 2026-10-10（续5）— v9「识别输入增强」的真实 A/B：先把测量环境修对，再谈效果

- 目标：用户要求「用同一页做前后对比，验证那批 v9 改动（别人会话做的）到底把识别错误修到什么程度」。
- **测量事故（重要教训）**：前三次采样（`LOCAL_OCR_REC_PREPROCESS=off` / 默认 / `LOCAL_OCR_REC_UPSCALE_MIN_SHORT_SIDE=200`）
  结果**逐条完全一致**，看起来像「放大不影响识别」。实际原因是 **8765 上有一个别人起的 `python server.py`（pid 22400，
  命令行是 bat 风格的 `python  server.py`，不是我这边的完整解释器路径）**：我起的受控子进程抢不到端口直接退出，
  请求全被那个实例接走了 —— 它的放大是开着的，所以三次必然一样。
  **教训：本地服务是固定端口，做 A/B 前必须先确认自己起的实例真的在服务**（看 `Get-NetTCPConnection` 的 OwnerProcess
  命令行，或干脆换端口）。别人那个实例我**没有动**。
- 修法：`tmp-cmoa/ab_rec_isolated.py` 用 `python -c "uvicorn.run(app, port=$AB_PORT)"` 在 **8791/8792** 起自己的
  实例（不改 `server.py`），端口本来是空的 → 端点就是自己的，自证。
- **受控结果**（同一张 `tmp-cmoa/page139.png`，同一份代码）：
  - `v9·放大关` 与「v8 基线载荷」**逐条完全一致**（71 条文本/分数、57 items、17 块）—— 说明放大就是这批改动的
    唯一功能差异，也说明测量链路可信。
  - `v9·放大开`：**71 条里 33 条变了**；items 57 → 54；平均分 0.727 → 0.691；<0.72 的 29 → 30 条；合并块 17 → 18。
  - 逐条读图核对（`tmp-cmoa/rec_disputed_crops.png` 是把有争议的 crop 横过来放大 3 倍拼的）：
    - 真修好（真值由我读原图确认）：#29 スキンダルで → **スキャンダルで**；#37 ま言ちまえば → **まあ言ちまえば**；
      #58 潰せた → **潰させた**；另有 #31 なるかわからね → なるかわからねえ、#27/#41 从空 → き/号。
    - 变差：#6 みがら → **迹**（「迹」是简体专用字，日文里不该出现）；#26 い → 2（0.986 → 0.288，噪声碎片）；
      #5/#9/#67 出现「办」。#51（真值 全部潰してこい）与 #63（真值 問題ないだろ）**两次都错**。
    - 副作用（算好的一面）：#3/#25/#43 三个「2」的噪声条目分数掉到 0.000 被丢掉 —— 正是靠低分例外才放行的那类假阳性。
    - 合并结构变差一处：基线「揉にん末/返討」+「調子に乗った/貴人の娘が/地元のチンピラと」在 v9 下变成
      「地元のチンピラと/揉揉末/返討」+「調子に乗った/貴人の娘が」（误合）。
- **crop 级探针**（`tmp-cmoa/probe_rec_scale.py`，直接调真识别器，不经过服务）：
  | crop | 原始 | v9 放大到 48 | 2× LANCZOS | **0.5× AREA** |
  | --- | --- | --- | --- | --- |
  | #29（真值 スキャンダルで） | スキンダルで 0.998 | スキャンダルで 0.932 ✓ | スキャンダルで 0.921 ✓ | スキンダルで 0.759 |
  | #63（真值 問題ないだろ） | 問う題 0.661 | 問う題 0.650 | 問う題 0.663 | **問題ないだろ 0.807 ✓** |
  结论：**日文竖排有两类独立的识别错误，修法是相反的** ——
  ①小字号假名被丢（ャ/あ/っ）→ 放大有效（v9 做对了）；
  ②crop 里混进了相邻列的ルビ（#63 的 crop 右缘就有被切一半的注音）→ 放大无效，**缩小/糊掉反而对**。
  建议：放大加**几何门**（长宽比 ≥5 这一桶 7 条里 6 条文本变长、0 条变短；短边 ≤11px 那一桶 5 条全部变差），
  再给「有相邻细条邻居」的 crop 加一个 0.5×/邻居遮挡候选交给既有的 `select_best_recognition` 挑
  （按 `recognition_quality` 算：#63 的 0.5× 候选 0.975 胜过原始的 0.754 ✓；但 #29 的放大候选 1.119 会输给
  原始 1.165，所以**不能**只靠质量公式做取舍，得先把放大做进几何门）。
- **顺带发现的真 bug（别人会话的改动里）**：`local-ocr-service/ocr_service/pipeline/crop_recognition.py:271-279`
  —— seam_recovery 分支的 `candidate_rows.append(...)` 被**挪出了 `if repaired_crop is not None:` 之外**，
  却仍引用 `repaired_image`。`repaired_crop is None` 时会 `UnboundLocalError`，或者上一轮循环残留的
  `repaired_image` 被当成本次的 crop 送进识别（张冠李戴）。本页无接缝所以没触发，接缝页会中招。
  `CLAUDE.md`/`AGENTS.md` 的实底那条还写着「现为 v8」，与磁盘上的 v9 不一致（文档待同步）。

## 2026-10-10（续4）— 检视台第二批问题：④⑤「没有框」是真 bug；⑦ 不是位置错是语义不同

- 用户两条反馈：**「第七步服务端的 bubble 位置感觉没修」**、**「4 和 5 步的结果没有框」**。
- ④⑤ 没有框 = **真 bug**：结果筛选/ルビ丢弃的条目来自 `createOcrDebugSession` 的 `filterReasons`，
  里头的 `item` 是 `toDebugOcrItem()` 的产物 —— 它的 `polygon` 是**百分比**坐标（`x/imgW*100`），
  而 `rawBox` 才是像素。我按像素直接画，于是整层框被挤到左上角（实测第一个框画成了 `20,7 1×3`，
  真实位置是 `193,91 11×44`）。修复：`stage-core.mjs` 新增 `debugPolygonToPixels()`，把百分比换回像素；
  修完第一个结果筛选框 = `193,91,11,44`（与像素框逐位一致），ルビ框也落到 `659,603` 这种真实位置。
  另外给「小到看不见」的框（最短边 < 6px）补一个固定尺寸的方块标记兜底。
- ⑦ 不是位置错：把服务端 region 框与检测框画在同一张原图上逐块比对（`tmp-cmoa/probe_region_align.py`），
  绿框正好各包一列 —— region-1 `[197,75,35,153]` 恰好框住检测 #61 `[202,86,26,131]`。
  服务端的 `regions` **全部是 4 点矩形**（15/15，矩形度 ≥0.99），语义是「逐文字容器的**实底采样区**」，
  不是气泡轮廓；一个两列气泡会拿到两块互相重叠的矩形，所以看起来「不贴气泡」。UI 侧改名并加说明：
  「⑦ 服务端实底采样区（逐文字容器，不是气泡轮廓）」，并指明想看气泡级范围看 ⑥。
  另一条同样可能的原因：**标签页是修 viewBox 之前打开的**（服务器重启不刷新已打开的标签页），
  那种情况下所有框（含 ⑦）都还是旧的偏移状态 —— 需要刷新页面。
- 验证：`tests/stage_core.test.mjs` 增加不变量（被丢弃条目的多边形包围盒必须等于其像素框、且不能是百分比量级）；
  `npm run verify` 全绿（1669 Node + 159 Python + 行数门禁 + lint）。


## 2026-10-10（续3）— 「回车会不会进翻译」：不进模型，但会被折成**一个空格**

- 用户看着检视台里带 `\n` 的合并文本问：翻译时会不会去掉回车（他感觉有回车机翻会很怪）。
- 实测（真实那一页 17 个块，同一份真代码）：聚类输出里 **11 个块带 `\n`**（竖排一列一行），
  但经过 `normalizeTranslationSourceText`（`seam-handling.js:387`，NFKC + `\s+ → " "`）之后
  **带换行的 0/17**；`アンゼルなら\n問う題` → `アンゼルなら 問う題`。调用链：
  observation 构建（`observation-results.js:160`）→ canonical 原样带走（`canonical-translate.js:211`）
  → 提示词 `{id, text: item.original_text}`（`translation-provider.js:345`）。提示词里另有一句兜底
  「一个 input 可能含多行 OCR，要整体理解、不要逐行机翻」。
- 反向也成立：模型**返回**的 `translated_text` 走同一个归一化（`translation-provider.js:117`），
  所以译文里的换行也进不来；页面上看到的分行是**我们自己的排版**（`white-space: pre-line` + 布局换行），
  不是模型给的换行 —— 「模型吐回车把排版搞乱」这条不成立。
- 但用户的直觉方向对：**折成空格**对日韩文本是错的连接方式（CJK 不用空格分词）。而且内部不一致 ——
  canonical 拼片段用 `join("")`（`reconciler-fragment-groups.js:225`），只有 OCR→observation 这个入口用空格；
  这个空格会同时进入送模型的原文、术语发现输入、术语库/翻译指纹。**待用户确认后**改成按字符集决定连接符
  （含假名/汉字 → `""`，含韩文或纯拉丁 → 保留空格）；代价是翻译缓存键与术语指纹变化（旧条目自然失配、
  不投毒，OCR 缓存不受影响）。
- 顺手把「模型到底读到什么」做成可见的：检视台新增 **⑧ 送进翻译模型的原文** 面板（聚类文本 vs 归一后文本、
  `换行→空格` 标记、`复制 Input JSON` 按钮），导出的 Markdown 摘要也带上这张表；
  `tests/stage_core.test.mjs` 增加不变量（送模型的文本必须无换行、无连续空白；多行块必须被标记为已归一化）。


## 2026-10-10（续2）— 检视台「框框的位置不对」：SVG 少了 viewBox + 合并块位置用了文字轴几何

- 用户反馈：**看起来框框的位置有问题**。查出两个独立原因（一个画错、一个算错）：
  1. `index.html` 的 `<svg id="overlay">` **没有 viewBox**。我的多边形坐标是**源图像素**（979×1324），而没有 viewBox 时 SVG 的用户单位是元素自身的 CSS 像素（这一页被显示成 1136px 宽），于是框按 1.0 而不是 1.16 的比例落位，**越往右下漂得越多**（右下角实测差约 100px）。修复：`applyStages()` 里设 `viewBox="0 0 W H"` + `preserveAspectRatio="none"`；修完用 `getBoundingClientRect` 与「源坐标 × 图片缩放」逐点比对，三类图层（合并块/结果筛选丢弃/ルビ）delta 全是 `0,0,0,0`。
  2. 合并块的「位置」取的是 `location/rawBox`，而那是**文字轴**几何（竖排时宽高与屏幕正好互换：一个两列气泡 rawBox=137×61，屏幕上的四边形是 58×132）。画框用的是 polygon 所以看着对，但**表格里的位置**与**「最近邻放大」裁图**都落到了错的区域。修复：`stage-core.mjs` 里合并块的 `box` 改为多边形的**屏幕轴包围盒**，文字轴原值保留为 `textAxisBox`，详情面板两行都显示（并注明哪个是原始值）。
- 顺带两处可读性修正：标签按序号轮换 5 条轨道（密集角落里十几条噪声碎片的原因文字原本叠成一团），锚点从 `polygon[0]` 换成包围盒左上角（旋转四边形的 `polygon[0]` 可能在底部，直接用它标签会跳位）。
- 验证：`tests/stage_core.test.mjs` 增加一条不变量 —— 合并块 `box` 必须等于其多边形包围盒，且两列竖排块的屏幕轴必然「窄而高」、文字轴「宽而扁」；`npm run verify` 全绿（1667 Node + 159 Python + 行数门禁 + lint）。


## 2026-10-10（续）— 「阶段检视台」：把每个阶段摊在一个本地网页上（不在插件里显示）

- 用户诉求：**不要在插件里展示中间结果，要一个新平台**（软件或新网页）逐阶段看，看完再提建议；并问「之前是不是有个可视化网页，在哪」。
- 勘查结论（都在浏览器里实测过，不是推测）：
  - 既有页面是 `tools/ocr-debug-tool/index.html`（Manga OCR Compare Workbench）+ `debug_background_workbench.html`，启动脚本 `run_ocr_debug_tool.bat` / `run_background_workbench.bat`，说明在同目录 README。
  - **但它们今天根本发不出 OCR 请求**：服务端 CORS 白名单只允许扩展来源（`dependencies.py#EXTENSION_ORIGIN_PATTERN = ^chrome-extension://[a-p]{32}$`，用在 `api.py` 的 CORSMiddleware）。实测从 `file://`（`Origin: null`）以及从 `http://127.0.0.1:8099` 直接 fetch `http://127.0.0.1:8765/health` 都是 `TypeError: Failed to fetch`。也就是说「双击 bat 直接打开 index.html」这条路从来没通过。
  - 另外它页面里的 Raw/Filtered/Merged 是**另写一份**过滤/合并实现（`index.html#processOcrPayload` 里的 `dropReason`/`mergeItems`），与线上代码是两份、会漂移。
- 做法：新增 `tools/stage-inspector/`，**生产代码零改动**（`extension/` 与 `local-ocr-service/` 一行没动）：
  - `serve.mjs`：只监听 127.0.0.1 的本地调试服务器 = 静态（`tools/`）+ **同源反代**（白名单 `/ocr` `/health` `/ocr/timings` `/debug-background`）+ 阶段回放 API + 线上快照/产物读取（白名单根 `.local-data/debug`，规范化后校验前缀，防目录穿越）。**没有**去放宽服务端 CORS —— `Origin: null` 必须继续挡着，否则任意网页里的 sandbox iframe 都能读本地术语库/译文库。
  - `stage-core.mjs`：阶段回放核心 —— 把 `dist/test/background.iife.js`（`npm run build` 产物）载进 `node:vm`，用**线上同一份** `keepOrTraceOcrWord` / `filterRubyAnnotationWords` / `buildLocalPaddleBubbleItems` 算阶段（不再有第二份实现）；同时保留 CLI 出一次性静态 HTML。
  - `index.html`：图层开关 ①检测 ②识别下限 ③到达结果筛选 ④结果筛选丢弃 ⑤ルビ ⑥合并块 ⑦服务端区域，颜色固定、可叠加；「每条检测的结局」主表 + 合并块/丢弃/区域三张表；选中一条即显示**服务端送给识别器的裁剪图**（`slice_crops/slice-<stem>-NNN.png`），没有裁剪图时用最近邻放大原图兜底；参数面板改 `confidenceThreshold` 等 → **只重跑阶段、不重跑 OCR**；导出 Markdown 摘要 / 阶段 JSON；「线上快照」列表直接读服务写下的真实页面（不花钱）。
  - `run_stage_inspector.bat` + 新增 `tools/README.md`（工具索引，直接回答「之前那个网页在哪」）+ 两个既有 bat/README 的 CORS 说明（把 `serviceUrl` 填成 `http://127.0.0.1:8099` 即可复活旧工具）。
- 真机验证（`tmp-cmoa/page139.png`，979×1324，服务 v8）：检测 71 → 识别下限丢 14 → 到达 57 → 结果筛选丢 16 → ルビ丢 4 → 合并 17 块 → 区域 15 个；把阈值 0.72 改到 0.60 后（只重跑阶段）结果筛选丢 16→11、ルビ 4→6、块 17→19；选中检测后裁剪图（14×27）与最近邻放大视图都正常。
- 顺带记录一个服务端命名坑：`debug_id` 为空时 `orchestrator` 用时间戳命名 `plugin_input/vis/result_json`，而 `crop_recognition` 里的裁剪图退回 `safe_debug_stem('')` → `ocr-<pid>-<tid>` 命名，两批产物对不上，检视台按 stem 找不到裁剪图。工具与 `tmp-cmoa/run_page_ocr.py` 现在都显式带 `debug_id`。
- 测试：`tests/stage_core.test.mjs`（6 例：各阶段计数与丢因、ルビ连同宿主、竖排读序合并、调阈值真的改变丢弃数、bundle 缺失给「先 npm run build」提示、导出面断言）。


## 2026-10-10 — 日漫两问：汉字旁的小字（ルビ）与「明明很清晰却没被翻译」

- 用户三句话：①**有些文字识别不到，明明看起来还挺清晰的**；②**日漫这些旁边的小字是什么，为什么有那么多，应该怎么进行排版，或者是不是应该忽略，还是用别的 OCR 比较好**；③「太麻烦就算了，反正我不看日漫，因为太贵了」。
- 先把「旁边的小字」查清楚 —— 它有两个来源，**都不是译文**：
  - **上次诊断时我打开的「OCR 调试」叠层**（`localPaddle.debug`）：`raw-N [OCR 87.8%] | …` 标签，实测一页 312 条 raw + 108 条 block，铺满整页，看起来就是一行行小字。它只是识别中间结果。已拆成 `content/modules/ocr-debug-overlay.js`（原在 `renderer-overlay.js` 里，那支文件本来就到 409/400 行），并让它在画框之外**自带一条自我说明横幅**（`.mt-debug-badge`：「OCR 调试层：下面的 raw/block 标签是识别中间结果，不是译文 · 关闭：设置 → OCR 调试」）—— 它长得像台词正是用户无法判断的原因。**用户侧的处置：在 设置页 / 悬浮菜单 里关掉「OCR 调试」**。
  - **ルビ（振り仮名）**：日漫在汉字旁用小一号假名注音（縦書き在汉字列右侧、横書き在汉字上方），PaddleOCR 把那一列小字当成**独立文本行**检测出来。这是真问题：它既各自成气泡（「为什么有那么多」），又会被聚类拼进正文 —— 实测「あしたもと」+「明日日地元」被拼成一行，译文「明日元,明天是本地。」，一句正常台词变成乱码。
- **两件事其实是同一个成因**：用服务自己写的 `slice_crops` 放大看，「鉄パイプか」0.705、「帰ないと」0.711 两条正文清清楚楚，但**汉字旁边就压着ルビ（てつ／かえ）**；同一页不带ルビ的行是 0.92~0.99。ルビ把整行的**平均**识别分拖到了默认阈值 0.72 下方。
- 于是「识别阶段」和「结果筛选」两条线都要动：
  - 服务端 `crop_recognition._run_slice_ocr_pipeline` 拿 `text_rec_score_thresh` **硬切** `items`，而这个字段以前送的正是**用户的结果筛选阈值**（默认 0.72）→ 0.70 出头的清晰台词在识别阶段就被删了，扩展侧那条「低分但行是完整的」例外根本没机会生效。改成送**识别硬下限** `shared/shared-constants.js#OCR_RECOGNITION_SCORE_FLOOR = 0.4`（同一常量也是结果筛选那条例外的门槛，一处定义两处用），用户阈值仍然只由结果筛选生效。
  - 结果筛选那条例外同时收紧：只放行「目标语言文字（`isReliableMeaningfulShortOcrText`，数字/拉丁/带 `?`、`�` 的一律不算）+ 面积占比 ≥0.0012」。用真实 6 页 212 条原始识别回放：旧行为会丢、新行为放行的条目从 23 条（只按 `meaningfulText` 判）收紧到 **16 条**，其中「鉄パイプか／帰ないと／終わったら／隠し持てる」是正文，其余是同一行的碎片。**没有按字数卡** —— 一开始加了「≥4 字」，立刻被既有用例打回：韩文单音节台词（「그」，webtoon 常见）就是一行、日文也有「え」「ま」这类一字台词，按长度丢会误删真台词（`tests/background_runtime.part07.test.mjs` 钉着这条）。
  - 新增 `background/modules/ocr-ruby.js#filterRubyAnnotationWords`，在**聚类之前**把ルビ整条丢掉（不并进正文、也不各自成气泡）。四条判据同时成立才认：①文本全假名；②比**整页同向条目的中位粗细**细（≤0.8）；③紧挨着一个更粗、且**含汉字**的邻居（间距 ≤ 自身粗细×1.6，竖排比左/右、横排比上/下）；④沿文字轴重合 ≥60%。**只看「比邻居细」会误伤** —— 邻居可能是聚类后的多列块（「それなら」对「私王来時」比值 0.55，两条都是真台词），页内中位数才是「正常字号」的判准。真实数据回放：11 条命中，逐条核对全是ルビ/ルビ碎片。
- 换代次 v7 → **v8**（服务端返回的 `items` 内容变了，而 OCR 缓存键里只看得到用户阈值），扩展侧 `config/versions.js` 与服务端 `dependencies.py` 两侧逐字同步，两处固定字面值的测试同步。
- 代价与取舍（写清楚）：一页多出约 1.5 条低分条目参与翻译（6 页共 9 条），换来「清晰台词不再被吞」。**误删真台词比留着ルビ严重得多**，所以ルビ判据刻意保守：拿不准就不动。
- 已知没解决：ルビ压在汉字上导致识别分天然偏低是模型层面的问题（要根治得在 crop 阶段把ルビ切掉，风险更大）；白字黑底／贴网点的气泡仍走清理图，擦痕依旧。用户说了「太麻烦就算了」，所以到此为止，没有再动 detect/crop。
- 验证：新增 `tests/ocr_ruby_filter.test.mjs`（8 例，夹具坐标全部取自真实整页 OCR）、`tests/ocr_recognition_floor.test.mjs`（3 例：硬下限口径 + 低分例外只放行够长的目标语言文字 + 达标条目不受影响）；`tests/overlay_style.test.mjs` 增加调试横幅与拆分后模块的断言；真实数据回放脚本留在 `tmp-cmoa/verify_ruby_real.mjs` 与 `tmp-cmoa/verify_floor_real.mjs`。


## 2026-10-09 — 清理图「只覆盖了一部分」：±90° 被当成倾斜去旋转文字框

- 用户反馈：**清理图大小不对，感觉现在是只覆盖了有翻译文字的地方**。我先把「关掉文字层只留遮罩」截了一张图：擦痕是一条条**横跨分格**的横带，竖排日文原文只被擦掉一小截、其余照旧露着 —— 横带就是线索。
- 根因在共享几何 `rendering/cover-geometry.js#resolveCoverQuad`：`rotation_deg` 接近 ±90° 时它的语义是**竖排（文字沿竖直方向排列）**，不是「歪了」。服务端 `polygon_rotation_deg` 对高而窄的框（竖排台词的每一列都是这种框）一律给 ±90°，而文字四边形本身是轴对齐的 —— 它就是那一列的准确范围。旧代码把这种角度当倾斜处理，`rotateBoxQuad(polygonBox, ±90)` 把 96×225 的竖列转成 225×96 的横条。
- 修复只有一处：`rotationTilted` 增加上界 `Math.abs(rotation) < RENDER_ROTATION_VERTICAL_MIN_DEG`（60°，复用渲染侧 `sanitizeRenderRotationDeg` 已有的同一常量与同一语义）。于是 ±90° 走「polygon 轴对齐就直接用它」，横排/斜排 SFX 的行为逐字不变。这一处同时修好四条路径（DOM 遮罩、清理遮罩、嵌入式画布、场景文字层）—— 它们本来就共用这一个函数。
- 保留的例外：**没有 polygon 时** box 是文字轴几何，旋转 ±90° 恰好得到屏幕盒子，所以 `else` 分支的旋转必须留着（有测试钉住）。
- 验证：新增 `tests/cleaned_mask_tilt.test.mjs` 两例（竖排投影产出竖长遮罩且与 `resolveCoverQuad` 同源、无 polygon 时仍旋转成竖框）；`npm run verify` 全绿。

## 2026-10-09 — 纯白气泡背景不干净：实底采样的留边单位拿成了「列长」

- 用户第二个要求：**纯粹的白色气泡框可以直接用 solid 而不是用清理图，清理图会导致背景不纯净**。
- 先量清楚「为什么这些白气泡没被判成实底」：写探针直接调服务内部 `measure_solid_background_scale`，逐块打印 near/far 两道采样门的指标与阈值。真实一页 19 行里**只有 1 行**判成实底，其余全部 `region_type=effect_text`、`bg_color` 为空 → 扩展侧 `bg_type=none` → 改用清理图。
- 根因：`detect_solid_region_for_box` 用 `line_height`（item box 的高）当 `vertical_reference` 决定上下留边。横排时它 ≈ 字高没问题；**竖排的一「行」是一整列**，实测列长 192px → near 采样区上下各外扩 0.35×192≈67px，直接越出气泡采到插画，每次都被「内部跨界离群」这道结构门拒掉。
- 修复：新增 `solid_sampling_reference(text_polygons, scale)` —— 取每个文字框**短边**（横排 = 行高、竖排 = 字宽、斜排 = 笔画厚度）的中位数当留边单位；拿不到多边形时返回 0，调用方沿用原来的 `line_height`（所以无 polygon 的旧行为与既有测试逐字不变）。同一页实底容器从 **1 个变成 6 个**，7/19 行拿到 `speech_bubble` + `#ffffff`。
- 仍然漏掉的那些（白底黑字贴在插画上、白字黑底气泡）不再硬调阈值，改由扩展侧**量到的**平底色兜底：`bubble-colors.js#sampleBubbleAppearance` 多返回一个 `bgCoverage`（外圈有多少像素贴着中位色），`applySampledBubbleColors` 在「服务没判出实底容器 + 环内一致率 ≥ 0.92 + 亮度 ≥ 0.72」时把 `adaptiveBackground` 升级成 `solid`。亮度门槛与服务端 `classify_solid_region_type` 的 `bright_background` 同口径；**环不够均匀就什么都不做**（平涂一块网点/渐变会把插画糊成色块，这条底线不能破）。
- 换识别/外观判定要换代次：`OCR_GEOMETRY_VERSION` / `OCR_GEOMETRY_CONTRACT_VERSION` v6 → **v7**（实底判定与清理图都进 OCR 结果，不换的话浏览器仍读回旧的 `bg_type=none`），两侧逐字同步，两处固定字面值的测试同步更新。
- 验证：新增 Python 两例（`solid_sampling_reference` 的短边口径；`detect_solid_region_for_box` 对竖排列传 40 而不是 300）与 `tests/bubble_colors.test.mjs` 三例（均匀亮色环升级成实底 / 不均匀或深底不升级 / 服务端已判实底的不改写）；服务重启后 `/health` 报 v7，真实整页探针复查容器数 1 → 6。

## 2026-10-02（续）— 思考开关挪进配置档案，并让术语提取一起关掉

- 用户两个要求：① 开关要放在**新建/编辑配置、填密钥那张卡片**里，不要挂在外面；② 问术语提取是否也该关思考。
  两件事其实是一件事：**思考模式本来就是「这一套配置」的属性**（换服务商就得跟着换），放进配置档案条目后，
  共用这套配置库的三个服务（翻译 / 整章术语提取 / 句子级提取）自动一起生效，不用再各配一遍。
- 存储位置：`normalizeVendorEntry()` 保留 `thinkingMode`（`config/vendors.js`）。下发路径两条 ——
  翻译走 `applyVendorEntry()`；两个提取小节走 `overlayVendorEntry()`（`resolveExtractionConfig()` 在
  「跟随翻译服务」时把翻译那份带过去）。提取小节自己也有 `thinkingMode` 默认值，但指向配置条目时
  `withVendor()` 会把它清成 `auto`——小节不再留第二份，否则「删掉配置后残留旧值」会变成静默行为差异。
- 术语提取也要关：一句「翻译是机械任务」同样成立——提取就是「读整章、吐 JSON 数组」，
  而且它按章跑，思考浪费的是整章级别的输出。四处调用点全部接入：
  - 句子级提取两个入口（选中文字 / 整句）在 `term-context-extract.js`：字段进 body，回落走统一助手。
  - 整章提取桌面版：字段算好放进 `upstream.thinking`，本地服务只转发（`models.py` 加
    `thinking: dict`，`api_handlers.py` 只放行两个已知键，`term_extractor.py` **只**转发不自己判断参数名）。
  - 整章提取手机版：`term-extract-llm.js` 同样从 `upstream.thinking` 取，回落走统一助手。
- Python 侧同样带一次剥参重试：不重试的话整条整章提取会在每个分段上先失败一次，
  用户看到的就是「术语一条都收不到」。判据与 JS 侧一致 —— 只有报错**点名**了那两个参数才剥。
- 又踩了一次行数门禁，记在案（这已经是本项目第三次因为门禁触发抽取）：
  - `vendor-ui.js` 加一个表单字段要 5 行，而它当时 397/400 —— 把纯函数 `nextCopyName` 抽成
    `settings/vendor-names.js`（顺带可单测），腾出位置。
  - `term_extractor.py` 一度到 402 —— 去掉 `_post_chunk` 辅助函数、改成 `for attempt in range(2)` 的小循环。
- 测试：`thinking_mode.test.mjs` 里那三个「面板上控件」的用例换成「向导里有控件 + 三个调用点都接上 +
  两条 Python 链路只转发」；`translation_vendor_wizard.test.mjs` 补「新建回默认 / 编辑回填 / 复制带走 /
  脏值收敛」；`translation_vendors.test.mjs` 补条目字段与两条下发路径；`term_extract_llm.test.mjs`
  补「整章提取照抄配置里的思考字段」。
- 一次测试脚手架教训：`term_extract_llm.test.mjs` 原来只桩住网络那一步，而「剥字段重试」现在是产品代码
  （`translation-utils.js`）。改成先 `installTranslationUtils(runtime)` 装真实实现、再用 `Object.assign`
  覆盖网络桩 —— 不能在测试里再写一份回落逻辑，那正是会漂的东西。
- 验证通过：Node 1617/1617，Python 157 passed / 1 skipped，ESLint 与 Pylint 干净，`npm run verify` 全绿。
- 仍未在真机确认：用户走的是 Hono + Cloudflare Workers 中转，**中转站是否原样转发这些参数还没验过**
  （最坏情况是退化成服务商默认，翻译与提取都不受影响）。

## 2026-10-02 — 小说的输出 token 是输入的 2.2 倍：思考模式默认开着，而我们从没发过任何思考参数

- 用户给出 10 条账单（输入 1,574–2,694 / 输出 1,178–11,313，合计 23,818 → 53,292 = **2.24 倍**）。
  关键不是倍数本身，而是**输入几乎相同、输出飘 2.8 倍**（2,416→4,530 与 2,454→11,313）：
  结构性开销（JSON 外壳、固定指令）会给出稳定的比值，飘成这样只能是"每次生成量本身在变"。
  第 7 行 1,574→1,178（0.75 倍）是唯一形状正常的一条，也正好是输入最低、没有术语前言的一条。
- 逻辑上的判据：提示词里装着 system 规则 + 翻译指令 + 术语表 + 前后文 + 正文，**译文只是正文那一部分的重写**，
  输出不可能长过整条提示词。仓库自己的成本模型（`novel-batch.js` 顶部注释）算的也是"输入 ~1250 / 输出 ~600"。
- 取到用户抓的响应体：**存在 `reasoning_tokens`**。而全仓 grep `thinking` / `enable_thinking` /
  `reasoning_effort` / `reasoning_content` **零匹配** —— DeepSeek（`deepseek-flash` / `v4-pro`）、
  GLM 4.5+、Qwen3.5+ 的思考模式**默认就是开的**，于是思维链一直按输出 token 计费，用户没有关掉它的手段。
  旁证：用户在思考模式下设了 `temperature: 0`，而 DeepSeek 文档写明**思考模式忽略 temperature**（不报错、不生效）。
- 修复：新增「思考模式」开关（设置页 → 翻译服务），`auto` / `off` / `on`，**默认 `auto` = 一个参数都不发**
  （升级前后的请求逐字一致，不改变任何已有用户的行为）。
  - `shared/thinking-mode.js` 是唯一定义处：按服务商选 `thinking:{type}`（DeepSeek/GLM/火山）或
    `enable_thinking`（千问/Ollama）；**认不准的一律两种都发** —— 中转站（one-api / new-api 这类）看不出背后挂的是哪家，
    而这恰恰是自建小说翻译最常见的接法。
  - 被拒时**只剥掉被拒的那一组**重发：`translation-utils.js#sendTranslationBodyWithFallbacks`。
    两组合成一个信号的话，服务商不支持 `json_object` 时会连用户的「关闭思考」一起丢掉，那条设置就永远不生效。
    端点被拒过一次就记下来，后续请求直接不发 —— 被拒的请求没有输出、不计费，但白等一个来回的延迟是实打实的。
  - 三条翻译链路（小说整章 / 排版对齐 / canonical 批次）统一走这个助手，不再各抄一份回落。
  - 本地服务的流式链路（`translation_stream.py`）**不自己判断参数名**，只转发扩展侧算好的字段；
    上游不认时剥掉重发一次（不重试的话整条流式链路会在每个批次上先失败一次，白白退到渐进小批）。
- **它不进任何缓存键**（小说块缓存键与 canonical 指纹里都没有）：思考模式只影响模型怎么想，不影响给定输入该产出什么译文，
  所以来回切开关不会让已经翻好的内容重新计费。
- 一次踩坑记在案：`configure.js#requestCanonicalTranslationBatch` 那个接缝一开始被我加上了
  `runtime.buildOpenAICompatibleEndpoint` + `runtime.thinkingRequestFields` 两个运行时依赖，
  `architecture_contracts.test.mjs` 的"最小 runtime"用例当场报 `not a function`。
  改成在接缝里调**纯函数** `thinkingMode.thinkingBodyFields(...)`、端点记忆下沉到回落助手里，接缝回到"只读配置 + 转交"。
- 测试：新增 `tests/thinking_mode.test.mjs`（15 例：取值收敛、按服务商选参数名、三组回落路径、限流不误记端点、
  剥字段不改原对象、三条链路都带上了、开关不进缓存键、设置页选中即保存 / 失败回退）。
- 用户环境上还有一件没处理的事：请求走的是 Hono + Cloudflare Workers 的中转网关，
  **中转站会不会原样转发这个参数还没在真机上确认过**（已实现"被拒就剥掉重发"，最坏是退化成服务商默认）。
- 验证通过：Node 1611/1611，Python 157 passed / 1 skipped，ESLint 与 Pylint 干净，
  桌面版与手机版构建成功，`npm run verify` 全绿。

## 2026-09-30（续 3）— 第二行没遮罩：接缝只读到一行、页级读到两行，而我把"按四边形裁"写成了硬规则

- 用户反馈（重载后）：那句「在你准备好房间的时候」上方一行有遮罩、**下方一行没有**。
- 真机取证（这次是**一次连接、之后复用**的 watcher 探针；Chrome 的远程调试服务器每个新客户端都要授权一次，反复连就是反复弹窗 —— 教训记在案）：
  - 该句由跨页 overlay 渲染；遮罩段节点 `::before` 的 `background: #ffffff` 正常、`clip-path` = `polygon(3.61% 13.72%, 99.55% 13.72%, 99.55% 54.25%, 3.61% 54.25%)` —— **只盖住目标框上面约 40% 的一条带**。
  - canonical 的几何：文字页有**两条** span —— 接缝 span（`textBox` = 自然坐标 y 30..90 = 只有第一行）与页级 span（`box` = y 10..157 = 两行都在）；`page_cover_boxes` 是两者的**并集**（两行 ✓），但 `bubble.polygon` 来自接缝观测 = **只有第一行**。
  - 于是"按 `bubble.polygon` 裁"= 用第一行的四边形去裁两行的框 → 第二行被裁掉。把 DOM 的 clip 反算回自然坐标，正好等于接缝那一行的范围（30..90），与推断完全吻合。
- 根因：上一轮我把 `applyCoverSegmentTilt` 的 `mustClip`（实底遮罩"无条件按四边形裁"）当成硬规则，而**裁剪的原始设计意图只服务「斜排原文」**：轴对齐文字的覆盖区域本来就等于这一页 OCR 给的框，再按一个更小的四边形裁只会砍掉同一气泡的其它行。同一轮修的坐标平移让 clip 第一次真的生效，于是这个隐患当场暴露。
- 修复（`crosspage-cover.js`）：重新只按 `geometry.coverTilted`（斜排）裁剪；实底遮罩一律画 `page_cover_boxes` 里这一页的段矩形整块（有采样色就画，没采到色才透明）；保留上一轮的坐标平移（斜排裁剪是真的生效了，而不是"没裁"）。`mustClip` 参数删除。
- 测试：`cross_page_overlay_dom.test.mjs` 改写实底用例（轴对齐 + 四边形只覆盖一行 → **整块矩形上色、不裁剪**）+ 把坐标平移用例改成斜排（`coverTilted: true`）才有意义；`overlay_style.test.mjs` 锁"裁剪只服务斜排"（断言 `if (!quad || !geometry.coverTilted)` 且不得再出现 `mustClip`）。
- 通用教训：**"裁剪"是形状提示，不是覆盖范围的来源** —— 覆盖范围必须来自"这一页全部证据的并集"（`page_cover_boxes`），形状只能在它与证据一致时用来修剪边缘；把提示升格成硬规则就会拿局部证据砍掉整体。

## 2026-09-30（续 2）— 真机连上看清了：跨页遮罩的裁剪是两套坐标系，加上我上一条"缺轮廓就透明"把原文漏了出来

- 用户反馈：那句「在你准备好房间的时候」（原文 `네가 머물방을 준비할 동안`，`lezhin.com/ko/comic/gods_will/5`）现在**完全没有遮罩**，原文裸露。
- 这次直接连上真机看（Chrome 154 的远程调试服务器 + `DevToolsActivePort` 里的 WS 端点；注意：**每建一个 CDP 客户端都会弹一次授权**，用户被弹了好几次 —— 排查时应合并成一次连接，别反复连）：
  - 该句由**跨页 overlay** 渲染（`canonical_be3e6b94…` 被 seam surface 接管，两页的页级投影都是空数组），所以遮罩来自 `crosspage-cover.js`，不是页级 `::before`。
  - 实测那个 `.mt-cover-segment`（在文字所在页）：`background: rgba(0,0,0,0) none`、`background-image: none`、`clip-path: none`、`data-cover-tilted="false"` —— 就是"没有遮罩"。
  - 气泡数据齐全：seam 观测 `bgType: "solid"`、`bgColor: "#ffffff"`、`polygon`（文字四边形）、`regionPolygon`（气泡轮廓，y 36.84%→100% 跨过分页线）都在，**不是**"没颜色/没轮廓"。
  - span 级新契约在真机上生效：上一页 `hasTextPixels: false`（textBox/fillBox 都是 null）、文字页 `true` ✓，且该页 `page_cover_boxes` 只剩文字页 ✓。
- 根因（两条）：
  1. **坐标系不一致（老 bug，被这次放大）**：`mapCompositePointToRoot` 返回 **root 坐标**，而 `updateCoverSegments` 传进 `applyCoverSegmentTilt` 的节点矩形是**覆盖层局部坐标**（相差覆盖层原点 max(0, outer.left/top)；现场 root≈3570 vs 局部 0~82）。于是映射点与节点矩形**永远不相交** → `clip-path` 恒为空：**斜排跨页遮罩从来没真正裁过**（`crosspage_cover_tilt` 的用例用的是恒等映射，所以一直没抓到）；实底遮罩则被我上一轮的新规则判成"裁不出来"。
  2. **我上一轮的口径太硬**：`solidColor && solidOutline && clipped` → 缺任一条就 `transparent`。「缺轮廓就透明」在跨页这条路上是错的方向：段矩形本来就从 `page_cover_boxes` 按页映射出来，不会串页，把它置透明只会让原文裸露。
- 修复：
  - `crosspage-cover.js`：`applyCoverSegmentTilt` 增加 `context.offsetX/offsetY`（= `max(0, geometry.outer.left/top)`），映射点先平移到覆盖层局部坐标再与段矩形求交；`updateCoverSegments` 传入该偏移。
  - 口径统一为一条：**量到颜色就必须遮住原文，形状尽力而为** —— DOM 侧（`lifecycle-bubble`）、跨页段（`crosspage-cover`）、嵌入式画布（`renderer-embed`）三处一致；只有**没采到采样色**时才透明（`.mt-fill-unbounded` / `background: transparent`），形状拿不到轮廓就退回本页自己的盒/段矩形。
- 测试：`cross_page_overlay_dom.test.mjs` 的实底用例改写（没颜色→透明、有颜色无轮廓→按本页段矩形上色、有颜色有轮廓→裁剪上色、缺坐标映射→仍上色），并**新增**「必须先平移到覆盖层局部坐标」正反两例；`overlay_tilt.test.mjs`、`overlay_style.test.mjs` 同步新口径与坐标系断言。
- 尚未处理（记一笔）：同一句在库里是**两条 canonical**（`canonical_f42c4ade…` 与 `canonical_be3e6b94…`，几何几乎相同）—— 这很可能就是"两个蓝框"的来源之一，值得单独查。
- 通用教训：**跨模块传递坐标必须写清坐标系**（`*ToRoot` / 局部），否则 clip 这类"求交集"的逻辑会安静地恒空；以及**"宁可透明"只适用于"画出来一定是错的"情形**，形状不完美不等于该放弃遮盖。

## 2026-09-30（续）— 那个「大的蓝框」：空壳 span 也进了文字框与遮罩框

- 用户追问（口径正确）：设计上只有遮罩层（= 最终文字并集 + 覆盖范围外扩一点点）与译文层（文字并集内自适应），**为什么会出现一个大的蓝框**。
- 取证：
  1. 小蓝框 = 页级 OCR 的最终文字并集（`ocr-display-geometry.js#buildLocalPaddleDisplayBox` 注释："蓝框只围绕最终文字并集保留小幅留边；气泡区域只用于边界约束和背景判断"）。
  2. 大蓝框 = **跨页 overlay 自己的外框**：`scene-crosspage.js:239` `outer = unionRects([...coverSegments, textBounds])`，蓝边来自 `styles.css:56` 的 `.mt-cross-page-debug::after`（`renderer-crosspage.js:142` 加类）。它必须同时装下「每一页的遮罩段」+「一个文字层」，所以只要上一页也有一条遮罩段，它就跨两页。
  3. 上一页那条遮罩段的来路：`seam-handling.js#describeSeamOcrCandidate` 的 `visualCrossesBoundary`（**容器**跨边界 + 文字离边界不超过边缘窗口即算跨缝）让"文字全在下一页"的候选活了下来；`observation-results.js:226-233` 随后**故意**把这一页贡献扩成整个视觉容器（注释：页面贡献必须覆盖完整视觉容器，双页渲染面必需）。
  4. 于是 `canonicalSeamPageBoxes` 的 `textBox || … || span.box` 兜底把空壳 span 也算进**文字框**（`projection-utils.js:37`），`cover` 同样带上它 —— 文字框被撑高、译文跟着偏移，遮罩段与调试外框一起跨页。
- 修复（生产端显式声明 + 消费端只认显式 false）：
  - `background/modules/observation-results.js`：span visual 新增 `hasTextPixels = Boolean(textBoxOnPage || polygonOnPage)`（文字框与文字四边形任一落在本页即算有文字；只在配置了 pageSpans 的分支写，普通页请求不写）。
  - `canonical/reconciler-modules/reconciler-observation.js#normalizePageSpan`：三值透传（缺字段 → `null`，**不塌成 false**）。该字段不进 `observationIdentityPayload`，观测 id / canonical revision / 译文缓存键全部不变。
  - `canonical/modules/projection-utils.js#canonicalSeamPageBoxes`：`hasTextPixels === false` 的 span 同时不进 `text` 与 `cover` —— 后者是 `buildCleanedArtifactProjectionPlan` 的清理掩膜来源，遮盖与擦除必须同进同退；并已核对 seam 擦除掩膜取的是文字/蓝框级并集（`buildSeamSurfaceBubble` 的 `box` 来自 `structuralBox || witnessBox`，两者都基于文字框），所以撤掉遮盖不会露出涂抹痕迹。
  - `canonical/reconciler-modules/reconciler-projection-utils.js#pageCoverIsEligible`：**整页几何都被显式声明 false** 时不发 cover 投影（连带挡住 standby 补遮罩与该页清理掩膜）；未声明的一律按"可能有文字"处理 —— 这正是上次直接回退的那条闸门踩过的坑。
- 测试：`seam_cut_line_evidence.test.mjs` +1（合成"容器跨缝、文字全在下片"的现场，断言上一页 `textBox: null` + `hasTextPixels: false`、下一页 true、普通页请求不带该字段）；`canonical_render_plan.test.mjs` +1（该页不进 text/cover，也不再要清理掩膜；带**对照组**证明不是"恰好落在捕获带内"）；`kakao_reconciler.part03.test.mjs` +2（三值契约、只有显式 false 才收窄 + 混合几何必须保守）；`cross_page_overlay_dom.test.mjs` +1（收窄后 overlay 只剩一个遮罩段、外框不再跨到上一页）。定向 144 例全绿。
- 通用教训：**「空壳几何」必须在生产端打标，不能指望下游从几何反推** —— `textBox` 在归一化时被抹成 null，"确实没有"与"没记录"从此分不开（上次硬猜直接打掉正常遮罩）；以及 **`x || y || z` 式的兜底取值会把"没有"当成"有"**，跨页文字框就是这么被撑大的。

## 2026-09-30 — 跨页实底气泡遮罩溢出：纯色补丁按包围盒画在上一页 + 没采样色时兜底纯白

- 用户反馈（lezhin 页；`lezhin.com` 不在 `site-hints` 名单里，走通用 canonical 链路）：某个跨页气泡（气泡框跨分页线、**文字像素全在下一页**）在**上一页**顶部长出一条明显白色实底长条；同一处调试框显示文字框被撑大，白条是直角、不贴合弧形气泡轮廓。
- 取证（读码定位，三条路径同一处缺陷）：
  1. **逐页 DOM 覆盖层**：`lifecycle-cover.js#buildBubbleCoverProjection` 把 `region_polygon` 清成 `null` → `lifecycle-bubble.js` 写不出 `--mt-region-clip` → `.mt-bg-solid::before` 用 `clip-path: inset(0)` 铺满 `x/y/w/h` 包围盒。跨页气泡在上一页的几何恰好只剩矩形（`region_polygon` 是唯一还在的轮廓，文字四边形不与这一页画布相交）。
  2. **跨页（接缝）遮罩段**：`crosspage-cover.js` 对 `bg_type=solid` 直接 `background = bg_color || "rgba(255,255,255,.96)"`，且只有斜排（`coverTilted`）才加 clip-path —— 轴对齐实底永远是**矩形**，没采到色时就是**纯白**。
  3. 嵌入式画布 `renderer-embed.js` 同型：无轮廓时照画 `fillBox` 矩形、`bg_color || "#ffffff"`。
- 修复（渲染层，一个口径：**轮廓 + 采样色缺一不可，缺了保持透明**）：
  - `rendering/cover-geometry.js` 新增 `resolveSolidFillOutline(source)`：容器轮廓 `region_polygon` 优先、文字四边形 `polygon` 兜底，拿不到返回 `null`（三条路径共用这一处定义）。
  - `lifecycle-cover.js`：覆盖投影**保留** `region_polygon`（`fill_box` 仍清空，避免与背景估计求并集把盒子撑大）。
  - `lifecycle-bubble.js`：实底填充统一按轮廓写 `--mt-region-clip`；无轮廓或无 `#rrggbb` 采样色时加 `.mt-fill-unbounded`（`styles.css` 关掉 `::before` 与 `.mt-fill-tilted`）→ 透明；顺带删掉"横排 ≤2° 才写 clip"的第二条路径。
  - `crosspage-cover.js`：实底遮罩段要求轮廓非空 + 采样色，并**无条件**按映射后的四边形裁剪（`applyCoverSegmentTilt(..., { mustClip })` 返回是否裁成功）；缺任一条 → `background: transparent`，纯白兜底删除。
  - `renderer-embed.js`：画布实底同样要求轮廓 + 采样色，否则一个像素都不画。
- 测试：`overlay_tilt.test.mjs` +4（DOM 轮廓/颜色缺一不可、容器轮廓优先、覆盖投影保留轮廓、画布实底不画）；`cross_page_overlay_dom.test.mjs` +1（跨页实底四种组合）；`overlay_style.test.mjs` 锁住"覆盖投影不得再清空 `region_polygon`"与新类名。全量 `npm run verify` 通过（Node 1589、Python 157+1 skipped、行数门禁、ESLint、构建）。
- 未做（有意）：曾给 `reconciler-projection-utils.js#pageCoverIsEligible` 加「这一页没有文字像素就不发 cover」的闸门，但 `normalizePageSpan` 会把**所有** span 归一成 `textBox: null`，无法区分「没记」与「确实没有」，实测直接打掉正常的跨页 duplicate cover（`kakao_reconciler.part03` 立刻红）→ 回退。渲染层修好后这类 cover 已被裁剪 + 同色，不再产生可见白条。
- 通用教训：**「没数据」与「数据为空」必须在契约层面分清**（`region_polygon` 被当成"没有"清掉，恰好清掉了唯一可信轮廓）；**兜底纯色永远比透明更糟** —— `.mt-bg-none` 早就写明"绝不画纯色补丁"，实底路径漏了同一条规矩。

## 2026-09-25（续 4）— 手机版点译文段落跳「找不到文件」：桌面专属回退撞上无拦截的旧包，装配期整段取消

- 用户反馈：**手机上点击某个已翻译的段落 → 跳到「未找到文件」界面**。用户明确口径：**取消这个行为，不是给手机版补 sidepanel**。
- 取证：点段落链路 = `novel-focus-click.js` 发 `OPEN_NOVEL_SIDEPANEL` → 桌面 `bootstrap.js#openNovelManageUi`（sidePanel.open 失败回退 `chrome.tabs.create(chrome.runtime.getURL("sidepanel.html"))`）。手机版从出生提交（88a3da7）起 `background-local.js` 就覆盖 `openNovelManageUi` 返回 ok:false —— **最新构建点段落无事发生**；真机装的是开发中途旧包（内容脚本已有点击、后台还没有拦截）→ 走桌面回退 → 打开手机包里不存在的 sidepanel.html → ERR_FILE_NOT_FOUND。用户确认现象即「未找到文件」。
- 修复（手机上点段落 = 什么都不做）：
  - `novel-mobile/content.js`：runtime 字面量加 `IS_NOVEL_MOBILE: true`（必须在 `contentPhases.functions` 装配循环之前就位）。
  - `content/modules/novel-focus-click.js`：`installNovelFocusClick` 开头 `if (runtime.IS_NOVEL_MOBILE) return;`（在 `isNovelReaderHost` 之前，装配期拦截，监听根本不挂）；桌面版零改动。
  - 双保险保留：`background-local.js` 的 ok:false 覆盖原样。
  - `novel-mobile-assets/manifest.json` 1.1.0 → **1.1.1**（版本号可见化，用户能在扩展页确认装上新包）。
- 测试：`tests/novel_focus_click.test.mjs` 扩到 **13 例**（新增「手机版不挂监听、点击不发消息」；QA 实证：若删 guard，KakaoPage hostname 命中名单 → 监听挂上 → 断言即红）。全量 Node 回归 **1570/1570**（`NODE_OPTIONS=` 前置）；ESLint 与行数门禁干净；双端重建 + `pack-novel-mobile.mjs` 产出新 zip/crx（CRX3 签名自检过）。
- 交付：`dist/novel-mobile.zip` / `.crx`（1.1.1）——手机上删旧装新、刷新阅读页后点段落应毫无反应。
- 备注：这几个文件的 diff 里还混着 9/25 RIDI 接入的未提交改动（QA 记录在案），与本修复无关但同批未提交；本次改动**未提交**（工作区 WIP 保护）。
- 通用教训：**手机版是「桌面共用模块 + 覆盖层」的减法产物，桌面专属功能的所有入口必须在装配期缺席**——后台消息拦截只兜得住「消息能到后台」的路径，挂监听这类入口根本不经过后台。以及：**查手机 Bug 第一步先确认真机上是哪一刻的构建**，包版本永远存疑。

## 2026-09-25（续 3）— 分片被剪断那行还是两份：提示被后台白名单丢掉 + 文本不可比时缺「几何同一行」判据

- 复验（第二次重载后）：跨页面已横跨分片边界、面板被吸收成一条气泡，但页级仍留一个 `'지오의조정화]` 的小气泡盖在第一行下半截上 —— 用户描述为「另外一个框是第一行的一半和剩下的行」。
- 取证（`data-mt-*` + 现场 OCR 产物）：
  - 内容侧确实发了接缝带提示（新加的 `data-mt-ocr-hint` 读到 `{strip:true,width:1280,band:96}`），但**后台入口 `normalizeImageMeta` 的白名单把它丢了**：`ocr-pipeline.js` 用 `normalizeImageMeta(message.imageMeta)` 重建 imageMeta，字段表里没有 `edgeLineBandPx` → 聚类永远收不到提示 → 页级面板仍是三行合一。这就是「提示没发」与「后台没用」之间的第三段断链（内容 → 消息 → 白名单 → 聚类）。
  - 补上透传后页级正确拆成「被剪断的那一行」+「其余两行」；但现场这一次复合图把左右两半**合成了一条观测**（原文 `[지오의 초상화]`），与页级残缺读法 `'지오의조정화]` 的模糊子串相似度只有 0.69（< 0.80），同一行仍裂成两条 canonical：接缝面一条、页级一条，后者还盖在接缝面上。
- 修复：
  - `background/modules/ocr-item-filter.js`：`normalizeImageMeta` 白名单补 `edgeLineBandPx`（`toNumber(..., 0)`）—— 契约是「内容侧发的提示必须原样到聚类」。
  - `canonical/reconciler-modules/reconciler-seam-eval.js`：`relationBetweenSeamAndPage` 从 `reconciler-canonical.js` 搬过来（那边顶到 400 行门禁），并新增 `seamPageGeometryDuplicateRelation`（几何同一行）+ `sharedComparableRun`（最长连续公共片段）。判据：同一页上两边框互相覆盖 ≥ 0.8、水平中心对齐 ≥ 0.85，**且两侧文本至少共享一段 ≥ 较短一侧 30% 的连续片段**。现场那行共享 `지오의`（3/8）✓；「同位置却互不相干的接缝」共享 0~1 字符 → 继续各走各的（三条既有护栏用例原样通过）。
  - `content/modules/recognition-seam.js`：接缝带提示取值提到一处，并把「有没有带上」写进 `data-mt-ocr-hint`（与既有 `data-mt-mask-report` 同类的主世界诊断）。
- 测试：`tests/seam_cut_line_evidence.test.mjs` 扩到 8 例，新增「后台入口必须原样透传接缝带提示」与「复合图合成一条完整读法时，页级残缺读法仍按几何认作同一行」（后者**实测去掉几何判据即红**）；`tests/strip_tile_reader.test.mjs` 新增「分片页请求带接缝带提示」。全量 Node 回归 **1569/1569**；行数门禁与 ESLint 干净。
- 真机终检（第三次重载后，`ridibooks.com/books/6305000008/view`）：那一块只剩**一条**跨页面气泡 —— 原文 `[지오의 초상화] 탐색3일차, 종료`、译文 `[地奥的肖像] 探索,第三天,结束。`，框 463×256 横跨分片边界；`data-mt-ocr-hint` = `{strip:true,width:1280,band:96}`；页级 `'지오의조정화]` 残留气泡消失，DOM 全文检索只剩这一条命中。
- 通用教训：**跨模块提示要一路验到消费点**——这次提示「发了、也带了」，却死在后端入口的白名单重建上；白名单式的字段归一化必须与新增契约同步，否则表现为「上游明明发了、下游就是没反应」。以及：**文本判据失效时要有几何兜底，但几何兜底必须带一点文字证据**，否则同位置的不相干证据会被并进来（既有护栏立刻抓到）。

## 2026-09-25（续 2）— RIDI 小说接入小说模式（桌面版 + 手机小说版）

- 用户需求：**想把 ridi 的小说界面加入小说模式**（`ridibooks.com/books/6224000125/view`），随后补一句**小说版的插件也要**（手机小说版同样要能翻 RIDI）。
- 真机取证（连用户已登录的 Chrome，同一 URL；并对比 RIDI 漫画页 `/books/6305000008/view`）：
  - 小说正文在**普通 DOM** 里：`#viewer_contents > div > div._container_* > div.css-*[._isScrollMode_*] > div.css-* > h2/p…`，**全章一次进 DOM**（内容来自 `webview-cache-epub.ridibooks.com/{话id}/epub/Section0001.xhtml.json`，EPUB 分节，长章会随滚动续载）。
  - **段落没有任何标识**（KakaoPage 的 EPUB 阅读器会打 `data-p-id`，RIDI 一个都不打）；类名是构建期哈希（`css-hafgtc` / `_container_d25rb_1`），换一次构建就变。
  - 一个短章 88 个块里 **51 个是 `<p><br></p>` 空行**；正文首段带一长串 U+2060/U+2063 零宽水印（视觉上没有，会原样进提示词与缓存）。
  - 作品级 id 不在 URL 里（URL 是**这一话**的 id）：`window.itemId`=6224000001、`window.itemEpisodeId`=6224000125，但那是**主世界**全局，isolated content script 读不到；阅读器自己渲染的作品标题链接 `#viewer a[href*="/library/books/"]`（`/library/books/8480770/`）里能读出作品 id 与作品名。
  - 漫画页只有 `#viewer`、没有 `#viewer_contents` —— 小说/漫画的判据天然是「有没有正文容器 + 有没有段落」。
- 结构（不是加分支，而是把「站点」收敛成适配器）：
  - 新增 `shared/novel-hosts.js`：域名判据的**唯一真源**（Kakao/RIDI/RIDI∪Kakao）。装配期（`novel-focus-click` 决定要不要挂监听）与 state 阶段（`reader-state` 写 `IS_*_READER`）用的是同一份名单 —— 顺手修掉一个既有缺陷：`runtime.IS_KAKAOPAGE_READER` 要到 state 阶段才写入，装配期读到的永远是 `undefined`，所以**「点原文打开修订面板」在真机上从来没挂上过**。`readers/site-hints.js` 的 RIDI 正则也改为复用这一份（同一家站点在「分片长条」与「小说阅读器」两套判据里不会再有第二个定义）。
  - 新增 `content/modules/novel-paragraph.js`：段落锚点契约 + leaf 判据 + 原文出口。锚点是**两个**属性名：Kakao 的 `data-p-id`（页面所有，只读）与 RIDI 的 `data-mt-novel-pid`（我们盖章），消费方一律走 `surface.anchorAttribute`，不硬编码。
  - 新增 `content/modules/novel-kakao-reader.js` / `novel-ridi-reader.js`：两个适配器（表面发现 + 章节抽取），`novel-reader.js` 只剩站点无关的「分发 / 签名 / 重扫 / 回填」。
  - RIDI 段落身份**按内容寻址**（`c{内容哈希}#{出现序号}@{哈希}`），锚点值就是内容哈希。理由：RIDI 是 EPUB 分节续载，DOM 序号会漂移；内容寻址让「同一段」在任何时刻都是同一个 id，译文与缓存不会认错段。空行不盖章、不计入 `chapter.paragraphs`（否则缓存覆盖率永远到不了「完整」、进度分母虚高）。
  - 章节身份：`chapterId` = URL 里的话 id，`seriesId`/`scopeKey`(`ridi:{作品id}`) = 作品标题链接里的作品 id（读不到就退回话 id，作用域退化成「一话」）；标题优先取 `og:title`（浏览器整页翻译会改写 `document.title`，og:title 不会）。
  - 零宽水印在**原文出口**（`getOriginalNovelParagraphText`）统一清掉：抽取与回填都走这个出口，源文哈希不会两边对不上。
- 运行时 API 去站点化（一处改名、全部调用点同步）：`findNovelSurface` / `extractNovelChapter` / `collectNovelImages` / `reconcileNovelReader` / `reconcileNovelIfStale`；`floating-states` 的 `kakaoReader` → `novelReader`（不可用文案改为「当前页面不是已支持的小说阅读页面」）。桌面版与手机版共用同一份 `contentPhases`，所以手机小说版**不写一行站点代码**就跟着支持 RIDI。
- 顺带修的两处真缺陷：
  1. `renderNovelTranslation` 加了「同内容不重写」记账（`state.renderedKeys`）。reconcile 会因自己插入的包裹节点被观察器看到而重扫，没有这层判断就是「写译文 → 触发观察器 → 再重扫 → 再写译文」的每 80ms 重写全文循环（Kakao 与 RIDI 都吃这一条）。
  2. `reconcileNovelIfStale` 恢复成**晚绑定** `runtime.reconcileNovelReader()`（手机版与测试靠覆盖这个属性做替换，直接调内部函数会让覆盖静默失效）。
- 手机小说版：`novel-mobile-assets/manifest.json` 的 `content_scripts.matches` 增加 `https://ridibooks.com/*` 与 `https://*.ridibooks.com/*`（仍不全站注入），名称/描述/弹窗与设置页品牌文案改成「KakaoPage / RIDI」。`apply-url-widen.js`（「一键加入应用」把章节网址放宽成作品网址）**故意不放宽 RIDI**：作品 id 不在 URL 里，唯一能猜的放宽会把所有作品一起纳入（范围错比范围窄更糟），已在注释里写清并提示留空应用网址。
- 测试：新增 `tests/ridi_novel_reader.test.mjs` 13 例（位置解析、漫画页不误判、正文重复渲染只取一条分支、内容寻址 id 与重复段落序号、空行不计入、水印清理、盖章锚点的回填与定位、同内容不重写 DOM、换话清空状态、站点名单唯一真源、RIDI 页面上三个 reader 标志）。`novel_focus_click` 改为「小说阅读站才挂监听（KakaoPage 与 RIDI 都算）」并新增盖章锚点用例；`novel_mobile_manifest` 增加 RIDI 注入断言；`floating_states` 跟随 `novelReader` 改名；`novel_renderer_inline_format` 增加「镜像壳也不许带盖章锚点」。
- 验证：`npm run verify` 全绿（行数门禁 production 400 / tests 800、`eslint extension/src`、Pylint、构建、**Node 1569/1569**、Python 154 passed + 1 skipped）；`node scripts/build-novel-mobile.mjs` 与 `scripts/check-novel-mobile-dist.mjs` 通过。真机（RIDI `6224000125`，重建扩展后刷新页面）：小说球由「不可用（未识别为 Kakao 小说页面）」变为可点（「小说翻译 / 点击显示中文译文」）；正文 88 个块中 37 个非空段落盖章、51 个空行不盖章，id 无一重复；作品 id `8480770` / 作品名 / `og:title` / 话 id `6224000125` 四项都取到。渲染层在真机 CSS 上实测（手工复刻 `renderNovelTranslation` 的 DOM 形态后量 computed style，再还原）：「原文包裹」`display:none`，译文逐项继承段落的颜色/字号/字体/行高（`rgb(0,0,0)` / 18.4px / Pretendard / 30.728px），`user-select` 被改回 `text`（RIDI 全站 `user-select:none`）。漫画页（`6305000008`）行为不变。**未做**：没有真跑一次 LLM 翻译（用户选择自己点，避免消耗额度与写入译文库）。
- 通用教训：**「这个站点是不是小说阅读器」必须是装配期就能回答的事实，不能依赖晚一阶段才写入的 runtime 标志。** 以及：**站点差异要收敛成适配器，而不是在管线里加 `if 站点`**——RIDI 只写了「怎么找正文、怎么定身份」，切块/翻译/渲染/缓存一行都没改。

## 2026-09-25（续）— 同一行被画两遍：页级段落吞掉了被剪断的行 + 相邻行吸收差 0.05 容差

- 真机复验第一轮修复后（用户重载扩展+刷新）跨页遮罩已横跨分片边界，但同一面板出现两份覆盖：接缝面盖住被剪断的标题行 `[吉奥的肖像]`，页级面板气泡又把这一行（带着误读 `조정화`）连同下面两行再翻一遍。
- 取证（本地 OCR 服务当次产物 + 探针）：
  - 页级整页 OCR 的三行（`'지오의조정화]` / `탐색3일차,` / `종료`）被**聚类并成一条 paragraph 观测**（`탐색3일차, '지오의조정화] 종료`），接缝证据于是没有可挂载的对象 —— 复合图读到的那一行只能自成一条 canonical。
  - 接缝面本可吸收「同一面板的相邻行」（`seam-residuals.js` 的 `adjacent_line`：吸收后框取并集、译文逐行并入、页级气泡被摘掉），但实测几何差一点点：标题行框高 7.42%、正文行组从 5.21% 起 → 重叠 2.21% = 较矮行高的 **0.30**，旧上限 `minHeight * 0.25` 把它挡在门外。
- 修复：
  - `background/modules/ocr-lines.js`：新增 `isLocalPaddleEdgeCutLine`，`buildLocalPaddleParagraphGroups` 在分组**之后**把「真的贴住画布边（笔画被剪断）」的行摘出来单独成组。判据是「贴边」（容差按行高 8%，OCR 框常比笔画内缩一两像素），不是「落在边缘带里」—— 后者会把带内正常行也拆成单行气泡。其余行保持原段落（在连通图上断开会让同段邻行也各自成组，实测过）。
  - `content/modules/recognition-seam.js`：分片页的整页 OCR 请求带上 `imageMeta.edgeLineBandPx`（= `calculateKakaoSeamCaptureBandHeight`，1280 宽分片为 96），后台才有依据判断哪一行贴边；接缝请求本身跨两页，不带这个提示。
  - `background/modules/ocr-clustering.js` / `ocr-provider.js` / `ocr-dispatch.js`：把提示透传进聚类。
  - `canonical/modules/seam-residuals.js`：相邻行吸收的重叠容差 `minHeight * 0.25` → `0.4`，与实测的 0.30 对齐；`pipeline-api.js` 补 `isSeamAdjacentBubbleLine` / `collectSeamSurfaceOwnership` 两个取证入口。
- 结果（复现台，现场真实几何）：页级观测由 1 条（三行）变 2 条（被剪断的标题行 + 正文两行成段）；接缝证据与标题行合成一条 canonical（原文 `[지오의 초상화]`、几何覆盖两片）；面板其余两行作为 `adjacent_line` 被接缝面吸收 → 整块并成一条气泡，页级气泡从渲染里摘掉。
- 测试：`tests/seam_cut_line_evidence.test.mjs` 扩到 6 例（新增「页级聚类摘行」「接缝面吸收相邻行」；两例都**实测修复前为红**），`tests/strip_tile_reader.test.mjs` 新增「分片页请求带接缝带提示」。全量 Node 回归 **1554/1554**；行数门禁与 ESLint 干净。
- 通用教训：**多行块与「被页边界剪断的行」在聚类阶段就必须分开**（一个是本页内部单元，另一个有一半在邻页）；而**吸收判据的容差要拿实测几何校准**——差 0.05 个行高，整块内容就会被画两遍。

## 2026-09-25 — RIDI 分片边界劈开的整行字：接缝跑了、证据被「带宽 × 1.5」的跨缝上限全丢

- 用户反馈：**「探索第3天……」那条覆盖框没有完全对齐原图，因为是截页，好像只识别到了下面那一部分、上面的抛弃了**，问是不是没达成截页判断、于是没做截页合并。
- 真机取证（连用户已登录的 Chrome，RIDI `ridibooks.com/books/6305000008/view`，1280 宽分片 / 带宽 96）：
  - `img[data-mt-seam-diagnostics]`：这一对分片（上片 `c5f2a563` / 下片 `ad0902ba`）`status: "completed"`、`reasons: ["lower_ocr_edge","lower_visual_edge"]`，但 `observationIds: []`、`filteredObservationIds: [一条]` —— **接缝跑了、一条证据都没留下**；canonical 的 `geometryPageIds` 只有下片、`sharedSeamObservationIds: []`、没有跨页面（`surfaces: []`）。
  - 本地 OCR 服务调试产物给出同一结论：上片整页只拿到 59px 字头碎片（乱码 `[기0 이 국 사히`，0.70 被服务端丢掉）；下片整页把字身读成 `'지오의조정화]`（0.81）；而**接缝复合图（1280x192）把这一行正确识别成 `[지오의` / `초상화]`（0.99）**。
  - 把三份真实产物喂进真实代码复现（新探针 `tmp_pairing_tests/repro_ridi_seam_merge.mjs`）：两个框双双被判 `seam_not_cross_boundary`，接缝 observation 数为 0。
- 根因（两层，都必须修）：
  1. `background/modules/seam-handling.js` 把「跨缝」定义成 `rawBox.height <= maxCrossHeight`，而 `maxCrossHeight = max(48, 带宽 × 1.5) = 144`。被劈开那行聚类后字高 150~153px，于是一个**完整落在复合图内部**（上下都不贴画布边）的整行被当成「不跨缝」丢掉。字高不该由带宽决定：带宽是给接缝上下文用的，特效字完全可能高过它。
  2. `canonical/reconciler-modules` 逐条挂载接缝观测：复合图把一行切成左右两个框时，只有一个框能通过文本关联到达 canonical，另一个自成一条 —— 同一行变成两条 canonical，各带半句原文、半幅几何，跨页遮罩自然只盖住一半。
- 修复：
  - `seam-handling.js` 新增 `seamLineFitsComposite(rawBox, imageSize)`：框严格落在复合图内部且不超过画布高的 90% → 视为「被劈开的一整行」，不再受带宽 × 1.5 限制；「整幅场景框」（贴住画布边或占满高度）仍被原上限挡住（新常量 `SEAM_CROSS_MAX_LINE_COVERAGE = 0.9`，`background-state.js`）。
  - `reconciler-seam-eval.js` 新增接缝证据身份 `seamCaptureKey`（单一真源，片段分组的同名函数改为委托它）、`seamEvidenceCaptures`（按证据分组，只收真正跨页的观测）、`resolveSeamCaptureRoot`、`attachSeamEvidenceToComponents`（**同一次复合图的观测作为一份证据整体挂载**）、`joinSeamCaptureMemberText`（整份证据按页/纵向顺序拼出整行，剔除被包含的重复读法）。
  - `reconciler-projection.js` 的挂载循环改为调用整体挂载；`reconciler-canonical.js` 的 `chooseCanonicalText` 在「整份证据都在本 canonical」时优先用拼出的整行，但页级读法更长时保留页级（页级证据还带着这一行以外的内容，例如整个面板的其余行）。
- 复现台修复后：`canonical_572333e0…` 原文 `[지오의 초상화]`、3 个成员（下片碎片 + 左右两半）、几何覆盖两片且上下片各自都盖到 20~81%；面板其余两行仍是独立一条。
- 测试：新增 `tests/seam_cut_line_evidence.test.mjs` 4 例（整行不再被带宽上限误杀 / 整幅场景框仍被挡住 / 两半整体挂载并用拼出的整行 / 对照组：拆成两份独立证据就只会各成半句）。**已实测**：把构建产物里的新判据短路后第 1 例变红、其余照旧；对照组证明修复前口径确实产出半句 canonical。
- 验证：`npm run build` 成功；行数门禁通过（production 400 / tests 800）；`eslint extension/src` 干净；**全量 Node 回归 1550/1550**。
- 通用教训：**「跨缝」不能用「框高 ≤ 上下文带宽的倍数」判定。** 带宽与字号无关；被劈开的一整行在复合图里是完整可见的（上下不贴画布边），这才是它与「整幅场景框」的分界。以及：**同一次复合图的观测是一份证据**，逐条挂载会让同一行在 OCR 的水平切分处裂成两条 canonical——几何各半、原文各半。

## 2026-09-22（续）— 上一轮修复不够：真正让 RIDI 分片丢遮罩的是「分片换图 = 换 pageId」

- 用户复测：**我刷新了，还是有的没有有的有**，并点名问 `물감이 그림이 마치 생명체인 것처럼 느껴졌지.`（"颜料和画作仿佛拥有了生命一般"）那一块为什么没有清理图覆盖。
- 上一轮（下一条）修了 `carriedMask` 的 sourceToken 门禁，方向对但**不够**。重新做真机取证后拿到决定性事实：
  - 现场 `<html data-mt-mask-bind>` 显示 `c74e0041 → 22` 次、`0d7f2cc5 → 6` 次**成功绑定**；`<html data-mt-mask-report>` 这些页都是 `cached`（图在手里）。可所有 `.mt-overlay-root` 的 `--mt-cleaned-image` **全是空的**。
  - 我第一轮加的「main-world 监听 `setProperty/removeProperty`」拿到 0 事件——因为**扩展的 runtime 跑在 isolated world**，`evaluate_script` 在 main world，两边 `window` 不通。这个假阴性差点让我走错方向。**取证必须落在 isolated world（改源码 + 重建）**。
  - 补上专项取证流水（`<html data-mt-mask-trace>`，环形 80 条，记录 bind / sync-write / sync-remove / sync-bail / rebuild / remove-overlay / store-rescue）后真相清楚了：
    - `sync-write` 对某一页（`6ed6732f`）连打 **60+ 次**，**全程没有任何 `sync-remove`**，可那一页的 root 依旧是 `hasVar: 0`。
    - 同时 3 秒内页面 pageId 从 `6ed6732f` 一路变成 `1d1efd02 → f5de19f9 → 5009fc71`；**可见的那一层（`display:block`）的 pageId 根本不在 `data-mt-mask-report` 里**。
    - 现象归纳：**拿到遮罩并反复写入的，是已经不可见的那一页；用户真正看到的这一页，从来没被绑过。**
- 根因（两条，都必须修）：
  1. **`applyCleanedImageToPageOverlays` 用错身份。** `renderer-mask.js` 的 `overlayPageId()` 先读 `overlayState.pageId`——那是**建 root 那一刻的快照**。RIDI 分片阅读器换图是「同一个 `<img>` 元素原地换页」：新图有新 pageId / 新 imageRevision，但 targetId 不变、覆盖层不重建，于是快照永远停在旧页。结果：新页的图匹配不上（可见层永远没遮罩），旧页的图反而写进这个 target 的层。
  2. **渲染侧取图只看快照。** `renderOverlay` 的 `cleanedImage` 只来自 `result.cleanedImage`（渲染那一刻的快照）和 `oldOverlay.cleanedImage`（同一枚 root）。清理图是异步产物，**图落地时这一版投影往往已经画完**；如果覆盖层恰好在图落地之后才重建，两个来源都空 → 新 root 天生没遮罩，而且再也不会有人来补（一键绑定已经消费掉了）。
- 修复：
  - `content/modules/renderer-mask.js`：`overlayPageId()` 改为**以 `state.kakaoPageIdByTarget` 的当前绑定为准**，`overlayState.pageId` 只作无绑定时的回退。同一口径同步到 `lifecycle-position.js` 的 `overlayPageIdOf` 与 `lifecycle-overlay-cleanup.js` 的 `maskPageIdOf`（三处必须一致，否则取证流水和实际绑定会对不上 pageId）。
  - `renderer-overlay.js`：清理图取三个来源的第一个非空值 —— `result.cleanedImage` → `oldOverlay.cleanedImage` → **`runtime.getPageCleanedImage(pageId)`（直接问 canonical store 这一页此刻的 handle.cleanedImage）**。新增的 `getPageCleanedImage` 在 `renderer-mask.js` 里实现。这才是唯一不依赖时序的取法。
- 测试：`tests/ridi_rendering_parity.test.mjs`
  - 新增「分片原地换图（同一 target 换成新 pageId）后，新页的清理图必须能绑上可见层」——**已实测旧口径失败、新口径通过**（用 Python 临时把 `overlayPageId` 还原成快照优先，只有这一例红）。
  - 新增「渲染没带图、旧层也没绑过时，必须从 store 兜底取这一页的清理图」——**已实测去掉 store 兜底则失败**。
  - 原有那例源码断言改成匹配新的三来源形式。
- 顺手修的门禁缺陷：`scripts/check-file-lengths.mjs` 的 `walk()` 会把**指向目录的软链**当成文件 `readFileSync` → `EISDIR` 直接崩掉整个门禁（pytest `--basetemp` 就会留下 `<name>current -> <name>0` 这类软链）。已加 `entry.isSymbolicLink()` 跳过。
- 验证：ESLint 干净、行数门禁通过、构建成功、**Node 回归 1521/1521**、**Python 148 passed / 1 skipped**。
- 通用教训：**「这一页的产物」不能用「建那一层时记下的这一页」去找。** 分片阅读器会原地换页，页面身份必须每次**现问当前绑定**。以及——**取证代码一定要跑在扩展真正所在的 world**，otherwise 会拿到"什么都没发生"的假阴性。

## 2026-09-22 — RIDI 部分分片的遮罩「绑上了又被擦掉」：沿用清理图被错挂在 sourceToken 上

- 用户反馈：**漫画翻译模式中，ridi 的界面和 kakaopage 的界面不相同，希望最终效果和 kakaopage 相同；但 ridi 界面有些翻译有背景清理图遮罩，有的没有。**
- 现场取证（连用户已登录的 Chrome；RIDI `ridibooks.com/books/6305000008/view` vs KakaoPage 参照页）：
  - RIDI 四个分片全是 `role: cover_only` + `region_type: effect_text` + `bg_type: none`，**条件完全一致**，所以"有的有、有的没有"不可能是判据不同造成的。
  - `<html data-mt-mask-report>` 显示每个分片的清理图都**已经算出来**（`cached` + `masks: 1~2`），不是"上游没请求"。
  - 决定性一条：分片 `0974bfe0` 的 `data-mt-mask-bind` 记着**成功绑定过 32 次**，而它的 `.mt-overlay-root` 上 `--mt-cleaned-image` **是空的**（同一时刻另一个分片 `ae112e20` 有图）。→ 图写进 DOM 之后**又被抹掉了**。
- 根因在 `content/modules/renderer-overlay.js` 重建 root 时的"沿用上一版清理图"：
  ```js
  const carriedMask = oldOverlay && oldOverlay.sourceToken === currentSourceToken
    ? String(oldOverlay.cleanedImage || "") : "";
  ```
  清理图是**页级**产物（按 pageId 由 canonical handle 提供），而 `sourceToken` 是**图源地址**——RIDI 的分片图会换 url（懒加载/换版），两者本就无关。换源那一轮：
  1. `carriedMask` 被判空 → 新建的 root **不带** `--mt-cleaned-image`；
  2. 新 `overlayState.cleanedImage` 也被写成空，把 `renderer-mask.js` 先前绑好的记录**覆盖掉**；
  3. 紧接着的 `syncOverlayPosition`（`lifecycle-position.js`）按"这一层没有清理图"把变量 **removeProperty 掉**。
  三步下来就是用户看到的"有的分片遮罩被擦掉、有的没被擦掉"——差别只在于该分片这一轮有没有换图源。
- 修复：`carriedMask` 去掉 `sourceToken` 相等这一档，只要这一页之前拿到过清理图就沿用（`const carriedMask = String(oldOverlay && oldOverlay.cleanedImage || "")`）。换源导致失效的情形由 `syncOverlayPosition` 自己的 sourceToken 分支负责（它会重建 root 并解绑页面），不需要在这里重复把关。
- 测试：`tests/ridi_rendering_parity.test.mjs` 新增 1 例「分片换图源（sourceToken 变化）也不能丢掉这一页已绑定的清理图」——用假 DOM 跑真实的 `renderOverlay`，先让 overlayState 持有清理图，再把 target 的图源换成 v2，断言新 root 立刻带上 `--mt-cleaned-image`。同时把原有的源码断言从「必须挂 sourceToken」改成「必须无条件沿用」。**已实测该用例在旧写法下失败、新写法下通过**。
- 验证：ESLint 干净、行数门禁通过、`scripts/build-extension.mjs` 重新构建成功、完整 Node 回归全绿。
- 通用教训：**「沿用上一个状态」这类 carry-over 守卫，必须挂在这个状态真正的身份上。** 清理图按 pageId 缓存，就不该用图源 URL 把关——挂错身份会在"身份恰好变化"的那一部分数据上静默失效，表现成"随机地有些行、有些不行"。

## 2026-09-21 — 覆盖层「太大」：跨坐标空间比对倾角，把遮罩撑成了外接框的包围盒

- 用户反馈：**这个覆盖层太大了吧，只要在识别的文字框里面就行了**（承接上一条的斜排遮罩修复）。
- 在连着的 Chrome 里量到确凿数字（25 话 ENTRANCE→入口 气泡）：识别到的文字框 `dataset.polygon` = 30/12.1、75.56/36.32、70.79/41.5、25.23/17.28（百分比），文字节点盒子 **362×278 px**，而遮罩裁剪层 `.mt-cover-clip` 是 **443×532 px**（`clipPath: polygon(29.03% 0%, 100% 54.52%, 70.97% 100%, 0% 45.48%)`）——几乎是原文字框的两倍高。用 `rect.h > text.h * 1.4` 一量就能自动判出来。
- 根因正是我上一轮加的「冲突」规则：`resolveCoverQuad` 会拿 `rotation_deg` 与 `polygonRotationDeg(polygon)` 比数值，超过 0.5° 就认为两者冲突、退回「旋转整个外接框」。但两套数字根本不在同一个坐标空间：同一段斜排文字，像素坐标读 **35°**（OCR 的 `rotation_deg`），百分比坐标读 **28°**（polygon），页面长宽比 720:947=1.315 → `atan(tan35° × 0.76) = 28°`，是同一个倾角。误判成冲突后 `rotateBoxQuad(polygonBox, 35)` 把 50.33×29.4 的文字框外接框旋转出 61.6×56.1% 的包围盒 = 443×532 px。
- 修复：
  - `resolveCoverQuad` 去掉跨空间的角度比对：**polygon 本身倾斜就直接用它**（按覆盖范围外扩），只有 polygon 是轴对齐框、而 OCR 给了 `rotation_deg` 时才旋转这个框。遮罩从此就是「识别到的文字框」。
  - 「覆盖范围」默认值由 `1.2`（外扩 6%）改为 `0`（贴合识别到的文字框）：`config/schema.js` 的 `DEFAULT_RUNTIME_CONFIG`、`normalizeRuntimeConfig` 兜底、`reader-state.js` 的初始 state 三处同步；设置页选项与范围不变，用户想留白仍可自己调大。
  - 清理遮罩（`clean-masks.js`）本来就走 `resolveCoverQuad`，一并跟着变紧，不再向外扩 6%。
- 测试：`tests/overlay_tilt.test.mjs` 的「冲突跟 rotation_deg 走」一例改写为「遮罩尺寸跟着识别到的文字框」——断言裁剪层宽高等于文字框（±7%），并显式断言遮罩不会比文字框大出 10%（旋转外接框那条路会大出 30%+）。`qa_probe_tilt.mjs` 的 (c) 行改为打印遮罩实际包围盒（现在 = 52×26，即文字框本身）。
- 验证：`npm run build` + 手机版构建成功；完整 Node 回归 **1445/1445**；行数门禁与 ESLint 干净。
- 复现口径：同一个页面上量「文字节点盒子 vs 遮罩裁剪层盒子」，两者不一致就是这条缺陷；再算一次像素/百分比两套角度即可区分是坐标空间换算还是真的冲突。

## 2026-09-21 — 斜排原文的「覆盖层」还是水平：清理图的遮罩几何是轴对齐蓝框

- 承接上一条：渲染侧四条路径的倾角都补齐后，用户在看真实页面（我连的 Chrome：Kakao 小说 155 话的「正文图片 1」、漫画 25 话的 ENTRANCE→入口）反馈**还是水平的**。
- 先把现场数据摊开：漫画页那个「入口」气泡在 DOM 里其实是歪的（`dataset.rotationDeg=35`、`--mt-base-transform: … rotate(35deg)`、遮罩 clip-path 也是 35°），所以「水平的」不是文字层，而是**用户眼里的覆盖层 = 清理图里被擦掉的那一块**。小说正文图片走的是嵌入式渲染：底图就是清理图（`payload.cleanedImage`），被擦掉的区域直接就是用户看到的白/补丁，没有任何 clip 去收拾它。
- 根因：`canonical/modules/scene-index-resolve.js` 的 `buildCanonicalCleanMasks` 一律发**轴对齐蓝框**（`normalizeCanonicalCleanMaskGeometry(projection.geometry)`，注释写着"清理范围统一采用最终渲染蓝框"），而 Python 侧 `build_complex_text_inpaint_mask` 一旦收到 supplemental masks 就**只用它们**（`if final_polygons: … return`），连 OCR 自带的倾斜 polygon 都不再看。于是斜排文字被擦掉的永远是一个水平矩形：在漫画覆盖层里被倾斜 clip 盖住看不出来，在嵌入式（小说正文图片）里就是一块水平补丁。
- 修复：新增 `canonical/modules/clean-masks.js`（`installCleanMasks`，从 `scene-index-resolve.js` 拆出来，原文件已经顶到 400 行门禁）：
  - `buildCanonicalCleanMasks` 对**斜排**投影改发 `{coordinateSpace:'percent', polygon:[四角]}`；四边形由渲染侧的 `resolveCoverQuad` 直接算出 —— 「擦掉的范围」与「画上去的遮罩」从此是同一个几何，不再各写一份。
  - 倾角取证与渲染同一口径（`resolveTiltRotationDeg`：`rotation_deg/rotationDeg`（含 `visual`）→ `polygon` → `region_polygon`）。轴对齐（≤0.5°）投影仍发原来的蓝框，行为不变。
  - 清理多边形比遮罩多胀 1%（`padding: 0.2`）盖住抗锯齿边，避免擦不干净留笔画。
  - JS 侧 `normalizeCleanedMask` 本来就是「有 polygon 用 polygon、没有才用 box」，Python 的 `normalize_percent_mask_polygon` 也早就支持 polygon 遮罩，两端都不用改；清理 artifact 的缓存键含遮罩内容（`buildCleanedArtifactKey(imageRevision, masks)`），所以新遮罩会强制重出清理图，不会被旧的矩形补丁缓存粘住。
- 测试：新增 `tests/cleaned_mask_tilt.test.mjs` 4 例 —— 斜排投影发倾斜四边形且与 `resolveCoverQuad` 的角点逐个相等、没有 polygon 时按倾角旋转外接框、轴对齐投影仍发蓝框（行为不变）、实心背景/未激活投影不产出遮罩。
- 验证：`npm run build` + 手机版构建成功；完整 Node 回归 **1445/1445**；Python **137 passed + 1 skipped**；`npm run check:lines` 与 ESLint 干净。
- 备注：Chrome 里没法直接看像素（本会话模型不支持读图、页面 `fetch` 被 Kakao CDN 的 CORS 拦掉），所以现场取证是靠 DOM 数据（rotationDeg / clip-path / 清理补丁来源）而不是截图；上面结论中的「嵌入式底图=清理图」依据是 `renderer-embed.js` 的 `baseDataUrl = payload.cleanedImage`。

## 2026-09-21 — 斜排原文的覆盖层仍是水平：倾角取证口径有四条路径各自为政

- 用户反馈：**覆盖层没有根据倾斜的文本进行倾斜**（与既有回归 `tests/overlay_tilt.test.mjs` 抬头引用的同一句缺陷）。
- 先用真实链路复现，不猜：写探针把「合成 OCR 观察 → `reconciler.reconcile` → `buildRenderProjections` → `projectionToRendererBubble` → `createBubbleNode`」整条跑通，逐例打印渲染节点倾角。结论——**倾角只在 `region_polygon`（区域轮廓）上、顶层 `polygon` 是轴对齐框或没有时，渲染节点恒为 0°**（`rotate(0.00deg)`），即覆盖层水平、斜排原文露在外面；其余三种来源（顶层 `rotation_deg`、`visual.rotationDeg`、倾斜 `polygon`）都能歪。
- 根因是**倾角取证口径分散且口径不一致**，不是某一条渲染路径写错：
  - canonical 投影气泡（`reconciler-projection-utils.addProjection`）**只把 `polygon` 写到顶层，没写 `rotation_deg`**，倾角只留在 `visual.rotationDeg` 里；渲染侧却只读顶层字段（`lifecycle-bubble` / `lifecycle-cover` / `renderer-embed` 都读 `bubble.rotation_deg`）；
  - `resolveBubblePolygonRotation` 的几何兜底用**首边**：集群合并框从短边起笔时报 ≈±90°（水平文字被竖过来），顶点起点/绕向一变结果就变；
  - `region_polygon` / `visual.regionPolygon` 从不参与倾角取证；
  - `resolveCoverQuad` 在 `rotation_deg` 与 `polygon` 冲突时跟 `polygon` 走，而文字节点跟 `rotation_deg` 走 → 译文与遮罩错开（QA 探针 `qa_probe_tilt.mjs` 一直把这条打印成 CONFLICT）。
- 修复（一处口径，四条路径共用）：
  - `rendering/cover-geometry.js` 新增纯几何 `polygonRotationDeg(points, scaleX, scaleY)`：**轴对齐框（倾斜量 ≤ 0.5°）一律返回 0**（高而窄的多行外框不能被读成 90°）；确实歪了的四边形取**最长边**＝文字行方向，折到 ±90°，与起点/绕向无关；近正方形（长短边比 < 1.2）取更接近水平的那条边。另新增 `resolveTiltRotationDeg(rotationDeg, polygons, …)`：显式倾角优先（0 视为没有信息），否则在一串候选四边形里「哪个真的倾斜就用哪个」。`polygonEdgeRotationDeg`（首边口径）保留给探针/对照。
  - `content/modules/target-resolve.js` 新增 `runtime.resolveBubbleRotation(bubble, imageWidth, imageHeight)`：从 `rotation_deg/rotationDeg`（含 `visual` 内同义字段）取证，再依次看 `polygon / visual.polygon / region_polygon / visual.regionPolygon / visual.region_polygon`；`resolveBubblePolygonRotation` 的几何兜底改为同一个 `polygonRotationDeg`。
  - DOM 文字节点（`lifecycle-bubble`）、遮罩四边形（`lifecycle-cover`）、嵌入式画布（`renderer-embed`）三条路径改调 `resolveBubbleRotation`；纯几何的场景文字层（`scene-builder`：成员 region、成员四边形兜底、`cleanupGeometry` 的遮罩）改调 `resolveTiltRotationDeg`。画布与 DOM 保持同一个百分比空间口径，避免同一气泡在两条路径歪出两个角度（按画布像素换算真实倾角是另一件事，本次不动）。
  - canonical 投影气泡补上顶层 `rotation_deg`/`rotationDeg`，下游只读顶层也有值。
  - `resolveCoverQuad`：`polygon` 与 `rotation_deg` 冲突时以 `rotation_deg` 为准（它才是文字节点的渲染倾角），遮罩与译文不再错开。
- 测试：`tests/overlay_tilt.test.mjs` 由 4 例扩到 11 例 —— region_polygon 单独倾斜（DOM/遮罩/画布三条路径）、`visual` 内同义字段、顶点起点与绕向不变性（轴对齐框 6 种点序恒为 0，含高而窄的轴对齐外框；倾斜四边形 4 种点序恒为同一角度）、成员 region 缺 `rotationDeg` 时用成员四边形兜底、canonical 投影气泡顶层带倾角且 region-only 场景渲染节点仍能恢复、遮罩与译文同源（冲突时都跟 `rotation_deg`）。`qa_probe_tilt.mjs` 的 CONFLICT 行改为打印遮罩实际倾角。
- 验证：`npm run build` + 手机版构建成功；完整 Node 回归 **1436/1436**（exit 0）；`npm run check:lines` 通过；改动文件 ESLint 干净。
- 复现/取证方式留在工作区临时探针里（跑完即删），思路可复用：只要把「canonical 投影 → 渲染气泡 → 渲染节点」串起来打印 `dataset.rotationDeg`，倾角在链路哪一段丢的一目了然。

## 2026-09-21 — 正文图片 OCR 全挂：`runtime.handleOcrDataUrlWithTimings is not a function`

- 用户报错：页面里每个正文图片的 OCR 请求都返回 `runtime.handleOcrDataUrlWithTimings is not a function`。
- 根因是**装配漏装**，不是 OCR 逻辑：`background/modules/ocr-timings.js` 写好了包装器 `handleOcrDataUrlWithTimings`（只加计时日志，再转发 `runtime.handleOcrDataUrl`），`messages.js` 的 `OCR_DATA_URL` 也指向它，但 `background/modules/index.js` 里 `installOcrTimings` **只出现在了那份没人用的 `backgroundInstallers` 列表**，漏在真正被使用的 `backgroundPhases.functions` 之外；`createBackgroundRuntime()` / `novel-mobile/background.js` 都只装 `backgroundPhases`，于是运行时既没有 `handleOcrDataUrlWithTimings`，连带 `recordOcrPipelineTimings/summarizeOcrTimings` 也没有。
- 定位方式：用假的 `chrome` 全局直接 `createBackgroundRuntime()`，逐个打印 `typeof runtime.*` —— `handleOcrDataUrl: function` 而 `handleOcrDataUrlWithTimings: undefined`，一眼看出是漏装而非调用姿势错误。
- 修复：
  - `backgroundPhases.functions` 补上 `installOcrTimings`（放在 `installOcrPipeline` 前，顺序与旧列表一致）；
  - 把重复的 `backgroundInstallers` 改成由 `backgroundPhases` 派生（`[...functions, ...state, ...startup]`），消除「两份手写列表各自维护」这个漂移源 —— 本次事故正是漂移的结果（旧列表还额外漏了 `installTranslationConfig/installTranslationTaskCancel/installWebpageTabController`）。
- 新增 `tests/background_message_wiring.test.mjs` 3 例做同类回归：① `messages.js` 里路由的每个 `runtime.*` 处理器都必须在 background 目录某个文件里被赋值（防「路由到没人装的处理器」）；② `index.js` 里 import 的每个 `install*` 都必须落进阶段数组（防「模块写好但没接线」），并钉住 `installOcrTimings` 在 `functions` 里、`backgroundInstallers` 必须是派生写法；③ 包装器必须转发真正的 `handleOcrDataUrl`。
- 验证：`npm run build` 成功；直接 import 构建产物 `dist/extension/background.js` 检查 `backgroundRuntime` 的 6 个计时相关处理器全为 `function`；新增用例 3/3、`novel_mobile_isolation` + `translation_cache` + 本次用例合计 38/38、`background_runtime.part05`（含 OCR_DATA_URL 校验用例）11/11；`npm run check:lines` 通过、改动文件 ESLint 干净。
- 备注：沙箱里 `esbuild`/`node --test` 会因命名管道被拦（spawn EPERM），构建与用例改用「提权跑 build」和「进程内 `import()` 测试文件」完成验证。

## 2026-09-21 — 手机端小说术语提取「漏术语」：分段失败被当成成功 + 没有进度、没有诊断

- 用户反馈：手机端待确认里**有**术语，但比电脑少、老漏；怀疑是 service worker 被回收。核实结论：回收只丢「整趟」（消息失败会让内容脚本 30 秒后重试，且没标记任何段落），真正会**永久漏**的是：
  - `novel-mobile/term-extract-llm.js` 逐段 try/catch：只要有一段成功就 `ok:true` 返回，随后 `mergeDiscovery` 把**整屏所有段落**写进 `processedEvidenceIds` —— 落在失败/超时分段里的术语再也不会被重新提取（电脑相反：任一段失败 → 整趟失败 → 不标记 → 30 秒后自动重跑）。
  - 手机更容易出现失败分段：没有串行队列（多屏并发抢同一个模型）、每段超时 120s（桌面读超时 300s、整趟预算 120–1200s）、SW 被回收。
  - 手机**从不写** `mt_term_discovery_last_v1`：它整段覆盖了桌面的 `runTermDiscovery`，把 `recordDiscovery` 一起漏掉，所以术语库页「最近一次提取」在手机上是空的 —— 漏了也看不见。
- 修复：
  - **逐段覆盖**：`requestChapterTermExtraction` 返回 `partial{totalChunks,failedChunks,timedOutChunks,coveredBlockIds}`；`mergeDiscoveryResult` 新增 `processedBlockIds`（默认仍是全部块），手机只把「成功分段覆盖的块」记为已处理；未覆盖的段落由新增的 `reason:"partial"` 触发 30 秒重试补跑（`novel-term-discovery.js` 的 RETRY_REASONS）。
  - **断点续跑**：每跑完一段把候选写 `chrome.storage.session`（测试可注入 store），同一趟提取重入时跳过已完成分段、只补剩下的；整趟跑完才清理。
  - **串行队列**：新增 `novel-mobile/term-extract-queue.js`（在途 1 + 排队 1，超出按 `throttled` 交回内容脚本重试），对齐桌面 `enqueueExtraction`；超时冷却 60 秒、其它 5 分钟（`platform-storage.js` 的超时错误现在带 `timeout` 标记）。
  - **结果记账共享**：新增 `shared/term-discovery-report.js`，桌面与手机都写 `mt_term_discovery_last_v1`；术语库页「最近一次提取」新增「有 N 段没跑完，稍后自动补跑」与丢弃统计（kind 非法 / 原文里找不到 / 自造 kind 已按专有名词保留）。
  - **两端单一真源**：Python `_chunk_prompt` 补上手机版那 3 条加固规则；`_validate_llm_output` 移植 FIELD/KIND/INVALID 别名表，自造 kind 归一成 `proper_noun` **保留**（以前整条静默丢弃），丢弃计数随 `/terms/extract` 返回；新增 `tests/term_extractor_parity.test.mjs` 逐行/逐键钉住两边。
  - **空模型保护**：`resolveExtractionConfig` 在选中配置没填 model 时继承翻译模型；Python/JS 只在 base_url 指向本机时才退到 `qwen2.5:7b`，否则报「未配置术语提取模型」。
  - **Python 拆文件**过行数门禁：`term_text_utils.py`（规范化与包含判定）+ `term_extract_heuristic.py`（零依赖启发式），`verify.mjs` 与 pylint 列表同步。
- 验证：`npm run verify` 全绿（Node 1413/1413、Python 129 passed + 1 skipped、行数门禁、ESLint、Pylint 10.00/10）；`dist/extension` 与 `dist/novel-mobile` 均已重建。

## 2026-09-21 — 网页翻译速度从快捷弹窗搬进设置页（顺带澄清它和「小说翻译速度」不是同一套）

- 用户问「网页端现在每块字数是哪里调的？popup 和设置页都有，一个是网页快速翻译，一个是小说翻译速度，这两个重复了，保留设置页」。先按代码纠正事实：
  - 弹窗「速度与调试 → 网页快速翻译 → 高级参数」写的是 `runtime.webpageConcurrency / webpageBatchItems / webpageBatchChars`，**唯一**消费者是 `content/modules/webpage-scheduler-config.js`（→ `webpage-scheduler.js` 的每批上限与车道数），管的是**网页正文翻译**；
  - 设置页「小说翻译速度 → 渐进每块字数」写的是 `runtime.novelChunkChars`，走 `shared/novel-speed.js` → `novel-progressive-workflow.js`，管的是**小说回退通道**。
  - 两者是两条管线、两个键，不是重复的一份 —— 所以按用户选择把**网页那三个参数整块搬到设置页**，而不是删掉弹窗那份能力。
- 新增 `extension/src/shared/webpage-speed.js`：`WEBPAGE_SPEED_LIMITS`（1–8 / 4–96 / 400–8000）、`WEBPAGE_SPEED_DEFAULTS`（5 / 32 / 3200）、`WEBPAGE_SPEED_STATE_KEYS`、`WEBPAGE_SPEED_PRESETS`（fast 5·32·3200 = 旧弹窗 `FAST_MODE`；normal 3·24·1600 = 旧 `NORMAL_MODE`）、`clampWebpageSpeed`、`isWebpageFastMode`、`describeWebpageSpeed`。默认值与档位与搬走前逐个相等 —— 不动设置＝行为不变。
- `config/schema.js`：`DEFAULT_RUNTIME_CONFIG` 的三个数字改为引用共享默认值，`normalizeRuntimeConfig` 改用 `clampWebpageSpeed`（与小说速度同一套收敛）。**有意的行为差异**：`null`/`""` 现在回默认 3200，而不是被 `numberIn` 夹成下限 400（`0` 仍夹下限）——与「空输入框当没填」的既有规则统一。
- 设置页：`public/settings.html` 在「小说翻译速度」卡后新增「网页翻译速度」卡（并发批数 / 每批段数 / 每批字符数 + 每个参数一句作用说明 + 「快速模式」勾选项 + `webpageSpeedHint` 提示行），`settings/controller.js` 接上回填、写回、输入时实时算「一批多大」、手改任意一格让勾选跟着掉。说明文案全部来自代码事实（视口内批次 1/4 上限、近屏 1/2、有视口任务时后台只占 1 条车道、段数与字符数「先到者为准」）。
- 快捷弹窗：`public/quick-popup.html` 的「速度与调试」卡缩成纯「调试」卡（`#debugHeading`，只留 OCR 调试 + 一行「网页翻译速度在完整设置 → 阅读与显示」的指引），`quick-popup/controller.js` 删掉两档常量、三个字段的回填/写回与全部绑定。删 HTML 必须同步删绑定：`byId(...)` 绑定在模块加载期执行，漏删会整页抛 null。
- 手机版：`novel-mobile/popup-local.js` 改按 `debugHeading` 藏卡；`novel-mobile/settings-local.js` 新增 `DESKTOP_WEBPAGE_ARTICLE_FIELDS`（三个 id 逐个藏所在卡）——手机版不做网页翻译，这些值对它完全不生效。
- 测试：新增 `tests/webpage_speed_settings.test.mjs` 9 例（默认值/两档与搬走前逐个相等、状态键不新开存储键、脏数据收敛、`normalizeRuntimeConfig` 新规则、`isWebpageFastMode` 只认短键与三值全等、提示语、设置页三格范围与逐条说明、控制器接线、以及「弹窗里不能再出现这三个键与任何数字输入框」的反向断言）；`tests/novel_mobile_pages.test.mjs` 跟着改 `debugHeading` 并加「网页速度卡在手机版整卡隐藏」。
- 验证：完整 Node 回归 **1400/1400**（exit 0）、Python **129 passed + 1 skipped**、ESLint 干净、`dist/extension` 与 `dist/novel-mobile` 已重建且两套产物完整性检查通过。真机（file:// 加载 `dist/extension/settings.html#reading`，伪 chrome 注入配置）实测：三格回填 5/32/3200、范围与 step 正确、提示行「当前：并发 5 批 · 每批最多 32 段 / 3200 字（先到者为准）」；取消快速模式 → 3/24/1600，勾回 → 5/32/3200，手改字符数 900 → 勾选自动掉且提示重算；快捷弹窗渲染后 `input[type=number]` 数量为 0、无控制台报错、语言/启用开关正常回填。
- 过程中观察到零星抖动（同一批用例单独复跑全绿、最后一轮完整回归 0 失败），且这些文件都不引用本次改动的模块，故记为既有抖动、非本次引入：`kakao_pipeline.part14/15/17` 的接缝超时用例（只 import `canonical/pipeline.js` 与 legacy harness）、`novel_mobile_background_local` 的提取节流与 `term_extract_llm`（属工作区未提交的术语提取 WIP）。
- **既有红灯（与本次改动无关）**：`npm run check:lines` 报 `local-ocr-service/term_extractor.py: 540 lines (limit 400)`——本次未触碰任何 Python 文件，`tests/length_gate.test.mjs` 只单测 `validateLength` 的 extension 规则所以照过。

## 2026-09-21 — 混排交给模型排版 + 术语「模型判断但必须逐条交代」

- 用户两条要求：
  1. 「这种混排不能让 AI 去排版吗？」—— 按字符占比猜强调边界只能猜个大概，希望由模型判定；
  2. 「去掉校验是因为会直接套用术语，即使在原文里不是那个意思。但是发现去掉校验会导致有时候术语会不生效。」—— 保留「模型按语境判断」，但要堵住「静默漏用」。
- 版式（AI 排版）：新开一条**独立的排版对齐小请求**，不动译文缓存、已翻好的章节不用重译也能修：
  - `content/modules/novel-inline-format.js`（新）：把行内格式复刻逻辑从 `novel-renderer.js` 拆出来（渲染器已接近 400 行上限），新增 `describeNovelEmphasis(node)` —— 把原文强调片段标成 `⟦…⟧`，作为对齐请求的输入；
  - `content/modules/novel-emphasis-align.js`（新）+ `background/modules/novel-emphasis.js`（新）：一屏译文到齐后（桌面版挂在 `scheduleTermDiscoveryForChapter` 的出口、手机版挂在 `afterScreenTranslated`），只把含行内格式的段落（真机 137 段里个位数）发一次 `ALIGN_NOVEL_EMPHASIS`，拿回带标记的译文存进 `state.emphasisMarks`；`state.emphasisAligned` 记账保证每段只问一次（reconcile 每 80ms 会走到那个出口）；
  - 采用条件很硬：**标记成对、段数与原文一致、去掉标记后与译文逐字相同**（允许空白差异，会按字符投影回去）。模型借排版改了译文就整条丢弃，退回比例映射；`⟦⟧` 永远在写入页面前剔除；
  - 每屏只对混排段落各问一次，纯文本屏（如今日打开的 126 话，251 段里 85 段只有 `<br>`/`<img>`）零请求。
- 术语（判断 + 交代）：
  - `shared/novel.js#validateTranslations` 新增 `glossary_unaccounted`：命中的术语必须要么「译文里逐字有译名」，要么在 `terms.skipped` 里写明「这次语境不是它 + 理由」；两者都没有 = 静默漏用 → 点名重试。`terms.used` 声称用了却查不到译名 → 仍是 `glossary_violation`。模型没按新 schema 回（旧缓存/老模型）时退回旧的字符串硬校验，**不会**把所有命中都判成「没交代」而整章重试；
  - 小批提示词（`novel-translation.js`）与流式提示词（`translation_stream.py`）都带上同一套交代规则 + schema，重试时点名未交代的术语；流式事件把模型的 `terms` 原样转发给守卫；
  - 「译文里照抄术语原文拼写」的确定性修复从手机版提到 `shared/term-repair.js`，桌面小批链路与流式链路（转发前就地改写事件与落库快照）现在也享受；
  - 手机版定点修正不再「只修前 N 段」：`maxParagraphs` 改成**每批段数**，全量分批修完（真机症状：同一个名字这一章里两种写法），设置项文案同步改成「修正每批段数」。
- 验证：Node 1377/1377、Python 110 passed + 1 skipped、`check:lines`、ESLint、Pylint 10.00/10 全绿；`dist/extension` 与 `dist/novel-mobile` 均已重建，Chrome 里已确认加载到新样式（包裹层 `color: inherit !important` 生效、页面无 `⟦⟧` 残留）。

## 2026-09-21 — 桌面版小说翻译速度也做成可调（手机版那套旋钮的桌面对应物）

- 用户要求「桌面侧也改」：手机版已有「翻译速度」卡片（并发 / 每块字数 / 补翻段数），桌面版这三个数却仍是 `novel-stream-workflow.js` / `novel-progressive-workflow.js` / `shared/novel.js` 里写死的常量。
- 先分清楚桌面小说**两条通道**各有什么真旋钮（写代码前用现有测试与代码路径确认，不猜）：
  1. 流式（主力，`attemptNovelTranslationStream`，服务端 `/translations/stream`）：按 `novelStreamBatchSize` 段切批、`STREAM_BATCH_CONCURRENCY = 3` 条请求并发 ⇒ 并发是真并发，一轮最多翻「并发 × 每批段数」段；
  2. 渐进（`attemptNovelTranslationStream` 失败后的回退，`novel-progressive-workflow.js`）：闸门 `nextChunkIndex <= respondedChunkCount` 保证**同时只有 1 个请求在途**，`PROGRESSIVE_CHUNK_CONCURRENCY = 2` 只是让「下一块的请求」与「本块的落库/渲染」重叠 ⇒ 这里唯一能拧的是 `CHUNK_TARGET_CHARS`（1400，块越大轮数越少），把「并发」暴露给用户会是个谎，故不暴露，只在代码注释里写明原因；
  3. 漏译逐段补齐 `REPAIR_CONCURRENCY = 3`：各段独立，可以真并发。
- 新增 `extension/src/shared/novel-speed.js`：桌面三个旋钮的取值范围 / 默认值 / 收敛函数 / `resolveNovelSpeed(runtime.state)` / 设置页提示语，成为唯一真源（`shared/novel.js` 的 `CHUNK_TARGET_CHARS` 也改成引用它的默认值，避免两处各写一个 1400）。
- 接进既有桌面配置链路（不新开存储键，避免第二个真源）：`config/schema.js`（`DEFAULT_RUNTIME_CONFIG` + `normalizeRuntimeConfig` 收敛）、`public/settings.html`（阅读与显示 → 新增「小说翻译速度」卡片：流式并发 1–8 / 渐进每块字数 400–4000 / 补翻并发 1–8，并带一行 `novelSpeedHint`）、`settings/controller.js`（回填、保存、输入时实时刷新提示、保存后回填夹紧值）、`content/configure.js`（`runtime.state` 初载 + storage 变更时同步，改完下一次翻译生效，不用刷新页面）。
- 默认值 3 / 1400 / 3 与改动前逐个相等：不动设置＝行为不变（这是本次改动的底线，有测试兜住旧配置读出来仍是老行为）。
- 收敛复用手机版踩过的坑：`null` / `""` / 空白一律按「没填」回默认，不像 `numberIn` 那样被 `Number(null) === 0` 夹成下限（每块 400 字、并发 1 这种莫名其妙的值）。
- 手机版：`novel-mobile/settings-local.js` 的 `DESKTOP_NOVEL_ARTICLE_FIELDS` 逐个 id 藏掉这张桌面专属卡（手机版走 `novel-batch.js` 并发小批 + 自己的 `mt_novel_mobile_tuning_v1`，这些值对它完全不生效）。
- 测试：新增 `tests/novel_speed_desktop.test.mjs` 10 例（默认值与旧常量逐个相等 / 脏数据收敛 / `resolveNovelSpeed` 缺失 state 不炸 / 提示语 / 设置页与控制器接线 / 流式并发 1、6、越界 99、0 / 渐进每块字数真的传给 `buildChunks` 且块数随之变化 / 补翻并发 1、4、默认 3）；`tests/novel_mobile_pages.test.mjs` 增「桌面速度卡在手机版整卡隐藏」。
- 验证：Node **1353/1353**；Python **110 passed + 1 skipped**；`check:lines`、`eslint extension/src` 全绿；`dist/extension` 与 `dist/novel-mobile` 均已重建并通过产物门禁；`dist/novel-mobile.crx` 重新打包（1469 KB，ID `ahadlldgbllcbhpkhebglhdcjbadliap` 不变）。
- 生效方式：桌面版需在 `chrome://extensions` 点「重新加载」并刷新阅读页；已渲染的旧 DOM 不会自愈（对存量译文要重新翻译才用上新参数）。

## 2026-09-21 — 小说版三条：包裹层被页面主题规则抢走颜色、译文不复刻行内格式、原文模式残留隐藏译文

- 用户反馈:①术语有时候不正确(全站生效时也一样);②无法完全模仿原文版式 —— 蓝框里的「黑色正文 + 灰色加粗段」混排全变成一种颜色,且切回原文也不恢复;③切换原文后其他翻译软件直接跳过这段韩文(像已经翻译过一样)。
- 真机取证(`page.kakao.com/content/61822085/viewer/62231885/`,shadow DOM + `getComputedStyle`):
  - `p.box_txt` 计算色 `rgb(0,0,0)`,而 `.mt-novel-source` / `.mt-novel-translation` 及其内部 `<strong>` 全是 `rgb(189,189,189)`;
  - 把包裹层摘掉后实测:纯文本节点=黑、`<strong>`=灰 ⇒ 页面注入的 `* { color: rgb(var(--…-darkgray-text)) !important; }` 同样命中我们插入的两个 span,而不带 `!important` 的 `color: inherit` 压不过它。
  - 原文模式只把译文标 `hidden`:整段 `textContent` 成了「韩文+中文」,别的翻译插件据此判「这段已经是译文」而跳过。
- `novel-renderer.js`:
  - 包裹层改为 `color: inherit !important; font: inherit !important`,对页面主题规则完全透明(实测 source/translation 恢复黑、内部 `<strong>` 保持灰)。
  - 新增 `collectInlineRuns` / `buildTranslationMirror`:按原文每个行内片段的字符占比把译文切回去复刻(旧的「只有一个行内包裹才镜像」在 `본 보고에는 <strong>…</strong> 포함되어 있습니다.` 这类混排上整段放弃);遇到 `<br>`/图片/链接等无法复刻的结构仍退回纯文本;镜像壳只搬 class/style,必须丢掉 `data-p-id`。
  - `setNovelTranslationVisibility(false)` 改成**完全还原 DOM**(撤掉译文节点与两个包裹节点),译文留在 `state.translations`;`reapplyNovelTranslations` 在原文模式直接返回,避免 80ms reconcile 又把壳贴回去。实测还原后 `textContent` 无中文、无残留节点。
- 术语(桌面流式链路,多数段落走的这条):提示词只有一句 `Required glossary:`、丢掉条目备注,而且**没有任何校验** —— 模型漏用术语照样渲染、照样落库,小批链路却有两道(硬规则提示词 + `validateTranslations` 重试/回落)。现在:
  - `translation_stream.py` 的术语段与小批链路同规则(逐字照用、最长优先、备注用于选人称语气),并带上 `note`;
  - `translation-stream.js` 用 `buildStreamGlossaryGuard` 逐段核对,漏用术语的段落**不转发、不写译文库缓存镜像**,内容侧因此仍视其为未翻译,随后由渐进小批链路重译(那条链路自带重试与「术语违规保留译文 + 警告」回落,不会丢段)。
- 顺带修既有红灯:`settings-local.js#DESKTOP_NOVEL_ARTICLE_FIELDS` 补 `novelChunkChars` / `novelRepairConcurrency`(桌面三个速度旋钮同一张卡,按 id 逐个隐藏才不依赖卡片 DOM 结构)。
- 验证:Node 1353/1353、Python 110 passed + 1 skipped、`check:lines`、`eslint` 全绿;`dist/extension` 与 `dist/novel-mobile`(手机版共用同一份 novel-renderer)均已重建。Chrome 侧需在扩展管理页点「重新加载」后再刷新阅读页才会生效(MCP 无法访问 `chrome://`)。

## 2026-09-19 — 小说译文「格式和原文不一样」:论坛/评论块被当成一段段落,整块排版被压平

- 用户提问(附截图):第 3 话里 `[New Renez 车敏锡 原本是Miro练习生这件事,是真的吗?]` 那条论坛块,原文和译文格式不一样。
- 真机取证(页面 `page.kakao.com/content/61822085/viewer/61869653/`,译文模式,shadow DOM 实测):
  - 该块标记是**容器与内层段落同号**:`div.box01[data-p-id="162"] > div.box02[data-p-id="162"] > p.box_txt[data-p-id="162"] × 9`;
  - `box01` 内 **9 个 `p.box_txt` 全部不可见**(可见段落数 0),`div.box02`(白底内框)rect 为 `0×0`、`checkVisibility() === false`;
  - 唯一可见的是外层 `.mt-novel-translation`:217 字纯文本、`font-size:24px`、`line-height:1.6`;
  - 页面 shadow CSS:`box01{background:#B0DFE5;padding:.3em}`、`box02{background:#fff;padding:.5em}`、`box_txt{font-size:.95em;line-height:1.8em;padding:.5em}`、`txt_b{font-weight:bold}` ⇒ **白底内框、逐行留白、加粗标题全部丢失**;
  - 全屏 233 个块级 `data-p-id` 节点里只有这 2 个是容器;143 条译文里有 2 条属于容器(同一段文字被重复翻译)。
- 根因两条:`novel-reader.js` 的 `isNovelParagraphNode()` 只判「块级标签 + data-p-id」,容器被当成段落(整块拼接文本进 `chapter.paragraphs`);`novel-renderer.js` 的 `ensureNovelWrappers(node)` 会把该节点的**全部子节点**(含已渲染的内层段落)搬进 `[hidden]` 的 `.mt-novel-source`,只留一段扁平译文。
- 第三处隐患(必须同改):`findNovelParagraphNode(surface,id)` 用 `[...rawMatches].filter(块级标签)[ordinal]` 解析序号,容器占 ordinal 0 ⇒ 只改提取不改这里,reapply 会把译文定位到容器、源文哈希不匹配而被 `restoreNovelNode` 清掉(表现为译文静默消失)。
- 修复:
  1. `content/modules/novel-reader.js` 新增 `hasNestedNovelParagraph()` / `isNovelParagraphLeaf()`:「带 data-p-id 的块级节点若存在**同为段落的块级后代**,就只是容器」,`findKakaoNovelSurface` / `novelSurfaceSignature` / `extractKakaoNovelChapter` 三处收集统一改用 leaf 判据。判据只认块级后代——`<br data-p-id>`、`<img data-p-id>`、`<span class="txt_b" data-p-id>` 是空元素/行内元素,不构成嵌套段落(否则满屏空行段落会被误删)。
  2. `content/modules/novel-renderer.js` 的 `findParagraphNode()` 用同一个 `runtime.isNovelParagraphLeaf` 过滤后再取 ordinal(序号口径与提取一致);另加「整段只有一个行内包裹元素时镜像该包裹」,`<p class="box_txt"><span class="txt_b">…</span></p>` 这类标题行的加粗不再丢失(混排格式仍按纯文本,不清空重写以外不叠加镜像)。
- 真机判据预演(把修复后的判据源码贴进当前页面跑真实 DOM):候选 233 → leaf **231**,被排除的正好是 `DIV.box01`/`DIV.box02`;按 pid 比对「过滤后的文档序」与提取序,**ordinal 错位 0 处**;有文字的 leaf 141 个且全部已有译文 ⇒ 修后进度由 143 变 141,同一段文字不再重复送翻译。
- 缓存不受影响:`paragraphKey`/recordId 依赖 `chapterId + 源文哈希 + occurrenceIndex`,容器从不与内层段落共享哈希,已缓存的 141 段译文仍命中,只是 id 序号重排(`162#1..9` → `162`,`162#1..8`)。
- 测试:`tests/novel_nested_container.test.mjs` 新增 6 例(容器不是段落/空行 `<br>` 不误判/序号与提取同口径/渲染不吞容器/行内包裹镜像且重复渲染不叠加/混排保持纯文本);`check:lines`、`eslint extension/src`、`scripts/build-extension.mjs` 全部通过。
- 生效方式:需在 `chrome://extensions` 重新加载扩展并刷新页面(已渲染的旧 DOM 不会自愈)。

## 2026-09-18 — 网文翻译「后面的比前面先出来」：不是顺序颠倒，也不只是失败重发，还有「上一轮任务没被取消」

- 用户问:网文翻译是按阅读顺序发申请的吗?有没有颠倒?还是失败后重发了一次?
- 代码事实:`novel-stream-workflow.js` 里待译段落按阅读顺序取(`orderParagraphs` 按 `data-p-id` 数字序,否则 DOM 序),按下标切片,**发送顺序就是阅读顺序**(0-49、50-99、100-149…);但**同时并发 3 条流**(`STREAM_BATCH_CONCURRENCY = 3`,原注释写明是为了把整章串行等待压到约 1/3),每条流独立返回 ⇒ 谁先出字谁先显示。服务端 `translation_stream.py` 收到一行就 commit 一行并立刻推事件,不重排;所以单条流内是模型的输出顺序。
- 真机取证(用户当前章 58화 = 69908877,218 段):在页面 shadow DOM 里按阅读顺序现算 `paragraphKey`(与库里 `segment_key` **218/218 完全对齐**),再按本地服务提交序号 `translation_records.change_seq` 还原到达顺序:
  - 首 12 个到达的段落下标 = `100, 101, 50, 102, 51, 103, 52, 104, 53, 105, 54, 55` —— 三条流(0-49 / 50-99 / 100-149)交错,后段先出是**并发**,不是颠倒;
  - 更极端:0-49 那条流**首行迟到 58s**(首个提交 1789744098972,而 100-149 是 1789744031152),这段时间 50-199 甚至 200-217 都先出完了 ⇒ 用户看到「后面的快得多」;
  - 本轮跨度 98.4s,5 个 50 段桶 + 18 段尾桶。
- 但确实多翻了一遍,原因不是失败重试:`applied_operations` 显示同章有**两个 taskId**(…f6zyu6 与 …s4iilj),后者在前者还在流式时就启动、重叠约 47s;按段落下标映射,第二轮覆盖的正是第一轮尚未出字的 118 段 ⇒ **218 段里 118 段被翻了两遍**(`record_revision = 2`、两条版本)。第一轮全部是 `stream:` 操作、rev 从 1 开始 ⇒ 这次**没有**发生「批次失败 → 逐段补翻」。
- 根因:`translateNovelText` 换新 taskId 时**不取消旧任务的流**——旧流会继续把同一批段落翻完并提交;而新任务的 `pending` 只看「已有译文的段落」,把旧任务**在途**的段落当成缺失又发了一遍。
- 修复(`content/modules/novel-workflow.js`):新任务开始前先 `cancelNovelTranslationStream(旧taskId)` + `CANCEL_TRANSLATION_TASK` 取消旧任务,它没做完的段落由新任务按「尚无译文」覆盖 ⇒ 同一批段落最多只翻一遍,也省下重复的 token 与时间。
- 测试:`tests/novel_screen_continue.test.mjs` 新增「新任务取代旧任务:先取消旧任务的流式请求,避免同批段落被翻两遍」。全量 Node 回归 **107 个文件 1142/1142 通过**;`eslint extension/src` 0 错;行数门禁过;`scripts/build-extension.mjs` 构建成功。
- 回答用户的三个可能:①发送顺序**没有**颠倒(就是阅读顺序);②**不是**批次失败重发(这一轮没有失败重试);③真正多出来的一遍来自「上一轮任务没被取消」,已修。
- 触发链(为什么会冒出第二个任务):`resetNovelNavigationState`(`novel-reader.js`,换章/换作品时重置)把 `textStatus` 打回 `idle`、清空 `translations`,却**没有取消在途的流** ⇒ 悬浮球不再显示「翻译中」,用户再点一下(或走补翻入口)就开了第二个任务;新任务先按持久缓存过滤(已提交的 100 段直接从库里补出来),剩下没落库的 118 段正是第一条流里还没出字的那批 ⇒ 同一批段落被两条流同时翻。第二条修复:`resetNovelNavigationState` 重置前先取消旧任务的流(内容侧 port + `CANCEL_TRANSLATION_TASK`),并清空 taskId。
- 代价(为什么这算真 bug 而不是"多花点钱"):两条任务同时在跑时,上游最多 6 条并发流,服务商排队 ⇒ 0-49 那条流在任务 1 里 118s 才出第一行、在任务 2 里 160s 才出第一行;整章 218 段耗时被拉长,且 118 段译文会被第二条流改写一次(版本 v1→v2)。
- 测试:新增 `tests/novel_reader_reset_cancel.test.mjs` 2 例(换章必须取消在途任务并清空状态;同章重渲染不得误取消);`tests/novel_screen_continue.test.mjs` 增「新任务取代旧任务:先取消旧任务的流式请求」。全量 Node 回归 **108 个文件 1144/1144 通过**;`eslint extension/src` 0 错;行数门禁过;`scripts/build-extension.mjs` 构建成功。
- 仍未修(诚实说明):`pending` 只按「是否已有译文」算,不认识「在途」——跨任务无法感知,所以只要还能出现两个任务就仍有重复风险;本次两处取消把「两个任务并发」这个前提消掉了,重复随之消失。
- 渲染时序(回答「后面先到、前面迟到时,前面是立即补上还是等后面渲染完」):**立即补上,不存在等待**。`novel-stream-workflow.js` 的事件回调每收到一个 `paragraph` 事件就同步调 `renderNovelTranslation(item.node, text, true)`(`novel-renderer.js:109`,纯同步 DOM 写,不排队、不等别的段);单条流内部用 `eventQueue = eventQueue.then(...)` 串行处理(所以单条流内不会乱序),三条流之间没有任何锁——JS 单线程,DOM 写入天然一次一个,但谁也不等谁。译文写在各段自己的 `:scope > .mt-novel-translation` 里,「补洞」是就地补,文档顺序永远等于阅读顺序。唯一会「迟到才出现」的情况:该段 DOM 节点在流式期间被阅读器换掉(重渲染/翻屏),那次渲染写进了已脱离文档的旧节点,要等下一次 `reapplyNovelTranslations`(shadow DOM 变动触发 reconcile,或切显示模式)按内容哈希匹配当前节点再补上。
- 由此产生的两个可见现象(均未改,记录在案):①双语模式下补洞会把下方内容下推,页面会被顶一下;②流式到达的段一律按 `showTranslation = true` 渲染并翻转全局意图,所以流式期间按「显示原文」挡不住后续到达的段。
- 若想更接近「顺序出现」:设置 → 小说流式分段把每批段数调大(默认 50,上限 150),批数变少、并发交错的窗口就小;代价是整章总时长变长(并发本身就是为了压总时长)。


## 2026-09-18 — 网页翻译「太慢」：实测瓶颈在模型往返，改为流式增量渲染

- 用户追加反馈:「而且感觉网页翻译太慢了。」
- 实测(Chrome 真机 + 本地夹具页 `http://127.0.0.1:8899/`,54 段韩文 ≈ 3.2k 字,用用户当前配置):
  - 点击 → **已缓存**的段渲染出来:**330ms**(说明扫描/enrich/服务预检/缓存查询都不是瓶颈);
  - 22 个未缓存可视区段被组成 3 个请求,先后在 **23.1s / 28.6s / 28.9s** 返回(每次 6~8 段);
  - 之前那次 Kakao 页 23 段约 5s ⇒ 同一条链路快慢差距就是**模型生成速度/首字延迟**,不是扩展调度。整个可视区必须等一次 20~30s 的往返才有第一个字。
- 结论:再优化扫描/分批收益有限(极小批次换来的只是更早一点),真正的问题是「等一整批」。修复方向 = **把等待变成渐进的**:
  - 新增 `shared/translation-row-stream.js`:SSE 事件切分(跨网络分片可拼)+ 从**尚未闭合**的 JSON 里增量提取**已经完整**的译文行。安全规则:一行必须成对出现且紧跟右花括号,残缺行绝不猜(否则会把下一行开头误当本行译文);两种键序都认;转义用 `JSON.parse` 还原。
  - 新增 `background/modules/translation-provider-stream.js`:`stream:true` 请求,边收边把行抛给 `onRow`;服务端忽略 stream 直接回普通 JSON 时就地解析(**不再白发一次**);`response_format` 兼容性 4xx 返回 `null` 交回非流式;**中途断流但已拿到行时返回已拿到的行**(缺项交给既有的逐项补翻兜底,部分译文比整批失败有用);真失败(Key/额度/401)照旧抛错 ⇒ 失败原因照旧可见。
  - `translation-provider.js`:批量请求支持 `onRow`,并把模型内部 id(`canonical-request-N`)映射回本批 item id;`ocr-pipeline.js` 再映射回**原文**并 `chrome.tabs.sendMessage({type:"WEBPAGE_TRANSLATION_PARTIAL"})` 推给标签页。
  - 内容脚本:`applyPartialWebpageTranslations`(实现在 `webpage-renderer.js`,受 400 行门禁)只认当前 taskId、按原文匹配未完成段、立即渲染;最终 `settleBatch` 仍会覆盖一次(渲染幂等),所以提前显示的内容不会被留下错的;另加守卫「已 done 的段不因整批缺项被翻成失败」。
- 安全边界:流式只对 `mode === "webpage"` 开启;链路上任何一步不成立(无 body reader / 非 SSE 且解析不出 / 400 response_format)都会回退到原来的整批请求 ⇒ 最坏情况等于今天的体验。图形行数门禁压力用等价压缩处理(`translation-provider.js`、`ocr-pipeline.js`、`webpage-translate.js`、`webpage-scheduler.js` 均压回 400 行内)。
- 测试:新增 `tests/translation_row_stream.test.mjs` 11 例(残行不猜、逐行不重复、键序颠倒、转义、跨分片 SSE、边收边抛、忽略 stream 时就地解析且只发一次请求、response_format 回退、断流返回部分行、真失败仍抛错);`tests/webpage_toggle.test.mjs` 增「过期任务的增量丢弃 + 同一行不重复渲染」。全量 Node 回归 **107 个文件 1141/1141 通过**;`eslint extension/src` 0 错;行数门禁过;`scripts/build-extension.mjs` 构建成功。
- 待用户操作:**必须在 `chrome://extensions` 重新加载扩展再刷新页面** —— 这次内容脚本与背景都改了(实测只刷新页面时页面里跑的还是旧内容脚本)。重载后应能看到译文「一条条陆续出现」,而不是等半天一次性出现。
- 补充(回答「为什么慢」):单次请求 20~30s 是**服务商侧的生成速度**(实测约 2.7s/条,≈20 tok/s 量级)。扩展能做的是「早显示」和「并行」;若想整体更快,换更快的模型/服务商比调参数有效。快捷弹窗里的「并发数/每批段数/每批字符数」(快速模式 = 5/32/3200)是并行与批次大小的旋钮:并发调高、每批调小会让**第一行更早**出现(代价是请求数变多,可能触发限流)。


## 2026-09-18 — 网页翻译双语模式：译文退化成 hover 提示（看不到）；长文本节点让调度器死循环

- 用户反馈两件事:①「双语模式,网页翻译只有当鼠标移到文字上的时候才出现翻译,我想让它直接出现在原文字后面」;②「翻译总是出现错误,就是那个红色的刷新图标,这不是偶发现象」。
- 真机取证(Chrome,用户当前 Kakao 阅读页):`document.querySelectorAll('.mt-webpage-bilingual-translation').length === 0`,页面里只存在**一个** `.mt-webpage-translation-tooltip` ⇒ 双语模式下 30/30 段全部走了 hover 分支,不悬停就一个字都看不到。与用户描述完全一致。
- 根因 1(`webpage-renderer.js`):`safeBilingualContainer` 只认「独占一个块级元素的文本节点」,而 `BLOCK_TAGS` 只列了 P/H1-H6/BLOCKQUOTE/LI/TD/TH。真实网页的文字大多在 div/span/a/button 里 ⇒ 主路径几乎不命中,其余一律 `attachTooltip` 悬停提示。修复:**删掉 hover 提示整条链路**,双语译文元素永远插在**原文字节点之后**:独占块级容器时块级排版(另起一行),否则行内排版(紧跟原文同一行)。重复渲染幂等(同一条译文不插第二份,菜单「重新显示译文」会重放),cleanup 同时支持 block/inline。
- 根因 2(红 ↻ 看不到原因):失败原因此前只写在红图标的 `title` 上,不悬停就无从得知;悬浮球也只说「翻译失败」。修复:进度面板在 `失败 N` 后追加一行 `失败原因：…`(首个失败段 `errors[0].error`,截断 160 字),同一原因只写一次 `console.warn`。**红 ↻ 的含义是「这一段的翻译请求真的失败了」——Key 未配置/余额不足/限流/超时/模型漏 id,现在都能直接看到。**
- 根因 3(调度器死循环,网页翻译会永远转圈):`webpage-scheduler.js#composeBatch` 把字符上限写成 `chars + len > maxChars` 就 break。单个文本节点超过该档上限(默认 P0 600 / P1 1200 / P2·P3 2400 字,长正文段落很常见)时,该档第一批就 break ⇒ **返回空批**,而这段仍是 pending ⇒ `tryStartBatches` 在同一批上无限空转:队列永不排空、`drainWebpageQueue` 永不返回、`state.working` 永远为真,并向后台空发无数条 0 项 `TRANSLATE_TEXT_BLOCKS`。修复:上限改「软上限」——首个段超限也单独成批;`tryStartBatches` 另加空批防护。
- 顺带修复 1:`controls-triple.js` 的「重试失败段落 / 全部重新翻译」把同步函数 `requeueWebpageSegments()` 的返回值(数字)当 Promise 用(`.then`)⇒ 点击必抛 TypeError、界面毫无反应,这两条菜单此前是**死的**。
- 顺带修复 2:`requeueWebpageSegments(statuses, options)` 支持 `force`,「全部重新翻译(绕过缓存)」现在真的把 `force` 传进翻译请求(此前只是把段标回 pending,再请求仍命中缓存 ⇒ 对已译段落等于空操作);结算后清掉 force,普通失败重试继续走缓存。
- 测试:新增 `tests/webpage_bilingual_render.test.mjs` 8 例(块级/行内都插在原文之后、段落含链接走行内、重复渲染幂等、译文变化替换、恢复原文只删译文元素、仅译文模式仍改写文本节点、**面板写出失败原因**);`tests/webpage_scheduler.test.mjs` 新增「长文本节点单独成批、队列排空」并扩展重译用例断言 `force` 真的传到请求。全量 Node 回归 **106 个文件 1129/1129 通过**;`eslint extension/src` 0 错;行数门禁过;`scripts/build-extension.mjs` 构建成功。
- 环境备注:本沙箱里 `node --test` 会 spawn EPERM,全量回归改为「逐文件直接 `node <file>`」执行;`npm run build`(esbuild 需要 spawn 子进程)同样需要更宽的执行权限。
- 待用户操作:`chrome://extensions` 重新加载 + 刷新页面(内容脚本与 styles.css 都要重载)。**若红 ↻ 仍出现,请把进度面板/控制台里的「失败原因」原文发来** —— 那句话直接指向 Key、余额、限流还是超时,是这次唯一还缺的现场证据。

## 2026-09-16 — 修复「对话引号被丢掉」:流式链路既没有提示词规则、也没有兜底修复

- 用户反馈:`“난 무조건 탈색부터 한다.”` 被翻成 `我不管，肯定要先漂发。`(引号没了),并要求「限制一下提示词和加上代码检测，除了双引号还有单引号也忽略了」,同时说「我之前好像让AI处理过这个问题」。
- 真机取证(`.local-data/translations.db`,只读直查):该条 `record_key=1f3416cc` 有两个版本 —— v1(流式写入)= `我不管，肯定要先漂发。`,v2(小批/补翻链路重写)= `“我不管，肯定要先漂发。”`。**同一段两条链路结果不同 ⇒ 不是"没修",是有一条链路没接上。**
- 根因(上次修了一半):`restoreDialogueQuotes` 这个确定性兜底是 2026-09-15(90c2d8a)加的,只接进了**小批链路**(`novel-translation.js#handleTranslateNovelChunk` 的 `restoreQuotes`)与两条读缓存/读正式库的路径(`novel-cache.js`、`novel-workflow.js`)。**多数段落实际走的流式链路完全没有接**:`background/modules/translation-stream.js` 只是把 Python 服务的事件原样转发+存快照,`content/modules/novel-stream-workflow.js` 直接渲染事件里的译文;而服务端提示词(`local-ocr-service/ocr_service/pipeline/translation_stream.py#_prompt`)里**根本没有引号规则**。两处都缺 ⇒ 流式翻出来的段落引号必丢,小批链路一接手就又"好了"。
- 规模(历史译文统计,`active_version` 口径):**novel 191 条 + webpage 4 条**「原文整段被引号包住、译文一个引号都没有」(全部可确定性修复);另有 32 条「引号与叙述混排」的只能靠模型修。样例:`“내가 배려해주지 않아도, 걔넨 알아서 잘할 거야.”` -> `就算我不去关照，他们也会自己做得很好。`
- 修复 1(`extension/src/shared/utils.js`):引号对表补齐 **单引号**与更多风格 —— `“ ”`、`„ “`、`‘ ’`、`‚ ‘`、`「 」`、`『 』`、`｢ ｣`、`« »`、`‹ ›`、ASCII `"`/`'`、`＂`、`’ ’`、`＇`;新增 `containsDialogueQuote()` 与 `hasDroppedDialogueQuotes()`(后者=「原文有引号、译文一个都没有」,单引号同样覆盖)。
- 修复 2(`shared/novel.js#validateTranslations`):**校验前先做确定性修复**。原文整段被引号包住的当场补回、不占用重试;修不回来的(引号与叙述混排)报 `dialogue_quote_missing` 并给出 `quoteFallbacks` 可保留译文。这就是用户要的"代码检测"。
- 修复 3(`background/modules/novel-translation.js`):回落机制从「只认术语」推广为通用 —— `indexFallbacks()` 合并 `glossaryFallbacks`(→`glossary_warning`)与 `quoteFallbacks`(→`dialogue_quote_warning`),`acceptFallback()` 按 `code` 出警告。**重试仍拿不回引号时保留译文 + 出警告,绝不因为格式问题把整段变成未翻译**;`summarizeTranslationWarnings()` 的文案按存在的警告码拼接(纯术语场景文案与原来逐字一致)。
- 修复 4(提示词,两处都要改):
  - `novel-translation.js#buildPrompt`:引号规则从一句扩成 `QUOTE_RULE`(逐字符、正反例),并在重试时点名「上次哪几个 id 丢了引号」;`PROMPT_VERSION` **v2 → v3**(它在缓存键里,不 bump 旧缓存会掩盖新行为)。
  - `local-ocr-service/.../translation_stream.py`:新增 `DIALOGUE_QUOTE_RULE` 常量并进 `_prompt` —— **服务端提示词此前完全没有引号规则**。
- 修复 5(流式事件兜底,`background/modules/translation-stream.js#relayStream`):按 `paragraphKey → originalText` 对每条 `paragraph` 事件做 `restoreDialogueQuotes`,**并同步改写要落库的快照译文**(`event.record.activeVersion.translatedText`)—— 否则写进正式译文库的仍是没引号那版。修复幂等,服务端将来自己也修也不会双重包裹。
- 为什么不在 Python 侧也修译文:本项目既有设计是「**库存模型原样,读取时确定性修复**」(`novel-workflow.js`/`novel-cache.js` 读正式库时都会修复)。在服务端再实现一份等于把同一规则写两遍(参照 2026-09-15 绑定网址通配符那次两边必须同步的教训),故只补提示词。
- 测试:新增 `tests/novel_quote_guard.test.mjs`(7 例:校验层先修后校验/混排报错并给回落、原文无引号或译文自带引号都不报、警告汇总文案、小批链路用户实测那条、小批链路混排重试失败保留译文+警告、**流式链路事件与落库快照都被修好**);`tests/novel_dialogue_quotes.test.mjs` 3 例(新增单引号/`｢｣`/`«»`/`„“`/全角引号与幂等、`hasDroppedDialogueQuotes`)。写测试两个坑:vm 沙箱里返回的数组与本机不同 realm,`deepStrictEqual(arr, [])` 会报「same structure but not reference-equal」,要用 `arr.length`;跑后台测试前**必须先 `node scripts/build-extension.mjs`**(测试读 `dist/test/background.iife.js`)。
- 验证:全量 Node 回归 **1137/1137 通过**;`eslint extension/src` 0 错误;行数门禁过;`node scripts/build-extension.mjs` 成功;`pylint`(conda env `manga-translator`,3.3.9)**10.00/10**;`pytest tests -q` **103 passed 1 skipped**(与基线一致)。bump 提示词版本使 `tests/novel_translation_chunk.test.mjs` 的版本断言同步改为 v3。
- 待用户操作:①`chrome://extensions` 重新加载 + 刷新阅读页;②**本地 OCR 服务要重启**(`start_local_ocr_gpu.bat`)才会用上新的服务端提示词 —— 不重启也没关系,扩展侧的事件兜底已经能保证显示与落库都带引号。
- 未提交:改动仅在工作区(`shared/utils.js`、`shared/novel.js`、`background/modules/{novel-translation,translation-stream,translation-utils}.js`、`local-ocr-service/ocr_service/pipeline/translation_stream.py`、`tests/novel_dialogue_quotes.test.mjs`、`tests/novel_quote_guard.test.mjs`、`tests/novel_translation_chunk.test.mjs`),commit 需用户确认。
- 遗留(待用户定):历史译文库那 195 条已存成没引号的记录,**不会自动改写**(读取时代码会就地修好再显示,所以界面是正常的);如需把库里也改成带引号,可以加一个一次性的批量修复入口。

## 2026-09-16 — 修复「翻译过的小说不再生成记忆」:写记忆只挂在「这次真的调了模型」这条路径上

- 用户反馈:「小说记忆这个功能是不是不要比较好。它出了问题。翻译过的小说好像不会生成记忆了」。
- 根因(`content/modules/novel-workflow.js#translateNovelText`):写记忆(`SAVE_NOVEL_MEMORY`)原先**只挂在「这一屏刚由 AI 翻完且整屏完成」这一条路径**上。重读一本已经翻过的书时,段落全部命中 SQLite 正式译文库(`ensureTranslationServiceOnline` 直接回记录)⇒ 不产生任何模型请求 ⇒ 走「`!pending.length` ⇒ 提前返回」⇒ **永不写记忆**。所以首次读新章能生成记忆、回头重读旧章一条都不生成 —— 与用户描述完全一致。
- 复现(修复前,4 段全命中译文库的最小桩):`SAVE_NOVEL_MEMORY` 0 次、`TRANSLATE_NOVEL_CHUNK` 0 次,而返回仍是 `completed: true`;对照组(首次翻译)写 1 次。**「完成了但不落库」是没有报错的静默丢状态。**
- 修复 1:抽出 `saveNovelMemory(chapter, state)`,「整屏完成」与「整屏全部命中译文」两个分支都调用(后者加 `allItems.length` 守卫,空屏不凭空建记录);「本地服务离线」「任务被取消」两个分支仍然不写(这次确实没学到新东西)。
- 修复 2(顺带):保存成功后清空 `state.memoryDeltas`。快照存的是「本话新增」的增量,同一话翻下一屏时会把**已存过的增量再叠一遍**(摘要层层重复、越积越长) —— 原先每次保存都重发全部累计增量,是本次改动之外的既有缺陷。
- 修复 3(顺带):保存改为检查响应体 `ok === false` 并报错。`sendRuntimeMessage` 对「后台返回 ok:false」是 **resolve 而非 reject**,原来的 `try/catch` 抓不到 ⇒ 存失败(例如缺 key/chapterId)完全静默;现在会 `REPORT_STATUS` 且**不清空增量**,等下次重试。
- 测试:`tests/novel_memory_save.test.mjs`(新增 4 例:首次翻译要写、全命中文库也要写、下一屏只带本屏新增量、存失败要报错且保留增量)。`tests/novel_chunk_pipeline.test.mjs` 两处断言从「看 `state.memoryDeltas` 残留」改为「看保存出去的消息」—— 因为增量现在保存后即清空,残留不再是契约。写这个测试的两个坑:`shared/novel.js#buildChunks` 的 `limit = Math.max(400, targetChars)`(传小值没用,想让一段一块必须把段落写到 450 字以上);桩里 `buildNovelCacheRecordId` 要按 `chapterId:paragraphKey` 生成可对的 key,否则「全部命中」模拟不出来。
- 验证:全量 Node 回归 **1128/1128 通过**(基线 1124 + 新增 4);`node node_modules/eslint/bin/eslint.js extension/src` 0 错误;行数门禁通过;`node scripts/build-extension.mjs` 构建成功。
- 未提交:改动仅在工作区(`extension/src/content/modules/novel-workflow.js`、`tests/novel_memory_save.test.mjs`、`tests/novel_chunk_pipeline.test.mjs`),commit 需用户确认。
- 待用户操作:`dist/` 为 gitignore 产物,需在 `chrome://extensions` 点「重新加载」并刷新阅读页(设置页「小说记忆」分区是独立 iframe,也要关掉重开)。
- 附带结论(回答用户「是不是不要比较好」):**不建议删**。真正吃 token 的是「记忆被塞进提示词」,而它已经有独立开关(`设置 → 阅读与显示 → 使用小说记忆`),关掉即等于停用且可随时恢复;删掉反而要同时拆掉提示词注入、记忆面板、存储 schema、后台三组消息与一批测试。本次是「一个 `return` 的位置」问题,不是设计问题。

## 2026-09-15 — 修复「侧栏加术语一律进默认术语库」:请求里没带页面地址,归属解析无从下手

- 用户反馈:「在管理当前章节译文界面所添加的词汇,应该把它加到所属网页的归属术语库里吧。现在全都在默认术语库里」。
- 现场取证(`.local-data/glossary.db`):最新一条 `23:32 이율 => 伊律` 的 `library_id` 是 `default`;而同一时段经**术语库页**加的 `23:30 씨발 => 卧槽` 落在 `library-12ea4c07-cc8`(韩语日常词汇)。即「术语库页那条路是对的,侧栏这条路是错的」,不是显示问题,是**真的存错了库**。
- 当前阅读页 `https://page.kakao.com/content/69863606/viewer/69863609/`(我杀死的本命出道 第2话),而库 `我和我杀死的最爱一起出道`(`library-8f246e3e-7c5`)正绑定 `https://page.kakao.com/content/69863606/*` —— 本该命中却落进了默认库。
- 根因:`sidepanel/modules/revision-ui.js` 的「加入术语表」只发了 `{source, target, note}`,既没有页面地址也没有 `chapterKey`。后台 `resolveEntryLibraryId` 只认两档输入 —— `entry.libraryId`(显式指定)与 `chapterLibraryId`(由候选提取在 pending 里留下的章节记录),两者都是空就回落到默认库。术语库页之所以正确,是因为候选卡片的库选择框会把 `libraryId` 一起发出去。
- 为什么不能只靠 `chapterLibraryId`:侧栏这一章往往从未跑过候选提取,pending 里根本没有它的记录 —— 网址绑定是这种情况下唯一的归属线索。这也与术语库页 `effectiveLibraryId` 的既有优先级(手动指定 > 网址匹配 > 默认)不一致,本次统一。
- 修复 1(`background/modules/term-discovery-messages.js`):`resolveEntryLibraryId` 增加第四档 —— 前三档都不成立时用 `matchLibraryByUrl(libraries, pageUrl)` 按网址取库(只看已启用的库,与候选提取判定同源),再兜底默认库;`handleConfirmTermCandidates` 归一化并透传每个条目的 `pageUrl`,本地写入与服务端同步两处调用点同步更新;响应新增 `libraryNames`,让调用方能说出「加进了哪个库」。
- 修复 2(`content/modules/novel-revision-panel.js`):章节快照新增 `url: location.href`。`scopeKey` 是 `kakao:<作品id>`,分不出章节页,不能替代;取值与候选提取(`novel-term-discovery.js` 传的 `location.href`)同源,两边才认得同一章。
- 修复 3(`sidepanel/modules/revision-ui.js`):「加入术语表」带上 `pageUrl` 与 `chapterKey`(同一值),状态行改为 `已加入术语库「<库名>」`,让去向可见;提示语变长,自动收起由 1.2s 放宽到 2.6s。
- 真机数据端到端验证(用 `glossary.db` 里真实的 13 个库与真实阅读页网址,跑新构建的 `dist/test/background.iife.js`):`content/69863606/viewer/69863609/` → 命中 `https://page.kakao.com/content/69863606/*`,落库「我和我杀死的最爱一起出道」;对照一个未绑定任何库的页面 → 正确回落「默认术语库」,回退行为未变。
- 验证:新增 5 项回归到 `tests/glossary_library_routing.test.mjs`(侧栏只带网址 → 落在网址绑定的库、无绑定 → 默认库、条目自带 `libraryId` 压过网址匹配、网址绑定的库被停用 → 默认库、章节已有库 → 不被网址匹配覆盖)。定向 11/11、全量 Node 回归 **1124/1124 通过**;`eslint extension/src` 0 错误;行数门禁通过;`scripts/build-extension.mjs` 构建成功。
- 待用户操作:`dist/` 为 gitignore 产物,需在 `chrome://extensions` 点「重新加载」并刷新阅读页(侧栏是独立页面,也要关掉重开)。

## 2026-09-15 — 修复「翻到后面的屏永远停在原文」:分屏阅读下补翻链路整条是死的

- 用户追问「版权页插件怎么不翻译啊」,实机复核确认这是**独立的第二个 Bug**,与上一条的串页问题无关:上一页修复后版权页不再被写错译文,但它自己**从头到尾没被翻译过**,一直停在韩文原文。
- 现场(Chrome 实机):末页版权页 14 个段落 `translatedCount = 0`、无任何 `mt-novel-*` 包裹;而悬浮球写着「**小说翻译，当前显示中文，点击恢复原文**」,进度面板写着「小说翻译完成 正文 205/205」——扩展确信整章已译完。
- 取证:`analyzeNovelCacheStatus` 的 `cacheCheckedKey` 只有 `scopeKey:chapterId`,而覆盖率只在**当前挂载的那一屏**上算过。首屏判定一次后该 key 就锁死,后面翻到的屏再也不会重算 ⇒ 悬浮球永远显示首屏的结论。
- 根因 1(触发缺失):`reconcileKakaoNovelReader` 用 `state.surface.root !== surface.root` 判断「换屏」,但 KakaoPage 翻页**复用同一个 shadow 宿主**,只有宿主内内容换掉 ⇒ 该判断恒为 false;`onNovelSurfaceChanged` 的第三个参数同理恒为 false,而它只做 `reapplyNovelTranslations`(重画已有译文),**从不发起翻译**。于是新翻到的屏既不会被补翻,也没人会发现它是空的。
- 根因 2(入口被挡):`translateNovelChapter` 里 `if (options.missingOnly && state.textStatus === "complete") return reused` 与 `if (state.textStatus === "complete" && !force) return 切换显示` 都排在「按当前屏重算待翻译集合」**之前**。分屏阅读下 `textStatus === "complete"` 只代表此前访问过的那几屏译完了,却把后面所有屏的补翻和手动点击一起挡掉 —— 连菜单里的「补翻」也救不回来。
- 修复 1(`novel-reader.js`):新增 `novelSurfaceSignature(surface)` = 屏内各段落的 `data-p-id` + 源文哈希。签名只用原文,渲染插入的 `mt-novel-source` 译文包裹不改变它,不会自激。`reconcileKakaoNovelReader` 每次更新 `state.surfaceSignature`;`scheduleNovelReconcile` 据此算出 `surfaceChanged = rootChanged || 签名变化` 并透传给 `onNovelSurfaceChanged`。
- 修复 2(`novel-workflow.js`):新增 `continueNovelTranslationForCurrentScreen(surface)` —— 只在用户已为本章开启过翻译(`textStatus` 为 `complete`/`partial`)时继续;幂等(`screenContinueTask` 防重入);先用持久缓存补,剩下的才发翻译请求。`onNovelSurfaceChanged` 仅在 `surfaceChanged === true` 时调用它。
- 修复 3(`novel-workflow.js`):`translateNovelChapter` 把「按当前屏重算待翻译集合」提到两个提前返回**之前**。只有本屏确实无缺段时才保留原语义(missingOnly ⇒ reused;普通点击 ⇒ 译文↔原文切换)。空段落表的旧行为不变。
- 修复 4(`novel-cache.js`):`cacheCheckedKey` 加入屏签名,覆盖率按屏重算,悬浮球不再拿首屏的结论去描述后面的屏。
- 验证:新增 `tests/novel_screen_continue.test.mjs`(10 项:同宿主换内容被识别为换屏、渲染包裹不改变签名、空屏签名、缺段时点击不切换而是翻译、补翻不再被提前挡掉、全有译文时仍按原语义返回/切换、`surfaceChanged` 门控、未开启翻译时零请求)。全量 Node 回归 **1119/1119 通过**;`eslint extension/src` 0 错误;`scripts/build-extension.mjs` 构建成功。
- 用户可见变化:翻到新的一屏时会自动补翻(带缓存优先,不重复请求),悬浮球在该屏的真实缓存覆盖率上重新判定。

## 2026-09-15 — 修复「小说译文串页」:EPUB 分页后同号段落认领上一页译文

- 现场(Chrome 实机,KakaoPage `내가 죽인 최애와 데뷔합니다` 第 1 话):末页版权页(`지은이 │ 유쓰` / `펴낸이 │ 김주형` / `마케팅 │ 한재혁` / `전자우편 │ jplusmedia@…` / 免责声明)被画上**作品开头**的句子——`第一话`、`有人说过。如果觉得憋屈，就自己亲自上场。`、`所以——`、`[IMPACT《Boom-Shot!》MV]`。悬浮球同时显示「小说翻译，缓存已有完整译文」，即扩展认为本章已译完。
- 取证 1:正文在 `[data-testid='viewer-container']` 下的**影子根**内,段落节点带 `mt-novel-source` / `mt-novel-translation` 包裹。逐段导出后,翻译与原文**按序号一一错位对应**(`📄 pid 0 → 第一话`、`pid 3 → 有人说…`、`pid 5 → 是啊…`、`pid 7 → 说我自己来唱…`、`pid 9 → 所以——`、`pid 13 → [IMPACT《Boom-Shot!》MV]`)。
- 取证 2:`.local-data/translations.db`(20572 条记录)中,版权页原文 `지은이` / `jplusmedia` / `마케팅` / `제이플미디어` / `한재혁` **均为 0 条命中**——这段原文从未被翻译过,所以不是模型错译,也不是缓存内容写错。而 `[임팩터 "Boom-Shot!" M/V] → [IMPACT《Boom-Shot!》MV]` 是作品开头的既有记录。
- 取证 3:末页 14 个段落的 `data-p-id` 是 `0..13`。**KakaoPage 的 `data-p-id` 只在单个 EPUB 文档(一屏)内唯一,翻页后从 0 重新编号**;而 `extractKakaoNovelChapter` 生成的段落身份只有 `pid`(`pid#同 id 序号`),于是在同一章的每一屏里 `0`、`3`、`5`… 反复出现。翻页后 `reapplyNovelTranslations` 把 `state.translations`(键为上一屏的段落 id)原样重刷到新一屏 → 同号段落认领上一屏译文。
- 根因定位:`content/modules/novel-reader.js` 的段落身份缺少「屏内/内容」维度;`content/modules/novel-renderer.js` 的 `reapplyNovelTranslations` 信任 id→节点映射,不做任何内容校验。持久缓存(`buildNovelRecordId` 已含 `sourceHash`)是内容寻址的、正确的,问题只在内存的渲染层。
- 修复 1(身份内容化):`extractKakaoNovelChapter` 生成 `pid#序号@源文哈希前12位`。同号但不同内容的段落从此不可能撞号;`pid`/`domAnchor` 保留原始 `data-p-id`,定位与恢复逻辑不变。
- 修复 2(栅栏):`novel-renderer.js` 新增 `splitNovelParagraphId`(兼容旧格式 `pid` / `pid#序号`)与 `computeNovelParagraphSourceHash`(复用 `getOriginalNovelParagraphText` + `normalizeSourceText` + `computeSourceHash`,与提取端同源)。`reapplyNovelTranslations` 在渲染前比对节点当前源文哈希,不一致则**拒收并 `restoreNovelNode` 清掉错配残影**。
- 副作用修复:版权页的段落此前因 id 撞号被误判为「已翻译」,现已正确计入待翻译,悬浮球的「缓存已有完整译文」误导徽标消失。
- 现场验证(Chrome 实机,未重载扩展前的真机数据):对末页 14 个真实段落按新方案重算,`newId` 全部互异(`0@795136c8`、`3@c2da865a`、`5@f3fe8cb9`、`7@95200a8a`、`9@811c9dc5`、`13@be7fff13`),且**逐行 `stable: true`**(渲染后经 `.mt-novel-source` 回读的哈希与提取时一致)⇒ 合法译文不会被误判为错配。
- 验证:新增 `tests/novel_paragraph_identity.test.mjs`(4 项:跨屏同号段落身份互异、错配拒收且版权页原文不变、错配残影被清理、`splitNovelParagraphId` 兼容旧格式)。全量 Node 回归 **1109/1109 通过**;`eslint extension/src` 0 错误;`scripts/build-extension.mjs` 构建成功。
- 待用户操作:`dist/` 为 gitignore 产物,需在 `chrome://extensions` 点「重新加载」并刷新阅读页复核(content script 不会因刷新页面而更新)。

## 2026-09-10 — 修复「插件无法翻译」:免密钥服务商被密钥门槛拦住

- 现场定位:用户激活的翻译档案是**无密钥本地 Ollama**(`provider: ollama`, `apiKey: ""`, `baseUrl: http://127.0.0.1:11434/v1`, `model: translategemma:12b`)。当前 Kakao 阅读页 45 个网页翻译段失败,其中 44 个失败节点 `title` 正是 `Translation API Key is missing. Please configure it in popup.`;悬浮球只显示笼统的「网页翻译失败」。`.local-data/translations.db` 中最后一次**新**网页译文提交为 8/12(此后全是缓存命中),与「新请求全部被拒」一致。本地 OCR 服务(8765)`/health`、`/translations/health` 正常,`ocrGeometryVersion` 与扩展一致,不是 OCR 或本地服务问题。
- 根因:`background/modules/ocr-pipeline.js` 的翻译入口无条件要求 `settings.apiKey`,而 `shared/llm-providers.js` 早已声明 `ollama`/`custom` 的 `needsKey: false`,`providers/translation.js` 的 `validate()` 与本地服务 `translation_stream.py`(`if api_key:`)也都支持免密钥上游 ⇒ 免密钥本地服务永远无法翻译。修复:新增 `llmProviders.keyRequired(providerId)` 作为唯一判定来源,`ocr-pipeline.js`、`novel-translation.js` 改为按服务商能力判断,错误文案改为可定位的中文(含服务商名与设置位置);`sendOpenAICompatibleTranslationRequest` 仅在 Key 非空时发送 `Authorization` 头。
- 次级缺陷 1:`config/vendors.js` 的 `applyVendorEntry` 把条目密钥当 legacy 回退值,而 `schema.js` 的槽位解析只在目标服务商槽位为空时才采用回退 ⇒ **同一服务商改 Key 不生效**(旧槽位永远胜出)。修复:条目写入自身服务商槽位并对其有最终决定权,其他服务商槽位保持不变。
- 次级缺陷 2:失败原因被吞。`webpage-batches.js` 的 `result?.errors || [...]` 兜底对空数组失效;`webpage-translate.js` 丢弃后台顶层 `error`;`webpage-startup.js` 的返回结果从不带 `error`,导致界面只剩「翻译失败/网页翻译失败」。三处均已修复,失败节点标题与悬浮球提示现在显示真实原因。
- 顺带清理:`content/modules/webpage-translate.js` 里 2 个字面 NUL 字节改为 `\u0000` 转义(运行时值不变;此前该文件被 ripgrep 判为二进制而整体跳过搜索)。
- 现场验证(修复前置):直接向用户本机 Ollama 按扩展同款请求体发请求 → HTTP 200,`response_format: json_object` 下 12/12 id 合法 JSON,约 6s(请求超时 30s 内)。
- 验证:新增/扩展 `llm_config`(keyRequired 矩阵)、`translation_vendors`(槽位覆盖、免密钥档案可翻译、缺 Key 中文提示)、`webpage_batches`(漏项原因不再被吞)、`webpage_scheduler`(启动结果与后台顶层 error 带出真实原因);定向运行 12/12、5/5、20/20 通过。`dist/` 为 gitignore 产物,需重新构建并在 `chrome://extensions` 重新加载扩展后在阅读页复核。

## 2026-07-15 - Codex

- 通过 Chrome 现场状态与本地 OCR JSON 定位分段根因：`그런 / 의미에서 / 이름이에요.` 属于同一个 `caption_panel`，而同一行的 `고른` 被区域检测误标为一个嵌套的 `speech_bubble`。该小区域约 93% 被外层区域包含，但旧的区域兼容规则禁止不同区域类型合并，最终把一句话拆成两个翻译段。
- 修复 `src/background.js` 及根目录同步文件的通用合并规则：仅当 caption/speech 两个区域高度嵌套，文字处于同一基线、间距紧密、角度和字号接近、背景色相近，且小区域面积明显小于外层区域时，允许跨区域合并；相邻但彼此独立的气泡仍保持分开。
- 新增正向回归覆盖“嵌套误检区域不能拆断一句话”，并新增反向回归覆盖“相邻独立 caption 与 speech 不得合并”。修复前正向用例稳定失败，修复后定向用例 `3/3`、完整 Node 回归 `442/442` 通过；`scripts/build-extension.mjs` 构建成功并更新 `dist/`。

## 2026-07-15 - Codex

- Chrome 现场确认两类错误方向都来自旧 OCR 几何结果，而不是译文 CSS 自行旋转：气泡短句 `야,` 的页面节点保留 `rotation=-89°`，此前单字现场仍为错误的 `온 / rotation=81°`。用户清缓存后仍无变化时，本机 `127.0.0.1:8765` 没有服务监听，页面只是继续显示内存中的旧 canonical/overlay，并未执行新 OCR。
- 使用当前磁盘代码对 `page-81cb...` 现场原图离线重跑，`야` 与下面一行的所有候选均为 `rotation=0°`；此前 `엇` 现场也已验证为 `-8.37° / orientation=0`。因此方向算法修复有效，遗漏点是服务进程和 OCR 缓存没有随几何算法升级建立版本边界。
- 新增 OCR 几何契约 `orientation-v2`：扩展请求携带版本，服务 `/health` 与 `/ocr` 回显版本；服务拒绝不匹配的客户端，扩展也拒绝缺少/错误版本的旧服务并明确要求重启。OCR 坐标模型版本提升为 `page-percent-v3-orientation-aware`，使修改前的缓存键自动失效，不要求用户猜测需要清哪类存储。
- 新增 Node/Python 回归覆盖请求版本透传、普通 OCR 的旧服务拒绝、服务端推理前协议拒绝及响应版本。完整 Node 回归 `440/440`、OCR Python 回归 `40/40` 通过，`scripts/build-extension.mjs` 构建成功；更新后的本地服务已启动，`/health` 返回 `ok=true`、`device=gpu:0`、`ocrGeometryVersion=orientation-v2`。

## 2026-07-15 - Codex

- Chrome 现场确认气泡 `"'노을'로 정해졌습니다!"` 的译文节点实际携带 `alignment=left` / `mt-align-left`，不是 CSS 偶发位移。原始两行中心分别为 `377.5px` 与 `370px`，中心差仅 `7.5px`；但左边缘差 `80px` 小于旧规则按字高放宽后的 `82.225px` 容差，因此“左对齐”分支先于“居中”分支命中。
- 修复 `src/background.js` 及根目录同步文件的通用对齐推断：当中心线离散度在允许范围内，且不超过最近边缘离散度的 `60%` 时，优先判为居中；真正齐左、齐右的段落继续使用原有边缘规则。该规则覆盖短行嵌套于长行中央的常见气泡排版，不依赖现场文字或固定坐标。
- 新增回归同时覆盖“中心相同但宽度差异很大的两行气泡”和“宽度差异很大但真正齐左的普通气泡”。旧逻辑下前者稳定失败为 `left`；修复后定向测试 `3/3`、完整 Node 回归 `439/439` 通过，`scripts/build-extension.mjs` 构建成功并更新 `dist/`。

## 2026-07-15 - Codex

- 通过 Chrome 依次复现两个跨页现场、一个方向现场：首个气泡的可靠实色气泡区域跨越接缝，但文字框在边界前 1px 结束；第二个现场的正确 seam OCR 已进入 `standalone`，却因历史 canonical 稳定 ID 被无关 seam 候选抢占而在 Store 中被同 ID 覆盖；方向现场的近方形单个韩文字框因长边判定得到约 `80.96°`，继而被错误旋转 `90°`。
- 修复跨页证据与 canonical 稳定性：拼接过滤和页跨度计算可在严格边界内使用与文字重叠的可靠 `speech_bubble` / `caption_panel` 视觉区域，同时拒绝整幅场景式超大区域；历史匹配预留所有具有精确后继的 canonical ID，并把重复 canonical ID 纳入不变量检查，避免 Map 静默覆盖。
- 修复方向判定：近方形 polygon 使用顶边作为文字轴，只有宽高比至少 `1.4` 的裁剪才尝试 `±90°`；两个方向的识别质量接近且都包含目标文字时才以几何方向打破平局，明显更好的识别仍可胜出。使用现场原图复核后由错误的 `온 / 80.96° / orientation 90` 改为 `엇 / -8.37° / orientation 0`。
- 修复加载框偶发消失：debug-only overlay 不再被误当作稳定译文复用；已有稳定译文保留时额外显示居中的加载状态卡，状态更新和清理只作用于该卡，不删除译文气泡。
- 回归覆盖新增可靠视觉区域跨缝、超大区域拒绝、稳定 ID 防抢占、近方形韩文方向、识别质量平局和加载状态卡生命周期。完整 Node 回归 `438/438`、OCR Python 回归 `39/39` 均通过；现场 OCR 原图复核通过，`scripts/build-extension.mjs` 构建成功并更新 `dist/`。

## 2026-07-15 - Codex

- Chrome 重载诊断确认：“那个想睡觉的人”位置的正确 seam OCR `다준이ㅋㅋㅋㅋ작곡 잘하네` 仍在两个 page-local seam window 中，debug raw/final 框均正常，但 `data-seam-diagnostics=[]` 且 `surface.bubbles=[]`。这证明它在进入 surface 候选循环之前就已脱离 canonical，而不是被翻译、背景图或几何条件过滤。
- 根因：OCR debug 的 filter reason 会重新构造 filtered observation；当它与最终 retained candidate 具有相同文本和几何时，两者生成相同的确定性 observation ID。reconciler 检测到 active/filtered 同 ID 冲突后，中止 seam 增量 reconciliation，保留旧的 page-only canonical snapshot，因此现场只显示上一页末尾错误的小框。
- 修复 `src/background.js` / 根目录 `background.js`：provider-neutral OCR 结果在边界处保证 retained/filtered ID 集合互斥，retained 证据优先；`deepFreezeObservationResult()` 同样规范化从 v22 缓存读取的旧 payload，无需用户清缓存即可恢复正确 seam observation。冲突数量写入 `counts.filteredShadowedByRetained` 供诊断。
- 完善 `src/kakao-pipeline.js` / 根目录 `kakao-pipeline.js`：没有进入任何 canonical 的 seam observation 现在输出 `no_canonical`，并附带 coverage ledger 的 resolution/filterReason，避免候选前置丢失再次只显示空诊断数组。
- 新增回归覆盖“同一 seam candidate 同时存在于 final 与 debug filter”以及旧缓存 active/filtered ID 冲突；验证通过：`background_runtime` 77/77、`kakao_pipeline` 160/160、完整 Node 回归 434/434，`scripts/build-extension.mjs` 构建通过并更新 `dist/`。

## 2026-07-15 - Codex

- Chrome 重载后再次复核“那个想睡觉的人”：上一版补偿翻译与几何抑制没有改变现场结果。错误的小框仍是 `그자고자하니는`，正确的跨页 OCR `다준이ㅋㅋㅋㅋ작곡 잘하네` 对应两个 seam composite，但两者仍为 `surface.bubbles=[]`；因此此前把主因归结为“批量翻译漏项后没有重试”并不完整。
- 使用现场上下页与 seam OCR JSON 离线重建 reconciliation：正确 seam observation 能独立生成 `ready` canonical，并正确投影到上下两页，说明候选不是在 OCR 或 reconciliation 阶段丢失，而是在后续 `buildSeamRenderSurfaceIndex()` 构建 surface 时被排除。
- 为 seam surface 候选增加结构化排除诊断，覆盖 `already_handled`、`page_mismatch`、`no_linked_observation`、`incomplete_pair`、`missing_translation`、`bubble_build_failed`、`missing_cleaned_image` 与 `accepted`；诊断透传到页面 `data-seam-diagnostics`，重载扩展后可直接从现场 DOM 确认唯一排除原因。
- 修改范围：`src/kakao-pipeline.js` / 根目录 `kakao-pipeline.js`、`src/content.js` / 根目录 `content.js`、`tests/kakao_pipeline.test.mjs`、`tests/content_runtime.test.mjs`。本轮只增加受控诊断与对应回归，不宣称最终显示问题已经修复。
- 验证通过：`kakao_pipeline` 160/160、`content_runtime` 131/131；完整 Node 回归 432/432；`scripts/build-extension.mjs` 构建通过并更新 `dist/`。

## 2026-07-15 - Codex

- Chrome 现场定位“那个想睡觉的人”覆盖框：页面接缝处的大蓝框是正确 seam OCR `다준이ㅋㅋㅋㅋ작곡 잘하네`，对应 `410.75 x 55.44px` 的 final 区域；小蓝框是上一页末尾错误单页 OCR `그자고자하니는`，实际译文 bubble 仅 `186.97 x 12.97px`。正确 seam surface 当时只有 debug 节点且 `surface.bubbles=[]`，因此渲染链路只剩小框。
- 根因 1：canonical 批量翻译响应漏掉个别 id 时，成功项会结算，但漏项直接进入失败回退并被当前 revision 标记为已尝试；正确 seam 候选会长期停留在 debug-only 状态。修复为只对漏项立即执行一次小批次重试，仍缺失时才沿用原失败回退。
- 根因 2：即使大框随后成功翻译，文字差异较大的单页误识别属于另一个 canonical，现有 `handledCanonicalIds` 无法淘汰它。新增 seam 复合坐标到各页百分比坐标的反投影；同类文本区域、位于页边缘、被正确 seam 区域覆盖至少 72%，且面积不大于 seam 页片段 1.35 倍的普通候选会写入 `suppressedCanonicalIds`，普通投影和 provisional fallback 均不再恢复该小框。特效字、UI 文字和内页候选不参与此淘汰。
- 修改范围：`src/kakao-pipeline.js` / 根目录 `kakao-pipeline.js`、`src/content.js` / 根目录 `content.js`、`tests/kakao_pipeline.test.mjs`、`tests/content_runtime.test.mjs`。
- 验证通过：现场几何回归覆盖“大框正确、小框文字完全不同”的场景；`kakao_pipeline` 160/160、`content_runtime` 131/131；完整 Node 回归 432/432；`scripts/build-extension.mjs` 构建通过并更新 `dist/`。

## 2026-07-15 - Codex

- Chrome 现场复现“希望粉丝们能像晚霞一样……”译文：`.mt-bubble` 默认横向 flex，left/right 对齐类的 `align-items` 实际作用在纵轴；右对齐长译文会从蓝框底部向上溢出。测量探针又使用纵向居中，`scrollHeight` 无法可靠覆盖负方向溢出，导致字号拟合没有及时收缩。修复为纵向 flex，并让测量探针从顶部开始排版，长译文按真实高度参与拟合。
- Chrome 现场复现倾斜跨页文字：两个 page-local seam window 均已存在，但旋转位置仍以 polygon 外接矩形中心作为锚点；现场外接矩形中心约为 `(491.5, 133.5)`，真实 polygon 中心约为 `(538, 124)`，视觉上仍像绕左上区域旋转。修复为从 polygon 顶点计算视觉中心，并在普通与 seam 两条渲染路径中显式透传给旋转锚点。
- 倾斜两行倒序根因位于后端 OCR 聚类：行分组使用轴对齐框的短边约 80px 作为行厚，而现场旋转 polygon 投影后的实际行厚约 42px，导致上下两行被误归为一行并按行内轴反向拼接。改为使用 polygon 在局部 line axis 上的投影厚度；真实几何回归覆盖 OCR 下行先返回时仍按视觉 top-to-bottom 输出。
- 修复韩文倾斜文字被误判为日文竖排：旧逻辑只看中文译文中的汉字和全角标点，忽略韩文原文，导致约 `-12.6deg` 的正常横排译文变成一字一列并超出蓝框。现在中小角度旋转时结合原文脚本判断，韩文/拉丁原文保持横排；仅接近竖直的 CJK 文字允许竖排。
- 按本次现场要求恢复 OCR 对比框：`final` debug 模式同时显示 raw 红框与 final 蓝框；正常关闭 debug 时仍不显示诊断层。提升 OCR 坐标模型版本，避免继续复用已写入倒序文本的旧缓存。
- 修改范围：`src/content.js` / 根目录 `content.js`、`src/background.js` / 根目录 `background.js`、`src/styles.css` / 根目录 `styles.css`，以及对应的 `content_runtime`、`background_runtime`、`overlay_style` 回归测试。
- 验证通过：`content_runtime` 131/131、`background_runtime` 75/75、`overlay_style` 6/6；完整 Node 回归 431/431；`scripts/build-extension.mjs` 构建通过。Chrome 安全策略不允许自动进入扩展管理页，需手动重新加载本地扩展后刷新阅读页完成新版现场复核。

## 2026-07-15 - Codex

- Chrome 现场复核：页面中实际存在 81 个译文 bubble、10 个 seam window、219 个 OCR debug box。红/蓝框与黑底 `raw-*` 标签来自 debug overlay；静止采样 DOM 稳定，闪烁主要来自滚动/虚拟化期间 overlay hide/show 与 debug 层重绘。
- 根因 1：`appendOcrDebugNodes()` 只要 `result.debug` 存在就绘制 raw/duplicate/deduped/final 全阶段，未按 `debugOverlayMode` 过滤。修复为后台 debug payload 透传 `debugOverlayMode`，前端仅绘制当前模式 stage；默认 final 不再显示 raw 红框。
- 根因 2：canonical seam surface 只挂到一个 host page root，另一页没有自己的 `.mt-seam-window`，导致跨页倾斜译文被宿主页 `overflow:hidden` 裁掉。修复为 surface 的每个 `pageId` 都生成 page-local seam slice，并用 `renderKey@pageId` 去重，避免上下页互删。
- 根因 3：overlay render signature 包含 debug payload，debug 抖动可能导致稳定译文 root 被整体替换。修复为译文签名忽略 debug，仅 debug-only overlay 使用 debug 签名；相同译文结果只同步位置，不重放 `mt-stream-enter`。
- 保留并验证旋转锚点逻辑：明显旋转的 left/center/right 文本仍使用 center transform anchor，文本对齐继续由 `alignment` 控制；已有倾斜两行阅读顺序回归继续覆盖下行先返回时的 top-to-bottom 拼接。
- 修改范围：`src/content.js` / 根目录 `content.js`，`src/background.js` / 根目录 `background.js`，`tests/content_runtime.test.mjs`，`tests/background_runtime.test.mjs`。
- 验证通过：`node --check content.js background.js`；完整 Node 回归 `kakao_reconciler + kakao_pipeline + content_runtime + background_runtime + glossary_core + term_discovery_core + overlay_style` 428/428；`scripts/build-extension.mjs` 构建通过并更新 `dist/`。

## 2026-07-15 - Codex

- 定位评论区二次问题：带时间的小字此前被 `nonTranslate` 路径过滤；部分正文 cluster 与时间元数据分离后失去 chat 语义，单框正文又回退到居中；昵称+时间同框会在通用大小字拆分后重新合成 metadata；左/右对齐的倾斜 overlay 使用 top-left/top-right 旋转锚点，视觉位置会被旋转带偏。
- 修复 `src/background.js` 及根目录同步文件：新增 chat role 拆分与透传，支持 `chat_nickname`、`chat_time`、`chat_aux`、`chat_body`；昵称+时间同 OCR 框按时间正则估算拆框；紧邻 chat metadata 的大字号正文继承 chat 语义；chat 候选不再因时间进入 `nonTranslate` 过滤，也不再在最终 coalesce 阶段互相合并；普通气泡仍保持原有居中/几何推断。
- 修复 `src/content.js`、`src/styles.css`、`src/kakao-pipeline.js`、`src/kakao-reconciler.js` 及根目录同步文件：新增 `font_weight` / `translation_role` 透传和渲染；明显旋转的 overlay 改用中心 transform anchor，文本对齐仍由 `alignment` 控制；长译文扩展逻辑继续保留并覆盖 solid 背景。
- 新增/更新回归：chat 昵称/时间/正文三类都进入翻译、同框昵称时间拆分、单框 chat 左对齐且普通气泡居中、倾斜锚点不漂移、字重变量与长译文不裁剪。
- 验证通过：`background_runtime` 73/73；`overlay_style + content_runtime` 134/134；`kakao_reconciler + kakao_pipeline` 208/208；完整本地集合 415/415；`scripts/build-extension.mjs` 构建通过。

## 2026-07-15 - Codex

- UTF-8 诊断：PowerShell 直接嵌入非 ASCII 文本时曾把短韩文字样显示成 `??`，改用 `$OutputEncoding` / `[Console]::OutputEncoding` 的 UTF-8 设置，并用 JS Unicode escape 复核后确认这是命令输入显示问题，不是 OCR 主链路修复失败；历史测试里的短文本实际为 `음.`，已按“合法单字/短词保留”的需求调整断言。
- 根因 1：本地 OCR 归一化和最终 candidate 过滤阶段仍存在短文本/低置信小框过滤，合法单个韩文音节可能在翻译批处理和 overlay 生成前被丢弃。新增统一有效文本判断和结构化 drop debug，保留含韩/中/日/英文/数字的单字符文本，仅过滤空白、纯符号、明确噪声或乱码短片段。
- 根因 2：评论区 OCR 合并时字号差异约束过宽，渲染端又默认用居中锚点和 `text-align:center`，导致左对齐评论和小号用户名/时间被抹平成同一种样式。修复合并的字号/行高拆组阈值，新增基于子框 left/right/center 的 alignment 推断，并让 overlay 按 left/center/right 使用不同锚点。
- 根因 3：倾斜多行文字拼接仍依赖 raw y/x 排序，旋转后可能把下行排到上行前；长译文 fitting 到最小字号后仍受固定最大高度和 hidden overflow 裁剪。改为投影到局部阅读坐标系排序，且长译文在最小字号后扩展 overlay 与背景遮罩，不再省略或裁掉末尾文字。
- 修改范围：`src/background.js` / 根目录 `background.js` 的 OCR 过滤、样式拆组、对齐推断、倾斜阅读顺序；`src/content.js` / 根目录 `content.js` 的 overlay 对齐锚点和溢出扩展；`src/styles.css` / 根目录 `styles.css` 的对齐类和 overflow；`src/kakao-pipeline.js`、`src/kakao-reconciler.js` 及根目录同步文件的 alignment 透传；新增/更新 `tests/background_runtime.test.mjs`、`tests/overlay_style.test.mjs`。
- 验证通过：语法检查通过；`tests/background_runtime.test.mjs` 71/71；`tests/overlay_style.test.mjs` 6/6；完整本地 Node 回归 `kakao_reconciler + kakao_pipeline + content_runtime + background_runtime + glossary_core + term_discovery_core + overlay_style` 423/423；`scripts/build-extension.mjs` 构建通过。

## 2026-07-15 - Codex

- 定位悬浮球回归：content 脚本只在 `state.autoTranslatePageEnabled` 已经开启时才走本页自动翻译开关，忽略了持久化的 `mt_pretranslate_mode=ahead/continuous`，因此“预先翻译 6 张”配置下点击“译”仍直接进入 `manualTranslateVisible()`。
- 修复 `src/content.js`：悬浮球点击先校验扩展启用状态；已开启本页自动翻译时只负责停止；未开启但当前模式是 ahead/continuous 时调用 `togglePageAutoTranslate(true)`；仅 manual 模式才执行当前视口手动翻译。
- 定位“翻译当前视口”偶发无动作：popup 的 all-frames 直调只要任一 frame 返回就停止兜底；当主页面 frame 被跳过而 iframe 返回空结果时，不再发送 `MANUAL_TRANSLATE_VISIBLE` 到主 frame，用户看到像是没有反应。
- 修复 `src/popup.js`：合并 all-frames 结果时记录 `skippedCount`，只有有可见目标/成功/失败/队列活动，或没有 skipped frame 的确定空结果，才视为可用；否则继续走 `tabs.sendMessage` 主页面兜底。相同判定也用于本页自动翻译开关，避免悬浮球启用预翻译时被空 iframe 吞掉。
- 同步根目录扩展文件并更新 `dist/`；新增/调整 `tests/content_runtime.test.mjs`、`tests/kakao_pipeline.test.mjs` 回归断言。
- 验证通过：`src/popup.js`、`src/content.js`、根目录 `popup.js`、`content.js` 语法检查；定向 `kakao_pipeline + content_runtime` 283/283 通过；完整 Node 回归 416/416 通过；`scripts/build-extension.mjs` 通过。

## 2026-07-15 - Codex

- 定位“点击译/翻译当前视口无反应”：popup 主按钮和悬浮球“译”都直接调用 `togglePageAutoTranslate`，手动入口被接成页面自动翻译开关，和 UI 文案“翻译当前视口”及悬浮球提示不一致。
- 修复 popup 主按钮按模式分流：手动模式调用 `runManualTranslateAllFrames` 只翻译当前视口；领先/连续预翻译模式仍启停本页自动翻译；执行开始即显示状态提示。
- 修复悬浮球：显示“译”时调用 `manualTranslateVisible`，只在已开启自动翻译且显示“停”时负责停止自动翻译。
- 新增回归测试覆盖 popup 主按钮手动路径和悬浮球点击路径，防止再次误接到自动翻译开关。
- 验证通过：`src/popup.js`、`src/content.js` 语法检查；定向 `content_runtime + kakao_pipeline` 283/283 通过；`scripts/build-extension.mjs` 通过；完整 Node 回归 416/416 通过。

## 2026-07-14 - Codex

- 定位 seam-pair 的重复渲染根因：后台把拼接图中每个 OCR 框都转换为 observation；即使该框仅属于上页或下页，也会进入归并、翻译和渲染链路。
- 将拼接带限制为每侧 64–96px；同步内容脚本、拼接调度和 reconciliation 的带宽计算，避免完整气泡、帖子和阅读器 UI 进入 seam OCR。
- 在后台 OCR 结果标准化阶段增加跨缝硬过滤，发生在翻译之前：仅接受真正跨越两页边界的单一框，或横向重叠、字号/角度相近且紧贴边界的上下碎片对；其他框以 `seam_not_cross_boundary` 记录为已过滤证据。
- 新增回归覆盖完整页面文字拒绝、合法跨缝碎片拼接、64–96px 拼接带和内容侧捕获范围；`background_runtime` 64 项、`kakao_reconciler` 49 项、相关 pipeline 8 项及内容脚本定向回归均通过。
- 已执行根目录同步、四个扩展脚本语法检查和 `scripts/build-extension.mjs`；扩展产物更新至 `dist/`。
- 内容脚本全量回归为 117/121 通过；4 项既有失败均依赖未暴露的旧测试 API 或过时的消息分支正则（`waitForPaint`、`isKakaoReaderContentTarget`、`takeNextKakaoTranslationQueueItem`），与本次 seam 输入过滤无关。

## 2026-07-14 - Codex

- Chrome 复现：开启本页自动翻译且不点击任何译文气泡后，拼接页先生成一个 `mt-seam-window`，随后其内部的 `mt-seam-composite` 又被候选扫描识别为带背景图的普通目标，产生第二套普通覆盖层，造成接缝文本重叠且 OCR 文案略有差异。
- 修复：在统一的 `isSupportedTarget` 入口排除带有或位于 `data-manga-translator-overlay` 内的扩展节点。拼接画布、普通覆盖层、调试节点和后续任何扩展自有背景图均不会重新进入 OCR 队列；单张页面的正常图片逻辑不变。
- 新增回归：`extension-owned seam composites never reenter Kakao OCR target selection`；同时保留 canonical seam 单宿主渲染回归。
- 验证通过：`node --check src/content.js`、`node --check content.js`；3 项内容运行时定向测试通过；`scripts/build-extension.mjs` 通过并更新 `dist/`。
- 全量 `node --test` 仍有既有失败：内容运行时测试引用未暴露的旧辅助 API，以及 5 个 Kakao pipeline 的 250ms 超时用例；与本次目标过滤修改无关。Chrome 自动化无法进入 `edge://extensions` 重载本地扩展，需在扩展管理页手动点击“重新加载”后再刷新阅读页验证。

## 2026-07-14 - Codex

- 定位 Kakao 拼接处重复渲染：旧的独立跨页 overlay 与 canonical seam surface 同时输出。
- 将拼接结果统一保留在 canonical `renderOverlay` 渲染链路；禁用旧的独立跨页渲染入口。
- 验证：`src/content.js`、`src/kakao-pipeline.js` 语法检查通过；新增拼接渲染回归用例通过。
- 定向回归全部通过；全量历史测试仍有既有的运行时辅助 API 缺失与 250ms 超时问题，与本次修改无关。

## 2026-07-14 — Codex

- 检查 `C:\Users\yuanying\.codex\logs_2.sqlite`：数据库处于 WAL 模式；`logs` 表约 13.9 万条记录，其中 TRACE 约 9.6 万条，3 秒采样期间 `MAX(id)` 增长且 TRACE 持续写入，确认存在高频 TRACE 写盘。
- 在 `logs` 表创建 `logs_ignore_trace_insert` trigger：对 `NEW.level = 'TRACE'` 的 INSERT 使用 `RAISE(IGNORE)` 拦截。
- 验证：trigger 生效后 5 秒内 TRACE 最大 ID 保持 `65866549`，TRACE 条数未增长；`MAX(id)` 仅由非 TRACE 日志增加 2；WAL 文件保持约 9.55 MB。

## 2026-07-14 — Codex

- 修复跨页复合覆盖层被宿主页裁剪的问题：`mt-seam-window` 改为允许可见溢出；canonical 渲染会清理旧版无状态的 `mt-seam-cross-page` 根节点，隐藏覆盖层时不再露出旧副本。
- 本地 OCR 按视觉字号、时间格式和聊天形态拆分候选；用户名/时间保留为过滤证据但不进入翻译请求；高置信度 speech bubble 使用气泡内部区域进行文字拟合和纯色擦除。
- 保留 OCR polygon 与真实旋转角，移除将合法倾斜角强制归零的经验阈值；补充图片运行时消息超时与队列回归辅助逻辑。
- 新增聊天元数据、气泡内部区域、倾斜角度及跨页渲染回归测试。完整本地测试通过：414/414。

## 2026-07-14 - Codex

- 为图片运行时消息增加超时与可视区域截图降级；管线错误会恢复 loading 覆盖层。
- 翻译队列通过微任务统一排空；旧代际任务不会清理当前代际的 loading 状态。
- 跨页窗口仅裁剪页面本地片段，复合画布仍可跨页显示；扩展构建和全量本地测试均通过：414/414。

## 2026-07-15 - Codex

- 完成迁移前 OCR appearance/layout 修复基线：补强颜色采样、完整区域遮盖、候选竞争过滤、方向与真实字厚计算，以及页内/跨页文本层仲裁。
- 修正清理图并发回归测试对调用先后顺序的无效依赖；不同 canonical mask 的请求仍保持独立。
- `local-ocr-service/glossary.db` 仅保留为旧工作区本地改动，未纳入基线提交。
- 本地验证通过：Node 452/452，Python 43 passed、1 skipped，扩展构建成功。
