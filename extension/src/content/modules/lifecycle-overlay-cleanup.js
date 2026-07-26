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
    runtime.state.overlaysById.delete(targetId);
    if (runtime.state.overlaysById.size === 0) {
      runtime.stopOverlayFrameSync();
    }
  }
  runtime.removeOverlayForTarget = removeOverlayForTarget;
}
