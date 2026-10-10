# CLAUDE.md — Manga Realtime Translator

> 本文件与 `AGENTS.md` 内容一致（`AGENTS.md` 是本机副本、按 `.gitignore` 不入库）。
> **改动请同时更新两份** —— 这两份曾经各写一份清单并互相矛盾（content 模块一处写 32、一处写 31）。
>
> 模块清单**不再逐文件枚举**：那种写法必然漂移（曾经写着 content 32 个文件、实际 84 个，
> 还列过 `platform-settings.js`、`novel-memory-editor.js`、`canonical/pipeline-factory/`
> 三个并不存在的东西）。这里只写数量、命名约定与入口；完整清单以目录为准：
> `ls extension/src/content/modules/`。

## Build & Verify

```bash
npm run build          # esbuild: extension/src → dist/extension
npm run dev            # watch mode
npm run verify         # line gate + lint (JS+Python) + build + tests
npm run check:lines    # production 400, entrypoints 120, tests 800
npm run lint:js        # ESLint (extension/src)
npm run lint:python    # Pylint (local-ocr-service)
npm run test:node      # Node test suite —— 用例数看这条命令的输出，别抄进文档
npm run test:python    # Python test suite —— 同上
```

- 行数门禁口径：生产文件 400 行、入口文件（`*/index.js` 与 `server.py`/`ocr_service/api.py`）120 行、测试 800 行。
- **可视化调试页面**（阶段检视台 / OCR 对比工作台 / 背景判定工作台）统一从本地调试服务器打开：
  `tools/stage-inspector/run_stage_inspector.bat`（或 `node tools/stage-inspector/serve.mjs`）→ <http://127.0.0.1:8099/>。
  **不要用 `file://` 直接打开**：本地 OCR 服务的 CORS 只允许扩展来源（`EXTENSION_ORIGIN_PATTERN`），
  `file://`（`Origin: null`）与任意 localhost 页面直接 fetch 服务都会被浏览器拦掉；`serve.mjs` 用同源反代解决，
  服务端白名单**不放宽**。工具索引：`tools/README.md`。
- 测试规模口径（文件数，2026-09 审计时点）：`tests/*.test.mjs` **165** 个文件、`tests/test_*.py` **17** 个文件。
  单个用例数由 runner 打印（当时 Node 1581 / Python 157+1 skipped）——**不要写死在文档里**，写死了必然过时。

## Architecture

```
Reader Profile → Detect → Crop OCR → Observation → Canonical → Translation → Crop-local Layout → RenderScene → Renderer
```

