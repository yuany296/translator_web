# Operations Log

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
