export function installLifecycleOverlayCleanup(runtime) {
  function clearKakaoLoadingOverlay(target) {
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) return false;
    const overlayState = runtime.state.overlaysById.get(targetId);
    if (!overlayState) return false;
    if (overlayState.mode !== "loading") {
      const card = overlayState.loadingCard || overlayState.root.querySelector(".mt-loading-card-status");
      if (!card) return false;
      card.remove();
      overlayState.loadingCard = null;
      return true;
    }
    runtime.removeOverlayForTarget(target);
    return true;
  }
  runtime.clearKakaoLoadingOverlay = clearKakaoLoadingOverlay;
  function removeSeamSurfaceEntriesForTarget(target) {
    const pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || runtime.state.kakaoStore && typeof runtime.state.kakaoStore.getPageHandleForTarget === "function" && (runtime.state.kakaoStore.getPageHandleForTarget(target) || {}).pageId || "");
    if (!pageId) return;
    for (const [targetId, overlayState] of runtime.state.overlaysById) {
      const seamEntries = Array.isArray(overlayState && overlayState.seamEntries) ? overlayState.seamEntries : [];
      if (seamEntries.length === 0) continue;
      const keepEntries = [];
      for (const entry of seamEntries) {
        const pageIds = Array.isArray(entry.surface && entry.surface.pageIds) ? entry.surface.pageIds.map(String) : [];
        if (pageIds.includes(pageId)) {
          if (entry.windowNode && entry.windowNode.isConnected) entry.windowNode.remove();
        } else {
          keepEntries.push(entry);
        }
      }
      if (keepEntries.length === seamEntries.length) continue;
      overlayState.seamEntries = keepEntries;
      overlayState.root.dataset.seamRenderKeys = keepEntries.map(entry => entry.surface && entry.surface.renderKey).filter(Boolean).join(" ");
      const seamBubbleCount = keepEntries.reduce((sum, entry) => sum + (entry.bubbleNodes || []).length, 0);
      overlayState.bubbleCount = overlayState.bubbleNodes.length + seamBubbleCount;
      if (overlayState.bubbleCount === 0 && overlayState.debugNodeCount === 0) {
        if (overlayState.loadingTimeout) window.clearTimeout(overlayState.loadingTimeout);
        overlayState.root.remove();
        runtime.state.overlaysById.delete(targetId);
      }
    }
  }
  runtime.removeSeamSurfaceEntriesForTarget = removeSeamSurfaceEntriesForTarget;
  function removeOverlayForTarget(target) {
    runtime.removeSeamSurfaceEntriesForTarget(target);
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }
    const overlayState = runtime.state.overlaysById.get(targetId);
    if (!overlayState) {
      return;
    }

    // 清除 loading 超时定时器
    if (overlayState.loadingTimeout) {
      window.clearTimeout(overlayState.loadingTimeout);
      overlayState.loadingTimeout = 0;
    }
    overlayState.root.remove();
    runtime.state.overlaysById.delete(targetId);
    if (runtime.state.overlaysById.size === 0) {
      runtime.stopOverlayFrameSync();
    }
  }
  runtime.removeOverlayForTarget = removeOverlayForTarget;
}
