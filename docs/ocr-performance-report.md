# 漫画翻译慢：成因定位与提速改造记录（2026-09-21）

本文件记录本次「漫画翻译感觉太慢」的定位过程、实测数据、已落地的改造，以及怎么复测。
所有数字都在本机（GPU PaddleOCR，`gpu:0`）用 `tests/fixtures/visual/kakao_solid_bubble.png`
（真实 Kakao 截图，`lang=auto`，`mode=fast`）测得。

## 1. 定位到的成因（按影响排序）

| # | 成因 | 代码位置 | 证据 |
|---|---|---|---|
| 1 | OCR 服务用一把全局 `asyncio.Lock` 包住整个 `run_ocr`：推理之外的解码、裁剪、外观分析、debug 写盘全部被串行化 | `ocr_service/pipeline/api_handlers.py`（改造前） | 已改为只锁 predict，见 §3 |
| 2 | debug 产物默认开启：每页写 3 张整页 PNG（input / plugin_input / vis）+ result JSON，且发生在锁内 | `debug_artifacts.py`、`LOCAL_OCR_DEBUG_ALWAYS` 缺省 `'1'` | 历史产物时间戳：1MB 图每次 PNG 编码 279~374ms，单页 0.6~0.9s；`.local-data/debug` 9197 文件 2.36GB、`debug-ocr` 2133 文件 1.10GB |
| 3 | `lang=auto` 对每个 crop 跑 japan + korean 两遍识别；竖排 crop 再 ×2 方向 | `crop_recognition.py` | 实测 `recognize` + `recognizeSecondLang` + `recognizeRetry` ≈ 60~100ms/页 |
| 4 | 触边 canonical 被扣住不翻译，等邻页 seam，最坏等满超时（原 8000ms） | `canonical-translate.js` / `canonical-seam-ocr.js` / `reader-api.js` | 6 个 kakao pipeline 测试在守这个契约，见 §4 |
| 5 | 漫画翻译没有流式：整批 LLM 返回后才渲染（网页翻译早就有流式） | `ocr-pipeline.js` 只对 `mode==="webpage"` 开 partial push | 见 §4 的开关 |
| 6 | 每页翻译前逐个气泡 `await getCache()`：30 个气泡 = 30 次 storage 往返 | `translation-provider.js`（改造前） | 已改批量读取，见 §3 |
| 7 | 服务冷启动：第一个 OCR 请求要加载 det + rec 模型 | `paddle_provider.py` 懒加载 | 实测首请求 `detectPrimary` 最大 10163ms、单请求 totalMs p95 16911ms |

## 2. 优化后的实测基线（debug 关闭，预热后）

| 阶段 | p50 | p95 |
|---|---:|---:|
| 客户端整请求 wall | 634ms | 887ms |
| appearance（外观/背景判定） | 217ms | 235ms |
| predict（Paddle 推理占用） | 186ms | 358ms |
| crops（透视裁剪 + 方向） | 132ms | 195ms |
| detectRecovery（宽松检测） | 94ms | 104ms |
| detectPrimary（主检测） | 77ms | 230ms |
| recognize / SecondLang / Retry | 11 / 23 / 27ms | 20 / 24 / 40ms |
| decode（base64 解码） | 4ms | 6ms |

- **`appearance` 现在是最大单项**（>推理），是下一步优化的首选目标。
- 并发 3 页：整批 1435ms（串行估计 1902ms，加速比 1.33），单请求 p50 从 634ms 升到 1205ms，
  `queueWait` p95 = 258ms。加速比偏低的原因：剩余工作里相当一部分是 Python/GIL 侧
  （PIL 画图、纯 Python 循环），且推理本身按设计串行。
- debug 开关 A/B（同一张图、同一进程）：

| | wall p50 | debugArtifacts |
|---|---:|---:|
| debug 关闭 | 634ms | — |
| debug 打开 | 943ms | 146ms |

改造前同一张图的 debug 开销约 0.6~0.9s（3 张 PNG）；现在只剩 1 张 PNG + 1 张 JPEG + JSON，
即 §3 的 1.2 把 debug 开销压掉了约 4/5。

