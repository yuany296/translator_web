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
