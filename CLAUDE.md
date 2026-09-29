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
- 测试规模口径（文件数，2026-09 审计时点）：`tests/*.test.mjs` **164** 个文件、`tests/test_*.py` **17** 个文件。
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
- **SQLite 术语库 schema v6**（`glossary_store/common.py`；v5 是**译文库** `translation_store/schema.py`）：
  `glossary_libraries`（含 `apply_urls`）+ `library_id` on `glossary_entries`/`pending_candidates`；
  身份索引 `(source_key, src_lng, tgt_lng, scope_type, scope_key, library_id)`
- **Seam triple OCR**：切片接缝处会 OCR 上片、下片与合成图三份；reconciler 只保留一个投影为 `primary`、
  其余标 `standby`，`content/configure.js` 在渲染前过滤 `standby`/`text_standby`，所以页面里出现隐藏或零几何的
  `mt-overlay-root` 是预期的（那是离屏切片覆盖层，滚回去会重现），不是几何丢失。用
  `__mtOverlayGeometryReport()`（页面控制台）诊断。
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
- **Truncation guard**：两条判据，镜像在 `extension/src/shared/translation-shrink.js` 与
  `local-ocr-service/translation_store/shrink_guard.py` ——
  (a) 自动候选明显短于当前启用版本（< 60%）时保留旧文本；
  (b) **与有没有旧版本无关**：「原文 ≥ 12 字、候选 ≤ `min(6, max(2, floor(源文 × 0.15)))` 字」判为截尾。
  两端作用相同、落地方式不同：客户端 (b) 命中时**不写缓存但当次仍渲染新值**（首次译文没有更好的值可用），
  服务端 (b) 命中时**不设为启用版本**（候选仍进历史）。手动/置顶候选与人工版本不受 (b) 影响。
- **浏览器里缓存的键族**：`mt_cache_v<N>:` 一个前缀族同时装着 OCR 缓存（`v28:ocr:`）、小说缓存（`v23:novel*`）
  与译文缓存（`v29:translation:`）。配额兜底清理**有意**把整个族都清掉（`isManagedCacheKey`），
  名字不叫 translation cache 就是这个原因。

## Module Layout

数量为 2026-09 审计时点（口径：该目录下递归 `.js` 文件数）。清单以目录为准。

| 目录 | 文件数 | 说明 |
| --- | --- | --- |
| `background/modules/` | 50 | Service Worker：消息路由、OCR/翻译 provider 编排、缓存、术语发现 |
| `background/providers/` | 3 | provider 注册表 + OCR/翻译实现 |
| `content/modules/` | 84 | 内容脚本：读取器运行时、调度、采集、场景、渲染、网页与小说链路 |
| `canonical/modules/` | 24 | canonical 管线、stitch、投影、场景索引 |
| `canonical/reconciler-modules/` | 14 | 接缝 reconciler（观察/配对/投影/回退） |
| `canonical/canonical-pipeline-factory/` | 7 | canonical 各阶段工厂 |
| `canonical/page-store-factory/` | 3 | 页级 store 组装 |
| `shared/` | 26 | 跨域共享：术语库核心、语言码、哈希、接缝带、投影角色、novel 核心 |
| `glossary/` | 18 | 术语库页面（`modules/` 17 个：编辑/待确认/词条视图/批量/导入导出/库管理） |
| `novel-mobile/` | 28 | 手机小说版（独立构建：`dist/novel-mobile`） |
| `settings/` | 5 | 设置页（服务选择、厂商 UI、本地服务可达性） |
| `sidepanel/` | 3 | 侧栏章节译文修订面板 |
| `rendering/` | 7 | RenderScene、DOM/内嵌渲染器、气泡配色、封面几何 |
| 其余 | — | `popup/` 2、`quick-popup/` 2、`translations/` 2、`readers/` 2、`config/` 4、`layout/` 2、`geometry/` 1、`recognition/` 1 |

### 共享术语库/术语发现模块（`extension/src/shared/`）

`glossary.js`（schema v4 + 生效条目解析 + 指纹）、`glossary-library.js`（库归一 + 网址匹配）、
`term-discovery.js`（合并/编排）、`term-discovery-keys.js`（章节/源文身份）、
`term-discovery-pending.js`（待确认存储 + 章节 `libraryId`）、`term-discovery-ignored.js`（忽略表）、
`term-repair.js`（照抄原文的术语就地换译名）、`novel-hosts.js`（站点名单唯一真源）、
`traditional-chinese.js`（繁体专用字唯一真源）、`seam-band.js`（接缝带几何）、
`projection-role.js`（投影角色归一）、`stable-hash.js`（两种哈希输出）、`shared-constants.js`（跨模块零散常量）

## Code Patterns

- 入口（`*/index.js`）只做装配，不写业务逻辑
- `configure.js` 负责绑定 provider、配置存储与消息处理器
- 测试用 `runtime` 桩替换真实 API 调用
- 缓存键的构成：OCR = 图像 + OCR 配置 + 几何版本；翻译 = canonical 文本 + 翻译配置 + 提示词版本 + 术语库指纹
- **同一个含义只允许一处定义**：跨模块共用的常量放 `shared/shared-constants.js`（或同域内的单一来源），
  参与缓存键/身份键的哈希与语言码尤其不能有第二份 —— 分叉不会报错，只会静默出错
