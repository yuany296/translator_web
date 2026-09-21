/**
 * 漫画流式增量渲染：后台每把一批已完成的译文行推回来，就先结算进 canonical store
 * 并做一次去抖渲染，用户不必等整批 LLM 返回（慢模型整批 20~30s）。
 *
 * 默认关闭（runtime.comicStreamingEnabled，见设置 mt_runtime_config_v1）：
 * 它会带来逐气泡上屏的视觉变化，需要先在真实阅读器上确认。
 */
export function installCanonicalPartialTranslations(runtime) {
  const PARTIAL_RENDER_DEBOUNCE_MS = 120;
  let renderTimer = 0;

  function comicStreamingEnabled() {
    return runtime.comicStreamingEnabled === true;
  }
  runtime.isComicStreamingEnabled = comicStreamingEnabled;

  function cancelComicPartialRender() {
    if (!renderTimer) return;
    try {
      globalThis.clearTimeout(renderTimer);
    } catch {
      // 页面正在卸载时忽略
    }
    renderTimer = 0;
  }
  runtime.cancelComicPartialRender = cancelComicPartialRender;

  function schedulePartialRender() {
    if (renderTimer) return;
    renderTimer = globalThis.setTimeout(() => {
      renderTimer = 0;
      const pipeline = runtime.kakaoCanonicalPipeline;
      if (!pipeline || typeof pipeline.renderSettled !== "function") return;
      Promise.resolve(pipeline.renderSettled("partial-translation")).catch(error => {
        console.warn("[MangaTranslator] partial comic render failed:", runtime.getErrorMessage?.(error) || error);
      });
    }, PARTIAL_RENDER_DEBOUNCE_MS);
  }

  /** 把增量行结算进 store；返回本次真正结算的条数。 */
  function settlePartialRows(rows) {
    const pipeline = runtime.kakaoCanonicalPipeline;
    const store = pipeline && pipeline.store;
    if (!store || typeof store.settleTranslation !== "function") return 0;
    const revisionById = new Map(store.getCanonicalSnapshot().map(canonical => [String(canonical && canonical.id || ""), Number(canonical && canonical.revision) || 1]));
    let settled = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row && row.id || "");
      const text = String(row && (row.translatedText || row.translated_text) || "").trim();
      const revision = revisionById.get(id);
      if (!id || !text || revision === undefined) continue;
      try {
        if (store.settleTranslation({ id, revision }, { translated_text: text }) === true) settled += 1;
      } catch {
        // 单行结算失败不影响整批结果
      }
    }
    return settled;
  }
  runtime.settleCanonicalPartialRows = settlePartialRows;

  function applyComicPartialTranslations(message) {
    if (!comicStreamingEnabled()) return 0;
    const settled = settlePartialRows(message && message.rows);
    if (settled > 0) schedulePartialRender();
    return settled;
  }
  runtime.applyComicPartialTranslations = applyComicPartialTranslations;
}
