export function installPipeline16(runtime) {
  /**
   * 跨图去重（内部使用 Store 的串行化事务）
   */
  async function dedupeKakaoResultByPageCoordinates({
    result,
    target,
    targetKey,
    scopedTargetKey = targetKey,
    store,
    adapters = {},
    scrollX = 0,
    scrollY = 0
  }) {
    if (!store || !result || !Array.isArray(result.bubbles) || !targetKey) {
      return result;
    }
    return store.runSerializedDedupe(() => runtime.executeDedupe(target, targetKey, scopedTargetKey, result, scrollX, scrollY, store, adapters));
  }
  runtime.dedupeKakaoResultByPageCoordinates = dedupeKakaoResultByPageCoordinates;
  async function executeDedupe(target, targetKey, scopedTargetKey, result, scrollX, scrollY, store, adapters = {}) {
    if (!result || !Array.isArray(result.bubbles) || !targetKey) return result;
    const targetRect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    if (!targetRect || !(targetRect.width > 0) || !(targetRect.height > 0)) return result;

    // 为所有气泡添加 global_box
    const bubblesWithBox = result.bubbles.map(bubble => ({
      ...bubble,
      global_box: bubble.global_box || runtime.computeKakaoGlobalBox(bubble, scrollX, scrollY, targetRect)
    }));
    const trimmed = await runtime.trimBoundaryOverlap(bubblesWithBox, targetKey, store.getGlobalEntries(), adapters.translateTrimmedBubble);
    const deduped = runtime.runDedupeGlobalBubbles(trimmed, target, targetRect, targetKey, store, {
      scrollX,
      scrollY,
      scopedTargetKey,
      onSupersededEntry: adapters.onSupersededEntry
    });
    return {
      ...result,
      bubbles: deduped,
      debug: runtime.syncOcrDebugFinalBubbles(result.debug, deduped)
    };
  }

  /**
   * 边界重叠气泡修剪
   */
  runtime.executeDedupe = executeDedupe;
  async function trimBoundaryOverlap(bubbles, targetKey, existingEntries, translateTrimmedBubble) {
    const existing = Array.isArray(existingEntries) ? existingEntries : [];
    const output = [];
    for (const bubble of bubbles) {
      let nextBubble = bubble;
      const text = runtime.normalizeOcrSimilarityText(bubble.original_text);
      const entry = existing.find(candidate => {
        const overlap = runtime.getSubstantialOcrBoundaryOverlap(text, candidate.text);
        return overlap && runtime.areKakaoGlobalBoxesRelated(bubble.global_box, candidate.box);
      });
      if (entry) {
        const trimmed = runtime.trimKakaoBubbleBoundary(nextBubble, runtime.getSubstantialOcrBoundaryOverlap(text, entry.text));
        if (trimmed) {
          nextBubble = typeof translateTrimmedBubble === "function" ? await translateTrimmedBubble(trimmed, targetKey) : trimmed;
        }
      }
      output.push(nextBubble);
    }
    return output;
  }

  /**
   * 全局去重（传递 store 实例而非直接操作 state）
   */
  runtime.trimBoundaryOverlap = trimBoundaryOverlap;
  function runDedupeGlobalBubbles(bubbles, target, targetRect, targetKey, store, options = {}) {
    if (!targetRect || !targetKey) return bubbles;
    store.deleteEntriesForKey(targetKey);
    const existing = store.getGlobalEntries();
    const accepted = [];
    const entries = [];
    const sx = Number(options.scrollX || 0);
    const sy = Number(options.scrollY || 0);
    for (const bubble of bubbles) {
      const box = bubble.global_box || runtime.computeKakaoGlobalBox(bubble, sx, sy, targetRect);
      const text = runtime.normalizeOcrSimilarityText(bubble.original_text);
      const translatedText = runtime.normalizeOcrSimilarityText(bubble.translated_text);
      const duplicates = existing.concat(entries).filter(entry => runtime.isKakaoGlobalDuplicateCandidate({
        box,
        text,
        translatedText,
        targetKey,
        bubble
      }, entry));
      const rawCompleteness = Math.max(text.length, translatedText.length);
      const completeness = bubble.stitch_boundary_neighbor ? Math.max(1, Math.floor(rawCompleteness * 0.5)) : rawCompleteness;
      const strongestExisting = duplicates.reduce((best, entry) => !best || entry.completeness > best.completeness ? entry : best, null);
      if (strongestExisting && strongestExisting.completeness >= completeness) {
        continue;
      }

      // 移除被超越的旧条目
      for (const dup of duplicates) {
        if (typeof options.onSupersededEntry === "function") {
          options.onSupersededEntry(dup);
        } else {
          runtime.removeSupersededEntry(dup, store);
        }
      }
      accepted.push(bubble);
      entries.push({
        box,
        text,
        translatedText,
        completeness,
        target,
        targetKey,
        scopedTargetKey: options.scopedTargetKey || targetKey,
        bubble,
        bubbleContainer: accepted,
        entryContainer: entries
      });
    }
    store.setEntriesForKey(targetKey, entries);
    return accepted;
  }
  runtime.runDedupeGlobalBubbles = runDedupeGlobalBubbles;
  function removeSupersededEntry(entry, store) {
    if (!entry) return;
    store.removeEntryFromKey(entry.targetKey, entry);

    // 从 bubbleContainer 和 entryContainer 中移除
    if (Array.isArray(entry.bubbleContainer)) {
      const idx = entry.bubbleContainer.indexOf(entry.bubble);
      if (idx >= 0) entry.bubbleContainer.splice(idx, 1);
    }
    if (Array.isArray(entry.entryContainer)) {
      const idx = entry.entryContainer.indexOf(entry);
      if (idx >= 0) entry.entryContainer.splice(idx, 1);
    }
    // 注意：localResultCache 更新和 overlay 重新渲染由 content.js
    // 在收到 SupersededEntry 事件后处理，不在 pipeline 层处理。
  }

  /**
   * 释放未被 stitch 覆盖的短页
   */
  runtime.removeSupersededEntry = removeSupersededEntry;
  function releaseUncoveredShortPages(payload, result, owner, store, adapters) {
    if (!payload || runtime.hasAttachedShortPageBubble(result)) return 0;
    const attachedKeys = runtime.extractAttachedShortPageKeys(payload);
    if (attachedKeys.length === 0) return 0;
    const ownerKey = adapters.computeTargetKey(owner);
    const ownerScopedKey = adapters.buildTargetSourceCacheKey(ownerKey, adapters.getQuickSourceToken(owner));
    let released = 0;
    for (const shortKey of attachedKeys) {
      const el = adapters.findTargetByScopedKey(shortKey);
      if (!el) continue;
      store.releaseShortPage(el, ownerScopedKey);
      delete el.dataset.mtNoTextKey;
      delete el.dataset.mtLastTranslatedKey;
      adapters.tracePipeline("short-detached", el, {
        reason: "ownerSucceededWithoutBubble",
        ownerScopedKey
      });
      released += 1;
      adapters.queuePageAutoTranslate(el);
    }
    return released;
  }
  runtime.releaseUncoveredShortPages = releaseUncoveredShortPages;
  function rememberLocalResult(adapters, scopedKey, result) {
    if (!adapters.state || !adapters.state.localResultCache) return;
    adapters.state.localResultCache.set(scopedKey, result);
  }

  /* =================================================================
   * 导出
   * ================================================================= */
  runtime.rememberLocalResult = rememberLocalResult;
}
