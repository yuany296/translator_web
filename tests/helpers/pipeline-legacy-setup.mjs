export function installPipelineLegacySetup(runtime, scope) {
  if (!scope.adapters) throw new Error("KakaoPipeline: adapters required");

  // 校验必须的 adapter 方法
  const required = ["extractTargetPayload", "requestTranslationForPayload", "renderTranslationResult", "clearRenderedTarget", "renderOverlay", "computeTargetKey", "getQuickSourceToken", "buildTargetSourceCacheKey", "captureTargetSnapshot", "renderLoadingOverlay", "shouldUseKakaoStitchedOcr", "buildKakaoStitchedPayload", "tracePipeline", "scheduleAutoTranslateRetry"];
  scope.required = required;
  for (const name of scope.required) {
    if (typeof scope.adapters[name] !== "function") {
      throw new Error(`KakaoPipeline: missing adapter "${name}"`);
    }
  }
  const store = scope.adapters.store || runtime.createStore();

  /** 生成唯一 runId */
  scope.store = store;
  let runSeq = 0;
  scope.runSeq = runSeq;
  function nextRunId() {
    scope.runSeq += 1;
    return `run-${scope.runSeq}-${Date.now()}`;
  }

  /** 检查作业身份是否仍然有效 */
  scope.nextRunId = nextRunId;
  function isCurrentJob(target, identity) {
    if (!target || !target.isConnected) return false;
    if (!scope.store.isCurrentPageJob(identity.scopedTargetKey, identity)) return false;
    const currentSource = scope.adapters.getQuickSourceToken(target);
    if (currentSource !== identity.sourceToken) return false;
    const currentKey = scope.adapters.buildTargetSourceCacheKey(scope.adapters.computeTargetKey(target), currentSource);
    return currentKey === identity.scopedTargetKey;
  }
  scope.isCurrentJob = isCurrentJob;
  function cancelJob(target, identity, reason) {
    if (target) {
      scope.adapters.tracePipeline("cancelled", target, {
        runId: identity.runId,
        reason
      });
    }
    if (scope.store.isCurrentPageJob(identity.scopedTargetKey, identity)) {
      scope.store.cancelPageJob(identity.scopedTargetKey);
    }
    return {
      ok: false,
      skipped: true,
      reason: `cancelled:${reason}`
    };
  }

  /**
   * 运行一个页面的翻译管线
   * @param {Element} target
   * @param {object} options
   * @param {string} options.reason
   * @param {boolean} [options.force]
   */
  scope.cancelJob = cancelJob;
  function run(target, options = {}) {
    const targetKey = scope.adapters.computeTargetKey(target);
    const sourceToken = scope.adapters.getQuickSourceToken(target);
    const scopedTargetKey = scope.adapters.buildTargetSourceCacheKey(targetKey, sourceToken);
    return scope.store.getOrCreateInflightJob(scopedTargetKey, () => {
      if (scope.store.getPagePhase(scopedTargetKey) !== runtime.PagePhase.WAITING) {
        scope.store.resetPagePhase(scopedTargetKey);
      }
      const identity = {
        scopedTargetKey,
        sourceToken,
        runId: scope.nextRunId()
      };
      scope.store.beginPageJob(scopedTargetKey, identity);
      return scope.executePipeline(target, identity, options);
    });
  }
  scope.run = run;
  function runCached(target, cachedResult, options = {}) {
    const targetKey = scope.adapters.computeTargetKey(target);
    const sourceToken = scope.adapters.getQuickSourceToken(target);
    const scopedTargetKey = scope.adapters.buildTargetSourceCacheKey(targetKey, sourceToken);
    return scope.store.getOrCreateInflightJob(scopedTargetKey, async () => {
      if (scope.store.getPagePhase(scopedTargetKey) !== runtime.PagePhase.WAITING) {
        scope.store.resetPagePhase(scopedTargetKey);
      }
      const identity = {
        scopedTargetKey,
        sourceToken,
        runId: scope.nextRunId()
      };
      scope.store.beginPageJob(scopedTargetKey, identity);
      try {
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.DEDUPING);
        const result = typeof scope.adapters.dedupeResult === "function" ? await scope.adapters.dedupeResult(cachedResult, target, targetKey, scopedTargetKey) : cachedResult;
        if (!scope.isCurrentJob(target, identity)) {
          return scope.cancelJob(target, identity, "sourceChanged during cached dedupe");
        }
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.DEDUPED);
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RENDERING);
        if (typeof scope.adapters.renderCachedPipelineResult === "function") {
          await scope.adapters.renderCachedPipelineResult({
            target,
            targetKey,
            scopedTargetKey,
            result,
            options
          });
        } else if (result && Array.isArray(result.bubbles) && result.bubbles.length > 0) {
          await scope.adapters.renderTranslationResult(target, targetKey, result, null);
        } else {
          scope.adapters.clearRenderedTarget(target);
        }
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.RENDERED);
        return {
          ok: true,
          reused: true,
          bubbles: result && Array.isArray(result.bubbles) ? result.bubbles.length : 0
        };
      } catch (error) {
        scope.store.transitionPagePhase(scopedTargetKey, runtime.PagePhase.FAILED);
        if (typeof scope.adapters.reportPipelineError === "function") {
          await scope.adapters.reportPipelineError(error, target, options);
        }
        return {
          ok: false,
          error: runtime.getErrorMessage(error)
        };
      } finally {
        scope.store.finishPageJob(scopedTargetKey, identity);
      }
    });
  }

  /**
   * 内部管线执行体（可被 inflight 合并）
   */
  scope.runCached = runCached;
}
