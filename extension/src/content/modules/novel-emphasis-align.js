/**
 * 「让模型排版」的内容侧调度。
 *
 * 一屏译文到齐之后，把这一屏里**含行内格式**的段落挑出来，连同它们带 ⟦⟧ 标记的原文一起
 * 发给后台(见 background/modules/novel-emphasis.js)，拿回同样带标记的译文，存进
 * `state.emphasisMarks`，渲染时就能把强调段落对到正确的字上(见 novel-renderer.js
 * 的 buildTranslationMirror)。整段没有任何行内格式的段落不参与 —— 真机一整屏 137 段里
 * 通常只有个位数。
 *
 * 三条边界：
 *   - 每段只对齐一次：`state.emphasisAligned` 记下「这段译文已经问过了」(含失败)，
 *     否则每次 reconcile / 每次翻屏回来都会重发一遍；
 *   - 只有拿到标记的段落才重贴，其余保持原样(比例映射兜底)；
 *   - 失败绝不冒泡：排版只是外观，坏掉不该影响翻译本身。
 */
const MAX_ITEMS_PER_REQUEST = 40;

export function installNovelEmphasisAlign(runtime) {
  function collectAlignmentItems(chapter, state) {
    const items = [];
    for (const paragraph of chapter.paragraphs) {
      const text = String(state.translations.get(paragraph.id) || "").trim();
      if (!text) continue;
      if (state.emphasisAligned.has(paragraph.id)) continue;
      const emphasis = runtime.describeNovelEmphasis?.(paragraph.node);
      if (!emphasis) continue;
      items.push({ id: paragraph.id, source: emphasis.marked, translation: text });
    }
    return items;
  }

  function rememberAttempt(state, items) {
    for (const item of items) state.emphasisAligned.set(item.id, item.translation);
  }

  function requestContext() {
    return {
      sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
      targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
      pageUrl: typeof location !== "undefined" ? location.href : ""
    };
  }

  async function alignNovelEmphasisForScreen(chapter, state = runtime.getNovelState()) {
    if (!chapter || !state || runtime.state?.invalidated) return { aligned: 0 };
    if (typeof runtime.sendRuntimeMessage !== "function") return { aligned: 0 };
    const pending = collectAlignmentItems(chapter, state);
    if (!pending.length) return { aligned: 0 };
    let aligned = 0;
    for (let offset = 0; offset < pending.length; offset += MAX_ITEMS_PER_REQUEST) {
      const batch = pending.slice(offset, offset + MAX_ITEMS_PER_REQUEST);
      let response = null;
      try {
        response = await runtime.sendRuntimeMessage({
          type: "ALIGN_NOVEL_EMPHASIS",
          ...requestContext(),
          items: batch.map(({ id, source, translation }) => ({ id, source, translation }))
        });
      } catch {
        response = null;
      }
      // 先记账再判断结果:失败也记，避免每 80ms 的 reconcile 反复重发同一个请求。
      rememberAttempt(state, batch);
      for (const row of Array.isArray(response && response.alignments) ? response.alignments : []) {
        const id = String(row && row.id || "");
        const marked = String(row && row.marked_translation || "");
        if (!id || !marked) continue;
        state.emphasisMarks.set(id, marked);
        aligned += 1;
      }
    }
    if (aligned) refreshAlignedParagraphs(chapter, state);
    return { aligned };
  }

  /** 只有拿到标记的段落需要重贴;重贴走同一条 reapply(它按 id 找活节点)。 */
  function refreshAlignedParagraphs(chapter, state) {
    if (state.showTranslation !== true) return;
    for (const paragraph of chapter.paragraphs) {
      const text = String(state.translations.get(paragraph.id) || "").trim();
      if (!text || !state.emphasisMarks.has(paragraph.id)) continue;
      runtime.renderNovelTranslation?.(paragraph.node, text, true, paragraph.id);
    }
  }

  runtime.alignNovelEmphasisForScreen = alignNovelEmphasisForScreen;

  /**
   * 换章/换屏时把「问过没有」与对齐结果一起清掉：段落 id 里带源文哈希，不清也不会串号，
   * 但白白占内存，而且同一屏翻回来时应该允许重新对齐(模型可能换了)。
   */
  function resetNovelEmphasis(state = runtime.getNovelState()) {
    state.emphasisAligned?.clear?.();
    state.emphasisMarks?.clear?.();
  }
  runtime.resetNovelEmphasis = resetNovelEmphasis;
}
