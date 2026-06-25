# KakaoPage 翻译管线 — 问题诊断与修复方案

## 问题概述

1. **漏页** — 部分漫画页面没有被送入 OCR/翻译，最终无译文覆盖。目前观察，该界面是短页。

---

## ✅ 根因 #0（CRITICAL）：`attachedShortPageKeys` 存的是 `targetKey`，但 `findTargetByScopedKey` 期望 `scopedKey` → `releaseUncoveredKakaoShortPages` 完全无效

### 问题

`buildKakaoStitchedPayload` (:1562-1564) 存储短页 key 时用的是 `computeTargetKey()` 的返回值（plain targetKey）：

```js
// :1562-1564
attachedShortPageKeys: [previousEntry, nextEntry]
    .filter(e => e && e.shortPageAttachment)
    .map(e => e.targetKey),   // ← computeTargetKey(x) = "direct|img|url|800x1000"
```

但 `releaseUncoveredKakaoShortPages` (:5184) 和 catch 块 (:1188) 都是通过 `findTargetByScopedKey(shortKey)` 来查找元素：

```js
// :5689-5690
const key = computeTargetKey(candidate);
if (buildTargetSourceCacheKey(key, getQuickSourceToken(candidate)) === scopedKey) {
    return candidate;
}
```

`buildTargetSourceCacheKey` 会在 targetKey 后追加 `|src:<8位hash>`：

```
targetKey:    "direct|img|https://page-edge.kakao.com/...|800x1000"
scopedKey:    "direct|img|https://page-edge.kakao.com/...|800x1000|src:abcd1234"
```

**`attachedShortPageKeys` 存的是 targetKey，`findTargetByScopedKey` 比对的是 scopedKey → 必然不匹配 → 永远返回 null → 短页从不被释放！**

### 影响范围

| 位置 | 行号 | 影响 |
|------|------|------|
| `releaseUncoveredKakaoShortPages` | :5184 | 短页从未被释放独立翻译 |
| `translateTarget` catch | :1188 | owner 失败时短页也被卡住 |

**这是导致 "漏页" 最可能的根因。** 之前的修复（commit `8790211`）引入了 `releaseUncoveredKakaoShortPages` 机制，但由于 key 类型不匹配，该机制完全无效。

### 修复

**一行修复** — 改 `attachedShortPageKeys` 存储 scopedKey 而非 targetKey：

在 `buildKakaoStitchedPayload` :1562-1564：

```js
// 修改前：
attachedShortPageKeys: [previousEntry, nextEntry]
    .filter(e => e && e.shortPageAttachment)
    .map(e => e.targetKey),

// 修改后：
attachedShortPageKeys: [previousEntry, nextEntry]
    .filter(e => e && e.shortPageAttachment)
    .map(e => buildTargetSourceCacheKey(e.targetKey, e.src)),
```

`previousEntry` 和 `nextEntry` 结构已包含 `targetKey` 和 `src` 字段（:1500-1501, :1518-1519），可直接用于构造 scopedKey。

### 状态

✅ **已修复**（commit `8790211` 后补充修复）。

---

## ✅ 根因 #1：`translateTarget` filter 拒绝时无 retry（P0）

### 问题

- `queuePageAutoTranslate` 在 `passesTargetFilter` 失败时会调 `scheduleAutoTranslateRetry`（:5068），但 `translateTarget` 不调（:997-1002）
- 当短页被 `releaseUncoveredKakaoShortPages` 释放后，走 `queueTranslate` → `translateTarget` 路径，若 filter 拒绝则永久丢失

### 修复

在 `translateTarget` 的 filter 拒绝处（:997-1002），为 KakaoPage 自动翻译模式增加 retry：

```js
if (!passesTargetFilter(target, options.manual, {
  relaxed: options.relaxed === true,
  allowOffscreen: options.allowOffscreen === true
})) {
  // KakaoPage 自动翻译模式下安排重试
  if (IS_KAKAOPAGE_READER && state.autoTranslatePageEnabled && options.manual) {
    scheduleAutoTranslateRetry(target);
  }
  return { ok: false, skipped: true, reason: "filtered as non-manga target" };
}
```

### 状态

✅ **已修复**。`translateTarget` filter 拒绝时，KakaoPage 自动翻译模式下会调用 `scheduleAutoTranslateRetry` 确保短页不会永久丢失。

---

## ✅ 根因 #2：短页气泡存在于 owner 结果中时，短页元素没有自己的 overlay（P1）

### 问题

