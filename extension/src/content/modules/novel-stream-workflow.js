export function installNovelStreamWorkflow(runtime) {
  function recordPayload(chapter, item) {
    return {
      mode: "novel", scopeKey: chapter.scopeKey, segmentKey: item.paragraphKey,
      workId: chapter.seriesId, chapterId: chapter.chapterId,
      rawSourceText: item.original_text,
      normalizedSourceText: runtime.normalizeTranslationCacheText(item.original_text),
      rawSourceHash: item.rawSourceHash,
      normalizedSourceHash: item.normalizedSourceHash,
      configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
      resolvedSourceLanguage: runtime.resolveSourceLanguage?.(item.original_text) || "auto",
      targetLanguage: runtime.getTargetLanguage?.() || "zh-CN"
    };
  }

  async function attemptNovelTranslationStream(chapter, state, items, fingerprint, context = {}) {
    if (!items.length || !runtime.runNovelTranslationStream) return { supported: false, completed: 0 };
    const taskId = state.taskId;
    const chapterKey = state.chapterKey;
    state.streamState = "streaming";
    state.progress.textPhase = "正在建立逐段流式翻译…";
    runtime.setNovelTextStatus?.("working", state.progress);
    const request = {
      taskId, scopeKey: chapter.scopeKey,
      sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
      targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
      configFingerprint: fingerprint,
      context: {
        chapterTitle: chapter.chapterTitle, memory: context.memory || {},
        previousTranslation: context.previousTranslation || ""
      },
      items: items.map(item => ({
        id: item.id, paragraphKey: item.paragraphKey,
        recordKey: runtime.buildNovelRecordKey(chapter, item),
        originalText: item.original_text, recordPayload: recordPayload(chapter, item)
      }))
    };
    try {
      const result = await runtime.runNovelTranslationStream(request, event => {
        if (state.taskId !== taskId || state.chapterKey !== chapterKey) return;
        if (event.type === "progress") {
          state.progress.textPhase = `流式翻译已完成 ${event.completed}/${event.total} 段…`;
          runtime.setNovelTextStatus?.("working", state.progress);
          return;
        }
        const item = chapter.paragraphs.find(candidate => candidate.paragraphKey === event.paragraphKey);
        const translated = String(event.record?.activeVersion?.translatedText || event.translation || "").trim();
        if (!item || !translated) return;
        state.translations.set(item.id, translated);
        state.translationSnapshots?.set(event.record.recordKey, event.record);
        runtime.renderNovelTranslation(item.node, translated, true);
        item.node.dataset.mtNovelStatus = "current";
        state.pendingParagraphs.delete(item.id);
        state.progress.textDone = chapter.paragraphs.filter(row => state.translations.has(row.id)).length;
        runtime.setNovelTextStatus?.("working", state.progress);
      });
      state.streamState = result.failed > 0 ? "paragraph-recovery" : "completed";
      return { supported: true, completed: Number(result.completed) || 0, result };
    } catch (error) {
      if (state.taskId !== taskId) return { supported: true, cancelled: true, completed: 0 };
      state.streamState = "unsupported";
      state.progress.textPhase = "流式不可用，正在切换渐进小批翻译…";
      runtime.setNovelTextStatus?.("working", state.progress);
      return { supported: false, completed: 0, error: runtime.getErrorMessage(error) };
    }
  }

  runtime.attemptNovelTranslationStream = attemptNovelTranslationStream;
}
