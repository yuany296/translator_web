# Operations Log

## 2026-07-26 - Codex（吸收跨页文本中的短韩文误识别片段）

- Chrome 现场确认跨页三行已经归为一个 canonical，完整原文为 `이렇게 마음 편히 먹어보는 게 얼마 만이더라.`、译文为“多久没有这样安心地吃过饭了？”，但框内仍保留一个独立普通气泡“舒心地”。该气泡的原始 OCR 是 `펴히`，与正确 seam 文本中的 `편히` 只差一个韩文音节内部字母。
- 既有模糊文本匹配对 NFD 长度小于 5 的片段保持拒绝，以避免短字串误合并；`펴히` 的 NFD 长度为 4，因此即使其几何框完全位于跨页文字框内，也不能进入片段组。
- 为片段组新增严格的短韩文纠错证据：仅接受 2–3 个纯韩文音节、NFD 模糊相似度至少 0.8，且 seam 覆盖比例至少 72% 的候选；通用模糊匹配的默认最短长度保持不变。远离 seam 的相同误识别、同位置但文字无关的短片段继续拒绝，避免按本次案例特殊化。
- 回归直接覆盖公开 `reconcile()` 的完整流程和重复执行幂等性，断言 `펴히` 与上下页三行、seam observation 全部进入唯一 canonical，完整原文不丢失；同时覆盖远距离和无关短韩文的负例。
- 完整本地 `npm run verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `521/521`、Python `58 passed, 1 skipped`；最新 bundle 已写入 `dist/extension/`。

## 2026-07-26 - Codex（修复原子多行组件的跨页续接）

- 首轮修复重载后，先确认漫画页仍持有失效的旧 content script（控制台为 `Extension context invalidated`）；刷新漫画页并重新翻译后，Chrome 现场仍稳定复现两个重叠 canonical，排除“仅未刷新页面”这一表象原因。
- 临时诊断锁定到续接的最后一道组件约束：下页候选与 seam 的关系已通过，得分约 `0.699858`、几何重叠约 `0.779733`、文本公共边界为 5 个字符，翻译角色也兼容；唯一失败项为 `componentCompatible=false`。
- 上页 owner 是片段组原子合并得到的合法多行组件，内部包含独立的“이렇게”和“마음”行。旧的 `canUnionComponents()` 在吸收下页续句时重新校验 owner 的所有内部成员，因两行本就不应几何重叠 35% 而误拒绝整个续接。
- 新增 continuation bridge 专用约束：信任两个已形成组件各自的内部合法性，只检查本次合并新增的跨组件同页几何冲突；章节一致、最多三页、三页中间页贯穿和翻译角色等全局硬约束保持不变。新增回归覆盖“原子多行 owner + seam 公共中间行 + 下页长续句”，并断言旧约束拒绝、新约束接受且原文扩展为完整三行句子。
- 完整本地 `scripts/verify.mjs` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `520/520`、Python `58 passed, 1 skipped`；最终 bundle 已写入 `dist/extension/`。沙箱内首轮 Python 的 5 个失败仅因无权读取本机 PaddleOCR 模型缓存，在获准的本机环境重跑后全部通过。
- 首次最终页面复测又暴露第二层缺口：新 continuation bridge 已把三个 page observations 合并为同一组件，但 `fragmentGroup.authoritativeText` 在 draft 阶段无条件覆盖 `chooseCanonicalText()` 的续接扩展，导致 canonical 成员已完整、原文仍停留在 seam 前缀。该行为此前的内部 helper 回归无法覆盖。
- 对发生 continuation bridge 的片段组，draft 现在会在片段组权威文本与完整成员推导文本之间保留更长的续接结果；未发生 bridge 的普通片段组继续沿用原权威文本，避免放宽既有选择规则。回归升级为直接调用公开 `R.reconcile()`，断言只产生一个 canonical、`acceptedContinuationBridges=1`，且完整原文为 `이렇게 마음 편히 먹어보는 게 얼마 만이더라.`。修正后再次完整验证通过：Node `520/520`、Python `58 passed, 1 skipped`，其余门禁、lint 与构建均通过。

## 2026-07-26 - Codex（修复跨页三行文本的传递归并）

- 按用户要求先提交本轮既有的跨页统一覆盖层与页面几何改动，基线提交为 `58f6ed8`，随后再开始本修复。
- Chrome 现场证据显示：跨页 observation 已包含“上行 + 中行”，下一页普通 observation 又包含“中行 + 下行”；旧 reconciler 只会把 seam 归给得分最高的一个 page component，不能借公共中行继续吸收另一个 component，因而输出两个相互遮挡的 canonical。即使三个 observation 已偶然进入同一 component，旧文本选择也只在恰好一个 page observation 时扩展 seam，仍可能截断下行。
- 新增 seam owner 的 continuation bridge：只有真实跨页贡献、公共边界文本、页边接触和几何重叠均达到阈值，且组件页数、同页几何与翻译角色约束全部通过时，才把第二个续接 component 原子并入 owner；诊断记录 `acceptedContinuationBridges`。对 `effect_text` / `caption_panel` 这类页缝分类漂移，仅在文本与几何双强证据下放行，普通异类相邻文字仍保持硬边界。
- canonical 原文现在可同时按阅读方向吸收 seam 的前缀和后缀扩展，公共中行只保留一次；目标回归得到唯一原文 `이렇게 마음 편히 먹어보는 게 얼마 만이더라.`，三个 observation 全部记为 `consumed`。reconciler 模型版本提升为 `kakao-canonical-v2`，避免重载后复用旧 observation 身份。
- 完整本地 `scripts/verify.mjs` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `519/519`、Python `58 passed, 1 skipped`；最新 bundle 已写入 `dist/extension/`。沙箱内首轮 Python OCR 的 5 个失败仅因无权读取用户目录中的 PaddleOCR 模型，获准在本机环境重跑同一验证后全部通过。

## 2026-07-22 - Codex（修复滚动后 loading 消失与排队状态不可见）

- Chrome 现场先后采集到三类一致证据：正文图片仍有 `inflightSourceToken` 时 loading 已离开视口；滚动到后续图片时可见目标尚未启动且没有任何排队提示；控制台最终明确记录 `Loading overlay timed out, clearing`。右下角“停”只表示本页自动翻译已开启，不能证明当前有任务执行，因此旧 UI 会让用户误判为处理已经停止。
- 翻译目标进入调度队列后立即渲染“等待处理...”，任务真正开始后继续由 canonical 阶段更新为提取、识别、翻译、跨页处理和渲染等文案。排队与执行两种状态现在都有明确反馈。
- loading 的 30 秒计时器改为孤儿状态看门：目标仍在 `queuedTargets` 或 `inflightByTarget` 时保留提示并重新武装计时器；只有任务已经不在队列/执行集合时才清除并按既有恢复规则重试。已翻译 overlay 上附加的进度胶囊也共用相同生命周期，终态清理会同步取消计时器。
- loading 卡片不再固定在整张图片的顶部或中心，而是每帧根据目标图片与当前视口的可见交集计算锚点。长图顶部滚出屏幕、只剩图片底部可见或页面继续下滑时，提示仍保持在当前可见片段中央。
- 新增回归覆盖长图可见片段定位、活动任务超时保留/断连清理和排队提示先于 worker 启动。定向测试 `39/39` 通过；完整验证中的文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建和全部 Node 测试通过；Python 在获准读取本机 PaddleOCR 模型后为 `58 passed, 1 skipped`。新 bundle 已写入 `dist/extension/`。
- Chrome 安全策略禁止自动打开或操作 `chrome://extensions/`，因此未绕过限制。普通页面刷新仍使用旧扩展进程，现场最终回归需要用户手动在扩展管理页点击一次“重新加载”，再刷新当前 Kakao 页面。

