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

