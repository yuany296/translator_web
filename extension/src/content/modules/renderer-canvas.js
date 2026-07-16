export function installRendererCanvas(runtime) {
  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Embedded image decode failed"));
      image.src = dataUrl;
    });
  }
  runtime.loadImageFromDataUrl = loadImageFromDataUrl;
  async function decodeDataUrlImageSize(dataUrl) {
    const image = await runtime.loadImageFromDataUrl(dataUrl);
    return {
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0
    };
  }
  runtime.decodeDataUrlImageSize = decodeDataUrlImageSize;
  function renderLoadingOverlay(target, targetKey, text) {
    runtime.ensureOverlayLayer();
    const targetId = runtime.getTargetId(target);
    const oldOverlay = runtime.state.overlaysById.get(targetId);
    if (oldOverlay && oldOverlay.targetKey === targetKey && oldOverlay.mode === "loading") {
      runtime.updateLoadingOverlayText(target, targetKey, text);
      runtime.syncOverlayPosition(oldOverlay);
      return;
    }
    if (runtime.shouldPreserveOverlayDuringLoading(oldOverlay, targetKey)) {
      // 已有译文可继续显示，后续 seam/投影阶段在后台完成，避免稳定内容闪烁。
      // 同时保留独立的进度胶囊，避免后台仍在运行时 loading 从画面消失。
      runtime.ensureLoadingStatusCard(oldOverlay, text);
      runtime.syncOverlayPosition(oldOverlay);
      return;
    }
    if (oldOverlay) {
      if (oldOverlay.loadingTimeout) {
        window.clearTimeout(oldOverlay.loadingTimeout);
        oldOverlay.loadingTimeout = 0;
      }
      oldOverlay.root.remove();
      runtime.state.overlaysById.delete(targetId);
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
        const current = runtime.state.overlaysById.get(targetId);
        if (current !== overlayState || current.mode !== "loading") return;
        console.warn("[MangaTranslator] Loading overlay timed out, clearing", {
          targetKey: String(targetKey).slice(0, 80)
        });
        overlayState.root.remove();
        runtime.state.overlaysById.delete(targetId);
        if (runtime.state.overlaysById.size === 0) {
          runtime.stopOverlayFrameSync();
        }
        const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
        const settled = runtime.hasSettledTranslationMarker(target, targetKey, scopedTargetKey);
        const taskActive = runtime.state.inflightByTarget.has(target) || runtime.state.queuedTargets.has(target);
        // UI 超时不能推翻已经完成的翻译，也不能给仍在运行的同一任务制造第二份作业。
        if (target.isConnected && runtime.state.autoTranslatePageEnabled && !settled && !taskActive) {
          runtime.scheduleAutoTranslateRetry(target);
        }
        runtime.reportStatus("warn", "loading-overlay-timeout", {
          targetKey: String(targetKey).slice(0, 80),
          settled,
          taskActive
        }).catch(() => {});
      }, runtime.LOADING_OVERLAY_TIMEOUT_MS)
    };
    runtime.state.overlayLayer.appendChild(root);
    runtime.state.overlaysById.set(targetId, overlayState);
    runtime.syncOverlayPosition(overlayState);
    runtime.ensureOverlayFrameSync();
  }
  runtime.renderLoadingOverlay = renderLoadingOverlay;
}
