export function installStorePipelineContext(runtime) {
  /* =================================================================
   * PageContext — 阶段间传递的不可变数据载体
   * ================================================================= */
  function createPageContext({
    targetKey,
    scopedTargetKey,
    sourceToken,
    runId
  }) {
    return Object.freeze({
      targetKey,
      scopedTargetKey,
      sourceToken,
      runId,
      /** 进入下一阶段的快照数据，由各阶段设置 */
      snapshot: null,
      payload: null,
      stitchPayload: null,
      rawResult: null,
      mappedResult: null,
      dedupedResult: null,
      renderPayload: null,
      error: null,
      diagnostics: Object.freeze({})
    });
  }

  /** 每个阶段都返回新的冻结上下文，禁止通过共享对象传递中间状态。 */
  runtime.createPageContext = createPageContext;
  function updatePageContext(context, patch) {
    return Object.freeze({
      ...context,
      ...patch
    });
  }

  /** 封装 Kakao 自动重试计时器，调用方只提供页面相关判断。 */
  runtime.updatePageContext = updatePageContext;
  function createRetryScheduler({
    store,
    setTimer,
    clearTimer,
    isPlaceholder,
    isTargetUsable,
    isTargetReady,
    onReady,
    delayMs = 1200,
    maxDelayMs = 20000,
    maxAttempts = 5
  }) {
    function schedule(target) {
      const current = store.getRetryState(target);
      if (current && current.timer || isPlaceholder(target)) {
        return false;
      }
      const attempts = Number(current && current.attempts || 0);
      if (attempts >= maxAttempts) {
        return false;
      }
      store.setRetryState(target, {
        timer: null,
        attempts: attempts + 1,
        retries: Number(current && current.retries || 0)
      });
      scheduleNext(target, delayMs);
      return true;
    }
    function scheduleNext(target, waitMs) {
      const current = store.getRetryState(target);
      if (current && current.timer) {
        return;
      }
      const timer = setTimer(() => {
        const fired = store.clearRetryState(target) || current || {
          attempts: 0,
          retries: 0
        };
        if (!isTargetUsable(target) || isPlaceholder(target)) {
          return;
        }
        if (isTargetReady(target)) {
          onReady(target);
          return;
        }
        const retries = Number(fired.retries || 0) + 1;
        store.setRetryState(target, {
          timer: null,
          attempts: Number(fired.attempts || 0),
          retries
        });
        scheduleNext(target, Math.min(delayMs * Math.pow(2, retries - 1), maxDelayMs));
      }, waitMs);
      store.setRetryState(target, {
        timer,
        attempts: Number(current && current.attempts || 0),
        retries: Number(current && current.retries || 0)
      });
    }
    function cancel(target) {
      const current = store.clearRetryState(target);
      if (current && current.timer) {
        clearTimer(current.timer);
      }
    }
    function clear() {
      store.clearRetryStates(clearTimer);
    }
    return Object.freeze({
      schedule,
      cancel,
      clear
    });
  }
  runtime.createRetryScheduler = createRetryScheduler;
  function getShortPageAttachmentGate(store, target, now = Date.now()) {
    const attachment = store.getShortPageAttachment(target);
    if (!attachment || !attachment.ownerKey) {
      return Object.freeze({
        blocked: false,
        timedOut: false,
        ownerKey: ""
      });
    }
    if (now - attachment.attachedAt > runtime.KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS) {
      store.releaseShortPage(target, attachment.ownerKey, now);
      return Object.freeze({
        blocked: false,
        timedOut: true,
        ownerKey: attachment.ownerKey
      });
    }
    return Object.freeze({
      blocked: true,
      timedOut: false,
      ownerKey: attachment.ownerKey
    });
  }
  runtime.getShortPageAttachmentGate = getShortPageAttachmentGate;
  function attachShortPageIfAllowed(store, target, ownerKey, now = Date.now()) {
    const previous = store.getShortPageAttachment(target);
    if (previous && previous.detachedOwnerKey === ownerKey && now - previous.detachedAt <= runtime.KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS) {
      return false;
    }
    store.attachShortPage(target, ownerKey, now);
    return true;
  }
  runtime.attachShortPageIfAllowed = attachShortPageIfAllowed;
  function releaseShortPagesForOwner(store, candidates, ownerKey, now = Date.now()) {
    const released = [];
    for (const target of Array.isArray(candidates) ? candidates : []) {
      const attachment = store.getShortPageAttachment(target);
      if (!attachment || attachment.ownerKey !== ownerKey) {
        continue;
      }
      store.releaseShortPage(target, ownerKey, now);
      released.push(target);
    }
    return released;
  }

  /* =================================================================
   * Pipeline — 五阶段编排器
   * ================================================================= */
  /**
   * @param {object} adapters — content.js 注入的 DOM/通信/渲染能力
   *
   * 必须的 adapter 接口：
   *   extractTargetPayload(target, scopedKey) → payload
   *   requestOcrForPayload(payload, meta) → provider-neutral observations
   *   requestCanonicalTranslations(items, meta) → text-only translations
   *   renderTranslationResult(target, targetKey, result, payload, opts)
   *   clearRenderedTarget(target)
   *   renderOverlay(target, targetKey, result)
   *   buildTargetSourceCacheKey(targetKey, sourceToken) → string
   *   computeTargetKey(target) → string
   *   getQuickSourceToken(target) → string
   *   collectKakaopageManualTargetCandidates(all, target) → Element[]
   *   extractAdjacentKakaoPayload(target) → payload
   *   loadImageFromDataUrl(dataUrl) → Image
   *   buildKakaoStitchedPayload(target, basePayload) → stitchedPayload | null
   *   findTargetByScopedKey(scopedKey) → Element | null
   *   queueTranslate(target, opts)
   *   queuePageAutoTranslate(target)
   *   scheduleAutoTranslateRetry(target)
   *   tracePipeline(stage, target, data)
   *   getVisibleViewportRect(target) → rect | null
   *   captureTargetSnapshot(target) → snapshot
   *   isTargetSnapshotStillValid(target, snapshot) → boolean
   *   shouldUseEmbeddedRender(target) → boolean
   *   getPayloadCache(key) → payload | null
   *   state.localResultCache (Map, 用于 rememberLocalResult 等)
   *   state.inflightByTarget (WeakMap, 用于并发控制)
   */
  runtime.releaseShortPagesForOwner = releaseShortPagesForOwner;
}
