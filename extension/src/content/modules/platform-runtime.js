export function installPlatformRuntime(runtime) {
  function rememberPayloadCache(targetKey, payload) {
    runtime.state.payloadCacheByTargetKey.set(targetKey, {
      timestamp: Date.now(),
      payload
    });
    if (runtime.state.payloadCacheByTargetKey.size <= runtime.MAX_PAYLOAD_CACHE) {
      return;
    }
    const firstKey = runtime.state.payloadCacheByTargetKey.keys().next().value;
    if (firstKey) {
      runtime.state.payloadCacheByTargetKey.delete(firstKey);
    }
  }
  runtime.rememberPayloadCache = rememberPayloadCache;
  function normalizeRenderMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === runtime.RENDER_MODE_EMBEDDED ? runtime.RENDER_MODE_EMBEDDED : runtime.RENDER_MODE_OVERLAY;
  }
  runtime.normalizeRenderMode = normalizeRenderMode;
  function normalizePretranslateMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "ahead" || mode === "continuous") {
      return mode;
    }
    return "manual";
  }
  runtime.normalizePretranslateMode = normalizePretranslateMode;
  function isAutomaticPretranslateMode(value) {
    const mode = runtime.normalizePretranslateMode(value);
    return mode === "ahead" || mode === "continuous";
  }
  runtime.isAutomaticPretranslateMode = isAutomaticPretranslateMode;
  function normalizeCaptureMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === runtime.CAPTURE_MODE_SCREENSHOT ? runtime.CAPTURE_MODE_SCREENSHOT : runtime.CAPTURE_MODE_DIRECT;
  }
  runtime.normalizeCaptureMode = normalizeCaptureMode;
  function isScreenshotCaptureMode() {
    return runtime.state.captureMode === runtime.CAPTURE_MODE_SCREENSHOT;
  }
  runtime.isScreenshotCaptureMode = isScreenshotCaptureMode;
  function isScreenshotTargetNotVisibleError(reason) {
    return String(reason || "") === runtime.SCREENSHOT_TARGET_NOT_VISIBLE;
  }
  runtime.isScreenshotTargetNotVisibleError = isScreenshotTargetNotVisibleError;
  async function reportStatus(level, message, details) {
    if (runtime.state.invalidated) {
      return;
    }
    const safeLevel = level === "error" ? "error" : "info";
    if (safeLevel === "info") {
      const now = Date.now();
      if (now - runtime.state.lastInfoStatusAt < runtime.STATUS_INFO_THROTTLE_MS) {
        return;
      }
      runtime.state.lastInfoStatusAt = now;
    }
    try {
      await runtime.sendRuntimeMessage({
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
  runtime.reportStatus = reportStatus;
  function sendRuntimeMessage(message) {
    if (runtime.state.invalidated) {
      return Promise.reject(new Error("Extension context invalidated"));
    }
    return new Promise((resolve, reject) => {
      const messageType = String(message && message.type || "");
      const hasImageRuntimeTimeout = messageType === "FETCH_IMAGE_DATA_URL" || messageType === "CAPTURE_VISIBLE_TARGET_DATA_URL";
      const timeoutMs = hasImageRuntimeTimeout ? runtime.IMAGE_RUNTIME_MESSAGE_TIMEOUT_MS : 0;
      let settled = false;
      let timer = 0;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        callback(value);
      };
      if (timeoutMs > 0) {
        timer = window.setTimeout(() => {
          finish(reject, new Error(`Runtime message timed out: ${messageType}`));
        }, timeoutMs);
      }
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          const reason = chrome.runtime.lastError.message || "runtime message failed";
          finish(reject, new Error(reason));
          return;
        }
        finish(resolve, response || null);
      });
    });
  }
  runtime.sendRuntimeMessage = sendRuntimeMessage;
  function markInvalidated(reason) {
    if (runtime.state.invalidated) {
      return;
    }
    runtime.state.invalidated = true;
    runtime.api.invalidated = true;
    try {
      if (runtime.state.io) {
        runtime.state.io.disconnect();
      }
    } catch {
      // Ignore.
    }
    try {
      if (runtime.state.preloadIo) {
        runtime.state.preloadIo.disconnect();
      }
    } catch {
      // Ignore.
    }
    try {
      if (runtime.state.mo) {
        runtime.state.mo.disconnect();
      }
    } catch {
      // Ignore.
    }
    runtime.clearAllOverlays();
    runtime.clearAutoTranslateRetryTimers();
    if (runtime.state.kakaoProjectionRefreshTimer) {
      window.clearTimeout(runtime.state.kakaoProjectionRefreshTimer);
      runtime.state.kakaoProjectionRefreshTimer = 0;
    }
    runtime.state.kakaoProjectionRefreshPageIds.clear();
    runtime.state.kakaoStore.reset();
    runtime.state.queue.length = 0;
    runtime.state.preloadQueue.length = 0;
    runtime.state.payloadCacheByTargetKey.clear();
    runtime.state.lastRecoveryAt = 0;
    runtime.state.lastAggressivePreloadSweepAt = 0;
    if (runtime.state.aggressiveSweepTimer) {
      try {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(runtime.state.aggressiveSweepTimer);
        } else {
          window.clearTimeout(runtime.state.aggressiveSweepTimer);
        }
      } catch {
        // Ignore timer cleanup failure.
      }
      runtime.state.aggressiveSweepTimer = 0;
    }
    if (runtime.state.syncInterval) {
      window.clearInterval(runtime.state.syncInterval);
      runtime.state.syncInterval = 0;
    }
    runtime.updateFloatingBallState();
    console.info("[MangaTranslator] context invalidated, waiting for reinjection:", reason);
  }
  runtime.markInvalidated = markInvalidated;
  function destroy() {
    runtime.restoreAllNovelText();
    runtime.disconnectNovelReader();
    if (runtime.state.floatingResizeBound && runtime.applyFloatingPosition) {
      window.removeEventListener("resize", runtime.applyFloatingPosition);
      runtime.state.floatingResizeBound = false;
    }
    if (runtime.state.novelProgressHideTimer) {
      window.clearTimeout(runtime.state.novelProgressHideTimer);
      runtime.state.novelProgressHideTimer = 0;
    }
    runtime.markInvalidated("destroy called");
    if (runtime.state.overlayLayer && runtime.state.overlayLayer.isConnected) {
      runtime.state.overlayLayer.remove();
    }
    if (runtime.state.floatingBallWrap && runtime.state.floatingBallWrap.isConnected) {
      runtime.state.floatingBallWrap.remove();
    }
    runtime.clearNovelImagePanel?.(true);
  }
  runtime.destroy = destroy;
  function claimRuntimeOwnership() {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    const previousOwner = root.getAttribute(runtime.RUNTIME_OWNER_ATTRIBUTE);
    runtime.restoreAllNovelText();
    const staleUiExists = !!document.querySelector(
      ".mt-overlay-layer, .mt-floating-ball-wrap, .mt-measure-probe, .mt-novel-image-panel"
    );
    root.setAttribute(runtime.RUNTIME_OWNER_ATTRIBUTE, runtime.state.runtimeOwnerToken);
    root.setAttribute(runtime.RUNTIME_FEATURE_ATTRIBUTE, runtime.RUNTIME_FEATURE_VERSION);
    document.querySelectorAll(
      ".mt-overlay-layer, .mt-floating-ball-wrap, .mt-measure-probe, .mt-novel-image-panel"
    ).forEach(node => node.remove());
    if (previousOwner && previousOwner !== runtime.state.runtimeOwnerToken || staleUiExists) {
      document.querySelectorAll(runtime.TARGET_SELECTOR).forEach(target => {
        delete target.dataset.mtLastTranslatedKey;
        delete target.dataset.mtNoTextKey;
      });
    }
  }
  runtime.claimRuntimeOwnership = claimRuntimeOwnership;
  function isCurrentRuntimeOwner() {
    const root = document.documentElement;
    return !root || root.getAttribute(runtime.RUNTIME_OWNER_ATTRIBUTE) === runtime.state.runtimeOwnerToken;
  }
  runtime.isCurrentRuntimeOwner = isCurrentRuntimeOwner;
  function getTargetId(target) {
    let id = runtime.state.targetIdByElement.get(target);
    if (id) {
      return id;
    }
    id = String(runtime.state.targetIdSeq);
    runtime.state.targetIdSeq += 1;
    runtime.state.targetIdByElement.set(target, id);
    return id;
  }
  runtime.getTargetId = getTargetId;
  function isMangaTranslatorOverlayTarget(target) {
    if (!target) {
      return false;
    }
    if (target.dataset && target.dataset.mangaTranslatorOverlay === "true") {
      return true;
    }
    return typeof target.closest === "function" && !!target.closest("[data-manga-translator-overlay]");
  }
  runtime.isMangaTranslatorOverlayTarget = isMangaTranslatorOverlayTarget;
  function isSupportedTarget(target) {
    // 扩展自己的拼接画布带有 background-image；若再次作为 OCR 目标采集，
    // 会在接缝处叠加一套普通翻译气泡。
    if (runtime.isMangaTranslatorOverlayTarget(target)) {
      return false;
    }
    return target instanceof HTMLImageElement || target instanceof HTMLCanvasElement || runtime.isBackgroundImageTarget(target);
  }
  runtime.isSupportedTarget = isSupportedTarget;
  function isRectVisible(rect) {
    return runtime.getVisibleArea(rect) >= 4;
  }
  runtime.isRectVisible = isRectVisible;
  function getVisibleArea(rect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }
  runtime.getVisibleArea = getVisibleArea;
  async function fetchPageImageDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Background image fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size <= 0) {
      throw new Error("Background image fetch returned empty data");
    }
    return runtime.blobToDataUrl(blob);
  }
  runtime.fetchPageImageDataUrl = fetchPageImageDataUrl;
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Blob data URL conversion failed"));
      reader.readAsDataURL(blob);
    });
  }
  runtime.blobToDataUrl = blobToDataUrl;
  function getOverlayDisplayRect(overlayState) {
    const target = overlayState.target;
    const rect = target.getBoundingClientRect();
    if (overlayState.displayRect) {
      return runtime.computeTargetSubRect(rect, overlayState.displayRect);
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
    if (!runtime.isBackgroundImageTarget(target) || !overlayState.imageMeta) {
      return rect;
    }
    return runtime.computeBackgroundImageRect(target, rect, overlayState.imageMeta);
  }
  runtime.getOverlayDisplayRect = getOverlayDisplayRect;
}
