export function installNovelImageWorkflow(runtime) {
  function buildOptions(chapter, item, retry, memoryContext, force = false) {
    const context = {
      scopeKey: chapter.scopeKey, seriesId: chapter.seriesId,
      chapterId: chapter.chapterId, chapterOrder: chapter.chapterOrder,
      nearbyText: item.context.nearbyText,
      memoryRevision: Number(memoryContext?.revision || 0),
      memory: memoryContext?.memory || {}
    };
    runtime.getNovelState().imageContexts.set(item.contextId, context);
    return {
      manual: true, force: retry || force, relaxed: true, allowOffscreen: true,
      isolatedPage: true, renderMode: runtime.RENDER_MODE_EMBEDDED,
      reason: `novel-image:${item.contextId}`
    };
  }

  async function translateNovelImages(chapter, retry = false, force = false) {
    const state = runtime.getNovelState();
    const images = runtime.collectKakaoNovelImages(chapter.surface, chapter.paragraphs);
    const pending = images.filter(item => force
      ? true
      : retry
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
      const result = await runtime.translateTarget(item.target, buildOptions(chapter, item, retry, memoryContext, force));
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
    if (failed.length === 0 && empty.length === 0) state.imageAutoResumeCount = 0;
    state.imageStatus = failed.length ? "partial" : "complete";
    state.progress.imagePhase = failed.length ? `仍有 ${failed.length} 张正文图片失败` : "正文图片处理完成";
    runtime.setNovelImageStatus?.(state.imageStatus, state.progress);
    if (failed.length || empty.length) runtime.openNovelImagePanel?.();
    else runtime.renderNovelImagePanel?.(false);
    return { ok: failed.length === 0, total: images.length, failed: failed.length, empty: empty.length };
  }
  runtime.translateNovelImages = translateNovelImages;

  runtime.retryNovelImages = async (force = false) => {
    const chapter = runtime.extractKakaoNovelChapter(runtime.reconcileKakaoNovelReader());
    if (!chapter) return { ok: false, unavailable: true };
    runtime.resetNovelForChapter(chapter, runtime.getNovelState());
    const state = runtime.getNovelState();
    if (state.imageStatus === "working") return { ok: true, reused: true };
    if (force) {
      // 强制重处理:先还原已嵌入图片,再清空任务与结果,全部重新 OCR。
      const content = chapter.surface && (chapter.surface.content || chapter.surface.root);
      if (content?.querySelectorAll) {
        [...content.querySelectorAll("img")].forEach(img => {
          if (img.dataset?.mtEmbeddedActive === "true" && runtime.isNovelContentImage?.(img)) {
            runtime.restoreEmbeddedForTarget(img);
          }
        });
      }
      state.imageJobs.clear();
      state.imageResults.clear();
    }
    return runtime.translateNovelImages(chapter, true, force);
  };

  runtime.getNovelImageTranslationOptions = reason => {
    const match = String(reason || "").match(/^novel-image:(.+)$/u);
    return match ? runtime.getNovelState().imageContexts.get(match[1]) || null : null;
  };

  // Kakao 小说阅读器是虚拟滚动列表：图片节点可能在 OCR 期间被重建/回收，
  // 收集到的旧节点会以 "target disconnected" 失败。这里在阅读器 mutation
  // 触发的 reconcile 里检测到可重试目标时自动补跑，避免用户手动反复重试。
  const NOVEL_IMAGE_RESUME_COOLDOWN_MS = 8000;
  const NOVEL_IMAGE_AUTO_RESUME_LIMIT = 3;

  function resumeNovelImagesIfIdle() {
    const state = runtime.getNovelState();
    if (!state || !state.surface) return;
    // 只有章节翻译流程已经跑过(正文完成/部分完成)时才自动补跑图片;
    // 刚进入小说页、尚未点击悬浮球时保持原图,不抢在译文之前替换。
    if (!["complete", "partial"].includes(state.textStatus)) return;
    if (state.imageStatus === "idle" || state.imageStatus === "working") return;
    if (Number(state.imageAutoResumeCount || 0) >= NOVEL_IMAGE_AUTO_RESUME_LIMIT) return;
    const now = Date.now();
    if (state.lastImageResumeAt && now - state.lastImageResumeAt < NOVEL_IMAGE_RESUME_COOLDOWN_MS) return;
    const chapter = runtime.extractKakaoNovelChapter(state.surface);
    if (!chapter || !chapter.images.length) return;
    const retryable = chapter.images.some(item => {
      const job = state.imageJobs.get(item.target);
      return !job || ["failed", "empty"].includes(job.status);
    });
    if (!retryable) return;
    state.lastImageResumeAt = now;
    state.imageAutoResumeCount = Number(state.imageAutoResumeCount || 0) + 1;
    void runtime.translateNovelImages(chapter, true);
  }
  runtime.resumeNovelImagesIfIdle = resumeNovelImagesIfIdle;
}
