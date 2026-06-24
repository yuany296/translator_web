# KakaoPage 翻译管线 — 问题诊断与修复方案

## 问题概述

三个核心症状，均发生在 KakaoPage 阅读器：

1. **漏页** — 部分漫画页面没有被送入 OCR/翻译，最终无译文覆盖
2. **重复上传** — 拼接模式下同一张图片被上传两次
3. **红蓝调试框对不齐** — 调试覆盖层的高度拉长，与原始漫画文字位置不吻合

---

## 当前代码状态

### 已实现

| 机制 | 位置 (content.js) | 作用 |
|------|-------------------|------|
| `inflightByTarget` WeakMap | :99, :895, :1086, :1082 | 阻止同一 DOM 元素重复翻译 |
| `sourceToken` 追踪 | :459, :472 | `dataset.mtSourceToken` 记录图片身份 |
| DOM 复用清理 | :461-464 | `currentSrc` 变化时清 overlay 和缓存 |
| `mtKakaoAttachedToKey` | :4843 | 标记短页已挂载到 owner |
| 拼接请求键 | :1394 | 含 sourceToken + slice + neighborToken |
| `normalizeDebugCoordinateItems` | :2045-2078 | 过滤非 owner 项 + ownerDraw 映射 |
| 统一映射规则 | :2037-2041 | rawItems/dedupedItems/duplicateItems 同一套映射 |
| 高度校验 | :1853-1866 | 单行 max 35%，多行 max 60%，溢出 max 60% |

### 未实现 / 有缺口

| 缺口 | 严重度 | 位置 |
|------|--------|------|
| **零条诊断日志** — 排查全靠猜 | **P0** | 全局 |
| `mtKakaoAttachedToKey` 仅在设置处检查，其他入队路径未检查 | **P1** | :4789, :4795, :712, :624 |
| 短页挂载到 owner 后若 owner 失败，短页成孤儿 | **P1** | :1057 catch |
| `inflightByTarget` 按 DOM 元素做 key，DOM 复用时返回旧 promise | **P1** | :895 |
| `buildKakaoStitchedPayload` 完全无测试 | P2 | tests/ |
| 无多页集成测试 | P2 | tests/ |
| DOM 复用时未清理 `mtKakaoAttachedToKey`、`mtBoundaryReadyToken`、`kakaoGlobalOcrEntries` | P2 | :461-471 |
| 短页拼接超时无回退机制 | P2 | :4843 |
| 调试框高度异常只丢弃不 clamp | P3 | :1853-1866 |
| `dedupedItems`/`duplicateItems` 坐标映射无测试 | P3 | tests/ |

---

## Phase 0: 诊断基础设施

> **必须先做**。没有数据，所有修复都是猜测。

### 0.1 目标

用结构化 trace 记录每一页经过全部 5 个 pipeline 阶段的完整生命周期，替代零散的 `console.log`。

### 0.2 5 个 Pipeline 阶段

```
collect → queue → stitch → map → dedupe → render
```

### 0.3 Trace 数据结构

每条 trace 记录对应一页在一个阶段的一次事件：

```js
{
  ts: performance.now(),          // 高精度时间戳
  idx: number,                    // 本次 trace 自增序号
  sourceToken: string,            // 图片真实身份 (getQuickSourceToken)
  targetKey: string,              // DOM 节点身份 (computeTargetKey)
  scopedKey: string,              // targetKey + sourceToken 组合键

  stage: "collected" | "queued" | "skipped" | "requested" | "mapped" | "deduped" | "rendered",

  detail: {
    rect: { top, height, width },  // 元素的 bounding rect
    ocrMode: null | "single" | "stitch",

    // skip 相关
    skipReason: null | "alreadyTranslated" | "noText" | "shortPageAttached" | "filterFail" | "screenshot",

    // stitch 相关
    stitchKey: null | string,
    neighbors: [],                 // [prevSourceToken, nextSourceToken]
    stitchRejection: null | string,

    // map / dedupe 相关
    rawBubbleCount: null | number,
    mappedBubbleCount: null | number,
    dedupeRemoved: null | number,

    // 短页附着
    attachedToKey: null | string,  // mtKakaoAttachedToKey 值
  }
}
```