## 3. 已落地的改造

**OCR 服务（Python）**

- `pipeline/request_timings.py`（新）：单请求分阶段计时（毫秒），最近 200 次环形缓冲 + p50/p95。
- `GET /ocr/timings`：返回最近请求的分阶段统计与最后一条明细（`api_handlers.ocr_timings`）。
- `pipeline/predict_guard.py`（新）：只有 `client.predict()` 走信号量（`LOCAL_OCR_PREDICT_CONCURRENCY`，
  默认 1），并记录 `queueWait` / `predict`；其余工作不再串行。
- debug 产物默认关闭（`LOCAL_OCR_DEBUG_ALWAYS` 缺省 `0`）；开启时原图只写一份、可视化改 JPEG
  （`LOCAL_OCR_DEBUG_VIS_FORMAT=png` 可回退）；写盘已不在推理锁内。
- 可选开关（默认保持改造前行为，需显式打开）：
  - `LOCAL_OCR_AUTO_LANG_SECOND_PASS=0`：只对可疑 crop 补第二语言（整页都弱则仍补整页）。
  - `LOCAL_OCR_RECOVERY_DETECT=on-demand`：主检测足够多时跳过宽松检测。
  - `LOCAL_OCR_CLEANED_IMAGE_FORMAT=jpeg`：清理图改 JPEG（seam 请求回传体积更小）。

**扩展**

- `background/modules/ocr-timings.js`（新）：把服务端分阶段耗时与扩展侧总耗时接到一条日志
  `[MangaTranslator][ocr-timing]`，控制台可用 `__mtOcrTimings()` 看汇总。
- `background/modules/translation-cache-lookup.js`（新）+ `platform-cache.getCacheMany`：一次批量读取代逐条读。
- `content/modules/recognition-workflow.js`：`[MangaTranslator][timing]` 增加 `unaccountedMs`
  （墙钟总时长 − 各阶段之和），边缘等待/服务排队会直接体现在这里。
- `reader-api.js`：边缘等待兜底超时 8000ms → 3000ms。
- 两个新的 runtime 配置键（默认都关闭，`mt_runtime_config_v1`）：
  - `edgeTranslateWithoutWaiting`：邻页没有进度时不再扣住触边 canonical（首屏更快，
    代价是 seam 之后确实合并的句子会多一次翻译）。
  - `comicStreamingEnabled`：漫画流式渲染（`COMIC_TRANSLATION_PARTIAL` → `renderSettled`）。
  打开方式（改完刷新页面）：
  ```js
  chrome.storage.local.get('mt_runtime_config_v1', c => chrome.storage.local.set({
    mt_runtime_config_v1: { ...c.mt_runtime_config_v1, edgeTranslateWithoutWaiting: true }
  }))
  ```

## 4. 刻意没有改的

- **触边 canonical 的等待契约**：6 个 kakao pipeline 测试（"edge candidates wait"、
  "a multi-fragment seam requests one canonical translation"、"keeps exactly one prior visible projection" 等）
  明确要求「触边文字等 seam 合并后再翻译一次」。激进策略（立即翻译）会打破它们，
  因此改成默认关闭的开关 + 只下调超时。
- **`MAX_PARALLEL_TRANSLATIONS`（非 Kakao 3 → 6）**：实测并发 3 时单请求 p50 已经从 634ms 升到
  1205ms，说明瓶颈是推理槽位与 GIL，而不是队列并行度；在没有实测收益前不动默认值。
- 未做：OCR 服务多进程 / 多 worker（显存与内存 ×N）；未引入新依赖。

## 5. 怎么复测

```bash
# 1) 重启本地 OCR 服务（Python 改动必须重启；uvicorn 没有 reload）
start_local_ocr_gpu.bat

# 2) 单页分阶段基线（debug 关闭 vs 打开）
python tools/bench_ocr_timings.py --input tests/fixtures/visual --repeat 3
python tools/bench_ocr_timings.py --input tests/fixtures/visual --repeat 3 --debug

# 3) 并发（验证推理槽位排队而不是整条链路串行）
python tools/bench_ocr_timings.py --input tests/fixtures/visual --concurrency 3

# 4) 看服务端最近请求的分阶段 p50/p95
curl http://127.0.0.1:8765/ocr/timings
```

