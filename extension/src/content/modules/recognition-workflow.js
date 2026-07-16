export function installRecognitionWorkflow(runtime) {
  async function runCanonicalTarget(target, options, cached = false) {
    try {
      if (!runtime.kakaoCanonicalPipeline) throw new Error("Canonical pipeline is unavailable");
      const result = cached
        ? await runtime.kakaoCanonicalPipeline.runCached(target, null, options)
        : await runtime.kakaoCanonicalPipeline.run(target, options);
      if (result?.ok) {
        await runtime.reportStatus("info", "translation done", {
          reason: options?.reason,
          pageId: result.pageId || "",
          bubbles: Number(result.bubbles || 0),
          cached: result.cached === true || result.reused === true,
          pipeline: "canonical-v2"
        });
      }
      return result;
    } finally {
      runtime.clearKakaoLoadingOverlay(target);
    }
  }
  runtime.runKakaoCanonicalTarget = runCanonicalTarget;

  function validateTarget(target, options) {
    if (runtime.state.invalidated) throw new Error("Extension context invalidated");
    if (!runtime.isSupportedTarget(target) || !target.isConnected) {
      return { ok: false, skipped: true, reason: "target disconnected" };
    }
    if (!options.manual && !runtime.state.enabled) {
      return { ok: false, skipped: true, reason: "plugin disabled" };
    }
    if (!runtime.passesTargetFilter(target, options.manual, {
      relaxed: options.relaxed === true,
      allowOffscreen: options.allowOffscreen === true
    })) {
      if (runtime.IS_KAKAOPAGE_READER && runtime.state.autoTranslatePageEnabled && options.manual) {
        runtime.scheduleAutoTranslateRetry(target);
      }
      return { ok: false, skipped: true, reason: "filtered as non-manga target" };
    }
    return null;
  }

  function reuseInflight(target) {
    if (!runtime.state.inflightByTarget.has(target)) return null;
    const currentToken = runtime.getTargetExecutionToken(target);
    if (target.dataset.inflightSourceToken === currentToken) {
      runtime.tracePipeline("inflight-bypass", target, { skipReason: "sameSourceToken" });
      return runtime.state.inflightByTarget.get(target);
    }
    runtime.state.inflightByTarget.delete(target);
    delete target.dataset.inflightSourceToken;
    runtime.tracePipeline("inflight-bypass", target, { skipReason: "sourceTokenChanged" });
    return null;
  }

  function reuseRenderedTarget(target, targetKey, scopedTargetKey) {
    const targetId = runtime.getTargetId(target);
    const rendered = runtime.getExistingRenderedState(targetId);
    if (!rendered || rendered.targetKey !== targetKey) return null;
    if (runtime.isBackgroundImageTarget(target) && rendered.mode === "embedded") {
      runtime.restoreEmbeddedForTarget(target);
      return null;
    }
    if (rendered.mode === "embedded" && !runtime.isEmbeddedRenderStillApplied(rendered)) {
      runtime.state.embeddedById.delete(targetId);
      return null;
    }
    if (!runtime.isReusableRenderedState(rendered, runtime.hasSettledTranslatedMarker(target, targetKey, scopedTargetKey))) {
      return null;
    }
    runtime.syncOverlayPosition(rendered);
    return { ok: true, reused: true, bubbles: rendered.bubbleCount };
  }

  async function executeCanonicalTarget(target, options) {
    const targetKey = runtime.computeTargetKey(target);
    const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
    if (runtime.isScreenshotCaptureMode() && !runtime.getVisibleViewportRect(target)) {
      return { ok: false, skipped: true, reason: runtime.SCREENSHOT_TARGET_NOT_VISIBLE };
    }
    if (!options.force) {
      const reused = reuseRenderedTarget(target, targetKey, scopedTargetKey);
      if (reused) return reused;
      if (runtime.hasReusableKakaoPageOcr(target) || runtime.state.localResultCache.has(scopedTargetKey)) {
        return runCanonicalTarget(target, options, true);
      }
    }
    return runCanonicalTarget(target, options, false);
  }

  async function translateTarget(target, options = {}) {
    const invalid = validateTarget(target, options);
    if (invalid) return invalid;
    const inflight = reuseInflight(target);
    if (inflight) return inflight;
    const executionToken = runtime.getTargetExecutionToken(target);
    const task = executeCanonicalTarget(target, options).catch(async (error) => {
      const reason = runtime.getErrorMessage(error);
      runtime.clearKakaoLoadingOverlay(target);
      if (runtime.isScreenshotTargetNotVisibleError(reason)) {
        if (runtime.IS_KAKAOPAGE_READER && runtime.state.autoTranslatePageEnabled) {
          runtime.scheduleAutoTranslateRetry(target);
        }
        return { ok: false, skipped: true, reason };
      }
      if (!runtime.CONTEXT_INVALIDATED_RE.test(reason)) {
        await runtime.reportStatus("error", reason, {
          reason: options.reason,
          targetTag: target.tagName.toLowerCase()
        });
      }
      if (runtime.state.autoTranslatePageEnabled && target.isConnected) {
        target.dataset.mtRecoveryReqAt = String(Date.now());
      }
      return { ok: false, error: reason };
    });
    target.dataset.inflightSourceToken = executionToken;
    runtime.state.inflightByTarget.set(target, task);
    void task.finally(() => {
      if (runtime.state.inflightByTarget.get(target) === task) runtime.state.inflightByTarget.delete(target);
      if (target.dataset.inflightSourceToken === executionToken) delete target.dataset.inflightSourceToken;
    });
    return task;
  }
  runtime.translateTarget = translateTarget;

  async function preloadTargetPayload(target) {
    if (runtime.state.invalidated || !runtime.state.enabled || runtime.state.inflightByTarget.has(target)) return;
    if (!runtime.passesTargetFilter(target, false) || runtime.isScreenshotCaptureMode()) return;
    if (runtime.state.preloadInFlightByTarget.has(target)) return runtime.state.preloadInFlightByTarget.get(target);
    const task = (async () => {
      const targetKey = runtime.computeTargetKey(target);
      const scopedKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
      const payloadKey = runtime.buildKakaoCanonicalPayloadCacheKey(scopedKey, target);
      if (runtime.state.localResultCache.has(scopedKey) || runtime.getPayloadCache(payloadKey)) return;
      await runtime.extractTargetPayload(target, payloadKey, { skipKakaoStitch: true });
    })().finally(() => runtime.state.preloadInFlightByTarget.delete(target));
    runtime.state.preloadInFlightByTarget.set(target, task);
    return task;
  }
  runtime.preloadTargetPayload = preloadTargetPayload;
}
