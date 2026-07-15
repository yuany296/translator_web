export function installCreatePipeline02(runtime, scope) {
  /**
   * 内部管线执行体（可被 inflight 合并）
   */
  async function executePipeline(target, identity, options) {
    const {
      scopedTargetKey,
      sourceToken,
      runId
    } = identity;
    const targetKey = scope.adapters.computeTargetKey(target);
    let ctx = runtime.createPageContext({
      targetKey,
      scopedTargetKey,
      sourceToken,
      runId
    });
    let renderPayload = null;
    scope.adapters.tracePipeline("pipeline-start", target, {
      runId,
      reason: options.reason
    });
    try {
      // =============================================
      // Phase 1: FETCH —— 提取图片数据
      // =============================================
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.FETCHING);

      // 校验作业身份（防止 DOM 复用后迟到任务覆盖新任务）
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, "sourceChanged before fetch");
      }
      const preTranslateSnapshot = scope.adapters.captureTargetSnapshot(target);
      ctx = runtime.updatePageContext(ctx, {
        snapshot: preTranslateSnapshot
      });
      scope.adapters.renderLoadingOverlay(target, targetKey, "提取图片...");
      const payload = await scope.adapters.extractTargetPayload(target, scopedTargetKey);
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, "sourceChanged after fetch");
      }
      ctx = runtime.updatePageContext(ctx, {
        payload
      });
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.FETCHED);

      // =============================================
      // Phase 2: STITCH —— 判断是否拼接并构建拼接 payload
      // =============================================
      renderPayload = payload;
      let stitchPayload = null;
      if (scope.adapters.shouldUseKakaoStitchedOcr(target, payload)) {
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.STITCHING);
        scope.adapters.renderLoadingOverlay(target, targetKey, "拼接相邻页...");
        stitchPayload = await scope.adapters.buildKakaoStitchedPayload(target, payload);
        if (!scope.isCurrentJob(target, identity)) {
          return scope.cancelJob(target, identity, "sourceChanged during stitching");
        }
        if (stitchPayload && stitchPayload.stitch) {
          renderPayload = stitchPayload;
        }
        ctx = runtime.updatePageContext(ctx, {
          stitchPayload
        });
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.STITCHED);
      }

      // =============================================
      // Phase 3: RECOGNIZE —— 调用 OCR/翻译
      // =============================================
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RECOGNIZING);
      scope.adapters.renderLoadingOverlay(target, targetKey, "模型翻译中...");
      let response = null;
      try {
        response = await scope.adapters.requestTranslationForPayload(renderPayload, runtime.buildOcrRequestKey(targetKey, renderPayload));
      } catch (error) {
        // 拼接失败时回退单图
        if (renderPayload && renderPayload.stitch && renderPayload.singleImagePayload) {
          scope.adapters.tracePipeline("stitch-fallback", target, {
            reason: "exception"
          });
          renderPayload = runtime.buildSingleFallbackPayload(renderPayload.singleImagePayload, renderPayload, "stitched request threw");
          response = await scope.adapters.requestTranslationForPayload(renderPayload, runtime.buildOcrRequestKey(targetKey, renderPayload));
        } else {
          throw error;
        }
      }

      // 请求失败时也回退
      if ((!response || !response.ok) && renderPayload && renderPayload.stitch && renderPayload.singleImagePayload) {
        scope.adapters.tracePipeline("stitch-fallback", target, {
          reason: "request failed"
        });
        renderPayload = runtime.buildSingleFallbackPayload(renderPayload.singleImagePayload, renderPayload, response && response.error ? response.error : "stitched request failed");
        response = await scope.adapters.requestTranslationForPayload(renderPayload, runtime.buildOcrRequestKey(targetKey, renderPayload));
      }
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "Translate request failed");
      }
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, "sourceChanged during recognition");
      }
      let result = runtime.normalizeResult(response.result);
      ctx = runtime.updatePageContext(ctx, {
        rawResult: result
      });

      // 拼接结果映射
      if (renderPayload && renderPayload.stitch) {
        if (typeof scope.adapters.mapStitchedResult === "function") {
          result = scope.adapters.mapStitchedResult(result, renderPayload, target, targetKey);
        } else {
          const targetRect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
          const sx = window.scrollX || 0;
          const sy = window.scrollY || 0;
          result = runtime.mapKakaoStitchedResult(result, renderPayload.stitch, targetRect, sx, sy);
        }
        ctx = runtime.updatePageContext(ctx, {
          mappedResult: result
        });

        // 回退检测
        const fallbackReason = runtime.shouldFallbackFromKakaoStitch(renderPayload, response.result, result);
        if (fallbackReason && renderPayload.singleImagePayload) {
          scope.adapters.tracePipeline("stitch-fallback", target, {
            reason: fallbackReason
          });
          renderPayload = runtime.buildSingleFallbackPayload(renderPayload.singleImagePayload, renderPayload, fallbackReason);
          response = await scope.adapters.requestTranslationForPayload(renderPayload, runtime.buildOcrRequestKey(targetKey, renderPayload));
          if (!response || !response.ok) {
            throw new Error("Single-image OCR fallback failed");
          }
          result = runtime.normalizeResult(response.result);
          ctx = runtime.updatePageContext(ctx, {
            rawResult: result,
            mappedResult: null
          });
        }
      }
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RECOGNIZED);

      // =============================================
      // Phase 4: DEDUPE —— 跨页去重
      // =============================================
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.DEDUPING);

      // 用串行化去重确保并发页面不会基于过期快照互相删除
      if (typeof scope.adapters.dedupeResult === "function") {
        result = await scope.adapters.dedupeResult(result, target, targetKey, scopedTargetKey);
      } else {
        const scrollX = window.scrollX || 0;
        const scrollY = window.scrollY || 0;
        result = await scope.store.runSerializedDedupe(() => runtime.executeDedupe(target, targetKey, scopedTargetKey, result, scrollX, scrollY, scope.store, scope.adapters));
      }
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, "sourceChanged during dedupe");
      }
      if (ctx.snapshot && typeof scope.adapters.isTargetSnapshotStillValid === "function" && !scope.adapters.isTargetSnapshotStillValid(target, ctx.snapshot)) {
        return scope.cancelJob(target, identity, "target changed during pipeline");
      }
      ctx = runtime.updatePageContext(ctx, {
        dedupedResult: result,
        renderPayload
      });
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.DEDUPED);

      // =============================================
      // Phase 5: RENDER —— 渲染结果
      // =============================================
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RENDERING);
      scope.adapters.renderLoadingOverlay(target, targetKey, "排版中...");
      if (typeof scope.adapters.renderPipelineResult === "function") {
        await scope.adapters.renderPipelineResult({
          target,
          targetKey,
          scopedTargetKey,
          result,
          payload: renderPayload,
          response,
          options,
          context: ctx
        });
      } else {
        runtime.releaseUncoveredShortPages(renderPayload, result, target, scope.store, scope.adapters);
        runtime.rememberLocalResult(scope.adapters, scopedTargetKey, result);
        if (result.bubbles.length > 0) {
          await scope.adapters.renderTranslationResult(target, targetKey, result, renderPayload, {
            stream: true
          });
          target.dataset.mtNoTextKey = "";
        } else {
          scope.adapters.clearRenderedTarget(target);
          target.dataset.mtNoTextKey = targetKey;
        }
        target.dataset.mtLastTranslatedKey = targetKey;
      }
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RENDERED);
      scope.adapters.tracePipeline("pipeline-end", target, {
        runId,
        bubbleCount: result.bubbles.length,
        ok: true
      });
      return {
        ok: true,
        bubbles: result.bubbles.length,
        cached: !!response.cached
      };
    } catch (error) {
      const reason = runtime.getErrorMessage(error);
      if (typeof scope.adapters.releaseAttachedShortPagesOnError === "function") {
        scope.adapters.releaseAttachedShortPagesOnError(ctx.stitchPayload || renderPayload, target, scopedTargetKey, ctx);
      }
      scope.adapters.clearRenderedTarget(target);
      if (runtime.isScreenshotTargetNotVisibleError(reason)) {
        scope.adapters.scheduleAutoTranslateRetry(target);
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RETRY_WAIT);
        return {
          ok: false,
          skipped: true,
          reason
        };
      }
      if (typeof scope.adapters.reportPipelineError === "function") {
        await scope.adapters.reportPipelineError(error, target, options);
      }
      scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.FAILED);
      scope.adapters.tracePipeline("pipeline-error", target, {
        runId,
        error: reason
      });
      return {
        ok: false,
        error: reason
      };
    } finally {
      scope.store.finishPageJob(scopedTargetKey, identity);
      scope.adapters.tracePipeline("pipeline-finally", target, {
        runId
      });
    }
  }
  scope.executePipeline = executePipeline;
  scope.result = {};
  Object.assign(scope.result, {
    store: scope.store,
    run: scope.run,
    runCached: scope.runCached,
    PagePhase: runtime.PagePhase,
    // 暴露纯函数供测试
    isVerifiedKakaoStitchNeighbor: runtime.isVerifiedKakaoStitchNeighbor,
    buildKakaoStitchWindowPlan: runtime.buildKakaoStitchWindowPlan,
    isAttachableKakaoShortPage: runtime.isAttachableKakaoShortPage,
    isKakaoPageEdgeFragment: runtime.isKakaoPageEdgeFragment,
    shouldRejectKakaoPageEdgeStitch: runtime.shouldRejectKakaoPageEdgeStitch,
    shouldFallbackFromKakaoStitch: runtime.shouldFallbackFromKakaoStitch,
    mapKakaoStitchedResult: runtime.mapKakaoStitchedResult,
    mapKakaoAdjacentBoundaryRect: runtime.mapKakaoAdjacentBoundaryRect,
    mapKakaoStitchedFillBox: runtime.mapKakaoStitchedFillBox,
    mapKakaoStitchedPolygon: runtime.mapKakaoStitchedPolygon,
    computeKakaoGlobalBox: runtime.computeKakaoGlobalBox,
    normalizeKakaoStitchSegments: runtime.normalizeKakaoStitchSegments,
    normalizeKakaoStitchDebugCoordinates: runtime.normalizeKakaoStitchDebugCoordinates,
    normalizeDebugCoordinateItems: runtime.normalizeDebugCoordinateItems,
    getKakaoStitchBestOverlap: runtime.getKakaoStitchBestOverlap,
    getKakaoStitchOwnerOverlap: runtime.getKakaoStitchOwnerOverlap,
    dedupeKakaoGlobalBubbles: runtime.runDedupeGlobalBubbles,
    trimKakaoBubbleBoundary: runtime.trimKakaoBubbleBoundary,
    sliceTextByNormalizedBoundary: runtime.sliceTextByNormalizedBoundary,
    isKakaoGlobalDuplicateCandidate: runtime.isKakaoGlobalDuplicateCandidate,
    isKakaoBoundaryNeighborBubble: runtime.isKakaoBoundaryNeighborBubble,
    isKakaoBoundaryOwnPair: runtime.isKakaoBoundaryOwnPair,
    areKakaoGlobalBoxesRelated: runtime.areKakaoGlobalBoxesRelated,
    areOcrTextsDuplicateOrContained: runtime.areOcrTextsDuplicateOrContained,
    hasSubstantialOcrTokenOverlap: runtime.hasSubstantialOcrTokenOverlap,
    getSubstantialOcrBoundaryOverlap: runtime.getSubstantialOcrBoundaryOverlap,
    getLongestCommonSubstringLength: runtime.getLongestCommonSubstringLength,
    getBubbleLineCount: runtime.getBubbleLineCount,
    textSimilarity: runtime.textSimilarity,
    normalizeOcrSimilarityText: runtime.normalizeOcrSimilarityText,
    findKakaoVerticalOverlap: runtime.findKakaoVerticalOverlap,
    hasUsableKakaoStripCaptureRect: runtime.hasUsableKakaoStripCaptureRect,
    hasAttachedShortPageBubble: runtime.hasAttachedShortPageBubble,
    filterOcrDebugFinalBubbles: runtime.filterOcrDebugFinalBubbles,
    syncOcrDebugFinalBubbles: runtime.syncOcrDebugFinalBubbles,
    createStore: runtime.createStore,
    canTransition: runtime.canTransition,
    isActivePhase: runtime.isActivePhase
  });
}