当 owner stitch 翻译检测到短页区域的文字：
- 气泡映射到 owner 坐标空间（`stitch_attached_short_page: true`）
- `hasAttachedShortPageBubble` 返回 true
- `releaseUncoveredKakaoShortPages` 返回 0（不释放→但根因 #0 修复后，此处会成为新路径）
- 短页保留 `mtKakaoAttachedToKey`，`queuePageAutoTranslate` 永远 skip
- 短页文字仅渲染在 owner 的 overlay 上，短页自身无覆盖层

### 修复

根因 #0 修复后，`releaseUncoveredKakaoShortPages` 开始实际工作。此时无论 owner 结果中是否有短页气泡，都应释放短页独立翻译，确保短页自身有 overlay：

```js
function releaseUncoveredKakaoShortPages(payload, result, owner, reason) {
  if (!IS_KAKAOPAGE_READER || !payload) {
    return 0;
  }

  const attachedShortPageKeys = Array.isArray(payload.attachedShortPageKeys)
    ? payload.attachedShortPageKeys.filter(Boolean)
    : [];
  if (attachedShortPageKeys.length === 0) {
    return 0;
  }

  const ownerKey = owner ? computeTargetKey(owner) : "";
  const ownerScopedKey = owner ? buildTargetSourceCacheKey(ownerKey, getQuickSourceToken(owner)) : "";
  let released = 0;
  for (const shortKey of attachedShortPageKeys) {
    const el = findTargetByScopedKey(shortKey);
    if (!el) continue;

    delete el.dataset.mtKakaoAttachedToKey;
    delete el.dataset.mtKakaoAttachedToAt;
    delete el.dataset.mtNoTextKey;
    delete el.dataset.mtLastTranslatedKey;
    el.dataset.mtKakaoDetachedFromOwnerKey = ownerScopedKey;
    el.dataset.mtKakaoDetachedFromOwnerAt = String(Date.now());
    tracePipeline("short-detached", el, { reason, ownerScopedKey });
    released += 1;

    // 用 queuePageAutoTranslate 而非 queueTranslate，确保有 retry 保护
    queuePageAutoTranslate(el);
  }
  return released;
}
```

变更：
- 移除 `hasAttachedShortPageBubble(result)` 检查 → 总是释放
- 改用 `queuePageAutoTranslate` → 获得 retry 保护
- （根因 #0 修复后 `findTargetByScopedKey` 能真正找到元素）

### 状态

✅ **已修复**。`releaseUncoveredKakaoShortPages` 不再检查 `hasAttachedShortPageBubble(result)`，始终释放短页独立翻译以确保短页自身有 overlay。

---

## ✅ 根因 #3：owner inflight 期间短页 attach，payload 已提取无法更新（P1）

### 问题

1. owner 的 `translateTarget` 开始时提取 payload → 此时短页尚未加载
2. 短页加载 → `maybeQueueKakaoShortPageAttachmentOwner` 调用 `queueTranslate(owner)`
3. `queueTranslate` 见 `inflightByTarget.has(owner)` → 不重入队
4. owner 翻译完成 → `payload.attachedShortPageKeys` 是旧数据（不含新短页）
5. 短页卡住 8 秒等 timeout

### 修复

在 `translateTarget` 的 finally 块中检查是否有短页在 inflight 期间附着：

```js
finally {
  state.inflightByTarget.delete(target);
  delete target.dataset.inflightSourceToken;

  // 检查 inflight 期间附着的短页
  if (IS_KAKAOPAGE_READER && state.autoTranslatePageEnabled) {
    releaseShortPagesAttachedDuringInflight(target);
  }
}
```

新增函数：

```js
function releaseShortPagesAttachedDuringInflight(owner) {
  const ownerKey = computeTargetKey(owner);
  const ownerScopedKey = buildTargetSourceCacheKey(ownerKey, getQuickSourceToken(owner));

  const candidates = collectKakaopageManualTargetCandidates(true, owner);
  for (const candidate of candidates) {
    if (candidate === owner) continue;
    if (candidate.dataset.mtKakaoAttachedToKey !== ownerScopedKey) continue;

    // 这个短页在 owner inflight 期间附着 → 释放并重新翻译
    delete candidate.dataset.mtKakaoAttachedToKey;
    delete candidate.dataset.mtKakaoAttachedToAt;
    delete candidate.dataset.mtNoTextKey;
    delete candidate.dataset.mtLastTranslatedKey;
    candidate.dataset.mtKakaoDetachedFromOwnerKey = ownerScopedKey;
    candidate.dataset.mtKakaoDetachedFromOwnerAt = String(Date.now());

    queuePageAutoTranslate(candidate);
  }
}
```

### 状态

✅ **已修复**。在 `translateTarget` 的 `finally` 块中调用 `releaseShortPagesAttachedDuringInflight`，检查 owner inflight 期间附着的短页并释放独立翻译。

---

## 实施顺序（已完成）