### 0.4 埋点位置

| 阶段 | content.js 位置 | 记录内容 |
|------|----------------|---------|
| `collected` | :491, :627, :1245, :2503, :4863, :4986 | 候选数量、每个候选的 sourceToken |
| `queued` | :4814-4818 | sourceToken + 入队时间 |
| `skipped` | :4795-4811 | **哪个条件触发** + sourceToken |
| `short-attached` | :4843 | 短页 → owner 映射 |
| `requested` | :1389-1407 | stitchKey, neighbors |
| `stitch-rejected` | :1249, :1266, :1295, :1309, :1366 | 拒绝原因 |
| `mapped` | :1768-1878 | 保留/丢弃气泡数 |
| `fallback` | :1649-1651 | dropRatio |
| `deduped` | :2114-2121 | 删除了几个气泡 |
| `inflight-bypass` | :895-896 | 复用 inflight promise |
| `rendered` | :3075 | 最终渲染气泡数 |

### 0.5 开关与导出

```js
// content.js 顶部 — 默认关闭，零性能开销
let ENABLE_PIPELINE_TRACE = false;

function tracePipeline(stage, target, detail = {}) {
  if (!ENABLE_PIPELINE_TRACE) return;
  const arr = globalThis.__MT_PIPELINE_TRACE__
    || (globalThis.__MT_PIPELINE_TRACE__ = []);
  if (arr.length >= 5000) arr.shift(); // FIFO 上限
  const sourceToken = getQuickSourceToken(target);
  const targetKey = computeTargetKey(target);
  arr.push({
    ts: performance.now(),
    idx: arr.length,
    sourceToken,
    targetKey,
    scopedKey: buildTargetSourceCacheKey(targetKey, sourceToken),
    stage,
    detail,
  });
}

// __test 导出
getPipelineTrace: () => globalThis.__MT_PIPELINE_TRACE__ || [],
clearPipelineTrace: () => { globalThis.__MT_PIPELINE_TRACE__ = []; },
```

浏览器中使用：翻页后在 DevTools console 执行：
```js
copy(JSON.stringify(globalThis.__MT_PIPELINE_TRACE__, null, 2))
```

### 0.6 数据分析方法

拿到 trace JSON 后关注以下指标：

1. **漏页检测**：找出所有 `stage: "collected"` 的 sourceToken，检查是否每个都最终到达 `"rendered"`。没有的查 `skipReason`。
2. **重复上传检测**：统计 `stage: "requested"` 的 sourceToken，有重复即为漏洞。
3. **短页孤儿检测**：找 `stage: "short-attached"` 的记录，检查对应 owner 是否成功 `"rendered"`。
4. **stitch 拒绝率**：统计 `stage: "stitch-rejected"` 的拒绝原因分布。

---

## Phase 1: 修复根因（按可能性排序）

### P1-1: 短页孤儿 — 漏页 + 重复上传

**根因**：`maybeQueueKakaoShortPageAttachmentOwner`（:4824）将短页重定向到 owner 并设 `mtKakaoAttachedToKey`。但如果 owner 拼接或翻译失败，短页永远无法独立翻译——每次 `queuePageAutoTranslate` 都会再次被 `maybeQueueKakaoShortPageAttachmentOwner` 拦截。

**修复点和具体改动**：

#### a) 超时回退机制

在 `maybeQueueKakaoShortPageAttachmentOwner` 设置标记处（:4843）：
```js
target.dataset.mtKakaoAttachedToKey = ownerScopedKey;
target.dataset.mtKakaoAttachedToAt = String(Date.now());  // 新增
```

常量（与其他 KAKAO_* 常量放在一起）：
```js
const KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS = 8000;
```