- **extension/src/**：按域组织的 ESM 源码，共 17 个域目录 —— `background`(+`providers`)、`canonical`、`config`、`content`、`geometry`、`glossary`、`layout`、`novel-mobile`（手机小说版，独立构建）、`popup`、`quick-popup`、`readers`、`recognition`、`rendering`、`settings`、`shared`、`sidepanel`、`translations`
- **extension/public/**：静态资源（manifest.json、popup.html、glossary.html、settings.html、styles.css）
- **dist/extension/**：桌面版构建输出（Chrome 加载它）；**dist/novel-mobile/** 是手机小说版的独立产物
- **local-ocr-service/**：Python PaddleOCR 服务（`ocr_service/` 包 + `server.py`），另含 `glossary_store/`（SQLite 术语库）与 `translation_store/`（SQLite 译文库）
- **Module pattern**：域内小模块（如 background `messages.js`、content `reader-init.js`、canonical `stitch-geometry.js`）通过 `install*()` 把函数装到共享 `runtime` 对象上；子目录只保留 `canonical/reconciler-modules/`、`canonical/canonical-pipeline-factory/`、`canonical/page-store-factory/`（**没有** `pipeline-factory/`）
- **Provider registry**：`background/providers/registry.js` —— OCR 与翻译 provider 注册时做契约校验

## Key Contracts

- `recognition/contracts.js`：不可变的 `DetectedTextRegion`（几何）与 `RecognizedTextRegion`（只加文本、不改几何）。
  注意它当前**只被 `tests/architecture_contracts.test.mjs` 引用**：生产路径的几何是
  `rendering/scene-builder.js` 现拼的对象。别以为线上几何也走这份冻结。
- `layout/placement.js`：`buildPlacementGeometry()` —— 用轴/法向分解做斜排 placement
- `layout/crop-local-layout.js`：`layoutInPlacement()` —— 在 crop 局部坐标里做文字适配
- `rendering/render-scene.js`：`RenderScene` = `page`/`composite` 两种 surface + `cover`/`text`/`debug`/`loading` 四种层。
  校验只保证 text 层**有** layout（`geometry`/`appearance`/`content`/`diagnostic` 会被冻结，`layout` 不会）
- `geometry/transforms.js`：单应矩阵往返校验（与 `recognition/contracts.js` 一样，目前只有测试在用）
- `config/schema.js`：**五个**独立配置键 —— `mt_ocr_config_v1`、`mt_translation_config_v1`、
  `mt_runtime_config_v1`、`mt_term_extraction_config_v1`、`mt_sentence_extraction_config_v1`
- 三个 LLM 服务（翻译 / 整章术语提取 / 句子级提取）共用一个命名配置库
  （`mt_translation_vendors_v1`，设置页 → 翻译服务）。提取小节存 `{ vendor, followTranslation }`：
  `vendor` 指向库里的一条；**`followTranslation` 不是"旧存档兼容字段"而是活开关** ——
  用户在设置页显式选库或自己填服务商时会被写成 `false`，`resolveExtractionConfig()`
  （`config/store.js`）据此决定"继续跟随翻译服务"还是"用本节自己的字段"。
  两个服务开关是 `runtime.termDiscoveryEnabled` / `runtime.sentenceExtractionEnabled`。
- `shared/glossary.js`：术语库 schema v4 —— `{ libraries: [{ id, name, enabled, urls, applyUrls }], entries: [{ libraryId, scope, scopeKey, … }] }`
  - 库开关（`library.enabled`）把整库条目挡在提示词与指纹之外；**除此之外还有第二道门 `applyUrls`**：
    库的"应用网址"非空时，只有当前页面命中才生效（`libraryApplyUrlMatches`，空数组 = 全站生效）
  - `urls` 只负责**新术语归属**：最具体的绑定胜（比字面长度，`*` 不计），且只考虑已启用的库
  - 条目级 `enabled` 独立生效，不被库开关覆盖；指纹前缀是 `g4-`
  - **语言码是跨端契约**：本地服务会把 `ja`/`ko`/`en` 升格成 `ja-JP`/`ko-KR`/`en-US` 落库并原样回传，
    扩展侧用它比对词条前必须折回短码（`languages.canonicalTargetLanguage`），否则这些目标语言下整库词条被静默滤掉
- **思考模式开关**：`shared/thinking-mode.js` 是唯一定义处（`auto`/`off`/`on` + 按服务商选参数名）。
  DeepSeek（`deepseek-flash`/`v4-pro`）、GLM 4.5+、Qwen3.5+ 的思考模式**默认就是开的**，思维链计在
  `completion_tokens` 里 —— 小说翻译账单上「输出 > 输入」几乎全是它。默认 `auto` 不发送任何参数
  （与升级前行为逐字一致，不改变任何已有用户的请求）。认不准的服务商（中转站）两种参数名都发；
  被拒时**只剥掉被拒的那一组**重发（`translation-utils.js#sendTranslationBodyWithFallbacks`），
  并按端点记住，避免每个请求都先撞一次 400。
  - 它存在**配置档案条目**里（`normalizeVendorEntry`，向导第二步「填写信息」那张卡片），不是翻译小节：
    一个后端认不认思考参数本来就是「这一套配置」的属性，换服务商就得跟着换。
  - 三个共用配置库的服务**一起生效**：翻译走 `applyVendorEntry`，整章提取与句子级提取走
    `overlayVendorEntry`（提取小节自己也有一份 `thinkingMode` 默认值；「跟随翻译服务」时
    `resolveExtractionConfig` 把翻译的那份带过去）。术语提取同样是机械任务，思考一样白花钱。
  - 本地服务的两条慢链路（`translation_stream.py` 翻译、`term_extractor.py` 整章提取）都**不自己判断
    参数名**，只把扩展侧算好的字段原样拼进上游请求体；被拒时剥掉重发一次（不重试的话整条链路会在
    每个批次上先失败一次）。
  - 它**不进任何缓存键**（小说块缓存键与 canonical 指纹里都没有），所以来回切开关不会让已翻好的内容重新计费。
- **SQLite 术语库 schema v6**（`glossary_store/common.py`；v5 是**译文库** `translation_store/schema.py`）：
  `glossary_libraries`（含 `apply_urls`）+ `library_id` on `glossary_entries`/`pending_candidates`；
  身份索引 `(source_key, src_lng, tgt_lng, scope_type, scope_key, library_id)`
- **Seam triple OCR**：切片接缝处会 OCR 上片、下片与合成图三份；reconciler 只保留一个投影为 `primary`、
  其余标 `standby`，`content/configure.js` 在渲染前过滤 `standby`/`text_standby`，所以页面里出现隐藏或零几何的
  `mt-overlay-root` 是预期的（那是离屏切片覆盖层，滚回去会重现），不是几何丢失。用
  `__mtOverlayGeometryReport()`（页面控制台）诊断。
- **整页容器目标（`pageComposite`，CMOA）**：站点提示里 `pageComposite: true` 表示「目标选择器指的是**整页容器**，
  容器内的 `img` 只是瓦片」。CMOA speedreader 把一页切成 3 条横向瓦片（`.pt-img` 下 3 个同宽 `img`），
  瓦片边界与页边界无关：按裸 `img` 选目标会让同一页的 3 条瓦片各成一个「页面」各跑一次 OCR，跨瓦片的竖排
  台词被拦腰截断，一页还挂 3 个覆盖层。装配点只有一处（`content/modules/composite-page.js`）：
  `isCompositePageTarget` / `compositePageTargetOf` / `compositePageBands` / `compositePageSourceToken` /
  `extractCompositePagePayload` / `isTargetMediaReady`。约束：
  - `isSitePreferredTarget` 必须**先**把容器内部的瓦片 img 挡掉（放在 `allowLoose` 回退**之前**，否则 relaxed 时
    下面那条 `[class*='page']` 又把瓦片放回来）——一页只能有一个目标身份，否则同一页会被翻两遍。
  - `getQuickSourceToken` / `computeTargetKey` / `extractTargetPayload` / `isSupportedTarget` / `isTargetReady`
    都以 `isCompositePageTarget` 分叉；`shouldUseEmbeddedRender` 对整页目标**强制 false**（一页是多条 img，
    没有**单个**可替换的元素），所以这个能力只在 DOM 覆盖层下成立。
  - 采集分辨率取瓦片自身的 natural/CSS 比、再受 `IMAGE_MAX_SIDE` 收口；百分比坐标与分辨率无关，
    缩放只决定 OCR 认不认得出小字，**不要**降成视口分辨率。
  - 目标身份 = 瓦片集合（数量 + 每片 URL）：阅读器回收 DOM 换页后 URL 变、身份变，旧页缓存按既有
    sourceToken 变更路径作废。**不掺版面尺寸**（尺寸变化不该让译文重跑）。
  - 与 `tiledStrip` 的区别是结构事实：分片长条的一整章是一条连续长图，边界只能靠接缝 OCR 拼回来；
    瓦片边界在页**内部**，拼回整页之后不存在需要靠接缝去猜的边界。两者**不要**混用。
- **日文竖排读序（自右向左）与竖排盒子轴**：竖排（`polygon_rotation_deg` 折到 ±90）的「行」是竖着的一列，
  列内自上而下、列序自右向左 —— 与横排是**两套轴**。两处必须按这个口径：
  - `background/modules/ocr-display-geometry.js#composeRotatedClusterWords`：`|rotation| ≥ 45°` 时按
    「列序 centerX 降序、列内 centerY 升序」拼，横排（含斜排 SFX）走原路径。判据只能用**盒子形状/中心**，
    **不能**用 rotation 的符号：服务端 `polygon_rotation_deg` 与本侧的 `normalizeRotationDegrees` 都把
    +90° 折成 -90°（要与 CSS 的 rotate 对齐），折叠之后「自上而下」与「自下而上」已经分不出来。
    症状：整句台词被拼成反序（「なてるんだけど 受けることに ボクも<加護の儀を」）。
  - `rendering/cover-geometry.js#resolveBubbleScreenBox`：竖排拿到的宽高是沿**文字轴**量的
    （宽 = 字列长度、高 = 字列厚度），横竖与屏幕**正好互换**；不换回来 `writing-mode: vertical-rl`
    只能排出 2~3 字一列的碎列并溢出到相邻分格，而且**不能再叠 ±90° 旋转**（那会把文字转回横排）。
    `content/modules/lifecycle-position.js` 是唯一消费处。
  - `rendering/cover-geometry.js#resolveCoverQuad`：`|rotation| ≥ RENDER_ROTATION_VERTICAL_MIN_DEG`
    （60°）时**不按倾角旋转文字框**，只用文字四边形 —— ±90° 是竖排方向而不是「歪了」。服务端
    `polygon_rotation_deg` 对高而窄的框一律给 ±90°，照它 `rotateBoxQuad` 会把 96×225 的竖列转成
    225×96 的横条：清理图于是擦掉横跨页面的一条、竖排原文只被擦掉一小截（症状「清理图只覆盖了
    一部分、日文还露着」）。**没有 polygon 时** box 是文字轴几何，那条旋转分支必须保留。
    四条路径（DOM 遮罩 / 清理遮罩 / 嵌入式画布 / 场景文字层）共用这一个函数，改一处全好。
- **实底（`bg_type=solid`）判定与「白气泡别用清理图」**：清理图是 inpaint 出来的，白底上必然留下
  擦不干净的痕迹，所以**纯净平底气泡要判成实底**。两端各一半：
  - 服务端 `pipeline/appearance_regions.py#detect_solid_region_for_box` 的采样留边单位必须是**字形尺寸**：
    `solid_sampling_reference` 取每个文字框**短边**的中位数（横排 = 行高、竖排 = 字宽）。以前直接用
    item box 的高 —— 竖排一「行」是一整列（实测 192px），near 采样区上下各外扩 0.35×192≈67px 越出气泡
    采到插画，被「内部跨界离群」结构门拒掉，真实一页 19 行只有 1 行判成实底。
  - 扩展侧 `rendering/bubble-colors.js#sampleBubbleAppearance` 额外返回 `bgCoverage`（外圈有多少像素
    贴着中位色），`applySampledBubbleColors` 在「服务没判出实底容器 + 一致率 ≥ 0.92 + 亮度 ≥ 0.72」
    时把 `adaptiveBackground` 升级成 `solid`（亮度门槛与服务端 `classify_solid_region_type` 的
    `bright_background` 同口径）。**环不够均匀就什么都不做** —— 平涂一块网点/渐变会把插画糊成色块，
    这条底线不能破（与「兜底纯白 → 凭空一条白条」是同一条教训）。
  - 外观判定进 OCR 结果，改它要**换代次**：`OCR_GEOMETRY_VERSION` / `OCR_GEOMETRY_CONTRACT_VERSION`
    两侧逐字同步（v7 起，现为 v8），否则浏览器仍读回旧的 `bg_type=none`。
- **ルビ（振り仮名）过滤 + 识别阶段的硬下限（v8）**：日漫在汉字旁边用小一号假名注音（縦書き在汉字列
  右侧、横書き在汉字上方），PaddleOCR 会把那一列小字当成**独立文本行**检测出来。两件事必须成对：
  - `background/modules/ocr-ruby.js#filterRubyAnnotationWords` 在**聚类之前**把ルビ整条丢掉 ——
    不并进正文（并进去就会把「あしたもと」+「明日地元」拼成一行，译成「明日元,明天是本地。」），
    也不各自成气泡（用户现场提问「日漫旁边这些是什么、为什么这么多」）。四条判据同时成立才认，
    **误删真台词比留着ルビ严重得多**：①文本全假名；②比**整页同向条目的中位粗细**细（≤0.8 ——
    只比「邻居」细会误伤，邻居可能是聚类后的多列块，宽度是单列的 2 倍）；③紧挨着一个更粗、且
    **含汉字**的邻居（间距 ≤ 自身粗细×1.6；竖排比 left/host.right、横排比 host.top/bottom）；
    ④沿文字轴与邻居重合 ≥60%。实测 6 页 212 条原始识别命中 21 条，逐条核对全是ルビ/ルビ碎片。
    只接在 `local_paddle` 词条上（`ocr-provider.js#buildLocalPaddleBubbleItems`）：Baidu 是词级框、
    没有真机数据可校准，不动它。
  - 识别阶段的 `text_rec_score_thresh` 送的是**硬下限** `shared/shared-constants.js#
    OCR_RECOGNITION_SCORE_FLOOR`（0.4），**不是**用户的结果筛选阈值：服务端
    `crop_recognition._run_slice_ocr_pipeline` 拿这个字段硬切 `items`，而竖排带ルビ的台词拿到的是
    **整行平均分**（同页不带ルビ的行 0.92~0.99，实测「鉄パイプか」0.705、「帰ないと」0.711，正文都
    清清楚楚），用默认 0.72 硬切就是用户说的「明明看起来还挺清晰，却没被翻译」。放行只发生在结果
    筛选那条低分例外里（`ocr-candidates.js#getOcrWordDropReason`），且要求「目标语言文字
    （数字/拉丁/带 ?、� 不算）+ 面积占比 ≥0.0012」——实测 6 页放行 16 条（4 条是正文，其余是同一
    行的碎片）。**不按字数卡**：韩文单音节台词（「그」）与日文一字台词（「え」「ま」）都是真台词，
    `background_runtime.part07` 钉过这条。
  - 这条改动换了服务端返回的 `items` 内容，而缓存键里只看得见用户阈值，所以**必须换代次**。
- **OCR 调试叠层**（`localPaddle.debug` → 服务返回 debug 载荷时才渲染）：`content/modules/
  ocr-debug-overlay.js` 画 raw/filtered/merged/final 各阶段的方框与 `raw-N [OCR 87.8%] | …` 标签，
  并且**必须**带一条自我说明横幅（`.mt-debug-badge`）—— 那些标签长得就像一行小字台词，用户看到
  满屏小字会问「这些是什么、为什么这么多」，而它们只是识别中间结果。它是诊断用的中间态：
  `renderer-overlay.js` 在 `debugOnly` 且已有气泡时不重建覆盖层。
- **Novel mode adapters**：小说模式与站点无关（`content/modules/novel-reader.js` = 表面发现/签名/重扫/回填）；
  站点差异只在两个适配器里 —— `novel-kakao-reader.js`（shadow DOM、页面自带的 `data-p-id`）与
  `novel-ridi-reader.js`（普通 DOM、我们盖章的 `data-mt-novel-pid`）。锚点是**两个**属性名、按设计如此：
  消费方取锚点值一律走 `runtime.novelAnchorValueOf(node, surface)`（不知道 surface 时它会两个属性都试），
  取属性名走 `runtime.novelAnchorAttribute(surface)`，**不要硬编码**。
  站点名单只存在于 `shared/novel-hosts.js`，且必须在装配期就能回答 —— `novel-focus-click` 在装配期
  挂 document 监听（那时 `reader-state` 还没写 `IS_*_READER`；当初读 runtime 标志正是"点原文修订"从未挂上的原因）。
- **Translation cache generations**：`CANONICAL_TRANSLATION_CACHE_PREFIX`（`mt_cache_v29:translation:`）是漫画
  canonical 的读取路径，命中后 `CACHE_TTL_MS`（7 天）内不再请求模型。因此投毒类 bug 需要**换代次 + 把旧前缀
  加进 `RETIRED_TRANSLATION_CACHE_PREFIXES`**；`__mtCacheAudit()` 只报告**名单里**的退役前缀与短值样本
  （没进名单的旧代次既读不到、也不会被清理，体检也看不见）。官方译文库先于该缓存读取，换代次只会重新请求库里没有的源文。
- **只 OCR 不翻译（`runtime.translationMode`：`provider` / `ocrOnly`）**：漫画链路的第二条出路 ——
  不调用翻译模型，覆盖层直接渲染识别到的原文，由**浏览器自带的页面翻译**就地接手（省掉模型调用，
  代价是没有术语库、没有译文缓存与修订）。生效值 = 本页临时选择 ?? 全局默认：
  `state.translationModeOverride`（悬浮菜单「仅识别不翻译（本页）」，不落盘）优先于设置页的
  `runtime.translationMode`；判据只有 `runtime.getEffectiveTranslationMode()` /
  `runtime.isOcrOnlyTranslation()`，不要直接读 `state.translationMode`。约束：
  - 后台 `handleTranslateTextBlocks` 靠**消息上**的 `translationMode` 把整批折成直通行
    （`translated_text = 原文`、指纹 `passthrough_*`，不请求模型、不写官方译文库、不写译文缓存）。
    **直通值不能为空**：`canonical-render.js` 与 `scene-canonical.js` 都按 `activeText && translated_text`
    过滤投影，空译文会让气泡**整个消失**，而不是回落到原文。
  - 该模式强制 DOM overlay（`scene-dispatch.js#isEmbeddedRenderMode` 直接返回 false）：
    embedded/canvas 把文字画进像素，浏览器翻译看不见它，这个模式就白开了。
  - 这个模式下**不能**给覆盖层加 `translate="no"`/`notranslate`（与"给自绘 UI 挡掉浏览器翻译"的常规
    做法正好相反），所以那个属性只能由模式决定，不能无条件写死。
  - 切换模式必须走 `runtime.invalidateComicTranslations()`：canonical store 里已 settle 的译文
    （很可能正是直通值）不清掉的话，`claimTranslations` 会因为 `attemptedTranslationKeys` 命中而跳过，
    **切回 provider 就永远复用直通值、再也不复译**。`store.dropTranslations()` 只清译文相关容器
    （译文、错误、pending/attempted 键、edge 等待态、烘进译文的 projection），观测与 canonical 保留，
    所以切换不需要重新 OCR；但必须同时清掉 `mtLastTranslatedKey` 标记，否则可见目标不会重新入队。
  - 术语发现要跟着停（`renderer-overlay.js#buildTermDiscoveryMessage` 直接返回 null）：它的输入是
    原文+译文，直通模式下退化成"原文对原文"，只会白烧钱产垃圾候选。
  - 范围只到漫画：`recognition-seam` / `recognition-stitch` 会带这个字段，网页与小说链路不带，
    所以全局开关对小说与网页无效果 —— 这是有意的范围限制，不是漏接。
- **Truncation guard**：两条判据，镜像在 `extension/src/shared/translation-shrink.js` 与
  `local-ocr-service/translation_store/shrink_guard.py` ——
  (a) 自动候选明显短于当前启用版本（< 60%）时保留旧文本；
  (b) **与有没有旧版本无关**：「原文 ≥ 12 字、候选 ≤ `min(6, max(2, floor(源文 × 0.15)))` 字」判为截尾。
  两端作用相同、落地方式不同：客户端 (b) 命中时**不写缓存但当次仍渲染新值**（首次译文没有更好的值可用），
  服务端 (b) 命中时**不设为启用版本**（候选仍进历史）。手动/置顶候选与人工版本不受 (b) 影响。
- **日文识别模型（跨端契约 + 缓存代次）**：`get_recognition_model_name('japan')` 必须是 PP-OCRv5
  （现为 `PP-OCRv5_server_rec`），**不能**回到 `japan_PP-OCRv3_mobile_rec` —— 实测后者在竖排漫画台词上
  无论原始/摆正/加白边/反色/2x 都只有 0.21~0.34 分并吐「桜すでくを」，同一块图 v5 是 0.95~0.99；
  横排也更准（0.981→1.000）。v5 保留日文字形（戦/図/訳/弁/悪/圧/郷 逐字正确，不会写成简体），
  源文与缓存身份不受影响；它与 `ch` 共用同一个模型文件。漫画台词绝大多数是竖排，所以这条影响**所有**
  日文站点而不只是某一个站 —— 症状是「只有单字/横排标题被翻译」，因为 `confidenceThreshold`（0.72）
  只放过那些高分单字。
  - **换识别模型必须同时给 `OCR_GEOMETRY_VERSION` 换代次**：扩展侧 `extension/src/config/versions.js`
    与服务端 `dependencies.py#OCR_GEOMETRY_CONTRACT_VERSION`，**两侧必须逐字相同**。它进 OCR 缓存键
    （`ocr-dispatch.js#buildOcrCacheKey`），不换的话重启服务后仍会命中旧缓存、看起来像"改了没用"；
    服务端 `api_handlers.py:227` 还会校验这个字段，只改一侧会让每个请求直接报"本地 OCR 服务版本过旧"。
    `tests/test_ocr_debug_part01.py` 与 `tests/background_runtime.part06.test.mjs` 固定了它的字面值。
  - 该模型映射在 `tools/ocr_debug_common.py` 还有**第二份**（调试工具用），改一处必须改两处。
- **浏览器里缓存的键族**：`mt_cache_v<N>:` 一个前缀族同时装着 OCR 缓存（`v28:ocr:`）、小说缓存（`v23:novel*`）
  与译文缓存（`v29:translation:`）。配额兜底清理**有意**把整个族都清掉（`isManagedCacheKey`），
  名字不叫 translation cache 就是这个原因。
- **实底（bg_type=solid）遮罩**：**量到颜色就必须遮住原文**，只有没采到采样色时才透明
  （`.mt-fill-unbounded` 关掉 `::before`；跨页遮罩段 `background: transparent`）。
  理由是三次真机教训：兜底纯白 → 原图上凭空一条白条；「缺轮廓就透明」→ 遮罩整块消失、原文裸露；
  「实底必须按四边形裁」→ 四边形只覆盖同一气泡的一部分时（接缝只读到一行、页级 OCR 读到两行）把另一半裁掉。
  覆盖范围：页级 = 覆盖节点盒（最终蓝框/文字外接框，轮廓可用时按 `resolveSolidFillOutline` 裁）；
  **跨页 = `page_cover_boxes` 里这一页的遮罩段矩形整块**，只有 `coverTilted`（斜排原文）才按字形四边形修剪可见范围。
  跨页侧按页映射、不会串到邻页，这也是"上一页空壳 span"必须被 `hasTextPixels:false` 挡掉的原因。
  三条路径同口径：`lifecycle-bubble`（DOM）、`crosspage-cover`（跨页段）、`renderer-embed`（画布）。
  `bg_type=none` 的清理图路径另有一套：拿不到清理图就透明（`.mt-bg-none`），绝不画纯色补丁。
- **跨页遮罩的坐标系**：`mapCompositePointToRoot` 返回 **root 坐标**，而遮罩段的节点矩形是**覆盖层局部坐标**
  （`node.style.left/top` 相对 `.mt-cross-page-overlay`），两者相差覆盖层原点 `max(0, geometry.outer.left/top)`
  —— `applyCoverSegmentTilt` 必须先做这步平移（`context.offsetX/offsetY`）。少了它，映射点与节点矩形永远不相交，
  斜排跨页遮罩的 `clip-path` 从来没真正生效过（一直只是"没裁"而已，看起来像正常）。
- **跨页 span 的三值「有没有文字像素」**：接缝复合图上「气泡轮廓越过分页线、文字像素全在另一页」时，
  `background/modules/observation-results.js#buildObservationPageSpans` 会**故意**把这一页的贡献扩成
  整个视觉容器（双页渲染面必需），并在 span 里显式写 `hasTextPixels: true|false`。
  `reconciler-observation.js#normalizePageSpan` 原样透传（缺字段 → `null` = 未声明，**不能塌成 false**：
  `textBox` 在那里一律被归一成 null，「确实没有文字」与「没记文字框」只靠这个字段区分）。
  消费端**只认显式 false**：`projection-utils.js#canonicalSeamPageBoxes` 把这类 span 同时挡在
  `page_text_boxes` 与 `page_cover_boxes` 之外（后者也是 `buildCleanedArtifactProjectionPlan` 的清理掩膜来源，
  必须与遮盖同进同退），`reconciler-projection-utils.js#pageCoverIsEligible` 在**整页几何都被声明 false** 时
  不发 cover 投影。未声明的一律按「可能有文字」处理 —— 拿不准就多画一块，不能把正常遮罩打掉。

## Module Layout

数量为 2026-09 审计时点（口径：该目录下递归 `.js` 文件数）。清单以目录为准。

| 目录 | 文件数 | 说明 |
| --- | --- | --- |
| `background/modules/` | 51 | Service Worker：消息路由、OCR/翻译 provider 编排、缓存、术语发现 |
| `background/providers/` | 3 | provider 注册表 + OCR/翻译实现 |
| `content/modules/` | 86 | 内容脚本：读取器运行时、调度、采集、场景、渲染、网页与小说链路 |
| `canonical/modules/` | 24 | canonical 管线、stitch、投影、场景索引 |
| `canonical/reconciler-modules/` | 14 | 接缝 reconciler（观察/配对/投影/回退） |
| `canonical/canonical-pipeline-factory/` | 7 | canonical 各阶段工厂 |
| `canonical/page-store-factory/` | 3 | 页级 store 组装 |
| `shared/` | 27 | 跨域共享：术语库核心、语言码、哈希、接缝带、投影角色、思考模式、novel 核心 |
| `glossary/` | 18 | 术语库页面（`modules/` 17 个：编辑/待确认/词条视图/批量/导入导出/库管理） |
| `novel-mobile/` | 28 | 手机小说版（独立构建：`dist/novel-mobile`） |
| `settings/` | 6 | 设置页（服务选择、配置档案向导、本地服务可达性、档案命名） |
| `sidepanel/` | 3 | 侧栏章节译文修订面板 |
| `rendering/` | 7 | RenderScene、DOM/内嵌渲染器、气泡配色、封面几何 |
| 其余 | — | `popup/` 2、`quick-popup/` 2、`translations/` 2、`readers/` 2、`config/` 4、`layout/` 2、`geometry/` 1、`recognition/` 1 |

### 共享术语库/术语发现模块（`extension/src/shared/`）

`glossary.js`（schema v4 + 生效条目解析 + 指纹）、`glossary-library.js`（库归一 + 网址匹配）、
`term-discovery.js`（合并/编排）、`term-discovery-keys.js`（章节/源文身份）、
`term-discovery-pending.js`（待确认存储 + 章节 `libraryId`）、`term-discovery-ignored.js`（忽略表）、
`term-repair.js`（照抄原文的术语就地换译名）、`novel-hosts.js`（站点名单唯一真源）、
`traditional-chinese.js`（繁体专用字唯一真源）、`seam-band.js`（接缝带几何）、
`projection-role.js`（投影角色归一）、`stable-hash.js`（两种哈希输出）、`shared-constants.js`（跨模块零散常量）、
`thinking-mode.js`（**思考模式唯一定义处**：`auto/off/on` + 按服务商选参数名）

## Code Patterns

- 入口（`*/index.js`）只做装配，不写业务逻辑
- `configure.js` 负责绑定 provider、配置存储与消息处理器
- 测试用 `runtime` 桩替换真实 API 调用
- 缓存键的构成：OCR = 图像 + OCR 配置 + 几何版本；翻译 = canonical 文本 + 翻译配置 + 提示词版本 + 术语库指纹
- **同一个含义只允许一处定义**：跨模块共用的常量放 `shared/shared-constants.js`（或同域内的单一来源），
  参与缓存键/身份键的哈希与语言码尤其不能有第二份 —— 分叉不会报错，只会静默出错
