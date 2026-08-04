export function installNovelImageWorkflow(runtime) {
  function buildOptions(chapter, item, retry, memoryContext) {
    const context = {
      scopeKey: chapter.scopeKey, seriesId: chapter.seriesId,
      chapterId: chapter.chapterId, chapterOrder: chapter.chapterOrder,
      nearbyText: item.context.nearbyText,
      memoryRevision: Number(memoryContext?.revision || 0),
      memory: memoryContext?.memory || {}
    };
    runtime.getNovelState().imageContexts.set(item.contextId, context);
    return {
      manual: true, force: retry, relaxed: true, allowOffscreen: true,
      isolatedPage: true, renderMode: runtime.RENDER_MODE_EMBEDDED,
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
        type: "GET_NOVEL_MEMORY", scopeKey: chapter.scopeKey,
        chapterId: chapter.chapterId, chapterOrder: chapter.chapterOrder
      });
      memoryContext = response?.context || null;
    } catch {
      memoryContext = null;
    }
    const tasks = pending.map(item => async () => {
      state.imageJobs.set(item.target, { status: "working" });
      runtime.updateNovelImageResult?.(item, null, "working");
      const result = await runtime.translateTarget(item.target, buildOptions(chapter, item, retry, memoryContext));
      const summary = runtime.updateNovelImageResult?.(item, result) || {
        status: result?.ok ? "complete" : "failed", error: result?.error || result?.reason || ""
      };
      state.imageJobs.set(item.target, { status: summary.status, error: summary.error || "" });
      state.progress.imageDone = images.filter(image =>
        ["complete", "empty"].includes(state.imageJobs.get(image.target)?.status)).length;
      state.progress.imagePhase = `正在识别正文图片 ${state.progress.imageDone}/${images.length}…`;
      runtime.setNovelImageStatus?.("working", state.progress);
      return result;
    });
    await runtime.runWithConcurrency(tasks, 2);
    const failed = images.filter(item => state.imageJobs.get(item.target)?.status === "failed");
    const empty = images.filter(item => state.imageJobs.get(item.target)?.status === "empty");
    state.imageStatus = failed.length ? "partial" : "complete";
    state.progress.imagePhase = failed.length ? `仍有 ${failed.length} 张正文图片失败` : "正文图片处理完成";
    runtime.setNovelImageStatus?.(state.imageStatus, state.progress);
    if (failed.length || empty.length) runtime.openNovelImagePanel?.();
    else runtime.renderNovelImagePanel?.(false);
    return { ok: failed.length === 0, total: images.length, failed: failed.length, empty: empty.length };
  }
  runtime.translateNovelImages = translateNovelImages;

  runtime.retryNovelImages = async () => {
    const chapter = runtime.extractKakaoNovelChapter(runtime.reconcileKakaoNovelReader());
    if (!chapter) return { ok: false, unavailable: true };
    runtime.resetNovelForChapter(chapter, runtime.getNovelState());
    if (runtime.getNovelState().imageStatus === "working") return { ok: true, reused: true };
    return translateNovelImages(chapter, true);
  };

  runtime.getNovelImageTranslationOptions = reason => {
    const match = String(reason || "").match(/^novel-image:(.+)$/u);
    return match ? runtime.getNovelState().imageContexts.get(match[1]) || null : null;
  };
}
