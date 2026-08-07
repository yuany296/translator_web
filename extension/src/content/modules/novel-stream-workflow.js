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

  // 服务端 /translations/stream 单次请求有 200 段上限(超出返回 422 too_long);
  // 默认按 50 段分批发送(设置项 novelStreamBatchSize 可调),每个请求结果一到就
  // 逐段替换,避免整章打包成一次请求导致结果集中到达、整章一次替换。
  const DEFAULT_STREAM_ITEMS_PER_REQUEST = 50;
  const MAX_STREAM_ITEMS_PER_REQUEST = 150;

  function resolveStreamBatchLimit(runtime) {
    const configured = Number(runtime.state?.novelStreamBatchSize);
    if (!Number.isFinite(configured)) return DEFAULT_STREAM_ITEMS_PER_REQUEST;
    return Math.min(MAX_STREAM_ITEMS_PER_REQUEST, Math.max(5, Math.floor(configured)));
  }

  async function attemptNovelTranslationStream(chapter, state, items, fingerprint, context = {}) {
    if (!items.length || !runtime.runNovelTranslationStream) return { supported: false, completed: 0 };
    const taskId = state.taskId;
    const chapterKey = state.chapterKey;
    state.streamState = "streaming";
    state.progress.textPhase = "正在建立逐段流式翻译…";
    runtime.setNovelTextStatus?.("working", state.progress);
    const requestBase = {
      taskId, scopeKey: chapter.scopeKey,
      sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
      targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
      configFingerprint: fingerprint,
      context: {
        chapterTitle: chapter.chapterTitle, memory: context.memory || {},
        previousTranslation: context.previousTranslation || ""
      }
    };
    const total = items.length;
    const batchLimit = resolveStreamBatchLimit(runtime);
    let completed = 0;
    let failed = 0;
    let protocolErrors = 0;
    let lastError = "";
    for (let offset = 0; offset < total; offset += batchLimit) {
      const batch = items.slice(offset, offset + batchLimit);
      state.progress.textPhase = `流式翻译第 ${offset + 1}–${Math.min(total, offset + batch.length)} 段…`;
      runtime.setNovelTextStatus?.("working", state.progress);
      const request = {
        ...requestBase,
        items: batch.map(item => ({
          id: item.id, paragraphKey: item.paragraphKey,
          recordKey: runtime.buildNovelRecordKey(chapter, item),
          originalText: item.original_text, recordPayload: recordPayload(chapter, item)
        }))
      };
      try {
        const result = await runtime.runNovelTranslationStream(request, event => {
          if (state.taskId !== taskId || state.chapterKey !== chapterKey) return;
          if (event.type === "progress") {
            state.progress.textPhase = `流式翻译已完成 ${completed + event.completed}/${total} 段…`;
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
        completed += Number(result.completed) || 0;
        failed += Number(result.failed) || 0;
        protocolErrors += Number(result.protocolErrors) || 0;
      } catch (error) {
        if (state.taskId !== taskId) return { supported: true, cancelled: true, completed };
        lastError = runtime.getErrorMessage(error);
        // 首批失败说明流式不可用,切换渐进小批;后续批次失败则进入逐段补齐。
        if (offset === 0) {
          state.streamState = "unsupported";
          state.progress.textPhase = "流式不可用，正在切换渐进小批翻译…";
          runtime.setNovelTextStatus?.("working", state.progress);
          return { supported: false, completed, error: lastError };
        }
        failed += batch.length;
        break;
      }
      if (state.taskId !== taskId) return { supported: true, cancelled: true, completed };
    }
    state.streamState = failed > 0 ? "paragraph-recovery" : "completed";
    return {
      supported: true, completed, failed, protocolErrors,
      result: { completed, failed, total, protocolErrors },
      ...(lastError ? { error: lastError } : {})
    };
  }

  runtime.attemptNovelTranslationStream = attemptNovelTranslationStream;
}