## 2026-07-20 - Codex（跨页完整页坐标几何进入统一 overlay）

- 首轮 Chrome MCP 复测中，surface 已显示 `accepted` 且内容层校验为 `ok=true`，但 DOM 仍为零。进一步确认统一 overlay 会在包含目标 seam 的渲染调用中创建，随后又被处理第 125 页的空 seam 调用全局删除。修复为 canonical 的每一次逐页 render descriptor 都携带同一份权威 `allSeamSurfaces` snapshot；内容 renderer 统一按该快照协调全局 overlay，无关页面不再撤销刚安装的跨页节点。
- Chrome MCP 诊断确认目标 seam 已完成、上下页 revision 一致、跨页 observation 与下页完整 observation 已归入同一个 canonical，译文也已生成；但 `buildSeamRenderSurfaceIndex()` 仍未产出 surface。现场下页 canonical 框从页顶延伸至约 `16.32%`，而 seam 捕获带只覆盖页顶约 `10%`，旧的 `inspectCanonicalSeamGeometry()` 要求 page observation 必须完全包含在捕获带内，因此合法的页边文字块被误判为 `canonical_geometry_outside_capture`。
- 几何门槛改为“page observation 必须与对应 seam 捕获带真实相交”，不再要求完整包含。这样从页边开始、但为了容纳整行/整段而延伸到捕获带外的块可进入跨页 surface；完全位于捕获带外、与 seam 断开的附近文字仍会被拒绝。
- surface bubble 新增 canonical 级 `page_text_boxes` / `page_cover_boxes`：汇总全部成员在上下页原图坐标中的完整几何，并在阅读区域 overlay 中通过各页 `getBoundingClientRect()` 转成统一正数局部坐标。text frame 取上下页完整框的整体 union，只布局一次并包含真实 page gap；cover 仍按页生成独立 segment，不覆盖 gap，也不再被 seam 截图高度截短。
- 非纯色背景继续优先使用对应页 cleaned image；缺失页级 artifact 时保留 seam cleaned image 路径或背景色回退。surface 签名纳入页级 cleaned image 哈希，artifact 更新不会污染稳定 layout key。
- 新增回归覆盖：页边块延伸出 seam 捕获带仍保留完整 `16.32%` 页几何、断开正文继续拒绝、阅读区域 text frame 跨越上下页及 24px gap、下页 cover 不被 96px seam band 截短。完整 `npm run verify` 通过：文件长度、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `515/515`、Python `58 passed, 1 skipped`；最新产物已写入 `dist/extension/`。

## 2026-07-19 - Codex（让片段组采用的 seam observation 成为 canonical 正式成员）

- Chrome MCP 在重载后的真实 Kakao 页复核：跨页 loading 正常，本轮 seam OCR 文件按预期生成，v25 已把圆形气泡的四个文字片段合成完整文本；但 DOM 仍为下页普通 `text_primary`，canonical 为 `canonical_c59a163480e4d400ee2b47e48a74a45c`，`.mt-cross-page-overlay=0`，页面级 seam/render 诊断均为空，证明 surface 在 canonical ownership 建立前即缺席。
- 根因是片段组允许多个单侧 `seam_context_only` observations 共同构成强 seam capture，却只把被归并的 page observations 写入 canonical 成员；这些 seam observations 虽提供了 authoritative 完整原文和归并授权，仍在 coverage ledger 中被标为过滤。`buildSeamRenderSurfaceIndex()` 按 observation ID 验证 canonical 与 seam state 的明确所有权时因此找不到交集，正确拒绝 surface，随后完整文本只能落为下页普通 projection。
- 被采纳片段组的 `seamObservationIds` 现正式附着到同一 canonical，进入 `memberObservationIds`、geometry、coverage ownership 与 surface 归属；同一 capture 中未参与归并的附近 seam 片段继续保持 `seam_context_only` 过滤。普通单页兼容约束、论坛角色硬边界及未授权 seam 的过滤行为不变。
- 更新回归断言：共同授权下页多片段的 seam observations 必须为 `consumed` 且进入 canonical；无关上页 seam 仍过滤；共享区域的双侧多片段全部进入同一 canonical。完整 `npm run verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `513/513`、Python `58 passed, 1 skipped`；构建已写入 `dist/extension/`。

## 2026-07-19 - Codex（修复 seam 所有权随 DOM 可用性抖动）

- Chrome MCP 复核确认本地 OCR 服务 `/health` 正常（`ok=true`、`device=gpu:0`），但重载后的失败轮次没有产生新 OCR 请求；结合上一轮已确认的 v25 seam OCR（四个文字片段已经合并为一个跨页 observation）继续追踪 canonical→render 路径，排除“需要重启 OCR”及论坛昵称/时间拆分规则。
- 根因是 `buildSeamRenderSurfaceIndex()` 把已完成 seam surface 的 canonical 所有权错误地依赖于两页 DOM 在同一时刻均可解析。任一页面绑定短暂缺席时，surface 被直接丢弃，后续 projection plan 会把完整 seam 文本重新作为普通单页投影显示在仍可用的下页，形成“韩文残留 + 中文框从下页顶部开始”的现场现象。
- seam surface 现只由已完成的 OCR/canonical/revision 证据决定，不再因瞬时 DOM 可用性撤销；若另一页暂不可用，统一 overlay 延后安装，同时继续按 `absorbedCanonicalIds` 压制单页 fallback，不重新 OCR、翻译或排版。
- `restoreKnownKakaoPageHandle()` 增加唯一、完全相同 source token 的恢复路径：阅读器回收/重连同一图片 DOM 后可恢复 pageId 与 image revision 绑定，并触发纯 projection refresh；不同 token、多个候选或 revision 冲突仍拒绝恢复，避免复用 DOM 绑定到旧图片。
- 新增回归覆盖“任一 seam 页面临时缺席时不恢复被吸收的单页 projection”和“同源图片恢复 canonical handle”；既有真实 seam 多片段、单 overlay、非负坐标、gap、resize/zoom、loading 与论坛角色边界用例继续通过。完整 `npm run verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `513/513`、Python `58 passed, 1 skipped`；新 bundle 已写入 `dist/extension/`。

## 2026-07-19 - Codex（单页气泡样式碎片归并与 OCR 语义缓存失效）