浏览器侧：打开漫画页 → 翻译一页，控制台看 `[MangaTranslator][timing]` 的 `unaccountedMs`
（大 = 在等 OCR 排队或 seam），以及 `[MangaTranslator][ocr-timing]` 的 `top` 阶段。

---

# 第二轮（同日稍晚）：从「OCR 慢」转到「追不上滚动」

## 6. 现场证据：慢的不是 OCR，是「你到了它还没翻」

在打开的 Kakao 长图页（194 片）实测 DOM：

| 观察 | 值 |
|---|---|
| 视口内切片 | 2 片，已翻译 **0** 片 |
| 视口前方 162 片 | 只有 2 片已翻译（在 +8~9 片处） |
| 译文覆盖层位置 | 集中在 y≈20.8k–24.6k，比当前视口（28.9k）**低 4~8 片** |
| 服务端 | 同时段仍在正常收请求（OCR 45→84，最近一次落库距今 14s） |

结论：服务是活的、翻译在产出，但**产出速度跟不上滚动速度**，所以「看得见的地方没有译文」。

## 7. 三个根因与对应改动

### 7.1 领先预翻译的并发被压到 1（主因）

`reader-state.js` 里 Kakao 的可见保留槽位是 `MAX_PARALLEL_TRANSLATIONS - 1 = 5`，
于是 `scheduler.js:canStartQueuedTranslation` 要求 `runningAheadJobs < 6 - 5 = 1`：
「领先 6 张」实际只是**排队 6 张、同时只跑 1 张**，单片 10~20s，而滚动 3~5s/片，必然越落越远。

- 保留槽位改为 **3**（领先可用 3 个），注释写明原约束（本地 OCR 全局锁）已不存在。
- 领先张数提为配置项 `pretranslateAheadCount`（默认 6，夹 1~12），设置页「翻译策略」新增输入框。
- 新增 `pruneStaleAheadTranslations()`：滚到视口上方的领先排队任务直接丢弃，不再花 OCR/LLM 额度。
- 新增 `visibleQueueOutnumbersFreeSlots()`：可见页在队列里等槽位时，不再派发新的领先任务。

### 7.2 渲染 bug：翻译好了也不显示

`crosspage-cover.js` 调用 `runtime.mapCompositePointToRoot`，但 `scene-crosspage.js` **从未把它挂到 runtime**
（浏览器控制台现场报 `runtime.mapCompositePointToRoot is not a function`，2 次 + 1 次未处理 rejection）。
同类问题还有 `runtime.removeCrossPageSurfaceEntry`（`crosspage-lifecycle.js` 三处调用，`renderer-crosspage.js` 没导出）
和 `runtime.requestOpenAICompatibleVision`（`vision-ocr.js` 调用，全仓库无实现）——共 3 个「只调用、没挂载」的入口。

- 三处全部补齐；跨页遮罩映射缺失时退回「不倾斜」而不是抛错。
- 跨页渲染单个气泡失败只降级该气泡（原来抛出去会让整页一起消失）。
- 新增 `tests/runtime_call_sites.test.mjs`：静态扫描 `extension/src`，**每个 `runtime.x(` 调用点都必须有挂载点**，
  白名单只放 `chrome.runtime.*`。这类 bug 之前只会在渲染时静默失效，构建期抓不到。

### 7.3 渲染前的一串串行等待

- LLM 返回后原先每个气泡 `await setCache`（N 次串行 storage 写）→ 改 `setCacheMany()` 一次写完，
  并且**不再挡渲染**（先 resolve，写入后台批量进行）。
- 官方译文库提交（配置指纹往返 + HTTP + IndexedDB 写）原先在返回前 await → 改为后台提交，
  失败仍走 pending 队列；`pending` 标记改由后续同步补。
- 旧的按块翻译批次移到 `translation-block-batch.js`（顺带把逐条缓存读改成一次 `getCacheMany`），
  `translation-provider.js` 因此从 404 行回到 339 行（行数门禁 400）。