在 `queuePageAutoTranslate`（:4789）的 `maybeQueueKakaoShortPageAttachmentOwner` 调用之后增加：
```js
// 检查 mtKakaoAttachedToKey 是否超时
const attachedAt = Number(target.dataset.mtKakaoAttachedToAt || 0);
if (target.dataset.mtKakaoAttachedToKey && Date.now() - attachedAt > KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS) {
  // 超时回退：清除附着标记，允许独立翻译
  delete target.dataset.mtKakaoAttachedToKey;
  delete target.dataset.mtKakaoAttachedToAt;
  // 不清除 trace —— 记录 fallback 行为
  tracePipeline("skipped", target, { skipReason: "shortPageAttachmentTimeout" });
  // 继续往下走独立翻译流程
}
```

#### b) Owner 失败时清理附属短页

在 `buildKakaoStitchedPayload` 返回的 payload 中增加字段：
```js
// :1395 附近
attachedShortPageKeys: [previousEntry, nextEntry]
  .filter(e => e && e.shortPageAttachment)
  .map(e => e.targetKey),
```

在 `translateTarget` catch 块（:1057）中增加：
```js
// Owner 翻译失败 → 释放附属短页
if (payload && Array.isArray(payload.attachedShortPageKeys)) {
  for (const shortKey of payload.attachedShortPageKeys) {
    const el = findTargetByScopedKey(shortKey);
    if (el) {
      delete el.dataset.mtKakaoAttachedToKey;
      delete el.dataset.mtKakaoAttachedToAt;
    }
  }
}
```

#### c) 其他入队入口统一检查

`queueTranslate`（:712）和 `getAheadTranslationTargets`（:624）在收集/入队前增加 `mtKakaoAttachedToKey` 检查：
```js
if (target.dataset.mtKakaoAttachedToKey) {
  const attachedAt = Number(target.dataset.mtKakaoAttachedToAt || 0);
  if (Date.now() - attachedAt <= KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS) {
    // 仍在超时期限内，等待 owner 完成
    tracePipeline("skipped", target, { skipReason: "shortPageAttached" });
    return;
  }
  // 超时：清除并继续
  delete target.dataset.mtKakaoAttachedToKey;
  delete target.dataset.mtKakaoAttachedToAt;
}
```

---

### P1-2: DOM 节点复用状态残留 — 漏页

**根因**：KakaoPage 虚拟列表会复用 `<img>` 元素，只改 `src` 属性。`registerTarget`（:461-471）在 `currentSrc` 变化时清理了部分状态，但遗漏了关键字段。

**修复**：扩展 :461-471 区域的清理列表：

```js
if (oldSourceToken && oldSourceToken !== sourceToken) {
  const oldTranslatedKey = target.dataset.mtLastTranslatedKey || "";
  if (oldTranslatedKey) {
    state.payloadCacheByTargetKey.delete(oldTranslatedKey);
    state.localResultCache.delete(oldTranslatedKey);
  }
  clearRenderedTarget(target);

  // 原有清理
  delete target.dataset.mtLastTranslatedKey;
  delete target.dataset.mtNoTextKey;
  delete target.dataset.mtRecoveryReqAt;

  // === 新增清理 ===
  delete target.dataset.mtKakaoAttachedToKey;
  delete target.dataset.mtKakaoAttachedToAt;
  delete target.dataset.mtBoundaryReadyToken;
  // ================

  // 清理全局去重条目
  if (oldTranslatedKey) {
    state.kakaoGlobalOcrEntries.delete(oldTranslatedKey);
  }
  // 允许该 DOM 元素重新入队
  state.queuedTargets.delete(target);
}
```

---

### P1-3: `inflightByTarget` DOM 复用竞态 — 重复上传

**根因**：`inflightByTarget` 用 DOM 元素做 WeakMap key（:895）。如果 DOM 被复用加载了新图片，`translateTarget` 会返回旧图片的 inflight promise，导致用错误数据调用 API。

**修复**：

a) 在 :895-896 增加 sourceToken 校验：
```js
if (state.inflightByTarget.has(target)) {
  const inflightToken = target.dataset.inflightSourceToken;
  const currentToken = getQuickSourceToken(target);
  if (inflightToken === currentToken) {
    // 同一张图片正在翻译中，返回已有 promise
    return state.inflightByTarget.get(target);
  }
  // sourceToken 不匹配：DOM 被复用了，清除旧 inflight 状态
  state.inflightByTarget.delete(target);
  delete target.dataset.inflightSourceToken;
  tracePipeline("inflight-bypass", target, { skipReason: "sourceTokenChanged" });
  // 继续往下走新翻译流程
}
```