```
Step 1: 修复根因 #0（一行改 attachedShortPageKeys → scopedKey） ✅
        这是 CRITICAL，修复后 releaseUncoveredKakaoShortPages 才开始真正工作
    ↓
Step 2: 修复根因 #1（translateTarget filter retry） ✅
        确保释放后的短页即使 filter 临时拒绝也能重试
    ↓
Step 3: 修复根因 #2（总是释放短页独立翻译） ✅
        确保短页自身有 overlay，不依赖 owner overlay
    ↓
Step 4: 修复根因 #3（inflight 期间附着检查） ✅
        处理时序问题
    ↓
Step 5: npm test + Chrome 真实验证 ✅
        85 tests pass
```

## 涉及文件

| 文件 | 改动 |
|------|------|
| `content.js` | 以上 4 项修复 |
| `tests/content_runtime.test.mjs` | 新增 `findTargetByScopedKey` 匹配测试、release 流程测试 |
| `problems.md` | 本文件 |

## 验证检查清单

| 场景 | 期望 |
|------|------|
| 短页在章节中间 | 有独立译文 overlay |
| 短页在章节首尾 | 有独立译文 overlay |
| owner 翻译期间短页滚出视口 | retry 触发，最终有译文 |
| owner inflight 期间短页附着 | owner 完成后短页自动独立翻译 |
| CDN 慢/失败的短页 | retry 最多 5 次，不永久卡住 |
| Chrome 30+ 页章节 | 所有页（含短页）都有译文 |

---

# 2026-06-25 Kakao 边界上下文切片 raw 有但 block 丢失（已修复）

## 现象

截图中 `봤냐, 이놈들아!` 能看到红色 `raw-*` 调试框，但没有对应的 `block-*` 翻译框；下一张短页自身也只生成了下方 `서호윤씨. / 미안해요!!` 的翻译。

## 根因

这不是 OCR 完全漏识别，而是拼接结果映射阶段漏保留：该文字来自 owner 下方的普通 `next` 上下文切片，`mapKakaoStitchedResult` 之前只保留 owner 区域和显式 short-page attachment，普通相邻切片文本会被当成邻页内容丢弃。若相邻页独立 OCR 没再次识别到同一边界文字，就会出现 raw 有、最终 block 无。

## 修复

新增 `mapKakaoAdjacentBoundaryBubble`，仅在以下条件同时满足时保留普通相邻切片文本为 owner 越界 overlay：

- 命中 `previous` 或 `next` segment，且 overlap ratio >= 0.6。
- 相邻 segment 不是显式 short-page attachment。
- segment 高度不超过 owner 高度的 45%，只认定为边界上下文切片。
- segment 边缘紧贴 owner 上/下边缘。
- 映射后的气泡高度合理，避免完整邻页文本被误收入。

## 验证

- `node.exe --test tests\content_runtime.test.mjs`：63 passed / 0 failed。
- `node.exe --test tests\content_runtime.test.mjs tests\background_runtime.test.mjs tests\overlay_style.test.mjs`：87 passed / 0 failed。
- `node.exe --check content.js`、`node.exe --check background.js`：通过。
- `node.exe scripts\build-extension.mjs`：通过。

---

# 2026-06-25 Kakao 跨页气泡只识别第一行（已修复）

## 现象

`block-ef5b...` 只识别并翻译了气泡顶部的 `어우피디님!`，下面两行 `왜 이래요 / 정말!!` 没有 raw 调试框，也没有译文。

## 根因

旧的普通相邻上下文切片太浅。前一页 owner 的拼接输入图只截到了下一页顶部气泡的第一行，图像底部正好停在 `어우 피디님` 附近；下一页独立 OCR 输入又从人物画面开始，顶部气泡文字已经在裁剪范围之外。结果是两条 OCR 路径都没有覆盖气泡下半部分。

## 修复

将 Kakao 普通拼接上下文深度从浅切片提升为更深的边界上下文：

- `KAKAO_STITCH_CONTEXT_CSS_PX` 提升到 360。
- 新增 `KAKAO_STITCH_CONTEXT_HEIGHT_RATIO = 0.35`，按 owner 高度限制上下文深度。
- `KAKAO_STITCH_MAX_CONTEXT_PX` 提升到 480。
- 最终映射仍要求普通相邻切片高度不超过 owner 的 45%，完整邻页仍会被过滤，避免重复翻译。

## 验证

- `node.exe --test tests\content_runtime.test.mjs`：64 passed / 0 failed。
- `node.exe --test tests\content_runtime.test.mjs tests\background_runtime.test.mjs tests\overlay_style.test.mjs`：88 passed / 0 failed。
- `node.exe --check content.js`、`node.exe --check background.js`：通过。
- `node.exe scripts\build-extension.mjs`：通过。
