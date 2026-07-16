export function installReaderInit(runtime) {
  function debugTargetFilter(message, details) {
    if (!runtime.ENABLE_FILTER_DEBUG) return;
    console.debug(`[MangaTranslator][Filter] ${message}`, details);
  }
  runtime.debugTargetFilter = debugTargetFilter;
  function tracePipeline(stage, target, detail = {}) {
    if (!runtime.ENABLE_PIPELINE_TRACE) return;
    const arr = globalThis.__MT_PIPELINE_TRACE__ || (globalThis.__MT_PIPELINE_TRACE__ = []);
    if (arr.length >= 5000) arr.shift();
    const sourceToken = runtime.getQuickSourceToken(target);
    const targetKey = runtime.computeTargetKey(target);
    arr.push({
      ts: performance.now(),
      idx: arr.length,
      sourceToken,
      targetKey,
      scopedKey: runtime.buildTargetSourceCacheKey(targetKey, sourceToken),
      stage,
      detail
    });
    if (target && target.dataset) {
      let history = [];
      try {
        history = JSON.parse(target.dataset.mtPipelineTrace || "[]");
        if (!Array.isArray(history)) history = [];
      } catch {
        history = [];
      }
      let summary = "";
      try {
        summary = JSON.stringify(detail).slice(0, 400);
      } catch {
        summary = "[unserializable]";
      }
      history.push({
        stage: String(stage || ""),
        at: Math.round(performance.now()),
        summary
      });
      target.dataset.mtPipelineStage = String(stage || "");
      target.dataset.mtPipelineTrace = JSON.stringify(history.slice(-12));
    }
  }
  runtime.tracePipeline = tracePipeline;
  async function init() {
    if (!runtime.hasExtensionApis()) {
      runtime.state.invalidated = true;
      runtime.api.invalidated = true;
      console.info("[MangaTranslator] extension APIs are unavailable in this page context, skip init.");
      return;
    }
    runtime.claimRuntimeOwnership();
    await runtime.loadLocalSettings();
    runtime.ensureOverlayLayer();
    runtime.createFloatingBall();
    runtime.bindRuntimeMessages();
    runtime.bindStorageListener();
    runtime.bindViewportSync();
    runtime.startObservers();
    runtime.rescan();
    await runtime.reportStatus("info", "content script ready", {
      autoEnabled: runtime.state.enabled,
      aggressivePreload: runtime.state.aggressivePreload,
      pageUrl: location.href
    });
    runtime.scheduleAheadPretranslation("page-load");
  }
  runtime.init = init;
  function hasExtensionApis() {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id && !!chrome.runtime.onMessage && !!chrome.storage && !!chrome.storage.local;
  }
  runtime.hasExtensionApis = hasExtensionApis;
  function bindRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) {
        return false;
      }
      if (message.type === "MANUAL_TRANSLATE_VISIBLE") {
        runtime.manualTranslateVisible().then(result => sendResponse({
          ok: true,
          ...result
        })).catch(error => {
          sendResponse({
            ok: false,
            error: runtime.getErrorMessage(error)
          });
        });
        return true;
      }
      if (message.type === "TOGGLE_PAGE_AUTO_TRANSLATE") {
        runtime.togglePageAutoTranslate(message.enabled).then(result => sendResponse({
          ok: true,
          ...result
        })).catch(error => {
          sendResponse({
            ok: false,
            error: runtime.getErrorMessage(error)
          });
        });
        return true;
      }
      if (message.type === "GET_PAGE_AUTO_TRANSLATE_STATUS") {
        sendResponse({
          ok: true,
          ...runtime.getPageAutoTranslateStatus()
        });
        return false;
      }
      if (message.type === "PING_CONTENT_SCRIPT") {
        sendResponse({
          ok: true,
          ready: !runtime.state.invalidated
        });
        return false;
      }
      return false;
    });
  }
  runtime.bindRuntimeMessages = bindRuntimeMessages;
  function bindViewportSync() {
    const scheduleSync = () => {
      if (runtime.state.syncRaf) {
        return;
      }
      runtime.state.syncRaf = window.requestAnimationFrame(() => {
        runtime.state.syncRaf = 0;
        runtime.syncAllOverlays();
        runtime.scheduleAheadPretranslation("viewport");
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
    if (!runtime.state.syncInterval) {
      runtime.state.syncInterval = window.setInterval(() => {
        runtime.ensureExtensionUiMounted();
        runtime.syncAllOverlays();
      }, 1200);
    }
  }
  runtime.bindViewportSync = bindViewportSync;
  function overlayFrameSyncTick() {
    runtime.state.overlayFrameRaf = 0;
    if (runtime.state.invalidated) {
      return;
    }
    for (const overlayState of runtime.state.overlaysById.values()) {
      runtime.syncOverlayPosition(overlayState);
    }
    runtime.syncKakaoVisualDuplicateBubbles();
    if (runtime.state.overlaysById.size > 0) {
      runtime.state.overlayFrameRaf = window.requestAnimationFrame(runtime.overlayFrameSyncTick);
    }
  }
  runtime.overlayFrameSyncTick = overlayFrameSyncTick;
  function ensureOverlayFrameSync() {
    if (runtime.state.invalidated || runtime.state.overlayFrameRaf || runtime.state.overlaysById.size === 0) {
      return;
    }
    // 阅读器可能用 transform 平滑移动画面，此时不会持续触发原生 scroll 事件。
    runtime.state.overlayFrameRaf = window.requestAnimationFrame(runtime.overlayFrameSyncTick);
  }
  runtime.ensureOverlayFrameSync = ensureOverlayFrameSync;
  function stopOverlayFrameSync() {
    if (!runtime.state.overlayFrameRaf) {
      return;
    }
    window.cancelAnimationFrame(runtime.state.overlayFrameRaf);
    runtime.state.overlayFrameRaf = 0;
  }
  runtime.stopOverlayFrameSync = stopOverlayFrameSync;
  function startObservers() {
    if (runtime.state.invalidated) {
      return;
    }
    runtime.state.io = new IntersectionObserver(runtime.onIntersection, {
      root: null,
      rootMargin: runtime.IS_KAKAOPAGE_READER ? "800px 0px" : "280px 0px",
      threshold: 0.08
    });
    runtime.state.preloadIo = new IntersectionObserver(runtime.onPreloadIntersection, {
      root: null,
      rootMargin: runtime.getPreloadRootMargin(),
      threshold: 0.01
    });
    runtime.state.mo = new MutationObserver(runtime.onMutation);
    const observeDom = () => {
      const root = document.documentElement || document.body;
      if (!root || runtime.state.invalidated) {
        return;
      }
      runtime.state.mo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "style", "class", "width", "height", "id"]
      });
    };
    observeDom();
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", observeDom, {
        once: true
      });
    }
  }
  runtime.startObservers = startObservers;
  function rescan() {
    if (runtime.state.invalidated) {
      return;
    }
    runtime.ensureExtensionUiMounted();
    runtime.scanNode(document.documentElement || document.body);
    runtime.syncAllOverlays();
  }
  runtime.rescan = rescan;
  function scanNode(node) {
    if (!node || runtime.state.invalidated) {
      return;
    }
    if (node instanceof Element && node.closest("[data-manga-translator-overlay]")) {
      return;
    }
    if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement || runtime.isBackgroundImageTarget(node)) {
      runtime.registerTarget(node);
      return;
    }
    if (!(node instanceof Element)) {
      return;
    }
    node.querySelectorAll(runtime.TARGET_SELECTOR).forEach(target => runtime.registerTarget(target));
  }
  runtime.scanNode = scanNode;
}