- Chrome MCP 将接缝置于视口中部并读取相邻图片几何后确认：圆形气泡确实横跨图片 123/124，第一页包含标题行，第二页包含后两行；现场拆出的 canonical 都是普通 `speech_bubble` 且 `translationRole` 为空，论坛昵称/时间拆分不是直接原因。
- 重载 v24 后旧三框缓存已失效，但 DOM 仍产生左右两列：`<화요 A등급 인정되지` 与 `'귀스쇼/의 재조정은 않았습니다.`。直接对 Chrome 截图运行扩展同款 OCR pipeline，发现服务把同一个圆形气泡误检成两个区域：左区 `x=113..369, y=172..432`，右区 `x=254..613, y=176..437`；纵向重叠约 98%、横向重叠约 45%，但 region ID 不同，导致左右同行在聚类入口即被判为不同气泡。
- 新增“强重叠气泡区域家族”：仅当两个高置信 `speech_bubble` 区域在一个轴向重叠至少 80%、另一个轴向至少 35%、交集占较小区域至少 35%，且背景色距离不超过 24 时，才允许不同 region ID 共享普通漫画文字聚类。仍保留原 `1.2 × 行高` 同行间距，不放宽远距离文字；不同容器、断开区域、时间格式冲突和 `chat_nickname` / `chat_time` / `chat_body` 等论坛角色继续保持硬边界。
- 聚类后的 Observation 会在扩展中缓存 7 天。扩展 OCR 语义缓存前缀最终提升为 `mt_cache_v25:ocr:`，让旧三框与两框结果失效；未改动 Python OCR 几何协议，因此无需重启 `local-ocr-service`。新 bundle 已写入 `dist/extension/`，现场生效只需重载扩展并刷新 Kakao 页面。
- 新增“两个强重叠 region ID、不同颜色/字号且每行均拆成左右两段”的六碎片回归，断言按行恢复完整原文；现有独立气泡、论坛昵称、时间、正文用例继续通过。最终 `verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `511/511`、Python `58 passed, 1 skipped`。

## 2026-07-19 - Codex（修正 seam capture 多 observation 证据粒度）

- 用户重载旧一轮构建后，用 Chrome MCP 再次刷新并触发当前视口翻译：loading 正常出现三个“提取单页图片...”，但现场仍是 `A등급 인정되지`、`'귀스쇼/의`、`<화요`、`재조정은 않았습니다.` 四个普通 page canonical；DOM 中 `.mt-cross-page-overlay=0`。这证明统一 overlay 已加载，失败点仍在 canonical 归并之前。
- 根因是上一版片段组仍要求“单个 seam observation”同时对两页有有效贡献。真实 seam OCR 会在同一次 capture 中返回多个 observation，每个 observation 可能只落在上页或下页；它们逐个都被标记为 `seam_context_only`，因此片段组拿不到能代表整次截缝的强证据。
- 改为按稳定 `captureId` 聚合同一次 seam OCR：组内 contribution 共同满足两页最低占比后才成为强 seam capture；每个 page fragment 仍必须分别通过页边、几何、文本/视觉关系检查。同页 fragment 使用连通分量原子归并，不放宽普通 `pageMembersCompatible()`。
- 同一 capture 内，单个 seam observation 可仅支持一侧；跨页组件只有共享同一 seam observation 或同一 capture-local region 身份时才连接，否则分别形成独立的单页片段组，避免把分页面两侧相邻但无关的气泡合并。完整原文按匹配的 seam observations 稳定排序并只翻译、布局一次；诊断同时记录 capture ID、seam observation IDs 和吸收的 page observation IDs。
- 新增回归覆盖“多个 context-only seam observations 共同授权下页四片段归并”和“同一区域的双侧多片段跨页归并”。完整 `verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `510/510`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。Chrome MCP 因浏览器安全策略不能操作 `edge://extensions/`，需要用户再次手动点扩展重载后完成现场复核。

## 2026-07-19 - Codex（跨页 seam 多片段 canonical 原子归并）

- Chrome 现场确认论坛角色拆分不是直接原因：问题块的 `translationRole` 均为空。真正缺口是 reconciler 只按“上页一个 observation + 下页一个 observation”建立普通边；第一条边合并后，后续同页相邻碎片因彼此重叠不足 35% 被组件约束拒绝，最终形成多个独立 canonical 和重叠译文框。
- 新增 seam 级片段组：每个 page observation 必须位于对应页边、落在同一 seam 支持几何内，并与 seam 文本或稳定视觉身份相关；同页碎片使用归一化坐标的间距连通图分组。候选按分数、成员数和稳定 ID 排序，在普通 pair edge 之前一次性合并，普通单页 `pageMembersCompatible()` 约束保持不变。
- seam 自身已经提供上下两页权威几何时，允许吸收仅出现在单侧 page OCR 中的多个连通碎片；这覆盖当前视口未生成上页 page observation、但 seam OCR 已跨越两页的场景。完整 seam 文本成为唯一 canonical 原文，所有吸收 observation 共享同一 ownership、翻译和布局。
- `chat_nickname`、`chat_time`、`chat_body` 等显式角色是硬边界；不同角色以及空角色与显式角色不得通过普通边或片段组归并。诊断新增 `acceptedFragmentGroups` / `rejectedFragmentGroups`，记录 seam ID、成员 observation IDs、分数及拒绝原因。
- 新增回归覆盖上页一块+下页多块、双侧多块、仅单侧多块、输入乱序确定性、断开干扰块、论坛角色隔离，以及 canonical pipeline 只发起一次翻译；现有统一 overlay DOM 用例继续验证单 overlay、非负坐标、页面 gap、分段 cover、一次文字拟合和 resize 几何复用。
- 完整本地 `verify` 通过：文件长度、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `508/508`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。Chrome MCP 能刷新和检查 Kakao 页，但浏览器安全策略禁止控制 `edge://extensions/`；未绕过限制，现场最终复核需要用户手动点击一次扩展“重新加载”后继续。

## 2026-07-19 - Codex（修复邻页 ready 时机导致 seam 未激活）

- Chrome 现场确认两处异常均没有生成 `.mt-cross-page-overlay`，而是由相邻页的普通 `.mt-overlay-root` 分别渲染多个 canonical；旧 `.mt-seam-window` / `.mt-seam-composite` 已不存在，说明问题发生在统一跨页 renderer 之前。
- 根因是 `registerTarget` 记录的 pending 邻页关系会在 `commitPageIdentity` 阶段调用 `resolvePendingKakaoAdjacency()`；此时当前页尚未写入 Store，旧逻辑却先删除 pending 关系。两页并发 OCR 时，双方第一次检查都可能只看到未就绪邻页，之后再无事件触发 seam，8 秒 edge wait 超时后只能放行普通单页碎片。
- 新逻辑只在双方 page handle、ready terminal 与 image revision 全部匹配后消费 pending 关系；页面 OCR 标记 ready 后通过 `notifyCanonicalPageReady` 再次兑现邻页，并在当前页普通 projection 前等待 `onAdjacentTargetAvailable()` 完成。seam 明确 completed/failed/skipped 后才按既有规则继续，成功 surface 继续使用显式 `absorbedCanonicalIds` / `absorbedObservationIds` 接管上下页。
- 新增回归覆盖：过早 pageId 绑定不得消费 pending 关系、双方 ready 后只消费一次，以及 ready 通知发生在页面 projection 之前。文件长度、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `501/501` 均通过；Python 在获准读取本机 PaddleOCR 模型后为 `58 passed, 1 skipped`。
- 新构建已写入 `dist/extension/`。浏览器安全策略禁止自动操作 `edge://extensions/`，未绕过限制；仍需用户手动重新加载本地扩展并刷新 Kakao 漫画页后进行现场复核。

## 2026-07-19 - Codex（跨页气泡改为阅读区域统一坐标系的单一 DOM overlay）

