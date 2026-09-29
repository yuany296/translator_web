import { findSeamSplitPairs } from "../modules/split-detector.js";

/**
 * 接缝漏合并遥测：一对邻片的接缝 OCR 完成、canonical 快照刷新之后，
 * 看看上片最后一条与下片第一条是不是「同一句被劈成两半却各自成条」。
 *
 * 目的不是自动合并（那要改 reconciler 的阈值），而是让下面这个问题**可观测**：
 * 接缝到底跑没跑（`shouldRun` 原因）、跑了之后为什么还是两条。
 * 输出 `[MangaTranslator][canonical-split]`，并把最近 20 对留在 `scope.seamSplits`。
 */
const MAX_TRACKED_SPLITS = 20;

export function installCanonicalSplitReport(runtime, scope) {
  const seamSplits = [];

  function reportSeamSplits({ upperPageId = "", lowerPageId = "", reasons = [], status = "" } = {}) {
    let canonicals = [];
    try {
      canonicals = scope.store.getCanonicalSnapshot() || [];
    } catch (error) {
      scope.trace?.("canonical-split-error", null, { error: runtime.getErrorMessage(error) });
      return [];
    }
    const splits = findSeamSplitPairs({
      canonicals,
      pairs: [{ upperPageId, lowerPageId }]
    });
    for (const split of splits) {
      const record = {
        at: Date.now(),
        upperPageId: String(upperPageId),
        lowerPageId: String(lowerPageId),
        seamStatus: String(status || ""),
        seamReasons: Array.isArray(reasons) ? reasons.map(String) : [],
        previousId: split.previous.id,
        previousText: split.previous.text.slice(0, 60),
        nextId: split.next.id,
        nextText: split.next.text.slice(0, 60)
      };
      seamSplits.push(record);
      if (seamSplits.length > MAX_TRACKED_SPLITS) seamSplits.splice(0, seamSplits.length - MAX_TRACKED_SPLITS);
      console.info("[MangaTranslator][canonical-split]", record);
    }
    return splits;
  }
  scope.reportSeamSplits = reportSeamSplits;

  function listSeamSplits() {
    return seamSplits.map(record => ({ ...record }));
  }
  scope.listSeamSplits = listSeamSplits;
}
