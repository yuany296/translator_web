# Operations Log

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
