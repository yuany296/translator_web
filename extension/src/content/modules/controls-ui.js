export function installControlsUi(runtime) {
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
      runtime.state.floatingBallFeedback = null;
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
    const feedback = document.createElement("div");
    feedback.className = "mt-floating-feedback";
    feedback.dataset.mangaTranslatorOverlay = "true";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.hidden = true;
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
    wrap.appendChild(feedback);
    wrap.appendChild(ball);
    wrap.appendChild(closeBtn);
    document.documentElement.appendChild(wrap);
    runtime.state.floatingBallWrap = wrap;
    runtime.state.floatingBall = ball;
    runtime.state.floatingBallClose = closeBtn;
    runtime.state.floatingBallFeedback = feedback;
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
  function showFloatingBallFeedback(message, level = "info") {
    const feedback = runtime.state.floatingBallFeedback;
    if (!feedback) return;
    feedback.textContent = String(message || "");
    feedback.className = `mt-floating-feedback mt-${level === "error" ? "error" : level === "success" ? "success" : "info"}`;
    feedback.hidden = !feedback.textContent;
  }
  runtime.showFloatingBallFeedback = showFloatingBallFeedback;
  function clearFloatingBallFeedback() {
    runtime.showFloatingBallFeedback("");
  }
  runtime.clearFloatingBallFeedback = clearFloatingBallFeedback;
  function buildManualTranslateFeedback(result) {
    const visibleCount = Math.max(0, Number(result?.visibleCount || 0));
    const successCount = Math.max(0, Number(result?.successCount || 0));
    const failCount = Math.max(0, Number(result?.failCount || 0));
    const skippedCount = Math.max(0, Number(result?.skippedCount || 0));
    const firstError = (() => {
      const raw = result?.errors?.[0];
      if (!raw) return "";
      if (typeof raw === "string") return raw.trim();
      if (raw && typeof raw.message === "string") return raw.message.trim();
      try { return JSON.stringify(raw).slice(0, 120); } catch { return ""; }
    })();
    const firstSkipped = String(result?.skippedReasons?.[0] || "").trim();
    if (/extension context invalidated/iu.test(firstError)) return { level: "error", message: "扩展已重新加载，请刷新漫画页后重试" };
    if (failCount > 0) return { level: "error", message: `翻译失败：${firstError || `${failCount} 个目标处理失败`}` };
    if (visibleCount === 0) return { level: "info", message: "当前视口未找到可翻译的漫画图片" };
    if (successCount === 0 && skippedCount > 0) return { level: "info", message: `本次未执行：${firstSkipped || "目标已离开可视区域，请稍后重试"}` };
    return { level: "success", message: `翻译完成：${successCount}/${visibleCount} 张` };
  }
  runtime.buildManualTranslateFeedback = buildManualTranslateFeedback;
  async function closeFloatingBall() {
    runtime.state.showFloatingBall = false;
    runtime.updateFloatingBallState();
    try {
      await runtime.updateRuntimeConfiguration({ showBall: false });
    } catch {
      // Ignore persistence failure, keep current page hidden state.
    }
  }
  runtime.closeFloatingBall = closeFloatingBall;
  async function manualTranslateVisible() {
    if (runtime.state.invalidated) {
      const result = {
        visibleCount: 0,
        successCount: 0,
        failCount: 0,
        errors: ["Extension context invalidated"]
      };
      const feedback = runtime.buildManualTranslateFeedback(result);
      runtime.showFloatingBallFeedback(feedback.message, feedback.level);
      return result;
    }
    runtime.clearFloatingBallFeedback();
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
        const result = {
          visibleCount: 0,
          successCount: 0,
          failCount: 0,
          errors: []
        };
        const feedback = runtime.buildManualTranslateFeedback(result);
        runtime.showFloatingBallFeedback(feedback.message, feedback.level);
        return result;
      }
      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      const errors = [];
      const skippedReasons = [];
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
          skippedCount += 1;
          if (result.reason) skippedReasons.push(result.reason);
        } else {
          failCount += 1;
          const err = result && result.error;
          if (err) {
            errors.push(typeof err === "string" ? err : (err.message || runtime.getErrorMessage(err)));
          }
        }
      }
      const uniqueErrors = [...new Set(errors)].slice(0, 3);
      const uniqueSkippedReasons = [...new Set(skippedReasons)].slice(0, 3);
      const result = { visibleCount: targets.length, successCount, failCount, skippedCount, errors: uniqueErrors, skippedReasons: uniqueSkippedReasons };
      const feedback = runtime.buildManualTranslateFeedback(result);
      runtime.showFloatingBallFeedback(feedback.message, feedback.level);
      if (feedback.level === "error") console.warn("[MangaTranslator] manual translation failed", { visibleCount: result.visibleCount, successCount: result.successCount, failCount: result.failCount, skippedCount: result.skippedCount, errors: result.errors });
      const summaryMessage = failCount > 0 ? `manual translate finished (${successCount}/${targets.length}), first error: ${uniqueErrors[0] || "unknown"}` : `manual translate finished (${successCount}/${targets.length})`;
      await runtime.reportStatus(failCount > 0 ? "error" : "info", summaryMessage, {
        visibleCount: targets.length,
        successCount,
        failCount,
        skippedCount,
        firstError: uniqueErrors[0] || ""
      });
      return result;
    } catch (error) {
      const reason = runtime.getErrorMessage(error);
      const result = { visibleCount: 0, successCount: 0, failCount: 1, skippedCount: 0, errors: [reason], skippedReasons: [] };
      const feedback = runtime.buildManualTranslateFeedback(result);
      runtime.showFloatingBallFeedback(feedback.message, feedback.level);
      console.warn("[MangaTranslator] manual translation crashed", error);
      await runtime.reportStatus("error", reason, {
        reason: "manual-translate-crash"
      });
      return result;
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