- 按用户要求先在 `main` 提交既有已验证修复（`a787fa3`），再创建并切换到 `codex/cross-page-unified-overlay` 分支；本轮只替换 seam projection/render，OCR、翻译和 canonical 归并入口保持不变。
- 删除上下页面各自创建 `.mt-seam-window` / `.mt-seam-composite` 的旧路径以及负 `top` 裁剪变换。新增阅读区域级 `.mt-cross-page-root`：选择同时包含两页且不含 `overflow/clip-path/contain:paint` 裁剪的共同祖先，必要时将其设为 `position:relative`，root 使用 `position:absolute; inset:0; overflow:visible`。
- 新坐标链严格按 seam 原始画布坐标 → 每页原图坐标 → 页面 `getBoundingClientRect()` 显示坐标 → overlay root 局部坐标转换。每个跨页 canonical 只生成一个 `.mt-cross-page-overlay`、一个完整 `.mt-text-layer` 和一次文字拟合；resize、缩放、图片加载、阅读宽度变化及 DOM 重排仅重算位置、尺寸和字号比例，不重新 OCR、翻译或调用文字拟合。
- cover 与 text 分层：清理图按 upper/lower segment 分别投射到实际图片区域，页面 gap 保持透明；译文元素的整体 frame 包含真实 gap 并连续横跨两页。调试态通过同一个 overlay 的连续蓝框显示，不再生成上下页两套框。
- 普通页去重改为显式 ownership：surface 携带 `absorbedCanonicalIds`、`absorbedObservationIds` 与调试项别名，并追溯 `supersedesId` / `retiredById` 链；普通 projection 和旧 page debug 按 ID 移交，不再以 72% 蓝框重叠作为主要判据。
- 新增真实 DOM 回归，覆盖裁剪祖先上移、单一 overlay、非负 top/left、单一 text、两段 cover、不覆盖 24px gap、一次文字布局以及 resize 后几何/字号正确缩放；同步更新 ownership、样式和架构测试，并断言生产代码不存在旧 seam window/composite 或负坐标同步函数。
- 完整本地 `verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `499/499`、Python `58 passed, 1 skipped`；构建已更新 `dist/extension/`。沙箱内首次 Python 视觉测试仅因无法读取用户目录中的 PaddleOCR 模型缓存失败，获准在沙箱外重跑同一套验证后全部通过。

## 2026-07-19 - Codex（跨页增量 loading 与尾句重复译文）

- Chrome 现场确认同一气泡同时渲染两个不同 canonical：单页 OCR `담당자 실수로 <화요 퀴즈쇼>가 중복 배정되었다고` 与跨页 seam OCR `중복 배정되었다고 합니다.`。两者共享页边尾句且几何重叠，但旧版运行中的扩展没有将其归并，因此分别翻译为长句和“复安排了”。
- 将现有 seam→page 续接逻辑补充为当前现场的反方向回归：上页长句能够吸收 seam 尾缀、去除公共文本后形成唯一完整句，防止 page projection 与 seam surface 各输出一个译文框；无文本续接关系的相邻气泡仍保持独立。
- loading 缺失确由截页增量入口造成：相邻 DOM 页后到达时，`onAdjacentTargetAvailable()` 直接执行 seam OCR 与 canonical refresh，绕过普通页面 job 的 `scope.loading()`。现在该入口只在 pair 尚未结算时为上下两页同时显示“处理跨页...”，渲染阶段更新为“渲染结果...”，并在成功或异常后统一清理；已结算 pair 不会重复闪烁。
- 自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `501/501`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。Chrome 现场读取了 Kakao 普通页面并确认旧版双框 DOM，但扩展管理页受浏览器安全策略保护，无法代替用户点击重新加载；新构建仍需手动重新加载扩展并刷新漫画页后复核。

## 2026-07-19 - Codex（跨页 seam 前缀与下一截页长句合并）

- Chrome 现场同步截图与 DOM 数据确认，重复显示来自两个同时激活的 canonical：跨页 seam 片段 `김솔음이 개빡센` 与下一页顶部完整句 `개빡센 입사이틀을 보낸다음날,`。两者在下一页共享 `개빡센` 边界词且几何重叠，但旧逻辑要求整体文本强相关，导致 seam 保持独立 surface、长句保持普通页面投影，最终两份中文叠加。
- 新增 seam→page 续接关系：仅对真实双页贡献的 seam、对应页边缘的 page observation、兼容区域、至少 35% 小框几何覆盖，以及达到短文本比例门槛的后缀/前缀重叠生效；无边界文本关系的相邻气泡仍保持独立。
- 当该关系把 standalone seam 接入唯一页面 canonical 时，按阅读方向去除公共边界词并合成完整原文，再统一翻译和投影；现场结构会得到 `김솔음이 개빡센 입사이틀을 보낸다음날,`，不再分别渲染 seam 片段与下一截页长句。
- 新增正向续接与反向无关文本回归。文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、完整 Node 测试均通过；Python `58 passed, 1 skipped`。新构建已写入 `dist/extension/`。Chrome 安全策略禁止自动进入扩展管理页，本轮未绕过；需手动重新加载本地扩展并刷新 Kakao 页面后完成新版现场复核。

## 2026-07-19 - Codex（译文倾角放宽到完整 -90°～90° 范围）

- Chrome 现场确认目标韩文 polygon 倾角约为 `-28.98°` / `-29.96°`，但 OCR 聚类、placement 和内容渲染三层都把超过 `25°` 的角度归零，导致译文只能水平显示；同页 `10.8°` 文字能正常保留旋转，排除渲染器不支持旋转的可能。
- 移除三层 `25°` 门槛，统一保留规范化后的 `-90°～90°` 倾角；内容层最大角度从 `89°` 调整为 `90°`。超过该范围的输入仍按文字轴的 180° 周期规范化，例如 `95°` 等价为 `-85°`。
- 将韩文/拉丁原文的横排判断提前到高角度竖排判断之前，确保接近 `90°` 的此类文字使用“旋转后的横排”，不会被误切成日文 `writing-mode` 竖排；日文竖排逻辑保持不变。
- 新增/更新回归覆盖 `32°`、`-89°`、`95°` 的规范化、超过 `25°` 的聊天公共角度、全范围 placement 中位角，以及高角度韩文仍横排。聚焦测试通过：内容角度 23/23、架构契约 16/16、韩文横排 1/1、聊天 `-30°` 1/1。
- 完整本地 `verify` 通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `498/498`、Python `58 passed, 1 skipped`；构建已更新 `dist/extension/`。首次沙箱内 Python 视觉测试因无权读取用户目录下的 PaddleOCR 模型缓存失败，获准在沙箱外重跑后全部通过。

## 2026-07-16 - Codex（倾斜文本按自身坐标轴分组，并在聚类前剔除评论区 UI 伪字）

- 用户提供的倾斜直播聊天页显示：服务端已返回约 `-14°` 的可靠 polygon/rotation，但前端 OCR 聚类仍用屏幕水平 AABB 的高度、上下间距和对齐关系判断同行/同段。同字号长行会因倾斜而得到远大于短行的 AABB 高度，继而被误判成不同字号或不同段；最终渲染即使保留旋转角，也无法补救已经错误的分组。
- 将 OCR 同行、段落、段落边界、阅读顺序、聊天区域识别、样式拆分、昵称/时间/正文角色及对齐推断统一改为文字轴/法线投影几何。polygon 可靠时使用真实厚度和轴向间距，缺失 polygon 时才回退 AABB；聊天正文还会继承附近元数据组的可靠公共角度。
- 对用户提供的干净评论卡截图直接调用正在运行的本地 OCR 服务复现：三行正文坐标为约 `y=170/239/306`，底部转发图标被误读为低置信度单字 `그`（`score≈0.672`、`y≈416`），点赞计数为独立数字 `1`。此前二者先进入段落聚类，后置 final 过滤只能看到“正文+伪字”，因此生成正文框、截断正文框及正文+图标大框三层覆盖。
- 新增聚类前 UI 伪字门禁：纯 1–3 位数字在进入段落前剔除；低置信度单字只有同时位于大面板底部、与同容器高置信度长正文存在明显间隔时才判为页脚控件伪识别。合法的独立短气泡和高置信度短句仍由原有保护规则保留。这样跨页截断最多留下上/下正文片段，图标不再形成第三个大蓝框，后续既有 seam/page 重叠仲裁可去掉重复下半片段。
- 新增两项通用回归：强倾斜三行同字号文字按自身坐标轴合成一个旋转段落；三行评论正文旁的低置信度页脚伪字和数字计数不得污染正文或扩大蓝框。文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `488/488` 均通过，构建已写入 `dist/extension/`。完整 Python 测试在受限沙箱中有 `53 passed, 1 skipped`，另 5 项 GPU/视觉基线测试仅因无法读取 `C:\Users\yuanying\.paddlex` 模型缓存而失败；申请该权限又被当前 Codex 用量限制拒绝。本轮未改 Python 代码，且同一运行中通过本地 OCR HTTP 服务实际复现了两张用户截图的识别结果。
- Chrome 已连接到 Kakao 标签页与扩展管理页，但 Kakao DOM 和 `edge://extensions/` 都被浏览器安全策略禁止读取；未绕过限制。新构建需要用户在扩展管理页手动点击一次“重新加载”，再刷新漫画页复核。

