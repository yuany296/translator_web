export function installLifecycleRestore(runtime) {
  function restoreEmbeddedForTarget(target) {
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }
    const embeddedState = runtime.state.embeddedById.get(targetId);
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
      runtime.restoreCanvasFromDataUrl(target, embeddedState.originalDataUrl);
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
    runtime.state.embeddedById.delete(targetId);
  }
  runtime.restoreEmbeddedForTarget = restoreEmbeddedForTarget;
  function restoreCanvasFromDataUrl(canvas, dataUrl) {
    runtime.loadImageFromDataUrl(dataUrl).then(image => {
      if (!canvas.isConnected) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    }).catch(() => {
      // 还原失败时保持当前画面，避免破坏页面渲染。
    });
  }
  runtime.restoreCanvasFromDataUrl = restoreCanvasFromDataUrl;
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
      sourceGeneration: runtime.getKakaoTargetGeneration(target),
      isConnected: target.isConnected
    };
  }
  runtime.captureTargetSnapshot = captureTargetSnapshot;
  function isTargetSnapshotStillValid(target, snapshot) {
    if (!target || !target.isConnected || !snapshot) {
      return false;
    }
    if (!snapshot.isConnected) {
      return false;
    }
    if (Number(snapshot.sourceGeneration || 0) !== runtime.getKakaoTargetGeneration(target)) {
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
  runtime.isTargetSnapshotStillValid = isTargetSnapshotStillValid;
  function clearRenderedTarget(target) {
    runtime.removeCrossPageOverlaysForTarget(target);
    runtime.removeOverlayForTarget(target);
    runtime.restoreEmbeddedForTarget(target);
  }
  runtime.clearRenderedTarget = clearRenderedTarget;
  function clearAllOverlays() {
    runtime.stopOverlayFrameSync();
    runtime.clearCrossPageOverlays();
    for (const overlayState of runtime.state.overlaysById.values()) {
      if (overlayState.loadingTimeout) {
        window.clearTimeout(overlayState.loadingTimeout);
        overlayState.loadingTimeout = 0;
      }
      overlayState.root.remove();
    }
    runtime.state.overlaysById.clear();
    runtime.state.seamSourceModeByRenderKey.clear();
  }
  runtime.clearAllOverlays = clearAllOverlays;
}
