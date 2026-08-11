export function installNovelProgressiveWorkflow(runtime) {
  // 渐进小批采用窗 2 有序流水线:chunk N+1 在 chunk N 的响应到达后立即发出,
  // 与 chunk N 的 commit/渲染重叠;上下文边界严格按 chunk 顺序推进,前后文一致。
  const PROGRESSIVE_CHUNK_CONCURRENCY = 2;
  // 逐段补齐的并行度;每段独立构建 nearby 上下文,结果按原顺序归并。
  const REPAIR_CONCURRENCY = 3;

  function buildChunkContext(allItems, chunk, state) {
    const firstIndex = allItems.findIndex(item => item.id === chunk[0].id);
    const lastIndex = allItems.findIndex(item => item.id === chunk.at(-1).id);
    return {
      previousTranslation: allItems.slice(0, firstIndex)
        .map(item => state.translations.get(item.id) || "").filter(Boolean).slice(-4).join("\n"),
      beforeText: allItems.slice(Math.max(0, firstIndex - 3), firstIndex)
        .map(item => item.original_text).join("\n"),
      afterText: allItems.slice(lastIndex + 1, lastIndex + 4)
        .map(item => item.original_text).join("\n")
    };
  }
  runtime.buildNovelChunkContext = buildChunkContext;

  async function applyChunkTranslations(chapter, state, response, fingerprint) {
    for (const row of response?.translations || []) {
      const text = String(row?.translated_text || "").trim();
      if (!text) continue;
      const item = chapter.paragraphs.find(candidate => candidate.id === String(row.id));
      if (!item) continue;
      const recordKey = runtime.buildNovelRecordKey(chapter, item);
      const operation = runtime.createTranslationOperation("commit_translation", recordKey, {
        mode: "novel", scopeKey: chapter.scopeKey, segmentKey: item.paragraphKey,
        workId: chapter.seriesId, chapterId: chapter.chapterId,
        rawSourceText: item.original_text,
        normalizedSourceText: runtime.normalizeTranslationCacheText(item.original_text),
        rawSourceHash: item.rawSourceHash,
        normalizedSourceHash: item.normalizedSourceHash,
        configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
        resolvedSourceLanguage: runtime.resolveSourceLanguage?.(item.original_text) || "auto",
        targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
        translatedText: text, source: "api", configFingerprint: fingerprint
      });
      const committed = await runtime.commitTranslationOperation(operation);
      const officialText = String(committed?.record?.activeVersion?.translatedText || text);
      state.translations.set(item.id, officialText);
      runtime.renderNovelTranslation(item.node, officialText, true);
      item.node.dataset.mtNovelStatus = committed?.pending ? "pending" : "current";
      if (committed?.pending) state.pendingParagraphs.add(item.id);
      else state.pendingParagraphs.delete(item.id);
    }
  }

  async function runNovelProgressiveTranslation({
    chapter,
    state,
    allItems,
    pending,
    chapterMemory,
    memoryRevision,
    force = false,
    fingerprint
  }) {
    const errors = [];
    const warnings = new Map();
    const chunks = runtime.novelCore.buildChunks(pending);
    let respondedChunkCount = 0;
    let nextChunkIndex = 0;
    let chunkInFlight = 0;
    let stopChunks = false;
    let chunkApplyError = null;
    let settleProgressiveChunks = null;
    const pumpProgressiveChunks = () => {
      while (chunkInFlight < PROGRESSIVE_CHUNK_CONCURRENCY && nextChunkIndex < chunks.length
        && !stopChunks && nextChunkIndex <= respondedChunkCount) {
        const index = nextChunkIndex;
        nextChunkIndex += 1;
        chunkInFlight += 1;
        void processProgressiveChunk(index).catch(error => {
          chunkApplyError = chunkApplyError || error;
          stopChunks = true;
        }).finally(() => {
          chunkInFlight -= 1;
          pumpProgressiveChunks();
        });
      }
      if (chunkInFlight === 0 && settleProgressiveChunks) settleProgressiveChunks();
    };
    const processProgressiveChunk = async index => {
      const chunk = chunks[index];
      const firstOrdinal = allItems.findIndex(item => item.id === chunk[0].id) + 1;
      const lastOrdinal = allItems.findIndex(item => item.id === chunk.at(-1).id) + 1;
      state.progress.textPhase = `正在精翻第 ${firstOrdinal}–${lastOrdinal} 段…`;
      runtime.setNovelTextStatus?.("working", state.progress);
      const nearby = buildChunkContext(allItems, chunk, state);
      let response;
      try {
        response = await runtime.sendRuntimeMessage({
          type: "TRANSLATE_NOVEL_CHUNK",
          scopeKey: chapter.scopeKey,
          seriesId: chapter.seriesId,
          chapterId: chapter.chapterId,
          chapterTitle: chapter.chapterTitle,
          chapterOrder: chapter.chapterOrder,
          memoryRevision,
          memory: chapterMemory,
          force,
          taskId: state.taskId,
          sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
          targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
          ...nearby,
          items: chunk.map(({ id, index, kind, original_text }) => ({
            id, index, kind, original_text
          }))
        });
      } catch (error) {
        response = { ok: false, error: runtime.getErrorMessage(error) };
      }
      runtime.collectTextDiagnostics?.(state, response);
      if (!response?.ok) {
        errors.push(...chunk.map(item => ({ id: item.id, error: response?.error || "translation_failed" })));
        stopChunks = true;
        return;
      }
      (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
      errors.push(...(response.errors || []));
      // 响应到达即推进上下文边界:译文与记忆先并入,再放行下一 chunk,
      // 让它的 LLM 请求与本次 commit/渲染重叠执行;上下文仍按 chunk 顺序可见。
      for (const row of response.translations || []) {
        const text = String(row && row.translated_text || "").trim();
        if (text) state.translations.set(String(row.id), text);
      }
      if (response.memory_delta) {
        state.memoryDeltas.push(response.memory_delta);
        chapterMemory = runtime.novelMemoryCore.mergeMemory(chapterMemory, response.memory_delta);
      }
      respondedChunkCount = Math.max(respondedChunkCount, index + 1);
      pumpProgressiveChunks();
      try {
        await applyChunkTranslations(chapter, state, response, fingerprint);
      } catch (error) {
        chunkApplyError = chunkApplyError || error;
        stopChunks = true;
        return;
      }
      state.progress.textDone = allItems.filter(item => state.translations.has(item.id)).length;
      state.progress.textPhase = `已完成 ${state.progress.textDone}/${state.progress.textTotal} 段，正在准备下一组…`;
      runtime.setNovelTextStatus?.("working", state.progress);
    };
    await new Promise(resolve => {
      settleProgressiveChunks = resolve;
      pumpProgressiveChunks();
    });
    if (chunkApplyError) throw chunkApplyError;
    let missing = allItems.filter(item => !state.translations.has(item.id));
    if (missing.length) {
      const repairErrors = [];
      state.progress.textPhase = `正在逐段补齐 ${missing.length} 个漏译段落…`;
      runtime.setNovelTextStatus?.("working", state.progress);
      const repairs = missing.map(item => async () => {
        state.progress.textPhase = `正在补齐漏译段落…`;
        runtime.setNovelTextStatus?.("working", state.progress);
        const nearby = buildChunkContext(allItems, [item], state);
        let response;
        try {
          response = await runtime.sendRuntimeMessage({
            type: "TRANSLATE_NOVEL_CHUNK",
            scopeKey: chapter.scopeKey,
            seriesId: chapter.seriesId,
            chapterId: chapter.chapterId,
            chapterTitle: chapter.chapterTitle,
            chapterOrder: chapter.chapterOrder,
            memoryRevision,
            memory: chapterMemory,
            force,
            taskId: state.taskId,
            sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
            targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
            ...nearby,
            items: [{
              id: item.id,
              index: item.index,
              kind: item.kind,
              original_text: item.original_text
            }]
          });
        } catch (error) {
          response = { ok: false, error: runtime.getErrorMessage(error) };
        }
        runtime.collectTextDiagnostics?.(state, response);
        if (!response?.ok) {
          return { id: item.id, ok: false, error: response?.error || "repair_failed" };
        }
        (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
        await applyChunkTranslations(chapter, state, response, fingerprint);
        state.progress.textDone = allItems.filter(row => state.translations.has(row.id)).length;
        runtime.setNovelTextStatus?.("working", state.progress);
        return {
          id: item.id,
          ok: true,
          memoryDelta: response.memory_delta || null,
          errors: response.errors || []
        };
      });
      const repairResults = await runtime.runWithConcurrency(repairs, REPAIR_CONCURRENCY);
      // 结果按 missing 原顺序返回,memory_delta 依序归并,章节记忆保持确定性。
      for (const result of repairResults) {
        if (!result || result.ok === false) {
          repairErrors.push({
            id: result && result.id || "",
            error: result && result.error || "repair_failed"
          });
          continue;
        }
        if (result.memoryDelta) {
          state.memoryDeltas.push(result.memoryDelta);
          chapterMemory = runtime.novelMemoryCore.mergeMemory(chapterMemory, result.memoryDelta);
        }
        repairErrors.push(...(result.errors || []));
      }
      errors.push(...repairErrors);
    }
    return { errors, warnings: [...warnings.values()], chapterMemory };
  }
  runtime.runNovelProgressiveTranslation = runNovelProgressiveTranslation;
}