b) 在 :1086 设置 inflight 时同步记录 sourceToken：
```js
target.dataset.inflightSourceToken = getQuickSourceToken(target);
state.inflightByTarget.set(target, task);
```

c) 在 :1082 finally 块中同步清理：
```js
delete target.dataset.inflightSourceToken;
state.inflightByTarget.delete(target);
```

---

### P2-4: 拼接缓存键冲突 — 重复上传

**根因**：payload 缓存用 `scopedTargetKey`（targetKey + sourceToken）做键。`buildKakaoStitchedPayload`（:1160）将拼接后的 composite payload 覆盖写入同一个缓存键。后续用同一 key 取到的可能是拼接 composite 而非单图，且拼接图中包含了邻居页面导致重复。

**修复**（:1157-1162 区域）：

```js
// 改写前（现状）:
payload = await buildKakaoStitchedPayload(target, payload);
// 此时 payload 是拼接 composite，但缓存键仍是 scopedTargetKey

// 改写后:
const singlePayload = payload; // 保留单图版本

if (shouldUseKakaoStitchedOcr(target, singlePayload)) {
  const stitched = await buildKakaoStitchedPayload(target, singlePayload);
  if (stitched.stitchAdmission === "accepted") {
    // 拼接版本用独立缓存键 (single | stitch 隔离)
    rememberPayloadCache(cacheKey + "|stitch", stitched);
    return stitched;
  }
  // 拼接被拒绝，回退到单图
  rememberPayloadCache(cacheKey, singlePayload);
  return singlePayload;
}
rememberPayloadCache(cacheKey, singlePayload);
return singlePayload;
```

读取侧（:1134 附近）按 ocrMode 取对应缓存：
```js
const wantStitch = shouldUseKakaoStitchedOcr(target, payload);
const cacheToCheck = wantStitch ? cacheKey + "|stitch" : cacheKey;
const cached = state.payloadCacheByTargetKey.get(cacheToCheck);
```

---

### P2-5: 调试框高度异常 — 红蓝框对不齐

**根因**：三个环节可能导致偏差：
1. 高度校验只丢弃不 clamp → 整个气泡丢失（而非修正）
2. `fill_box`/`polygon` Y 坐标正确重映射但 X 在非零 `ownerDraw.x` 时不重映射
3. CSS 渲染尺寸与图片原始尺寸宽高比不一致 → 百分比坐标拉伸

**修复**：

a) **Clamp 替代丢弃**（:1853-1866）：
```js
// 改写前: mappedH > maxH → return null (丢弃整个气泡)
// 改写后:
if (mappedH > maxH) {
  // 高度超阈值：clamp 到 maxH，同时清除 fill_box/polygon/region_polygon
  // 因为填充区和多边形坐标已不可靠
  return {
    ...bubble,
    x: mappedX, y: mappedY, w: mappedW, h: maxH,
    stitch_overflow: false,
    fill_box: null,
    polygon: null,
    region_polygon: null,
  };
}
```

b) **`fill_box` 高度合理性检查**（:1912-1916）：
```js
const mappedH = (heightPx / ownerH) * 100;
// 高度合理性检查：不应超过 300%
if (mappedH > 300) return null;
```

c) **Overlay rect 宽高比校验**（`getOverlayDisplayRect` 函数）：对于 `<img>` 元素，若 CSS rect 的宽高比与 `naturalWidth/naturalHeight` 不一致（偏差 > 1%），按图片原始比例调整 overlay rect，使百分比坐标的 (0,0) 和 (100,100) 与实际图片内容的四角对齐。

---

## Phase 2: 测试补强

### A. `tests/content_runtime.test.mjs` 新增单元测试（12 个）