## 2026-07-16 - Codex（跨页 surface 与页面内部投影统一重叠仲裁）

- 用户报告评论卡正文同时出现三个最终蓝框。截图显示上方 `t9` 与下方区域互不重叠，应独立保留；下方 seam `c0` 大框完整覆盖一个普通页小框，后两者应按覆盖关系只保留大框，因此该组应从三个正文框收敛为两个；若剩余框继续满足同类覆盖条件，才进一步收敛为一个。
- 根因是 seam surface 内部候选已按“覆盖较多的大框优先”仲裁，但 surface 与普通页面投影之间的第二阶段抑制额外要求框位于页面顶部/底部 6% 内。短页、评论卡或 seam 捕获覆盖页面内部时，被大框覆盖的普通页小框会绕过总调度重新显示。
- 移除固定页边百分比前置条件，统一依据实际 page-local 投影判断：同区域族、覆盖较小框至少 72%，且小框面积不超过大框 1.35 倍时，surface 大框抑制普通页小框；互不重叠的独立评论继续保留。最终调试蓝框沿用同一 surface coverage 过滤。
- 新增页面内部 seam 大框只抑制重叠小框、保留独立框的回归。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `486/486`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。Chrome 已能发现用户指定的 Kakao 标签页，但站点权限策略拒绝读取页面 DOM，未绕过该限制进行现场提取。

## 2026-07-16 - Codex（移除 seam-only 次要页的孤立纯色白带）

- 用户刷新新构建后主白底已跟随最终蓝框收紧，但气泡上方仍残留一条独立白带。结合上一轮 Chrome 现场数据确认，同一 canonical 在相邻页底部还存在 `y=97.27%`、`h=2.73%` 的 `cover_only` 投影；它与当前页主蓝框不是同一节点。
- 根因位于跨页投影总调度：canonical 的次要页只有 seam 推测几何、没有该页自己的 page OCR 证据时，仍被无条件生成纯色 cover；当完整正文已经回退当前页渲染时，这个次要 cover 会单独落在空白处。
- 新增 `coverEligible` 调度约束：明确为 seam-only 且 `bgType=solid` 的次要页不再生成普通页面 cover，也禁止后续从 standby 补造 cover；含 page OCR 证据的真实跨页正文保持原遮盖行为。复杂背景 `bgType=none` 仍保留两页清理 artifact 请求，standby 在主页面缺失时也仍可接管文本与自身遮盖。
- 新增 seam-only 纯色孤立 cover、standby 补造门禁及复杂背景 artifact 保留回归。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `485/485`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（白底覆盖严格跟随最终蓝框）

- Chrome 现场测量确认同一 canonical 的译文层约为 `247×187px`，白底覆盖层却达到约 `311×220px`；白底使用了多次观测合并后的 canonical 外接框，而最终蓝框保存在 `fill_box`，两者并不相同。
- 根因是 canonical `fill_box` 使用 `{left, top, width, height}`，内容层归一化仅接受旧的 `{x, y, w, h}`，导致合法蓝框被当成空值丢弃；拆分后的 cover 节点随后回退到较大的 canonical 外接框。
- 内容层现同时兼容两种矩形格式；cover 节点先解析 `fill_box`，并直接以该最终蓝框作为自身几何，文本层仍独立使用原有 placement/polygon，避免白底超出蓝框或被译文字号反向扩张。
- 新增“canonical 总外接框大于最终蓝框”回归。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `484/484`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（完整 canonical 超出 seam 捕获带时回退页面渲染）

- Chrome 现场测量确认“完整三行译文挤在气泡上半部”是文本与几何错配：seam 最终框 `c0` 约 `213×58px`，几乎等于 `raw-0 | 안녕하세요!` 的 `199×54px` 第一行框；但该节点携带的 canonical 原文是三行完整句子“안녕하세요! 떠오르는 새벽! 더 던입니다!”。其余页面正文位于 `raw-7/raw-8/raw-6`，最后一行已经超出 96+96px seam 画布。
- 根因是 surface 构造只使用属于当前 seam state 的 observation 合并几何，却使用完整 canonical 的文本和译文；跨页证据只覆盖第一行时，完整译文会被错误装入第一行框。
- 新增 `inspectCanonicalSeamGeometry()` 可表达性门禁：逐一检查 canonical 的所有 page observation 是否完整落在对应 segment `sourceCrop` 内。任一正文框越出捕获带时，候选以 `canonical_geometry_outside_capture` 退出 seam surface，并且不写入 `handledCanonicalIds`；seam observation 仍保留用于 reconciliation，最终由页面侧 canonical union 大蓝框接管渲染。
- seam final 调试框现严格由最终选中的 surface bubbles 重建；surface 没有选中候选时清空旧 final 蓝框，只保留 raw 红框，避免已回退页面渲染后仍显示过期 `t0/c0` 小蓝框。
- 新增纯几何门禁和完整 pipeline 接管回归，覆盖“第一行在 top seam band、正文延伸到 band 外”的三行 canonical。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `483/483`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（统一跨页 surface 内蓝框仲裁与清理图挂载）

- Chrome 现场确认当前“多个蓝框”并非仅是 seam 与普通页面投影重复：同一个 `seam-render-v1:b3d69aed` surface 内同时存在完整 canonical“밥이요? 네, 먹었죠.”与被其覆盖的残片 canonical“먹었죠 먹었죠.”，面积约相差 3.1 倍；旧的 seam→page 移交仲裁无法处理 surface 内部冲突。
- 将跨页最终选择规则集中到 `projection-utils.js`：同一 surface 内、同区域类型且覆盖较小框至少 72% 的候选按面积降序仲裁，只渲染覆盖更大的蓝框；被淘汰 canonical 仍写入 `handledCanonicalIds`，避免它从普通页面投影再次激活。互不重叠的多个蓝框和不同类型的特效文字继续独立保留。
- OCR final 调试层现在跟随仲裁后的 seam 蓝框生成，普通页面中与 seam 最终框重叠的 final 蓝框会隐藏；raw 红框仍完整保留用于对比，避免逻辑已经淘汰残片但调试层继续显示 `t0/t4` 双蓝框。
- Chrome 同时确认衣服 `NICT` 没有 final 蓝框，却被 seam 的整张 `cleanedImage` 擦除。surface 现在仅在仲裁后的气泡确实存在 `bgType!=solid` 时挂载 cleaned image；纯色译文即使 OCR 响应携带清理产物，也会清空 surface 的 `cleanedImage`、token 与 fingerprint，避免无关衣服文字进入渲染结果。
- 新增重叠大框优先、独立多框保留、调试蓝框同步、纯色 seam 不消费无关清理图等回归。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `481/481`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（跨页蓝框覆盖仲裁改为移交后重算）

- 使用 Chrome 复核用户所示 Kakao 接缝现场：完整跨页蓝框对应 canonical `canonical_2b646...`，原文为“많이 와 주셔서 감사해요”；与其重叠的单页蓝框对应 `canonical_5eef...`，只包含残片“많이 와주셔서”。前者覆盖跨页完整文字，后者却仍被普通投影通道同时渲染，因而出现两份蓝框和两份中文。
- 根因是投影仲裁顺序：第一轮普通投影中，完整 canonical 已把残片降成 cover；完整 canonical 随后移交给 seam surface，普通投影重新构建时残片恢复 active，但 seam 抑制仍使用移交前的第一轮结果，无法看到重新激活的残片。
- 新增统一的两阶段 `resolveSeamProjectionPlan()`：先从普通投影移除已由 seam surface 接管的 canonical，再对重新构建的 active 候选按页面映射覆盖率做抑制，最后带着 seam handled 与 suppressed 集合重建最终投影；正常翻译与翻译失败回退共用同一顺序。多个 seam 蓝框仍逐一参与覆盖判断，独立且不重叠的普通文本不受影响。
- 新增与现场 `720×1100` 页面、`720×192` 接缝画布相同几何的回归，锁定“完整跨页 canonical 移交后，单页残片不得重新激活”。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `477/477`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。
- Chrome 刷新普通漫画页后仍运行旧 content script，现场 DOM 继续包含残片 canonical，确认 unpacked 扩展进程不会热读取本次构建。需在扩展管理页手动点一次“重新加载”，再刷新漫画页进行最终现场复核。

