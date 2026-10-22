export function installLifecycleOverlayCleanup(runtime) {
  function clearKakaoLoadingOverlay(target) {
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) return false;
    const overlayState = runtime.state.overlaysById.get(targetId);
    if (!overlayState) return false;
    if (overlayState.loadingTimeout) {
      window.clearTimeout(overlayState.loadingTimeout);
      overlayState.loadingTimeout = 0;
    }
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
  function removeOverlayForTarget(target) {
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
    runtime.traceMaskEvent?.(maskPageIdOf(runtime, overlayState), "remove-overlay", {
      stateMask: String(overlayState.cleanedImage || "").length,
      bubbleCount: Number(overlayState.bubbleCount || 0)
    });
    runtime.state.overlaysById.delete(targetId);
    if (runtime.state.overlaysById.size === 0) {
      runtime.stopOverlayFrameSync();
    }
  }
  runtime.removeOverlayForTarget = removeOverlayForTarget;
  // 渲染跳过判据：这一页上一轮画好的覆盖层是否还在 DOM 上。
  // 滚动清理、换图、恢复原文都会删掉覆盖层状态，这时必须重画，不能跳过。
  function isPageRenderStillApplied(target) {
    const targetId = typeof runtime.getTargetId === "function" ? runtime.getTargetId(target) : runtime.state.targetIdByElement.get(target);
    const overlayState = targetId ? runtime.state.overlaysById.get(targetId) : null;
    if (!overlayState || !overlayState.root || !overlayState.root.isConnected) return false;
    const mode = String(overlayState.mode || "");
    return mode !== "loading" && mode !== "debug";
  }
  runtime.isPageRenderStillApplied = isPageRenderStillApplied;
}

// 与 renderer-mask.js 的 overlayPageId 同一口径：先看这一 target 此刻绑在哪一页
// （分片原地换图会换 pageId），再看建 root 时的快照。
function maskPageIdOf(runtime, overlayState) {
  const target = overlayState && overlayState.target;
  if (target && runtime.state && runtime.state.kakaoPageIdByTarget) {
    const live = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    if (live) return live;
  }
  return String((overlayState && overlayState.pageId) || "");
}