| # | 测试名 | 覆盖的缺口 | 关键断言 |
|---|--------|-----------|---------|
| 1 | `buildKakaoStitchedPayload` creates composite with owner + neighbors | `buildKakaoStitchedPayload` 无测试 | ocrMode="stitch", 3 segments |
| 2 | `buildKakaoStitchedPayload` rejects: owner not found | 拒绝路径 | stitchRejectionReason="owner not found" |
| 3 | `buildKakaoStitchedPayload` rejects: no verified neighbor | 拒绝路径 | stitchRejectionReason="no verified neighbor" |
| 4 | `buildKakaoStitchedPayload` rejects: page-edge | 拒绝路径 | rejection starts with "page-edge" |
| 5 | `buildKakaoStitchedPayload` attaches short pages as full slices | 短页附着 | shortPageAttachment=true, slice == full height |
| 6 | `inflightByTarget` prevents re-queue for same sourceToken | inflight 生命周期 | 第二次调用返回首次 promise |
| 7 | `inflightByTarget` allows re-queue when sourceToken changed | DOM 复用 | sourceToken 不同 → 不等同 |
| 8 | `mtKakaoAttachedToKey` blocks independent queue | 短页保护 | 有 attached key 且未超时 → skip |
| 9 | `mtKakaoAttachedToKey` expires and allows standalone | 短页孤儿回退 | 超时 → key 清除 → 允许入队 |
| 10 | `shouldFallbackFromKakaoStitch` triggers on dropRatio > 0.7 | dropRatio 分支 | 触发回退 |
| 11 | `normalizeDebugCoordinateItems` filters non-owner + remaps coords | debug 坐标映射 | 仅保留 owner，坐标值正确 |
| 12 | `dedupedItems` / `duplicateItems` coordinate mapping | 两个数组无测试 | 过滤 + 映射正确 |

### B. 新建 `tests/integration_kakao_pipeline.test.mjs`

模拟 10 页序列（8 正常页 + 2 短页）端到端通过 pipeline：

1. `collectKakaopageManualTargetCandidates(true)` 返回 10 个候选
2. 短页被正确分配给相邻 owner（第 3、7 页）
3. Owner 的 `buildKakaoStitchedPayload` 包含正确的邻居
4. 所有 payload 中同一 sourceToken 最多出现一次
5. Owner 翻译失败后，附属短页可独立翻译

### C. `__test` 导出增强

新增导出函数以支持测试：
- `buildKakaoStitchedPayload`
- `normalizeDebugCoordinateItems`
- `getKakaoStitchOwnerOverlap`
- `normalizeKakaoStitchSegments`
- `getDebugItemPercentWithImageSize`
- `mapKakaoStitchedFillBox`

---

## Phase 3: 验证路径

### 3.1 单元测试基线

```bash
npm test
```
- 先确保所有现有测试通过
- 再确保新增 ~15 个测试通过

### 3.2 真实 KakaoPage 验证

1. 打开诊断 trace：在 console 执行 `globalThis.__MT_PIPELINE_TRACE__ = []` 然后从 content.js 启用
2. 翻阅一个 30+ 页的长章节
3. 导出 trace 分析：
   - 每个 `<img>` 元素都出现在 `stage: "collected"` 中
   - 零个 sourceToken 在 `stage: "requested"` 中出现超过 1 次
   - 每个 `"collected"` 最终到达 `"rendered"` 或有明确 `skipReason`
   - 短页显示 `attachedToKey` 且 owner 链完整

### 3.3 调试框目视检查

使用 CSS debug 类检查：
- `.mt-debug-raw`（蓝框）和 `.mt-debug-deduped`（红框）尺寸/位置接近
- 框不超出图片边界（`stitch_overflow` 除外）
- 框高度与文字行高一致

### 3.4 回归检查清单

| 场景 | 期望结果 |
|------|---------|
| 30 页长章节 | 全部 30 页渲染 |
| 含短碎页章节 | 短页附着邻页，无丢失、无重复 |
| 调试框正常页 | 红蓝框贴合文字 |
| DOM 节点复用 | 干净过渡，旧状态不泄漏 |

---

## 实施顺序

```
Phase 0: 加诊断 trace → 在真实页面跑一次 → 导出数据分析
    ↓
Phase 1: 按优先级修复（先跑 trace 后再决定修哪个）
    P1-1 (短页孤儿) → P1-2 (DOM 复用) → P1-3 (inflight 竞态)
    → P2-4 (缓存键) → P2-5 (调试框)
    ↓  （每修一个就写对应的测试）
Phase 2: 补测试 → 集成测试
    ↓
Phase 3: 验证 → npm test + 真实页面 + 目视检查
```

