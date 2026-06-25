# KakaoPage 翻译管线 — 问题诊断与修复方案

## 问题概述

1. 漏字？不知道是OCR的问题还是其他问题。
2. 明明关掉了调试模式，但是还是有红蓝框。
   ![1782369631921](image/problems/1782369631921.png)
3. [✅] 一个翻译重复两遍。两个翻译叠在一起。大概是一张图重复拼接了。da9c0e62f698e4fb3be1de5c0d7a530281b4a423

294760ba32787bc5973ded9f4803fe9cb17c0d38 这两个提交记录可能有所帮助吧

![1782369734481](image/problems/1782369734481.png)

![1782369753352](image/problems/1782369753352.png)

**根因分析：** 两个互相关联的问题导致气泡"重复出现"：

1. **`recoverRenderedTargets` 恢复路径跳过去重** — `syncAllOverlays` → `recoverRenderedTargets` 被周期性调用，从 `state.localResultCache` 中读取缓存的翻译结果并直接传给 `renderOverlay`，沿途未调用 `dedupeKakaoResultByPageCoordinates`。当全局去重状态（`kakaoGlobalOcrEntries`）在缓存后发生变化（例如相邻页独立 OCR 后其气泡被跨图去重移除），缓存中残留的"本应被移除"的气泡在恢复时因未重新比对而再次出现。

2. **`dedupeKakaoResultByPageCoordinates` 中全局条目删除时机导致竞态** — 该函数在 `await trimKakaoBoundaryOverlapBubbles` 之前就执行 `state.kakaoGlobalOcrEntries.delete(targetKey)`，导致本目标旧条目在 await 期间从全局状态中消失。其他并列处理的目标（`MAX_PARALLEL_TRANSLATIONS` > 1）在此期间查不到本目标条目，因而漏掉去重，接受本应被移除的气泡。

**修复方案:**
- `recoverRenderedTargets`: overlay 恢复路径改为先 `dedupeKakaoResultByPageCoordinates` 再 `renderOverlay`，确保缓存结果与当前全局去重状态一致。
- `dedupeKakaoResultByPageCoordinates`: 移除 await 前的 `delete(targetKey)`，让 `dedupeKakaoGlobalBubbles`（内部同样做 delete）在 await 之后处理清除，避免竞态窗口。

**涉及的提交：** (f3926cae 包含两项修复)