## 8. OCR 服务侧（第二轮）

- **det 与 rec 分开占槽**：原来一把 `predict_guard` 把检测与识别串在一起，后到的请求排队
  （`queueWait` p95 230ms）。现在是 `predict_guard('det')` / `predict_guard('rec')` 两把独立槽位，
  检测与识别可以重叠；阶段名拆成 `predictDet/predictRec`、`queueWaitDet/queueWaitRec`。
- **启动预热**：模型是懒加载的，首个真实请求要等 ~10s（实测首请求 `detectPrimary` 10.1s、
  `totalMs` p95 16.9s）。现在 lifespan 里起后台线程预热 det + japan/korean 识别模型，
  实测预热耗时 18.6s **不阻塞端口**，`/health` 的 `warmup` 字段可查。
  `LOCAL_OCR_DISABLE_WARMUP=1` 可关闭（A/B 与 CI 用）。
- **计时口径修正**：`predict*` 打在 `detect*`/`recognize*` 作用域内部，原先 `unaccountedMs`
  把它们重复计入，导致永远被夹成 0；现在按「非嵌套阶段」求和。

## 9. 测量警告（重要）

第二轮改动**不能**用当时的绝对延迟做前后对比：同一张 fixture、同一台机器，

| 指标 | 第一轮测量 | 第二轮测量 |
|---|---:|---:|
| 客户端整请求 | 634ms | 2030~2120ms |
| 纯 base64 解码（与本次改动无关） | 4.5ms | 26.1~27.9ms |
| appearance | 217ms | 792ms |

而**没有跑第二轮代码**的长期实例（8765）在同一时刻复现了同样的数字
（`decode 27.9ms / crops 499.5ms / appearance 792.7ms / total 2364.9ms`）——
CPU 是 i9-13900HX，`CurrentClockSpeed` 停在 2200MHz（基频），第一轮测量时显然在睿频。
所以这是整机 CPU 状态差异，不是代码回归。**以后比较延迟必须同时记录 CPU 当前频率**，
或者只在同一次会话内做 A/B。

## 10. 这一轮你还需要做

1. **重启本地 OCR 服务**（第二轮 Python 改动：det/rec 分槽、预热、计时口径）。启动日志里会看到
   `[local-ocr] warmup {'ok': True, ...}`。
2. **重载扩展**（`dist/extension` 已重建：渲染 bug 修复、领先并发、领先张数输入框、缓存批量写）。
3. 重载后**重新加载漫画页**（旧页面里的 content script 在扩展重载后已失效），然后点一次悬浮球。
   也可以在设置页把「领先张数」从 6 调到 8~10——并发放开之后，窗口越深越不容易被追上。

## 11. 复测清单（第二轮）

```powershell
# 服务侧：确认预热 + det/rec 分槽生效
curl http://127.0.0.1:8765/health          # 看 warmup
curl http://127.0.0.1:8765/ocr/timings     # 看 predictDet / predictRec / queueWaitDet / queueWaitRec

# 页面侧（重载扩展 + 重新加载页面、点一次悬浮球后）：
#   在漫画页控制台执行，看视口内命中率
Array.from(document.querySelectorAll("[data-mt-last-translated-key]")).filter(n => {
  const r = n.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}).length
```

目标：连续滚动 30 片，视口内命中率 ≥ 90%（修复前约 0~10%）。

---

# 第三轮（同日 21:47 起）：漫画译文被截尾事故

## 12. 现象与证据

用户反馈：可视区识别出很多文字，最后只呈现「游乐设施」二字。

同一条原文在官方译文库里的版本历史（`translation_versions`，同一个 record）：

| 原文 | 20:32（旧构建） | 21:47 起（上一轮构建） |
|---|---|---|
| `'좋아, 바로'` | 20:35 `好,马上` | 21:47 / 22:12 / 22:22 三次都是 `好,` |
| `'어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.'` | 20:32 `听说游乐设施指南里包含这个主题公园的相关内容。` | 21:47 `游乐设施` |