---

## 涉及文件

| 文件 | 改动 |
|------|------|
| `content.js` | Phase 0 埋点 + Phase 1 修复 |
| `tests/content_runtime.test.mjs` | 新增 ~12 个单元测试 + `__test` 导出增强 |
| `tests/integration_kakao_pipeline.test.mjs` | **新建** — 10 页端到端集成测试 |
| `styles.css` | 可能在 debug box 增加 `aspect-ratio` 支持 |

---

## Chrome 验证发现的问题（2024-06-24）

### #4 图片加载 429 限流导致翻译卡在 loading

**状态：已修复 ✅**

**症状**：开启自动翻译后 loading 卡片一直显示 "OCR + 翻译中..."，翻译永不完成

**根因**：Kakao CDN 返回 429 Too Many Requests 时 `<img>` `naturalWidth=0`、`complete=true`。扩展未检测此状态仍发起 `FETCH_IMAGE_DATA_URL`，Service Worker 重试后仍 429，期间 loading 卡片不消失

**修复**：
- #4a — `extractImagePayload` 增加空图检测：`naturalWidth=0` 且非 data URL 时触发 `SCREENSHOT_TARGET_NOT_VISIBLE` 自动重试（`:2827-2836`）
- #4b — Loading 超时保护：`LOADING_OVERLAY_TIMEOUT_MS = 60000`，超时自动清除并触发 `scheduleAutoTranslateRetry`（`:3902-3931`）
- #4c — Service Worker fetch 添加 `AbortController` 总体超时 10 秒（`background.js :246-267`）

### #5 虚拟列表滚动后新图片不自动翻译

**状态：已修复 ✅**

**症状**：KakaoPage 虚拟列表滚动后，新视口内的漫画图片没有自动触发翻译

**根因**：虚拟列表回收 `<img>` 元素（改 `src`），`MutationObserver` 观察到变化后调 `registerTarget` 清旧状态设新 `mtSourceToken`，但 `queuePageAutoTranslate` 未被触发。`IntersectionObserver` 对已观察过的元素不会重触发

**修复**：
- `registerTarget` 中 sourceToken 变化且自动翻译开启时，立即调用 `queuePageAutoTranslate`（`:516-527`）

---

### #6 Kakao CDN fetch 失败导致非首页图片翻译卡死

**状态：已修复 ✅**

**症状**：只有第一页（标题页）翻译成功，后续页面全部卡在 "OCR + 翻译中..." 后超时消失

**根因**：
- 扩展 Service Worker 通过 `FETCH_IMAGE_DATA_URL` 抓取 Kakao page-edge CDN 图片时失败（`ERR_CONTENT_LENGTH_MISMATCH`，CDN 响应不完整）
- 每个 fetch 尝试需要 10 秒超时（2 次 × 10s），总等待 20 秒
- canvas fallback（`imageElementToDataUrl`）因跨域 CORS 限制抛出 SecurityError
- 最后的 `captureVisibleTargetPayload` 对视口外的图片返回 `SCREENSHOT_TARGET_NOT_VISIBLE`
- 重试循环跑满后 loading 超时（60s）清除卡片，但翻译从未完成

**修复**：
- **background.js**: 减少 fetch 总体超时 10s→5s；交换 credentials 顺序（`include` 优先携带 cookies）；对网络不稳定的 `Failed to fetch` 增加 300ms 延迟重试（`:232-278`）
- **content.js**: `extractImagePayload` canvas fallback 失败时，对 KakaoPage 视口外图片自动 `scrollIntoView` 后截图（`:2902-2918`）
- **content.js**: loading 超时从 60s→30s，更快触发重试（`:61`）

**验证**：
- Chrome 中打开长章节，开启自动翻译
- 滚动浏览多页，检查非首页是否也有译文
- 控制台应无 `ERR_CONTENT_LENGTH_MISMATCH` 导致的长时间挂起