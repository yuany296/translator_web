export function installContent23(runtime) {
  function clearAllEmbeddedTargets() {
    const targets = Array.from(runtime.state.embeddedById.values()).map(item => item.target).filter(Boolean);
    targets.forEach(target => runtime.restoreEmbeddedForTarget(target));
    runtime.state.embeddedById.clear();
    runtime.state.embeddedImageCache.clear();
  }
  runtime.clearAllEmbeddedTargets = clearAllEmbeddedTargets;
  function clearAllRenderedTargets() {
    runtime.clearAllOverlays();
    runtime.clearAllEmbeddedTargets();
  }
  runtime.clearAllRenderedTargets = clearAllRenderedTargets;
  function ensureOverlayLayer() {
    if (runtime.state.overlayLayer && runtime.state.overlayLayer.isConnected) {
      return runtime.state.overlayLayer;
    }
    const layer = document.createElement("div");
    layer.className = "mt-overlay-layer";
    if (runtime.IS_KAKAOPAGE_READER) {
      // 进入页面坐标系后，图片和覆盖层由浏览器合成线程同步滚动，避免 fixed 覆盖层逐帧追赶。
      layer.classList.add("mt-overlay-document-flow");
    }
    layer.dataset.mangaTranslatorOverlay = "true";
    document.documentElement.appendChild(layer);
    runtime.state.overlayLayer = layer;
    runtime.reattachOverlayRoots(layer);
    return layer;
  }
  runtime.ensureOverlayLayer = ensureOverlayLayer;
  function reattachOverlayRoots(layer) {
    if (!layer || !layer.isConnected) {
      return;
    }
    runtime.state.overlaysById.forEach(overlayState => {
      if (overlayState && overlayState.root && !overlayState.root.isConnected) {
        layer.appendChild(overlayState.root);
      }
    });
  }
  runtime.reattachOverlayRoots = reattachOverlayRoots;
  function isExtensionUiMounted() {
    const overlayOk = !!(runtime.state.overlayLayer && runtime.state.overlayLayer.isConnected);
    const ballOk = !runtime.state.showFloatingBall || !!(runtime.state.floatingBallWrap && runtime.state.floatingBallWrap.isConnected);
    return overlayOk && ballOk;
  }
  runtime.isExtensionUiMounted = isExtensionUiMounted;
  function ensureExtensionUiMounted() {
    if (runtime.state.invalidated) {
      return;
    }
    if (!runtime.isCurrentRuntimeOwner()) {
      runtime.destroy();
      return;
    }
    const layer = runtime.ensureOverlayLayer();
    runtime.reattachOverlayRoots(layer);
    if (runtime.state.overlayHideDepth === 0 && layer && layer.style.visibility === "hidden") {
      layer.style.visibility = runtime.state.overlayPreviousVisibility || "";
      runtime.state.overlayPreviousVisibility = "";
    }
    if (!runtime.state.floatingBallWrap || !runtime.state.floatingBallWrap.isConnected) {
      runtime.state.floatingBallWrap = null;
      runtime.state.floatingBall = null;
      runtime.state.floatingBallClose = null;
      runtime.createFloatingBall();
    }
    if (runtime.state.overlayHideDepth === 0 && runtime.state.floatingBallWrap && runtime.state.floatingBallWrap.isConnected && runtime.state.floatingBallWrap.style.visibility === "hidden") {
      runtime.state.floatingBallWrap.style.visibility = "";
    }
    runtime.updateFloatingBallState();
  }
  runtime.ensureExtensionUiMounted = ensureExtensionUiMounted;
  function stopExtensionUiEvent(event) {
    if (!event) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
  runtime.stopExtensionUiEvent = stopExtensionUiEvent;
  function stopExtensionUiPropagation(event) {
    if (!event) {
      return;
    }
    event.stopPropagation();
  }
  runtime.stopExtensionUiPropagation = stopExtensionUiPropagation;
  function createFloatingBall() {
    if (runtime.state.floatingBallWrap && runtime.state.floatingBallWrap.isConnected) {
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "mt-floating-ball-wrap";
    wrap.dataset.mangaTranslatorOverlay = "true";
    wrap.addEventListener("click", runtime.stopExtensionUiEvent);
    wrap.addEventListener("mousedown", runtime.stopExtensionUiPropagation);
    wrap.addEventListener("mouseup", runtime.stopExtensionUiPropagation);
    wrap.addEventListener("pointerdown", runtime.stopExtensionUiPropagation);
    wrap.addEventListener("pointerup", runtime.stopExtensionUiPropagation);
    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "mt-floating-ball";
    ball.textContent = "译";
    ball.title = "翻译当前视口漫画目标";
    ball.addEventListener("click", async event => {
      runtime.stopExtensionUiEvent(event);
      if (runtime.state.invalidated || !runtime.state.enabled) {
        return;
      }
      if (runtime.state.autoTranslatePageEnabled) {
        await runtime.togglePageAutoTranslate(false);
        return;
      }
      if (runtime.isAutomaticPretranslateMode(runtime.state.pretranslateMode)) {
        await runtime.togglePageAutoTranslate(true);
        return;
      }
      await runtime.manualTranslateVisible();
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mt-floating-close";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭悬浮球";
    closeBtn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      await runtime.closeFloatingBall();
    });
    wrap.appendChild(ball);
    wrap.appendChild(closeBtn);
    document.documentElement.appendChild(wrap);
    runtime.state.floatingBallWrap = wrap;
    runtime.state.floatingBall = ball;
    runtime.state.floatingBallClose = closeBtn;
    runtime.updateFloatingBallState();
  }
  runtime.createFloatingBall = createFloatingBall;
  function updateFloatingBallState() {
    if (!runtime.state.floatingBallWrap || !runtime.state.floatingBall) {
      return;
    }
    runtime.state.floatingBallWrap.classList.toggle("mt-hidden", !runtime.state.showFloatingBall);
    runtime.state.floatingBall.classList.toggle("mt-disabled", !runtime.state.enabled || runtime.state.invalidated);
    runtime.state.floatingBall.classList.toggle("mt-auto-enabled", runtime.state.autoTranslatePageEnabled && runtime.state.enabled);
    runtime.state.floatingBall.textContent = runtime.state.autoTranslatePageEnabled && runtime.state.enabled ? "停" : "译";
    runtime.state.floatingBall.title = runtime.state.autoTranslatePageEnabled && runtime.state.enabled ? "关闭本页自动翻译" : "翻译当前视口漫画目标";
  }
  runtime.updateFloatingBallState = updateFloatingBallState;
  function setFloatingBallWorking(working) {
    if (!runtime.state.floatingBall) {
      return;
    }
    runtime.state.floatingBall.classList.toggle("mt-working", !!working);
  }
  runtime.setFloatingBallWorking = setFloatingBallWorking;
  async function closeFloatingBall() {
    runtime.state.showFloatingBall = false;
    runtime.updateFloatingBallState();
    try {
      await runtime.storageSet({
        mt_show_ball: false
      });
    } catch {
      // Ignore persistence failure, keep current page hidden state.
    }
  }
  runtime.closeFloatingBall = closeFloatingBall;
  async function manualTranslateVisible() {
    if (runtime.state.invalidated) {
      return {
        visibleCount: 0,
        successCount: 0,
        failCount: 0,
        errors: ["Extension context invalidated"]
      };
    }
    runtime.setFloatingBallWorking(true);
    try {
      let targets = runtime.collectVisibleTargets();
      if (targets.length === 0 && runtime.IS_CMOA_SPEED_READER) {
        targets = runtime.collectVisibleTargets({
          relaxed: true
        });
      }
      if (targets.length === 0) {
        await runtime.reportStatus("info", "no visible manga target", {
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
      const tasks = targets.map(target => async () => runtime.translateTarget(target, {
        manual: true,
        reason: "manual"
      }));
      const results = await runtime.runWithConcurrency(tasks, runtime.MANUAL_PARALLEL_TRANSLATIONS);
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
      const summaryMessage = failCount > 0 ? `manual translate finished (${successCount}/${targets.length}), first error: ${uniqueErrors[0] || "unknown"}` : `manual translate finished (${successCount}/${targets.length})`;
      await runtime.reportStatus(failCount > 0 ? "error" : "info", summaryMessage, {
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
      runtime.setFloatingBallWorking(false);
    }
  }
  runtime.manualTranslateVisible = manualTranslateVisible;
  async function togglePageAutoTranslate(enabled) {
    if (runtime.state.invalidated) {
      return {
        enabled: false,
        visibleCount: 0,
        successCount: 0,
        failCount: 0,
        errors: ["Extension context invalidated"]
      };
    }
    const nextEnabled = typeof enabled === "boolean" ? enabled : !runtime.state.autoTranslatePageEnabled;
    runtime.state.autoTranslatePageEnabled = nextEnabled && runtime.state.enabled;
    runtime.updateFloatingBallState();
    if (!runtime.state.autoTranslatePageEnabled) {
      runtime.clearAutoTranslateRetryTimers();
      await runtime.reportStatus("info", "page auto translate stopped", {
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
    runtime.rescan();
    const visibleCount = runtime.queueVisiblePageAutoTargets();
    runtime.scheduleAheadPretranslation("page-auto-start");
    const queuedCount = runtime.state.queue.length;
    const runningCount = runtime.state.runningJobs;
    await runtime.reportStatus("info", "page auto translate started", {
      pageUrl: location.href,
      visibleCount,
      queuedCount,
      runningCount
    });
    return {
      enabled: true,
      visibleCount,
      successCount: 0,
      failCount: 0,
      queuedCount,
      runningCount,
      errors: []
    };
  }
  runtime.togglePageAutoTranslate = togglePageAutoTranslate;
  function getPageAutoTranslateStatus() {
    return {
      enabled: runtime.state.autoTranslatePageEnabled && runtime.state.enabled,
      queuedCount: runtime.state.queue.length,
      runningCount: runtime.state.runningJobs
    };
  }
  runtime.getPageAutoTranslateStatus = getPageAutoTranslateStatus;
  function queueVisiblePageAutoTargets() {
    const targets = runtime.collectVisibleTargets({
      includeLimit: false
    });
    targets.forEach(target => runtime.queuePageAutoTranslate(target));
    return targets.length;
  }
  runtime.queueVisiblePageAutoTargets = queueVisiblePageAutoTargets;
  function matchesTargetMarker(value, targetKey, scopedTargetKey) {
    const marker = String(value || "");
    return !!marker && (marker === String(targetKey || "") || marker === String(scopedTargetKey || ""));
  }
  runtime.matchesTargetMarker = matchesTargetMarker;
  function hasSettledNoTextMarker(target, targetKey, scopedTargetKey) {
    return !!target && runtime.matchesTargetMarker(target.dataset && target.dataset.mtNoTextKey, targetKey, scopedTargetKey);
  }
  runtime.hasSettledNoTextMarker = hasSettledNoTextMarker;
  function hasSettledTranslatedMarker(target, targetKey, scopedTargetKey) {
    return !!target && runtime.matchesTargetMarker(target.dataset && target.dataset.mtLastTranslatedKey, targetKey, scopedTargetKey);
  }
  runtime.hasSettledTranslatedMarker = hasSettledTranslatedMarker;
  function hasPendingTranslationMarkerState(target, targetKey, scopedTargetKey) {
    if (!target || !target.dataset) return false;
    return !runtime.hasSettledTranslatedMarker(target, targetKey, scopedTargetKey) && !runtime.hasSettledNoTextMarker(target, targetKey, scopedTargetKey);
  }
  runtime.hasPendingTranslationMarkerState = hasPendingTranslationMarkerState;
  function isTranslationRecoveryDue(target, now = Date.now()) {
    if (!target || !target.dataset) return false;
    const lastRequestedAt = Number(target.dataset.mtRecoveryReqAt || 0);
    return !Number.isFinite(lastRequestedAt) || lastRequestedAt <= 0 || Number(now) - lastRequestedAt >= runtime.RECOVERY_REQUEST_GAP_MS;
  }
  runtime.isTranslationRecoveryDue = isTranslationRecoveryDue;
  function hasSettledTranslationMarker(target, targetKey, scopedTargetKey) {
    if (!target || !target.dataset) return false;
    return runtime.hasSettledTranslatedMarker(target, targetKey, scopedTargetKey) || runtime.hasSettledNoTextMarker(target, targetKey, scopedTargetKey);
  }
  runtime.hasSettledTranslationMarker = hasSettledTranslationMarker;
}
