export function installContent03(runtime) {
  function buildAheadTranslationOptions(reason) {
    return {
      manual: true,
      relaxed: true,
      allowOffscreen: true,
      reason: `ahead-${String(reason || "unknown")}`
    };
  }
  runtime.buildAheadTranslationOptions = buildAheadTranslationOptions;
  function getAheadTranslationTargets() {
    const candidates = (runtime.IS_KAKAOPAGE_READER ? runtime.collectKakaopageManualTargetCandidates(true) : Array.from(document.querySelectorAll(runtime.TARGET_SELECTOR))).filter(target => runtime.isSupportedTarget(target) && target.isConnected).filter(target => runtime.IS_KAKAOPAGE_READER ? runtime.passesKakaoAheadTargetFilter(target) : runtime.passesTargetFilter(target, true, {
      relaxed: true
    }));
    if (candidates.length === 0) {
      return [];
    }
    const viewportAnchor = window.innerHeight * 0.35;
    const isPending = target => {
      const targetKey = runtime.computeTargetKey(target);
      const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
      return target.dataset.mtLastTranslatedKey !== targetKey && target.dataset.mtLastTranslatedKey !== scopedTargetKey && target.dataset.mtNoTextKey !== targetKey && target.dataset.mtNoTextKey !== scopedTargetKey;
    };
    const pendingTargets = runtime.state.pretranslateMode === "continuous" ? runtime.selectPendingContinuousCandidates(candidates, viewportAnchor, isPending) : runtime.selectPendingAheadCandidates(candidates, viewportAnchor, isPending);
    return pendingTargets.filter(target => {
      if (target instanceof HTMLImageElement && !target.complete) {
        target.loading = "eager";
        if (target.dataset.mtAheadLoadPending !== "true") {
          target.dataset.mtAheadLoadPending = "true";
          target.addEventListener("load", () => {
            delete target.dataset.mtAheadLoadPending;
            runtime.scheduleAheadPretranslation("image-load");
          }, {
            once: true
          });
        }
        return false;
      }
      return true;
    });
  }
  runtime.getAheadTranslationTargets = getAheadTranslationTargets;
  function selectPendingAheadCandidates(candidates, viewportAnchor, isPending, aheadCount = runtime.PRETRANSLATE_AHEAD_COUNT) {
    let startIndex = candidates.findIndex(target => target.getBoundingClientRect().bottom >= viewportAnchor);
    if (startIndex < 0) {
      startIndex = Math.max(0, candidates.length - 1);
    }
    return candidates.slice(startIndex).filter(isPending).slice(0, aheadCount + 1);
  }
  runtime.selectPendingAheadCandidates = selectPendingAheadCandidates;
  function selectPendingContinuousCandidates(candidates, viewportAnchor, isPending) {
    let startIndex = candidates.findIndex(target => target.getBoundingClientRect().bottom >= viewportAnchor);
    if (startIndex < 0) {
      startIndex = Math.max(0, candidates.length - 1);
    }
    return candidates.slice(startIndex).filter(isPending);
  }
  runtime.selectPendingContinuousCandidates = selectPendingContinuousCandidates;
  function passesKakaoAheadTargetFilter(target) {
    if (!runtime.isSupportedTarget(target) || !target.isConnected || !runtime.isSitePreferredTarget(target, {
      allowLoose: true
    })) {
      return false;
    }
    const rect = target.getBoundingClientRect();
    const canonicalTarget = runtime.shouldUseKakaoCanonicalPipeline(target);
    // 领先/连续预翻译只服务正文长图。推荐横向卡片仍可在真正进入可视区后走普通翻译，
    // 但不能抢占正文的预翻译槽位。
    if (!canonicalTarget || !runtime.isKakaoEpisodeImageTarget(target)) {
      return false;
    }
    if (rect.width < 80 || rect.height < (canonicalTarget ? runtime.KAKAO_THIN_STRIP_MIN_HEIGHT : 80)) {
      return false;
    }
    if (target instanceof HTMLImageElement) {
      const naturalWidth = Number(target.naturalWidth || 0);
      const naturalHeight = Number(target.naturalHeight || 0);
      if (naturalWidth > 0 && naturalHeight > 0 && (naturalHeight < (canonicalTarget ? runtime.KAKAO_THIN_STRIP_MIN_HEIGHT : 80) || naturalHeight / naturalWidth < (canonicalTarget ? 0.01 : 0.10))) {
        return false;
      }
      // KakaoPage 推荐区封面（~98x140）不应占用预翻译槽位，确保漫画页优先。
      if (canonicalTarget && naturalWidth > 0 && naturalWidth < 200) {
        return false;
      }
    }
    return true;
  }
  runtime.passesKakaoAheadTargetFilter = passesKakaoAheadTargetFilter;
  function isKakaoShortPageQueueBlocked(target) {
    if (!runtime.IS_KAKAOPAGE_READER || runtime.shouldUseKakaoCanonicalPipeline(target)) {
      return false;
    }
    const gate = runtime.KP.getShortPageAttachmentGate(runtime.state.kakaoStore, target);
    if (gate.timedOut) {
      runtime.tracePipeline("skipped", target, {
        skipReason: "shortPageAttachmentTimeout"
      });
    } else if (gate.blocked) {
      runtime.tracePipeline("skipped", target, {
        skipReason: "shortPageAttached"
      });
    }
    return gate.blocked;
  }
  runtime.isKakaoShortPageQueueBlocked = isKakaoShortPageQueueBlocked;
  function queueTranslate(target, options) {
    if (!runtime.isSupportedTarget(target) || !target.isConnected || runtime.state.invalidated) {
      return;
    }
    if (!options.manual) {
      return;
    }
    if (runtime.maybeQueueKakaoShortPageAttachmentOwner(target, options)) {
      return;
    }
    if (runtime.isKakaoShortPageQueueBlocked(target)) {
      return;
    }
    const revisionCheck = runtime.isCanonicalRevisionCheckOptions(options);
    if (runtime.state.queuedTargets.has(target)) {
      if (revisionCheck) runtime.upgradeQueuedTranslationRequest(runtime.state.queue, target, options);
      return;
    }
    if (runtime.state.inflightByTarget.has(target)) {
      if (runtime.shouldReuseTargetInflight(target.dataset.inflightSourceToken, runtime.getTargetExecutionToken(target))) return;
    }
    const item = {
      target,
      options
    };
    const insertIndex = runtime.getTranslationQueueInsertIndex(runtime.state.queue, options);
    runtime.state.queue.splice(insertIndex, 0, item);
    runtime.state.queuedTargets.add(target);
    runtime.tracePipeline("queued", target, {
      reason: options.reason,
      targetKey: runtime.computeTargetKey(target).slice(0, 80)
    });
    runtime.pumpQueue();
  }
  runtime.queueTranslate = queueTranslate;
  function isCanonicalRevisionCheckOptions(options) {
    return options && options.force === true && options.reason === "kakao-image-revision-check";
  }
  runtime.isCanonicalRevisionCheckOptions = isCanonicalRevisionCheckOptions;
  function shouldReuseTargetInflight(inflightToken, currentExecutionToken) {
    return !!inflightToken && String(inflightToken) === String(currentExecutionToken);
  }
  runtime.shouldReuseTargetInflight = shouldReuseTargetInflight;
  function upgradeQueuedTranslationRequest(queue, target, options) {
    const queued = Array.isArray(queue) ? queue.find(item => item && item.target === target) : null;
    if (!queued) return false;
    queued.options = {
      ...(queued.options || {}),
      ...(options || {}),
      force: true
    };
    return true;
  }
  runtime.upgradeQueuedTranslationRequest = upgradeQueuedTranslationRequest;
  function isAheadTranslationOptions(options) {
    return String(options && options.reason || "").startsWith("ahead-");
  }
  runtime.isAheadTranslationOptions = isAheadTranslationOptions;
  function getTranslationQueueInsertIndex(queue, options) {
    const items = Array.isArray(queue) ? queue : [];
    if (runtime.isAheadTranslationOptions(options)) return items.length;
    const firstAhead = items.findIndex(item => runtime.isAheadTranslationOptions(item && item.options));
    return firstAhead >= 0 ? firstAhead : items.length;
  }
  runtime.getTranslationQueueInsertIndex = getTranslationQueueInsertIndex;
  function getKakaoQueueItemRect(item) {
    const target = item && item.target ? item.target : item;
    return target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
  }
  runtime.getKakaoQueueItemRect = getKakaoQueueItemRect;
  function isKakaoQueueItemVisible(item, viewportHeight = window.innerHeight) {
    const rect = runtime.getKakaoQueueItemRect(item);
    return !!(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < Number(viewportHeight || 0));
  }
  runtime.isKakaoQueueItemVisible = isKakaoQueueItemVisible;
  function takeNextKakaoTranslationQueueItem(queue, viewportHeight = window.innerHeight) {
    if (!Array.isArray(queue) || queue.length === 0) return null;
    const visibleIndex = queue.findIndex(item => runtime.isKakaoQueueItemVisible(item, viewportHeight));
    if (visibleIndex >= 0) return queue.splice(visibleIndex, 1)[0];
    let bestIndex = -1;
    let bestDistance = Infinity;
    queue.forEach((item, index) => {
      const rect = runtime.getKakaoQueueItemRect(item);
      if (!rect || rect.top < Number(viewportHeight || 0)) return;
      const distance = rect.top - Number(viewportHeight || 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) {
      queue.forEach((item, index) => {
        const rect = runtime.getKakaoQueueItemRect(item);
        if (!rect) return;
        const distance = Math.max(0, -rect.bottom);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
    }
    return bestIndex >= 0 ? queue.splice(bestIndex, 1)[0] : queue.shift() || null;
  }
  runtime.takeNextKakaoTranslationQueueItem = takeNextKakaoTranslationQueueItem;
  function canStartKakaoTranslationQueueItem(item, runningJobs, maxParallel, viewportHeight = window.innerHeight) {
    if (Number(runningJobs) >= Number(maxParallel)) return false;
    if (runtime.isKakaoQueueItemVisible(item, viewportHeight)) return true;
    return Number(runningJobs) < Math.max(0, Number(maxParallel) - 1);
  }
  runtime.canStartKakaoTranslationQueueItem = canStartKakaoTranslationQueueItem;
  function canStartQueuedTranslation(item, input = {}) {
    const runningJobs = Number(input.runningJobs || 0);
    const maxParallel = Math.max(1, Number(input.maxParallel || runtime.MAX_PARALLEL_TRANSLATIONS));
    if (runningJobs >= maxParallel) return false;
    if (!runtime.isAheadTranslationOptions(item && item.options)) return true;
    const runningAheadJobs = Number(input.runningAheadJobs || 0);
    const reservedSlots = Math.max(0, Number(input.reservedSlots ?? runtime.VISIBLE_TRANSLATION_RESERVED_SLOTS));
    return runningAheadJobs < Math.max(0, maxParallel - reservedSlots);
  }
  runtime.canStartQueuedTranslation = canStartQueuedTranslation;
  function queuePreload(target, options = {}) {
    if (!runtime.isSupportedTarget(target) || !target.isConnected || runtime.state.invalidated) {
      return;
    }
    if (!runtime.state.enabled) {
      return;
    }
    if (runtime.state.preloadQueuedTargets.has(target) || runtime.state.preloadInFlightByTarget.has(target)) {
      return;
    }
    if (options.priority === "high") {
      runtime.state.preloadQueue.unshift(target);
    } else {
      runtime.state.preloadQueue.push(target);
    }
    runtime.state.preloadQueuedTargets.add(target);
    runtime.pumpPreloadQueue();
  }
  runtime.queuePreload = queuePreload;
  function pumpQueue() {
    if (runtime.state.queueDrainScheduled) return;
    if (typeof queueMicrotask === "function") {
      runtime.state.queueDrainScheduled = true;
      queueMicrotask(() => {
        runtime.state.queueDrainScheduled = false;
        runtime.processTranslationQueue();
      });
      return;
    }
    runtime.processTranslationQueue();
  }
  runtime.pumpQueue = pumpQueue;
  function processTranslationQueue() {
    if (runtime.state.invalidated) {
      return;
    }
    while (runtime.state.runningJobs < runtime.MAX_PARALLEL_TRANSLATIONS && runtime.state.queue.length > 0) {
      const next = runtime.state.queue[0];
      if (!runtime.canStartQueuedTranslation(next, {
        runningJobs: runtime.state.runningJobs,
        runningAheadJobs: runtime.state.runningAheadJobs,
        maxParallel: runtime.MAX_PARALLEL_TRANSLATIONS,
        reservedSlots: runtime.VISIBLE_TRANSLATION_RESERVED_SLOTS
      })) {
        break;
      }
      const item = runtime.state.queue.shift();
      runtime.state.queuedTargets.delete(item.target);
      if (!item.target.isConnected) {
        continue;
      }
      const ahead = runtime.isAheadTranslationOptions(item.options);
      runtime.state.runningJobs += 1;
      if (ahead) runtime.state.runningAheadJobs += 1;
      runtime.translateTarget(item.target, item.options).catch(() => {
        // Error is handled in translateTarget.
      }).finally(() => {
        runtime.state.runningJobs -= 1;
        if (ahead) runtime.state.runningAheadJobs = Math.max(0, runtime.state.runningAheadJobs - 1);
        runtime.pumpQueue();
      });
    }
  }
  runtime.processTranslationQueue = processTranslationQueue;
  function pumpPreloadQueue() {
    if (runtime.state.invalidated) {
      return;
    }
    while (runtime.state.preloadRunningJobs < runtime.getMaxPreloadJobs() && runtime.state.preloadQueue.length > 0) {
      const target = runtime.state.preloadQueue.shift();
      runtime.state.preloadQueuedTargets.delete(target);
      if (!target || !target.isConnected) {
        continue;
      }
      runtime.state.preloadRunningJobs += 1;
      runtime.preloadTargetPayload(target).catch(() => {
        // Ignore preload errors to avoid noisy page behavior.
      }).finally(() => {
        runtime.state.preloadRunningJobs -= 1;
        runtime.pumpPreloadQueue();
      });
    }
  }
  runtime.pumpPreloadQueue = pumpPreloadQueue;
  function getMaxPreloadJobs() {
    return runtime.state.aggressivePreload ? runtime.AGGRESSIVE_PRELOAD_JOBS : runtime.MAX_PRELOAD_JOBS;
  }
  runtime.getMaxPreloadJobs = getMaxPreloadJobs;
  function getPreloadRootMargin() {
    return runtime.state.aggressivePreload ? runtime.AGGRESSIVE_PRELOAD_ROOT_MARGIN : runtime.PRELOAD_ROOT_MARGIN;
  }
  runtime.getPreloadRootMargin = getPreloadRootMargin;
}