## 2026-07-16 - Codex（修复 seam 再次用完整气泡区域扩框）

- 使用 Chrome 复核当前 Kakao 页面并直接比较 DOM 几何：可见 seam 蓝色 final 框约为 158×107，但同一 canonical 的 cover/text 节点达到约 232×182；普通单页节点已经与蓝框一致，证明扩张发生在跨页 surface 构造，而不是 OCR 蓝框生成或字体溢出阶段。
- 根因是 seam 专用 `seamObservationCaptureBox()` 对纯色区域强制优先采用 `regionPolygon`，`buildSeamSurfaceBubble()` 又把纯色文字 polygon 替换成完整区域 polygon。因此正确的 `visual.box` 被覆盖，跨页遮盖与文字层同时退回整气泡面积。
- seam 现与单页遵循同一几何契约：最终遮盖以 `visual.box` 蓝框为第一优先级，`fillBox` 和原始文字 polygon 依次回退，完整 `regionPolygon` 仅作为缺失最终几何时的兼容回退；文字层保留原始文字 polygon，区域 polygon 只保留背景识别语义。
- 更新 seam 原子渲染回归，明确断言蓝框、文字 polygon 和区域 polygon 互不替代。完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `476/476`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（收紧气泡蓝框与实际遮盖范围）

- 定位“蓝框扩展过大”为两条高置信度气泡特例共同造成：显示几何直接采用几乎整个 `region_box`，纯色填充又采用完整气泡区域；单句 110×40 的文字框因此可被放大到约 302×185，嵌入图片模式也会按大框填充。
- 移除整气泡铺满特例。最终蓝框现统一取 OCR 文字框并集，只保留约 2–4px 的受限留边，并由气泡区域裁剪边界；`region_box` / `region_polygon` 继续用于区域归属、背景类型和颜色判断，不再决定蓝框或填充面积。
- DOM 覆盖、复杂背景修复蒙版和嵌入图片纯色填充现在都跟随同一个最终蓝框。新增/更新回归锁定高置信度单句气泡不得回退为完整气泡范围，同时保留多行、斜排、跨页和背景判断行为。
- 完整自动验证通过：文件长度门禁、JavaScript lint、Python lint `10.00/10`、扩展构建、Node `476/476`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（统一蓝框清理并排除衣服英文误遮）

- 使用 Chrome 现场复核当前 Kakao 页面：衣服上的 `NICT` 只有红色 raw OCR 框、没有蓝色 final 框，却已出现在清理图中；普通复杂背景译文节点的初始几何是蓝框，但 `syncOverlayPosition()` 随后用 raw polygon 将同一个节点缩回红框；服务端还对 supplemental 蓝框执行 2–8px 二次膨胀。这三条链路分别对应“误遮衣服英文”“仍按红框覆盖”“蓝框外继续扩张”。
- DOM 覆盖层重新拆分为两个同源节点：无文字的 cover 节点固定使用 canonical 最终蓝框，清理图/实色背景只绘制在该节点；text 节点继续使用原始 polygon 做角度、位置和字体拟合，但强制透明背景。普通页面与 seam 页面共用 `createBubbleRenderNodes()`，避免 cover 再被文字 polygon 或溢出拟合改变。
- OCR 服务在收到有效最终 `cleanedMasks` 时将其视为权威清理范围：不再混入 raw OCR 多边形，也不再对蓝框二次膨胀；只有缺少最终 mask 的首轮兼容路径才保留原始 OCR 的 2–8px 膨胀。因此像 `NICT` 这类只有红框、被最终候选过滤掉的服装文字不会进入最终清理图。
- 新增回归覆盖蓝框/文字层分离、seam 共用路径、蓝框像素边界不膨胀、最终 mask 排除 provisional raw OCR。自动验证通过：文件长度门禁、ESLint、扩展构建、Node `476/476`、Pylint `10.00/10`、Python `58 passed, 1 skipped`。本地 OCR 服务已重启，`/health` 返回 `ok=true`、`device=gpu:0`、`cuda=true`；新扩展已写入 `dist/extension/`。

## 2026-07-16 - Codex（复杂背景清理改用最终蓝框）

- 根据“单句只覆盖红框、边缘笔画残留”的现象复核清理链路：红框是原始 OCR 字形多边形，蓝框是合并、留边后的最终 canonical 投影。此前普通单页复杂背景只把红框交给修复服务，蓝框补充蒙版仅限跨页文本，因此单句外围线条可能没有进入清理范围。
- `buildCanonicalCleanMasks()` 现为每个启用且 `bgType=none` 的投影生成最终蓝框百分比蒙版，不再要求 canonical 必须跨页；实色气泡仍走可靠气泡区域填充。清理几何与译文 placement 保持分离，因此只扩大原文清除范围，不会放大或移动译文排版。
- 清理产物键继续包含归一化蒙版：后续 seam 证据没有改变蓝框时复用已有清理图，蓝框变化时仍会生成不同产物键。新增/更新回归覆盖“原始红框小于蓝框时使用完整蓝框”和“相同蓝框不重复刷新”。
- 自动验证通过：文件长度门禁、ESLint、扩展构建、定向测试 `10/10`、Node `475/475`、Pylint `10.00/10`、Python `58 passed, 1 skipped`；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（修复 OCR 调试布尔值被当作会话对象）

- 根据现场错误 `Cannot create property 'dedupedItems' on boolean 'true'` 定位到 Local Paddle OCR 聚类：`buildLocalPaddleBubbleItems()` 同时接收调试开关布尔值和可写 `ocrDebug` 会话，但聚类调用只传了布尔值；开启“OCR 调试”后，聚类器会向 `true.dedupedItems` 写值并中止 OCR。
- 将聚类器契约拆分为 `debugEnabled` 与 `ocrDebug`，布尔值仅控制噪声保留及控制台日志，会话对象单独承载 `dedupedItems`、`lineItems`、`duplicateItems`；保留直接诊断入口对旧对象参数的兼容。
- 新增“调试开关为 true + 可写调试会话”回归，锁定真实浏览器失败路径。红/蓝框仍只由“OCR 调试”控制：关闭该开关只隐藏诊断框，不会关闭 OCR。
- 验证通过：文件长度门禁、ESLint、扩展构建、定向测试 `13/13`、Node `475/475`、Python `58 passed, 1 skipped`；新产物已写入 `dist/extension/`。

## 2026-07-16 - Codex（以 e93b783 恢复翻译模式与旧版渲染质量）