两条都是**同一个 record 的旧版本完整、新版本被截尾**，而新版本被设为启用版本 → 页面显示截尾值。

## 13. 根因（三条）

1. **漫画被切到供应商流式请求（本项目的回归）**：上一轮把 partial 推送放宽成
   `mode === "comic" && !!taskId`，并在 `canonical-translate.js` 传了 `taskId: runId`，
   于是 `onRow` 非空 → `requestOpenAICompatibleCanonicalTranslationBatch` 走
   `streamCanonicalTranslationBatch`（请求体加 `stream: true`）。网页一直走这条路，
   漫画从这一轮开始才走，而这条路上的返回值被截尾。
   `comicStreamingEnabled` 只挡住了**渲染**，没挡住**请求路径**——「默认关闭」名不副实。
2. **流式行提取器有并发缺陷**：`shared/translation-row-stream.js` 的 `ROW_PATTERN` 是模块级
   带 `g` 的正则，多个 extractor 共用它会互相踩 `lastIndex`；Kakao 下最多 6 个批次并发流式，
   会重复/漏行，而下游用 `new Map(rows)` 取后到的那条 → 早到的残值可能压掉完整值。
3. **页面里还有一层「看不见」**：可见的是 `mt-cross-page-overlay`（seam 表面，截尾值）；
   同一句的完整译文在 `mt-overlay-root`（页 OCR 版）里，而那些 root **没有几何尺寸**
   （没有 `left/top/width/height`，`rect = 0×0`，子节点按百分比定位全部塌成 0）。
   即使译文正确也看不见。**待查**：这些 0 尺寸 root 是「本该由 seam 表面接管的 standby」还是「几何没写上去」。

## 14. 已落地的止血（Phase 0）

- **漫画默认不再走流式请求**：内容脚本按 `runtime.comicStreamingEnabled` 显式发
  `streamPartials`，后台只在 `mode === "webpage"` 或显式开启时才传 `onRow`。
  `comicStreamingEnabled` 现在真正只控制开关，且默认关。
- **双层「变短」护栏**（同一套阈值：源 ≥ 4 字、旧译文 ≥ 4 字、新译文 < 旧译文 60%）：
  - 服务端 `translation_store/shrink_guard.py`：自动译文明显变短时**只进历史、不设为启用版本**，
    手动版本永远优先；`TRANSLATION_SHRINK_GUARD=0` 可关。
  - 扩展侧 `shared/translation-shrink.js`：同一判据用于当次渲染——命中时沿用旧译文并打日志，
    不让截尾值上屏。
- **修掉共享正则游标**：`ROW_PATTERN` 改为每个 extractor 实例一把，并加并发用例。

## 15. 怎么恢复那条记录（已执行）

`record 724cf01c…`（原文 `어트랙션 안내에는…`）的启用版本曾被截尾的 `游乐设施` 覆盖。
已通过服务端支持的 `select_version` 操作把 20:32 的完整译文切回启用版本（记录版本号 2 → 3，
两条历史版本都保留）；扩展下次同步就会读到完整译文。

顺手做了一次**全库扫描**（工具：`tools/repair_truncated_translations.py`），
判据与护栏一致并且只修「回归特征」——启用版本是 api 来源、未置顶、比同记录最长版本短于 60%，
且截尾那条是**后写入**的（避免覆盖用户自己的选择）：

| 模式 | 原文 | 被写入的截尾值 | 恢复成 | 写入时间 |
|---|---|---|---|---|
| comic | `'좋아, 바로'` | `好,` | `好,马上` | 09-21 23:54 |
| comic | `'굳이 연락 안할이유라도 있남~?'` | `何必联系` | `有什么特别不联系的理由吗~?` | 08-11 |
| comic | `'오오오! 역시!'` | `哦哦哦!` | `哦哦哦!果然!` | 08-07 |
| novel | `'??: ??'` | `??：??` | `“这是我的属性吗？”` | 09-14 |
| novel | `'그런데, 어? 춤 D-는 좀 심해…'` | `“这，这不公平啊！”` | `但是，嗯？舞蹈D-是不是有点太低了？` | 09-14 |
| novel | `'매니저가 펄쩍 뛰었다…'` | `经纪人吓了一跳。我却无所谓。…` | `经纪人吓了一跳。我却很平静。…` | 09-14 |

