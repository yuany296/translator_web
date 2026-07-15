export function installReaderObservers(runtime) {
  function registerTarget(target) {
    if (!runtime.isSupportedTarget(target) || runtime.state.invalidated) {
      return;
    }
    if (!runtime.isSitePreferredTarget(target)) {
      return;
    }
    if (target instanceof HTMLImageElement && !target.complete && !runtime.state.kakaoLoadListenerTargets.has(target)) {
      runtime.state.kakaoLoadListenerTargets.add(target);
      target.addEventListener("load", () => {
        runtime.state.kakaoLoadListenerTargets.delete(target);
        if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.shouldRevalidateKakaoImageLoad(target)) {
          runtime.prepareKakaoTargetRevisionCheck(target, "image-load");
        }
        runtime.registerTarget(target);
        // Image just finished loading — queue for translation if the
        // IntersectionObserver already fired and won't fire again.
        if (runtime.state.autoTranslatePageEnabled && runtime.state.enabled && target.isConnected) {
          runtime.queuePageAutoTranslate(target);
        }
      }, {
        once: true
      });
      target.addEventListener("error", () => runtime.state.kakaoLoadListenerTargets.delete(target), {
        once: true
      });
    }
    const sourceToken = runtime.getQuickSourceToken(target);
    const oldSourceToken = target.dataset.mtSourceToken || "";
    const canonicalTarget = runtime.shouldUseKakaoCanonicalPipeline(target);
    if (canonicalTarget && oldSourceToken && oldSourceToken === sourceToken && runtime.shouldRevalidateReconnectedKakaoTarget(target)) {
      runtime.prepareKakaoTargetRevisionCheck(target, "dom-reconnected");
    }
    if (oldSourceToken && oldSourceToken !== sourceToken) {
      const oldScopedTargetKey = runtime.buildTargetSourceCacheKey(runtime.computeTargetKey(target), oldSourceToken);
      runtime.state.kakaoStore.cancelPageJob(oldScopedTargetKey);
      if (canonicalTarget) {
        runtime.detachKakaoTargetForSourceChange(target);
      }
      const oldTranslatedKey = target.dataset.mtLastTranslatedKey || "";
      if (oldTranslatedKey) {
        runtime.state.payloadCacheByTargetKey.delete(oldTranslatedKey);
        runtime.state.localResultCache.delete(oldTranslatedKey);
      }
      runtime.clearRenderedTarget(target);
      target.dataset.mtLastTranslatedKey = "";
      target.dataset.mtNoTextKey = "";
      target.dataset.mtRecoveryReqAt = "";
      if (!canonicalTarget && typeof runtime.state.kakaoStore.clearShortPage === "function") {
        runtime.state.kakaoStore.clearShortPage(target);
      }
      delete target.dataset.mtBoundaryReadyToken;
      runtime.kakaoRetryScheduler.cancel(target);
      // 清理全局去重条目
      if (!canonicalTarget && oldTranslatedKey) {
        runtime.state.kakaoStore.deleteEntriesForKey(oldTranslatedKey);
      }
      // 允许该 DOM 元素重新入队
      runtime.state.queuedTargets.delete(target);
      for (let index = runtime.state.queue.length - 1; index >= 0; index -= 1) {
        if (runtime.state.queue[index] && runtime.state.queue[index].target === target) runtime.state.queue.splice(index, 1);
      }
    }
    target.dataset.mtSourceToken = sourceToken;
    if (!oldSourceToken || oldSourceToken === sourceToken) {
      runtime.restoreKnownKakaoPageHandle(target);
    }
    const isNewObservation = !runtime.state.observedTargets.has(target);
    if (isNewObservation) {
      runtime.state.io.observe(target);
      if (runtime.state.preloadIo) {
        runtime.state.preloadIo.observe(target);
      }
      runtime.state.observedTargets.add(target);
    }

    // 自动翻译开启时，在两种情况下立即入队：
    const imgNotComplete = target instanceof HTMLImageElement && !target.complete;
    const needsRevisionCheck = target.dataset.mtKakaoRevisionCheck === "true";
    const shouldAutoQueue = runtime.state.autoTranslatePageEnabled && runtime.state.enabled && target.isConnected && !imgNotComplete;
    if (needsRevisionCheck && runtime.state.enabled && target.isConnected && !imgNotComplete) {
      delete target.dataset.mtKakaoRevisionCheck;
      runtime.queueTranslate(target, {
        manual: true,
        force: true,
        relaxed: true,
        allowOffscreen: true,
        reason: "kakao-image-revision-check"
      });
    }
    if (!shouldAutoQueue && runtime.state.autoTranslatePageEnabled && runtime.state.enabled && imgNotComplete) {
      // 图片还未加载完成（CDN 慢），等 load 事件触发后会再进 registerTarget 入队。
      // 但如果 load 事件永远不触发（CDN 错误），重试机制需要兜底。
      // sourceToken 变化时（SVG→CDN）安排一次重试，确保不遗漏。
      if (!isNewObservation && oldSourceToken && oldSourceToken !== sourceToken) {
        runtime.scheduleAutoTranslateRetry(target);
      }
    }
    if (shouldAutoQueue) {
      // 1) DOM 复用（sourceToken 变化）→ 旧元素被回收给新图片
      if (!isNewObservation && oldSourceToken && oldSourceToken !== sourceToken) {
        runtime.queuePageAutoTranslate(target);
      }
      // 2) 新元素且已在视口中 → IntersectionObserver 不会同步触发
      if (isNewObservation && runtime.isTargetVisible(target)) {
        runtime.queuePageAutoTranslate(target);
      }
      // 3) 已观察过且在视口中、未翻译 → init 时 autoTranslate 尚未开启，
      //    toggle 后 rescan 不会再次触发 intersection，需要此处显式入队。
      if (!isNewObservation && runtime.isTargetVisible(target) && !target.dataset.mtLastTranslatedKey && !target.dataset.mtNoTextKey) {
        runtime.queuePageAutoTranslate(target);
      }
    }
    if (runtime.IS_KAKAOPAGE_READER && target instanceof HTMLImageElement && target.complete && sourceToken) {
      runtime.refreshPreviousKakaoBoundary(target, sourceToken);
    }
    if (isNewObservation || oldSourceToken !== sourceToken) {
      runtime.tracePipeline("collected", target, {
        rect: {
          top: target.getBoundingClientRect().top,
          height: target.getBoundingClientRect().height,
          width: target.getBoundingClientRect().width
        }
      });
    }
  }
  runtime.registerTarget = registerTarget;
  function refreshPreviousKakaoBoundary(target, sourceToken) {
    if (target.dataset.mtBoundaryReadyToken === sourceToken) {
      return;
    }
    target.dataset.mtBoundaryReadyToken = sourceToken;
    const ordered = runtime.collectKakaopageManualTargetCandidates(true, target).filter(candidate => candidate instanceof HTMLImageElement && candidate.isConnected);
    const index = ordered.indexOf(target);
    if (index <= 0) {
      return;
    }
    const previous = runtime.findKakaoStitchNeighborTarget(runtime.buildKakaoStitchCandidateEntries(ordered), index, "previous");
    if (!previous) {
      return;
    }
    if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.kakaoCanonicalPipeline) {
      // 延迟触发邻页 seam，等 pipeline 建立 handle 后再执行。
      if (typeof runtime.kakaoCanonicalPipeline.onAdjacentTargetAvailable === "function") {
        if (!runtime.state.pendingKakaoAdjacency) runtime.state.pendingKakaoAdjacency = new Map();
        runtime.state.pendingKakaoAdjacency.set(target, previous);
      }
      return;
    }
    if (previous.dataset.mtLastTranslatedKey && runtime.state.autoTranslatePageEnabled && runtime.isAutomaticPretranslateMode(runtime.state.pretranslateMode)) {
      const previousKey = runtime.computeTargetKey(previous);
      runtime.state.payloadCacheByTargetKey.delete(previousKey);
      runtime.state.payloadCacheByTargetKey.delete(runtime.buildTargetSourceCacheKey(previousKey, runtime.getQuickSourceToken(previous)));
      runtime.queueTranslate(previous, {
        manual: true,
        force: true,
        reason: "kakao-boundary-refresh"
      });
    }
  }
  runtime.refreshPreviousKakaoBoundary = refreshPreviousKakaoBoundary;
  function onIntersection(entries) {
    if (runtime.state.invalidated) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      if (runtime.state.autoTranslatePageEnabled && runtime.state.enabled) {
        runtime.queuePageAutoTranslate(entry.target);
      }
    }
  }
  runtime.onIntersection = onIntersection;
  function onPreloadIntersection(entries) {
    if (runtime.state.invalidated) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const target = entry.target;
      if (!runtime.passesTargetFilter(target, false)) {
        continue;
      }
    }
  }
  runtime.onPreloadIntersection = onPreloadIntersection;
  function onMutation(mutations) {
    if (runtime.state.invalidated) {
      return;
    }
    let shouldRepairUi = false;
    let sawExternalMutation = false;
    const disconnectedCanonicalPageIds = new Set();
    for (const mutation of mutations) {
      const mutationInsideOverlay = mutation.target instanceof Element && mutation.target.closest("[data-manga-translator-overlay]");
      if (mutationInsideOverlay) {
        continue;
      }
      if (mutation.type === "childList") {
        mutation.removedNodes.forEach(node => {
          if (node === runtime.state.overlayLayer || node === runtime.state.floatingBallWrap) {
            shouldRepairUi = true;
          }
          if (node instanceof Element && !node.closest("[data-manga-translator-overlay]")) {
            const removedTargets = [];
            if (runtime.isSupportedTarget(node)) removedTargets.push(node);
            node.querySelectorAll(runtime.TARGET_SELECTOR).forEach(target => {
              if (runtime.isSupportedTarget(target)) removedTargets.push(target);
            });
            for (const removedTarget of removedTargets) {
              const pageId = runtime.detachKakaoTargetHandle(removedTarget);
              if (pageId) disconnectedCanonicalPageIds.add(pageId);
            }
            if (removedTargets.length > 0) sawExternalMutation = true;
          }
        });
        mutation.addedNodes.forEach(node => {
          if (node instanceof Element && node.closest("[data-manga-translator-overlay]")) {
            return;
          }
          sawExternalMutation = true;
          runtime.scanNode(node);
        });
      }
      if (mutation.type === "attributes" && (mutation.target instanceof HTMLImageElement || mutation.target instanceof HTMLCanvasElement || runtime.isBackgroundImageTarget(mutation.target))) {
        sawExternalMutation = true;
        runtime.registerTarget(mutation.target);
      }
    }
    if (shouldRepairUi || !runtime.isExtensionUiMounted()) {
      runtime.ensureExtensionUiMounted();
    }
    if (sawExternalMutation || shouldRepairUi) {
      runtime.scheduleAheadPretranslation("mutation");
    }
    if (disconnectedCanonicalPageIds.size > 0) {
      runtime.scheduleKakaoProjectionRefresh([...disconnectedCanonicalPageIds], "page-handle-disconnected");
    }
  }
  runtime.onMutation = onMutation;
  function scheduleAheadPretranslation(reason) {
    if (!runtime.shouldSchedulePagePretranslation()) {
      return;
    }
    runtime.getAheadTranslationTargets().forEach(target => runtime.queueTranslate(target, runtime.buildAheadTranslationOptions(reason)));
  }
  runtime.scheduleAheadPretranslation = scheduleAheadPretranslation;
  function shouldSchedulePagePretranslation({
    enabled = runtime.state.enabled,
    pageEnabled = runtime.state.autoTranslatePageEnabled,
    mode = runtime.state.pretranslateMode,
    invalidated = runtime.state.invalidated
  } = {}) {
    return enabled && pageEnabled && !invalidated && runtime.isAutomaticPretranslateMode(mode);
  }
  runtime.shouldSchedulePagePretranslation = shouldSchedulePagePretranslation;
}
