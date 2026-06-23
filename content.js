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
  const MAX_PARALLEL_TRANSLATIONS = 3;
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
  const KAKAO_STITCH_MAX_CONTEXT_PX = 300;
  const KAKAO_STITCH_MIN_CONTEXT_PX = 96;
  const KAKAO_STITCH_CONTEXT_CSS_PX = 180;
  const KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX = 32;
  const KAKAO_STITCH_MIN_WIDTH_RATIO = 0.82;
  const PRETRANSLATE_AHEAD_COUNT = 6;
  const RUNTIME_OWNER_ATTRIBUTE = "data-manga-translator-runtime-owner";
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
    recentFallbackRequestKeys: new Map(),
    kakaoGlobalOcrEntries: new Map(),
    lastRecoveryAt: 0,
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
    lastInfoStatusAt: 0,
    runtimeOwnerToken: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  };

  const api = {
    invalidated: false,
    rescan,
    manualTranslateVisible,
    togglePageAutoTranslate,
    getPageAutoTranslateStatus,
    __test: {
      mapKakaoStitchedResult,
      dedupeKakaoResultByPageCoordinates,
      buildKakaoStitchWindowPlan,
      isVerifiedKakaoStitchNeighbor,
      shouldFallbackFromKakaoStitch,
      shouldRejectKakaoPageEdgeStitch,
      buildOcrRequestKey,
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
      getOverlayVisibilityRect,
      syncOverlayPosition,
      passesKakaopageTargetGeometry,
      hasUsableKakaoStripCaptureRect,
      selectPendingAheadCandidates,
      selectPendingContinuousCandidates,
      isAutomaticPretranslateMode,
      shouldSchedulePagePretranslation
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
      rootMargin: "280px 0px",
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

    if (target instanceof HTMLImageElement && !target.complete) {
      target.addEventListener(
        "load",
        () => {
          registerTarget(target);
        },
        { once: true }
      );
    }

    const sourceToken = getQuickSourceToken(target);
    const oldSourceToken = target.dataset.mtSourceToken || "";
    if (oldSourceToken && oldSourceToken !== sourceToken) {
      const oldTranslatedKey = target.dataset.mtLastTranslatedKey || "";
      if (oldTranslatedKey) {
        state.payloadCacheByTargetKey.delete(oldTranslatedKey);
        state.localResultCache.delete(oldTranslatedKey);
      }
      clearRenderedTarget(target);
      target.dataset.mtLastTranslatedKey = "";
      target.dataset.mtNoTextKey = "";
      target.dataset.mtRecoveryReqAt = "";
    }
    target.dataset.mtSourceToken = sourceToken;

    if (!state.observedTargets.has(target)) {
      state.io.observe(target);
      if (state.preloadIo) {
        state.preloadIo.observe(target);
      }
      state.observedTargets.add(target);
    }
    if (IS_KAKAOPAGE_READER && target instanceof HTMLImageElement && target.complete && sourceToken) {
      refreshPreviousKakaoBoundary(target, sourceToken);
    }
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
    const previous = ordered[index - 1];
    if (!isVerifiedKakaoStitchNeighbor(
      describeKakaoStitchTarget(target),
      describeKakaoStitchTarget(previous),
      "previous"
    )) {
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
      return target.dataset.mtLastTranslatedKey !== targetKey && target.dataset.mtNoTextKey !== targetKey;
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
        if (rect.width < 80 || rect.height < 80) {
      return false;
    }
    if (target instanceof HTMLImageElement) {
      const naturalWidth = Number(target.naturalWidth || 0);
      const naturalHeight = Number(target.naturalHeight || 0);
      if (naturalWidth > 0 && naturalHeight > 0 && (naturalHeight < 80 || naturalHeight / naturalWidth < 0.10)) {
        return false;
      }
    }
    return true;
  }

  function queueTranslate(target, options) {
    if (!isSupportedTarget(target) || !target.isConnected || state.invalidated) {
      return;
    }

    if (!options.manual) {
      return;
    }

    if (state.queuedTargets.has(target) || state.inflightByTarget.has(target)) {
      return;
    }

    state.queue.push({ target, options });
    state.queuedTargets.add(target);
    pumpQueue();
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
      return { ok: false, skipped: true, reason: "filtered as non-manga target" };
    }

    if (state.inflightByTarget.has(target)) {
      return state.inflightByTarget.get(target);
    }

    const task = (async () => {
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

        // Stale result defense: capture snapshot before translation
        const preTranslateSnapshot = captureTargetSnapshot(target);
        renderLoadingOverlay(target, targetKey, "OCR + 翻译中...");
        const payload = await extractTargetPayload(target, scopedTargetKey);
        updateLoadingOverlayText(target, targetKey, "模型翻译中...");
        let renderPayload = payload;
        let response = null;
        try {
          response = await requestTranslationForPayload(payload, buildOcrRequestKey(targetKey, payload));
        } catch (error) {
          if (!payload.stitch || !payload.singleImagePayload) {
            throw error;
          }
          console.warn("[MangaTranslator][KakaoPage] 拼接 OCR 抛出异常，回退当前单图", {
            targetKey: targetKey.slice(0, 80),
            error: getErrorMessage(error)
          });
          renderPayload = buildSingleFallbackPayload(payload.singleImagePayload, payload, "stitched request threw");
          if (shouldSkipRepeatedFallbackRequest(targetKey, renderPayload)) {
            return { ok: false, skipped: true, reason: "duplicate single-fallback request" };
          }
          response = await requestTranslationForPayload(renderPayload, buildOcrRequestKey(targetKey, renderPayload));
        }

        if ((!response || !response.ok) && renderPayload === payload && payload.stitch && payload.singleImagePayload) {
          console.warn("[MangaTranslator][KakaoPage] 拼接 OCR 请求失败，回退当前单图", {
            targetKey: targetKey.slice(0, 80),
            error: response && response.error ? response.error : "unknown stitched request failure"
          });
          renderPayload = buildSingleFallbackPayload(
            payload.singleImagePayload,
            payload,
            response && response.error ? response.error : "stitched request failed"
          );
          if (shouldSkipRepeatedFallbackRequest(targetKey, renderPayload)) {
            return { ok: false, skipped: true, reason: "duplicate single-fallback request" };
          }
          response = await requestTranslationForPayload(renderPayload, buildOcrRequestKey(targetKey, renderPayload));
        }

        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "Translate request failed");
        }

        let result = normalizeResult(mapKakaoStitchedResult(response.result, renderPayload, target, targetKey));
        const fallbackReason = renderPayload === payload
          ? shouldFallbackFromKakaoStitch(payload, response.result, result)
          : "";
        if (fallbackReason && payload.singleImagePayload) {
          console.warn("[MangaTranslator][KakaoPage] 拼接 OCR 结果异常，回退当前单图", {
            targetKey: targetKey.slice(0, 80),
            reason: fallbackReason
          });
          renderPayload = buildSingleFallbackPayload(payload.singleImagePayload, payload, fallbackReason);
          if (shouldSkipRepeatedFallbackRequest(targetKey, renderPayload)) {
            return { ok: false, skipped: true, reason: "duplicate single-fallback request" };
          }
          response = await requestTranslationForPayload(renderPayload, buildOcrRequestKey(targetKey, renderPayload));
          if (!response || !response.ok) {
            throw new Error(response && response.error ? response.error : "Single-image OCR fallback failed");
          }
          result = normalizeResult(response.result);
        }
        result = await dedupeKakaoResultByPageCoordinates(result, target, targetKey);

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
        state.inflightByTarget.delete(target);
      }
    })();

    state.inflightByTarget.set(target, task);
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
      if (state.localResultCache.has(targetKey) || getPayloadCache(targetKey)) {
        return;
      }

      await extractTargetPayload(target, targetKey);
    })().finally(() => {
      state.preloadInFlightByTarget.delete(target);
    });

    state.preloadInFlightByTarget.set(target, task);
    return task;
  }

  async function extractTargetPayload(target, targetKey) {
    const cacheKey = String(targetKey || computeTargetKey(target));
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

    payload = await normalizeKakaopagePayload(target, payload);
    payload = enrichPayloadForTarget(payload, target);
    if (shouldUseKakaoStitchedOcr(target, payload)) {
      payload = await buildKakaoStitchedPayload(target, payload);
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

  function shouldUseKakaoStitchedOcr(target, payload) {
    return (
      IS_KAKAOPAGE_READER &&
      state.captureMode === CAPTURE_MODE_DIRECT &&
      state.renderMode === RENDER_MODE_OVERLAY &&
      target instanceof HTMLImageElement &&
      payload &&
      isDataUrl(payload.dataUrl)
    );
  }

  async function buildKakaoStitchedPayload(target, ownerPayload) {
    const singlePayload = markSingleKakaoPayload(ownerPayload, target, "");
    const ordered = collectKakaopageManualTargetCandidates(true, target).filter(
      (candidate) => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete
    );
    const ownerIndex = ordered.indexOf(target);
    if (ownerIndex < 0) {
      return markSingleKakaoPayload(ownerPayload, target, "owner not found");
    }

    const ownerDescriptor = describeKakaoStitchTarget(target);
    const previousCandidate = ownerIndex > 0 ? ordered[ownerIndex - 1] : null;
    const nextCandidate = ownerIndex + 1 < ordered.length ? ordered[ownerIndex + 1] : null;
    const previousTarget = isVerifiedKakaoStitchNeighbor(
      ownerDescriptor,
      describeKakaoStitchTarget(previousCandidate),
      "previous"
    ) ? previousCandidate : null;
    const nextTarget = isVerifiedKakaoStitchNeighbor(
      ownerDescriptor,
      describeKakaoStitchTarget(nextCandidate),
      "next"
    ) ? nextCandidate : null;
    if (!previousTarget && !nextTarget) {
      return markSingleKakaoPayload(ownerPayload, target, "no verified neighbor");
    }
    const previousPayload = previousTarget ? await extractAdjacentKakaoPayload(previousTarget) : null;
    const nextPayload = nextTarget ? await extractAdjacentKakaoPayload(nextTarget) : null;
    const payloads = [previousPayload, ownerPayload, nextPayload].filter(Boolean);
    const decoded = await Promise.all(payloads.map((payload) => loadImageFromDataUrl(payload.dataUrl)));
    let decodedIndex = 0;
    const previousImage = previousPayload ? decoded[decodedIndex++] : null;
    const ownerImage = decoded[decodedIndex++];
    const nextImage = nextPayload ? decoded[decodedIndex] : null;
    const canonicalWidth = Math.max(
      1,
      Math.min(IMAGE_MAX_SIDE, Number(ownerPayload.width) || ownerImage.naturalWidth || ownerImage.width)
    );
    const scaledHeight = (image) =>
      Math.max(1, Math.round(((image.naturalHeight || image.height) / Math.max(1, image.naturalWidth || image.width)) * canonicalWidth));
    const ownerHeight = scaledHeight(ownerImage);
    const previousHeight = previousImage ? scaledHeight(previousImage) : 0;
    const nextHeight = nextImage ? scaledHeight(nextImage) : 0;
    const rejection = shouldRejectKakaoPageEdgeStitch({
      owner: ownerDescriptor,
      ownerHeight,
      canonicalWidth,
      previous: previousTarget ? describeKakaoStitchTarget(previousTarget) : null,
      next: nextTarget ? describeKakaoStitchTarget(nextTarget) : null,
      previousHeight,
      nextHeight
    });
    if (rejection) {
      return markSingleKakaoPayload(singlePayload, target, rejection);
    }
    const plan = buildKakaoStitchWindowPlan({
      owner: ownerDescriptor,
      previous: previousTarget ? describeKakaoStitchTarget(previousTarget) : null,
      next: nextTarget ? describeKakaoStitchTarget(nextTarget) : null,
      canonicalWidth,
      ownerHeight,
      previousHeight,
      nextHeight
    });
    const previousSlice = previousImage ? plan.previousSlice : 0;
    const nextSlice = nextImage ? plan.nextSlice : 0;
    if (previousSlice <= 0 && nextSlice <= 0) {
      return markSingleKakaoPayload(ownerPayload, target, "empty stitch slices");
    }
    const compositeWidth = canonicalWidth;
    const compositeHeight = previousSlice + ownerHeight + nextSlice;

    const ownerEntry = {
      source: "owner",
      targetKey: computeTargetKey(target),
      src: getQuickSourceToken(target),
      drawRect: { x: 0, y: previousSlice, w: canonicalWidth, h: ownerHeight },
      sourceCrop: { x: 0, y: 0, w: ownerImage.naturalWidth || ownerImage.width, h: ownerImage.naturalHeight || ownerImage.height },
      naturalWidth: ownerImage.naturalWidth || ownerImage.width,
      naturalHeight: ownerImage.naturalHeight || ownerImage.height
    };

    let previousEntry = null;
    if (previousTarget && previousImage && previousSlice > 0) {
      const prevNatW = previousImage.naturalWidth || previousImage.width;
      const prevNatH = previousImage.naturalHeight || previousImage.height;
      const sourceCropHeight = prevNatH * (previousSlice / Math.max(1, previousHeight));
      previousEntry = {
        source: "previous",
        targetKey: computeTargetKey(previousTarget),
        src: getQuickSourceToken(previousTarget),
        drawRect: { x: 0, y: 0, w: canonicalWidth, h: previousSlice },
        sourceCrop: { x: 0, y: prevNatH - sourceCropHeight, w: prevNatW, h: sourceCropHeight },
        naturalWidth: prevNatW,
        naturalHeight: prevNatH
      };
    }

    let nextEntry = null;
    if (nextTarget && nextImage && nextSlice > 0) {
      const nextNatW = nextImage.naturalWidth || nextImage.width;
      const nextNatH = nextImage.naturalHeight || nextImage.height;
      const sourceCropHeight = nextNatH * (nextSlice / Math.max(1, nextHeight));
      nextEntry = {
        source: "next",
        targetKey: computeTargetKey(nextTarget),
        src: getQuickSourceToken(nextTarget),
        drawRect: { x: 0, y: previousSlice + ownerHeight, w: canonicalWidth, h: nextSlice },
        sourceCrop: { x: 0, y: 0, w: nextNatW, h: sourceCropHeight },
        naturalWidth: nextNatW,
        naturalHeight: nextNatH
      };
    }
    const segments = [previousEntry, ownerEntry, nextEntry].filter(Boolean);

    const canvas = document.createElement("canvas");
    canvas.width = canonicalWidth;
    canvas.height = compositeHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      return ownerPayload;
    }

    if (previousImage && previousSlice > 0) {
      const naturalHeight = previousImage.naturalHeight || previousImage.height;
      const naturalWidth = previousImage.naturalWidth || previousImage.width;
      const sourceHeight = naturalHeight * (previousSlice / previousHeight);
      context.drawImage(previousImage, 0, naturalHeight - sourceHeight, naturalWidth, sourceHeight, 0, 0, canonicalWidth, previousSlice);
    }
    context.drawImage(ownerImage, 0, 0, canonicalWidth, ownerHeight, 0, previousSlice, canonicalWidth, ownerHeight);
    if (nextImage && nextSlice > 0) {
      const naturalHeight = nextImage.naturalHeight || nextImage.height;
      const naturalWidth = nextImage.naturalWidth || nextImage.width;
      const sourceHeight = naturalHeight * (nextSlice / nextHeight);
      context.drawImage(nextImage, 0, 0, naturalWidth, sourceHeight, 0, previousSlice + ownerHeight, canonicalWidth, nextSlice);
    }

    const sourceKeys = [previousTarget, target, nextTarget].map((item) => (item ? getQuickSourceToken(item) : "edge"));
    return {
      ...ownerPayload,
      ocrMode: "stitch",
      stitchAdmission: "accepted",
      sourceToken: getQuickSourceToken(target),
      dataUrl: canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY),
      imageUrl: `kakao-stitch:${sourceKeys.join("|")}`,
      width: canonicalWidth,
      height: compositeHeight,
      stitchKey: `${computeTargetKey(target)}|stitch:${previousSlice}:${nextSlice}|${sourceKeys.join("|")}`,
      singleImagePayload: ownerPayload,
      stitch: {
        canvasWidth: canonicalWidth,
        canvasHeight: compositeHeight,
        sourceKeys,
        verified: true,
        ocrMode: "stitch",
        owner: ownerEntry,
        previous: previousEntry,
        next: nextEntry,
        segments
      }
    };
  }

  function markSingleKakaoPayload(payload, target, rejectionReason) {
    const reason = String(rejectionReason || "").trim();
    return {
      ...payload,
      ocrMode: "single",
      sourceToken: getQuickSourceToken(target),
      ...(reason ? { stitchAdmission: "rejected", stitchRejectionReason: reason } : {})
    };
  }

  function buildSingleFallbackPayload(singlePayload, stitchedPayload, fallbackReason) {
    const reason = String(fallbackReason || "stitched result rejected").trim();
    return {
      ...singlePayload,
      ocrMode: "single-fallback",
      sourceToken: String(stitchedPayload && stitchedPayload.sourceToken || singlePayload && singlePayload.sourceToken || ""),
      fallbackReason: reason,
      stitchAdmission: "fallback"
    };
  }

  function buildOcrRequestKey(targetKey, payload) {
    const mode = String(payload && payload.ocrMode || "single");
    const sourceToken = String(payload && payload.sourceToken || "");
    const reason = String(payload && (payload.fallbackReason || payload.stitchRejectionReason) || "");
    const stitchKey = String(payload && payload.stitchKey || "");
    return [
      String(targetKey || ""),
      `src:${hashSourceIdentity(sourceToken)}`,
      `mode:${mode}`,
      reason ? `reason:${hashSourceIdentity(reason)}` : "",
      stitchKey ? `stitch:${hashSourceIdentity(stitchKey)}` : ""
    ].filter(Boolean).join("|");
  }

  function shouldSkipRepeatedFallbackRequest(targetKey, payload) {
    if (!payload || payload.ocrMode !== "single-fallback") {
      return false;
    }
    const key = buildOcrRequestKey(targetKey, payload);
    const now = Date.now();
    const lastAt = Number(state.recentFallbackRequestKeys.get(key) || 0);
    state.recentFallbackRequestKeys.set(key, now);
    pruneRecentFallbackRequestKeys(now);
    return lastAt > 0 && now - lastAt < 2500;
  }

  function pruneRecentFallbackRequestKeys(now = Date.now()) {
    for (const [key, timestamp] of state.recentFallbackRequestKeys.entries()) {
      if (now - Number(timestamp || 0) > 10000) {
        state.recentFallbackRequestKeys.delete(key);
      }
    }
  }

  function shouldRejectKakaoPageEdgeStitch({ owner, ownerHeight, canonicalWidth, previous, next, previousHeight, nextHeight } = {}) {
    if (!owner || !isKakaoPageEdgeSource(owner.sourceKey)) {
      return "";
    }
    const width = Math.max(1, Number(canonicalWidth) || Number(owner.width) || 1);
    const height = Math.max(1, Number(ownerHeight) || 0);
    const isFragment = height < Math.max(760, width * 1.05);
    if (!isFragment) {
      return "";
    }
    const neighborHeights = [
      previous ? Number(previousHeight || 0) : 0,
      next ? Number(nextHeight || 0) : 0
    ].filter((value) => value > 0);
    const hasStableNeighborHeight = neighborHeights.some((neighborHeight) => {
      const ratio = Math.min(height, neighborHeight) / Math.max(height, neighborHeight);
      return ratio >= 0.78;
    });
    return hasStableNeighborHeight
      ? ""
      : "page-edge fragmented image stitch admission rejected";
  }

  function isKakaoPageEdgeSource(source) {
    return /(^|\/\/)page-edge\.kakao\.com\//i.test(String(source || ""));
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

  function isVerifiedKakaoStitchNeighbor(owner, candidate, direction) {
    if (!owner || !candidate || !candidate.sourceKey || candidate.sourceKey === owner.sourceKey) {
      return false;
    }
    // Verify different image sources to catch virtual list element reuse
    const ownerSrc = owner.currentSrc || owner.src || "";
    const candidateSrc = candidate.currentSrc || candidate.src || "";
    if (ownerSrc && candidateSrc && ownerSrc === candidateSrc) {
      return false;
    }
    if (!(candidate.height >= 40)) {
      return false;
    }
    const widthRatio = Math.min(owner.width, candidate.width) / Math.max(owner.width, candidate.width);
    if (widthRatio < KAKAO_STITCH_MIN_WIDTH_RATIO) {
      return false;
    }
    const ownerCenter = owner.left + owner.width / 2;
    const candidateCenter = candidate.left + candidate.width / 2;
    const centerDelta = Math.abs(ownerCenter - candidateCenter);
    if (centerDelta > Math.max(owner.width, candidate.width) * 0.12) {
      return false;
    }

    const scrollY = window.scrollY || 0;
    const ownerVisualTop = owner.top + scrollY;
    const ownerVisualBottom = owner.bottom + scrollY;
    const candidateVisualTop = candidate.top + scrollY;
    const candidateVisualBottom = candidate.bottom + scrollY;

    if (direction === "previous") {
      if (!(candidateVisualTop < ownerVisualTop)) return false;
      if (candidateVisualBottom > ownerVisualTop + 24) return false;
    } else {
      if (!(candidateVisualTop > ownerVisualTop)) return false;
      if (candidateVisualTop < ownerVisualBottom - 24) return false;
    }

    const seamGap = direction === "previous"
      ? ownerVisualTop - candidateVisualBottom
      : candidateVisualTop - ownerVisualBottom;
    if (seamGap < -16) {
      return false;
    }
    return Math.abs(seamGap) <= KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX;
  }

  function buildKakaoStitchWindowPlan({ owner, previous, next, canonicalWidth, ownerHeight, previousHeight, nextHeight }) {
    if (!owner || !(owner.width > 0) || !(ownerHeight > 0) || !(canonicalWidth > 0)) {
      return { previousSlice: 0, nextSlice: 0 };
    }
    const bitmapPerCssPixel = canonicalWidth / owner.width;
    const desiredContext = clamp(
      Math.round(Math.min(KAKAO_STITCH_CONTEXT_CSS_PX, owner.height * 0.2) * bitmapPerCssPixel),
      KAKAO_STITCH_MIN_CONTEXT_PX,
      KAKAO_STITCH_MAX_CONTEXT_PX
    );
    return {
      previousSlice: previous && previousHeight > 0 ? Math.min(desiredContext, previousHeight) : 0,
      nextSlice: next && nextHeight > 0 ? Math.min(desiredContext, nextHeight) : 0
    };
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
    if (bubble && Number.isFinite(Number(bubble.source_line_count)) && Number(bubble.source_line_count) >= 1) {
      return Math.round(Number(bubble.source_line_count));
    }
    if (bubble && Array.isArray(bubble.items) && bubble.items.length > 0) {
      return bubble.items.length;
    }
    const text = String((bubble && (bubble.original_text || bubble.text || "")) || "");
    const lines = String(text).split(/\n+/).filter(Boolean).length;
    return Math.max(1, lines);
  }

  function shouldFallbackFromKakaoStitch(payload, rawResult, mappedResult) {
    if (!payload || !payload.stitch || !payload.singleImagePayload) {
      return "";
    }
    const rawBubbles = rawResult && Array.isArray(rawResult.bubbles) ? rawResult.bubbles : [];
    const mappedBubbles = mappedResult && Array.isArray(mappedResult.bubbles) ? mappedResult.bubbles : [];
    if (rawBubbles.length === 0) {
      return "stitched OCR produced no owner text";
    }
    // Check drop ratio
    if (mappedBubbles.length === 0 && rawBubbles.length > 0) {
      return "stitched OCR dropped all bubbles";
    }
    const dropRatio = rawBubbles.length > 0 ? (rawBubbles.length - mappedBubbles.length) / rawBubbles.length : 0;
    if (dropRatio > 0.7) {
      return "stitched OCR drop ratio exceeded 70%";
    }
    const invalid = mappedBubbles.some((bubble) => {
      const values = [bubble.x, bubble.y, bubble.w, bubble.h].map((v) => Number(v));
      if (values.some((v) => !Number.isFinite(v))) return true;
      const bw = values[2];
      const bh = values[3];
      if (bw <= 0 || bh <= 0) return true;
      const bx = values[0];
      const by = values[1];
      if (bubble.stitch_overflow) {
        // Overflow bubble: y can be negative, y+h can > 100
        if (by + bh < -35 || by > 135) return true;
        if (bh > 60) return true;
      } else {
        // Normal bubble
        if (bx < -5 || bx + bw > 105) return true;
        if (by < -5 || by + bh > 105) return true;
        const lineCount = getBubbleLineCount(bubble);
        const maxH = lineCount > 1 ? 60 : 35;
        if (bh > maxH) return true;
      }
      return false;
    });
    return invalid ? "stitched OCR produced implausible owner coordinates" : "";
  }

  async function extractAdjacentKakaoPayload(target) {
    try {
      const payload = await extractImagePayload(target);
      return payload && isDataUrl(payload.dataUrl) ? payload : null;
    } catch {
      return null;
    }
  }

  function mapKakaoStitchedResult(result, payload, target, targetKey) {
    if (!payload || !payload.stitch || !result || !Array.isArray(result.bubbles)) {
      return result;
    }
    const stitch = payload.stitch;
    const canvasWidth = Math.max(1, Number(stitch.canvasWidth || Number(payload.width) || 1));
    const canvasHeight = Math.max(1, Number(stitch.canvasHeight || Number(payload.height) || 1));
    const ownerDraw = stitch.owner && stitch.owner.drawRect
      ? stitch.owner.drawRect
      : { x: 0, y: 0, w: canvasWidth, h: canvasHeight };
    const segments = normalizeKakaoStitchSegments(stitch, canvasWidth, canvasHeight, ownerDraw);
    const targetRect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;

    console.debug("[MangaTranslator][KakaoStitch] Mapping result", {
      targetKey: targetKey && targetKey.slice(0, 80),
      canvasWidth,
      canvasHeight,
      bubbleCount: result.bubbles.length,
      segments: segments.map((s) => ({
        source: s.source,
        targetKey: s.targetKey,
        src: String(s.src || "").slice(0, 80),
        drawRect: s.drawRect,
        sourceCrop: s.sourceCrop
      }))
    });

    const mapped = result.bubbles.map((bubble) => {
      const bx = Number(bubble.x);
      const by = Number(bubble.y);
      const bw = Number(bubble.w);
      const bh = Number(bubble.h);

      if (![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) {
        console.warn("[MangaTranslator][KakaoStitch] Discarding bubble with invalid coords", {
          raw: { x: bubble.x, y: bubble.y, w: bubble.w, h: bubble.h },
          text: String(bubble.original_text || "").slice(0, 40)
        });
        return null;
      }

      const bubblePx = {
        x: (bx / 100) * canvasWidth,
        y: (by / 100) * canvasHeight,
        w: (bw / 100) * canvasWidth,
        h: (bh / 100) * canvasHeight
      };

      const bubbleArea = Math.max(1, bubblePx.w * bubblePx.h);
      const ranked = segments.map((segment) => {
        const rect = segment && segment.drawRect;
        if (!rect) return { segment, ratio: 0 };
        const left = Math.max(bubblePx.x, rect.x);
        const top = Math.max(bubblePx.y, rect.y);
        const right = Math.min(bubblePx.x + bubblePx.w, rect.x + rect.w);
        const bottom = Math.min(bubblePx.y + bubblePx.h, rect.y + rect.h);
        const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
        return { segment, ratio: overlap / bubbleArea };
      }).sort((a, b) => b.ratio - a.ratio);

      const best = ranked[0];
      const ownerRank = ranked.find((r) => r.segment && r.segment.source === "owner");
      const ownerRatio = ownerRank ? ownerRank.ratio : 0;

      console.debug("[MangaTranslator][KakaoStitch] Bubble overlap ratios", {
        text: String(bubble.original_text || "").slice(0, 50),
        rawPercent: { x: bx, y: by, w: bw, h: bh },
        px: bubblePx,
        overlaps: ranked.map((r) => ({
          source: r.segment && r.segment.source,
          ratio: Number(r.ratio.toFixed(4))
        })),
        bestSource: best && best.segment && best.segment.source,
        bestRatio: best ? Number(best.ratio.toFixed(4)) : 0
      });

      if (!best || !best.segment || best.segment.source !== "owner" || best.ratio < 0.6) {
        console.debug("[MangaTranslator][KakaoStitch] Discarding bubble: not in owner region", {
          bestSource: best && best.segment && best.segment.source,
          bestRatio: best ? Number(best.ratio.toFixed(4)) : 0
        });
        return null;
      }

      const ownerRect = ownerDraw;
      const crossesBoundary = bubblePx.y < ownerRect.y ||
        (bubblePx.y + bubblePx.h) > (ownerRect.y + ownerRect.h);
      const overflow = crossesBoundary && ownerRatio >= 0.25;

      if (overflow) {
        const mappedY = ((bubblePx.y - ownerRect.y) / ownerRect.h) * 100;
        const mappedH = (bubblePx.h / ownerRect.h) * 100;

        if (mappedY + mappedH < -35 || mappedY > 135 || mappedH > 60) {
          console.warn("[MangaTranslator][KakaoStitch] Discarding overflow bubble out of bounds", {
            text: String(bubble.original_text || "").slice(0, 40),
            mappedY: Number(mappedY.toFixed(2)),
            mappedBottom: Number((mappedY + mappedH).toFixed(2)),
            mappedH: Number(mappedH.toFixed(2))
          });
          return null;
        }

        return {
          ...bubble,
          x: ((bubblePx.x - ownerRect.x) / ownerRect.w) * 100,
          y: mappedY,
          w: (bubblePx.w / ownerRect.w) * 100,
          h: mappedH,
          stitch_overflow: true,
          fill_box: mapKakaoStitchedFillBox(bubble.fill_box, ownerRect.y, ownerRect.h, canvasHeight),
          polygon: mapKakaoStitchedPolygon(bubble.polygon, ownerRect.y, ownerRect.h, canvasHeight),
          region_polygon: mapKakaoStitchedPolygon(bubble.region_polygon, ownerRect.y, ownerRect.h, canvasHeight)
        };
      }

      // Normal bubble: clip to owner drawRect
      const clippedLeft = Math.max(bubblePx.x, ownerRect.x);
      const clippedTop = Math.max(bubblePx.y, ownerRect.y);
      const clippedRight = Math.min(bubblePx.x + bubblePx.w, ownerRect.x + ownerRect.w);
      const clippedBottom = Math.min(bubblePx.y + bubblePx.h, ownerRect.y + ownerRect.h);
      const clippedW = Math.max(0, clippedRight - clippedLeft);
      const clippedH = Math.max(0, clippedBottom - clippedTop);
      if (clippedW <= 0 || clippedH <= 0) {
        console.warn("[MangaTranslator][KakaoStitch] Discarding normal bubble: zero area after clipping");
        return null;
      }

      const mappedX = ((clippedLeft - ownerRect.x) / ownerRect.w) * 100;
      const mappedY = ((clippedTop - ownerRect.y) / ownerRect.h) * 100;
      const mappedW = (clippedW / ownerRect.w) * 100;
      const mappedH = (clippedH / ownerRect.h) * 100;

      const lineCount = getBubbleLineCount(bubble);
      const maxH = lineCount > 1 ? 60 : 35;
      if (mappedX < -5 || mappedX + mappedW > 105 ||
          mappedY < -5 || mappedY + mappedH > 105 ||
          mappedH > maxH) {
        console.warn("[MangaTranslator][KakaoStitch] Discarding normal bubble out of bounds", {
          text: String(bubble.original_text || "").slice(0, 40),
          mapped: { x: Number(mappedX.toFixed(2)), y: Number(mappedY.toFixed(2)),
                     w: Number(mappedW.toFixed(2)), h: Number(mappedH.toFixed(2)) },
          maxH,
          lineCount
        });
        return null;
      }

      return {
        ...bubble,
        x: mappedX,
        y: mappedY,
        w: mappedW,
        h: mappedH,
        stitch_overflow: false,
        fill_box: mapKakaoStitchedFillBox(bubble.fill_box, ownerRect.y, ownerRect.h, canvasHeight),
        polygon: mapKakaoStitchedPolygon(bubble.polygon, ownerRect.y, ownerRect.h, canvasHeight),
        region_polygon: mapKakaoStitchedPolygon(bubble.region_polygon, ownerRect.y, ownerRect.h, canvasHeight)
      };
    }).filter(Boolean);

    const withGlobalBoxes = mapped.map((bubble) => ({
      ...bubble,
      global_box: computeKakaoGlobalBoxFromTarget(bubble, target)
    }));
    const deduped = dedupeKakaoGlobalBubbles(withGlobalBoxes, target, targetRect, targetKey);

    console.debug("[MangaTranslator][KakaoStitch] Mapping complete", {
      rawCount: result.bubbles.length,
      mappedCount: mapped.length,
      dedupedCount: deduped.length,
      dropRatio: result.bubbles.length > 0
        ? Number(((result.bubbles.length - deduped.length) / result.bubbles.length).toFixed(3))
        : 0
    });

    return {
      ...result,
      bubbles: deduped,
      debug: normalizeKakaoStitchDebugCoordinates(result.debug, payload.stitch)
    };
  }

  function mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH) {
    if (!box || typeof box !== "object") return null;
    const x = Number(box.x);
    const y = Number(box.y);
    const w = Number(box.w);
    const h = Number(box.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const topPx = (y / 100) * compositeH;
    const heightPx = (h / 100) * compositeH;
    return {
      x,
      y: ((topPx - ownerY) / ownerH) * 100,
      w,
      h: (heightPx / ownerH) * 100
    };
  }

  function mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const mapped = points.map((point) => {
      const x = Number(point && point.x);
      const rawY = Number(point && point.y);
      if (!Number.isFinite(x) || !Number.isFinite(rawY)) return null;
      const pixY = (rawY / 100) * compositeH;
      return { x, y: ((pixY - ownerY) / ownerH) * 100 };
    });
    return mapped.every(Boolean) ? mapped : null;
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
    const rawSegments = Array.isArray(stitch && stitch.segments) ? stitch.segments : [];
    const segments = rawSegments
      .filter((segment) => segment && segment.drawRect)
      .map((segment) => ({
        ...segment,
        drawRect: normalizeRectLike(segment.drawRect)
      }))
      .filter((segment) => segment.drawRect && segment.drawRect.w > 0 && segment.drawRect.h > 0);
    if (segments.length > 0) {
      return segments;
    }
    // Fallback: derive from canvas dimensions and ownerDraw
    const cw = Number(stitch && stitch.canvasWidth) || compositeWidth;
    const ch = Number(stitch && stitch.canvasHeight) || compositeHeight;
    // Backward compat: also check old field names
    const prevSlice = Math.max(0, Number(stitch && (stitch.previousSlice || (stitch.previous && stitch.previous.drawRect && stitch.previous.drawRect.h))) || 0);
    const nextSlice = Math.max(0, Number(stitch && (stitch.nextSlice || (stitch.next && stitch.next.drawRect && stitch.next.drawRect.h))) || 0);
    const owner = normalizeRectLike(ownerDraw) || {
      x: 0,
      y: prevSlice,
      w: cw,
      h: Math.max(1, ch - prevSlice - nextSlice)
    };
    const fallback = [];
    if (prevSlice > 0) {
      fallback.push({ source: "previous", drawRect: { x: 0, y: 0, w: cw, h: prevSlice } });
    }
    fallback.push({ source: "owner", drawRect: owner });
    if (nextSlice > 0) {
      fallback.push({ source: "next", drawRect: { x: 0, y: owner.y + owner.h, w: cw, h: nextSlice } });
    }
    return fallback;
  }

  function normalizeRectLike(rect) {
    if (!rect || typeof rect !== "object") return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const w = Number(rect.w || rect.width);
    const h = Number(rect.h || rect.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return null;
    }
    return { x, y, w, h };
  }

  function getKakaoStitchOwnerOverlap(bubbleRect, segments) {
    if (!bubbleRect || !Array.isArray(segments) || segments.length === 0) {
      return null;
    }
    const area = Math.max(1, bubbleRect.w * bubbleRect.h);
    const ranked = segments
      .map((segment) => {
        const rect = segment && segment.drawRect;
        if (!rect) return { segment, ratio: 0 };
        const left = Math.max(bubbleRect.x, rect.x);
        const top = Math.max(bubbleRect.y, rect.y);
        const right = Math.min(bubbleRect.x + bubbleRect.w, rect.x + rect.w);
        const bottom = Math.min(bubbleRect.y + bubbleRect.h, rect.y + rect.h);
        const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
        return { segment, ratio: overlap / area };
      })
      .sort((a, b) => b.ratio - a.ratio);
    const best = ranked[0];
    return best && best.segment && best.segment.source === "owner" && best.ratio >= 0.6 ? best : null;
  }

  function normalizeKakaoStitchDebugCoordinates(debug, stitch) {
    if (!debug || !stitch) {
      return debug;
    }
    const cw = Math.max(1, Number(stitch.canvasWidth || stitch.compositeWidth) || Number(debug.imageWidth) || 1);
    const ch = Math.max(1, Number(stitch.canvasHeight || stitch.compositeHeight) || Number(debug.imageHeight) || 1);
    const ownerDraw = stitch.owner && stitch.owner.drawRect
      ? stitch.owner.drawRect
      : { x: 0, y: 0, w: cw, h: ch };
    const ownerRect = normalizeRectLike(ownerDraw) || { x: 0, y: 0, w: cw, h: ch };
    const context = {
      stitch,
      compositeWidth: cw,
      compositeHeight: ch,
      ownerDraw: ownerRect,
      segments: normalizeKakaoStitchSegments(stitch, cw, ch, ownerRect)
    };
    return {
      ...debug,
      imageWidth: ownerRect.w,
      imageHeight: ownerRect.h,
      rawItems: normalizeDebugCoordinateItems(debug.rawItems, debug, context),
      duplicateItems: normalizeDebugCoordinateItems(debug.duplicateItems, debug, context),
      dedupedItems: normalizeDebugCoordinateItems(debug.dedupedItems, debug, context)
    };
  }

  function normalizeDebugCoordinateItems(items, debug, context = {}) {
    if (!Array.isArray(items) || !context || !context.stitch) {
      return Array.isArray(items) ? items : [];
    }
    const imageWidth = Math.max(1, Number(debug && debug.imageWidth) || Number(context.compositeWidth) || 1);
    const imageHeight = Math.max(1, Number(debug && debug.imageHeight) || Number(context.compositeHeight) || 1);
    const compositeWidth = Math.max(1, Number(context.compositeWidth) || imageWidth);
    const compositeHeight = Math.max(1, Number(context.compositeHeight) || imageHeight);
    const ownerDraw = context.ownerDraw || { x: 0, y: 0, w: compositeWidth, h: compositeHeight };
    const segments = Array.isArray(context.segments) ? context.segments : [];
    return items.map((item) => {
      const percent = getDebugItemPercentWithImageSize(item, imageWidth, imageHeight);
      if (!percent) return null;
      const rect = {
        x: (Number(percent.x) / 100) * compositeWidth,
        y: (Number(percent.y) / 100) * compositeHeight,
        w: (Number(percent.w) / 100) * compositeWidth,
        h: (Number(percent.h) / 100) * compositeHeight
      };
      if (!getKakaoStitchOwnerOverlap(rect, segments)) {
        return null;
      }
      const left = Math.max(rect.x, ownerDraw.x);
      const top = Math.max(rect.y, ownerDraw.y);
      const right = Math.min(rect.x + rect.w, ownerDraw.x + ownerDraw.w);
      const bottom = Math.min(rect.y + rect.h, ownerDraw.y + ownerDraw.h);
      const mapped = {
        x: ((left - ownerDraw.x) / ownerDraw.w) * 100,
        y: ((top - ownerDraw.y) / ownerDraw.h) * 100,
        w: (Math.max(0, right - left) / ownerDraw.w) * 100,
        h: (Math.max(0, bottom - top) / ownerDraw.h) * 100
      };
      return mapped.w > 0 && mapped.h > 0 ? { ...item, percent: mapped } : null;
    }).filter(Boolean);
  }

  function getDebugItemPercentWithImageSize(item, imageWidth, imageHeight) {
    if (item && item.percent && [item.percent.x, item.percent.y, item.percent.w, item.percent.h].every((value) => Number.isFinite(Number(value)))) {
      return item.percent;
    }
    const box = item && (item.rawBox || item.box);
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

  async function dedupeKakaoResultByPageCoordinates(result, target, targetKey) {
    if (!IS_KAKAOPAGE_READER || !result || !Array.isArray(result.bubbles) || !targetKey) {
      return result;
    }
    const targetRect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    if (!targetRect || !(Number(targetRect.width) > 0) || !(Number(targetRect.height) > 0)) {
      return result;
    }
    const bubbles = result.bubbles.map((bubble) => ({
      ...bubble,
      global_box: bubble.global_box || {
        left: targetRect.left + window.scrollX + (Number(bubble.x) / 100) * targetRect.width,
        top: targetRect.top + window.scrollY + (Number(bubble.y) / 100) * targetRect.height,
        width: (Number(bubble.w) / 100) * targetRect.width,
        height: (Number(bubble.h) / 100) * targetRect.height
      }
    }));
    state.kakaoGlobalOcrEntries.delete(targetKey);
    const trimmed = await trimKakaoBoundaryOverlapBubbles(bubbles, targetKey);
    const deduped = dedupeKakaoGlobalBubbles(trimmed, target, targetRect, targetKey);
    return {
      ...result,
      bubbles: deduped,
      debug: syncOcrDebugFinalBubbles(result.debug, deduped)
    };
  }

  async function trimKakaoBoundaryOverlapBubbles(bubbles, targetKey) {
    const existing = Array.from(state.kakaoGlobalOcrEntries.values()).flat();
    const output = [];
    for (const bubble of bubbles) {
      let nextBubble = bubble;
      const text = normalizeOcrSimilarityText(bubble.original_text);
      const entry = existing.find((candidate) => {
        const overlap = getSubstantialOcrBoundaryOverlap(text, candidate.text);
        return overlap && areKakaoGlobalBoxesRelated(bubble.global_box, candidate.box);
      });
      if (entry) {
        const overlap = getSubstantialOcrBoundaryOverlap(text, entry.text);
        const trimmed = trimKakaoBubbleBoundary(nextBubble, overlap);
        if (trimmed) {
          nextBubble = await translateTrimmedKakaoBubble(trimmed, targetKey);
        }
      }
      output.push(nextBubble);
    }
    return output;
  }

  function trimKakaoBubbleBoundary(bubble, overlap) {
    if (!bubble || !overlap || !(overlap.length > 0)) {
      return null;
    }
    const originalText = String(bubble.original_text || "");
    const normalizedLength = Math.max(1, normalizeOcrSimilarityText(originalText).length);
    const uniqueLength = normalizedLength - overlap.length;
    if (uniqueLength < 2) {
      return null;
    }
    const keepRatio = Math.max(0.12, Math.min(1, uniqueLength / normalizedLength));
    const keepSuffix = overlap.trim === "prefix";
    const uniqueText = sliceTextByNormalizedBoundary(originalText, overlap.length, keepSuffix);
    if (normalizeOcrSimilarityText(uniqueText).length < 2) {
      return null;
    }
    const originalY = Number(bubble.y);
    const originalH = Number(bubble.h);
    const nextY = keepSuffix ? originalY + originalH * (1 - keepRatio) : originalY;
    const nextH = originalH * keepRatio;
    const globalBox = bubble.global_box ? {
      ...bubble.global_box,
      top: keepSuffix
        ? Number(bubble.global_box.top) + Number(bubble.global_box.height) * (1 - keepRatio)
        : Number(bubble.global_box.top),
      height: Number(bubble.global_box.height) * keepRatio
    } : null;
    return {
      ...bubble,
      original_text: uniqueText,
      translated_text: "",
      y: nextY,
      h: nextH,
      fill_box: null,
      polygon: null,
      region_polygon: null,
      global_box: globalBox,
      source_line_count: Math.max(1, Math.round(Number(bubble.source_line_count || 1) * keepRatio)),
      boundary_trimmed: true
    };
  }

  function sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix) {
    const chars = Array.from(String(text || ""));
    let count = 0;
    if (keepSuffix) {
      let index = 0;
      while (index < chars.length && count < overlapLength) {
        count += normalizeOcrSimilarityText(chars[index]).length;
        index += 1;
      }
      return chars.slice(index).join("").trim();
    }
    let index = chars.length - 1;
    while (index >= 0 && count < overlapLength) {
      count += normalizeOcrSimilarityText(chars[index]).length;
      index -= 1;
    }
    return chars.slice(0, index + 1).join("").trim();
  }

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
    if (!debug || typeof debug !== "object") {
      return debug;
    }
    const keptBlockIds = new Set((Array.isArray(bubbles) ? bubbles : [])
      .map((bubble) => String(bubble && (bubble.block_id || bubble.id) || ""))
      .filter(Boolean));
    const finalBubbles = (Array.isArray(debug.finalBubbles) ? debug.finalBubbles : [])
      .filter((item) => keptBlockIds.has(String(item && (item.blockId || item.block_id || item.id) || "")));
    return {
      ...debug,
      finalBubbles,
      items: finalBubbles
    };
  }

  function syncOcrDebugFinalBubbles(debug, bubbles) {
    const filtered = filterOcrDebugFinalBubbles(debug, bubbles);
    if (!filtered) {
      return filtered;
    }
    const byId = new Map((Array.isArray(bubbles) ? bubbles : []).map((bubble) => [
      String(bubble && (bubble.block_id || bubble.id) || ""),
      bubble
    ]));
    const finalBubbles = filtered.finalBubbles.map((item) => {
      const bubble = byId.get(String(item && (item.blockId || item.block_id || item.id) || ""));
      return bubble ? {
        ...item,
        text: bubble.original_text,
        translatedText: bubble.translated_text,
        percent: { x: bubble.x, y: bubble.y, w: bubble.w, h: bubble.h }
      } : item;
    });
    return { ...filtered, finalBubbles, items: finalBubbles };
  }

  function dedupeKakaoGlobalBubbles(bubbles, target, targetRect, targetKey) {
    if (!targetRect || !targetKey) {
      return bubbles;
    }
    state.kakaoGlobalOcrEntries.delete(targetKey);
    const existing = Array.from(state.kakaoGlobalOcrEntries.values()).flat();
    const accepted = [];
    const entries = [];
    for (const bubble of bubbles) {
      const box = bubble.global_box || {
        left: targetRect.left + window.scrollX + (Number(bubble.x) / 100) * targetRect.width,
        top: targetRect.top + window.scrollY + (Number(bubble.y) / 100) * targetRect.height,
        width: (Number(bubble.w) / 100) * targetRect.width,
        height: (Number(bubble.h) / 100) * targetRect.height
      };
      const text = normalizeOcrSimilarityText(bubble.original_text);
      const translatedText = normalizeOcrSimilarityText(bubble.translated_text);
      const duplicates = existing.concat(entries).filter((entry) =>
        isKakaoGlobalDuplicateCandidate({ box, text, translatedText }, entry)
      );
      const completeness = Math.max(text.length, translatedText.length);
      const strongestExisting = duplicates.reduce(
        (best, entry) => !best || entry.completeness > best.completeness ? entry : best,
        null
      );
      if (strongestExisting && strongestExisting.completeness >= completeness) {
        continue;
      }
      duplicates.forEach((entry) => removeSupersededKakaoGlobalEntry(entry));
      accepted.push(bubble);
      entries.push({
        box,
        text,
        translatedText,
        completeness,
        target,
        targetKey,
        bubble,
        bubbleContainer: accepted,
        entryContainer: entries
      });
    }
    state.kakaoGlobalOcrEntries.set(targetKey, entries);
    return accepted;
  }

  function isKakaoGlobalDuplicateCandidate(candidate, entry) {
    if (!candidate || !entry || !candidate.box || !entry.box) {
      return false;
    }
    const sourceRelated = areOcrTextsDuplicateOrContained(candidate.text, entry.text);
    const translationRelated = areOcrTextsDuplicateOrContained(candidate.translatedText, entry.translatedText);
    if (!sourceRelated && !translationRelated) {
      return false;
    }
    return areKakaoGlobalBoxesRelated(candidate.box, entry.box);
  }

  function areKakaoGlobalBoxesRelated(leftBox, rightBox) {
    if (!leftBox || !rightBox) {
      return false;
    }
    const overlap = pageBoxIntersectionRatio(leftBox, rightBox);
    const leftCenterX = leftBox.left + leftBox.width / 2;
    const rightCenterX = rightBox.left + rightBox.width / 2;
    const horizontalOverlap = Math.max(
      0,
      Math.min(leftBox.left + leftBox.width, rightBox.left + rightBox.width) -
        Math.max(leftBox.left, rightBox.left)
    );
    const horizontalOverlapRatio = horizontalOverlap / Math.max(1, Math.min(leftBox.width, rightBox.width));
    const verticalGap = Math.max(
      0,
      Math.max(leftBox.top, rightBox.top) -
        Math.min(leftBox.top + leftBox.height, rightBox.top + rightBox.height)
    );
    const closeAcrossBoundary = verticalGap <= Math.max(leftBox.height, rightBox.height) * 0.28 &&
      (horizontalOverlapRatio >= 0.35 ||
        Math.abs(leftCenterX - rightCenterX) <= Math.max(leftBox.width, rightBox.width) * 0.35);
    return overlap >= 0.08 || closeAcrossBoundary;
  }

  function areOcrTextsDuplicateOrContained(first, second) {
    if (!first || !second) {
      return false;
    }
    const shorter = first.length <= second.length ? first : second;
    const longer = first.length > second.length ? first : second;
    return textSimilarity(first, second) >= 0.82 ||
      (shorter.length >= 3 && longer.includes(shorter));
  }

  function getSubstantialOcrBoundaryOverlap(first, second) {
    const minimumLength = Math.max(6, Math.ceil(Math.min(first.length, second.length) * 0.55));
    const maximumLength = Math.min(first.length, second.length);
    for (let length = maximumLength; length >= minimumLength; length -= 1) {
      if (first.endsWith(second.slice(0, length))) {
        return { length, trim: "suffix" };
      }
      if (second.endsWith(first.slice(0, length))) {
        return { length, trim: "prefix" };
      }
    }
    return null;
  }

  function removeSupersededKakaoGlobalEntry(entry) {
    if (!entry) {
      return;
    }
    const ownerEntries = state.kakaoGlobalOcrEntries.get(entry.targetKey) || [];
    state.kakaoGlobalOcrEntries.set(
      entry.targetKey,
      ownerEntries.filter((candidate) => candidate !== entry)
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

    const cached = state.localResultCache.get(entry.targetKey);
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
    state.localResultCache.set(entry.targetKey, nextResult);
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
    const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
    return (width * height) / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  }

  function normalizeOcrSimilarityText(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  function textSimilarity(first, second) {
    if (first === second) {
      return first ? 1 : 0;
    }
    if (!first || !second) {
      return 0;
    }
    const firstChars = Array.from(first);
    const secondChars = Array.from(second);
    let previous = Array.from({ length: secondChars.length + 1 }, (_, index) => index);
    firstChars.forEach((firstChar, firstIndex) => {
      const current = [firstIndex + 1];
      secondChars.forEach((secondChar, secondIndex) => {
        current.push(Math.min(current[secondIndex] + 1, previous[secondIndex + 1] + 1, previous[secondIndex] + (firstChar === secondChar ? 0 : 1)));
      });
      previous = current;
    });
    return 1 - previous[previous.length - 1] / Math.max(firstChars.length, secondChars.length);
  }

  async function normalizeKakaopagePayload(target, payload) {
    if (!IS_KAKAOPAGE_READER || !payload || !isSupportedTarget(target)) {
      return payload;
    }

    const rect = target.getBoundingClientRect();
    const payloadHeight = Number(payload.height || 0);
    const payloadWidth = Number(payload.width || 0);
    const cssHeight = Number(payload.cssHeight || rect.height || 0);
    const cssWidth = Number(payload.cssWidth || rect.width || 0);
    const looksLikeStrip =
      payloadHeight < 220 ||
      cssHeight < 180 ||
      payloadWidth / Math.max(1, payloadHeight) > 5.2 ||
      cssWidth / Math.max(1, cssHeight) > 5.2;

    if (!looksLikeStrip) {
      return payload;
    }

    const captureRect = getVisibleViewportRect(target);
    if (!hasUsableKakaoStripCaptureRect(captureRect)) {
      // 页面滚动或虚拟列表重排可能让目标在提取期间只露出一小部分；这是可重试状态，不应上报为 OCR 错误。
      throw new Error(SCREENSHOT_TARGET_NOT_VISIBLE);
    }

    return captureVisibleTargetPayload(target, new Error("Kakao source image is a strip"), payload.imageUrl || "kakao-strip");
  }

  function hasUsableKakaoStripCaptureRect(captureRect) {
    return !!captureRect && captureRect.height >= 180 && captureRect.width >= 180;
  }

  async function extractImagePayload(img) {
    if (!img.complete) {
      throw new Error("Image is not loaded yet");
    }

    const imageUrl = resolveImageUrl(img);

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
      const fetched = await sendRuntimeMessage({
        type: "FETCH_IMAGE_DATA_URL",
        url: imageUrl
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
        url: imageUrl
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
    if (rect.width < 80 || rect.height < 60) {
      return { ok: false, reason: `target too small: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}` };
    }

    const visibleRect = getVisibleViewportRect(target);
    if (!visibleRect) {
      return { ok: false, reason: "no visible viewport rect" };
    }

    if (visibleRect.width < 60 || visibleRect.height < 50) {
      return {
        ok: false,
        reason: `visible rect too small: ${visibleRect.width.toFixed(0)}x${visibleRect.height.toFixed(0)}`,
      };
    }

    const visibleArea = getVisibleArea(rect);
    if (visibleArea < 5000) {
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
            maxOriginalBytes: EMBEDDED_MAX_ORIGINAL_BYTES
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
      mode: "loading"
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

    const originalText = cleanRenderableText(bubble.original_text || "");
    const translatedText = cleanRenderableText(bubble.translated_text || "") || originalText;
    if (!translatedText) {
      return null;
    }
    const bgType = normalizeBgType(bubble.bg_type);

    const node = document.createElement("div");
    const renderColors = getBubbleRenderColors(bubble, bgType);
    node.className = `mt-bubble mt-bg-${bgType}`;
    node.dataset.mangaTranslatorOverlay = "true";
    node.dataset.index = String(index);
    node.dataset.mode = "translated";
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

    node.textContent = formatTranslationForOriginalLines(translatedText, Number(node.dataset.sourceLineCount));
    node.title = originalText || translatedText;
    applyBubbleTextLayout(node, translatedText);

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
      if ((target.dataset.mtLastTranslatedKey || "") !== targetKey) {
        continue;
      }

      const localCachedResult = state.localResultCache.get(targetKey);
      if (localCachedResult && Array.isArray(localCachedResult.bubbles) && localCachedResult.bubbles.length > 0) {
        if (shouldUseEmbeddedRender(target)) {
          extractTargetPayload(target, targetKey)
            .then((payload) => renderTranslationResult(target, targetKey, localCachedResult, payload))
            .catch(() => {
              // 当前图片不可读时跳过恢复，避免自动触发新的翻译请求。
            });
        } else {
          renderOverlay(target, targetKey, localCachedResult);
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
      overlayState.root.remove();
      state.overlaysById.delete(overlayState.targetId);
      if (state.overlaysById.size === 0) {
        stopOverlayFrameSync();
      }
      return;
    }

    if (!overlayState.target.isConnected) {
      overlayState.root.remove();
      state.overlaysById.delete(overlayState.targetId);
      if (state.overlaysById.size === 0) {
        stopOverlayFrameSync();
      }
      return;
    }

    const rect = getOverlayDisplayRect(overlayState);
    const visible = isRectVisible(getOverlayVisibilityRect(overlayState, rect));

    if (!visible || rect.width < 2 || rect.height < 2) {
      overlayState.root.style.display = "none";
      return;
    }

    const viewportRect = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
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

    const targetKey = computeTargetKey(target);
    if (target.dataset.mtLastTranslatedKey === targetKey || target.dataset.mtNoTextKey === targetKey) {
      return;
    }

    if (!passesTargetFilter(target, true)) {
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

  const autoTranslateRetryTimers = new Map();
  const AUTO_TRANSLATE_RETRY_DELAY_MS = 1200;

  function scheduleAutoTranslateRetry(target) {
    if (autoTranslateRetryTimers.has(target)) {
      return;
    }

    const timer = window.setTimeout(() => {
      autoTranslateRetryTimers.delete(target);
      if (!target.isConnected || state.invalidated) {
        return;
      }
      queuePageAutoTranslate(target);
    }, AUTO_TRANSLATE_RETRY_DELAY_MS);

    autoTranslateRetryTimers.set(target, timer);
  }

  function clearAutoTranslateRetryTimers() {
    for (const timer of autoTranslateRetryTimers.values()) {
      window.clearTimeout(timer);
    }
    autoTranslateRetryTimers.clear();
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

      // Neighbor-finding mode: apply size + center proximity filters
      if (ownerRect) {
        if (!(rect.width >= 200 && rect.height >= 40)) {
          return false;
        }
        if (target instanceof HTMLImageElement) {
          const naturalWidth = Number(target.naturalWidth || 0);
          const naturalHeight = Number(target.naturalHeight || 0);
          if (!(naturalWidth >= 60 && naturalHeight >= 30)) {
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
      return false;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return false;
    }

    const widthLimit = manual ? MANUAL_MIN_WIDTH : AUTO_MIN_WIDTH;
    const heightLimit = manual ? MANUAL_MIN_HEIGHT : AUTO_MIN_HEIGHT;
    const effectiveWidthLimit = relaxed ? Math.max(90, Math.min(widthLimit, 100)) : widthLimit;
    const effectiveHeightLimit = relaxed ? Math.max(90, Math.min(heightLimit, 100)) : heightLimit;

    if (rect.width < effectiveWidthLimit || rect.height < effectiveHeightLimit) {
      return false;
    }

    if (IS_KAKAOPAGE_READER && !passesKakaopageTargetGeometry(target, rect, manual, relaxed, allowOffscreen)) {
      return false;
    }

    const ratio = rect.height / rect.width;
    const minRatio = relaxed ? 0.10 : AUTO_MIN_RATIO;
    const maxRatio = relaxed ? 20 : 14;
    if (ratio < minRatio || ratio > maxRatio) {
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
      const visibleArea = getVisibleArea(rect);
      const visibleRect = getVisibleViewportRect(target);
      const minVisibleArea = relaxed ? 5000 : manual ? 10000 : 15000;
      if (!visibleRect || visibleArea < minVisibleArea) {
        return false;
      }

      const minVisibleHeight = relaxed ? 50 : manual ? 60 : 80;
      const minVisibleWidth = relaxed ? 60 : manual ? 80 : 100;
      if (visibleRect.height < minVisibleHeight || visibleRect.width < minVisibleWidth) {
        return false;
      }

      const visibleRatio = visibleRect.height / Math.max(1, visibleRect.width);
      if (visibleRatio < 0.10 || visibleRatio > 20) {
        return false;
      }
    }

    if (target instanceof HTMLImageElement) {
      const naturalWidth = Number(target.naturalWidth || 0);
      const naturalHeight = Number(target.naturalHeight || 0);
      if (naturalWidth > 0 && naturalHeight > 0) {
        const naturalRatio = naturalHeight / Math.max(1, naturalWidth);
        if (naturalHeight < 80 || naturalRatio < 0.10) {
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