**注意**：其中 2 条是 8 月、3 条是 9-14 的旧伤——说明「自动译文被截尾后覆盖完整版本」这件事
在我这轮改动之前就发生过（用户说的「又出现了」是准确的）。所以真正该长期保留的是**写入侧护栏**，
而不是只回退请求路径。修复后全库扫描为 0 条。

## 16. 仍需做（下一轮）

1. ~~**证明流式本身能否用**~~ → 见第 17 节第 3 条（本轮先补原始快照与 A/B 入口）。
2. ~~**查清 `mt-overlay-root` 没有几何的原因**~~ → 见第 17 节第 2 条，已取证：是设计内抑制，
   不是缺几何。
3. **slice 边界把一句话劈成两半**（DB 里能看到 `'다크라이드는 보통'` 与
   `'테마파크의 테마를 설명합니다.'` 是同一句的两半各自翻译）：判断该由 seam 合并、
   还是该在 canonical 层合并跨 slice 的同一句。
   第四轮已落地**遥测**（见第 17 节第 6 条），合并策略待真实阅读一轮的数据再定。
4. ~~复核上一轮「官方库提交改成后台不 await」引入的**提交乱序**风险~~ → 见第 17 节第 4 条。

## 17. 第四轮：缓存代次、护栏加强、隐藏 root 与接缝三重 OCR（2026-09-22 00:2x）

### 1. 真正让「游乐设施」赖着不走的那一层：指纹缓存代次

第 15 节只修了服务端库。但漫画 canonical 的**读路径**是 chrome.storage 里的指纹缓存
（`CANONICAL_TRANSLATION_CACHE_PREFIX`），命中就直接渲染、不再请求模型，而
`CACHE_TTL_MS` 是 **7 天**——所以护栏和官方库修复都救不了浏览器里的旧值。

处置：代次前缀 `mt_cache_v22:translation:` → `mt_cache_v29:translation:`，
并把退役前缀的键真正删掉（`background/modules/translation-cache-generation.js`，
在 `lookupCanonicalTranslationCache` 首次调用时幂等执行一次）。
代价很小：`handleTranslateTextBlocks` 先读官方库（`:166-178`），只有库里没有的源文才会重新请求。

体检入口：service worker 控制台 `__mtCacheAudit()`（退役残留 / 当前代次条数 / 可疑短值采样），
`__mtPruneCache()` 手动触发清理。顺带修掉一个既有缺口：`__mtOcrTimings()` 之前只定义没暴露，
现在由 `bootstrap.js` 显式挂上。

### 2. 「隐藏的 mt-overlay-root」取证结论：是抑制，不是缺陷

现场（`page.kakao.com/content/69229506/viewer/69731856/`，scrollY 43493）：

| 指标 | 值 |
|---|---|
| `.mt-overlay-root` | 18（其中 17 个 `display:none`） |
| `.mt-cross-page-overlay`（接缝面） | 7 |
| 同一 canonical 两种译文（冲突） | **0** |
| 已渲染但「长原文只回几个字」的气泡 | **0** |
| DOM 里有译文、当前不可见的 canonical | 25（其 root 的 target 都在视口外） |

三个机制叠加，逐个排除：

1. **接缝三重 OCR 抑制**（用户观察）：接缝处跑上片、下片、composite 三次 OCR，
   reconciler 只让一份当 `primary`，其余标 `standby`
   （`reconciler-projection-utils.js:99`、`scene-index-resolve.js:204`），
   而 `content/configure.js:38` 在渲染前就把 standby 滤掉——standby 气泡**根本不会进 DOM**。
2. **离屏切片隐藏**：`syncOverlayPosition` 里 target 不在视口 → `display:none`
   （`lifecycle-position.js:109-113`）。这一条解释了那 17 个隐藏 root：它们是**已滚过/未滚到**
   的切片覆盖层，滚回去时会自动恢复显示，不能删。
