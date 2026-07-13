(() => {
  const existing = globalThis.__MANGA_TRANSLATOR_V3__;
  if (existing && !existing.invalidated) {
    if (typeof existing.rescan === "function") {
      existing.rescan();
    }
    return;
  }

  const IS_PIXIV_COMIC_VIEWER =
    /(^|\.)comic\.pixiv\.net$/i.test(location.hostname) && /^\/viewer\/stories\/\d+/i.test(location.pathname);
  const IS_KAKAOPAGE_READER =
    /(^|\.)page\.kakao\.com$/i.test(location.hostname) ||
    /(^|\.)kakaopage\.com$/i.test(location.hostname) ||
    /(^|\.)page\.kakaocdn\.net$/i.test(location.hostname);
  const TARGET_SELECTOR =
    IS_PIXIV_COMIC_VIEWER || IS_KAKAOPAGE_READER ? "img, canvas, [id^='page-'], [style*='background-image']" : "img, canvas";
  const PIXIV_PAGE_ID_RE = /^page-\d+$/;
  const PIXIV_PLACEHOLDER_BACKGROUND_RE = /\/images\/blank\.png|border_logo\.png/i;
  const AUTO_MIN_WIDTH = 80;
  const AUTO_MIN_HEIGHT = 80;
  const AUTO_MIN_RATIO = 0.10;
  const MANUAL_MIN_WIDTH = 60;
  const MANUAL_MIN_HEIGHT = 60;
  const MAX_MANUAL_TARGETS = 4;
  const MAX_PARALLEL_TRANSLATIONS = IS_KAKAOPAGE_READER ? 6 : 3;
  const MANUAL_PARALLEL_TRANSLATIONS = 3;
  const MAX_PRELOAD_JOBS = 2;
  const PRELOAD_ROOT_MARGIN = "1400px 0px";
  const AGGRESSIVE_PRELOAD_JOBS = 5;
  const AGGRESSIVE_PRELOAD_ROOT_MARGIN = "3200px 0px";
  const AGGRESSIVE_PRELOAD_BATCH = 12;
  const AGGRESSIVE_PRELOAD_SWEEP_GAP_MS = 900;
  const AGGRESSIVE_PRELOAD_MAX_QUEUE = 24;
  const PAYLOAD_CACHE_TTL_MS = 90 * 1000;
  const MAX_PAYLOAD_CACHE = 30;
  const RECOVERY_SCAN_GAP_MS = 650;
  const RECOVERY_REQUEST_GAP_MS = 5000;
  const MAX_RECOVERY_TARGETS = 10;
  const IMAGE_MAX_SIDE = 1536;
  const IMAGE_JPEG_QUALITY = 0.82;
  const EMBEDDED_JPEG_QUALITY = 0.9;
  const EMBEDDED_MAX_CANVAS_PIXELS = 24 * 1000 * 1000;
  const EMBEDDED_MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;
  const MAX_LOCAL_RESULT_CACHE = 120;
  const KP = globalThis.MangaTranslatorKakaoPipeline;
  const KR = globalThis.MangaTranslatorKakaoReconciler;
  const KAKAO_CANONICAL_TARGET_LANGUAGE = "zh-CN";
  const KAKAO_CANONICAL_SOURCE_LANGUAGE = "auto";
  const KAKAO_AUTH_QUERY_PARAM_RE = /^(?:signature|credential|expires|policy|token|key-pair-id|x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders))$/i;
  const {
    KAKAO_OVERLAP_SAMPLE_WIDTH,
    KAKAO_THIN_STRIP_MIN_HEIGHT
  } = KP;

  const LOADING_OVERLAY_TIMEOUT_MS = 30000;
  const PRETRANSLATE_AHEAD_COUNT = 6;
  const RUNTIME_OWNER_ATTRIBUTE = "data-manga-translator-runtime-owner";
  const RUNTIME_FEATURE_ATTRIBUTE = "data-manga-translator-feature-version";
  const RUNTIME_FEATURE_VERSION = "kakao-canonical-v1";
  const MAX_EMBEDDED_IMAGE_CACHE = 40;
  const STATUS_INFO_THROTTLE_MS = 1200;
  const CONTEXT_INVALIDATED_RE = /extension context invalidated/i;
  const RENDER_MODE_OVERLAY = "overlay";
  const RENDER_MODE_EMBEDDED = "embedded";
  const CAPTURE_MODE_DIRECT = "direct";
  const CAPTURE_MODE_SCREENSHOT = "screenshot";
  const SCREENSHOT_TARGET_NOT_VISIBLE = "Target is not visible enough for screenshot capture";
  const IS_CMOA_SPEED_READER =
    /(^|\.)cmoa\.jp$/i.test(location.hostname) && /^\/bib\/speedreader\//i.test(location.pathname);
  const CMOA_AUTO_MIN_VISIBLE_AREA = 8000;
  const CMOA_MANUAL_MIN_VISIBLE_AREA = 2500;
  const BUBBLE_FONT_MIN = 10;
  const BUBBLE_FONT_MAX = 48;
  const BUBBLE_FONT_BASE_RATIO = 0.5;
  const BUBBLE_FONT_BINARY_STEPS = 9;
  const BUBBLE_FONT_SAFETY_SCALE = 0.9;
  const BUBBLE_FONT_VERTICAL_SAFETY_SCALE = 0.84;
  const MAX_FONT_FIT_CACHE = 600;
  const MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = /[\[\(（【<［]\s*image\s*#?\s*\d+\s*[\]\)）】>］]/giu;
  const MODEL_IMAGE_PLACEHOLDER_ONLY_RE = /^image\s*#?\s*\d+$/iu;

  // Pipeline trace — 默认关闭，零性能开销
  let ENABLE_PIPELINE_TRACE = false;

  function tracePipeline(stage, target, detail = {}) {
    if (!ENABLE_PIPELINE_TRACE) return;
    const arr = globalThis.__MT_PIPELINE_TRACE__
      || (globalThis.__MT_PIPELINE_TRACE__ = []);
    if (arr.length >= 5000) arr.shift();
    const sourceToken = getQuickSourceToken(target);
    const targetKey = computeTargetKey(target);
    arr.push({
      ts: performance.now(),
      idx: arr.length,
      sourceToken,
      targetKey,
      scopedKey: buildTargetSourceCacheKey(targetKey, sourceToken),
      stage,
      detail
    });
  }

  const state = {
    enabled: true,
    autoTranslatePageEnabled: false,
    pretranslateMode: "manual",
    invalidated: false,
    io: null,
    preloadIo: null,
    mo: null,
    overlayLayer: null,
    overlaysById: new Map(),
    embeddedById: new Map(),
    embeddedImageCache: new Map(),
    targetIdByElement: new WeakMap(),
    targetIdSeq: 1,
    observedTargets: new WeakSet(),
    inflightByTarget: new WeakMap(),
    queue: [],
    queuedTargets: new WeakSet(),
    runningJobs: 0,
    preloadQueue: [],
    preloadQueuedTargets: new WeakSet(),
    preloadRunningJobs: 0,
    preloadInFlightByTarget: new WeakMap(),
    aggressivePreload: IS_CMOA_SPEED_READER,
    lastAggressivePreloadSweepAt: 0,
    aggressiveSweepTimer: 0,
    overlayHideDepth: 0,
    overlayPreviousVisibility: "",
    payloadCacheByTargetKey: new Map(),
    localResultCache: new Map(),
    /** pageId 只映射当前可用 DOM 句柄；canonical/translation 事实保存在 Kakao Store。 */
    kakaoTargetsByPageId: new Map(),
    kakaoPageIdByTarget: new WeakMap(),
    kakaoImageRevisionByTarget: new WeakMap(),
    kakaoLoadListenerTargets: new WeakSet(),
    kakaoProjectionRefreshPageIds: new Set(),
    kakaoProjectionRefreshTimer: 0,
    /** Kakao 管线 Store（由 kakao-pipeline.js 提供） */
    kakaoStore: null,
    lastRecoveryAt: 0,
    lastKakaoVisualDedupeAt: 0,
    syncRaf: 0,
    overlayFrameRaf: 0,
    syncInterval: 0,
    showFloatingBall: true,
    captureMode: CAPTURE_MODE_DIRECT,
    renderMode: RENDER_MODE_OVERLAY,
    floatingBallWrap: null,
    floatingBall: null,
    floatingBallClose: null,
    bubbleMeasureProbe: null,
    fontFitCache: new Map(),
    termDiscoverySentKeys: new Set(),
    lastInfoStatusAt: 0,
    runtimeOwnerToken: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  };

  // 初始化 Kakao 管线 Store（如可用）
  if (KP && typeof KP.createStore === "function") {
    state.kakaoStore = KP.createStore();
  }

  const kakaoRetryScheduler = KP.createRetryScheduler({
    store: state.kakaoStore,
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
    isPlaceholder: (target) =>
      target instanceof HTMLImageElement && isDataUrl(resolveImageUrl(target)),
    isTargetUsable: (target) => !!target && target.isConnected && !state.invalidated,
    isTargetReady: (target) =>
      target instanceof HTMLImageElement && target.complete && passesTargetFilter(target, true),
    onReady: queuePageAutoTranslate
  });

  const kakaoLegacyPipeline = KP && typeof KP.createPipeline === "function"
    ? KP.createPipeline({
      store: state.kakaoStore,
      extractTargetPayload: (target, scopedKey) =>
        extractTargetPayload(target, scopedKey, { skipKakaoStitch: true, forceLegacyKakao: true }),
      requestTranslationForPayload,
      renderTranslationResult,
      clearRenderedTarget,
      renderOverlay,
      computeTargetKey,
      getQuickSourceToken,
      buildTargetSourceCacheKey,
      captureTargetSnapshot,
      isTargetSnapshotStillValid,
      shouldUseKakaoStitchedOcr,
      buildKakaoStitchedPayload,
      mapStitchedResult: mapKakaoStitchedResultForPipeline,
      dedupeResult: dedupeKakaoResultByPageCoordinates,
      renderLoadingOverlay,
      renderPipelineResult: renderKakaoPipelineResult,
      renderCachedPipelineResult: renderCachedKakaoPipelineResult,
      releaseAttachedShortPagesOnError: releaseKakaoPipelineErrorAttachments,
      reportPipelineError: reportKakaoPipelineError,
      findTargetByScopedKey,
      queueTranslate,
      queuePageAutoTranslate,
      scheduleAutoTranslateRetry,
      tracePipeline,
      state
    })
    : null;

  const kakaoCanonicalPipeline = KP && KR && typeof KP.createCanonicalPipeline === "function"
    ? KP.createCanonicalPipeline({
      store: state.kakaoStore,
      reconciler: KR,
      extractTargetPayload: (target, scopedKey) =>
        extractTargetPayload(target, buildKakaoCanonicalPayloadCacheKey(scopedKey, target), { skipKakaoStitch: true }),
      buildPageIdentity: buildKakaoPageIdentity,
      commitPageIdentity: (target, identity) => bindKakaoTargetToPage(
        target,
        identity && identity.pageId,
        identity && identity.imageRevision
      ),
      requestOcrForPayload,
      requestCanonicalTranslations,
      findAdjacentPageTargets: findAdjacentKakaoPageTargets,
      resolvePageRecord: (target) => {
        return state.kakaoStore && typeof state.kakaoStore.getPageHandleForTarget === "function"
          ? state.kakaoStore.getPageHandleForTarget(target)
          : null;
      },
      buildSeamPayload: buildKakaoSeamPayload,
      detectAdjacentPixelRisk: detectAdjacentKakaoPixelRisk,
      getTargetForPageId: getTargetForKakaoPageId,
      renderCanonicalProjections,
      clearCanonicalProjection: (target) => clearRenderedTarget(target),
      computeTargetKey,
      getQuickSourceToken,
      buildTargetSourceCacheKey,
      captureTargetSnapshot,
      isTargetSnapshotStillValid,
      getTargetGeneration: getKakaoTargetGeneration,
      renderLoadingOverlay,
      scheduleAutoTranslateRetry,
      reportPipelineError: reportKakaoPipelineError,
      tracePipeline,
      targetLanguage: KAKAO_CANONICAL_TARGET_LANGUAGE,
      sourceLanguage: KAKAO_CANONICAL_SOURCE_LANGUAGE,
      edgeWaitTimeoutMs: 8000
    })
    : null;

  const kakaoPipeline = kakaoCanonicalPipeline || kakaoLegacyPipeline;

  const api = {
    invalidated: false,
    rescan,
    manualTranslateVisible,
    togglePageAutoTranslate,
    getPageAutoTranslateStatus,
    __test: {
      /** 直接访问 pipeline 模块（只读） */
      get pipeline() { return globalThis.MangaTranslatorKakaoPipeline; },
      /** 访问 Store（已封装） */
      get kakaoStore() { return state.kakaoStore; },
      get kakaoPipeline() { return kakaoPipeline; },
      get kakaoCanonicalPipeline() { return kakaoCanonicalPipeline; },
      get kakaoLegacyPipeline() { return kakaoLegacyPipeline; },
      mapKakaoStitchedResult,
      dedupeKakaoResultByPageCoordinates,
      buildKakaoStitchWindowPlan,
      findKakaoStitchNeighborTarget,
      isVerifiedKakaoStitchNeighbor,
      shouldFallbackFromKakaoStitch,
      hasKakaoFragmentStructureRisk,
      shouldRejectKakaoPageEdgeStitch,
      buildOcrRequestKey,
      shouldUseKakaoCanonicalPipeline,
      normalizeKakaoStableImageSource,
      buildKakaoPageIdentity,
      detachKakaoTargetForSourceChange,
      getTargetForKakaoPageId,
      prepareKakaoTargetRevisionCheck,
      captureTargetSnapshot,
      isTargetSnapshotStillValid,
      shouldReuseTargetInflight,
      upgradeQueuedTranslationRequest,
      normalizeOcrObservationResult,
      projectionToRendererBubble,
      normalizeProjectionPages,
      normalizeDebugCoordinateItems,
      normalizePretranslateMode,
      textSimilarity,
      formatTranslationForOriginalLines,
      normalizeBubbleRotation,
      buildRegionClipPath,
      getBubbleRenderColors,
      getDynamicStrokeWidth,
      getCleanedPatchStyle,
      buildSolidBackgroundBox,
      buildAheadTranslationOptions,
      compareOverlayViewportRects,
      getOverlayPositionRect,
      shouldHideOverlayRoot,
      getOverlayVisibilityRect,
      syncOverlayPosition,
      passesKakaopageTargetGeometry,
      hasUsableKakaoStripCaptureRect,
      selectPendingAheadCandidates,
      selectPendingContinuousCandidates,
      isAttachableKakaoShortPage,
      findKakaoVerticalOverlap,
      isAutomaticPretranslateMode,
      shouldSchedulePagePretranslation,
      tracePipeline,
      getPipelineTrace: () => globalThis.__MT_PIPELINE_TRACE__ || [],
      clearPipelineTrace: () => { globalThis.__MT_PIPELINE_TRACE__ = []; },
      findKakaoShortPageAttachmentOwner,
      normalizeKakaoStitchDebugCoordinates,
      maybeQueueKakaoShortPageAttachmentOwner,
      maybeCropKakaoOverlappedPayload,
      sampleKakaoImageForOverlap,
      normalizeKakaoStitchSegments,
      getKakaoStitchOwnerOverlap,
      getDebugItemPercentWithImageSize,
      mapKakaoStitchedFillBox,
      mapKakaoStitchedPolygon,
      buildTermDiscoveryMessage,
      releaseUncoveredKakaoShortPages,
      releaseShortPagesAttachedDuringInflight,
      hasAttachedShortPageBubble,
      buildKakaoStitchedPayload,
      findTargetByScopedKey,
      setPipelineTraceEnabled: (v) => { ENABLE_PIPELINE_TRACE = v; }
    },
    destroy
  };

  globalThis.__MANGA_TRANSLATOR_V3__ = api;

  init().catch((error) => {
    console.warn("[MangaTranslator] content init failed:", error);
  });

  async function init() {
    if (!hasExtensionApis()) {
      state.invalidated = true;
      api.invalidated = true;
      console.info("[MangaTranslator] extension APIs are unavailable in this page context, skip init.");
      return;
    }

    claimRuntimeOwnership();
    await loadLocalSettings();
    ensureOverlayLayer();
    createFloatingBall();
    bindRuntimeMessages();
    bindStorageListener();
    bindViewportSync();
    startObservers();
    rescan();

    await reportStatus("info", "content script ready", {
      autoEnabled: state.enabled,
      aggressivePreload: state.aggressivePreload,
      pageUrl: location.href
    });
    scheduleAheadPretranslation("page-load");
  }

  function hasExtensionApis() {
    return (
      typeof chrome !== "undefined" &&
      !!chrome.runtime &&
      !!chrome.runtime.id &&
      !!chrome.runtime.onMessage &&
      !!chrome.storage &&
      !!chrome.storage.local
    );
  }

  function bindRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) {
        return false;
      }

      if (message.type === "MANUAL_TRANSLATE_VISIBLE") {
        manualTranslateVisible()
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error) => {
            sendResponse({ ok: false, error: getErrorMessage(error) });
          });
        return true;
      }

      if (message.type === "TOGGLE_PAGE_AUTO_TRANSLATE") {
        togglePageAutoTranslate(message.enabled)
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error) => {
            sendResponse({ ok: false, error: getErrorMessage(error) });
          });
        return true;
      }

      if (message.type === "GET_PAGE_AUTO_TRANSLATE_STATUS") {
        sendResponse({ ok: true, ...getPageAutoTranslateStatus() });
        return false;
      }

      if (message.type === "PING_CONTENT_SCRIPT") {
        sendResponse({ ok: true, ready: !state.invalidated });
        return false;
      }

      return false;
    });
  }

  function bindStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      if (changes.mt_enabled) {
        state.enabled = changes.mt_enabled.newValue !== false;
        if (!state.enabled) {
          state.autoTranslatePageEnabled = false;
          clearAllRenderedTargets();
        } else {
          rescan();
          scheduleAheadPretranslation("enabled");
        }
      }

      if (changes.mt_show_ball) {
        state.showFloatingBall = changes.mt_show_ball.newValue !== false;
      }

      if (changes.mt_capture_mode) {
        const nextMode = normalizeCaptureMode(changes.mt_capture_mode.newValue);
        if (nextMode !== state.captureMode) {
          state.captureMode = nextMode;
          state.payloadCacheByTargetKey.clear();
          clearAllRenderedTargets();
          if (state.enabled) {
            rescan();
          }
        }
      }

      if (changes.mt_render_mode) {
        const nextMode = normalizeRenderMode(changes.mt_render_mode.newValue);
        if (nextMode !== state.renderMode) {
          state.renderMode = nextMode;
          clearAllRenderedTargets();
          if (state.enabled) {
            rescan();
          }
        }
      }

      if (changes.mt_pretranslate_mode) {
        state.pretranslateMode = normalizePretranslateMode(changes.mt_pretranslate_mode.newValue);
        if (shouldSchedulePagePretranslation()) {
          scheduleAheadPretranslation("setting-change");
        }
      }

      updateFloatingBallState();
    });
  }

  function bindViewportSync() {
    const scheduleSync = () => {
      if (state.syncRaf) {
        return;
      }

      state.syncRaf = window.requestAnimationFrame(() => {
        state.syncRaf = 0;
        syncAllOverlays();
        scheduleAheadPretranslation("viewport");
      });
    };

    window.addEventListener("scroll", scheduleSync, {
      passive: true,
      capture: true
    });

    window.addEventListener("resize", scheduleSync, {
      passive: true,
      capture: true
    });

    if (!state.syncInterval) {
      state.syncInterval = window.setInterval(() => {
        ensureExtensionUiMounted();
        syncAllOverlays();
      }, 1200);
    }
  }

  function overlayFrameSyncTick() {
    state.overlayFrameRaf = 0;
    if (state.invalidated || state.overlaysById.size === 0) {
      return;
    }

    for (const overlayState of state.overlaysById.values()) {
      syncOverlayPosition(overlayState);
    }
    syncKakaoVisualDuplicateBubbles();
    state.overlayFrameRaf = window.requestAnimationFrame(overlayFrameSyncTick);
  }

  function ensureOverlayFrameSync() {
    if (state.invalidated || state.overlayFrameRaf || state.overlaysById.size === 0) {
      return;
    }
    // 阅读器可能用 transform 平滑移动画面，此时不会持续触发原生 scroll 事件。
    state.overlayFrameRaf = window.requestAnimationFrame(overlayFrameSyncTick);
  }

  function stopOverlayFrameSync() {
    if (!state.overlayFrameRaf) {
      return;
    }
    window.cancelAnimationFrame(state.overlayFrameRaf);
    state.overlayFrameRaf = 0;
  }

  function startObservers() {
    if (state.invalidated) {
      return;
    }

    state.io = new IntersectionObserver(onIntersection, {
      root: null,
      rootMargin: IS_KAKAOPAGE_READER ? "800px 0px" : "280px 0px",
      threshold: 0.08
    });
    state.preloadIo = new IntersectionObserver(onPreloadIntersection, {
      root: null,
      rootMargin: getPreloadRootMargin(),
      threshold: 0.01
    });

    state.mo = new MutationObserver(onMutation);

    const observeDom = () => {
      const root = document.documentElement || document.body;
      if (!root || state.invalidated) {
        return;
      }

      state.mo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "style", "class", "width", "height", "id"]
      });
    };

    observeDom();

    if (!document.body) {
      document.addEventListener("DOMContentLoaded", observeDom, { once: true });
    }
  }

  function rescan() {
    if (state.invalidated) {
      return;
    }

    ensureExtensionUiMounted();
    scanNode(document.documentElement || document.body);
    syncAllOverlays();
  }

  function scanNode(node) {
    if (!node || state.invalidated) {
      return;
    }

    if (node instanceof Element && node.closest("[data-manga-translator-overlay]")) {
      return;
    }

    if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement || isBackgroundImageTarget(node)) {
      registerTarget(node);
      return;
    }

    if (!(node instanceof Element)) {
      return;
    }

    node.querySelectorAll(TARGET_SELECTOR).forEach((target) => registerTarget(target));
  }

  function registerTarget(target) {
    if (!isSupportedTarget(target) || state.invalidated) {
      return;
    }
    if (!isSitePreferredTarget(target)) {
      return;
    }

    if (
      target instanceof HTMLImageElement && !target.complete &&
      !state.kakaoLoadListenerTargets.has(target)
    ) {
      state.kakaoLoadListenerTargets.add(target);
      target.addEventListener(
        "load",
        () => {
          state.kakaoLoadListenerTargets.delete(target);
          if (shouldUseKakaoCanonicalPipeline(target) && shouldRevalidateKakaoImageLoad(target)) {
            prepareKakaoTargetRevisionCheck(target, "image-load");
          }
          registerTarget(target);
          // Image just finished loading — queue for translation if the
          // IntersectionObserver already fired and won't fire again.
          if (state.autoTranslatePageEnabled && state.enabled && target.isConnected) {
            queuePageAutoTranslate(target);
          }
        },
        { once: true }
      );
      target.addEventListener("error", () => state.kakaoLoadListenerTargets.delete(target), { once: true });
    }

    const sourceToken = getQuickSourceToken(target);
    const oldSourceToken = target.dataset.mtSourceToken || "";
    const canonicalTarget = shouldUseKakaoCanonicalPipeline(target);
    if (
      canonicalTarget && oldSourceToken && oldSourceToken === sourceToken &&
      shouldRevalidateReconnectedKakaoTarget(target)
    ) {
      prepareKakaoTargetRevisionCheck(target, "dom-reconnected");
    }
    if (oldSourceToken && oldSourceToken !== sourceToken) {
      const oldScopedTargetKey = buildTargetSourceCacheKey(computeTargetKey(target), oldSourceToken);
      state.kakaoStore.cancelPageJob(oldScopedTargetKey);
      if (canonicalTarget) {
        detachKakaoTargetForSourceChange(target);
      }
      const oldTranslatedKey = target.dataset.mtLastTranslatedKey || "";
      if (oldTranslatedKey) {
        state.payloadCacheByTargetKey.delete(oldTranslatedKey);
        state.localResultCache.delete(oldTranslatedKey);
      }
      clearRenderedTarget(target);
      target.dataset.mtLastTranslatedKey = "";
      target.dataset.mtNoTextKey = "";
      target.dataset.mtRecoveryReqAt = "";
      if (!canonicalTarget && typeof state.kakaoStore.clearShortPage === "function") {
        state.kakaoStore.clearShortPage(target);
      }
      delete target.dataset.mtBoundaryReadyToken;
      kakaoRetryScheduler.cancel(target);
      // 清理全局去重条目
      if (!canonicalTarget && oldTranslatedKey) {
        state.kakaoStore.deleteEntriesForKey(oldTranslatedKey);
      }
      // 允许该 DOM 元素重新入队
      state.queuedTargets.delete(target);
      for (let index = state.queue.length - 1; index >= 0; index -= 1) {
        if (state.queue[index] && state.queue[index].target === target) state.queue.splice(index, 1);
      }
    }
    target.dataset.mtSourceToken = sourceToken;
    if (!oldSourceToken || oldSourceToken === sourceToken) {
      restoreKnownKakaoPageHandle(target);
    }

    const isNewObservation = !state.observedTargets.has(target);
    if (isNewObservation) {
      state.io.observe(target);
      if (state.preloadIo) {
        state.preloadIo.observe(target);
      }
      state.observedTargets.add(target);
    }

    // 自动翻译开启时，在两种情况下立即入队：
    const imgNotComplete = target instanceof HTMLImageElement && !target.complete;
    const needsRevisionCheck = target.dataset.mtKakaoRevisionCheck === "true";
    const shouldAutoQueue =
      state.autoTranslatePageEnabled &&
      state.enabled &&
      target.isConnected &&
      !imgNotComplete;
    if (needsRevisionCheck && state.enabled && target.isConnected && !imgNotComplete) {
      delete target.dataset.mtKakaoRevisionCheck;
      queueTranslate(target, {
        manual: true,
        force: true,
        relaxed: true,
        allowOffscreen: true,
        reason: "kakao-image-revision-check"
      });
    }
    if (!shouldAutoQueue && state.autoTranslatePageEnabled && state.enabled && imgNotComplete) {
      // 图片还未加载完成（CDN 慢），等 load 事件触发后会再进 registerTarget 入队。
      // 但如果 load 事件永远不触发（CDN 错误），重试机制需要兜底。
      // sourceToken 变化时（SVG→CDN）安排一次重试，确保不遗漏。
      if (!isNewObservation && oldSourceToken && oldSourceToken !== sourceToken) {
        scheduleAutoTranslateRetry(target);
      }
    }
    if (shouldAutoQueue) {
      // 1) DOM 复用（sourceToken 变化）→ 旧元素被回收给新图片
      if (!isNewObservation && oldSourceToken && oldSourceToken !== sourceToken) {
        queuePageAutoTranslate(target);
      }
      // 2) 新元素且已在视口中 → IntersectionObserver 不会同步触发
      if (isNewObservation && isTargetVisible(target)) {
        queuePageAutoTranslate(target);
      }
      // 3) 已观察过且在视口中、未翻译 → init 时 autoTranslate 尚未开启，
      //    toggle 后 rescan 不会再次触发 intersection，需要此处显式入队。
      if (
        !isNewObservation &&
        isTargetVisible(target) &&
        !target.dataset.mtLastTranslatedKey &&
        !target.dataset.mtNoTextKey
      ) {
        queuePageAutoTranslate(target);
      }
    }

    if (IS_KAKAOPAGE_READER && target instanceof HTMLImageElement && target.complete && sourceToken) {
      refreshPreviousKakaoBoundary(target, sourceToken);
    }
    tracePipeline("collected", target, {
      rect: {
        top: target.getBoundingClientRect().top,
        height: target.getBoundingClientRect().height,
        width: target.getBoundingClientRect().width
      }
    });
  }

  function refreshPreviousKakaoBoundary(target, sourceToken) {
    if (target.dataset.mtBoundaryReadyToken === sourceToken) {
      return;
    }
    target.dataset.mtBoundaryReadyToken = sourceToken;
    const ordered = collectKakaopageManualTargetCandidates(true, target).filter(
      (candidate) => candidate instanceof HTMLImageElement && candidate.isConnected
    );
    const index = ordered.indexOf(target);
    if (index <= 0) {
      return;
    }
    const previous = findKakaoStitchNeighborTarget(
      buildKakaoStitchCandidateEntries(ordered),
      index,
      "previous"
    );
    if (!previous) {
      return;
    }
    if (shouldUseKakaoCanonicalPipeline(target) && kakaoCanonicalPipeline) {
      if (typeof kakaoCanonicalPipeline.onAdjacentTargetAvailable === "function") {
        Promise.resolve(kakaoCanonicalPipeline.onAdjacentTargetAvailable(previous, target)).catch((error) => {
          console.warn("[MangaTranslator][Kakao canonical] adjacent reconcile failed:", error);
        });
      }
      return;
    }
    if (
      previous.dataset.mtLastTranslatedKey &&
      state.autoTranslatePageEnabled &&
      isAutomaticPretranslateMode(state.pretranslateMode)
    ) {
      const previousKey = computeTargetKey(previous);
      state.payloadCacheByTargetKey.delete(previousKey);
      state.payloadCacheByTargetKey.delete(buildTargetSourceCacheKey(previousKey, getQuickSourceToken(previous)));
      queueTranslate(previous, { manual: true, force: true, reason: "kakao-boundary-refresh" });
    }
  }

  function onIntersection(entries) {
    if (state.invalidated) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      if (state.autoTranslatePageEnabled && state.enabled) {
        queuePageAutoTranslate(entry.target);
      }
    }
  }

  function onPreloadIntersection(entries) {
    if (state.invalidated) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      const target = entry.target;
      if (!passesTargetFilter(target, false)) {
        continue;
      }
    }
  }

  function onMutation(mutations) {
    if (state.invalidated) {
      return;
    }

    let shouldRepairUi = false;
    let sawExternalMutation = false;
    const disconnectedCanonicalPageIds = new Set();
    for (const mutation of mutations) {
      const mutationInsideOverlay = mutation.target instanceof Element && mutation.target.closest("[data-manga-translator-overlay]");
      if (mutationInsideOverlay) {
        continue;
      }
      if (mutation.type === "childList") {
        mutation.removedNodes.forEach((node) => {
          if (node === state.overlayLayer || node === state.floatingBallWrap) {
            shouldRepairUi = true;
          }
          if (node instanceof Element && !node.closest("[data-manga-translator-overlay]")) {
            const removedTargets = [];
            if (isSupportedTarget(node)) removedTargets.push(node);
            node.querySelectorAll(TARGET_SELECTOR).forEach((target) => {
              if (isSupportedTarget(target)) removedTargets.push(target);
            });
            for (const removedTarget of removedTargets) {
              const pageId = detachKakaoTargetHandle(removedTarget);
              if (pageId) disconnectedCanonicalPageIds.add(pageId);
            }
            if (removedTargets.length > 0) sawExternalMutation = true;
          }
        });
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element && node.closest("[data-manga-translator-overlay]")) {
            return;
          }
          sawExternalMutation = true;
          scanNode(node);
        });
      }

      if (
        mutation.type === "attributes" &&
        (mutation.target instanceof HTMLImageElement ||
          mutation.target instanceof HTMLCanvasElement ||
          isBackgroundImageTarget(mutation.target))
      ) {
        sawExternalMutation = true;
        registerTarget(mutation.target);
      }
    }

    if (shouldRepairUi || !isExtensionUiMounted()) {
      ensureExtensionUiMounted();
    }
    if (sawExternalMutation || shouldRepairUi) {
      scheduleAheadPretranslation("mutation");
    }
    if (disconnectedCanonicalPageIds.size > 0) {
      scheduleKakaoProjectionRefresh([...disconnectedCanonicalPageIds], "page-handle-disconnected");
    }
  }

  function scheduleAheadPretranslation(reason) {
    if (!shouldSchedulePagePretranslation()) {
      return;
    }
    getAheadTranslationTargets().forEach((target) =>
      queueTranslate(target, buildAheadTranslationOptions(reason))
    );
  }

  function shouldSchedulePagePretranslation({
    enabled = state.enabled,
    pageEnabled = state.autoTranslatePageEnabled,
    mode = state.pretranslateMode,
    invalidated = state.invalidated
  } = {}) {
    return enabled && pageEnabled && !invalidated && isAutomaticPretranslateMode(mode);
  }

  function buildAheadTranslationOptions(reason) {
    return {
      manual: true,
      relaxed: true,
      allowOffscreen: true,
      reason: `ahead-${String(reason || "unknown")}`
    };
  }

  function getAheadTranslationTargets() {
    const candidates = (IS_KAKAOPAGE_READER
      ? collectKakaopageManualTargetCandidates(true)
      : Array.from(document.querySelectorAll(TARGET_SELECTOR)))
      .filter((target) => isSupportedTarget(target) && target.isConnected)
      .filter((target) => IS_KAKAOPAGE_READER ? passesKakaoAheadTargetFilter(target) : passesTargetFilter(target, true, { relaxed: true }));
    if (candidates.length === 0) {
      return [];
    }
    const viewportAnchor = window.innerHeight * 0.35;
    const isPending = (target) => {
      const targetKey = computeTargetKey(target);
      const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
      return target.dataset.mtLastTranslatedKey !== targetKey &&
        target.dataset.mtLastTranslatedKey !== scopedTargetKey &&
        target.dataset.mtNoTextKey !== targetKey &&
        target.dataset.mtNoTextKey !== scopedTargetKey;
    };
    const pendingTargets = state.pretranslateMode === "continuous"
      ? selectPendingContinuousCandidates(candidates, viewportAnchor, isPending)
      : selectPendingAheadCandidates(
        candidates,
        viewportAnchor,
        isPending
      );
    return pendingTargets.filter((target) => {
      if (target instanceof HTMLImageElement && !target.complete) {
        target.loading = "eager";
        if (target.dataset.mtAheadLoadPending !== "true") {
          target.dataset.mtAheadLoadPending = "true";
          target.addEventListener("load", () => {
            delete target.dataset.mtAheadLoadPending;
            scheduleAheadPretranslation("image-load");
          }, { once: true });
        }
        return false;
      }
      return true;
    });
  }

  function selectPendingAheadCandidates(candidates, viewportAnchor, isPending, aheadCount = PRETRANSLATE_AHEAD_COUNT) {
    let startIndex = candidates.findIndex((target) => target.getBoundingClientRect().bottom >= viewportAnchor);
    if (startIndex < 0) {
      startIndex = Math.max(0, candidates.length - 1);
    }
    return candidates.slice(startIndex).filter(isPending).slice(0, aheadCount + 1);
  }


  function selectPendingContinuousCandidates(candidates, viewportAnchor, isPending) {
    let startIndex = candidates.findIndex((target) => target.getBoundingClientRect().bottom >= viewportAnchor);
    if (startIndex < 0) {
      startIndex = Math.max(0, candidates.length - 1);
    }
    return candidates.slice(startIndex).filter(isPending);
  }
  function passesKakaoAheadTargetFilter(target) {
    if (!isSupportedTarget(target) || !target.isConnected || !isSitePreferredTarget(target, { allowLoose: true })) {
      return false;
    }
    const rect = target.getBoundingClientRect();
    const canonicalTarget = shouldUseKakaoCanonicalPipeline(target);
    if (rect.width < 80 || rect.height < (canonicalTarget ? KAKAO_THIN_STRIP_MIN_HEIGHT : 80)) {
      return false;
    }
    if (target instanceof HTMLImageElement) {
      const naturalWidth = Number(target.naturalWidth || 0);
      const naturalHeight = Number(target.naturalHeight || 0);
      if (
        naturalWidth > 0 && naturalHeight > 0 &&
        (naturalHeight < (canonicalTarget ? KAKAO_THIN_STRIP_MIN_HEIGHT : 80) ||
          naturalHeight / naturalWidth < (canonicalTarget ? 0.01 : 0.10))
      ) {
        return false;
      }
      // KakaoPage 推荐区封面（~98x140）不应占用预翻译槽位，确保漫画页优先。
      if (canonicalTarget && naturalWidth > 0 && naturalWidth < 200) {
        return false;
      }
    }
    return true;
  }

  function isKakaoShortPageQueueBlocked(target) {
    if (!IS_KAKAOPAGE_READER || shouldUseKakaoCanonicalPipeline(target)) {
      return false;
    }
    const gate = KP.getShortPageAttachmentGate(state.kakaoStore, target);
    if (gate.timedOut) {
      tracePipeline("skipped", target, { skipReason: "shortPageAttachmentTimeout" });
    } else if (gate.blocked) {
      tracePipeline("skipped", target, { skipReason: "shortPageAttached" });
    }
    return gate.blocked;
  }

  function queueTranslate(target, options) {
    if (!isSupportedTarget(target) || !target.isConnected || state.invalidated) {
      return;
    }

    if (!options.manual) {
      return;
    }

    if (maybeQueueKakaoShortPageAttachmentOwner(target, options)) {
      return;
    }

    if (isKakaoShortPageQueueBlocked(target)) {
      return;
    }

    const revisionCheck = isCanonicalRevisionCheckOptions(options);
    if (state.queuedTargets.has(target)) {
      if (revisionCheck) upgradeQueuedTranslationRequest(state.queue, target, options);
      return;
    }
    if (state.inflightByTarget.has(target)) {
      if (shouldReuseTargetInflight(target.dataset.inflightSourceToken, getTargetExecutionToken(target))) return;
    }

    state.queue.push({ target, options });
    state.queuedTargets.add(target);
    tracePipeline("queued", target, {
      reason: options.reason,
      targetKey: computeTargetKey(target).slice(0, 80)
    });
    pumpQueue();
  }

  function isCanonicalRevisionCheckOptions(options) {
    return options && options.force === true && options.reason === "kakao-image-revision-check";
  }

  function shouldReuseTargetInflight(inflightToken, currentExecutionToken) {
    return !!inflightToken && String(inflightToken) === String(currentExecutionToken);
  }

  function upgradeQueuedTranslationRequest(queue, target, options) {
    const queued = Array.isArray(queue) ? queue.find((item) => item && item.target === target) : null;
    if (!queued) return false;
    queued.options = { ...(queued.options || {}), ...(options || {}), force: true };
    return true;
  }

  function queuePreload(target, options = {}) {
    if (!isSupportedTarget(target) || !target.isConnected || state.invalidated) {
      return;
    }

    if (!state.enabled) {
      return;
    }

    if (state.preloadQueuedTargets.has(target) || state.preloadInFlightByTarget.has(target)) {
      return;
    }

    if (options.priority === "high") {
      state.preloadQueue.unshift(target);
    } else {
      state.preloadQueue.push(target);
    }
    state.preloadQueuedTargets.add(target);
    pumpPreloadQueue();
  }

  function pumpQueue() {
    if (state.invalidated) {
      return;
    }

    while (state.runningJobs < MAX_PARALLEL_TRANSLATIONS && state.queue.length > 0) {
      const item = state.queue.shift();
      state.queuedTargets.delete(item.target);

      if (!item.target.isConnected) {
        continue;
      }

      state.runningJobs += 1;
      translateTarget(item.target, item.options)
        .catch(() => {
          // Error is handled in translateTarget.
        })
        .finally(() => {
          state.runningJobs -= 1;
          pumpQueue();
        });
    }
  }

  function pumpPreloadQueue() {
    if (state.invalidated) {
      return;
    }

    while (state.preloadRunningJobs < getMaxPreloadJobs() && state.preloadQueue.length > 0) {
      const target = state.preloadQueue.shift();
      state.preloadQueuedTargets.delete(target);

      if (!target || !target.isConnected) {
        continue;
      }

      state.preloadRunningJobs += 1;
      preloadTargetPayload(target)
        .catch(() => {
          // Ignore preload errors to avoid noisy page behavior.
        })
        .finally(() => {
          state.preloadRunningJobs -= 1;
          pumpPreloadQueue();
        });
    }
  }

  function getMaxPreloadJobs() {
    return state.aggressivePreload ? AGGRESSIVE_PRELOAD_JOBS : MAX_PRELOAD_JOBS;
  }

  function getPreloadRootMargin() {
    return state.aggressivePreload ? AGGRESSIVE_PRELOAD_ROOT_MARGIN : PRELOAD_ROOT_MARGIN;
  }

  function scheduleAggressivePreloadSweep(reason) {
    if (!state.aggressivePreload || state.invalidated || !state.enabled) {
      return;
    }
    if (state.preloadQueue.length >= AGGRESSIVE_PRELOAD_MAX_QUEUE) {
      return;
    }
    if (state.aggressiveSweepTimer) {
      return;
    }

    const run = () => {
      state.aggressiveSweepTimer = 0;
      triggerAggressivePreloadSweep(reason);
    };

    if (typeof window.requestIdleCallback === "function") {
      state.aggressiveSweepTimer = window.requestIdleCallback(
        () => {
          run();
        },
        { timeout: 320 }
      );
      return;
    }

    state.aggressiveSweepTimer = window.setTimeout(run, 180);
  }

  function triggerAggressivePreloadSweep() {
    if (!state.aggressivePreload || state.invalidated || !state.enabled) {
      return;
    }
    if (state.preloadQueue.length >= AGGRESSIVE_PRELOAD_MAX_QUEUE) {
      return;
    }

    const now = Date.now();
    if (now - state.lastAggressivePreloadSweepAt < AGGRESSIVE_PRELOAD_SWEEP_GAP_MS) {
      return;
    }
    state.lastAggressivePreloadSweepAt = now;

    const root = IS_CMOA_SPEED_READER
      ? document.querySelector("#content") || document.documentElement
      : document.documentElement;
    const nodes = root ? root.querySelectorAll(TARGET_SELECTOR) : [];
    const viewportCenterY = window.innerHeight / 2;
    const candidates = Array.from(nodes)
      .filter((target) => isSupportedTarget(target) && target.isConnected)
      .filter((target) => !state.preloadQueuedTargets.has(target) && !state.preloadInFlightByTarget.has(target))
      .filter((target) => !state.inflightByTarget.has(target))
      .filter((target) => passesTargetFilter(target, false))
      .map((target) => {
        const rect = target.getBoundingClientRect();
        return {
          target,
          rect,
          distance: Math.abs(rect.top + rect.height / 2 - viewportCenterY),
          area: getVisibleArea(rect)
        };
      })
      .filter((item) => item.rect.top < window.innerHeight + 2800 && item.rect.bottom > -2800)
      .sort((left, right) => left.distance - right.distance || right.area - left.area)
      .slice(0, AGGRESSIVE_PRELOAD_BATCH);

    for (const item of candidates) {
      queuePreload(item.target, { priority: "high" });
      if (state.preloadQueue.length >= AGGRESSIVE_PRELOAD_MAX_QUEUE) {
        break;
      }
    }
  }

  async function runKakaoCanonicalTarget(target, options, cached = false) {
    let result = cached
      ? await kakaoCanonicalPipeline.runCached(target, null, options)
      : await kakaoCanonicalPipeline.run(target, options);
    if (result && result.fallbackLegacy === true && kakaoLegacyPipeline) {
      tracePipeline("canonical-legacy-fallback", target, {
        reason: result.reason || "non-authoritative-page-payload",
        source: String(result.payload && result.payload.source || "")
      });
      const targetKey = computeTargetKey(target);
      const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
      // Canonical FETCH 已缓存了未经旧截图归一化的 payload；委托旧链路前移除它，
      // 让截图/裁剪模式完整走原有提取与坐标适配流程。
      state.payloadCacheByTargetKey.delete(scopedTargetKey);
      state.payloadCacheByTargetKey.delete(buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target));
      result = await kakaoLegacyPipeline.run(target, {
        ...options,
        reason: options && options.reason
          ? `${options.reason}:canonical-payload-fallback`
          : "canonical-payload-fallback"
      });
    }
    if (result && result.ok) {
      await reportStatus("info", "translation done", {
        reason: options && options.reason,
        pageId: result.pageId || "",
        bubbles: Number(result.bubbles || 0),
        cached: result.cached === true || result.reused === true,
        pipeline: "kakao-canonical-v1"
      });
      // Canonical pipeline 的 run/runCached 通过 refreshCanonicalState →
      // renderCanonicalProjections 渲染结果，但某些路径可能不会清理
      // loading overlay（如 getTargetForKakaoPageId 返回 null，或缓存命中
      // 时 projections 为空），导致 overlay 永久残留。此处显式清理。
      clearKakaoLoadingOverlay(target);
    }
    return result;
  }

  async function translateTarget(target, options) {
    if (state.invalidated) {
      throw new Error("Extension context invalidated");
    }

    if (!isSupportedTarget(target) || !target.isConnected) {
      return { ok: false, skipped: true, reason: "target disconnected" };
    }

    if (!options.manual && !state.enabled) {
      return { ok: false, skipped: true, reason: "plugin disabled" };
    }

    if (!passesTargetFilter(target, options.manual, {
      relaxed: options.relaxed === true,
      allowOffscreen: options.allowOffscreen === true
    })) {
      // KakaoPage 自动翻译模式下安排重试：短页被 release 后可能已部分滚出视口，
      // 或因图片未完成加载等原因暂时不通过 filter——重试机制确保不会永久丢失。
      if (IS_KAKAOPAGE_READER && state.autoTranslatePageEnabled && options.manual) {
        scheduleAutoTranslateRetry(target);
      }
      return { ok: false, skipped: true, reason: "filtered as non-manga target" };
    }

    if (state.inflightByTarget.has(target)) {
      const inflightToken = target.dataset.inflightSourceToken;
      const currentToken = getTargetExecutionToken(target);
      if (inflightToken === currentToken) {
        tracePipeline("inflight-bypass", target, { skipReason: "sameSourceToken" });
        return state.inflightByTarget.get(target);
      }
      // sourceToken 不匹配：DOM 被复用了，清除旧 inflight 状态
      state.inflightByTarget.delete(target);
      delete target.dataset.inflightSourceToken;
      tracePipeline("inflight-bypass", target, { skipReason: "sourceTokenChanged" });
    }

    const executionToken = getTargetExecutionToken(target);
    const task = (async () => {
      let payload = null;
      let renderPayload = null;
      try {
        const targetKey = computeTargetKey(target);
        const targetId = getTargetId(target);
        const sourceToken = getQuickSourceToken(target);
        const scopedTargetKey = buildTargetSourceCacheKey(targetKey, sourceToken);

        if (isScreenshotCaptureMode() && !getVisibleViewportRect(target)) {
          return {
            ok: false,
            skipped: true,
            reason: SCREENSHOT_TARGET_NOT_VISIBLE
          };
        }

        const existingRendered = getExistingRenderedState(targetId);
        if (!options.force && existingRendered && existingRendered.targetKey === targetKey) {
          if (isBackgroundImageTarget(target) && existingRendered.mode === "embedded") {
            restoreEmbeddedForTarget(target);
          } else if (existingRendered.mode === "embedded" && !isEmbeddedRenderStillApplied(existingRendered)) {
            state.embeddedById.delete(targetId);
          } else if (existingRendered.mode === "embedded") {
            return { ok: true, reused: true, bubbles: existingRendered.bubbleCount };
          } else {
            syncOverlayPosition(existingRendered);
            return { ok: true, reused: true, bubbles: existingRendered.bubbleCount };
          }
        }

        const refreshedRendered = getExistingRenderedState(targetId);
        if (!options.force && refreshedRendered && refreshedRendered.targetKey === targetKey) {
          if (isBackgroundImageTarget(target) && refreshedRendered.mode === "embedded") {
            restoreEmbeddedForTarget(target);
          } else if (refreshedRendered.mode === "embedded") {
            return { ok: true, reused: true, bubbles: refreshedRendered.bubbleCount };
          } else {
            syncOverlayPosition(refreshedRendered);
            return { ok: true, reused: true, bubbles: refreshedRendered.bubbleCount };
          }
        }

        const localCachedResult = state.localResultCache.get(scopedTargetKey);
        if (!options.force && localCachedResult) {
          if (shouldUseKakaoCanonicalPipeline(target) && kakaoCanonicalPipeline) {
            return await runKakaoCanonicalTarget(target, options, true);
          }
          if (IS_KAKAOPAGE_READER && kakaoLegacyPipeline) {
            return await kakaoLegacyPipeline.runCached(target, localCachedResult, options);
          }
          const dedupedCachedResult = await dedupeKakaoResultByPageCoordinates(localCachedResult, target, targetKey);
          state.localResultCache.set(scopedTargetKey, dedupedCachedResult);
          if (dedupedCachedResult.bubbles.length > 0) {
            if (shouldUseEmbeddedRender(target)) {
              renderLoadingOverlay(target, targetKey, "生成嵌入图片中...");
            }
            const cachedPayload = shouldUseEmbeddedRender(target)
              ? await extractTargetPayload(target, scopedTargetKey)
              : null;
            await renderTranslationResult(target, targetKey, dedupedCachedResult, cachedPayload);
          } else {
            clearRenderedTarget(target);
          }
          return { ok: true, reused: true, bubbles: dedupedCachedResult.bubbles.length };
        }

        if (shouldUseKakaoCanonicalPipeline(target) && kakaoCanonicalPipeline) {
          return await runKakaoCanonicalTarget(target, options, false);
        }
        if (IS_KAKAOPAGE_READER && kakaoLegacyPipeline) {
          return await kakaoLegacyPipeline.run(target, options);
        }

        // Stale result defense: capture snapshot before translation
        const preTranslateSnapshot = captureTargetSnapshot(target);
        renderLoadingOverlay(target, targetKey, "OCR + 翻译中...");
        payload = await extractTargetPayload(target, scopedTargetKey);
        updateLoadingOverlayText(target, targetKey, "模型翻译中...");
        renderPayload = payload;
        const response = await requestTranslationForPayload(
          payload,
          buildOcrRequestKey(targetKey, payload)
        );
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "Translate request failed");
        }
        const result = normalizeResult(response.result);
        // Stale result defense: check if target changed during OCR
        if (preTranslateSnapshot && !isTargetSnapshotStillValid(target, preTranslateSnapshot)) {
          console.warn("[MangaTranslator] Stale result dropped: target changed during OCR, skipping clearRenderedTarget");
          return { ok: false, skipped: true, reason: "target changed during OCR (stale result)" };
        }
        const expectedSourceImageId = String(renderPayload && renderPayload.sourceImageId || payload && payload.sourceImageId || "");
        if (!target.isConnected || (expectedSourceImageId && getSourceImageIdForTarget(target) !== expectedSourceImageId)) {
          clearRenderedTarget(target);
          return { ok: false, skipped: true, reason: "source image changed during OCR" };
        }
        releaseUncoveredKakaoShortPages(payload, result, target, "ownerSucceededWithoutShortPageBubble");
        rememberLocalResult(scopedTargetKey, result);

        console.debug("[MangaTranslator] Received", result.bubbles.length, "bubbles, translated:", result.bubbles.filter((b) => b.translated_text && b.translated_text !== b.original_text).length, "of", result.bubbles.length);

        if (result.bubbles.length > 0) {
          updateLoadingOverlayText(target, targetKey, shouldUseEmbeddedRender(target) ? "生成嵌入图片中..." : "排版中...");
          await renderTranslationResult(target, targetKey, result, renderPayload, { stream: true });
          target.dataset.mtNoTextKey = "";
        } else {
          console.warn("[MangaTranslator] OCR returned no text for target", {
            targetTag: target.tagName.toLowerCase(),
            targetKey: targetKey.slice(0, 80),
            responseOk: response && response.ok,
            resultBubbles: response && response.result && response.result.bubbles ? response.result.bubbles.length : 0,
            resultCleaned: response && response.result && typeof response.result.cleanedImage === "string" ? response.result.cleanedImage.slice(0, 40) + "..." : "none",
            resultKeys: response && response.result ? Object.keys(response.result) : null,
            error: response && response.error || null
          });
          updateLoadingOverlayText(target, targetKey, "未识别到文本");
          await sleep(1500);
          clearRenderedTarget(target);
          target.dataset.mtNoTextKey = targetKey;
        }

        target.dataset.mtLastTranslatedKey = targetKey;

        await reportStatus("info", "translation done", {
          reason: options.reason,
          bubbles: result.bubbles.length,
          cached: !!response.cached
        });

        return { ok: true, bubbles: result.bubbles.length, cached: !!response.cached };
      } catch (error) {
        const reason = getErrorMessage(error);

        // Owner 翻译失败 → 释放附属短页，允许它们独立翻译
        let attachedShortPageKeys = null;
        if (payload && Array.isArray(payload.attachedShortPageKeys) && payload.attachedShortPageKeys.length > 0) {
          attachedShortPageKeys = payload.attachedShortPageKeys;
        } else if (renderPayload && Array.isArray(renderPayload.attachedShortPageKeys) && renderPayload.attachedShortPageKeys.length > 0) {
          attachedShortPageKeys = renderPayload.attachedShortPageKeys;
        }
        if (attachedShortPageKeys) {
          for (const shortKey of attachedShortPageKeys) {
            const el = findTargetByScopedKey(shortKey);
            if (el) {
              state.kakaoStore.releaseShortPage(el, buildTargetSourceCacheKey(
                computeTargetKey(target),
                getQuickSourceToken(target)
              ));
              tracePipeline("skipped", el, { skipReason: "ownerFailedReleasingShortPage" });
            }
          }
        }

        clearRenderedTarget(target);
        if (isScreenshotTargetNotVisibleError(reason)) {
          if (IS_KAKAOPAGE_READER && state.autoTranslatePageEnabled) {
            scheduleAutoTranslateRetry(target);
          }
          return {
            ok: false,
            skipped: true,
            reason
          };
        }

        if (CONTEXT_INVALIDATED_RE.test(reason)) {
          markInvalidated(reason);
        } else {
          await reportStatus("error", reason, {
            reason: options.reason,
            targetTag: target.tagName.toLowerCase()
          });
        }

        return { ok: false, error: reason };
      } finally {
        // Owner 翻译结束，检查是否有短页在 inflight 期间被附着到此 owner。
        // 如果有，这些短页的附着标记指向一个不会再被重翻译的 owner 结果，
        // 需要立即释放让它们独立翻译。
        if (
          IS_KAKAOPAGE_READER &&
          state.autoTranslatePageEnabled &&
          !shouldUseKakaoCanonicalPipeline(target)
        ) {
          releaseShortPagesAttachedDuringInflight(target);
        }
      }
    })();

    target.dataset.inflightSourceToken = executionToken;
    state.inflightByTarget.set(target, task);
    void task.finally(() => {
      if (state.inflightByTarget.get(target) === task) {
        state.inflightByTarget.delete(target);
      }
      if (target.dataset.inflightSourceToken === executionToken) {
        delete target.dataset.inflightSourceToken;
      }
    });
    return task;
  }

  async function preloadTargetPayload(target) {
    if (state.invalidated || !state.enabled) {
      return;
    }

    if (state.inflightByTarget.has(target)) {
      return;
    }

    if (!passesTargetFilter(target, false)) {
      return;
    }

    if (state.preloadInFlightByTarget.has(target)) {
      return state.preloadInFlightByTarget.get(target);
    }

    if (isScreenshotCaptureMode()) {
      return;
    }

    const task = (async () => {
      const targetKey = computeTargetKey(target);
      const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
      const canonicalTarget = shouldUseKakaoCanonicalPipeline(target);
      const payloadCacheKey = canonicalTarget
        ? buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target)
        : scopedTargetKey;
      if (
        state.localResultCache.has(targetKey) ||
        state.localResultCache.has(scopedTargetKey) ||
        getPayloadCache(targetKey) ||
        getPayloadCache(payloadCacheKey)
      ) {
        return;
      }

      await extractTargetPayload(target, payloadCacheKey, {
        skipKakaoStitch: canonicalTarget
      });
    })().finally(() => {
      state.preloadInFlightByTarget.delete(target);
    });

    state.preloadInFlightByTarget.set(target, task);
    return task;
  }

  async function extractTargetPayload(target, targetKey, options = {}) {
    const cacheKey = String(targetKey || computeTargetKey(target));
    // 优先检查 stitch 专用缓存 key，避免单图缓存误吞拼接版本
    if (options.skipKakaoStitch !== true) {
      const cachedStitch = getPayloadCache(cacheKey + "|stitch");
      if (cachedStitch) {
        return cachedStitch;
      }
    }
    const cached = getPayloadCache(cacheKey);
    if (cached) {
      return cached;
    }

    let payload = null;
    if (isScreenshotCaptureMode()) {
      payload = await captureVisibleTargetPayload(target, null, buildScreenshotImageUrl(target));
      payload = enrichPayloadForTarget(payload, target);
      rememberPayloadCache(cacheKey, payload);
      return payload;
    }

    if (target instanceof HTMLImageElement) {
      payload = await extractImagePayload(target);
    } else if (target instanceof HTMLCanvasElement) {
      payload = await extractCanvasPayload(target);
    } else if (isBackgroundImageTarget(target)) {
      payload = await extractBackgroundImagePayload(target);
    } else {
      throw new Error("Unsupported target element");
    }

    payload = await normalizeKakaopagePayload(target, payload, options);
    payload = enrichPayloadForTarget(payload, target);

    // 单图版本始终缓存到普通 key
    const singlePayload = payload;

    if (options.skipKakaoStitch === true) {
      rememberPayloadCache(cacheKey, singlePayload);
      return singlePayload;
    }

    if (shouldUseKakaoStitchedOcr(target, singlePayload)) {
      const stitched = await buildKakaoStitchedPayload(target, singlePayload);
      if (stitched.stitchAdmission === "accepted") {
        // 拼接版本用独立缓存键 (single | stitch 隔离)
        rememberPayloadCache(cacheKey + "|stitch", stitched);
        tracePipeline("requested", target, {
          ocrMode: "stitch",
          stitchKey: stitched.stitchKey,
          neighbors: (stitched.stitch && stitched.stitch.sourceKeys) || []
        });
        return stitched;
      }
      // 拼接被拒绝，回退到单图
      rememberPayloadCache(cacheKey, singlePayload);
      tracePipeline("stitch-rejected", target, {
        stitchRejection: stitched.stitchRejectionReason
      });
      return singlePayload;
    }

    rememberPayloadCache(cacheKey, payload);
    return payload;
  }

  function enrichPayloadForTarget(payload, target) {
    if (!payload || !target) {
      return payload;
    }
    const rect = target.getBoundingClientRect();
    const sourceWidth = target instanceof HTMLImageElement
      ? Number(target.naturalWidth || target.width || rect.width)
      : target instanceof HTMLCanvasElement
        ? Number(target.width || rect.width)
        : Number(payload.width || rect.width);
    const sourceHeight = target instanceof HTMLImageElement
      ? Number(target.naturalHeight || target.height || rect.height)
      : target instanceof HTMLCanvasElement
        ? Number(target.height || rect.height)
        : Number(payload.height || rect.height);
    return {
      ...payload,
      ocrMode: String(payload.ocrMode || "single"),
      sourceToken: getQuickSourceToken(target),
      sourceImageId: getSourceImageIdForTarget(target),
      sourceWidth,
      sourceHeight,
      targetCssWidth: Number(rect.width || 0),
      targetCssHeight: Number(rect.height || 0),
      coordinateSpace: payload.source === "visible-tab-crop" ? "source-image-v1" : String(payload.coordinateSpace || "ocr-image-v1")
    };
  }

  function getSourceImageIdForTarget(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return "";
    }
    const rect = target.getBoundingClientRect();
    const width = target instanceof HTMLImageElement
      ? Number(target.naturalWidth || target.width || rect.width)
      : target instanceof HTMLCanvasElement
        ? Number(target.width || rect.width)
        : Number(rect.width || 0);
    const height = target instanceof HTMLImageElement
      ? Number(target.naturalHeight || target.height || rect.height)
      : target instanceof HTMLCanvasElement
        ? Number(target.height || rect.height)
        : Number(rect.height || 0);
    const sourceToken = target instanceof HTMLCanvasElement
      ? `canvas:${computeCanvasSignature(target)}`
      : getQuickSourceToken(target);
    return `image-${hashSourceIdentity(sourceToken)}|${Math.round(width)}x${Math.round(height)}`;
  }

  function hashSourceIdentity(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildTargetSourceCacheKey(targetKey, sourceToken) {
    const base = String(targetKey || "");
    const token = String(sourceToken || "");
    return token ? `${base}|src:${hashSourceIdentity(token)}` : base;
  }

  function shouldUseKakaoCanonicalPipeline(target) {
    return !!(
      IS_KAKAOPAGE_READER &&
      state.captureMode === CAPTURE_MODE_DIRECT &&
      state.renderMode === RENDER_MODE_OVERLAY &&
      target instanceof HTMLImageElement
    );
  }

  function getStableChapterUrl() {
    const href = String(
      (typeof location !== "undefined" && location.href) ||
      `${(typeof location !== "undefined" && location.origin) || ""}${(typeof location !== "undefined" && location.pathname) || ""}${(typeof location !== "undefined" && location.search) || ""}`
    );
    const hashIndex = href.indexOf("#");
    return hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  }

  function normalizeKakaoStableImageSource(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    // Inline data has no stable identity independent of its bytes.
    if (isDataUrl(raw)) return "";
    // Blob URLs carry a document-local object token that distinguishes equal-size pages.
    if (isBlobUrl(raw)) {
      const hashIndex = raw.indexOf("#");
      return hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    }
    try {
      const base = (typeof location !== "undefined" && location.href) || undefined;
      const url = new URL(raw, base);
      url.hash = "";
      const retained = [];
      for (const [key, itemValue] of url.searchParams.entries()) {
        if (!KAKAO_AUTH_QUERY_PARAM_RE.test(key)) {
          retained.push([key, itemValue]);
        }
      }
      retained.sort((left, right) =>
        left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
      url.search = "";
      for (const [key, itemValue] of retained) {
        url.searchParams.append(key, itemValue);
      }
      return url.toString();
    } catch {
      return raw.replace(/([?&])(?:signature|credential|expires|policy|token|key-pair-id|x-amz-[^=&]+)=[^&#]*/gi, "$1")
        .replace(/[?&]+$/, "")
        .replace(/\?&/, "?");
    }
  }

  async function sha256HexBytes(bytes) {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject && cryptoObject.subtle && typeof cryptoObject.subtle.digest === "function") {
      const digest = await cryptoObject.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    }
    let fallback = 2166136261;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const value of view) {
      fallback ^= value;
      fallback = Math.imul(fallback, 16777619);
    }
    return (fallback >>> 0).toString(16).padStart(8, "0");
  }

  async function sha256HexText(value) {
    return sha256HexBytes(new TextEncoder().encode(String(value || "")));
  }

  function dataUrlToBytes(dataUrl) {
    const raw = String(dataUrl || "");
    const commaIndex = raw.indexOf(",");
    if (commaIndex < 0) {
      return new TextEncoder().encode(raw);
    }
    const header = raw.slice(0, commaIndex);
    const body = raw.slice(commaIndex + 1);
    if (/;base64(?:;|$)/i.test(header)) {
      const decoded = atob(body);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  }

  async function buildKakaoPageIdentity(target, payload, context = {}) {
    const width = Math.max(1, Math.round(Number(
      payload && (payload.sourceWidth || payload.width) ||
      target && (target.naturalWidth || target.width) || 0
    )));
    const height = Math.max(1, Math.round(Number(
      payload && (payload.sourceHeight || payload.height) ||
      target && (target.naturalHeight || target.height) || 0
    )));
    const imageRevision = await sha256HexBytes(dataUrlToBytes(payload && payload.dataUrl));
    const chapterId = `chapter-${await sha256HexText(getStableChapterUrl())}`;
    const rawSource = String(
      payload && payload.imageUrl ||
      payload && payload.sourceToken ||
      context.sourceToken ||
      target && target.dataset && getQuickSourceToken(target) ||
      payload && payload.sourceImageId || ""
    );
    const stableSource = normalizeKakaoStableImageSource(rawSource) || `inline:${imageRevision}`;
    const pageId = `page-${await sha256HexText(`${chapterId}\n${stableSource}\n${width}x${height}`)}`;
    const rect = target && typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : null;
    const identity = Object.freeze({
      chapterId,
      pageId,
      imageRevision,
      stableSource,
      width,
      height,
      readingOrder: Number(rect && rect.top || 0) + Number(window.scrollY || 0),
      shortPage: height <= 420 || height / Math.max(1, width) <= 0.45,
      imageMeta: Object.freeze({
        ...buildPayloadImageMeta(payload),
        chapterId,
        pageId,
        imageRevision,
        stableSource,
        sourceType: "page",
        pageIds: [pageId],
        imageRevisionByPage: { [pageId]: imageRevision }
      }),
      targetKey: String(context.targetKey || ""),
      scopedTargetKey: String(context.scopedTargetKey || ""),
      sourceToken: String(context.sourceToken || payload && payload.sourceToken || target && target.dataset && getQuickSourceToken(target) || "")
    });
    if (context.deferBind !== true) bindKakaoTargetToPage(target, pageId, imageRevision);
    return identity;
  }

  function bindKakaoTargetToPage(target, pageId, imageRevision = "") {
    if (!target || !pageId) {
      return;
    }
    const previousPageId = state.kakaoPageIdByTarget.get(target);
    if (previousPageId && previousPageId !== pageId) {
      const previousTargets = state.kakaoTargetsByPageId.get(previousPageId);
      if (previousTargets) {
        previousTargets.delete(target);
        if (previousTargets.size === 0) state.kakaoTargetsByPageId.delete(previousPageId);
      }
    }
    state.kakaoPageIdByTarget.set(target, pageId);
    const storedRevision = state.kakaoStore && typeof state.kakaoStore.getPageHandle === "function"
      ? state.kakaoStore.getPageHandle(pageId)?.imageRevision || ""
      : "";
    const currentRevision = String(
      imageRevision
      || (previousPageId === pageId ? state.kakaoImageRevisionByTarget.get(target) : "")
      || storedRevision
      || ""
    );
    if (currentRevision) state.kakaoImageRevisionByTarget.set(target, currentRevision);
    else state.kakaoImageRevisionByTarget.delete(target);
    const targets = state.kakaoTargetsByPageId.get(pageId) || new Set();
    targets.add(target);
    state.kakaoTargetsByPageId.set(pageId, targets);
  }

  function unbindKakaoTargetFromPage(target) {
    if (!target) return;
    const pageId = state.kakaoPageIdByTarget.get(target);
    state.kakaoPageIdByTarget.delete(target);
    state.kakaoImageRevisionByTarget.delete(target);
    if (!pageId) return;
    const targets = state.kakaoTargetsByPageId.get(pageId);
    if (!targets) return;
    targets.delete(target);
    if (targets.size === 0) state.kakaoTargetsByPageId.delete(pageId);
  }

  function detachKakaoTargetHandle(target) {
    if (!target) return "";
    const pageId = String(state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId) return "";
    const targets = state.kakaoTargetsByPageId.get(pageId);
    if (targets) {
      targets.delete(target);
      if (targets.size === 0) state.kakaoTargetsByPageId.delete(pageId);
    }
    if (state.kakaoStore && typeof state.kakaoStore.unbindPageTarget === "function") {
      state.kakaoStore.unbindPageTarget(target);
    }
    return pageId;
  }

  function detachKakaoTargetForSourceChange(target, scheduleRefresh = scheduleKakaoProjectionRefresh) {
    if (!target) return "";
    const pageId = String(state.kakaoPageIdByTarget.get(target) || "");
    unbindKakaoTargetFromPage(target);
    if (state.kakaoStore && typeof state.kakaoStore.unbindPageTarget === "function") {
      state.kakaoStore.unbindPageTarget(target);
    }
    // 新图片尚未完成 OCR 时，也要立刻让旧 canonical 的 standby 接管。
    if (pageId && typeof scheduleRefresh === "function") {
      scheduleRefresh([pageId], "page-handle-source-changed");
    }
    return pageId;
  }

  function getKakaoTargetGeneration(target) {
    return Math.max(0, Number(target && target.dataset && target.dataset.mtKakaoSourceGeneration) || 0);
  }

  function buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target) {
    return `${String(scopedTargetKey || "")}|generation:${getKakaoTargetGeneration(target)}`;
  }

  function getTargetExecutionToken(target) {
    return `${getQuickSourceToken(target)}|generation:${getKakaoTargetGeneration(target)}`;
  }

  function shouldRevalidateReconnectedKakaoTarget(target) {
    const pageId = String(state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId || !state.kakaoStore || typeof state.kakaoStore.getPageHandle !== "function") return false;
    const handle = state.kakaoStore.getPageHandle(pageId);
    return !!handle && (!handle.target || handle.target.isConnected === false);
  }

  function shouldRevalidateKakaoImageLoad(target) {
    const pageId = String(state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId || !state.kakaoStore || typeof state.kakaoStore.getPageHandle !== "function") return false;
    const handle = state.kakaoStore.getPageHandle(pageId);
    return !!handle && (handle.target === target || !handle.target || handle.target.isConnected === false);
  }

  function prepareKakaoTargetRevisionCheck(target, reason = "image-reload") {
    if (!target || !target.dataset) return 0;
    const previousPageId = String(state.kakaoPageIdByTarget.get(target) || "");
    const nextGeneration = getKakaoTargetGeneration(target) + 1;
    target.dataset.mtKakaoSourceGeneration = String(nextGeneration);
    target.dataset.mtKakaoRevisionCheck = "true";
    const targetKey = computeTargetKey(target);
    const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
    state.payloadCacheByTargetKey.delete(targetKey);
    state.payloadCacheByTargetKey.delete(scopedTargetKey);
    state.payloadCacheByTargetKey.delete(buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target));
    state.payloadCacheByTargetKey.delete(`${scopedTargetKey}|stitch`);
    state.localResultCache.delete(scopedTargetKey);
    if (previousPageId) {
      unbindKakaoTargetFromPage(target);
      if (state.kakaoStore && typeof state.kakaoStore.unbindPageTarget === "function") {
        state.kakaoStore.unbindPageTarget(target);
      }
      clearRenderedTarget(target);
      if (typeof window.setTimeout === "function") {
        scheduleKakaoProjectionRefresh([previousPageId], "page-image-revision-check");
      }
    }
    tracePipeline("canonical-revision-check", target, { reason, generation: nextGeneration });
    return nextGeneration;
  }

  function scheduleKakaoProjectionRefresh(pageIds, reason) {
    if (!kakaoCanonicalPipeline || typeof kakaoCanonicalPipeline.refresh !== "function") return;
    for (const pageId of Array.isArray(pageIds) ? pageIds : [pageIds]) {
      if (pageId) state.kakaoProjectionRefreshPageIds.add(String(pageId));
    }
    if (state.kakaoProjectionRefreshTimer || state.kakaoProjectionRefreshPageIds.size === 0) return;
    state.kakaoProjectionRefreshTimer = window.setTimeout(() => {
      state.kakaoProjectionRefreshTimer = 0;
      const focusPageIds = [...state.kakaoProjectionRefreshPageIds];
      state.kakaoProjectionRefreshPageIds.clear();
      Promise.resolve(kakaoCanonicalPipeline.refresh({
        reason: String(reason || "page-handle-change"),
        focusPageIds
      })).catch((error) => {
        console.warn("[MangaTranslator][Kakao canonical] projection refresh failed:", error);
      });
    }, 0);
  }

  function restoreKnownKakaoPageHandle(target) {
    if (!target || !shouldUseKakaoCanonicalPipeline(target)) return "";
    const pageId = String(state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId || !state.kakaoStore || typeof state.kakaoStore.getPageHandle !== "function") return "";
    const previous = state.kakaoStore.getPageHandle(pageId);
    if (!previous || previous.imageRevision == null) return "";
    const boundRevision = String(state.kakaoImageRevisionByTarget.get(target) || "");
    if (boundRevision && boundRevision !== String(previous.imageRevision || "")) return "";
    bindKakaoTargetToPage(target, pageId, previous.imageRevision);
    if (typeof state.kakaoStore.registerPageHandle === "function") {
      state.kakaoStore.registerPageHandle({
        ...previous,
        target,
        targetKey: computeTargetKey(target),
        scopedTargetKey: buildTargetSourceCacheKey(computeTargetKey(target), getQuickSourceToken(target)),
        sourceToken: getQuickSourceToken(target)
      });
    }
    scheduleKakaoProjectionRefresh([pageId], "page-handle-restored");
    return pageId;
  }

  function getTargetForKakaoPageId(pageId) {
    const normalizedPageId = String(pageId || "");
    const targets = state.kakaoTargetsByPageId.get(normalizedPageId);
    if (!targets) return null;

    const isUsable = (target) => !!target && target.isConnected &&
      state.kakaoPageIdByTarget.get(target) === normalizedPageId &&
      shouldUseKakaoCanonicalPipeline(target);
    const currentHandleTarget = state.kakaoStore && typeof state.kakaoStore.getPageHandle === "function"
      ? state.kakaoStore.getPageHandle(normalizedPageId)?.target
      : null;
    const currentImageRevision = state.kakaoStore && typeof state.kakaoStore.getPageHandle === "function"
      ? String(state.kakaoStore.getPageHandle(normalizedPageId)?.imageRevision || "")
      : "";

    let bestTarget = null;
    let bestVisibleArea = -1;
    for (const target of Array.from(targets)) {
      if (!isUsable(target)
        || (currentImageRevision
          && String(state.kakaoImageRevisionByTarget.get(target) || "") !== currentImageRevision)) {
        targets.delete(target);
        continue;
      }
      let visibleArea = 0;
      try {
        visibleArea = getVisibleArea(target.getBoundingClientRect());
      } catch {
        visibleArea = 0;
      }
      // 可见面积优先；面积相同时优先 Store 当前句柄，其次取后绑定 clone。
      if (
        visibleArea > bestVisibleArea ||
        (visibleArea === bestVisibleArea && target === currentHandleTarget) ||
        (visibleArea === bestVisibleArea && bestTarget !== currentHandleTarget)
      ) {
        bestTarget = target;
        bestVisibleArea = visibleArea;
      }
    }
    if (targets.size === 0) state.kakaoTargetsByPageId.delete(normalizedPageId);
    return bestTarget;
  }

  function findAdjacentKakaoPageTargets(target) {
    const targets = collectKakaopageManualTargetCandidates(true, target)
      .filter((candidate) => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete);
    const entries = buildKakaoStitchCandidateEntries(targets);
    const ownerIndex = entries.findIndex((entry) => entry && entry.target === target);
    if (ownerIndex < 0) {
      return { previous: null, next: null };
    }
    return {
      previous: findKakaoStitchNeighborTarget(entries, ownerIndex, "previous"),
      next: findKakaoStitchNeighborTarget(entries, ownerIndex, "next")
    };
  }

  async function detectAdjacentKakaoPixelRisk(pageARecord, pageBRecord) {
    const payloadA = pageARecord && pageARecord.payload;
    const payloadB = pageBRecord && pageBRecord.payload;
    const fragmentRisk = hasKakaoFragmentStructureRisk(pageARecord) || hasKakaoFragmentStructureRisk(pageBRecord);
    if (!payloadA || !payloadB || !isDataUrl(payloadA.dataUrl) || !isDataUrl(payloadB.dataUrl)) {
      return fragmentRisk ? Object.freeze({ risk: true, fragmentRisk: true }) : null;
    }
    const [imageA, imageB] = await Promise.all([
      loadImageFromDataUrl(payloadA.dataUrl),
      loadImageFromDataUrl(payloadB.dataUrl)
    ]);
    const overlap = findKakaoVerticalOverlap(
      sampleKakaoImageForOverlap(imageA),
      sampleKakaoImageForOverlap(imageB)
    );
    if (overlap && overlap.accepted) {
      return Object.freeze({ ...overlap, risk: true, ...(fragmentRisk ? { fragmentRisk: true } : {}) });
    }
    return fragmentRisk ? Object.freeze({ risk: true, fragmentRisk: true }) : null;
  }

  function hasKakaoFragmentStructureRisk(record) {
    if (!record || typeof KP.isKakaoPageEdgeFragment !== "function") return false;
    const identity = record.identity || record.pageIdentity || record;
    const payload = record.payload || {};
    const width = Math.max(1, Number(identity.width || payload.sourceWidth || payload.width || 0));
    const height = Math.max(1, Number(identity.height || payload.sourceHeight || payload.height || 0));
    const sourceKey = String(identity.stableSource || payload.imageUrl || record.sourceToken || "");
    return KP.isKakaoPageEdgeFragment({
      owner: { sourceKey, width, height },
      canonicalWidth: width,
      ownerHeight: height
    });
  }

  async function buildKakaoSeamPayload(pageARecord, pageBRecord, options = {}) {
    const payloadA = pageARecord && pageARecord.payload;
    const payloadB = pageBRecord && pageBRecord.payload;
    const identityA = pageARecord && (pageARecord.identity || pageARecord.pageIdentity || pageARecord);
    const identityB = pageBRecord && (pageBRecord.identity || pageBRecord.pageIdentity || pageBRecord);
    if (!payloadA || !payloadB || !identityA || !identityB) return null;
    if (!isDataUrl(payloadA.dataUrl) || !isDataUrl(payloadB.dataUrl)) return null;

    const [imageA, imageB] = await Promise.all([
      loadImageFromDataUrl(payloadA.dataUrl),
      loadImageFromDataUrl(payloadB.dataUrl)
    ]);
    const widthA = Number(identityA.width || imageA.naturalWidth || imageA.width || 0);
    const widthB = Number(identityB.width || imageB.naturalWidth || imageB.width || 0);
    const heightA = Number(identityA.height || imageA.naturalHeight || imageA.height || 0);
    const heightB = Number(identityB.height || imageB.naturalHeight || imageB.height || 0);
    const bitmapWidthA = Number(imageA.naturalWidth || imageA.width || 0);
    const bitmapWidthB = Number(imageB.naturalWidth || imageB.width || 0);
    const bitmapHeightA = Number(imageA.naturalHeight || imageA.height || 0);
    const bitmapHeightB = Number(imageB.naturalHeight || imageB.height || 0);
    if (!(widthA > 0 && widthB > 0 && heightA > 0 && heightB > 0)) return null;
    const requestedHeight = Number(options.height || options.bandHeight || 0);
    const bandHeight = Math.max(160, Math.min(420,
      Math.round(requestedHeight || Math.min(widthA, widthB) * 0.15)));
    const sourceBandA = Math.min(heightA, bandHeight);
    const sourceBandB = Math.min(heightB, bandHeight);
    const bitmapBandA = Math.min(bitmapHeightA, sourceBandA * bitmapHeightA / heightA);
    const bitmapBandB = Math.min(bitmapHeightB, sourceBandB * bitmapHeightB / heightB);
    const canvasWidth = Math.max(1, Math.round(Math.min(widthA, widthB)));
    const drawnHeightA = Math.max(1, Math.round(sourceBandA * canvasWidth / widthA));
    const drawnHeightB = Math.max(1, Math.round(sourceBandB * canvasWidth / widthB));
    const overlap = options.overlap || null;
    const overlapRows = overlap && overlap.accepted
      ? Math.round(Number(overlap.rows || 0) / Math.max(1, Number(overlap.currentRows || 1)) * drawnHeightB)
      : 0;
    const alignedOverlap = Math.max(0, Math.min(overlapRows, drawnHeightA - 1, drawnHeightB - 1));
    const canvasHeight = drawnHeightA + drawnHeightB - alignedOverlap;
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.drawImage(
      imageA,
      0,
      bitmapHeightA - bitmapBandA,
      bitmapWidthA,
      bitmapBandA,
      0,
      0,
      canvasWidth,
      drawnHeightA
    );
    context.drawImage(
      imageB,
      0,
      0,
      bitmapWidthB,
      bitmapBandB,
      0,
      drawnHeightA - alignedOverlap,
      canvasWidth,
      drawnHeightB
    );

    const pageIds = [String(identityA.pageId), String(identityB.pageId)];
    const imageRevisionByPage = {
      [pageIds[0]]: String(identityA.imageRevision || ""),
      [pageIds[1]]: String(identityB.imageRevision || "")
    };
    const segments = [
      {
        pageId: pageIds[0],
        drawRect: { x: 0, y: 0, w: canvasWidth, h: drawnHeightA },
        sourceCrop: { x: 0, y: heightA - sourceBandA, w: widthA, h: sourceBandA },
        naturalWidth: widthA,
        naturalHeight: heightA
      },
      {
        pageId: pageIds[1],
        drawRect: { x: 0, y: drawnHeightA - alignedOverlap, w: canvasWidth, h: drawnHeightB },
        sourceCrop: { x: 0, y: 0, w: widthB, h: sourceBandB },
        naturalWidth: widthB,
        naturalHeight: heightB
      }
    ];
    const pageSpans = segments.map((segment) => ({
      pageId: segment.pageId,
      canvasBox: {
        x: segment.drawRect.x,
        y: segment.drawRect.y,
        w: segment.drawRect.w,
        h: segment.drawRect.h
      },
      pageBox: {
        x: segment.sourceCrop.x,
        y: segment.sourceCrop.y,
        w: segment.sourceCrop.w,
        h: segment.sourceCrop.h
      },
      pageWidth: segment.naturalWidth,
      pageHeight: segment.naturalHeight
    }));
    return {
      dataUrl: canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY),
      imageUrl: `kakao-seam:${pageIds.join("+")}`,
      width: canvasWidth,
      height: canvasHeight,
      sourceWidth: canvasWidth,
      sourceHeight: canvasHeight,
      cssWidth: canvasWidth,
      cssHeight: canvasHeight,
      source: "kakao-seam",
      sourceType: "seam",
      ocrMode: "seam",
      pageIds,
      imageRevisionByPage,
      pageSpans,
      seam: {
        bandHeight,
        alignedOverlap,
        canvasWidth,
        canvasHeight,
        segments
      },
      coordinateSpace: "kakao-seam-v1"
    };
  }

  async function requestOcrForPayload(payload, context = {}) {
    const sourceType = context.sourceType === "seam" ? "seam" : "page";
    const pageIds = Array.isArray(context.pageIds) ? context.pageIds.map(String) : [];
    const imageRevisionByPage = context.imageRevisionByPage && typeof context.imageRevisionByPage === "object"
      ? context.imageRevisionByPage
      : {};
    const response = await sendRuntimeMessage({
      type: "OCR_DATA_URL",
      dataUrl: payload && payload.dataUrl,
      imageUrl: payload && payload.imageUrl,
      targetKey: String(context.requestKey || ""),
      ocrMode: String(payload && payload.ocrMode || (sourceType === "seam" ? "seam" : "single")),
      sourceToken: String(payload && payload.sourceToken || ""),
      sourceType,
      pageIds,
      imageRevision: String(context.imageRevision || (pageIds[0] && imageRevisionByPage[pageIds[0]]) || ""),
      imageRevisionByPage,
      requireCleanedImage: context.requireCleanedImage === true,
      forceCleanedImageArtifact: context.forceCleanedImageArtifact === true,
      imageMeta: {
        ...buildPayloadImageMeta(payload),
        ...(context.imageMeta || {}),
        sourceType,
        pageIds,
        imageRevisionByPage,
        pageSpans: payload && payload.pageSpans || context.imageMeta && context.imageMeta.pageSpans || null,
        seam: payload && payload.seam || null
      }
    });
    if (!response || !response.ok) return response;
    const result = normalizeOcrObservationResult(response.result, {
      sourceType,
      pageIds,
      imageRevisionByPage
    });
    return { ...response, result };
  }

  function normalizeOcrObservationResult(result, fallback = {}) {
    const normalizeObservation = (observation, filtered = false) => {
      const {
        translated_text: _legacyTranslatedText,
        translatedText: _legacyTranslatedTextCamel,
        ...evidence
      } = observation && typeof observation === "object" ? observation : {};
      const originalText = cleanRenderableText(observation && (observation.originalText || observation.original_text) || "");
      return Object.freeze({
        ...evidence,
        id: String(observation && (observation.id || observation.block_id) || ""),
        sourceType: observation && observation.sourceType === "seam" ? "seam" : String(fallback.sourceType || "page"),
        pageIds: Array.isArray(observation && observation.pageIds)
          ? observation.pageIds.map(String)
          : Array.from(fallback.pageIds || [], String),
        imageRevisionByPage: observation && observation.imageRevisionByPage || fallback.imageRevisionByPage || {},
        originalText,
        original_text: originalText,
        confidence: Number(observation && observation.confidence || 0),
        ...(filtered ? { filterReason: String(observation && observation.filterReason || "unspecified") } : {})
      });
    };
    const observations = Array.isArray(result && result.observations)
      ? result.observations.map((item) => normalizeObservation(item, false))
      : [];
    const filteredObservations = Array.isArray(result && result.filteredObservations)
      ? result.filteredObservations.map((item) => normalizeObservation(item, true))
      : [];
    return {
      ...(result || {}),
      observations,
      filteredObservations,
      edgeSignals: result && result.edgeSignals && typeof result.edgeSignals === "object"
        ? result.edgeSignals
        : { top: false, bottom: false },
      counts: result && result.counts || {
        eligible: observations.length,
        filtered: filteredObservations.length
      }
    };
  }

  async function requestCanonicalTranslations(items, context = {}) {
    const requestItems = (Array.isArray(items) ? items : []).map((item) => ({
      id: String(item && item.id || ""),
      revision: Math.max(1, Number(item && item.revision || 1)),
      original_text: String(item && (item.original_text || item.originalText) || "")
    })).filter((item) => item.id && item.original_text);
    if (requestItems.length === 0) {
      return { ok: true, result: { translations: [], errors: [], partial: false } };
    }
    const response = await sendRuntimeMessage({
      type: "TRANSLATE_TEXT_BLOCKS",
      sourceLanguage: String(context.sourceLanguage || KAKAO_CANONICAL_SOURCE_LANGUAGE),
      targetLanguage: String(context.targetLanguage || KAKAO_CANONICAL_TARGET_LANGUAGE),
      items: requestItems
    });
    if (!response) return response;
    const translations = Array.isArray(response.translations)
      ? response.translations
      : Array.isArray(response.result && response.result.translations)
        ? response.result.translations
        : [];
    const errors = Array.isArray(response.errors)
      ? response.errors
      : Array.isArray(response.result && response.result.errors)
        ? response.result.errors
        : [];
    if (!response.ok && !(response.partial === true && translations.length > 0)) {
      return response;
    }
    const normalized = {
      translations: translations.map((item) => ({
        ...item,
        id: String(item && item.id || ""),
        revision: Math.max(1, Number(item && item.revision || 1)),
        translated_text: cleanRenderableText(item && item.translated_text || ""),
        translationFingerprint: String(item && item.translationFingerprint || ""),
        cached: item && item.cached === true
      })).filter((item) => item.id && item.translated_text),
      errors,
      partial: response.partial === true || response.result && response.result.partial === true || errors.length > 0
    };
    return { ...response, ok: true, partial: normalized.partial, result: normalized };
  }

  function shouldUseKakaoStitchedOcr(target, payload) {
    return (
      IS_KAKAOPAGE_READER &&
      state.captureMode === CAPTURE_MODE_DIRECT &&
      state.renderMode === RENDER_MODE_OVERLAY &&
      target instanceof HTMLImageElement &&
      payload &&
      payload.kakaoOverlapCrop !== true &&
      isDataUrl(payload.dataUrl)
    );
  }

  async function buildKakaoStitchedPayload(target, ownerPayload) {
    return KP.buildKakaoStitchedPayload(target, ownerPayload, {
      collectCandidates: (owner) => collectKakaopageManualTargetCandidates(true, owner),
      isReadyImageTarget: (candidate) =>
        candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete,
      describeTarget: describeKakaoStitchTarget,
      extractAdjacentPayload: extractAdjacentKakaoPayload,
      loadImage: loadImageFromDataUrl,
      createCanvas: (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      imageMaxSide: IMAGE_MAX_SIDE,
      imageJpegQuality: IMAGE_JPEG_QUALITY,
      computeTargetKey,
      getQuickSourceToken,
      buildTargetSourceCacheKey
    });
  }
  function buildOcrRequestKey(targetKey, payload) {
    return KP.buildOcrRequestKey(targetKey, payload);
  }
  function shouldRejectKakaoPageEdgeStitch({ owner, ownerHeight, canonicalWidth, previous, next, previousHeight, nextHeight } = {}) {
    return KP.shouldRejectKakaoPageEdgeStitch({
      owner,
      ownerHeight,
      canonicalWidth,
      previous,
      next,
      previousHeight,
      nextHeight
    });
  }

  const isKakaoPageEdgeSource = KP.isKakaoPageEdgeSource;

  // Kakao page-edge CDN URLs must include authentication parameters
  // (signature, credential, expires) to be fetchable. If the URL lacks
  // these, wait briefly for the page's JS to inject them.
  const KAKAO_EDGE_AUTH_PARAM_RE = /[?&](?:signature|credential|expires)=/i;
  const KAKAO_EDGE_URL_WAIT_MS = 600;
  const KAKAO_EDGE_URL_POLL_MS = 50;

  function isKakaoEdgeUrlMissingAuth(url) {
    if (!url) return false;
    return isKakaoPageEdgeSource(url) && !KAKAO_EDGE_AUTH_PARAM_RE.test(url);
  }

  async function resolveImageUrlWithAuth(target) {
    let url = resolveImageUrl(target);
    if (!isKakaoEdgeUrlMissingAuth(url)) {
      return url;
    }
    // Poll currentSrc for auth params to appear (page JS adds them asynchronously)
    const deadline = Date.now() + KAKAO_EDGE_URL_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, KAKAO_EDGE_URL_POLL_MS));
      if (!target.isConnected) break;
      url = resolveImageUrl(target);
      if (!isKakaoEdgeUrlMissingAuth(url)) {
        return url;
      }
    }
    // Return whatever we have, even if auth params are still missing.
    // The background fetch will retry with different credential modes.
    console.warn("[MangaTranslator][KakaoPage] page-edge URL still missing auth params after wait, proceeding with:", url.slice(0, 120));
    return url;
  }

  function describeKakaoStitchTarget(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = target.getBoundingClientRect();
    const width = Number(rect.width || 0);
    const height = Number(rect.height || 0);
    if (!(width > 0 && height > 0)) {
      return null;
    }
    return {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      right: Number(rect.right || (Number(rect.left || 0) + width)),
      bottom: Number(rect.bottom || (Number(rect.top || 0) + height)),
      width,
      height,
      sourceKey: getQuickSourceToken(target),
      currentSrc: target.currentSrc || "",
      src: (target.getAttribute && target.getAttribute("src")) || ""
    };
  }

  function buildKakaoStitchCandidateEntries(targets) {
    return KP.buildKakaoStitchCandidateEntries(targets, describeKakaoStitchTarget);
  }

  function findKakaoStitchNeighborTarget(entries, ownerIndex, direction) {
    return KP.findKakaoStitchNeighborTarget(entries, ownerIndex, direction);
  }

  function findKakaoShortPageAttachmentOwnerTarget(entries, targetIndex, direction) {
    return KP.findKakaoShortPageAttachmentOwnerTarget(entries, targetIndex, direction);
  }

  function isKakaoStitchCandidatePastNeighborWindow(owner, candidate, direction) {
    return KP.isKakaoStitchCandidatePastNeighborWindow(owner, candidate, direction);
  }

  function isVerifiedKakaoStitchNeighbor(owner, candidate, direction) {
    return KP.isVerifiedKakaoStitchNeighbor(owner, candidate, direction);
  }

  function buildKakaoStitchWindowPlan({ owner, previous, next, canonicalWidth, ownerHeight, previousHeight, nextHeight }) {
    return KP.buildKakaoStitchWindowPlan({
      owner,
      previous,
      next,
      canonicalWidth,
      ownerHeight,
      previousHeight,
      nextHeight
    });
  }

  function isAttachableKakaoShortPage(candidate, owner, candidateHeight, ownerHeight) {
    return KP.isAttachableKakaoShortPage(candidate, owner, candidateHeight, ownerHeight);
  }

  async function requestTranslationForPayload(payload, requestKey) {
    return sendRuntimeMessage({
      type: "TRANSLATE_DATA_URL",
      dataUrl: payload.dataUrl,
      imageUrl: payload.imageUrl,
      targetKey: requestKey,
      ocrMode: String(payload.ocrMode || "single"),
      sourceToken: String(payload.sourceToken || ""),
      fallbackReason: String(payload.fallbackReason || ""),
      stitchAdmission: String(payload.stitchAdmission || ""),
      imageMeta: buildPayloadImageMeta(payload)
    });
  }

  function getBubbleLineCount(bubble) {
    return KP.getBubbleLineCount(bubble);
  }

  function shouldFallbackFromKakaoStitch(payload, rawResult, mappedResult) {
    return KP.shouldFallbackFromKakaoStitch(payload, rawResult, mappedResult);
  }

  async function extractAdjacentKakaoPayload(target) {
    try {
      const payload = await extractImagePayload(target);
      return payload && isDataUrl(payload.dataUrl) ? payload : null;
    } catch {
      return null;
    }
  }

  function mapKakaoStitchedResultForPipeline(result, payload, target, targetKey) {
    if (!payload || !payload.stitch || !result || !Array.isArray(result.bubbles)) {
      return result;
    }
    const targetRect = target && typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : null;
    const mappedResult = KP.mapKakaoStitchedResult(
      result,
      payload.stitch,
      targetRect,
      window.scrollX || 0,
      window.scrollY || 0
    );
    const mapped = Array.isArray(mappedResult && mappedResult.bubbles)
      ? mappedResult.bubbles
      : [];
    const withGlobalBoxes = mapped.map((bubble) => ({
      ...bubble,
      global_box: computeKakaoGlobalBoxFromTarget(bubble, target)
    }));
    tracePipeline("mapped", target, {
      rawBubbleCount: result.bubbles.length,
      mappedBubbleCount: mapped.length,
      targetKey: String(targetKey).slice(0, 80)
    });
    return {
      ...mappedResult,
      bubbles: withGlobalBoxes
    };
  }

  function mapKakaoStitchedResult(result, payload, target, targetKey) {
    const mappedResult = mapKakaoStitchedResultForPipeline(result, payload, target, targetKey);
    if (!mappedResult || !Array.isArray(mappedResult.bubbles)) {
      return mappedResult;
    }
    const targetRect = target && typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : null;
    return {
      ...mappedResult,
      bubbles: dedupeKakaoGlobalBubbles(mappedResult.bubbles, target, targetRect, targetKey)
    };
  }
  function mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH) {
    return KP.mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH);
  }

  function mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH) {
    return KP.mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH);
  }
  function computeKakaoGlobalBoxFromTarget(bubble, target) {
    if (!target || typeof target.getBoundingClientRect !== "function") return null;
    const rect = target.getBoundingClientRect();
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const bx = Number(bubble.x);
    const by = Number(bubble.y);
    const bw = Number(bubble.w);
    const bh = Number(bubble.h);
    if (![bx, by, bw, bh].every(Number.isFinite)) return null;
    return {
      left: rect.left + scrollX + (bx / 100) * rect.width,
      top: rect.top + scrollY + (by / 100) * rect.height,
      width: (bw / 100) * rect.width,
      height: (bh / 100) * rect.height
    };
  }

  function normalizeKakaoStitchSegments(stitch, compositeWidth, compositeHeight, ownerDraw) {
    return KP.normalizeKakaoStitchSegments(stitch, compositeWidth, compositeHeight, ownerDraw);
  }

  function getKakaoStitchOwnerOverlap(bubbleRect, segments) {
    return KP.getKakaoStitchOwnerOverlap(bubbleRect, segments);
  }

  function normalizeKakaoStitchDebugCoordinates(debug, stitch) {
    return KP.normalizeKakaoStitchDebugCoordinates(debug, stitch);
  }

  function normalizeDebugCoordinateItems(items, debug, context = {}) {
    return KP.normalizeDebugCoordinateItems(items, debug, context);
  }

  function getDebugItemPercentWithImageSize(item, imageWidth, imageHeight) {
    return KP.getDebugItemPercent(item, imageWidth, imageHeight);
  }
  async function dedupeKakaoResultByPageCoordinates(result, target, targetKey, scopedTargetKey = targetKey) {
    if (!IS_KAKAOPAGE_READER || !result || !Array.isArray(result.bubbles) || !targetKey) {
      return result;
    }
    return KP.dedupeKakaoResultByPageCoordinates({
      result,
      target,
      targetKey,
      scopedTargetKey,
      store: state.kakaoStore,
      adapters: {
        translateTrimmedBubble: translateTrimmedKakaoBubble,
        onSupersededEntry: removeSupersededKakaoGlobalEntry
      },
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0
    });
  }
  function trimKakaoBubbleBoundary(bubble, overlap) { return KP.trimKakaoBubbleBoundary(bubble, overlap); }

  function sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix) { return KP.sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix); }

  async function translateTrimmedKakaoBubble(bubble, targetKey) {
    try {
      const response = await sendRuntimeMessage({
        type: "TRANSLATE_TEXT_BLOCKS",
        sourceImageId: `${targetKey}|boundary-trim`,
        items: [{
          id: String(bubble.block_id || bubble.id || "boundary-trimmed"),
          original_text: bubble.original_text,
          x: bubble.x,
          y: bubble.y,
          w: bubble.w,
          h: bubble.h
        }]
      });
      const translated = response && response.ok && Array.isArray(response.translations)
        ? response.translations[0]
        : null;
      return {
        ...bubble,
        translated_text: cleanRenderableText(translated && translated.translated_text || "") || bubble.original_text
      };
    } catch {
      return { ...bubble, translated_text: bubble.original_text };
    }
  }

  function filterOcrDebugFinalBubbles(debug, bubbles) {
    return KP.filterOcrDebugFinalBubbles(debug, bubbles);
  }

  function syncOcrDebugFinalBubbles(debug, bubbles) {
    return KP.syncOcrDebugFinalBubbles(debug, bubbles);
  }
  function dedupeKakaoGlobalBubbles(bubbles, target, targetRect, targetKey) {
    return KP.runDedupeGlobalBubbles(
      bubbles,
      target,
      targetRect,
      targetKey,
      state.kakaoStore,
      {
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
        onSupersededEntry: removeSupersededKakaoGlobalEntry
      }
    );
  }

  function isKakaoGlobalDuplicateCandidate(candidate, entry) {
    return KP.isKakaoGlobalDuplicateCandidate(candidate, entry);
  }

  function isKakaoBoundaryOwnPair(candidate, entry) {
    return KP.isKakaoBoundaryOwnPair(candidate, entry);
  }

  function isKakaoBoundaryNeighborBubble(bubble) {
    return KP.isKakaoBoundaryNeighborBubble(bubble);
  }

  function areKakaoGlobalBoxesRelated(leftBox, rightBox) {
    return KP.areKakaoGlobalBoxesRelated(leftBox, rightBox);
  }

  function areOcrTextsDuplicateOrContained(first, second) {
    return KP.areOcrTextsDuplicateOrContained(first, second);
  }

  function hasSubstantialOcrTokenOverlap(first, second) {
    return KP.hasSubstantialOcrTokenOverlap(first, second);
  }

  function getLongestCommonSubstringLength(firstChars, secondChars, stopAt) {
    return KP.getLongestCommonSubstringLength(firstChars, secondChars, stopAt);
  }

  function getSubstantialOcrBoundaryOverlap(first, second) {
    return KP.getSubstantialOcrBoundaryOverlap(first, second);
  }
  function removeSupersededKakaoGlobalEntry(entry) {
    if (!entry) {
      return;
    }
    const ownerEntries = state.kakaoStore.getEntriesForKey(entry.targetKey);
    state.kakaoStore.setEntriesForKey(
      entry.targetKey,
      ownerEntries.filter((candidate) =>
        candidate !== entry &&
        !(candidate.bubble && entry.bubble && candidate.bubble === entry.bubble)
      )
    );
    if (Array.isArray(entry.bubbleContainer)) {
      const index = entry.bubbleContainer.indexOf(entry.bubble);
      if (index >= 0) {
        entry.bubbleContainer.splice(index, 1);
      }
    }
    if (Array.isArray(entry.entryContainer)) {
      const index = entry.entryContainer.indexOf(entry);
      if (index >= 0) {
        entry.entryContainer.splice(index, 1);
      }
    }

    const cacheKey = entry.scopedTargetKey || entry.targetKey;
    const cached = state.localResultCache.get(cacheKey);
    if (!cached || !Array.isArray(cached.bubbles)) {
      return;
    }
    const remaining = cached.bubbles.filter(
      (bubble) => normalizeOcrSimilarityText(bubble.original_text) !== entry.text
    );
    if (remaining.length === cached.bubbles.length) {
      return;
    }
    const nextResult = {
      ...cached,
      bubbles: remaining,
      debug: filterOcrDebugFinalBubbles(cached.debug, remaining)
    };
    state.localResultCache.set(cacheKey, nextResult);
    if (!entry.target || entry.target.isConnected === false) {
      return;
    }
    if (shouldUseEmbeddedRender(entry.target)) {
      restoreEmbeddedForTarget(entry.target);
      entry.target.dataset.mtLastTranslatedKey = "";
      queueTranslate(entry.target, { manual: true, force: true, reason: "kakao-cross-page-dedupe" });
      return;
    }
    renderOverlay(entry.target, entry.targetKey, nextResult);
  }

  function pageBoxIntersectionRatio(left, right) {
    return KP.pageBoxIntersectionRatio(left, right);
  }

  function normalizeOcrSimilarityText(value) {
    return KP.normalizeOcrSimilarityText(value);
  }

  function textSimilarity(first, second) {
    return KP.textSimilarity(first, second);
  }
  async function normalizeKakaopagePayload(target, payload, options = {}) {
    if (!IS_KAKAOPAGE_READER || !payload || !isSupportedTarget(target)) {
      return payload;
    }

    // Canonical 链路的单页 OCR 输入是权威证据：重复像素仅用于 seam 对齐，
    // 短页/碎图片也必须按自身完整字节独立进入 OCR。
    if (shouldUseKakaoCanonicalPipeline(target) && options.forceLegacyKakao !== true) {
      return payload;
    }

    const overlapCropped = await maybeCropKakaoOverlappedPayload(target, payload);
    if (overlapCropped) {
      return overlapCropped;
    }

    const rect = target.getBoundingClientRect();
    if (!KP.isKakaoStripPayload(payload, rect)) {
      return payload;
    }

    const captureRect = getVisibleViewportRect(target);
    if (!hasUsableKakaoStripCaptureRect(captureRect)) {
      // 页面滚动或虚拟列表重排可能让目标在提取期间只露出一小部分；这是可重试状态，不应上报为 OCR 错误。
      throw new Error(SCREENSHOT_TARGET_NOT_VISIBLE);
    }

    return captureVisibleTargetPayload(target, new Error("Kakao source image is a strip"), payload.imageUrl || "kakao-strip");
  }

  async function maybeCropKakaoOverlappedPayload(target, payload) {
    return KP.maybeCropKakaoOverlappedPayload(target, payload, {
      isReadyImageTarget: (candidate) =>
        candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete,
      isDataUrl,
      directCapture: state.captureMode === CAPTURE_MODE_DIRECT,
      collectCandidates: (owner) => collectKakaopageManualTargetCandidates(true, owner),
      describeTarget: describeKakaoStitchTarget,
      getNeighborPayload: getKakaoNeighborPayloadForOverlap,
      loadImage: loadImageFromDataUrl,
      sampleImage: sampleKakaoImageForOverlap,
      createCanvas: (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      getTargetRect: (candidate) => candidate.getBoundingClientRect(),
      getQuickSourceToken,
      imageJpegQuality: IMAGE_JPEG_QUALITY
    });
  }
  async function getKakaoNeighborPayloadForOverlap(target) {
    const targetKey = computeTargetKey(target);
    const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
    const cached = getPayloadCache(scopedTargetKey) || getPayloadCache(targetKey);
    if (cached && !cached.stitch && cached.kakaoOverlapCrop !== true && isDataUrl(cached.dataUrl)) {
      return cached;
    }
    return extractAdjacentKakaoPayload(target);
  }

  function sampleKakaoImageForOverlap(image) {
    const sourceWidth = image.naturalWidth || image.width || 0;
    const sourceHeight = image.naturalHeight || image.height || 0;
    if (!(sourceWidth > 0 && sourceHeight > 0)) {
      return null;
    }
    const width = KAKAO_OVERLAP_SAMPLE_WIDTH;
    const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return KP.computeGraySample({ data: pixels, width, height });
  }

  function findKakaoVerticalOverlap(previousSample, currentSample) {
    return KP.findKakaoVerticalOverlap(previousSample, currentSample);
  }

  function hasUsableKakaoStripCaptureRect(captureRect) {
    return KP.hasUsableKakaoStripCaptureRect(captureRect);
  }
  async function extractImagePayload(img) {
    if (!img.complete) {
      throw new Error("Image is not loaded yet");
    }

    const imageUrl = await resolveImageUrlWithAuth(img);

    // 图片 complete 但 naturalWidth=0 → CDN 限流或加载失败（常见于 429）
    if (
      img.complete &&
      !img.naturalWidth &&
      !img.naturalHeight &&
      imageUrl &&
      !isDataUrl(imageUrl)
    ) {
      if (IS_KAKAOPAGE_READER) {
        // 对于 Kakao page-edge 图片，触发自动重试
        throw new Error(SCREENSHOT_TARGET_NOT_VISIBLE);
      }
      throw new Error(`Image failed to load: ${imageUrl.slice(0, 80)}`);
    }

    if (isDataUrl(imageUrl)) {
      return {
        dataUrl: imageUrl,
        imageUrl: imageUrl.slice(0, 120),
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        cssWidth: img.getBoundingClientRect().width,
        cssHeight: img.getBoundingClientRect().height,
        source: "img-data-url"
      };
    }

    if (isHttpUrl(imageUrl)) {
      // Pass page URL as referrer so background fetch can set the Referer header.
      // Kakao CDNs check Referer for hotlink protection.
      const fetched = await sendRuntimeMessage({
        type: "FETCH_IMAGE_DATA_URL",
        url: imageUrl,
        referrer: location.href,
        preserveSize: shouldUseKakaoCanonicalPipeline(img),
        maxOriginalBytes: EMBEDDED_MAX_ORIGINAL_BYTES
      });

      if (fetched && fetched.ok && isDataUrl(fetched.dataUrl)) {
        return {
          dataUrl: fetched.dataUrl,
          imageUrl,
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          cssWidth: img.getBoundingClientRect().width,
          cssHeight: img.getBoundingClientRect().height,
          source: "img-fetch"
        };
      }
    }

    try {
      const fallbackDataUrl = imageElementToDataUrl(img);
      return {
        dataUrl: fallbackDataUrl,
        imageUrl,
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        cssWidth: img.getBoundingClientRect().width,
        cssHeight: img.getBoundingClientRect().height,
        source: "img-canvas"
      };
    } catch (error) {
      // Canvas 被跨域污染（SecurityError）→ 尝试截图回退。
      // 不 scrollIntoView（多图并行会导致页面跳动），改为抛出 SCREENSHOT_TARGET_NOT_VISIBLE
      // 依赖 retry 机制，当用户自然滚动到该位置时截图会成功。
      if (IS_KAKAOPAGE_READER && img.isConnected && (img.naturalWidth || 0) > 0 && !getVisibleViewportRect(img)) {
        throw new Error(SCREENSHOT_TARGET_NOT_VISIBLE);
      }
      return captureVisibleTargetPayload(img, error, imageUrl || "visible-tab-image-crop");
    }
  }

  async function extractCanvasPayload(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Invalid canvas target");
    }

    let firstError = null;

    try {
      const jpeg = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
      if (isDataUrl(jpeg)) {
        return {
          dataUrl: jpeg,
          imageUrl: "",
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
          source: "canvas"
        };
      }
    } catch (error) {
      firstError = error;
      // Ignore and fallback to png.
    }

    try {
      const png = canvas.toDataURL("image/png");
      if (isDataUrl(png)) {
        return {
          dataUrl: png,
          imageUrl: "",
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
          source: "canvas"
        };
      }
    } catch (error) {
      firstError = firstError || error;
      return captureVisibleTargetPayload(canvas, firstError, "visible-tab-canvas-crop");
    }

    throw new Error("Canvas data extraction failed");
  }

  async function captureVisibleTargetPayload(target, originalError, imageUrl) {
    const captureRect = getVisibleViewportRect(target);
    if (!captureRect) {
      throw new Error(SCREENSHOT_TARGET_NOT_VISIBLE);
    }

    const payload = await withOverlayLayerHidden(async () => {
      await waitForPaint();
      const captured = await sendRuntimeMessage({
        type: "CAPTURE_VISIBLE_TARGET_DATA_URL",
        rect: {
          left: captureRect.left,
          top: captureRect.top,
          width: captureRect.width,
          height: captureRect.height
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        devicePixelRatio: window.devicePixelRatio || 1
      });

      if (!captured || !captured.ok || !isDataUrl(captured.dataUrl)) {
        const fallbackError = captured && captured.error ? captured.error : "visible tab screenshot failed";
        const originalMessage = originalError && originalError.message ? originalError.message : "";
        throw new Error(
          originalMessage
            ? `Target screenshot fallback failed: ${fallbackError}; original error: ${originalMessage}`
            : `Target screenshot fallback failed: ${fallbackError}`
        );
      }

      return captured;
    });

    const targetRect = target.getBoundingClientRect();
    return {
      dataUrl: payload.dataUrl,
      imageUrl: String(imageUrl || "visible-tab-target-crop"),
      width: Number(payload.width || 0),
      height: Number(payload.height || 0),
      bitmapWidth: Number(payload.bitmapWidth || 0),
      bitmapHeight: Number(payload.bitmapHeight || 0),
      cropX: Number(payload.cropX || 0),
      cropY: Number(payload.cropY || 0),
      devicePixelRatio: window.devicePixelRatio || 1,
      cssWidth: captureRect.width,
      cssHeight: captureRect.height,
      source: "visible-tab-crop",
      displayRect: {
        offsetX: captureRect.left - targetRect.left,
        offsetY: captureRect.top - targetRect.top,
        width: captureRect.width,
        height: captureRect.height
      }
    };
  }

  function getVisibleViewportRect(target) {
    const rect = target.getBoundingClientRect();
    const left = clamp(rect.left, 0, window.innerWidth);
    const top = clamp(rect.top, 0, window.innerHeight);
    const right = clamp(rect.right, 0, window.innerWidth);
    const bottom = clamp(rect.bottom, 0, window.innerHeight);
    const width = right - left;
    const height = bottom - top;

    if (!(width >= 2 && height >= 2)) {
      return null;
    }

    return { left, top, width, height };
  }

  async function withOverlayLayerHidden(callback) {
    const overlayLayer = state.overlayLayer;
    const floatingBallWrap = state.floatingBallWrap;
    const markedOverlays = Array.from(document.querySelectorAll("[data-manga-translator-overlay]"));
    const shouldHideOverlay = overlayLayer && overlayLayer.isConnected;
    const shouldHideBall = floatingBallWrap && floatingBallWrap.isConnected;
    const previousFloatingVisibility = shouldHideBall ? floatingBallWrap.style.visibility : "";
    const previousMarkedVisibility = markedOverlays.map((node) => ({
      node,
      visibility: node.style.visibility
    }));

    if (shouldHideOverlay && state.overlayHideDepth === 0) {
      state.overlayPreviousVisibility = overlayLayer.style.visibility;
    }
    if (shouldHideOverlay) {
      state.overlayHideDepth += 1;
      overlayLayer.style.visibility = "hidden";
    }
    if (shouldHideBall) {
      floatingBallWrap.style.visibility = "hidden";
    }
    markedOverlays.forEach((node) => {
      node.style.visibility = "hidden";
    });
    try {
      return await callback();
    } finally {
      if (shouldHideOverlay) {
        state.overlayHideDepth = Math.max(0, state.overlayHideDepth - 1);
        if (state.overlayHideDepth === 0) {
          overlayLayer.style.visibility = state.overlayPreviousVisibility;
          state.overlayPreviousVisibility = "";
        }
      }
      if (shouldHideBall && floatingBallWrap.isConnected) {
        floatingBallWrap.style.visibility = previousFloatingVisibility;
      }
      previousMarkedVisibility.forEach((entry) => {
        if (entry.node && entry.node.isConnected) {
          entry.node.style.visibility = entry.visibility;
        }
      });
      ensureExtensionUiMounted();
    }
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  async function extractBackgroundImagePayload(target) {
    const imageUrl = resolveBackgroundImageUrl(target);
    if (!imageUrl) {
      throw new Error("Background image is unavailable");
    }

    if (isDataUrl(imageUrl)) {
      const size = await decodeDataUrlImageSize(imageUrl);
      return {
        dataUrl: imageUrl,
        imageUrl: imageUrl.slice(0, 120),
        width: size.width,
        height: size.height
      };
    }

    let dataUrl = "";
    if (isBlobUrl(imageUrl)) {
      dataUrl = await fetchPageImageDataUrl(imageUrl);
    } else if (isHttpUrl(imageUrl)) {
      const fetched = await sendRuntimeMessage({
        type: "FETCH_IMAGE_DATA_URL",
        url: imageUrl,
        referrer: location.href
      });
      if (fetched && fetched.ok && isDataUrl(fetched.dataUrl)) {
        dataUrl = fetched.dataUrl;
      }
    }

    if (!isDataUrl(dataUrl)) {
      return captureVisibleTargetPayload(target, new Error("Background image data extraction failed"), imageUrl);
    }

    const size = await decodeDataUrlImageSize(dataUrl);
    return {
      dataUrl,
      imageUrl,
      width: size.width,
      height: size.height
    };
  }

  function imageElementToDataUrl(img) {
    const srcWidth = img.naturalWidth || img.width || img.clientWidth;
    const srcHeight = img.naturalHeight || img.height || img.clientHeight;

    if (!srcWidth || !srcHeight) {
      throw new Error("Image size is unavailable");
    }

    const maxSide = IMAGE_MAX_SIDE;
    const longest = Math.max(srcWidth, srcHeight);
    const scale = longest > maxSide ? maxSide / longest : 1;
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    try {
      return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
    } catch {
      return canvas.toDataURL("image/png");
    }
  }

  async function renderCachedKakaoPipelineResult({ target, targetKey, scopedTargetKey, result }) {
    state.localResultCache.set(scopedTargetKey, result);
    if (result.bubbles.length === 0) {
      clearRenderedTarget(target);
      return;
    }
    if (shouldUseEmbeddedRender(target)) {
      renderLoadingOverlay(target, targetKey, "生成嵌入图片中...");
    }
    const payload = shouldUseEmbeddedRender(target)
      ? await extractTargetPayload(target, scopedTargetKey, { skipKakaoStitch: true })
      : null;
    await renderTranslationResult(target, targetKey, result, payload);
  }

  async function renderKakaoPipelineResult({
    target,
    targetKey,
    scopedTargetKey,
    result,
    payload,
    response,
    options,
    context
  }) {
    const expectedSourceImageId = String(payload && payload.sourceImageId || "");
    if (!target.isConnected || (expectedSourceImageId && getSourceImageIdForTarget(target) !== expectedSourceImageId)) {
      clearRenderedTarget(target);
      return;
    }

    releaseUncoveredKakaoShortPages(
      context && context.stitchPayload || payload,
      result,
      target,
      "ownerSucceededWithoutShortPageBubble"
    );
    rememberLocalResult(scopedTargetKey, result);

    if (result.bubbles.length > 0) {
      updateLoadingOverlayText(target, targetKey, shouldUseEmbeddedRender(target) ? "生成嵌入图片中..." : "排版中...");
      await renderTranslationResult(target, targetKey, result, payload, { stream: true });
      target.dataset.mtNoTextKey = "";
    } else {
      updateLoadingOverlayText(target, targetKey, "未识别到文本");
      await sleep(1500);
      clearRenderedTarget(target);
      target.dataset.mtNoTextKey = targetKey;
    }

    target.dataset.mtLastTranslatedKey = targetKey;
    await reportStatus("info", "translation done", {
      reason: options && options.reason,
      bubbles: result.bubbles.length,
      cached: !!(response && response.cached)
    });
  }

  function releaseKakaoPipelineErrorAttachments(payload, owner, ownerScopedKey) {
    const attachedKeys = payload && Array.isArray(payload.attachedShortPageKeys)
      ? payload.attachedShortPageKeys
      : [];
    for (const shortKey of attachedKeys) {
      const target = findTargetByScopedKey(shortKey);
      if (!target) {
        continue;
      }
      KP.releaseShortPagesForOwner(state.kakaoStore, [target], ownerScopedKey);
      tracePipeline("short-detached", target, {
        reason: "ownerFailedReleasingShortPage",
        ownerScopedKey
      });
    }
  }

  async function reportKakaoPipelineError(error, target, options) {
    const reason = getErrorMessage(error);
    if (CONTEXT_INVALIDATED_RE.test(reason)) {
      markInvalidated(reason);
      return;
    }
    await reportStatus("error", reason, {
      reason: options && options.reason,
      targetTag: target && target.tagName ? target.tagName.toLowerCase() : "unknown"
    });
  }

  function projectionToRendererBubble(projection) {
    const source = projection && projection.bubble && typeof projection.bubble === "object"
      ? projection.bubble
      : projection || {};
    const rawGeometry = projection && (
      projection.geometry || projection.pageLocalBox || projection.box
    ) || source.geometry || source.pageLocalBox || source.box || source;
    const geometry = Array.isArray(rawGeometry) ? rawGeometry[0] || {} : rawGeometry;
    const visual = projection && projection.visual || source.visual || {};
    const rawRole = String(projection && projection.role || source.projection_role || "text_primary");
    const role = rawRole === "primary" ? "text_primary"
      : rawRole === "standby" && projection && projection.coverOnly === true ? "cover_only"
        : rawRole === "standby" ? "text_standby"
        : rawRole === "cover" ? "cover_only"
          : rawRole;
    const originalText = String(
      projection && (projection.originalText || projection.original_text) ||
      source.originalText || source.original_text || ""
    );
    const translatedText = String(
      projection && (projection.translatedText || projection.translated_text) ||
      source.translatedText || source.translated_text || ""
    );
    return {
      ...source,
      x: Number(geometry && (geometry.x ?? geometry.left) || 0),
      y: Number(geometry && (geometry.y ?? geometry.top) || 0),
      w: Number(geometry && (geometry.w ?? geometry.width) || 0),
      h: Number(geometry && (geometry.h ?? geometry.height) || 0),
      fill_box: source.fill_box || visual.fill_box || visual.fillBox || null,
      bg_type: source.bg_type || visual.bg_type || visual.bgType || "none",
      bg_color: source.bg_color || visual.bg_color || visual.bgColor || "",
      bg_confidence: Number(source.bg_confidence || visual.bg_confidence || visual.bgConfidence || 0),
      region_id: String(source.region_id || visual.region_id || visual.regionId || ""),
      region_type: String(source.region_type || visual.region_type || visual.regionType || "plain_text"),
      region_polygon: source.region_polygon || visual.region_polygon || visual.regionPolygon || null,
      polygon: source.polygon || visual.polygon || null,
      text_color: source.text_color || visual.text_color || visual.textColor || "",
      stroke_color: source.stroke_color || visual.stroke_color || visual.strokeColor || "",
      rotation_deg: Number(source.rotation_deg || visual.rotation_deg || visual.rotationDeg || 0),
      source_line_count: Math.max(1, Number(source.source_line_count || visual.source_line_count || visual.sourceLineCount || 1)),
      block_id: String(
        projection && (projection.projectionId || projection.id) ||
        source.block_id || source.id || ""
      ),
      canonical_id: String(projection && (projection.canonicalId || projection.groupId) || source.canonical_id || ""),
      canonical_revision: Math.max(1, Number(projection && (projection.canonicalRevision || projection.groupRevision || projection.revision) || source.canonical_revision || 1)),
      projection_role: role,
      original_text: originalText,
      translated_text: role === "cover_only" ? "" : translatedText
    };
  }

  function normalizeProjectionPages(input) {
    const normalized = new Map();
    const add = (pageId, projections) => {
      if (!pageId) return;
      normalized.set(String(pageId), Array.isArray(projections) ? projections : []);
    };
    if (input && input.projectionsByPage instanceof Map) {
      for (const [pageId, projections] of input.projectionsByPage.entries()) add(pageId, projections);
    } else if (input && input.projectionsByPage && typeof input.projectionsByPage === "object") {
      for (const [pageId, projections] of Object.entries(input.projectionsByPage)) add(pageId, projections);
    } else {
      add(input && input.pageId, input && input.projections);
    }
    return normalized;
  }

  async function renderCanonicalProjections(input = {}) {
    const pages = normalizeProjectionPages(input);
    const allTextCandidates = new Map();
    for (const [pageId, projections] of pages.entries()) {
      for (const projection of projections) {
        const rawRole = String(projection && projection.role || "text_primary");
        const role = rawRole === "primary" ? "text_primary" : rawRole === "standby" ? "text_standby" : rawRole;
        if (role !== "text_primary" && role !== "text_standby") continue;
        const canonicalId = String(projection && (projection.canonicalId || projection.groupId || projection.id) || "");
        if (!canonicalId) continue;
        const target = getTargetForKakaoPageId(pageId);
        if (!target) continue;
        const candidates = allTextCandidates.get(canonicalId) || [];
        candidates.push({ pageId, projection, target, role });
        allTextCandidates.set(canonicalId, candidates);
      }
    }

    const activeProjectionIds = new Set();
    for (const candidates of allTextCandidates.values()) {
      candidates.sort((left, right) => {
        const leftPrimary = left.role === "text_primary" ? 0 : 1;
        const rightPrimary = right.role === "text_primary" ? 0 : 1;
        return leftPrimary - rightPrimary || String(left.pageId).localeCompare(String(right.pageId));
      });
      const selected = candidates.find((candidate) => candidate.projection.activeText === true) ||
        candidates.find((candidate) => candidate.projection.active !== false) || candidates[0];
      activeProjectionIds.add(String(selected.projection.projectionId || selected.projection.id || ""));
    }

    let renderedCount = 0;
    for (const [pageId, projections] of pages.entries()) {
      const target = getTargetForKakaoPageId(pageId) || (pageId === String(input.pageId || "") ? input.target : null);
      if (!target || !target.isConnected) continue;
      const bubbles = [...projections]
        .sort((left, right) => {
          const leftCover = left && (left.role === "cover" || left.role === "cover_only" || left.coverOnly === true) ? 0 : 1;
          const rightCover = right && (right.role === "cover" || right.role === "cover_only" || right.coverOnly === true) ? 0 : 1;
          return leftCover - rightCover;
        })
        .filter((projection) => {
          const rawRole = String(projection && projection.role || "text_primary");
          const role = rawRole === "primary" ? "text_primary"
            : rawRole === "standby" && projection && projection.coverOnly === true ? "cover_only"
              : rawRole === "standby" ? "text_standby"
              : rawRole === "cover" ? "cover_only"
                : rawRole;
          if (role === "cover_only") return projection.active !== false;
          if (typeof projection.activeText === "boolean") return projection.activeText;
          const projectionId = String(projection && (projection.projectionId || projection.id) || "");
          return activeProjectionIds.has(projectionId);
        })
        .map(projectionToRendererBubble)
        .filter((bubble) => bubble.w > 0 && bubble.h > 0)
        .filter((bubble) => bubble.projection_role === "cover_only" || bubble.translated_text);
      const targetKey = computeTargetKey(target);
      const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
      const result = {
        bubbles,
        cleanedImage: input.cleanedImageByPage && input.cleanedImageByPage[pageId] ||
          input.result && input.result.cleanedImage || null,
        debug: input.debugByPage && input.debugByPage[pageId] || null
      };
      rememberLocalResult(scopedTargetKey, result);
      if (bubbles.length > 0) {
        await renderTranslationResult(target, targetKey, result, input.payloadByPage && input.payloadByPage[pageId] || input.payload || null, { stream: true });
        target.dataset.mtNoTextKey = "";
      } else {
        clearRenderedTarget(target);
        target.dataset.mtNoTextKey = scopedTargetKey;
      }
      target.dataset.mtLastTranslatedKey = scopedTargetKey;
      renderedCount += bubbles.length;
    }
    return { ok: true, bubbles: renderedCount };
  }

  async function renderTranslationResult(target, targetKey, result, payload, options = {}) {
    if (IS_KAKAOPAGE_READER) {
      const renderable = isKakaopageTargetStillRenderable(target);
      if (!renderable.ok) {
        console.debug("[MangaTranslator][KakaoPage] overlay hidden (target outside viewport, auto-shows on scroll-back):", renderable.reason);
      } else {
        const rect = target.getBoundingClientRect();
        console.debug("[MangaTranslator][KakaoPage] render check complete", {
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
          bubbles: Array.isArray(result.bubbles) ? result.bubbles.length : 0,
          renderMode: options.renderMode || state.renderMode || "overlay",
          targetTag: target.tagName.toLowerCase(),
        });
      }
    }

    scheduleTermDiscovery(target, targetKey, result, payload);

    if (shouldUseEmbeddedRender(target) && !getPayloadDisplayRect(payload)) {
      await renderEmbeddedTranslation(target, targetKey, result, payload);
      removeOverlayForTarget(target);
      return;
    }

    restoreEmbeddedForTarget(target);
    renderOverlay(target, targetKey, result, {
      ...options,
      imageMeta: getPayloadImageMeta(payload),
      displayRect: payload && payload.coordinateSpace === "source-image-v1" ? null : getPayloadDisplayRect(payload)
    });
  }

  function isKakaopageTargetStillRenderable(target) {
    if (!target || !target.isConnected) {
      return { ok: false, reason: "target disconnected" };
    }

    const rect = target.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 40) {
      return { ok: false, reason: `target too small: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}` };
    }

    const visibleRect = getVisibleViewportRect(target);
    if (!visibleRect) {
      return { ok: false, reason: "no visible viewport rect" };
    }

    if (visibleRect.width < 40 || visibleRect.height < 30) {
      return {
        ok: false,
        reason: `visible rect too small: ${visibleRect.width.toFixed(0)}x${visibleRect.height.toFixed(0)}`,
      };
    }

    const visibleArea = getVisibleArea(rect);
    if (visibleArea < 3000) {
      return { ok: false, reason: `visible area too small: ${visibleArea.toFixed(0)}` };
    }

    return { ok: true, reason: "" };
  }

  function isEmbeddedRenderMode() {
    return state.renderMode === RENDER_MODE_EMBEDDED;
  }

  function shouldUseEmbeddedRender(target) {
    return isEmbeddedRenderMode() && !isBackgroundImageTarget(target);
  }

  function getExistingRenderedState(targetId) {
    return state.embeddedById.get(targetId) || state.overlaysById.get(targetId) || null;
  }

  function isEmbeddedRenderStillApplied(renderedState) {
    if (!renderedState || renderedState.mode !== "embedded") {
      return true;
    }

    const target = renderedState.target;
    if (renderedState.kind === "background" && target instanceof HTMLElement) {
      const backgroundImage = String(getComputedStyle(target).backgroundImage || target.style.backgroundImage || "");
      return target.dataset.mtEmbeddedActive === "true" && /url\((["']?)data:/i.test(backgroundImage);
    }

    if (renderedState.kind !== "image" || !(target instanceof HTMLImageElement)) {
      return true;
    }

    const currentSource = String(target.currentSrc || target.getAttribute("src") || "").trim();
    return target.dataset.mtEmbeddedActive === "true" && isDataUrl(currentSource);
  }

  function renderOverlay(target, targetKey, result, options = {}) {
    const bubbles = Array.isArray(result.bubbles) ? result.bubbles : [];
    const stream = options.stream === true;

    if (bubbles.length === 0) {
      removeOverlayForTarget(target);
      return;
    }

    ensureOverlayLayer();

    const targetId = getTargetId(target);
    const oldOverlay = state.overlaysById.get(targetId);
    if (oldOverlay) {
      oldOverlay.root.remove();
      state.overlaysById.delete(targetId);
    }

    const root = document.createElement("div");
    root.className = "mt-overlay-root";
    root.dataset.mangaTranslatorOverlay = "true";
    root.dataset.targetId = targetId;
    if (result && isDataUrl(result.cleanedImage)) {
      root.style.setProperty("--mt-cleaned-image", `url("${result.cleanedImage}")`);
    }
    appendOcrDebugNodes(root, result);

    const bubbleNodes = [];
    const backgroundTarget = IS_PIXIV_COMIC_VIEWER && isBackgroundImageTarget(target);
    bubbles.forEach((bubble, index) => {
      const bubbleNode = createBubbleNode(bubble, index, { backgroundTarget });
      if (bubbleNode) {
        if (stream) {
          const delayMs = Math.min(index * 34, 320);
          bubbleNode.classList.add("mt-stream-enter");
          bubbleNode.style.setProperty("--mt-stream-delay", `${delayMs}ms`);
        }
        bubbleNodes.push(bubbleNode);
        root.appendChild(bubbleNode);
      }
    });

    if (bubbleNodes.length === 0) {
      return;
    }

    const overlayState = {
      target,
      targetId,
      targetKey,
      sourceToken: getQuickSourceToken(target),
      root,
      bubbleNodes,
      bubbleCount: bubbleNodes.length,
      isBackgroundTarget: backgroundTarget,
      mode: "bubbles",
      imageMeta: options.imageMeta || null,
      displayRect: options.displayRect || null
    };

    state.overlayLayer.appendChild(root);
    state.overlaysById.set(targetId, overlayState);
    syncOverlayPosition(overlayState);
    if (!bubbles.some((bubble) => bubble && bubble.canonical_id)) {
      syncKakaoVisualDuplicateBubbles(true);
    }
    ensureOverlayFrameSync();
    logOcrDebugMapping(overlayState, result);
    if (result && result.debug) {
      console.info("[MangaTranslator][OCR chain] rendered", {
        frontendRenderedOverlays: bubbleNodes.length,
        targetKey,
        targetId
      });
    }

    if (stream) {
      bubbleNodes.forEach((node, index) => {
        const clearDelay = Math.min(index * 34, 320) + 420;
        window.setTimeout(() => {
          if (node.isConnected) {
            node.classList.remove("mt-stream-enter");
            node.style.removeProperty("--mt-stream-delay");
          }
        }, clearDelay);
      });
    }
    tracePipeline("rendered", target, {
      bubbleCount: bubbleNodes.length,
      targetKey: String(targetKey).slice(0, 80)
    });
  }

  function scheduleTermDiscovery(target, targetKey, result, payload) {
    if (state.invalidated) {
      return;
    }
    const sourceIdentity = String(
      payload && (payload.sourceImageId || payload.sourceToken) ||
      buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target))
    );
    const message = buildTermDiscoveryMessage(
      result,
      targetKey,
      sourceIdentity,
      location.href,
      document.title
    );
    if (!message) {
      return;
    }
    const sendKey = `${message.pageUrl}|${message.targetKey}|${hashSourceIdentity(JSON.stringify(message.blocks))}`;
    if (state.termDiscoverySentKeys.has(sendKey)) {
      return;
    }
    state.termDiscoverySentKeys.add(sendKey);
    if (state.termDiscoverySentKeys.size > 500) {
      state.termDiscoverySentKeys.delete(state.termDiscoverySentKeys.values().next().value);
    }
    sendRuntimeMessage(message).catch(() => {
      // 术语发现是旁路能力，离线或扩展重载都不能影响译文渲染。
    });
  }

  function buildTermDiscoveryMessage(result, targetKey, sourceIdentity, pageUrl, pageTitle) {
    const imageId = `image-${hashSourceIdentity(`${targetKey}|${sourceIdentity}`)}`;
    const blocks = (result && Array.isArray(result.bubbles) ? result.bubbles : [])
      .map((bubble, index) => {
        if (bubble && bubble.projection_role === "cover_only") {
          return null;
        }
        const originalText = String(bubble && bubble.original_text || "").trim();
        if (!originalText) {
          return null;
        }
        const translatedText = String(bubble && bubble.translated_text || "").trim();
        const rawBlockId = String(bubble && (bubble.block_id || bubble.id) || index);
        const evidenceHash = hashSourceIdentity(`${rawBlockId}|${originalText}`);
        return {
          id: `${imageId}-${evidenceHash}`,
          originalText,
          translatedText
        };
      })
      .filter(Boolean);
    if (blocks.length === 0) {
      return null;
    }
    return {
      type: "DISCOVER_TERMS",
      pageUrl: String(pageUrl || ""),
      pageTitle: String(pageTitle || ""),
      targetKey: imageId,
      blocks
    };
  }

  function syncKakaoVisualDuplicateBubbles(force = false) {
    if (!IS_KAKAOPAGE_READER || !KP || typeof KP.selectKakaoVisualDuplicateLoser !== "function") {
      return;
    }
    const now = performance.now();
    if (!force && now - state.lastKakaoVisualDedupeAt < 120) {
      return;
    }
    state.lastKakaoVisualDedupeAt = now;

    // 每次按当前视口重新计算。之前隐藏的 overflow 在 owner 离开视口后必须恢复，
    // 否则滚动时会把唯一仍可见的译文永久留在隐藏状态。
    state.overlaysById.forEach((overlayState) => {
      if (!overlayState || !Array.isArray(overlayState.bubbleNodes)) return;
      overlayState.bubbleNodes.forEach((node) => {
        if (!node || node.dataset.mtVisualDedupeHidden !== "true") return;
        node.style.removeProperty("visibility");
        delete node.dataset.mtVisualDedupeHidden;
      });
    });

    const candidates = [];
    state.overlaysById.forEach((overlayState) => {
      if (!overlayState || !overlayState.root || !overlayState.root.isConnected) return;
      if (overlayState.root.style.display === "none") return;
      overlayState.bubbleNodes.forEach((node) => {
        if (!node || !node.isConnected) return;
        if (node.dataset.canonicalId) return;
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;
        candidates.push({
          overlayState,
          node,
          descriptor: {
            scopeKey: overlayState.targetKey,
            regionType: String(node.dataset.regionType || ""),
            stitchOverflow: node.dataset.stitchOverflow === "true",
            originalText: String(node.dataset.original || ""),
            translatedText: String(node.dataset.translated || ""),
            box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          }
        });
      });
    });

    const removed = new Set();
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      const left = candidates[leftIndex];
      if (removed.has(left.node)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const right = candidates[rightIndex];
        if (removed.has(right.node)) continue;
        const loserSide = KP.selectKakaoVisualDuplicateLoser(left.descriptor, right.descriptor);
        if (!loserSide) continue;
        const loser = loserSide === "left" ? left : right;
        loser.node.style.visibility = "hidden";
        loser.node.dataset.mtVisualDedupeHidden = "true";
        removed.add(loser.node);
        if (loser === left) break;
      }
    }
  }

  function appendOcrDebugNodes(root, result) {
    const debug = result && result.debug;
    if (!debug || !root) {
      return;
    }
    const stages = [
      { name: "raw", items: debug.rawItems, className: "mt-debug-raw" },
      { name: "duplicate", items: debug.duplicateItems, className: "mt-debug-duplicate" },
      { name: "deduped", items: debug.dedupedItems, className: "mt-debug-deduped" },
      { name: "block", items: debug.finalBubbles, className: "mt-debug-block" }
    ];
    stages.forEach((stage) => {
      (Array.isArray(stage.items) ? stage.items : []).forEach((item, index) => {
        const percent = getDebugItemPercent(item, debug);
        if (!percent) {
          return;
        }
        const node = document.createElement("div");
        node.className = `mt-debug-box ${stage.className}`;
        node.style.left = `${percent.x}%`;
        node.style.top = `${percent.y}%`;
        node.style.width = `${percent.w}%`;
        node.style.height = `${percent.h}%`;
        const blockId = String(item.blockId || item.block_id || item.id || `${stage.name}-${index}`);
        const original = String(item.text || item.originalText || "").replace(/\s+/g, " ").slice(0, 28);
        const translated = String(item.translatedText || item.translated_text || "").replace(/\s+/g, " ").slice(0, 28);
        const duplicate = item.isDuplicate ? " duplicate" : "";
        node.dataset.label = `${blockId}${duplicate}${original ? ` | ${original}` : ""}${translated ? ` → ${translated}` : ""}`;
        node.dataset.mangaTranslatorOverlay = "true";
        root.appendChild(node);
      });
    });
  }

  function getDebugItemPercent(item, debug) {
    if (item && item.percent && [item.percent.x, item.percent.y, item.percent.w, item.percent.h].every((value) => Number.isFinite(Number(value)))) {
      return item.percent;
    }
    const box = item && (item.rawBox || item.box);
    const imageWidth = Math.max(1, Number(debug && debug.imageWidth) || 1);
    const imageHeight = Math.max(1, Number(debug && debug.imageHeight) || 1);
    if (!box || ![box.left, box.top, box.width, box.height].every((value) => Number.isFinite(Number(value)))) {
      return null;
    }
    return {
      x: (Number(box.left) / imageWidth) * 100,
      y: (Number(box.top) / imageHeight) * 100,
      w: (Number(box.width) / imageWidth) * 100,
      h: (Number(box.height) / imageHeight) * 100
    };
  }

  async function renderEmbeddedTranslation(target, targetKey, result, payload) {
    const bubbles = Array.isArray(result.bubbles) ? result.bubbles : [];
    if (bubbles.length === 0) {
      clearRenderedTarget(target);
      return;
    }
    if (target instanceof HTMLImageElement) {
      await renderEmbeddedImageTarget(target, targetKey, bubbles, payload);
      return;
    }

    if (target instanceof HTMLCanvasElement) {
      await renderEmbeddedCanvasTarget(target, targetKey, bubbles, payload);
      return;
    }

    if (isBackgroundImageTarget(target)) {
      await renderEmbeddedBackgroundTarget(target, targetKey, bubbles, payload);
      return;
    }

    throw new Error("Unsupported embedded render target");
  }

  async function renderEmbeddedImageTarget(img, targetKey, bubbles, payload) {
    const targetId = getTargetId(img);
    const cachedDataUrl = state.embeddedImageCache.get(targetKey);
    const outputDataUrl =
      cachedDataUrl || (await composeEmbeddedImageDataUrl(await getEmbeddedBaseDataUrl(img, payload), bubbles));

    if (!cachedDataUrl) {
      rememberEmbeddedImageCache(targetKey, outputDataUrl);
    }

    const existing = state.embeddedById.get(targetId);
    if (existing && existing.kind !== "image") {
      restoreEmbeddedForTarget(img);
    }

    if (!img.dataset.mtEmbeddedOriginalSource) {
      img.dataset.mtEmbeddedOriginalSource = resolveImageUrl(img);
    }
    if (!img.dataset.mtEmbeddedOriginalSrc) {
      img.dataset.mtEmbeddedOriginalSrc = img.getAttribute("src") || "";
    }
    if (!img.dataset.mtEmbeddedOriginalSrcset) {
      img.dataset.mtEmbeddedOriginalSrcset = img.getAttribute("srcset") || "";
    }

    img.dataset.mtEmbeddedActive = "true";
    img.dataset.mtEmbeddedOutputKey = targetKey;
    img.removeAttribute("srcset");
    img.src = outputDataUrl;

    state.embeddedById.set(targetId, {
      target: img,
      targetId,
      targetKey,
      kind: "image",
      mode: "embedded",
      bubbleCount: bubbles.length
    });
  }

  async function renderEmbeddedCanvasTarget(canvas, targetKey, bubbles, payload) {
    const targetId = getTargetId(canvas);
    const existing = state.embeddedById.get(targetId);
    const originalDataUrl =
      existing && existing.kind === "canvas" && existing.originalDataUrl
        ? existing.originalDataUrl
        : payload && isDataUrl(payload.dataUrl)
          ? payload.dataUrl
          : "";
    if (!originalDataUrl) {
      throw new Error("Canvas original image is unavailable for embedded rendering");
    }

    const image = await loadImageFromDataUrl(originalDataUrl);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawEmbeddedBubbles(ctx, canvas.width, canvas.height, bubbles);
    ctx.restore();

    state.embeddedById.set(targetId, {
      target: canvas,
      targetId,
      targetKey,
      kind: "canvas",
      mode: "embedded",
      bubbleCount: bubbles.length,
      originalDataUrl
    });
  }

  async function renderEmbeddedBackgroundTarget(target, targetKey, bubbles, payload) {
    const targetId = getTargetId(target);
    const cachedDataUrl = state.embeddedImageCache.get(targetKey);
    const baseDataUrl = payload && isDataUrl(payload.dataUrl) ? payload.dataUrl : "";
    const originalSource = resolveBackgroundImageUrl(target);
    if (!baseDataUrl) {
      throw new Error("Background image is unavailable for embedded rendering");
    }

    const outputDataUrl =
      cachedDataUrl ||
      (await composeEmbeddedImageDataUrl(baseDataUrl, bubbles, {
        heightUsage: 0.86,
        maxFont: 44,
        minFont: 9,
        paddingScale: 3,
        textScale: 1.55,
        widthUsage: 0.9,
        boxScale: 1.28
      }));
    if (!cachedDataUrl) {
      rememberEmbeddedImageCache(targetKey, outputDataUrl);
    }

    const existing = state.embeddedById.get(targetId);
    if (existing && existing.kind !== "background") {
      restoreEmbeddedForTarget(target);
    }

    if (!target.dataset.mtEmbeddedOriginalBackground) {
      target.dataset.mtEmbeddedOriginalBackground = target.style.backgroundImage || "";
    }
    if (!target.dataset.mtEmbeddedOriginalBackgroundSource) {
      target.dataset.mtEmbeddedOriginalBackgroundSource = originalSource;
    }

    target.dataset.mtEmbeddedActive = "true";
    target.dataset.mtEmbeddedOutputKey = targetKey;
    target.style.backgroundImage = `url("${outputDataUrl}")`;

    state.embeddedById.set(targetId, {
      target,
      targetId,
      targetKey,
      kind: "background",
      mode: "embedded",
      bubbleCount: bubbles.length
    });
  }

  async function getEmbeddedBaseDataUrl(img, payload) {
    try {
      return imageElementToEmbeddedDataUrl(img);
    } catch {
      const imageUrl = resolveImageUrl(img);
      if (isHttpUrl(imageUrl)) {
        try {
          const fetched = await sendRuntimeMessage({
            type: "FETCH_IMAGE_DATA_URL",
            url: imageUrl,
            preserveSize: true,
            maxOriginalBytes: EMBEDDED_MAX_ORIGINAL_BYTES,
            referrer: location.href
          });
          if (fetched && fetched.ok && isDataUrl(fetched.dataUrl)) {
            return fetched.dataUrl;
          }
        } catch {
          // 跨域原图抓取失败时降级到模型输入图，保持功能可用。
        }
      }

      if (payload && isDataUrl(payload.dataUrl)) {
        return payload.dataUrl;
      }
      throw new Error("Image data extraction failed for embedded rendering");
    }
  }

  function imageElementToEmbeddedDataUrl(img) {
    const srcWidth = img.naturalWidth || img.width || img.clientWidth;
    const srcHeight = img.naturalHeight || img.height || img.clientHeight;

    if (!srcWidth || !srcHeight) {
      throw new Error("Image size is unavailable");
    }

    const pixelCount = srcWidth * srcHeight;
    const scale = pixelCount > EMBEDDED_MAX_CANVAS_PIXELS ? Math.sqrt(EMBEDDED_MAX_CANVAS_PIXELS / pixelCount) : 1;
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL("image/jpeg", EMBEDDED_JPEG_QUALITY);
  }

  async function composeEmbeddedImageDataUrl(baseDataUrl, bubbles, options = {}) {
    const image = await loadImageFromDataUrl(baseDataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!width || !height) {
      throw new Error("Embedded base image size is unavailable");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    drawEmbeddedBubbles(ctx, width, height, bubbles, options);

    return canvas.toDataURL("image/jpeg", EMBEDDED_JPEG_QUALITY);
  }

  function drawEmbeddedBubbles(ctx, canvasWidth, canvasHeight, bubbles, options = {}) {
    const textOptions = options && typeof options === "object" ? options : {};
    bubbles.forEach((bubble) => {
      const text = formatTranslationForOriginalLines(
        cleanRenderableText(bubble.translated_text || bubble.original_text || ""),
        Number(bubble.source_line_count) || 1
      );
      if (!text) {
        return;
      }

      let x = (clamp(Number(bubble.x), 0, 100) / 100) * canvasWidth;
      let y = (clamp(Number(bubble.y), 0, 100) / 100) * canvasHeight;
      let w = (clamp(Number(bubble.w), 0, 100) / 100) * canvasWidth;
      let h = (clamp(Number(bubble.h), 0, 100) / 100) * canvasHeight;
      const embeddedGeometry = getEmbeddedPolygonGeometry(bubble.polygon, canvasWidth, canvasHeight);
      const rotation = normalizeBubbleRotation(bubble.rotation_deg);
      if (embeddedGeometry) {
        x = embeddedGeometry.centerX - embeddedGeometry.width / 2;
        y = embeddedGeometry.centerY - embeddedGeometry.height / 2;
        w = embeddedGeometry.width;
        h = embeddedGeometry.height;
      }

      if (w < 2 || h < 2) {
        return;
      }

      const boxScale = Math.max(1, Number(textOptions.boxScale || 1));
      if (boxScale > 1) {
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        w = Math.min(canvasWidth, w * boxScale);
        h = Math.min(canvasHeight, h * boxScale);
        x = clamp(centerX - w / 2, 0, Math.max(0, canvasWidth - w));
        y = clamp(centerY - h / 2, 0, Math.max(0, canvasHeight - h));
      }

      const bgType = normalizeBgType(bubble.bg_type);
      const paddingScale = Number(textOptions.paddingScale || 1);
      const paddingX = Math.max(1, paddingScale);
      const paddingY = Math.max(1, paddingScale);
      const boxX = Math.max(0, x - paddingX);
      const boxY = Math.max(0, y - paddingY);
      const box = {
        x: boxX,
        y: boxY,
        w: Math.min(canvasWidth - boxX, w + paddingX * 2),
        h: Math.min(canvasHeight - boxY, h + paddingY * 2)
      };
      const sourceFillBox = getCanvasFillBox(bubble.fill_box, canvasWidth, canvasHeight);
      const fillBox = unionRenderBoxes(box, sourceFillBox);

      if (bgType === "solid" && Array.isArray(bubble.region_polygon) && bubble.region_polygon.length >= 3) {
        ctx.save();
        ctx.beginPath();
        bubble.region_polygon.forEach((point, index) => {
          const pointX = (Number(point && point.x) / 100) * canvasWidth;
          const pointY = (Number(point && point.y) / 100) * canvasHeight;
          if (index === 0) ctx.moveTo(pointX, pointY);
          else ctx.lineTo(pointX, pointY);
        });
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = String(bubble.bg_color || "#ffffff");
        ctx.fillRect(fillBox.x, fillBox.y, fillBox.w, fillBox.h);
        ctx.restore();
      } else if (bgType === "solid") {
        ctx.save();
        ctx.fillStyle = String(bubble.bg_color || "#ffffff");
        ctx.fillRect(fillBox.x, fillBox.y, fillBox.w, fillBox.h);
        ctx.restore();
      }

      ctx.save();
      const centerX = box.x + box.w / 2;
      const centerY = box.y + box.h / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate((rotation * Math.PI) / 180);
      const localBox = { x: -box.w / 2, y: -box.h / 2, w: box.w, h: box.h };
      const renderColors = getBubbleRenderColors(bubble, bgType);
      drawFittedText(ctx, text, localBox, bgType, {
        ...textOptions,
        textColor: renderColors.textColor,
        strokeColor: renderColors.strokeColor
      });
      ctx.restore();
    });
  }

  function getCanvasFillBox(value, canvasWidth, canvasHeight) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const x = (Number(value.x) / 100) * canvasWidth;
    const y = (Number(value.y) / 100) * canvasHeight;
    const w = (Number(value.w) / 100) * canvasWidth;
    const h = (Number(value.h) / 100) * canvasHeight;
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  function unionRenderBoxes(primary, secondary) {
    if (!secondary) {
      return primary;
    }
    if (!primary) {
      return secondary;
    }
    const left = Math.min(primary.x, secondary.x);
    const top = Math.min(primary.y, secondary.y);
    const right = Math.max(primary.x + primary.w, secondary.x + secondary.w);
    const bottom = Math.max(primary.y + primary.h, secondary.y + secondary.h);
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    };
  }

  function getEmbeddedPolygonGeometry(value, canvasWidth, canvasHeight) {
    if (!Array.isArray(value) || value.length < 4) {
      return null;
    }
    const points = value.slice(0, 4).map((point) => ({
      x: (Number(point && point.x) / 100) * canvasWidth,
      y: (Number(point && point.y) / 100) * canvasHeight
    }));
    if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
      return null;
    }
    const edges = points.map((point, index) => {
      const next = points[(index + 1) % points.length];
      return Math.hypot(next.x - point.x, next.y - point.y);
    });
    return {
      centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      width: Math.max(8, (edges[0] + edges[2]) / 2),
      height: Math.max(8, (edges[1] + edges[3]) / 2)
    };
  }

  function drawFittedText(ctx, text, box, bgType, options = {}) {
    const textScale = Number(options.textScale || 1);
    const minFont = Number(options.minFont || 6);
    const maxFont = Number(options.maxFont || 30);
    const maxWidth = Math.max(6, box.w * Number(options.widthUsage || 0.82));
    const maxHeight = Math.max(6, box.h * Number(options.heightUsage || 0.68));
    const family = '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
    let best = {
      size: minFont,
      lines: [text]
    };
    let low = minFont;
    let high = Math.max(minFont + 1, Math.min(maxFont, box.h * 0.42 * textScale, box.w * 0.22 * textScale));

    for (let index = 0; index < 9; index += 1) {
      const size = (low + high) / 2;
      ctx.font = `600 ${size}px ${family}`;
      const lines = wrapCanvasText(ctx, text, maxWidth);
      const lineHeight = size * 1.22;
      const totalHeight = lines.length * lineHeight;
      const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);

      if (totalHeight <= maxHeight && widest <= maxWidth) {
        best = { size, lines };
        low = size;
      } else {
        high = size;
      }
    }

    ctx.save();
    ctx.font = `500 ${best.size}px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    if (bgType === "none") {
      ctx.strokeStyle = String(options.strokeColor || "#ffffff");
      ctx.lineWidth = getDynamicStrokeWidth(best.size);
    }

    const lineHeight = best.size * 1.22;
    const startY = box.y + box.h / 2 - ((best.lines.length - 1) * lineHeight) / 2;
    const centerX = box.x + box.w / 2;

    best.lines.forEach((line, index) => {
      const lineY = startY + index * lineHeight;
      if (bgType === "none") {
        ctx.strokeText(line, centerX, lineY);
      }
      ctx.fillStyle = String(options.textColor || "#111827");
      ctx.fillText(line, centerX, lineY);
    });

    ctx.restore();
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const paragraphs = String(text || "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const lines = [];

    paragraphs.forEach((paragraph) => {
      const tokens = segmentCanvasText(paragraph);
      const joiner = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(paragraph) ? "" : " ";
      let current = "";

      tokens.forEach((token) => {
        const next = current ? `${current}${joiner}${token}` : token;
        if (ctx.measureText(next).width <= maxWidth || !current) {
          current = next;
          return;
        }

        lines.push(current);
        current = token;
      });

      if (current) {
        lines.push(current);
      }
    });

    return lines.length > 0 ? lines : [String(text || "")];
  }

  function segmentCanvasText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return [];
    }

    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) {
      return Array.from(raw.replace(/\s+/g, ""));
    }

    return raw.split(/(\s+)/).filter((token) => token && !/^\s+$/.test(token));
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Embedded image decode failed"));
      image.src = dataUrl;
    });
  }

  async function decodeDataUrlImageSize(dataUrl) {
    const image = await loadImageFromDataUrl(dataUrl);
    return {
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0
    };
  }

  function renderLoadingOverlay(target, targetKey, text) {
    ensureOverlayLayer();

    const targetId = getTargetId(target);
    const oldOverlay = state.overlaysById.get(targetId);
    if (oldOverlay && oldOverlay.targetKey === targetKey && oldOverlay.mode === "loading") {
      updateLoadingOverlayText(target, targetKey, text);
      syncOverlayPosition(oldOverlay);
      return;
    }
    if (oldOverlay) {
      oldOverlay.root.remove();
      state.overlaysById.delete(targetId);
    }

    const root = document.createElement("div");
    root.className = "mt-overlay-root mt-overlay-loading";
    root.dataset.mangaTranslatorOverlay = "true";
    root.dataset.targetId = targetId;

    const loadingCard = document.createElement("div");
    loadingCard.className = "mt-loading-card";
    loadingCard.dataset.mangaTranslatorOverlay = "true";
    loadingCard.textContent = String(text || "OCR + 翻译中...");
    root.appendChild(loadingCard);

    const overlayState = {
      target,
      targetId,
      targetKey,
      root,
      bubbleNodes: [],
      bubbleCount: 0,
      mode: "loading",
      loadingTimeout: window.setTimeout(() => {
        // Loading 超时保护：清除 loading overlay 并触发重试
        if (!overlayState.root.isConnected) return;
        const current = state.overlaysById.get(targetId);
        if (current !== overlayState || current.mode !== "loading") return;
        console.warn("[MangaTranslator] Loading overlay timed out, clearing", {
          targetKey: String(targetKey).slice(0, 80)
        });
        overlayState.root.remove();
        state.overlaysById.delete(targetId);
        if (state.overlaysById.size === 0) {
          stopOverlayFrameSync();
        }
        // 清除已翻译标记以允许重试
        if (target.dataset.mtLastTranslatedKey === targetKey) {
          target.dataset.mtLastTranslatedKey = "";
        }
        if (target.isConnected && state.autoTranslatePageEnabled) {
          scheduleAutoTranslateRetry(target);
        }
        reportStatus("warn", "loading-overlay-timeout", {
          targetKey: String(targetKey).slice(0, 80)
        }).catch(() => {});
      }, LOADING_OVERLAY_TIMEOUT_MS)
    };

    state.overlayLayer.appendChild(root);
    state.overlaysById.set(targetId, overlayState);
    syncOverlayPosition(overlayState);
    ensureOverlayFrameSync();
  }

  function updateLoadingOverlayText(target, targetKey, text) {
    const targetId = state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }
    const overlayState = state.overlaysById.get(targetId);
    if (!overlayState || overlayState.mode !== "loading" || overlayState.targetKey !== targetKey) {
      return;
    }

    const node = overlayState.root.querySelector(".mt-loading-card");
    if (!node) {
      return;
    }
    node.textContent = String(text || "OCR + 翻译中...");
  }

  function createBubbleNode(bubble, index, options = {}) {
    let x = clamp(Number(bubble.x), 0, 100);
    let y = bubble.stitch_overflow === true ? Number(bubble.y) : clamp(Number(bubble.y), 0, 100);
    let w = clamp(Number(bubble.w), 0, 100);
    let h = clamp(Number(bubble.h), 0, 100);

    if (w <= 0 || h <= 0) {
      return null;
    }

    if (options.backgroundTarget) {
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      w = clamp(Math.max(w * 2.6, 18), 1, 92);
      h = clamp(Math.max(h * 2.2, 10), 1, 62);
      x = clamp(centerX - w / 2, 0, 100 - w);
      y = clamp(centerY - h / 2, 0, 100 - h);
    }

    const projectionRole = String(bubble.projection_role || "text_primary");
    const coverOnly = projectionRole === "cover_only";
    const originalText = cleanRenderableText(bubble.original_text || "");
    const translatedText = coverOnly
      ? ""
      : cleanRenderableText(bubble.translated_text || "") || originalText;
    if (!coverOnly && !translatedText) {
      return null;
    }
    const bgType = normalizeBgType(bubble.bg_type);

    const node = document.createElement("div");
    const renderColors = getBubbleRenderColors(bubble, bgType);
    node.className = `mt-bubble mt-bg-${bgType}`;
    if (coverOnly) node.classList.add("mt-cover-only");
    node.dataset.mangaTranslatorOverlay = "true";
    node.dataset.index = String(index);
    node.dataset.mode = coverOnly ? "cover" : "translated";
    node.dataset.projectionRole = projectionRole;
    node.dataset.original = originalText;
    node.dataset.translated = translatedText;
    node.dataset.sourceLineCount = String(Math.max(1, Math.round(Number(bubble.source_line_count) || 1)));
    node.dataset.rotationDeg = String(normalizeBubbleRotation(bubble.rotation_deg));
    if (Array.isArray(bubble.polygon)) {
      node.dataset.polygon = JSON.stringify(bubble.polygon);
    }
    node.dataset.wPercent = String(w);
    node.dataset.hPercent = String(h);
    node.dataset.xPercent = String(x);
    node.dataset.yPercent = String(y);
    node.dataset.backgroundTarget = options.backgroundTarget ? "true" : "";
    node.dataset.stitchOverflow = bubble.stitch_overflow === true ? "true" : "";
    node.dataset.blockId = String(bubble.block_id || bubble.id || `block-${index}`);
    node.dataset.canonicalId = String(bubble.canonical_id || "");
    if (bgType === "none") {
      const sourceBox = normalizeFillBox(bubble.cleaned_source_box) || { x, y, w, h };
      const patchStyle = getCleanedPatchStyle(sourceBox);
      node.style.setProperty("--mt-cleaned-size-x", patchStyle.sizeX);
      node.style.setProperty("--mt-cleaned-size-y", patchStyle.sizeY);
      node.style.setProperty("--mt-cleaned-position-x", patchStyle.positionX);
      node.style.setProperty("--mt-cleaned-position-y", patchStyle.positionY);
    }
    if (bubble.bg_color) {
      node.style.setProperty("--mt-adaptive-bg", String(bubble.bg_color));
    }
    node.style.setProperty(
      "--mt-text-color",
      renderColors.textColor
    );
    node.style.setProperty(
      "--mt-stroke-color",
      renderColors.strokeColor
    );
    node.dataset.regionType = String(bubble.region_type || "plain_text");
    const fillBox = bgType === "solid"
      ? buildSolidBackgroundBox({ x, y, w, h }, bubble.fill_box, bubble.stitch_overflow === true)
      : null;
    if (fillBox) {
      node.style.setProperty("--mt-fill-left", ((fillBox.x - x) / w) * 100 + "%");
      node.style.setProperty("--mt-fill-top", ((fillBox.y - y) / h) * 100 + "%");
      node.style.setProperty("--mt-fill-width", (fillBox.w / w) * 100 + "%");
      node.style.setProperty("--mt-fill-height", (fillBox.h / h) * 100 + "%");
    }
    if (bgType === "solid" && Array.isArray(bubble.region_polygon)) {
      const clipTarget = fillBox || { x, y, w, h };
      const clip = buildRegionClipPath(
        bubble.region_polygon,
        clipTarget.x,
        clipTarget.y,
        clipTarget.w,
        clipTarget.h
      );
      if (clip) {
        node.style.setProperty("--mt-region-clip", clip);
      }
    }

    const centerX = clamp(x + w / 2, 0, 100);
    const centerY = bubble.stitch_overflow === true ? y + h / 2 : clamp(y + h / 2, 0, 100);
    node.style.left = `${centerX}%`;
    node.style.top = `${centerY}%`;
    node.style.width = `${w}%`;
    node.style.height = `${h}%`;
    const rotation = normalizeBubbleRotation(bubble.rotation_deg);
    node.style.setProperty("--mt-base-transform", `translate(-50%, -50%) rotate(${rotation.toFixed(2)}deg)`);

    node.textContent = coverOnly ? "" : formatTranslationForOriginalLines(translatedText, Number(node.dataset.sourceLineCount));
    node.title = coverOnly ? "" : originalText || translatedText;
    if (!coverOnly) {
      applyBubbleTextLayout(node, translatedText);
    }

    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleOverlaySourceMode(node);
    });

    return node;
  }

  function buildRegionClipPath(points, x, y, width, height) {
    if (!Array.isArray(points) || points.length < 3 || width <= 0 || height <= 0) {
      return "";
    }
    const values = points.map((point) => {
      const localX = ((Number(point && point.x) - x) / width) * 100;
      const localY = ((Number(point && point.y) - y) / height) * 100;
      return Number.isFinite(localX) && Number.isFinite(localY)
        ? `${localX.toFixed(2)}% ${localY.toFixed(2)}%`
        : "";
    });
    return values.every(Boolean) ? `polygon(${values.join(", ")})` : "";
  }

  function formatTranslationForOriginalLines(text, requestedLines) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    const lineCount = Math.max(1, Math.min(8, Math.round(Number(requestedLines) || 1)));
    if (!raw || lineCount <= 1 || raw.includes("\n")) {
      return raw;
    }
    const units = /[\u3400-\u9fff]/.test(raw)
      ? Array.from(raw.replace(/\s+/g, ""))
      : raw.split(/\s+/).filter(Boolean);
    if (units.length <= lineCount) {
      return raw;
    }
    const rows = [];
    let offset = 0;
    for (let line = 0; line < lineCount; line += 1) {
      const remaining = units.length - offset;
      const take = Math.ceil(remaining / (lineCount - line));
      rows.push(units.slice(offset, offset + take).join(/[\u3400-\u9fff]/.test(raw) ? "" : " "));
      offset += take;
    }
    return rows.filter(Boolean).join("\n");
  }

  function toggleOverlaySourceMode(node) {
    const root = node.closest(".mt-overlay-root");
    if (!root) {
      return;
    }
    root.classList.toggle("mt-show-source");
  }

  function applyBubbleTextLayout(node, text) {
    const vertical = shouldUseVerticalJapaneseLayout(node, text);
    node.classList.toggle("mt-jp-vertical", vertical);
  }

  function shouldUseVerticalJapaneseLayout(node, text) {
    const backgroundTarget = node.dataset.backgroundTarget === "true";
    if (backgroundTarget && looksLikeCjkText(text)) {
      const hPercent = Number(node.dataset.hPercent || "0");
      const wPercent = Number(node.dataset.wPercent || "1");
      return hPercent / Math.max(wPercent, 0.1) >= 0.5;
    }

    if (!looksLikeJapaneseText(text)) {
      return false;
    }

    const hPercent = Number(node.dataset.hPercent || "0");
    const wPercent = Number(node.dataset.wPercent || "1");
    const ratio = hPercent / Math.max(wPercent, 0.1);

    // Prefer vertical layout on tall/narrow bubbles to keep reading natural.
    return ratio >= 0.82;
  }

  function looksLikeCjkText(text) {
    return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(text || ""));
  }

  function looksLikeJapaneseText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return false;
    }

    if (/[\u3040-\u30ff\u31f0-\u31ff\u30fc\uff66-\uff9f]/.test(raw)) {
      return true;
    }

    if (/[\u3001\u3002\u30fb\u300c\u300d\u300e\u300f\u301c]/.test(raw) && /[\u4e00-\u9fff]/.test(raw)) {
      return true;
    }

    return false;
  }

  function syncAllOverlays() {
    if (state.invalidated) {
      return;
    }

    if (state.overlaysById.size > 0) {
      for (const overlayState of state.overlaysById.values()) {
        syncOverlayPosition(overlayState);
      }
      syncKakaoVisualDuplicateBubbles();
      ensureOverlayFrameSync();
    }

    recoverRenderedTargets();
  }

  function recoverRenderedTargets() {
    const now = Date.now();
    if (now - state.lastRecoveryAt < RECOVERY_SCAN_GAP_MS) {
      return;
    }
    state.lastRecoveryAt = now;

    const candidates = Array.from(document.querySelectorAll(TARGET_SELECTOR))
      .filter((target) => isSupportedTarget(target))
      .filter((target) => target.isConnected)
      .filter((target) => passesTargetFilter(target, false))
      .filter((target) => isRectVisible(target.getBoundingClientRect()))
      .map((target) => ({
        target,
        area: getVisibleArea(target.getBoundingClientRect())
      }))
      .sort((left, right) => right.area - left.area)
      .slice(0, MAX_RECOVERY_TARGETS);

    for (const item of candidates) {
      const target = item.target;
      registerTarget(target);

      if (state.inflightByTarget.has(target) || state.queuedTargets.has(target)) {
        continue;
      }

      const targetId = state.targetIdByElement.get(target);
      if (targetId) {
        const renderedState = getExistingRenderedState(targetId);
        if (renderedState && isEmbeddedRenderStillApplied(renderedState)) {
          continue;
        }
        if (renderedState && renderedState.mode === "embedded") {
          state.embeddedById.delete(targetId);
        }
      }

      const targetKey = computeTargetKey(target);
      const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
      const renderedKey = target.dataset.mtLastTranslatedKey || "";
      if (renderedKey !== targetKey && renderedKey !== scopedTargetKey) {
        continue;
      }

      if (shouldUseKakaoCanonicalPipeline(target) && kakaoCanonicalPipeline) {
        Promise.resolve(kakaoCanonicalPipeline.runCached(target, null, { reason: "overlay-recovery" }))
          .catch(() => undefined);
        continue;
      }

      const localCachedResult = state.localResultCache.get(scopedTargetKey) || state.localResultCache.get(targetKey);
      if (localCachedResult && Array.isArray(localCachedResult.bubbles) && localCachedResult.bubbles.length > 0) {
        if (shouldUseEmbeddedRender(target)) {
          extractTargetPayload(target, scopedTargetKey)
            .then((payload) => renderTranslationResult(target, targetKey, localCachedResult, payload))
            .catch(() => {
              // 当前图片不可读时跳过恢复，避免自动触发新的翻译请求。
            });
        } else {
          // 恢复 overlay 时重新去重，确保缓存结果与当前全局去重状态一致。
          // 避免之前被跨图去重移除的气泡在恢复时因未重新比对而再次出现。
          dedupeKakaoResultByPageCoordinates(localCachedResult, target, targetKey)
            .then((dedupedResult) => {
              state.localResultCache.set(scopedTargetKey, dedupedResult);
              renderOverlay(target, targetKey, dedupedResult);
            });
        }
        target.dataset.mtLastTranslatedKey = targetKey;
        continue;
      }
    }
  }

  function syncOverlayPosition(overlayState) {
    if (!overlayState || !overlayState.target || !overlayState.root.isConnected) {
      return;
    }

    if (overlayState.sourceToken && getQuickSourceToken(overlayState.target) !== overlayState.sourceToken) {
      const stalePageId = String(state.kakaoPageIdByTarget.get(overlayState.target) || "");
      if (stalePageId) {
        if (state.kakaoStore && typeof state.kakaoStore.unbindPageTarget === "function") {
          state.kakaoStore.unbindPageTarget(overlayState.target);
        }
        unbindKakaoTargetFromPage(overlayState.target);
        scheduleKakaoProjectionRefresh([stalePageId], "page-handle-source-changed");
      }
      overlayState.root.remove();
      state.overlaysById.delete(overlayState.targetId);
      if (state.overlaysById.size === 0) {
        stopOverlayFrameSync();
      }
      return;
    }

    if (!overlayState.target.isConnected) {
      const disconnectedPageId = detachKakaoTargetHandle(overlayState.target);
      if (disconnectedPageId) {
        scheduleKakaoProjectionRefresh([disconnectedPageId], "page-handle-disconnected");
      }
      overlayState.root.remove();
      state.overlaysById.delete(overlayState.targetId);
      if (state.overlaysById.size === 0) {
        stopOverlayFrameSync();
      }
      return;
    }

    const rect = getOverlayDisplayRect(overlayState);
    const visible = isRectVisible(getOverlayVisibilityRect(overlayState, rect));
    const useDocumentFlow = IS_KAKAOPAGE_READER;

    if (shouldHideOverlayRoot(rect, visible, useDocumentFlow)) {
      overlayState.root.style.display = "none";
      return;
    }

    const viewportRect = getOverlayPositionRect(
      rect,
      useDocumentFlow,
      window.scrollX || 0,
      window.scrollY || 0
    );
    const changes = compareOverlayViewportRects(overlayState.lastViewportRect, viewportRect);

    overlayState.root.style.display = "block";
    if (changes.positionChanged || changes.sizeChanged) {
      overlayState.root.style.left = `${viewportRect.left}px`;
      overlayState.root.style.top = `${viewportRect.top}px`;
      overlayState.root.style.width = `${viewportRect.width}px`;
      overlayState.root.style.height = `${viewportRect.height}px`;
      overlayState.lastViewportRect = viewportRect;
    }

    // 画面平移只更新根节点坐标；尺寸不变时不重新测量文字，避免滚动期间抖动。
    if (!changes.sizeChanged) {
      return;
    }

    // 字号按气泡高度比例计算，并使用 clamp 限制上下界。
    overlayState.bubbleNodes.forEach((node) => {
      const polygonGeometry = getOverlayPolygonGeometry(node, rect);
      const bubbleWidthPercent = Number(node.dataset.wPercent || "0");
      const bubbleHeightPercent = Number(node.dataset.hPercent || "0");
      const bubbleWidthPx = polygonGeometry ? polygonGeometry.width : (rect.width * bubbleWidthPercent) / 100;
      const bubbleHeightPx = polygonGeometry ? polygonGeometry.height : (rect.height * bubbleHeightPercent) / 100;
      if (polygonGeometry) {
        node.style.left = `${polygonGeometry.centerX}px`;
        node.style.top = `${polygonGeometry.centerY}px`;
        node.style.width = `${polygonGeometry.width}px`;
        node.style.height = `${polygonGeometry.height}px`;
      }
      const fittedSize = fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, {
        backgroundTarget: overlayState.isBackgroundTarget
      });
      node.style.fontSize = `${fittedSize.toFixed(1)}px`;
      node.style.setProperty("--mt-stroke-width", `${getDynamicStrokeWidth(fittedSize).toFixed(1)}px`);
    });
  }

  function compareOverlayViewportRects(previous, next) {
    if (!previous) {
      return { positionChanged: true, sizeChanged: true };
    }
    return {
      positionChanged: previous.left !== next.left || previous.top !== next.top,
      sizeChanged: previous.width !== next.width || previous.height !== next.height
    };
  }

  function getOverlayPositionRect(rect, useDocumentFlow, scrollX = 0, scrollY = 0) {
    const offsetX = useDocumentFlow ? Number(scrollX) || 0 : 0;
    const offsetY = useDocumentFlow ? Number(scrollY) || 0 : 0;
    return {
      left: Math.round(rect.left + offsetX),
      top: Math.round(rect.top + offsetY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function shouldHideOverlayRoot(rect, visible, useDocumentFlow) {
    if (!rect || !(Number(rect.width) >= 2) || !(Number(rect.height) >= 2)) {
      return true;
    }
    // 页面坐标覆盖层即使暂时离开视口也保持挂载，由浏览器自然裁剪并随原图一起进入视口。
    return !useDocumentFlow && !visible;
  }

  function getOverlayVisibilityRect(overlayState, rect) {
    let minY = 0;
    let maxY = 100;
    Array.from(overlayState && overlayState.bubbleNodes || []).forEach((node) => {
      if (!node || !node.dataset || node.dataset.stitchOverflow !== "true") {
        return;
      }
      const y = Number(node.dataset.yPercent);
      const h = Number(node.dataset.hPercent);
      if (!Number.isFinite(y) || !Number.isFinite(h) || h <= 0) {
        return;
      }
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + h);
    });
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top + (minY / 100) * rect.height,
      bottom: rect.top + (maxY / 100) * rect.height,
      width: rect.width,
      height: ((maxY - minY) / 100) * rect.height
    };
  }

  function getDynamicStrokeWidth(fontSize) {
    const width = clamp((Number(fontSize) || 0) * 0.085, 1.8, 4.2);
    return Math.round(width * 10) / 10;
  }

  function getOverlayPolygonGeometry(node, rect) {
    if (!node.dataset.polygon) {
      return null;
    }
    try {
      const polygon = JSON.parse(node.dataset.polygon);
      if (!Array.isArray(polygon) || polygon.length < 4) {
        return null;
      }
      const points = polygon.slice(0, 4).map((point) => ({
        x: (Number(point.x) / 100) * rect.width,
        y: (Number(point.y) / 100) * rect.height
      }));
      if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
        return null;
      }
      const edges = points.map((point, index) => {
        const next = points[(index + 1) % points.length];
        return Math.hypot(next.x - point.x, next.y - point.y);
      });
      // 后端按文字基线方向排列四点，因此 0/2 边是宽度，1/3 边是高度。
      const width = Math.max(8, (edges[0] + edges[2]) / 2);
      const height = Math.max(8, (edges[1] + edges[3]) / 2);
      return {
        centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
        width: Math.max(8, width),
        height
      };
    } catch {
      return null;
    }
  }

  function fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, options = {}) {
    const width = Math.max(8, Math.round(bubbleWidthPx));
    const height = Math.max(8, Math.round(bubbleHeightPx));
    const text = String(node.textContent || "").trim();
    if (!text) {
      return BUBBLE_FONT_MIN;
    }

    const vertical = node.classList.contains("mt-jp-vertical");
    if (options.backgroundTarget) {
      return fitPixivBubbleFontSize(node, width, height, text, vertical);
    }

    const maxFont = options.backgroundTarget ? 34 : BUBBLE_FONT_MAX;
    const baseRatio = options.backgroundTarget ? 0.42 : BUBBLE_FONT_BASE_RATIO;
    const safetyScale = options.backgroundTarget ? 0.96 : BUBBLE_FONT_SAFETY_SCALE;
    const verticalSafetyScale = options.backgroundTarget ? 0.94 : BUBBLE_FONT_VERTICAL_SAFETY_SCALE;
    const startSize = Math.min(maxFont, clamp(height * baseRatio, BUBBLE_FONT_MIN, maxFont));
    const cacheKey = `${options.backgroundTarget ? "bg" : "std"}|${vertical ? "v" : "h"}|${width}x${height}|${text}`;
    const cachedSize = state.fontFitCache.get(cacheKey);
    if (typeof cachedSize === "number" && Number.isFinite(cachedSize)) {
      return cachedSize;
    }

    const probe = ensureBubbleMeasureProbe();
    probe.className = node.className;
    probe.classList.add("mt-measure-probe");
    probe.classList.remove("mt-show-original");
    probe.style.width = `${width}px`;
    probe.style.height = `${height}px`;
    probe.textContent = text;

    let low = BUBBLE_FONT_MIN;
    let high = startSize;
    let best = BUBBLE_FONT_MIN;
    for (let index = 0; index < BUBBLE_FONT_BINARY_STEPS; index += 1) {
      const mid = (low + high) / 2;
      probe.style.fontSize = `${mid}px`;
      if (isProbeOverflowing(probe)) {
        high = mid;
      } else {
        best = mid;
        low = mid;
      }
    }

    const safeScale = vertical ? verticalSafetyScale : safetyScale;
    const safeSize = clamp(best * safeScale, BUBBLE_FONT_MIN, maxFont);
    const normalized = Math.round(safeSize * 10) / 10;
    rememberFontFitCache(cacheKey, normalized);
    return normalized;
  }

  function fitPixivBubbleFontSize(node, width, height, text, vertical) {
    const compactText = String(text || "").replace(/\s+/g, "");
    const length = Math.max(1, Array.from(compactText).length);
    const minReadable = vertical ? 17 : 16;
    const maxReadable = vertical ? 36 : 32;
    const area = Math.max(1, width * height);
    const areaSize = Math.sqrt(area / Math.max(1, length)) * (vertical ? 0.95 : 0.78);
    const dimensionSize = vertical
      ? Math.min(width * 0.72, height / Math.min(length, 8) * 1.28)
      : Math.min(height * 0.48, width / Math.min(length, 10) * 1.45);
    const targetSize = clamp(Math.max(areaSize, dimensionSize), minReadable, maxReadable);
    const cacheKey = `pixiv|${vertical ? "v" : "h"}|${width}x${height}|${text}`;
    const cachedSize = state.fontFitCache.get(cacheKey);
    if (typeof cachedSize === "number" && Number.isFinite(cachedSize)) {
      return cachedSize;
    }

    const probe = ensureBubbleMeasureProbe();
    probe.className = node.className;
    probe.classList.add("mt-measure-probe");
    probe.classList.remove("mt-show-original");
    probe.style.width = `${width}px`;
    probe.style.height = `${height}px`;
    probe.style.fontSize = `${targetSize}px`;
    probe.textContent = text;

    let size = targetSize;
    while (size > minReadable && isProbeOverflowing(probe)) {
      size -= 1;
      probe.style.fontSize = `${size}px`;
    }

    const normalized = Math.round(clamp(size, minReadable, maxReadable) * 10) / 10;
    rememberFontFitCache(cacheKey, normalized);
    return normalized;
  }

  function ensureBubbleMeasureProbe() {
    if (state.bubbleMeasureProbe && state.bubbleMeasureProbe.isConnected) {
      return state.bubbleMeasureProbe;
    }

    const probe = document.createElement("div");
    probe.className = "mt-bubble mt-measure-probe";
    document.documentElement.appendChild(probe);
    state.bubbleMeasureProbe = probe;
    return probe;
  }

  function isProbeOverflowing(probe) {
    return probe.scrollHeight > probe.clientHeight + 0.5 || probe.scrollWidth > probe.clientWidth + 0.5;
  }

  function rememberFontFitCache(key, value) {
    state.fontFitCache.set(key, value);
    if (state.fontFitCache.size <= MAX_FONT_FIT_CACHE) {
      return;
    }

    const firstKey = state.fontFitCache.keys().next().value;
    if (firstKey) {
      state.fontFitCache.delete(firstKey);
    }
  }

  function removeOverlayForTarget(target) {
    const targetId = state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }

    const overlayState = state.overlaysById.get(targetId);
    if (!overlayState) {
      return;
    }

    // 清除 loading 超时定时器
    if (overlayState.loadingTimeout) {
      window.clearTimeout(overlayState.loadingTimeout);
      overlayState.loadingTimeout = 0;
    }
    overlayState.root.remove();
    state.overlaysById.delete(targetId);
    if (state.overlaysById.size === 0) {
      stopOverlayFrameSync();
    }
  }

  function restoreEmbeddedForTarget(target) {
    const targetId = state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }

    const embeddedState = state.embeddedById.get(targetId);
    if (!embeddedState) {
      return;
    }

    if (embeddedState.kind === "image" && target instanceof HTMLImageElement) {
      const originalSrc = target.dataset.mtEmbeddedOriginalSrc || target.dataset.mtEmbeddedOriginalSource || "";
      const originalSrcset = target.dataset.mtEmbeddedOriginalSrcset || "";

      target.dataset.mtEmbeddedActive = "";
      target.dataset.mtEmbeddedOutputKey = "";
      target.dataset.mtEmbeddedOriginalSource = "";
      target.dataset.mtEmbeddedOriginalSrc = "";
      target.dataset.mtEmbeddedOriginalSrcset = "";
      delete target.dataset.mtEmbeddedActive;
      delete target.dataset.mtEmbeddedOutputKey;
      delete target.dataset.mtEmbeddedOriginalSource;
      delete target.dataset.mtEmbeddedOriginalSrc;
      delete target.dataset.mtEmbeddedOriginalSrcset;

      if (originalSrcset) {
        target.setAttribute("srcset", originalSrcset);
      } else {
        target.removeAttribute("srcset");
      }
      if (originalSrc) {
        target.setAttribute("src", originalSrc);
      }
    } else if (embeddedState.kind === "canvas" && target instanceof HTMLCanvasElement && embeddedState.originalDataUrl) {
      restoreCanvasFromDataUrl(target, embeddedState.originalDataUrl);
    } else if (embeddedState.kind === "background" && target instanceof HTMLElement) {
      const originalBackground = target.dataset.mtEmbeddedOriginalBackground || "";
      target.dataset.mtEmbeddedActive = "";
      target.dataset.mtEmbeddedOutputKey = "";
      target.dataset.mtEmbeddedOriginalBackground = "";
      target.dataset.mtEmbeddedOriginalBackgroundSource = "";
      delete target.dataset.mtEmbeddedActive;
      delete target.dataset.mtEmbeddedOutputKey;
      delete target.dataset.mtEmbeddedOriginalBackground;
      delete target.dataset.mtEmbeddedOriginalBackgroundSource;
      target.style.backgroundImage = originalBackground;
    }

    state.embeddedById.delete(targetId);
  }

  function restoreCanvasFromDataUrl(canvas, dataUrl) {
    loadImageFromDataUrl(dataUrl)
      .then((image) => {
        if (!canvas.isConnected) {
          return;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      })
      .catch(() => {
        // 还原失败时保持当前画面，避免破坏页面渲染。
      });
  }

  function captureTargetSnapshot(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = target.getBoundingClientRect();
    return {
      currentSrc: target.currentSrc || target.src || "",
      naturalWidth: target.naturalWidth || 0,
      naturalHeight: target.naturalHeight || 0,
      rectWidth: rect.width,
      rectHeight: rect.height,
      sourceGeneration: getKakaoTargetGeneration(target),
      isConnected: target.isConnected
    };
  }

  function isTargetSnapshotStillValid(target, snapshot) {
    if (!target || !target.isConnected || !snapshot) {
      return false;
    }
    if (!snapshot.isConnected) {
      return false;
    }
    if (Number(snapshot.sourceGeneration || 0) !== getKakaoTargetGeneration(target)) {
      return false;
    }
    const currentSrc = target.currentSrc || target.src || "";
    if (snapshot.currentSrc && currentSrc && snapshot.currentSrc !== currentSrc) {
      return false;
    }
    const natW = target.naturalWidth || 0;
    const natH = target.naturalHeight || 0;
    if (snapshot.naturalWidth && natW && snapshot.naturalWidth !== natW) {
      return false;
    }
    if (snapshot.naturalHeight && natH && snapshot.naturalHeight !== natH) {
      return false;
    }
    const rect = target.getBoundingClientRect();
    const wDiff = Math.abs(rect.width - snapshot.rectWidth);
    const hDiff = Math.abs(rect.height - snapshot.rectHeight);
    const wRel = snapshot.rectWidth > 0 ? wDiff / snapshot.rectWidth : 0;
    const hRel = snapshot.rectHeight > 0 ? hDiff / snapshot.rectHeight : 0;
    if (wDiff > 3 && wRel > 0.03) return false;
    if (hDiff > 3 && hRel > 0.03) return false;
    return true;
  }

  function clearRenderedTarget(target) {
    removeOverlayForTarget(target);
    restoreEmbeddedForTarget(target);
  }

  function clearAllOverlays() {
    stopOverlayFrameSync();
    for (const overlayState of state.overlaysById.values()) {
      overlayState.root.remove();
    }
    state.overlaysById.clear();
    state.fontFitCache.clear();
    if (state.bubbleMeasureProbe && state.bubbleMeasureProbe.isConnected) {
      state.bubbleMeasureProbe.remove();
    }
    state.bubbleMeasureProbe = null;
  }

  function clearAllEmbeddedTargets() {
    const targets = Array.from(state.embeddedById.values()).map((item) => item.target).filter(Boolean);
    targets.forEach((target) => restoreEmbeddedForTarget(target));
    state.embeddedById.clear();
    state.embeddedImageCache.clear();
  }

  function clearAllRenderedTargets() {
    clearAllOverlays();
    clearAllEmbeddedTargets();
  }

  function ensureOverlayLayer() {
    if (state.overlayLayer && state.overlayLayer.isConnected) {
      return state.overlayLayer;
    }

    const layer = document.createElement("div");
    layer.className = "mt-overlay-layer";
    if (IS_KAKAOPAGE_READER) {
      // 进入页面坐标系后，图片和覆盖层由浏览器合成线程同步滚动，避免 fixed 覆盖层逐帧追赶。
      layer.classList.add("mt-overlay-document-flow");
    }
    layer.dataset.mangaTranslatorOverlay = "true";
    document.documentElement.appendChild(layer);

    state.overlayLayer = layer;
    reattachOverlayRoots(layer);
    return layer;
  }

  function reattachOverlayRoots(layer) {
    if (!layer || !layer.isConnected) {
      return;
    }

    state.overlaysById.forEach((overlayState) => {
      if (overlayState && overlayState.root && !overlayState.root.isConnected) {
        layer.appendChild(overlayState.root);
      }
    });
  }

  function isExtensionUiMounted() {
    const overlayOk = !!(state.overlayLayer && state.overlayLayer.isConnected);
    const ballOk = !state.showFloatingBall || !!(state.floatingBallWrap && state.floatingBallWrap.isConnected);
    return overlayOk && ballOk;
  }

  function ensureExtensionUiMounted() {
    if (state.invalidated) {
      return;
    }
    if (!isCurrentRuntimeOwner()) {
      destroy();
      return;
    }

    const layer = ensureOverlayLayer();
    reattachOverlayRoots(layer);
    if (state.overlayHideDepth === 0 && layer && layer.style.visibility === "hidden") {
      layer.style.visibility = state.overlayPreviousVisibility || "";
      state.overlayPreviousVisibility = "";
    }

    if (!state.floatingBallWrap || !state.floatingBallWrap.isConnected) {
      state.floatingBallWrap = null;
      state.floatingBall = null;
      state.floatingBallClose = null;
      createFloatingBall();
    }

    if (
      state.overlayHideDepth === 0 &&
      state.floatingBallWrap &&
      state.floatingBallWrap.isConnected &&
      state.floatingBallWrap.style.visibility === "hidden"
    ) {
      state.floatingBallWrap.style.visibility = "";
    }

    updateFloatingBallState();
  }

  function stopExtensionUiEvent(event) {
    if (!event) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  function stopExtensionUiPropagation(event) {
    if (!event) {
      return;
    }

    event.stopPropagation();
  }

  function createFloatingBall() {
    if (state.floatingBallWrap && state.floatingBallWrap.isConnected) {
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "mt-floating-ball-wrap";
    wrap.dataset.mangaTranslatorOverlay = "true";
    wrap.addEventListener("click", stopExtensionUiEvent);
    wrap.addEventListener("mousedown", stopExtensionUiPropagation);
    wrap.addEventListener("mouseup", stopExtensionUiPropagation);
    wrap.addEventListener("pointerdown", stopExtensionUiPropagation);
    wrap.addEventListener("pointerup", stopExtensionUiPropagation);

    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "mt-floating-ball";
    ball.textContent = "译";
    ball.title = "翻译当前视口漫画目标";

    ball.addEventListener("click", async (event) => {
      stopExtensionUiEvent(event);
      if (state.invalidated) {
        return;
      }

      await togglePageAutoTranslate(!state.autoTranslatePageEnabled);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mt-floating-close";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭悬浮球";
    closeBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await closeFloatingBall();
    });

    wrap.appendChild(ball);
    wrap.appendChild(closeBtn);

    document.documentElement.appendChild(wrap);
    state.floatingBallWrap = wrap;
    state.floatingBall = ball;
    state.floatingBallClose = closeBtn;
    updateFloatingBallState();
  }

  function updateFloatingBallState() {
    if (!state.floatingBallWrap || !state.floatingBall) {
      return;
    }

    state.floatingBallWrap.classList.toggle("mt-hidden", !state.showFloatingBall);
    state.floatingBall.classList.toggle("mt-disabled", !state.enabled || state.invalidated);
    state.floatingBall.classList.toggle("mt-auto-enabled", state.autoTranslatePageEnabled && state.enabled);
    state.floatingBall.textContent = state.autoTranslatePageEnabled && state.enabled ? "停" : "译";
    state.floatingBall.title =
      state.autoTranslatePageEnabled && state.enabled ? "关闭本页自动翻译" : "开启本页自动翻译";
  }

  function setFloatingBallWorking(working) {
    if (!state.floatingBall) {
      return;
    }

    state.floatingBall.classList.toggle("mt-working", !!working);
  }

  async function closeFloatingBall() {
    state.showFloatingBall = false;
    updateFloatingBallState();

    try {
      await storageSet({ mt_show_ball: false });
    } catch {
      // Ignore persistence failure, keep current page hidden state.
    }
  }

  async function manualTranslateVisible() {
    if (state.invalidated) {
      return {
        visibleCount: 0,
        successCount: 0,
        failCount: 0,
        errors: ["Extension context invalidated"]
      };
    }

    setFloatingBallWorking(true);

    try {
      let targets = collectVisibleTargets();
      if (targets.length === 0 && IS_CMOA_SPEED_READER) {
        targets = collectVisibleTargets({ relaxed: true });
      }

      if (targets.length === 0) {
        await reportStatus("info", "no visible manga target", {
          pageUrl: location.href
        });

        return {
          visibleCount: 0,
          successCount: 0,
          failCount: 0,
          errors: []
        };
      }

      let successCount = 0;
      let failCount = 0;
      const errors = [];

      const tasks = targets.map((target) => async () =>
        translateTarget(target, {
          manual: true,
          reason: "manual"
        })
      );
      const results = await runWithConcurrency(tasks, MANUAL_PARALLEL_TRANSLATIONS);

      for (const result of results) {
        if (result && result.ok) {
          successCount += 1;
        } else if (result && result.skipped) {
          // 滚动或虚拟列表会让截图目标在执行前离屏，此类目标不计为失败。
        } else {
          failCount += 1;
          if (result && result.error) {
            errors.push(result.error);
          }
        }
      }

      const uniqueErrors = [...new Set(errors)].slice(0, 3);
      const summaryMessage =
        failCount > 0
          ? `manual translate finished (${successCount}/${targets.length}), first error: ${
              uniqueErrors[0] || "unknown"
            }`
          : `manual translate finished (${successCount}/${targets.length})`;

      await reportStatus(failCount > 0 ? "error" : "info", summaryMessage, {
        visibleCount: targets.length,
        successCount,
        failCount,
        firstError: uniqueErrors[0] || ""
      });

      return {
        visibleCount: targets.length,
        successCount,
        failCount,
        errors: uniqueErrors
      };
    } finally {
      setFloatingBallWorking(false);
    }
  }

  async function togglePageAutoTranslate(enabled) {
    if (state.invalidated) {
      return {
        enabled: false,
        visibleCount: 0,
        successCount: 0,
        failCount: 0,
        errors: ["Extension context invalidated"]
      };
    }

    const nextEnabled = typeof enabled === "boolean" ? enabled : !state.autoTranslatePageEnabled;
    state.autoTranslatePageEnabled = nextEnabled && state.enabled;
    updateFloatingBallState();

    if (!state.autoTranslatePageEnabled) {
      clearAutoTranslateRetryTimers();
      await reportStatus("info", "page auto translate stopped", {
        pageUrl: location.href
      });
      return {
        enabled: false,
        visibleCount: 0,
        successCount: 0,
        failCount: 0,
        errors: []
      };
    }

    rescan();
    const result = await manualTranslateVisible();
    queueVisiblePageAutoTargets();

    await reportStatus("info", "page auto translate started", {
      pageUrl: location.href,
      visibleCount: result.visibleCount,
      successCount: result.successCount,
      failCount: result.failCount
    });

    return {
      enabled: true,
      ...result
    };
  }

  function getPageAutoTranslateStatus() {
    return {
      enabled: state.autoTranslatePageEnabled && state.enabled,
      queuedCount: state.queue.length,
      runningCount: state.runningJobs
    };
  }

  function queueVisiblePageAutoTargets() {
    const targets = collectVisibleTargets({ includeLimit: false });
    targets.forEach((target) => queuePageAutoTranslate(target));
  }

  function queuePageAutoTranslate(target) {
    if (!state.autoTranslatePageEnabled || !state.enabled || state.invalidated) {
      return;
    }

    if (!isSupportedTarget(target) || !target.isConnected) {
      return;
    }

    if (maybeQueueKakaoShortPageAttachmentOwner(target, { manual: true, force: true, reason: "page-auto-short-attachment" })) {
      return;
    }

    if (isKakaoShortPageQueueBlocked(target)) {
      return;
    }

    const targetKey = computeTargetKey(target);
    const scopedTargetKey = buildTargetSourceCacheKey(targetKey, getQuickSourceToken(target));
    if (
      target.dataset.mtLastTranslatedKey === targetKey ||
      target.dataset.mtLastTranslatedKey === scopedTargetKey ||
      target.dataset.mtNoTextKey === targetKey ||
      target.dataset.mtNoTextKey === scopedTargetKey
    ) {
      return;
    }

    if (!passesTargetFilter(target, true)) {
      console.debug("[MangaTranslator][Filter] queuePageAutoTranslate rejected", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        rect: (() => { try { const r = target.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; } catch { return '?'; } })()
      });
      tracePipeline("skipped", target, { skipReason: "filterFail" });
      // KakaoPage: IntersectionObserver fires early (8% visible) but geometry check
      // needs more (180px+ visible). Schedule retry so scroll-into-view images
      // don't get stuck untranslated.
      if (IS_KAKAOPAGE_READER) {
        scheduleAutoTranslateRetry(target);
      }
      return;
    }

    if (isScreenshotCaptureMode() && !getVisibleViewportRect(target)) {
      return;
    }

    queueTranslate(target, {
      manual: true,
      reason: "page-auto"
    });
  }

  function maybeQueueKakaoShortPageAttachmentOwner(target, options = {}) {
    if (
      !IS_KAKAOPAGE_READER ||
      shouldUseKakaoCanonicalPipeline(target) ||
      state.captureMode !== CAPTURE_MODE_DIRECT ||
      state.renderMode !== RENDER_MODE_OVERLAY ||
      !(target instanceof HTMLImageElement) ||
      !target.complete
    ) {
      return false;
    }

    const attachment = findKakaoShortPageAttachmentOwner(target);
    if (!attachment || !attachment.owner || attachment.owner === target) {
      return false;
    }

    const owner = attachment.owner;
    const ownerKey = computeTargetKey(owner);
    const ownerScopedKey = buildTargetSourceCacheKey(ownerKey, getQuickSourceToken(owner));
    if (!KP.attachShortPageIfAllowed(state.kakaoStore, target, ownerScopedKey)) {
      tracePipeline("short-attachment-suppressed", target, { ownerScopedKey });
      return false;
    }
    target.dataset.mtNoTextKey = "";
    tracePipeline("short-attached", target, { attachedToKey: ownerScopedKey });


    state.payloadCacheByTargetKey.delete(ownerKey);
    state.payloadCacheByTargetKey.delete(ownerScopedKey);
    state.localResultCache.delete(ownerKey);
    state.localResultCache.delete(ownerScopedKey);
    owner.dataset.mtLastTranslatedKey = "";
    owner.dataset.mtNoTextKey = "";

    queueTranslate(owner, {
      ...options,
      manual: true,
      force: true,
      reason: `${String(options.reason || "kakao-short-page")}:${attachment.direction}`
    });
    return true;
  }

  function findKakaoShortPageAttachmentOwner(target) {
    const candidates = collectKakaopageManualTargetCandidates(true, target).filter(
      (candidate) => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete
    );
    return KP.findKakaoShortPageAttachmentOwner(target, candidates, describeKakaoStitchTarget);
  }
  function releaseShortPagesAttachedDuringInflight(owner) {
    if (!owner || typeof owner.getBoundingClientRect !== "function") {
      return;
    }

    const ownerKey = computeTargetKey(owner);
    const ownerScopedKey = buildTargetSourceCacheKey(ownerKey, getQuickSourceToken(owner));
    if (!ownerScopedKey) return;

    const released = KP.releaseShortPagesForOwner(
      state.kakaoStore,
      collectKakaopageManualTargetCandidates(true, owner).filter((candidate) => candidate !== owner),
      ownerScopedKey
    );
    for (const candidate of released) {
      // 这个短页在 owner inflight 期间被附着 → owner 的 payload 不包含它
      // 释放标记，让短页走独立翻译流程
      delete candidate.dataset.mtNoTextKey;
      delete candidate.dataset.mtLastTranslatedKey;
      tracePipeline("short-detached", candidate, { reason: "ownerInflightCompleted", ownerScopedKey });

      queuePageAutoTranslate(candidate);
    }
  }

  function releaseUncoveredKakaoShortPages(payload, result, owner, reason) {
    // 仅释放未被 owner stitch 结果覆盖的短页。
    // 若 owner 结果中已有短页气泡（stitch_attached_short_page），说明短页文字已通过
    // 拼接 OCR 翻译并渲染在 owner overlay 上，无需再独立翻译，避免出现重复译文。
    if (!IS_KAKAOPAGE_READER || !payload || hasAttachedShortPageBubble(result)) {
      return 0;
    }

    const attachedShortPageKeys = Array.isArray(payload.attachedShortPageKeys)
      ? payload.attachedShortPageKeys.filter(Boolean)
      : [];
    if (attachedShortPageKeys.length === 0) {
      return 0;
    }

    const ownerKey = owner ? computeTargetKey(owner) : "";
    const ownerScopedKey = owner ? buildTargetSourceCacheKey(ownerKey, getQuickSourceToken(owner)) : "";
    let released = 0;
    for (const shortKey of attachedShortPageKeys) {
      const el = findTargetByScopedKey(shortKey);
      if (!el) {
        tracePipeline("short-detached", null, { reason: `findTargetByScopedKey returned null for ${String(shortKey).slice(0, 80)}`, ownerScopedKey });
        continue;
      }

      KP.releaseShortPagesForOwner(state.kakaoStore, [el], ownerScopedKey);
      delete el.dataset.mtNoTextKey;
      delete el.dataset.mtLastTranslatedKey;
      tracePipeline("short-detached", el, { reason, ownerScopedKey });
      released += 1;

      // 使用 queuePageAutoTranslate 而非 queueTranslate，确保有 retry 保护和 filter 重试机制
      queuePageAutoTranslate(el);
    }
    return released;
  }

  function hasAttachedShortPageBubble(result) {
    return !!(
      result &&
      Array.isArray(result.bubbles) &&
      result.bubbles.some((bubble) => bubble && bubble.stitch_attached_short_page === true)
    );
  }

  function scheduleAutoTranslateRetry(target) {
    return kakaoRetryScheduler.schedule(target);
  }

  function clearAutoTranslateRetryTimers() {
    kakaoRetryScheduler.clear();
  }
  function collectVisibleTargets(options = {}) {
    const relaxed = options.relaxed === true;
    const includeLimit = options.includeLimit !== false;
    const limit = IS_CMOA_SPEED_READER ? 6 : MAX_MANUAL_TARGETS;
    const targets = getManualTargetCandidates(relaxed)
      .filter((target) => isSupportedTarget(target) && passesTargetFilter(target, true, { relaxed }))
      .filter((target) => isRectVisible(target.getBoundingClientRect()))
      .map((target) => ({
        target,
        area: getVisibleArea(target.getBoundingClientRect())
      }))
      .sort((left, right) => right.area - left.area)
      .map((item) => item.target);

    if (IS_KAKAOPAGE_READER) {
      console.info(
        "[MangaTranslator][KakaoPage] visible OCR targets",
        targets.slice(0, includeLimit ? limit : 6).map((target) => {
          const rect = target.getBoundingClientRect();
          const url = target instanceof HTMLImageElement ? resolveImageUrl(target) : "";
          const filename = (url.match(/filename=([^&]+)/) || [])[1] || "";
          return {
            filename,
            rect: {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            },
            visibleArea: Math.round(getVisibleArea(rect))
          };
        })
      );
    }

    return includeLimit ? targets.slice(0, limit) : targets;
  }

  function getManualTargetCandidates(relaxed) {
    if (IS_KAKAOPAGE_READER) {
      return collectKakaopageManualTargetCandidates(relaxed);
    }

    if (!IS_CMOA_SPEED_READER || relaxed) {
      return Array.from(document.querySelectorAll(TARGET_SELECTOR));
    }

    const selectors = [
      "#content .pt-img img",
      "#content [id^='content-p'] img",
      "#content img",
      "#content canvas",
      TARGET_SELECTOR
    ];
    const seen = new Set();
    const result = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((target) => {
        if (!seen.has(target)) {
          seen.add(target);
          result.push(target);
        }
      });
    }

    return result.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
    });
  }

  function collectKakaopageManualTargetCandidates(relaxed, ownerTarget = null) {
    const selectors = [
      TARGET_SELECTOR,
      "main img",
      "main canvas",
      "main [style*='background-image']",
      "[class*='viewer'] img",
      "[class*='viewer'] canvas",
      "[class*='viewer'] [style*='background-image']",
      "[class*='page'] img",
      "[class*='page'] canvas",
      "[class*='page'] [style*='background-image']"
    ];
    const seen = new Set();
    const raw = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((target) => {
        if (!seen.has(target)) {
          seen.add(target);
          raw.push(target);
        }
      });
    }

    const scanLimit = relaxed ? 1400 : 800;
    const candidates = Array.from(document.querySelectorAll("main *, body *")).slice(0, scanLimit);
    candidates.forEach((target) => {
      if (!seen.has(target) && target instanceof HTMLElement && isBackgroundImageTarget(target)) {
        seen.add(target);
        raw.push(target);
      }
    });

    const ownerRect = ownerTarget && typeof ownerTarget.getBoundingClientRect === "function"
      ? ownerTarget.getBoundingClientRect()
      : null;
    const ownerCenter = ownerRect && ownerRect.width > 0 ? ownerRect.left + ownerRect.width / 2 : null;
    const result = raw.filter((target) => {
      if (!target || !target.isConnected || typeof target.getBoundingClientRect !== "function") {
        return false;
      }

      const rect = target.getBoundingClientRect();
      if (!(rect.width >= 1 && rect.height >= 1)) {
        return false;
      }

      // Visibility check: skip hidden elements
      try {
        const style = window.getComputedStyle(target);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
      } catch (_) {
        // ignore getComputedStyle errors
      }

      if (target instanceof HTMLImageElement) {
        const src = target.currentSrc || target.src || "";
        if (!src || !target.complete) return false;
        const naturalWidth = Number(target.naturalWidth || 0);
        const naturalHeight = Number(target.naturalHeight || 0);
        if (!(naturalWidth >= 1 && naturalHeight >= 1)) {
          return false;
        }
      }

      // Neighbor-finding mode: apply size + center proximity filters.
      // Accept thin strips (down to 8px) so they can be stitched into
      // adjacent pages instead of being dropped entirely.
      if (ownerRect) {
        const thinStripMinHeight = KAKAO_THIN_STRIP_MIN_HEIGHT;
        if (!(rect.width >= 200 && rect.height >= thinStripMinHeight)) {
          return false;
        }
        if (target instanceof HTMLImageElement) {
          const naturalWidth = Number(target.naturalWidth || 0);
          const naturalHeight = Number(target.naturalHeight || 0);
          if (!(naturalWidth >= 60 && naturalHeight >= thinStripMinHeight)) {
            return false;
          }
        }
        if (ownerCenter !== null) {
          const center = rect.left + rect.width / 2;
          const maxCenterDelta = Math.max(rect.width, ownerRect.width) * 0.15;
          if (Math.abs(center - ownerCenter) > maxCenterDelta) {
            return false;
          }
        }
      }

      return true;
    });

    // Always sort by visual position (scroll-adjusted), secondary by left
    return result.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftTop = leftRect.top + (window.scrollY || 0);
      const rightTop = rightRect.top + (window.scrollY || 0);
      if (Math.abs(leftTop - rightTop) > 2) {
        return leftTop - rightTop;
      }
      return leftRect.left - rightRect.left;
    });

  }

  async function runWithConcurrency(taskFactories, parallel) {
    const limit = Math.max(1, Math.min(parallel, taskFactories.length || 1));
    const results = new Array(taskFactories.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < taskFactories.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await taskFactories[index]();
        } catch (error) {
          results[index] = { ok: false, error: getErrorMessage(error) };
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
  }

  function isTargetVisible(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") return false;
    const rect = target.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return rect.left < vw && rect.right > 0 && rect.top < vh && rect.bottom > 0 && rect.width > 0 && rect.height > 0;
  }

  function passesTargetFilter(target, manual, options = {}) {
    const relaxed = options.relaxed === true;
    const allowOffscreen = options.allowOffscreen === true;
    if (!isSupportedTarget(target) || !target.isConnected) {
      return false;
    }
    if (!isSitePreferredTarget(target, { allowLoose: relaxed })) {
      return false;
    }

    if (target instanceof HTMLImageElement && !target.complete) {
      console.debug("[MangaTranslator][Filter] image not complete", {
        src: (target.currentSrc || target.src || '').slice(0, 60)
      });
      return false;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return false;
    }

    const widthLimit = manual ? MANUAL_MIN_WIDTH : AUTO_MIN_WIDTH;
    const heightLimit = manual ? MANUAL_MIN_HEIGHT : AUTO_MIN_HEIGHT;
    const effectiveWidthLimit = relaxed ? Math.max(90, Math.min(widthLimit, 100)) : widthLimit;
    // KakaoPage: accept thin strips so they can be stitched into neighbors
    const stripMinHeight = IS_KAKAOPAGE_READER ? KAKAO_THIN_STRIP_MIN_HEIGHT : 0;
    const effectiveHeightLimit = shouldUseKakaoCanonicalPipeline(target)
      ? stripMinHeight
      : relaxed
        ? Math.max(90, Math.min(heightLimit, 100))
        : Math.max(stripMinHeight, heightLimit);

    if (rect.width < effectiveWidthLimit || rect.height < effectiveHeightLimit) {
      console.debug("[MangaTranslator][Filter] rect too small", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        min: `${effectiveWidthLimit}x${effectiveHeightLimit}`,
        manual
      });
      return false;
    }

    if (IS_KAKAOPAGE_READER && !passesKakaopageTargetGeometry(target, rect, manual, relaxed, allowOffscreen)) {
      console.debug("[MangaTranslator][Filter] KakaoPage geometry rejected", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        manual,
        relaxed
      });
      return false;
    }

    const ratio = rect.height / rect.width;
    // KakaoPage: accept thin strips (down to ~0.01 ratio) so they aren't dropped.
    // The KakaoPage geometry check already handles per-mode visibility thresholds.
    const effectiveMinRatio = IS_KAKAOPAGE_READER ? 0.01 : (relaxed ? 0.10 : AUTO_MIN_RATIO);
    const maxRatio = relaxed ? 20 : 14;
    if (ratio < effectiveMinRatio || ratio > maxRatio) {
      console.debug("[MangaTranslator][Filter] aspect ratio out of bounds", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        ratio: ratio.toFixed(3),
        min: effectiveMinRatio,
        max: maxRatio
      });
      return false;
    }

    if (IS_CMOA_SPEED_READER) {
      const area = getVisibleArea(rect);
      const baseMinVisibleArea = manual ? CMOA_MANUAL_MIN_VISIBLE_AREA : CMOA_AUTO_MIN_VISIBLE_AREA;
      const minVisibleArea = relaxed ? Math.max(1200, Math.floor(baseMinVisibleArea * 0.2)) : baseMinVisibleArea;
      if (area < minVisibleArea) {
        return false;
      }
    }

    return true;
  }

  function passesKakaopageTargetGeometry(target, rect, manual, relaxed, allowOffscreen = false) {
    if (!allowOffscreen) {
      const canonicalTarget = shouldUseKakaoCanonicalPipeline(target);
      const visibleArea = getVisibleArea(rect);
      const visibleRect = getVisibleViewportRect(target);
      // KakaoPage uses virtual scrolling with tall images (up to 1100px+).
      // Lower thresholds so partially-scrolled images aren't filtered out.
      const minVisibleArea = canonicalTarget ? 1200 : relaxed ? 3000 : manual ? 6000 : 8000;
      if (!visibleRect || visibleArea < minVisibleArea) {
        console.debug("[MangaTranslator][Filter] KakaoPage not enough visible area", {
          src: (target.currentSrc || target.src || '').slice(0, 60),
          visibleArea: visibleArea,
          minVisibleArea,
          manual,
          relaxed
        });
        return false;
      }

      const minVisibleHeight = canonicalTarget ? KAKAO_THIN_STRIP_MIN_HEIGHT : relaxed ? 40 : manual ? 50 : 60;
      const minVisibleWidth = relaxed ? 50 : manual ? 60 : 80;
      if (visibleRect.height < minVisibleHeight || visibleRect.width < minVisibleWidth) {
        console.debug("[MangaTranslator][Filter] KakaoPage visible rect too small", {
          src: (target.currentSrc || target.src || '').slice(0, 60),
          visibleRect: `${Math.round(visibleRect.width)}x${Math.round(visibleRect.height)}`,
          min: `${minVisibleWidth}x${minVisibleHeight}`
        });
        return false;
      }

      const visibleRatio = visibleRect.height / Math.max(1, visibleRect.width);
      if (visibleRatio < 0.01 || visibleRatio > 22) {
        return false;
      }
    }

    if (target instanceof HTMLImageElement) {
      const naturalWidth = Number(target.naturalWidth || 0);
      const naturalHeight = Number(target.naturalHeight || 0);
      if (naturalWidth > 0 && naturalHeight > 0) {
        const naturalRatio = naturalHeight / Math.max(1, naturalWidth);
        // Accept thin strips (down to 8px, ratio ≥ 0.01) so they
        // get their own translation with stitching context.
        if (naturalHeight < KAKAO_THIN_STRIP_MIN_HEIGHT || naturalRatio < 0.01) {
          console.debug("[MangaTranslator][Filter] KakaoPage natural size too thin", {
            src: (target.currentSrc || target.src || '').slice(0, 60),
            natural: `${naturalWidth}x${naturalHeight}`
          });
          return false;
        }
      }
    }

    return true;
  }

  function isSitePreferredTarget(target, options = {}) {
    const allowLoose = options.allowLoose === true;
    if (IS_PIXIV_COMIC_VIEWER) {
      return isBackgroundImageTarget(target) || target instanceof HTMLImageElement || target instanceof HTMLCanvasElement;
    }

    if (!IS_CMOA_SPEED_READER) {
      return true;
    }

    const inReader = !!target.closest("#content .pt-img, #content [id^='content-p'], #content");
    if (inReader) {
      return true;
    }

    if (!allowLoose) {
      return false;
    }

    if (target.closest("[id*='reader'], [class*='reader'], [class*='comic'], [class*='page']")) {
      return true;
    }

    if (!(target instanceof HTMLImageElement)) {
      return false;
    }

    const src = resolveImageUrl(target);
    return !!src;
  }

  function computeTargetKey(target) {
    const captureSegment = getCaptureModeTargetKeySegment(target);
    if (target instanceof HTMLImageElement) {
      const url = resolveImageUrl(target);
      const width = target.naturalWidth || target.width || Math.round(target.getBoundingClientRect().width);
      const height = target.naturalHeight || target.height || Math.round(target.getBoundingClientRect().height);
      return `${captureSegment}|img|${url}|${width}x${height}`;
    }

    if (target instanceof HTMLCanvasElement) {
      const signature = computeCanvasSignature(target);
      return `${captureSegment}|canvas|${signature}`;
    }

    if (isBackgroundImageTarget(target)) {
      const rect = target.getBoundingClientRect();
      return `${captureSegment}|background|${resolveBackgroundImageUrl(target)}|${Math.round(rect.width)}x${Math.round(
        rect.height
      )}`;
    }

    return `${captureSegment}|unknown|${Date.now()}`;
  }

  function findTargetByScopedKey(scopedKey) {
    if (!scopedKey) return null;
    const targets = document.querySelectorAll(TARGET_SELECTOR);
    for (const candidate of targets) {
      if (!isSupportedTarget(candidate) || !candidate.isConnected) continue;
      const key = computeTargetKey(candidate);
      if (buildTargetSourceCacheKey(key, getQuickSourceToken(candidate)) === scopedKey) {
        return candidate;
      }
    }
    return null;
  }

  function getCaptureModeTargetKeySegment(target) {
    if (!isScreenshotCaptureMode()) {
      return CAPTURE_MODE_DIRECT;
    }

    const visibleRect = getVisibleViewportRect(target);
    if (!visibleRect) {
      return `${CAPTURE_MODE_SCREENSHOT}|not-visible`;
    }

    const targetRect = target.getBoundingClientRect();
    const offsetX = Math.round(visibleRect.left - targetRect.left);
    const offsetY = Math.round(visibleRect.top - targetRect.top);
    const width = Math.round(visibleRect.width);
    const height = Math.round(visibleRect.height);
    return `${CAPTURE_MODE_SCREENSHOT}|${offsetX},${offsetY},${width}x${height}`;
  }

  function buildScreenshotImageUrl(target) {
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "target";
    return `visible-tab-${tag}-crop`;
  }

  function getPayloadImageMeta(payload) {
    const width = Number(payload && payload.width);
    const height = Number(payload && payload.height);
    if (width > 0 && height > 0) {
      return {
        width,
        height,
        cssWidth: Number(payload && payload.cssWidth) || 0,
        cssHeight: Number(payload && payload.cssHeight) || 0,
        bitmapWidth: Number(payload && payload.bitmapWidth) || width,
        bitmapHeight: Number(payload && payload.bitmapHeight) || height,
        cropX: Number(payload && payload.cropX) || 0,
        cropY: Number(payload && payload.cropY) || 0,
        devicePixelRatio: Number(payload && payload.devicePixelRatio) || window.devicePixelRatio || 1,
        source: String((payload && payload.source) || "")
      };
    }

    return null;
  }

  function getPayloadDisplayRect(payload) {
    const rect = payload && payload.displayRect;
    if (!rect || typeof rect !== "object") {
      return null;
    }

    const offsetX = Number(rect.offsetX);
    const offsetY = Number(rect.offsetY);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!(Number.isFinite(offsetX) && Number.isFinite(offsetY) && width > 0 && height > 0)) {
      return null;
    }

    return { offsetX, offsetY, width, height };
  }

  function computeCanvasSignature(canvas) {
    const width = canvas.width || Math.round(canvas.getBoundingClientRect().width);
    const height = canvas.height || Math.round(canvas.getBoundingClientRect().height);
    const signature = `${width}x${height}`;

    if (width <= 1 || height <= 1) {
      return signature;
    }

    try {
      const probe = document.createElement("canvas");
      probe.width = 16;
      probe.height = 16;
      const probeCtx = probe.getContext("2d", { alpha: false, desynchronized: true });
      if (!probeCtx) {
        return signature;
      }

      probeCtx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const tinyDataUrl = probe.toDataURL("image/jpeg", 0.45);
      return `${signature}|${tinyDataUrl.slice(-128)}`;
    } catch {
      const rect = canvas.getBoundingClientRect();
      const timeBucket = Math.floor(Date.now() / 5000);
      return `${signature}|tainted|${Math.round(rect.left)}x${Math.round(rect.top)}|${Math.round(
        window.scrollX
      )}x${Math.round(window.scrollY)}|${timeBucket}`;
    }
  }

  function resolveImageUrl(img) {
    if (img.dataset.mtEmbeddedActive === "true") {
      const currentSource = String(img.currentSrc || img.getAttribute("src") || "").trim();
      if (isDataUrl(currentSource) && img.dataset.mtEmbeddedOriginalSource) {
        return img.dataset.mtEmbeddedOriginalSource;
      }
      if (currentSource && !isDataUrl(currentSource)) {
        delete img.dataset.mtEmbeddedActive;
        delete img.dataset.mtEmbeddedOutputKey;
        delete img.dataset.mtEmbeddedOriginalSource;
        delete img.dataset.mtEmbeddedOriginalSrc;
        delete img.dataset.mtEmbeddedOriginalSrcset;
      }
    }

    const candidates = [
      img.currentSrc,
      img.getAttribute("src"),
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.getAttribute("data-lazy-src")
    ].filter(Boolean);

    if (candidates.length === 0) {
      return "";
    }

    const first = String(candidates[0]).trim();
    if (!first) {
      return "";
    }

    if (first.startsWith("data:")) {
      return first;
    }

    if (first.startsWith("blob:")) {
      return first;
    }

    try {
      if (first.startsWith("//")) {
        return `${location.protocol}${first}`;
      }
      return new URL(first, location.href).href;
    } catch {
      return first;
    }
  }

  function resolveBackgroundImageUrl(target) {
    if (!(target instanceof Element)) {
      return "";
    }

    const backgroundImage = String(getComputedStyle(target).backgroundImage || target.style.backgroundImage || "").trim();
    if (!backgroundImage || backgroundImage === "none") {
      return "";
    }

    const match = backgroundImage.match(/url\((["']?)(.*?)\1\)/i);
    const rawUrl = match ? match[2] : "";
    if (!rawUrl) {
      return "";
    }

    if (target instanceof HTMLElement && target.dataset.mtEmbeddedActive === "true") {
      if (rawUrl.startsWith("data:") && target.dataset.mtEmbeddedOriginalBackgroundSource) {
        return target.dataset.mtEmbeddedOriginalBackgroundSource;
      }
      if (rawUrl && !rawUrl.startsWith("data:")) {
        delete target.dataset.mtEmbeddedActive;
        delete target.dataset.mtEmbeddedOutputKey;
        delete target.dataset.mtEmbeddedOriginalBackground;
        delete target.dataset.mtEmbeddedOriginalBackgroundSource;
      }
    }

    try {
      if (rawUrl.startsWith("//")) {
        return `${location.protocol}${rawUrl}`;
      }
      if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
        return rawUrl;
      }
      return new URL(rawUrl, location.href).href;
    } catch {
      return rawUrl;
    }
  }

  function isBackgroundImageTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const imageUrl = resolveBackgroundImageUrl(target);
    if (!imageUrl || PIXIV_PLACEHOLDER_BACKGROUND_RE.test(imageUrl)) {
      return false;
    }

    if (IS_PIXIV_COMIC_VIEWER) {
      return PIXIV_PAGE_ID_RE.test(target.id || "");
    }

    if (!IS_KAKAOPAGE_READER) {
      return false;
    }

    if (isDataUrl(imageUrl) || isBlobUrl(imageUrl)) {
      return true;
    }

    if (!isHttpUrl(imageUrl)) {
      return false;
    }

    try {
      const host = new URL(imageUrl, location.href).hostname;
      return /(^|\.)kakao(?:cdn)?\.net$/i.test(host) || /(^|\.)kakaocdn\.net$/i.test(host);
    } catch {
      return /kakao|kakaocdn/i.test(imageUrl);
    }
  }

  function getQuickSourceToken(target) {
    if (target instanceof HTMLImageElement) {
      return resolveImageUrl(target);
    }

    if (target instanceof HTMLCanvasElement) {
      return `canvas:${target.width}x${target.height}`;
    }

    if (isBackgroundImageTarget(target)) {
      return resolveBackgroundImageUrl(target);
    }

    return "";
  }

  function buildPayloadImageMeta(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const displayRect = getPayloadDisplayRect(payload);
    return {
      width: Number(payload.width || 0),
      height: Number(payload.height || 0),
      cssWidth: Number(payload.cssWidth || (displayRect && displayRect.width) || 0),
      cssHeight: Number(payload.cssHeight || (displayRect && displayRect.height) || 0),
      bitmapWidth: Number(payload.bitmapWidth || payload.width || 0),
      bitmapHeight: Number(payload.bitmapHeight || payload.height || 0),
      cropX: Number(payload.cropX || 0),
      cropY: Number(payload.cropY || 0),
      cropCssX: Number(displayRect && displayRect.offsetX ? displayRect.offsetX : 0),
      cropCssY: Number(displayRect && displayRect.offsetY ? displayRect.offsetY : 0),
      cropCssWidth: Number(displayRect && displayRect.width ? displayRect.width : payload.cssWidth || 0),
      cropCssHeight: Number(displayRect && displayRect.height ? displayRect.height : payload.cssHeight || 0),
      devicePixelRatio: Number(payload.devicePixelRatio || window.devicePixelRatio || 1),
      source: String(payload.source || ""),
      sourceImageId: String(payload.sourceImageId || ""),
      sourceWidth: Number(payload.sourceWidth || 0),
      sourceHeight: Number(payload.sourceHeight || 0),
      targetCssWidth: Number(payload.targetCssWidth || 0),
      targetCssHeight: Number(payload.targetCssHeight || 0),
      coordinateSpace: String(payload.coordinateSpace || ""),
      ocrMode: String(payload.ocrMode || "single"),
      sourceToken: String(payload.sourceToken || ""),
      fallbackReason: String(payload.fallbackReason || ""),
      stitchAdmission: String(payload.stitchAdmission || ""),
      stitchRejectionReason: String(payload.stitchRejectionReason || ""),
      stitch: payload.stitch || null
    };
  }

  function logOcrDebugMapping(overlayState, result) {
    const debug = result && result.debug;
    if (!debug || !Array.isArray(debug.items) || debug.items.length === 0) {
      return;
    }

    const rect = getOverlayDisplayRect(overlayState);
    const targetRect = overlayState.target.getBoundingClientRect();
    const imageMeta = debug.imageMeta || {};
    const rows = debug.items.map((item, index) => {
      const percent = item.percent || {};
      const raw = item.box || {};
      const cssLeft = rect.left + (Number(percent.x || 0) / 100) * rect.width;
      const cssTop = rect.top + (Number(percent.y || 0) / 100) * rect.height;
      const cssWidth = (Number(percent.w || 0) / 100) * rect.width;
      const cssHeight = (Number(percent.h || 0) / 100) * rect.height;
      return {
        index,
        text: item.text || "",
        confidence: item.confidence || 0,
        rawLeft: raw.left,
        rawTop: raw.top,
        rawWidth: raw.width,
        rawHeight: raw.height,
        rawWithCropLeft: Number(raw.left || 0) + Number(imageMeta.cropX || 0),
        rawWithCropTop: Number(raw.top || 0) + Number(imageMeta.cropY || 0),
        cssLeft: Math.round(cssLeft),
        cssTop: Math.round(cssTop),
        cssWidth: Math.round(cssWidth),
        cssHeight: Math.round(cssHeight),
        targetRelativeLeft: Math.round(cssLeft - targetRect.left),
        targetRelativeTop: Math.round(cssTop - targetRect.top)
      };
    });

    console.info("[MangaTranslator][OCR debug]", {
      imageMeta,
      localOcrDebug: debug.localOcr || {},
      overlayRect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
    console.table(rows);
  }

  function normalizeResult(result) {
    const bubbles = result && Array.isArray(result.bubbles) ? result.bubbles : [];

    return {
      bubbles: bubbles
        .map((bubble) => {
          return {
            x: clamp(Number(bubble.x), 0, 100),
            y: bubble.stitch_overflow === true ? Number(bubble.y) : clamp(Number(bubble.y), 0, 100),
            w: clamp(Number(bubble.w), 0, 100),
            h: clamp(Number(bubble.h), 0, 100),
            fill_box: normalizeFillBox(bubble.fill_box, bubble.stitch_overflow === true),
            cleaned_source_box: normalizeFillBox(bubble.cleaned_source_box),
            bg_type: normalizeBgType(bubble.bg_type),
            bg_color: String(bubble.bg_color || ""),
            bg_confidence: Number(bubble.bg_confidence || 0),
            region_id: String(bubble.region_id || ""),
            region_type: String(bubble.region_type || "plain_text"),
            region_polygon: normalizeRegionPolygon(bubble.region_polygon, bubble.stitch_overflow === true),
            text_color: normalizeCssColor(bubble.text_color, ""),
            stroke_color: normalizeCssColor(bubble.stroke_color, ""),
            polygon: normalizeBubblePolygon(bubble.polygon, bubble.stitch_overflow === true),
            rotation_deg: normalizeBubbleRotation(bubble.rotation_deg),
            source_line_count: Math.max(1, Math.round(Number(bubble.source_line_count) || 1)),
            block_id: String(bubble.block_id || bubble.id || ""),
            stitch_overflow: bubble.stitch_overflow === true,
            original_text: cleanRenderableText(bubble.original_text || ""),
            translated_text: cleanRenderableText(bubble.translated_text || "")
          };
        })
        .filter((bubble) => bubble.w > 0 && bubble.h > 0)
        .filter((bubble) => bubble.original_text || bubble.translated_text),
      debug: result && result.debug && typeof result.debug === "object" ? result.debug : null
    };
  }

  function normalizeFillBox(value, allowVerticalOverflow = false) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const rawX = Number(value.x);
    const rawY = Number(value.y);
    const rawW = Number(value.w);
    const rawH = Number(value.h);
    if (![rawX, rawY, rawW, rawH].every(Number.isFinite) || rawW <= 0 || rawH <= 0) {
      return null;
    }
    const box = {
      x: clamp(rawX, 0, 100),
      y: allowVerticalOverflow ? rawY : clamp(rawY, 0, 100),
      w: clamp(rawW, 0, 100),
      h: clamp(rawH, 0, 100)
    };
    return box.w > 0 && box.h > 0 ? box : null;
  }

  function buildSolidBackgroundBox(textBox, fillBoxValue, allowVerticalOverflow = false) {
    const text = normalizeFillBox(textBox, allowVerticalOverflow);
    const fill = normalizeFillBox(fillBoxValue, allowVerticalOverflow);
    if (!text) {
      return fill;
    }
    if (!fill) {
      return text;
    }
    const left = Math.min(text.x, fill.x);
    const top = Math.min(text.y, fill.y);
    const right = Math.max(text.x + text.w, fill.x + fill.w);
    const bottom = Math.max(text.y + text.h, fill.y + fill.h);
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    };
  }

  function getCleanedPatchStyle(sourceBox) {
    const box = normalizeFillBox(sourceBox) || { x: 0, y: 0, w: 100, h: 100 };
    const positionX = box.w < 100 ? (box.x / (100 - box.w)) * 100 : 0;
    const positionY = box.h < 100 ? (box.y / (100 - box.h)) * 100 : 0;
    return {
      sizeX: `${10000 / box.w}%`,
      sizeY: `${10000 / box.h}%`,
      positionX: `${positionX}%`,
      positionY: `${positionY}%`
    };
  }

  function normalizeBubblePolygon(value, allowOverflow) {
    if (!Array.isArray(value) || value.length < 4) {
      return null;
    }
    const points = value.slice(0, 4).map((point) => {
      const x = clamp(Number(point && point.x), 0, 100);
      const rawY = Number(point && point.y);
      const y = allowOverflow ? rawY : clamp(rawY, 0, 100);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    });
    return points.every(Boolean) ? points : null;
  }

  function normalizeRegionPolygon(value, allowOverflow) {
    if (!Array.isArray(value) || value.length < 3) {
      return null;
    }
    const points = value.map((point) => {
      const x = clamp(Number(point && point.x), 0, 100);
      const rawY = Number(point && point.y);
      const y = allowOverflow ? rawY : clamp(rawY, 0, 100);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    });
    return points.every(Boolean) ? points : null;
  }

  function getBubbleRenderColors(bubble, bgType) {
    return {
      textColor: normalizeCssColor(bubble && bubble.text_color, bgType === "none" ? "#000000" : "#111827"),
      strokeColor: normalizeCssColor(bubble && bubble.stroke_color, "#ffffff")
    };
  }

  function normalizeCssColor(value, fallback) {
    const text = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  }

  function normalizeBubbleRotation(value) {
    let angle = Number(value) || 0;
    while (angle >= 90) angle -= 180;
    while (angle < -90) angle += 180;
    return angle;
  }

  function cleanRenderableText(text) {
    return String(text || "")
      .replace(MODEL_IMAGE_PLACEHOLDER_BRACKET_RE, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(MODEL_IMAGE_PLACEHOLDER_ONLY_RE, "");
  }

  function normalizeBgType(value) {
    const text = String(value || "").toLowerCase();
    if (text === "solid" || text === "transparent" || text === "none") {
      return text;
    }

    return "solid";
  }

  function rememberLocalResult(targetKey, result) {
    state.localResultCache.set(targetKey, result);

    if (state.localResultCache.size <= MAX_LOCAL_RESULT_CACHE) {
      return;
    }

    const firstKey = state.localResultCache.keys().next().value;
    if (firstKey) {
      state.localResultCache.delete(firstKey);
    }
  }

  function rememberEmbeddedImageCache(targetKey, dataUrl) {
    state.embeddedImageCache.set(targetKey, dataUrl);

    if (state.embeddedImageCache.size <= MAX_EMBEDDED_IMAGE_CACHE) {
      return;
    }

    const firstKey = state.embeddedImageCache.keys().next().value;
    if (firstKey) {
      state.embeddedImageCache.delete(firstKey);
    }
  }

  function getPayloadCache(targetKey) {
    const entry = state.payloadCacheByTargetKey.get(targetKey);
    if (!entry || typeof entry !== "object") {
      return null;
    }

    if (Date.now() - Number(entry.timestamp || 0) > PAYLOAD_CACHE_TTL_MS) {
      state.payloadCacheByTargetKey.delete(targetKey);
      return null;
    }

    return entry.payload || null;
  }

  function rememberPayloadCache(targetKey, payload) {
    state.payloadCacheByTargetKey.set(targetKey, {
      timestamp: Date.now(),
      payload
    });

    if (state.payloadCacheByTargetKey.size <= MAX_PAYLOAD_CACHE) {
      return;
    }

    const firstKey = state.payloadCacheByTargetKey.keys().next().value;
    if (firstKey) {
      state.payloadCacheByTargetKey.delete(firstKey);
    }
  }

  async function loadLocalSettings() {
    try {
      const result = await storageGet([
        "mt_enabled",
        "mt_show_ball",
        "mt_aggressive_preload",
        "mt_capture_mode",
        "mt_render_mode",
        "mt_pretranslate_mode"
      ]);
      state.enabled = result.mt_enabled !== false;
      state.showFloatingBall = result.mt_show_ball !== false;
      state.captureMode = normalizeCaptureMode(result.mt_capture_mode);
      state.renderMode = normalizeRenderMode(result.mt_render_mode);
      state.pretranslateMode = normalizePretranslateMode(result.mt_pretranslate_mode);
      // 自动翻译是否开启属于当前页面会话，不能由全局设置激活其他标签页。
      state.autoTranslatePageEnabled = false;
      if (typeof result.mt_aggressive_preload === "boolean") {
        state.aggressivePreload = result.mt_aggressive_preload;
      } else {
        state.aggressivePreload = IS_CMOA_SPEED_READER;
      }
    } catch {
      state.enabled = true;
      state.showFloatingBall = true;
      state.captureMode = CAPTURE_MODE_DIRECT;
      state.renderMode = RENDER_MODE_OVERLAY;
      state.pretranslateMode = "manual";
      state.autoTranslatePageEnabled = false;
      state.aggressivePreload = IS_CMOA_SPEED_READER;
    }
  }

  function normalizeRenderMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === RENDER_MODE_EMBEDDED ? RENDER_MODE_EMBEDDED : RENDER_MODE_OVERLAY;
  }

  function normalizePretranslateMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "ahead" || mode === "continuous") {
      return mode;
    }
    return "manual";
  }

  function isAutomaticPretranslateMode(value) {
    const mode = normalizePretranslateMode(value);
    return mode === "ahead" || mode === "continuous";
  }

  function normalizeCaptureMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === CAPTURE_MODE_SCREENSHOT ? CAPTURE_MODE_SCREENSHOT : CAPTURE_MODE_DIRECT;
  }

  function isScreenshotCaptureMode() {
    return state.captureMode === CAPTURE_MODE_SCREENSHOT;
  }

  function isScreenshotTargetNotVisibleError(reason) {
    return String(reason || "") === SCREENSHOT_TARGET_NOT_VISIBLE;
  }

  async function reportStatus(level, message, details) {
    if (state.invalidated) {
      return;
    }

    const safeLevel = level === "error" ? "error" : "info";
    if (safeLevel === "info") {
      const now = Date.now();
      if (now - state.lastInfoStatusAt < STATUS_INFO_THROTTLE_MS) {
        return;
      }
      state.lastInfoStatusAt = now;
    }

    try {
      await sendRuntimeMessage({
        type: "REPORT_STATUS",
        level: safeLevel,
        message: String(message || ""),
        details: details && typeof details === "object" ? details : {},
        pageUrl: location.href
      });
    } catch {
      // Ignore status reporting errors.
    }
  }

  function sendRuntimeMessage(message) {
    if (state.invalidated) {
      return Promise.reject(new Error("Extension context invalidated"));
    }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const reason = chrome.runtime.lastError.message || "runtime message failed";
          if (CONTEXT_INVALIDATED_RE.test(reason)) {
            markInvalidated(reason);
          }
          reject(new Error(reason));
          return;
        }

        resolve(response || null);
      });
    });
  }

  function markInvalidated(reason) {
    if (state.invalidated) {
      return;
    }

    state.invalidated = true;
    api.invalidated = true;

    try {
      if (state.io) {
        state.io.disconnect();
      }
    } catch {
      // Ignore.
    }

    try {
      if (state.preloadIo) {
        state.preloadIo.disconnect();
      }
    } catch {
      // Ignore.
    }

    try {
      if (state.mo) {
        state.mo.disconnect();
      }
    } catch {
      // Ignore.
    }

    clearAllOverlays();
    clearAutoTranslateRetryTimers();
    if (state.kakaoProjectionRefreshTimer) {
      window.clearTimeout(state.kakaoProjectionRefreshTimer);
      state.kakaoProjectionRefreshTimer = 0;
    }
    state.kakaoProjectionRefreshPageIds.clear();
    state.kakaoStore.reset();
    state.queue.length = 0;
    state.preloadQueue.length = 0;
    state.payloadCacheByTargetKey.clear();
    state.lastRecoveryAt = 0;
    state.lastAggressivePreloadSweepAt = 0;

    if (state.aggressiveSweepTimer) {
      try {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(state.aggressiveSweepTimer);
        } else {
          window.clearTimeout(state.aggressiveSweepTimer);
        }
      } catch {
        // Ignore timer cleanup failure.
      }
      state.aggressiveSweepTimer = 0;
    }

    if (state.syncInterval) {
      window.clearInterval(state.syncInterval);
      state.syncInterval = 0;
    }

    updateFloatingBallState();
    console.info("[MangaTranslator] context invalidated, waiting for reinjection:", reason);
  }

  function destroy() {
    markInvalidated("destroy called");
    if (state.overlayLayer && state.overlayLayer.isConnected) {
      state.overlayLayer.remove();
    }
    if (state.floatingBallWrap && state.floatingBallWrap.isConnected) {
      state.floatingBallWrap.remove();
    }
  }

  function claimRuntimeOwnership() {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    const previousOwner = root.getAttribute(RUNTIME_OWNER_ATTRIBUTE);
    const staleUiExists = !!document.querySelector(".mt-overlay-layer, .mt-floating-ball-wrap, .mt-measure-probe");
    root.setAttribute(RUNTIME_OWNER_ATTRIBUTE, state.runtimeOwnerToken);
    root.setAttribute(RUNTIME_FEATURE_ATTRIBUTE, RUNTIME_FEATURE_VERSION);
    document
      .querySelectorAll(".mt-overlay-layer, .mt-floating-ball-wrap, .mt-measure-probe")
      .forEach((node) => node.remove());
    if ((previousOwner && previousOwner !== state.runtimeOwnerToken) || staleUiExists) {
      document.querySelectorAll(TARGET_SELECTOR).forEach((target) => {
        delete target.dataset.mtLastTranslatedKey;
        delete target.dataset.mtNoTextKey;
      });
    }
  }

  function isCurrentRuntimeOwner() {
    const root = document.documentElement;
    return !root || root.getAttribute(RUNTIME_OWNER_ATTRIBUTE) === state.runtimeOwnerToken;
  }

  function getTargetId(target) {
    let id = state.targetIdByElement.get(target);
    if (id) {
      return id;
    }

    id = String(state.targetIdSeq);
    state.targetIdSeq += 1;
    state.targetIdByElement.set(target, id);
    return id;
  }

  function isSupportedTarget(target) {
    return target instanceof HTMLImageElement || target instanceof HTMLCanvasElement || isBackgroundImageTarget(target);
  }

  function isRectVisible(rect) {
    return getVisibleArea(rect) >= 4;
  }

  function getVisibleArea(rect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  async function fetchPageImageDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Background image fetch failed: ${response.status}`);
    }

    const blob = await response.blob();
    if (!blob || blob.size <= 0) {
      throw new Error("Background image fetch returned empty data");
    }

    return blobToDataUrl(blob);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Blob data URL conversion failed"));
      reader.readAsDataURL(blob);
    });
  }

  function getOverlayDisplayRect(overlayState) {
    const target = overlayState.target;
    const rect = target.getBoundingClientRect();
    if (overlayState.displayRect) {
      return computeTargetSubRect(rect, overlayState.displayRect);
    }

    // 对于 <img> 元素，校验 CSS rect 宽高比是否与图片原始宽高比一致。
    // 偏差超过 1% 时，按原始比例调整 overlay rect，使百分比坐标与图片内容对齐。
    if (target instanceof HTMLImageElement && target.complete) {
      const natW = target.naturalWidth || 0;
      const natH = target.naturalHeight || 0;
      if (natW > 0 && natH > 0 && rect.width > 0 && rect.height > 0) {
        const cssRatio = rect.width / rect.height;
        const natRatio = natW / natH;
        const ratioDiff = Math.abs(cssRatio - natRatio) / Math.max(cssRatio, natRatio);
        if (ratioDiff > 0.01) {
          // 按图片原始比例调整：保持高度不变，调整宽度；或保持宽度不变调整高度
          const adjustedByWidth = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.width / natRatio,
            right: rect.left + rect.width,
            bottom: rect.top + rect.width / natRatio
          };
          const adjustedByHeight = {
            left: rect.left,
            top: rect.top,
            width: rect.height * natRatio,
            height: rect.height,
            right: rect.left + rect.height * natRatio,
            bottom: rect.top + rect.height
          };
          // 选择变更较小（面积变化较小）的调整方案
          const diffW = Math.abs(adjustedByWidth.height - rect.height) / rect.height;
          const diffH = Math.abs(adjustedByHeight.width - rect.width) / rect.width;
          return diffW <= diffH ? adjustedByWidth : adjustedByHeight;
        }
      }
    }

    if (!isBackgroundImageTarget(target) || !overlayState.imageMeta) {
      return rect;
    }

    return computeBackgroundImageRect(target, rect, overlayState.imageMeta);
  }

  function computeTargetSubRect(rect, displayRect) {
    const offsetX = Number(displayRect && displayRect.offsetX);
    const offsetY = Number(displayRect && displayRect.offsetY);
    const width = Number(displayRect && displayRect.width);
    const height = Number(displayRect && displayRect.height);
    if (!(Number.isFinite(offsetX) && Number.isFinite(offsetY) && width > 0 && height > 0)) {
      return rect;
    }

    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.left + offsetX + width,
      bottom: rect.top + offsetY + height,
      width,
      height
    };
  }

  function computeBackgroundImageRect(target, rect, imageMeta) {
    const imageWidth = Number(imageMeta && imageMeta.width);
    const imageHeight = Number(imageMeta && imageMeta.height);
    if (!(imageWidth > 0 && imageHeight > 0 && rect.width > 0 && rect.height > 0)) {
      return rect;
    }

    const style = getComputedStyle(target);
    const size = String(style.backgroundSize || "auto").trim().toLowerCase();
    if (size !== "contain") {
      return rect;
    }

    const imageRatio = imageWidth / imageHeight;
    const boxRatio = rect.width / rect.height;
    let width = rect.width;
    let height = rect.height;
    if (boxRatio > imageRatio) {
      height = rect.height;
      width = height * imageRatio;
    } else {
      width = rect.width;
      height = width / imageRatio;
    }

    const offsetX = (rect.width - width) * parseBackgroundPositionRatio(style.backgroundPositionX);
    const offsetY = (rect.height - height) * parseBackgroundPositionRatio(style.backgroundPositionY);

    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.left + offsetX + width,
      bottom: rect.top + offsetY + height,
      width,
      height
    };
  }

  function parseBackgroundPositionRatio(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "left" || text === "top") {
      return 0;
    }
    if (text === "right" || text === "bottom") {
      return 1;
    }
    if (text === "center") {
      return 0.5;
    }

    const percent = text.match(/(-?\d+(?:\.\d+)?)%/);
    if (percent) {
      return clamp(Number(percent[1]) / 100, 0, 1);
    }

    const pixel = text.match(/(-?\d+(?:\.\d+)?)px/);
    if (pixel) {
      return Number(pixel[1]) > 0 ? 1 : 0;
    }

    return 0.5;
  }

  function clamp(value, min, max) {
    const num = Number(value);
    const safe = Number.isFinite(num) ? num : min;
    return Math.min(max, Math.max(min, safe));
  }

  function isDataUrl(value) {
    return /^data:[^;]+;base64,/i.test(String(value || ""));
  }

  function isBlobUrl(value) {
    return /^blob:/i.test(String(value || "").trim());
  }

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || "").trim());
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
  }

  function getErrorMessage(error) {
    if (!error) {
      return "Unknown error";
    }

    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }

    return String(error);
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result || {});
        }
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
})();
