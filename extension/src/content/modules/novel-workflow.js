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
      // 全部命中缓存译文:首次点击直接显示已有译文并给出反馈,
      // 之后再次点击恢复原文(见 translateNovelChapter 的切换分支)。
      state.showTranslation = true;
      runtime.setNovelTranslationVisibility(true);
      runtime.setNovelTextStatus?.("complete", state.progress);
      return { ok: true, completed: true, translated: allItems.length, showTranslation: true };
    }
    if (!service.ok) {
      state.textStatus = "partial";
      state.progress.textPhase = service.error || "本地服务未启动，当前仅显示已缓存译文";
      // 服务离线但已有缓存译文时同样直接显示,与提示文案一致。
      if (state.translations.size > 0) {
        state.showTranslation = true;
        runtime.setNovelTranslationVisibility(true);
      }
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
      memory: chapterMemory,
      previousTranslation: runtime.buildNovelChunkContext(allItems, pending, state).previousTranslation
    });
    if (stream.cancelled) return { ok: false, cancelled: true };
    pending = allItems.filter(item => !state.translations.has(item.id));
    if (pending.length && state.streamState !== "paragraph-recovery") state.streamState = "progressive-batch";
    const progressive = await runtime.runNovelProgressiveTranslation({
      chapter,
      state,
      allItems,
      pending,
      chapterMemory,
      memoryRevision,
      force: options.force === true,
      fingerprint
    });
    errors = progressive.errors;
    progressive.warnings.forEach(warning => warnings.set(String(warning.id), warning));
    chapterMemory = progressive.chapterMemory;
    let missing = allItems.filter(item => !state.translations.has(item.id));
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
      // 已有完整译文:点击在 译文 ↔ 原文 之间切换(原文状态下图片一并还原)。
      state.showTranslation = !state.showTranslation;
      runtime.reapplyNovelTranslations?.(surface);
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
