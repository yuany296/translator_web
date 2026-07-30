export function installNovelWorkflow(runtime) {
  function collectTextDiagnostics(state, response) {
    if (!Array.isArray(response && response.diagnostics)) return;
    state.textDiagnostics.push(...response.diagnostics);
    state.textDiagnostics = state.textDiagnostics.slice(-160);
  }

  function publishTextDiagnostics(state, finalErrors, finalWarnings) {
    const observedErrors = state.textDiagnostics.flatMap(item =>
      Array.isArray(item && item.validationErrors) ? item.validationErrors : []
    );
    const requestFailures = state.textDiagnostics
      .filter(item => ["request_failed", "parse_failed"].includes(item && item.status))
      .map(item => ({
        id: Array.isArray(item.itemIds) ? item.itemIds.join(",") : "",
        code: item.status,
        error: item.error || ""
      }));
    const summary = runtime.novelCore.summarizeTranslationErrors([
      ...observedErrors,
      ...requestFailures
    ]);
    const warningSummary = runtime.novelCore.summarizeTranslationWarnings(finalWarnings);
    state.lastTextErrors = runtime.novelCore.summarizeTranslationErrors(finalErrors).errors;
    state.progress.textDiagnostic = summary.text;
    state.progress.textWarning = warningSummary.text;
    state.progress.textDiagnosticDetails = {
      finalErrors: state.lastTextErrors,
      finalWarnings: warningSummary.warnings,
      observedErrors: summary.errors,
      attempts: state.textDiagnostics
    };
    console.info("[MangaTranslator] Novel text diagnostics", state.progress.textDiagnosticDetails);
  }

  function getTranslatableParagraphs(chapter) {
    return chapter.paragraphs.filter(item => /[\uac00-\ud7af]/u.test(item.original_text));
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
    state.chapterKey = chapterKey;
    state.translations.clear();
    state.memoryDeltas = [];
    state.textDiagnostics = [];
    state.lastTextErrors = [];
    state.imageJobs.clear();
    state.imageContexts.clear();
    runtime.clearNovelImagePanel?.(true);
    state.textStatus = "idle";
    state.imageStatus = "idle";
    state.showTranslation = true;
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

  function applyChunkTranslations(chapter, state, response) {
    for (const row of response?.translations || []) {
      const text = String(row?.translated_text || "").trim();
      if (!text) continue;
      state.translations.set(String(row.id), text);
      runtime.renderNovelTranslation(
        chapter.paragraphs.find(item => item.id === String(row.id))?.node,
        text,
        true
      );
    }
  }

  async function translateNovelText(chapter) {
    const state = runtime.getNovelState();
    const allItems = getTranslatableParagraphs(chapter);
    importRenderedTranslations(chapter, state);
    const pending = allItems.filter(item => !state.translations.has(item.id));
    state.progress.textTotal = allItems.length;
    state.progress.textDone = allItems.length - pending.length;
    if (!pending.length) {
      state.textStatus = "complete";
      runtime.setNovelTextStatus?.("complete", state.progress);
      return { ok: true, completed: true, translated: allItems.length };
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
          ...nearby,
          items: chunk.map(({ id, index, kind, original_text }) => ({
            id, index, kind, original_text
          }))
        });
      } catch (error) {
        response = { ok: false, error: runtime.getErrorMessage(error) };
      }
      collectTextDiagnostics(state, response);
      if (!response?.ok) {
        errors.push(...chunk.map(item => ({ id: item.id, error: response?.error || "translation_failed" })));
        continue;
      }
      (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
      applyChunkTranslations(chapter, state, response);
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
        collectTextDiagnostics(state, response);
        if (!response?.ok) {
          repairErrors.push({ id: item.id, error: response?.error || "repair_failed" });
          continue;
        }
        (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
        applyChunkTranslations(chapter, state, response);
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
    state.progress.textPhase = completed
      ? "正文精翻完成"
      : `仍有 ${missing.length} 段未完成，再点“文”可继续补翻`;
    publishTextDiagnostics(state, errors, finalWarnings);
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

  function buildNovelImageOptions(chapter, item, retry, memoryContext) {
    const options = {
      scopeKey: chapter.scopeKey,
      seriesId: chapter.seriesId,
      chapterId: chapter.chapterId,
      chapterOrder: chapter.chapterOrder,
      nearbyText: item.context.nearbyText,
      memoryRevision: Number(memoryContext?.revision || 0),
      memory: memoryContext?.memory || {}
    };
    runtime.getNovelState().imageContexts.set(item.contextId, options);
    return {
      manual: true,
      force: retry,
      relaxed: true,
      allowOffscreen: true,
      isolatedPage: true,
      renderMode: runtime.RENDER_MODE_EMBEDDED,
      reason: `novel-image:${item.contextId}`
    };
  }

  async function translateNovelImages(chapter, retry = false) {
    const state = runtime.getNovelState();
    const images = runtime.collectKakaoNovelImages(chapter.surface, chapter.paragraphs);
    const pending = images.filter(item => retry
      ? ["failed", "empty"].includes(state.imageJobs.get(item.target)?.status) || !state.imageJobs.has(item.target)
      : !state.imageJobs.has(item.target));
    state.progress.imageTotal = images.length;
    if (!pending.length) {
      state.imageStatus = images.some(item => state.imageJobs.get(item.target)?.status === "failed")
        ? "partial" : "complete";
      state.progress.imagePhase = state.imageStatus === "complete"
        ? "正文图片处理完成" : "部分正文图片处理失败";
      runtime.setNovelImageStatus?.(state.imageStatus, state.progress);
      return { ok: state.imageStatus === "complete", total: images.length };
    }
    state.imageStatus = "working";
    state.progress.imagePhase = `正在识别正文图片 0/${images.length}…`;
    runtime.setNovelImageStatus?.("working", state.progress);
    let memoryContext = null;
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "GET_NOVEL_MEMORY",
        scopeKey: chapter.scopeKey,
        chapterId: chapter.chapterId,
        chapterOrder: chapter.chapterOrder
      });
      memoryContext = response?.context || null;
    } catch {
      memoryContext = null;
    }
    const tasks = pending.map(item => async () => {
      state.imageJobs.set(item.target, { status: "working" });
      runtime.updateNovelImageResult?.(item, null, "working");
      const result = await runtime.translateTarget(
        item.target,
        buildNovelImageOptions(chapter, item, retry, memoryContext)
      );
      const summary = runtime.updateNovelImageResult?.(item, result) || {
        status: result?.ok ? "complete" : "failed",
        error: result?.error || result?.reason || ""
      };
      state.imageJobs.set(item.target, { status: summary.status, error: summary.error || "" });
      state.progress.imageDone = images.filter(image =>
        ["complete", "empty"].includes(state.imageJobs.get(image.target)?.status)
      ).length;
      state.progress.imagePhase = `正在识别正文图片 ${state.progress.imageDone}/${images.length}…`;
      runtime.setNovelImageStatus?.("working", state.progress);
      return result;
    });
    await runtime.runWithConcurrency(tasks, 2);
    const failed = images.filter(item => state.imageJobs.get(item.target)?.status === "failed");
    const empty = images.filter(item => state.imageJobs.get(item.target)?.status === "empty");
    state.imageStatus = failed.length ? "partial" : "complete";
    state.progress.imagePhase = failed.length
      ? `仍有 ${failed.length} 张正文图片失败`
      : "正文图片处理完成";
    runtime.setNovelImageStatus?.(state.imageStatus, state.progress);
    if (failed.length || empty.length) runtime.openNovelImagePanel?.();
    else runtime.renderNovelImagePanel?.(false);
    return { ok: failed.length === 0, total: images.length, failed: failed.length, empty: empty.length };
  }
  runtime.translateNovelImages = translateNovelImages;

  async function translateNovelChapter() {
    const surface = runtime.reconcileKakaoNovelReader();
    const chapter = runtime.extractKakaoNovelChapter(surface);
    if (!chapter) return { ok: false, unavailable: true, error: "当前页面不是可识别的 Kakao 小说章节" };
    const state = runtime.getNovelState();
    resetForChapter(chapter, state);
    if (state.textStatus === "working") return { ok: true, reused: true };
    if (state.textStatus === "complete") {
      state.showTranslation = !state.showTranslation;
      runtime.setNovelTranslationVisibility(state.showTranslation);
      return { ok: true, toggled: true, showTranslation: state.showTranslation };
    }
    if (state.imageStatus === "idle") {
      void translateNovelImages(chapter).catch(error => {
        state.imageStatus = "partial";
        runtime.setNovelImageStatus?.("partial", state.progress, runtime.getErrorMessage(error));
      });
    }
    try {
      return await translateNovelText(chapter);
    } catch (error) {
      state.textStatus = "partial";
      runtime.setNovelTextStatus?.("partial", state.progress, runtime.getErrorMessage(error));
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.translateNovelChapter = translateNovelChapter;

  async function retryNovelImages() {
    const surface = runtime.reconcileKakaoNovelReader();
    const chapter = runtime.extractKakaoNovelChapter(surface);
    if (!chapter) return { ok: false, unavailable: true };
    resetForChapter(chapter, runtime.getNovelState());
    if (runtime.getNovelState().imageStatus === "working") return { ok: true, reused: true };
    return translateNovelImages(chapter, true);
  }
  runtime.retryNovelImages = retryNovelImages;

  function getNovelImageTranslationOptions(reason) {
    const match = String(reason || "").match(/^novel-image:(.+)$/u);
    return match ? runtime.getNovelState().imageContexts.get(match[1]) || null : null;
  }
  runtime.getNovelImageTranslationOptions = getNovelImageTranslationOptions;

  function onNovelSurfaceChanged(surface) {
    if (!surface) return;
    runtime.reapplyNovelTranslations(surface);
    runtime.reapplyNovelEmbeddedImages?.(surface);
  }
  runtime.onNovelSurfaceChanged = onNovelSurfaceChanged;
}
