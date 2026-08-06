export function installNovelWorkflow(runtime) {
  function getTranslatableParagraphs(chapter) {
    const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
    return chapter.paragraphs.filter(item => {
      const sourceLanguage = runtime.resolveSourceLanguage?.(item.original_text) || "auto";
      return String(item.original_text || "").trim() && (sourceLanguage === "auto" || sourceLanguage !== targetLanguage);
    });
  }

  function importRenderedTranslations(chapter, state) {
    chapter.paragraphs.forEach(item => {
      const node = item.node;
      const translation = node.querySelector?.(":scope > .mt-novel-translation");
      if (translation && String(translation.textContent || "").trim()) {
        state.translations.set(item.id, String(translation.textContent).trim());
      }
    });
  }

  function resetForChapter(chapter, state) {
    const chapterKey = `${chapter.scopeKey}:${chapter.chapterId}`;
    if (state.chapterKey === chapterKey) return;
    if (state.taskId) {
      runtime.cancelNovelTranslationStream?.(state.taskId);
      void runtime.sendRuntimeMessage({ type: "CANCEL_TRANSLATION_TASK", taskId: state.taskId }).catch(() => {});
      state.taskId = "";
    }
    state.chapterKey = chapterKey;
    state.translations.clear();
    state.memoryDeltas = [];
    state.textDiagnostics = [];
    state.cacheSavedIds.clear();
    state.pendingParagraphs.clear();
    state.streamState = "idle";
    state.cacheStatus = "none";
    state.lastTextErrors = [];
    state.imageJobs.clear();
    state.imageContexts.clear();
    runtime.clearNovelImagePanel?.(true);
    state.textStatus = "idle";
    state.imageStatus = "idle";
    state.showTranslation = false;
    Object.assign(state.progress, {
      textDone: 0,
      textTotal: 0,
      imageDone: 0,
      imageTotal: 0,
      textPhase: "",
      imagePhase: "",
      textDiagnostic: "",
      textWarning: "",
      textDiagnosticDetails: null
    });
  }

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

  function buildNovelRecordKey(chapter, item) {
    const normalized = runtime.normalizeTranslationCacheText(item.original_text);
    return runtime.buildNovelCacheRecordId(
      chapter.seriesId, chapter.chapterId,
      runtime.computeTranslationCacheHash(normalized), item.paragraphKey,
      runtime.resolveSourceLanguage?.(item.original_text) || "auto"
    );
  }
  runtime.buildNovelRecordKey = buildNovelRecordKey;
  runtime.resetNovelForChapter = resetForChapter;

  async function applyChunkTranslations(chapter, state, response, fingerprint) {
    for (const row of response?.translations || []) {
      const text = String(row?.translated_text || "").trim();
      if (!text) continue;
      const item = chapter.paragraphs.find(candidate => candidate.id === String(row.id));
      if (!item) continue;
      const recordKey = buildNovelRecordKey(chapter, item);
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

  async function translateNovelText(chapter, options = {}) {
    const state = runtime.getNovelState();
    state.taskId = `novel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const allItems = getTranslatableParagraphs(chapter);
    if (options.force) {
      state.translations.clear();
    } else {
      importRenderedTranslations(chapter, state);
      await runtime.applyCachedNovelTranslations?.(chapter, state);
    }
    const recordKeys = allItems.map(item => buildNovelRecordKey(chapter, item));
    const service = await runtime.ensureTranslationServiceOnline(recordKeys);
    state.serviceOnline = service.ok === true;
    if (!options.force) {
      const serverByKey = new Map((service.records || []).map(record => [record.recordKey, record]));
      allItems.forEach(item => {
        const snapshot = serverByKey.get(buildNovelRecordKey(chapter, item));
        const translated = String(snapshot?.activeVersion?.translatedText || "").trim();
        if (!translated) return;
        state.translations.set(item.id, translated);
        runtime.renderNovelTranslation(item.node, translated, true);
      });
    }
    let pending = allItems.filter(item => !state.translations.has(item.id));
    state.progress.textTotal = allItems.length;
    state.progress.textDone = allItems.length - pending.length;
    if (!pending.length) {
      state.textStatus = "complete";
      runtime.setNovelTextStatus?.("complete", state.progress);
      return { ok: true, completed: true, translated: allItems.length };
    }
    if (!service.ok) {
      state.textStatus = "partial";
      state.progress.textPhase = service.error || "本地服务未启动，当前仅显示已缓存译文";
      runtime.setNovelTextStatus?.("partial", state.progress);
      return { ok: false, offline: true, translated: state.translations.size, error: state.progress.textPhase };
    }
    state.textStatus = "working";
    state.progress.textPhase = "正在读取本书术语与前文记忆…";
    runtime.setNovelTextStatus?.("working", state.progress);
    let contextResponse = null;
    try {
      contextResponse = await runtime.sendRuntimeMessage({
        type: "GET_NOVEL_MEMORY",
        scopeKey: chapter.scopeKey,
        chapterId: chapter.chapterId,
        chapterOrder: chapter.chapterOrder
      });
    } catch {
      contextResponse = null;
    }
    const memoryRevision = Number(contextResponse?.context?.revision || 0);
    let chapterMemory = contextResponse?.context?.memory || {};
    let errors = [];
    const warnings = new Map();
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel");
    const stream = await runtime.attemptNovelTranslationStream(chapter, state, pending, fingerprint, {
      memory: chapterMemory, previousTranslation: buildChunkContext(allItems, pending, state).previousTranslation
    });
    if (stream.cancelled) return { ok: false, cancelled: true };
    pending = allItems.filter(item => !state.translations.has(item.id));
    if (pending.length && state.streamState !== "paragraph-recovery") state.streamState = "progressive-batch";
    for (const chunk of runtime.novelCore.buildChunks(pending)) {
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
          force: options.force === true,
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
        continue;
      }
      (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
      await applyChunkTranslations(chapter, state, response, fingerprint);
      if (response.memory_delta) {
        state.memoryDeltas.push(response.memory_delta);
        chapterMemory = runtime.novelMemoryCore.mergeMemory(chapterMemory, response.memory_delta);
      }
      errors.push(...(response.errors || []));
      state.progress.textDone = allItems.filter(item => state.translations.has(item.id)).length;
      state.progress.textPhase = `已完成 ${state.progress.textDone}/${state.progress.textTotal} 段，正在准备下一组…`;
      runtime.setNovelTextStatus?.("working", state.progress);
    }
    let missing = allItems.filter(item => !state.translations.has(item.id));
    if (missing.length) {
      const repairErrors = [];
      state.progress.textPhase = `正在逐段补齐 ${missing.length} 个漏译段落…`;
      runtime.setNovelTextStatus?.("working", state.progress);
      for (let index = 0; index < missing.length; index += 1) {
        const item = missing[index];
        state.progress.textPhase = `正在补齐漏译段落 ${index + 1}/${missing.length}…`;
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
            force: options.force === true,
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
          repairErrors.push({ id: item.id, error: response?.error || "repair_failed" });
          continue;
        }
        (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
        await applyChunkTranslations(chapter, state, response, fingerprint);
        if (response.memory_delta) {
          state.memoryDeltas.push(response.memory_delta);
          chapterMemory = runtime.novelMemoryCore.mergeMemory(chapterMemory, response.memory_delta);
        }
        repairErrors.push(...(response.errors || []));
        state.progress.textDone = allItems.filter(row => state.translations.has(row.id)).length;
        runtime.setNovelTextStatus?.("working", state.progress);
      }
      errors = repairErrors;
      missing = allItems.filter(item => !state.translations.has(item.id));
    }
    errors = errors.filter(error => missing.some(item => item.id === String(error.id)));
    const completed = missing.length === 0;
    const finalWarnings = [...warnings.values()]
      .filter(warning => state.translations.has(String(warning.id)));
    state.textStatus = completed ? "complete" : "partial";
    state.streamState = completed ? "completed" : "paragraph-recovery";
    state.progress.textPhase = completed
      ? "正文精翻完成"
      : `仍有 ${missing.length} 段未完成，再点小说球可继续补翻`;
    runtime.publishTextDiagnostics?.(state, errors, finalWarnings);
    state.showTranslation = true;
    runtime.setNovelTranslationVisibility(true);
    runtime.setNovelTextStatus?.(state.textStatus, state.progress);
    if (completed) {
      try {
        await runtime.sendRuntimeMessage({
          type: "SAVE_NOVEL_MEMORY",
          scopeKey: chapter.scopeKey,
          seriesId: chapter.seriesId,
          seriesTitle: chapter.seriesTitle,
          chapterId: chapter.chapterId,
          chapterTitle: chapter.chapterTitle,
          chapterOrder: chapter.chapterOrder,
          memoryDeltas: state.memoryDeltas
        });
      } catch (error) {
        await runtime.reportStatus("error", "novel memory save failed", {
          error: runtime.getErrorMessage(error),
          chapterId: chapter.chapterId
        });
      }
    }
    return { ok: completed, completed, translated: state.translations.size, errors, warnings: finalWarnings };
  }

  async function translateNovelChapter(options = {}) {
    const surface = runtime.reconcileKakaoNovelReader();
    const chapter = runtime.extractKakaoNovelChapter(surface);
    if (!chapter) return { ok: false, unavailable: true, error: "当前页面不是可识别的 Kakao 小说章节" };
    const state = runtime.getNovelState();
    resetForChapter(chapter, state);
    if (state.textStatus === "working") return { ok: true, reused: true };
    if (options.missingOnly && state.textStatus === "complete") {
      return { ok: true, completed: true, reused: true };
    }
    if (state.textStatus === "complete" && !options.force) {
      state.showTranslation = !state.showTranslation;
      runtime.setNovelTranslationVisibility(state.showTranslation);
      return { ok: true, toggled: true, showTranslation: state.showTranslation };
    }
    try {
      const result = await translateNovelText(chapter, { force: options.force === true });
      if (result && result.translated > 0) {
        // 异步旁路：翻译完成后采样已译段落做术语发现，不阻塞译文渲染。
        void runtime.scheduleNovelTermDiscovery?.(chapter);
      }
      // 仅重译正文时不动图片(图片强制重处理是独立入口)。
      if (options.textOnly !== true && state.serviceOnline && state.imageStatus === "idle") {
        void runtime.translateNovelImages(chapter).catch(error => {
          state.imageStatus = "partial";
          runtime.setNovelImageStatus?.("partial", state.progress, runtime.getErrorMessage(error));
        });
      }
      return result;
    } catch (error) {
      state.textStatus = "partial";
      runtime.setNovelTextStatus?.("partial", state.progress, runtime.getErrorMessage(error));
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.translateNovelChapter = translateNovelChapter;

  function onNovelSurfaceChanged(surface) {
    if (!surface) return;
    runtime.reapplyNovelTranslations(surface);
    runtime.reapplyNovelEmbeddedImages?.(surface);
    runtime.resumeNovelImagesIfIdle?.();
  }
  runtime.onNovelSurfaceChanged = onNovelSurfaceChanged;
}