- 用户纠正重构前基线为 `e93b78374406e61a8e2ea8eeeb8d4e5f47b8ee5f`。对比确认旧版有两种渲染方式（DOM 覆盖、嵌入图片）和三种翻译模式（手动、当前位置及后续 6 张、连续到章节末尾）；新配置模型和调度器仍支持三种翻译模式，但重构后的 popup 丢失了选择入口。
- Chrome 现场确认视觉回归不是 OCR 或译文内容问题：统一 RenderScene 把同一个气泡拆成独立 cover/text 节点，两者使用不同几何；DOM 文本直接采用 scene 字号，绕过旧版实测缩字、原文字高上限和溢出恢复，造成白色遮盖块与译文错位、36–48px 异常大字。
- 保留新 OCR → canonical → translation 链路，恢复 e93b783 的渲染行为：普通页面使用单气泡节点同时完成遮盖与译文；DOM 通过隐藏测量节点二分拟合字号，并以原文字高限制放大；确有溢出时扩展气泡及实色填充；跨页 seam 在固定合并画布坐标中拟合一次，滚动缩放时只变换整体；嵌入模式恢复 Canvas 自动换行、二分字号拟合、旋转、区域裁剪和背景填充。
- popup 恢复“翻译模式”选择器及状态说明，保存到现有 `mt_runtime_config_v1.pretranslateMode`，保持手动按钮、领先 6 张和连续到章节末尾三种行为。
- 自动验证通过：文件长度门禁、ESLint、Pylint `10.00/10`、扩展构建、Node `474/474`、Python `58 passed, 1 skipped`；构建产物已更新到 `dist/extension/`。Python 沙箱内首次运行因无权读取用户 PaddleOCR 模型缓存失败，允许访问既有本机模型后同一套测试全绿。

## 2026-07-16 - Codex（修复浏览器计时器 Illegal invocation）

- 在当前 Kakao 漫画页现场复现 `翻译失败：Illegal invocation`：悬浮按钮与 OCR 总开关正常，错误发生在 canonical pipeline 首次为页面抓取设置超时保护时。
- 根因是 canonical setup 将 `globalThis.setTimeout` / `globalThis.clearTimeout` 取出后作为普通函数调用；Chromium 的 Window 原生计时器要求保留 Window receiver，因此 Node 测试正常而浏览器抛出 `Illegal invocation`。默认计时器现统一绑定 `globalThis`，canonical deadline 和边缘重试共用安全包装；显式注入的测试计时器保持原协议。
- 新增浏览器 receiver 回归，旧实现会稳定触发同名异常。文件长度门禁、ESLint、Pylint `10.00/10`、扩展构建、Node `474/474`、Python `58 passed, 1 skipped` 均通过；构建产物已更新到 `dist/extension/`。

## 2026-07-16 - Codex（修复 canonical Store 初始化顺序）

- 根据页面错误 `Cannot read properties of null (reading 'getRetryState')` 定位到初始化顺序回归：`reader-api` 在创建 canonical Store 之前就构造了重试调度器；同时 canonical pipeline 因缺少外部 Store 静默创建了自己的 Store，造成内容运行时与流水线持有两套状态。
- 调整为先创建并保存唯一的 canonical Store，再将同一实例注入重试调度器和 canonical pipeline；重试调度器在构造期校验四个 retry-state 方法，使依赖缺失立即暴露，不再延迟到用户点击翻译后才崩溃。
- 新增运行时同实例回归与空 Store 构造失败回归。文件长度门禁、ESLint、扩展构建和 Node `473/473` 均通过；本轮已有 Python `58 passed, 1 skipped`、Pylint `10.00/10` 结果保持通过，构建产物已更新到 `dist/extension/`。

## 2026-07-16 - Codex（恢复手动翻译页面反馈）

- 现场确认本地 OCR 服务与扩展总开关均已开启；首次“点击无反应”的直接原因是重新加载扩展后漫画页仍保留失效的旧 content script，控制台明确记录 `Extension context invalidated`，旧悬浮球仍可见却无法向后台发送 OCR 请求。
- 修复新架构的静默失败回归：悬浮球旁新增页面内状态提示，手动翻译失败直接展示首个真实错误；扩展热重载失效时提示“请刷新漫画页”，无可见目标、全部目标因滚动失效、成功完成分别给出明确结果，不再只恢复为“译”而没有说明。
- 手动批处理结果新增 `skippedCount` / `skippedReasons`，区分失败与可重试跳过；错误结果同时写入控制台，后台状态保留原有汇总，便于页面与弹窗两条诊断路径一致追踪。
- 新增反馈文案与样式回归；文件长度门禁、ESLint、扩展构建、Node `471/471`、Python `58 passed, 1 skipped` 均通过。沙箱内 Python 实图用例因 Paddle 模型目录权限失败，允许访问本机模型缓存后复跑全绿；新构建已写入 `dist/extension/`。

## 2026-07-16 - Codex（修复 canonical 翻译 provider 误接线）

- 以 `419bea3` 为基线在现有 Kakao 漫画页复现不可用问题：扩展与悬浮球均已加载，但 canonical 刷新持续报 `Translation response omitted 3 item(s)`，页面无法生成译文。
- 根因是 translation provider 注册表把 canonical 批量翻译误接到旧的图片块翻译函数；该函数返回 `Map`，而 canonical 链路要求保留请求 ID 的数组，因此所有返回项都被判定为漏译。
- 将 OpenAI-compatible canonical 批量请求命名为独立的 `requestOpenAICompatibleCanonicalTranslationBatch`，provider 明确调用该接口；配置层的 `requestCanonicalTranslationBatch` 继续只负责 provider 选择、配置校验和测试 hook，避免同名覆盖再次混淆协议。
- 新增真实配置包装器回归，锁定 provider 返回 canonical ID 数组的契约；文件长度门禁、ESLint、构建、Node `469/469`、Python `58 passed, 1 skipped` 均通过，`/health` 返回 `ok=true`、`device=gpu:0`、`ocrGeometryVersion=detect-crop-recognize-appearance-layout-v2`。
- 新构建已写入 `dist/extension/`。浏览器安全策略禁止自动操作 `edge://extensions/`，需要用户手动重载该目录后刷新漫画页，才能完成新版现场复核。

## 2026-07-16 - Codex（完成 OCR / 翻译 / 渲染统一架构）

- 在用户后续重构提交之上继续完成迁移，不回退既有提交；旧仓库继续保留，当前唯一开发与构建目录为 `C:\homework\translator`，Chrome 唯一加载目录为 `dist/extension/`。
- OCR、翻译和运行时配置继续使用 `mt_ocr_config_v1`、`mt_translation_config_v1`、`mt_runtime_config_v1` 三个独立存储；删除生产代码中的组合 provider 和 `TRANSLATE_DATA_URL`，页面固定执行 OCR → canonical → 文本翻译。恢复遗漏的 OCR 安全缓存序列化，使清理图仅作为易失产物刷新，Observation 与翻译缓存彼此独立。
- 建立统一 `RenderScene`：page/composite 共用 scene builder，DOM 与 embedded renderer 消费同一 placement；cover 使用完整清理区域，text 使用不可变 crop 几何。删除旧字体拟合、溢出扩张、跨页专用排版及重复 canvas/DOM 字号计算路径；无法容纳时返回 `layout_unfit` 并保留原文。
- 斜排与竖排依据 polygon 文字轴、法向厚度及 `lineThickness` 中位数布局；竖排将检测长轴换算为文字倾角，可靠角度限制为 ±25°。低置信度清理区域不得扩大译文 placement，翻译长度不得改变几何。
- Python OCR 模块从机械编号的 `ocr_service/generated/mNN_*` 重命名为 `ocr_service/pipeline/` 下的职责文件；生产 legacy pipeline bridge 删除，兼容 factory 只保留在 `tests/helpers/`。删除一次性拆分/重命名脚本，生产 JS/Python 继续执行 400 行、入口 120 行门禁。
- OCR 外观/布局契约升级为 `detect-crop-recognize-appearance-layout-v2`，坐标模型升级为 `crop-source-transform-v2`；翻译提示版本保持不变，因此旧 OCR 几何缓存自动失效而翻译提示缓存边界不变。
- 修正 `verify` 对嵌套 npm 命令的依赖，改为 Node 编排器；`npm run verify` 与 `pnpm run verify` 均执行同一套长度门禁、lint、构建和测试。
- 自动验证通过：文件长度门禁通过；ESLint 通过；Pylint `10.00/10`；扩展构建成功；Node `468/468`；Python `58 passed, 1 skipped`。
- 重启本地 OCR 服务后 `/health` 返回 `ok=true`、`device=gpu:0`、`ocrGeometryVersion=detect-crop-recognize-appearance-layout-v2`。浏览器扩展管理页属于受保护 URL，自动控制无法替用户点击重载；需用户在扩展页手动重载 `dist/extension/` 后再继续普通漫画页的现场检查。
- 为避免与旧版扩展混淆，将扩展、弹窗和术语库标题统一为 `Manga OCR Translator · Next` / `漫画 OCR 翻译器 · Next`，版本提升为 `1.1.0`。使用内置 imagegen 生成紫色漫画气泡、青色 OCR 取景角与翻译箭头组合图标，移除色键背景后输出 16/32/48/128px PNG 并接入 manifest。
- 根据工具栏实机反馈，将透明底图标调整为高饱和绿色渐变圆角底板并增加深绿色边线；四角仍保留透明像素，16px 下形成完整醒目色块，主体气泡和 OCR 取景标记不变。