3. **残留壳复活旧值**（本轮重点怀疑对象）：如果某个 root 在当前 canonical 还是 primary 时建立、
   角色翻转后只是被 `display:none` 藏起来，它里面的旧 `data-translated` 可能在滚回时重新上屏。
   实测**冲突 0**：同一 canonical 在所有 root 与接缝面上的译文完全一致，且没有任何可见气泡
   是截尾形状。所以这个假设**当前不成立**，不做渲染改动，只把排查入口留下：
   页面控制台 `__mtOverlayGeometryReport()`（列出每个 root 的 target/display/内联几何/气泡译文，
   以及接缝面覆盖与 canonical 冲突）。

顺带记录一个**尚未处理的性能观察**：`overlaysById` 随会话内渲染过的切片数增长（本次 18 个），
帧同步会对每个 root 各做一次 `getBoundingClientRect()`；194 片的长章节读久之后这是每帧几十次
布局读取。因为本轮没有测量数据，先记录不改（改法需要 IntersectionObserver 或缓存 rect）。

### 3. 护栏加强：首次译文也要拦

原有护栏只在**有旧值**时比较。事故里的第一次写入没有任何旧值可比（37 字符韩文原句回 4 个字），
截尾值就这样成了启用版本，之后所有「与旧值比较」的判据都失效。

新增判据（JS/Python 同参）：原文 ≥ 12 字符、且译文 ≤ `min(6, floor(原文长度 × 0.15))` 个字符
→ 判为可疑。绝对上限 6 让长原文的合理短译不会被误判。
命中时：扩展侧**不写缓存**（当次仍渲染，代价只有一次重复请求）+ warn 日志；
服务端把候选写成**非激活**版本（`[translation-store] refused implausibly short translation: …`），
不再污染官方库。

### 4. 官方库提交的死代码

见下面第 7 条。

### 5. 流式取证入口

`translation-row-stream.js` 增加原始快照（原始 SSE、逐行提取、最终解析、`finish_reason`、
是否流式），service worker 控制台 `__mtTranslationSnapshots()` 查看、
`__mtStreamAb({ repeat })` 用当前配置的服务商做「非流式 vs 流式」对照。
只有 `repeat ≥ 20`、截尾行 0、且与整批逐行一致，才允许把 `comicStreamingEnabled` 交给用户开关。

### 6. 切片边界「同一句被劈成两半」的遥测

判据做成纯函数 `canonical/modules/split-detector.js`：上片最靠下的一条**没有结句标点**、
下片最靠上的一条**不以引号/括号开头**，且没有任何 canonical 同时落在两页上（跨片即已合并）
→ 记为漏合并。接缝 OCR 完成、canonical 快照刷新后由
`canonical-pipeline-factory/canonical-split-report.js` 输出
`[MangaTranslator][canonical-split]`（两条 canonical id、两段原文、接缝状态与 `shouldRun` 原因），
最近 20 对留档。

据此可以区分三种可能：(a) 接缝 OCR 被跳过（`skipped` 且原因是空的——准入判据没命中）；
(b) 跑了但 reconciler 没合并（阈值）；(c) 合并了但记录口径不一致
（`canonical_fb1d132cbfd52e5268e5998357136072` 的 `raw_source_text` 只存了前缀，而启用译文是整句——
符合「记录按 segmentKey 复用、源文只在创建时写入」的形状）。合并策略待真实数据再定，本轮不动阈值。

### 7. 官方库提交的死代码（已修）

`ocr-pipeline.js` 的 `pendingRecordKeys` 在提交改 fire-and-forget 后从未被填充，
`translations[].pending` 恒为 false，而 `comic-translation-store.js:96` 明明返回了 pending 集合。
现在 IIFE 里接回返回值并在非空时打 `official comic commit queued N record(s) for retry`；
失败的重试仍由 `queuePendingTranslationOperation` 落盘，因此不需要再在内存里镜像一份 pending。
顺序方面无风险：`submitTranslationOperations` 经 `translation-service.js` 的 `writeQueue` 串行，
且各切片提交的是不同 `recordKey`。



