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
  // 各批次共享同一份前文记忆与 previousTranslation,相互独立,因此同时并发
  // 3 条流式请求,把整章串行等待模型生成的时间压到接近三分之一。
  const DEFAULT_STREAM_ITEMS_PER_REQUEST = 50;
  const MAX_STREAM_ITEMS_PER_REQUEST = 150;
  const STREAM_BATCH_CONCURRENCY = 3;

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
    let cancelled = false;
    let firstFailed = false;
    let stop = false;
    // 并发两批同时进行，不能用"批次起点 + 本批完成数"推算展示（会双算/误导）；
    // 一律用真实已渲染译文数，避免看到某段范围就误以为前面的段落已经翻完。
    const streamProgressText = () =>
      `流式翻译中，已翻译 ${Number(state.progress.textDone) || 0}/${Number(state.progress.textTotal) || total} 段…`;
    const offsets = [];
    for (let offset = 0; offset < total; offset += batchLimit) offsets.push(offset);
    const runBatch = async start => {
      const batch = items.slice(start, start + batchLimit);
      state.progress.textPhase = streamProgressText();
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
            // 各批次完成数从 0 重新累计，不能按"批次起点 + 完成数"展示；
            // 统一用真实渲染数，避免并发时显示 55/150 这类虚高数字。
            state.progress.textPhase = streamProgressText();
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
          state.progress.textDone = chapter.paragraphs.filter(row => String(row.original_text || "").trim() && state.translations.has(row.id)).length;
          runtime.setNovelTextStatus?.("working", state.progress);
        });
        completed += Number(result.completed) || 0;
        failed += Number(result.failed) || 0;
        protocolErrors += Number(result.protocolErrors) || 0;
      } catch (error) {
        if (state.taskId !== taskId || state.chapterKey !== chapterKey) {
          cancelled = true;
          return;
        }
        lastError = runtime.getErrorMessage(error);
        // 首批失败说明流式不可用,切换渐进小批;后续批次失败则进入逐段补齐,
        // 且不再启动新的批次(与既有一旦失败即停的语义一致)。
        if (start === 0) {
          firstFailed = true;
          stop = true;
          return;
        }
        failed += batch.length;
        stop = true;
      }
    };
    await new Promise(resolve => {
      let inFlight = 0;
      let nextIndex = 0;
      const pump = () => {
        while (inFlight < STREAM_BATCH_CONCURRENCY && nextIndex < offsets.length && !stop) {
          const start = offsets[nextIndex];
          nextIndex += 1;
          inFlight += 1;
          void runBatch(start).finally(() => {
            inFlight -= 1;
            pump();
          });
        }
        if (inFlight === 0) resolve();
      };
      pump();
    });
    if (cancelled) return { supported: true, cancelled: true, completed };
    if (firstFailed) {
      state.streamState = "unsupported";
      state.progress.textPhase = "流式不可用，正在切换渐进小批翻译…";
      runtime.setNovelTextStatus?.("working", state.progress);
      return { supported: false, completed, error: lastError };
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