## 2026-07-16 - Codex (清理 legacy pipeline 死代码)

- 从 content 模块中移除所有 `kakaoLegacyPipeline` 死代码引用：
  - `recognition-workflow.js`：删除 canonical→legacy 回退块（3 处），`kakaoLegacyPipeline` 已被 `completeContentRuntime` 设为 `null`，回退永不执行
  - `reader-api.js`：删除 `kakaoLegacyPipeline` 构造（~30 行）及 `|| runtime.kakaoLegacyPipeline` 回退逻辑；测试 API 中移除 `kakaoLegacyPipeline` getter
  - `configure.js`：删除 `runtime.kakaoLegacyPipeline = null` 赋值
- 重命名 `removeLegacySeamCrossPageOverlays` → `removeSeamCrossPageOverlays`：该函数仍被 canonical seam 渲染链路使用（`scene-crosspage.js`、`lifecycle-font-fit.js`、`renderer-overlay.js`），"Legacy" 前缀有误导性
- `pipeline-factory/pipeline-legacy-*.js` 和 `pipeline-bridge.js` 保留：18 个测试文件通过 `P.createPipeline()` 使用，添加注释说明仅用于测试兼容
- 验证通过：`npm run verify` 全绿（Node 464/464，Python 58/58）

## 2026-07-16 - Codex (小文件合并)

- 将 8 个极小的模块文件（6~78 行）合并到其语义归属的大文件中，减少碎片化：
  - Background：`messages-constants.js`（6 行常量）→ `messages.js`
  - Content：`recognition-constants.js`（14 行）→ `recognition-binding.js`；`reader-store.js`（6 行）→ `reader-api.js`；`preload-sweep.js`（61 行）→ `scheduler.js`；`capture-helpers.js`（48 行）→ `capture-payload.js`
  - Canonical：`pipeline-errors.js`（16 行）→ `constants-fsm.js`
  - Glossary：`glossary-dom.js`（78 行）+ `glossary-startup.js`（6 行）→ `glossary-editor.js`
- 合并后文件总数从 89 减少到 79（Background 28，Content 31，Canonical modules 17+子目录，Glossary 3）
- 所有合并使用 `scripts/merge-small-files.mjs` 处理，保证 UTF-8 编码安全
- 验证通过：`npm run verify` 全绿（Node 464/464，Python 58/58）

## 2026-07-16 - Codex (模块重命名)

- 将所有按行数机械拆分的编号模块重命名为按领域命名的模块（rename-only，不涉及内容合并或逻辑修改）：
  - **Background**：30 个文件从 `01-messages.js` ~ `31-messages.js` 重命名为 `messages.js`、`term-discovery.js`、`ocr-pipeline.js`、`ocr-dispatch.js`、`observation-results.js`、`seam-handling.js`、`capture.js`、`ocr-provider.js`、`vision-ocr.js`、`ocr-clustering.js`、`ocr-styles.js`、`ocr-lines.js`、`ocr-regions.js`、`ocr-cluster-geometry.js`、`ocr-display-geometry.js`、`ocr-item-filter.js`、`ocr-candidates.js`、`baidu-provider.js`、`baidu-results.js`、`translation-provider.js`、`translation-helpers.js`、`translation-coalesce.js`、`translation-utils.js`、`platform-cache.js`、`platform-settings.js`、`platform-storage.js`、`background-state.js`、`bootstrap.js`、`messages-constants.js`
  - **Content**：35 个文件重命名为 `reader-init.js`、`reader-observers.js`、`reader-state.js`、`reader-store.js`、`reader-api.js`、`reader-startup.js`、`scheduler.js`、`preload-sweep.js`、`recognition-workflow.js`、`recognition-payload.js`、`recognition-binding.js`、`recognition-seam.js`、`recognition-stitch.js`、`recognition-overlap.js`、`recognition-constants.js`、`capture-payload.js`、`capture-helpers.js`、`scene-projection.js`、`scene-crosspage.js`、`scene-dispatch.js`、`renderer-overlay.js`、`renderer-embed.js`、`renderer-canvas.js`、`lifecycle-bubble.js`、`lifecycle-position.js`、`lifecycle-font-fit.js`、`lifecycle-restore.js`、`controls-ui.js`、`controls-autotranslate.js`、`controls-utils.js`、`target-filter.js`、`target-resolve.js`、`target-cache.js`、`platform-runtime.js`、`platform-dom.js`
  - **Canonical modules**：19 个文件重命名为 `stitch-geometry.js` ~ `pipeline-api.js`，bridge 文件更新子目录 import
  - **Canonical sub-directories**（保留目录结构，仅重命名文件）：`reconciler-modules/` 11 个、`pipeline-factory/` 2 个、`canonical-pipeline-factory/` 5 个、`page-store-factory/` 3 个
  - **Glossary**：5 个文件重命名为 `glossary-editor.js` ~ `glossary-startup.js`
- 所有重命名使用 `git mv` 保留历史，安装函数名同步更新
- 使用 Node.js 脚本（`scripts/rename-modules.mjs`、`scripts/rename-subdirs.mjs`）处理重命名和函数名替换，避免 PowerShell 编码问题
- 验证通过：`npm run verify` 全绿（line gate + ESLint + Pylint 10.00/10 + Build + Node 464/464 + Python 58/58）

## 2026-07-16 - Codex

- 完成旧根目录文件清理：删除 `background.js`、`content.js`、`kakao-pipeline.js`、`kakao-reconciler.js`、`popup.js`、`glossary*.js`、`term-discovery-core.js` 及相关 HTML/CSS/manifest 根目录副本。删除旧 `src/` 目录、`core/` 目录和 `scripts/sync-to-root.mjs`。
- 更新 `.gitignore`：不再忽略 `CLAUDE.md` 和 `operations-log.md`；显式排除 `glossary.db` 和 `local-ocr-service/glossary.db`；移除 `image/`、`mobile-userscript/`、`docs/` 等已废弃条目。
- 更新 `scripts/build-extension.mjs`：改用 esbuild `context` API 支持 `npm run dev` 的 `--watch` 文件监听模式；构建配置统一为数组驱动而非 for-of 循环。
- 修正 `tests/overlay_style.test.mjs`：源码断言从已删除的根 `content.js` 改为读取 `extension/src/content/modules/` 下的模块文件。
- 修正 `tests/kakao_pipeline.part01.test.mjs`：build 脚本断言匹配新的构建配置模式。
- 更新 `README.md`：完整重写以反映新的目录结构、配置拆分、provider 接口、几何契约和验证命令。
- 验证通过：文件行数门禁、ESLint、Python Pylint（10.00/10）、esbuild 构建、Node 464/464、Python 58/58（1 skip）。`npm run verify` 全绿。

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
