export function installContent24(runtime) {
  function queuePageAutoTranslate(target) {
    if (!runtime.state.autoTranslatePageEnabled || !runtime.state.enabled || runtime.state.invalidated) {
      return;
    }
    if (!runtime.isSupportedTarget(target) || !target.isConnected) {
      return;
    }
    if (runtime.maybeQueueKakaoShortPageAttachmentOwner(target, {
      manual: true,
      force: true,
      reason: "page-auto-short-attachment"
    })) {
      return;
    }
    if (runtime.isKakaoShortPageQueueBlocked(target)) {
      return;
    }
    const targetKey = runtime.computeTargetKey(target);
    const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
    if (target.dataset.mtLastTranslatedKey === targetKey || target.dataset.mtLastTranslatedKey === scopedTargetKey || target.dataset.mtNoTextKey === targetKey || target.dataset.mtNoTextKey === scopedTargetKey) {
      return;
    }
    if (runtime.IS_KAKAOPAGE_READER && !runtime.isTranslationRecoveryDue(target)) {
      return;
    }
    if (!runtime.passesTargetFilter(target, true)) {
      runtime.debugTargetFilter("queuePageAutoTranslate rejected", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        rect: (() => {
          try {
            const r = target.getBoundingClientRect();
            return `${Math.round(r.width)}x${Math.round(r.height)}`;
          } catch {
            return '?';
          }
        })()
      });
      runtime.tracePipeline("skipped", target, {
        skipReason: "filterFail"
      });
      // KakaoPage: IntersectionObserver fires early (8% visible) but geometry check
      // needs more (180px+ visible). Schedule retry so scroll-into-view images
      // don't get stuck untranslated.
      if (runtime.IS_KAKAOPAGE_READER) {
        runtime.scheduleAutoTranslateRetry(target);
      }
      return;
    }
    if (runtime.isScreenshotCaptureMode() && !runtime.getVisibleViewportRect(target)) {
      return;
    }
    if (runtime.IS_KAKAOPAGE_READER) {
      target.dataset.mtRecoveryReqAt = String(Date.now());
    }
    runtime.queueTranslate(target, {
      manual: true,
      reason: "page-auto"
    });
  }
  runtime.queuePageAutoTranslate = queuePageAutoTranslate;
  function maybeQueueKakaoShortPageAttachmentOwner(target, options = {}) {
    if (!runtime.IS_KAKAOPAGE_READER || runtime.shouldUseKakaoCanonicalPipeline(target) || !runtime.isKakaoEpisodeImageTarget(target) || runtime.state.captureMode !== runtime.CAPTURE_MODE_DIRECT || runtime.state.renderMode !== runtime.RENDER_MODE_OVERLAY || !(target instanceof HTMLImageElement) || !target.complete) {
      return false;
    }
    const attachment = runtime.findKakaoShortPageAttachmentOwner(target);
    if (!attachment || !attachment.owner || attachment.owner === target) {
      return false;
    }
    const owner = attachment.owner;
    const ownerKey = runtime.computeTargetKey(owner);
    const ownerScopedKey = runtime.buildTargetSourceCacheKey(ownerKey, runtime.getQuickSourceToken(owner));
    if (!runtime.KP.attachShortPageIfAllowed(runtime.state.kakaoStore, target, ownerScopedKey)) {
      runtime.tracePipeline("short-attachment-suppressed", target, {
        ownerScopedKey
      });
      return false;
    }
    target.dataset.mtNoTextKey = "";
    runtime.tracePipeline("short-attached", target, {
      attachedToKey: ownerScopedKey
    });
    runtime.state.payloadCacheByTargetKey.delete(ownerKey);
    runtime.state.payloadCacheByTargetKey.delete(ownerScopedKey);
    runtime.state.localResultCache.delete(ownerKey);
    runtime.state.localResultCache.delete(ownerScopedKey);
    owner.dataset.mtLastTranslatedKey = "";
    owner.dataset.mtNoTextKey = "";
    runtime.queueTranslate(owner, {
      ...options,
      manual: true,
      force: true,
      reason: `${String(options.reason || "kakao-short-page")}:${attachment.direction}`
    });
    return true;
  }
  runtime.maybeQueueKakaoShortPageAttachmentOwner = maybeQueueKakaoShortPageAttachmentOwner;
  function findKakaoShortPageAttachmentOwner(target) {
    const candidates = runtime.collectKakaopageManualTargetCandidates(true, target).filter(candidate => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete);
    return runtime.KP.findKakaoShortPageAttachmentOwner(target, candidates, runtime.describeKakaoStitchTarget);
  }
  runtime.findKakaoShortPageAttachmentOwner = findKakaoShortPageAttachmentOwner;
  function releaseShortPagesAttachedDuringInflight(owner) {
    if (!owner || typeof owner.getBoundingClientRect !== "function") {
      return;
    }
    const ownerKey = runtime.computeTargetKey(owner);
    const ownerScopedKey = runtime.buildTargetSourceCacheKey(ownerKey, runtime.getQuickSourceToken(owner));
    if (!ownerScopedKey) return;
    const released = runtime.KP.releaseShortPagesForOwner(runtime.state.kakaoStore, runtime.collectKakaopageManualTargetCandidates(true, owner).filter(candidate => candidate !== owner), ownerScopedKey);
    for (const candidate of released) {
      // 这个短页在 owner inflight 期间被附着 → owner 的 payload 不包含它
      // 释放标记，让短页走独立翻译流程
      delete candidate.dataset.mtNoTextKey;
      delete candidate.dataset.mtLastTranslatedKey;
      runtime.tracePipeline("short-detached", candidate, {
        reason: "ownerInflightCompleted",
        ownerScopedKey
      });
      runtime.queuePageAutoTranslate(candidate);
    }
  }
  runtime.releaseShortPagesAttachedDuringInflight = releaseShortPagesAttachedDuringInflight;
  function releaseUncoveredKakaoShortPages(payload, result, owner, reason) {
    // 仅释放未被 owner stitch 结果覆盖的短页。
    // 若 owner 结果中已有短页气泡（stitch_attached_short_page），说明短页文字已通过
    // 拼接 OCR 翻译并渲染在 owner overlay 上，无需再独立翻译，避免出现重复译文。
    if (!runtime.IS_KAKAOPAGE_READER || !payload || runtime.hasAttachedShortPageBubble(result)) {
      return 0;
    }
    const attachedShortPageKeys = Array.isArray(payload.attachedShortPageKeys) ? payload.attachedShortPageKeys.filter(Boolean) : [];
    if (attachedShortPageKeys.length === 0) {
      return 0;
    }
    const ownerKey = owner ? runtime.computeTargetKey(owner) : "";
    const ownerScopedKey = owner ? runtime.buildTargetSourceCacheKey(ownerKey, runtime.getQuickSourceToken(owner)) : "";
    let released = 0;
    for (const shortKey of attachedShortPageKeys) {
      const el = runtime.findTargetByScopedKey(shortKey);
      if (!el) {
        runtime.tracePipeline("short-detached", null, {
          reason: `findTargetByScopedKey returned null for ${String(shortKey).slice(0, 80)}`,
          ownerScopedKey
        });
        continue;
      }
      runtime.KP.releaseShortPagesForOwner(runtime.state.kakaoStore, [el], ownerScopedKey);
      delete el.dataset.mtNoTextKey;
      delete el.dataset.mtLastTranslatedKey;
      runtime.tracePipeline("short-detached", el, {
        reason,
        ownerScopedKey
      });
      released += 1;

      // 使用 queuePageAutoTranslate 而非 queueTranslate，确保有 retry 保护和 filter 重试机制
      runtime.queuePageAutoTranslate(el);
    }
    return released;
  }
  runtime.releaseUncoveredKakaoShortPages = releaseUncoveredKakaoShortPages;
  function hasAttachedShortPageBubble(result) {
    return !!(result && Array.isArray(result.bubbles) && result.bubbles.some(bubble => bubble && bubble.stitch_attached_short_page === true));
  }
  runtime.hasAttachedShortPageBubble = hasAttachedShortPageBubble;
  function scheduleAutoTranslateRetry(target) {
    return runtime.kakaoRetryScheduler.schedule(target);
  }
  runtime.scheduleAutoTranslateRetry = scheduleAutoTranslateRetry;
  function clearAutoTranslateRetryTimers() {
    runtime.kakaoRetryScheduler.clear();
  }
  runtime.clearAutoTranslateRetryTimers = clearAutoTranslateRetryTimers;
  function collectVisibleTargets(options = {}) {
    const relaxed = options.relaxed === true;
    const includeLimit = options.includeLimit !== false;
    const limit = runtime.IS_CMOA_SPEED_READER ? 6 : runtime.MAX_MANUAL_TARGETS;
    const targets = runtime.getManualTargetCandidates(relaxed).filter(target => runtime.isSupportedTarget(target) && runtime.passesTargetFilter(target, true, {
      relaxed
    })).filter(target => runtime.isRectVisible(target.getBoundingClientRect())).map(target => ({
      target,
      area: runtime.getVisibleArea(target.getBoundingClientRect())
    })).sort((left, right) => right.area - left.area).map(item => item.target);
    if (runtime.IS_KAKAOPAGE_READER) {
      console.info("[MangaTranslator][KakaoPage] visible OCR targets", targets.slice(0, includeLimit ? limit : 6).map(target => {
        const rect = target.getBoundingClientRect();
        const url = target instanceof HTMLImageElement ? runtime.resolveImageUrl(target) : "";
        const filename = (url.match(/filename=([^&]+)/) || [])[1] || "";
        return {
          filename,
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          visibleArea: Math.round(runtime.getVisibleArea(rect))
        };
      }));
    }
    return includeLimit ? targets.slice(0, limit) : targets;
  }
  runtime.collectVisibleTargets = collectVisibleTargets;
  function getManualTargetCandidates(relaxed) {
    if (runtime.IS_KAKAOPAGE_READER) {
      return runtime.collectKakaopageManualTargetCandidates(relaxed);
    }
    if (!runtime.IS_CMOA_SPEED_READER || relaxed) {
      return Array.from(document.querySelectorAll(runtime.TARGET_SELECTOR));
    }
    const selectors = ["#content .pt-img img", "#content [id^='content-p'] img", "#content img", "#content canvas", runtime.TARGET_SELECTOR];
    const seen = new Set();
    const result = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(target => {
        if (!seen.has(target)) {
          seen.add(target);
          result.push(target);
        }
      });
    }
    return result.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
    });
  }
  runtime.getManualTargetCandidates = getManualTargetCandidates;
  function collectKakaopageManualTargetCandidates(relaxed, ownerTarget = null) {
    const selectors = [runtime.TARGET_SELECTOR, "main img", "main canvas", "main [style*='background-image']", "[class*='viewer'] img", "[class*='viewer'] canvas", "[class*='viewer'] [style*='background-image']", "[class*='page'] img", "[class*='page'] canvas", "[class*='page'] [style*='background-image']"];
    const seen = new Set();
    const raw = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(target => {
        if (!seen.has(target)) {
          seen.add(target);
          raw.push(target);
        }
      });
    }
    const scanLimit = relaxed ? 1400 : 800;
    const candidates = Array.from(document.querySelectorAll("main *, body *")).slice(0, scanLimit);
    candidates.forEach(target => {
      if (!seen.has(target) && target instanceof HTMLElement && runtime.isBackgroundImageTarget(target)) {
        seen.add(target);
        raw.push(target);
      }
    });
    const ownerRect = ownerTarget && typeof ownerTarget.getBoundingClientRect === "function" ? ownerTarget.getBoundingClientRect() : null;
    const ownerCenter = ownerRect && ownerRect.width > 0 ? ownerRect.left + ownerRect.width / 2 : null;
    const result = raw.filter(target => {
      if (!target || !target.isConnected || typeof target.getBoundingClientRect !== "function") {
        return false;
      }
      const rect = target.getBoundingClientRect();
      if (!(rect.width >= 1 && rect.height >= 1)) {
        return false;
      }

      // Visibility check: skip hidden elements
      try {
        const style = window.getComputedStyle(target);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
      } catch (_) {
        // ignore getComputedStyle errors
      }
      if (target instanceof HTMLImageElement) {
        const src = target.currentSrc || target.src || "";
        if (!src || !target.complete) return false;
        const naturalWidth = Number(target.naturalWidth || 0);
        const naturalHeight = Number(target.naturalHeight || 0);
        if (!(naturalWidth >= 1 && naturalHeight >= 1)) {
          return false;
        }
      }

      // Neighbor-finding mode: apply size + center proximity filters.
      // Accept thin strips (down to 8px) so they can be stitched into
      // adjacent pages instead of being dropped entirely.
      if (ownerRect) {
        const thinStripMinHeight = runtime.KAKAO_THIN_STRIP_MIN_HEIGHT;
        if (!(rect.width >= 200 && rect.height >= thinStripMinHeight)) {
          return false;
        }
        if (target instanceof HTMLImageElement) {
          const naturalWidth = Number(target.naturalWidth || 0);
          const naturalHeight = Number(target.naturalHeight || 0);
          if (!(naturalWidth >= 60 && naturalHeight >= thinStripMinHeight)) {
            return false;
          }
        }
        if (ownerCenter !== null) {
          const center = rect.left + rect.width / 2;
          const maxCenterDelta = Math.max(rect.width, ownerRect.width) * 0.15;
          if (Math.abs(center - ownerCenter) > maxCenterDelta) {
            return false;
          }
        }
      }
      return true;
    });

    // Always sort by visual position (scroll-adjusted), secondary by left
    return result.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftTop = leftRect.top + (window.scrollY || 0);
      const rightTop = rightRect.top + (window.scrollY || 0);
      if (Math.abs(leftTop - rightTop) > 2) {
        return leftTop - rightTop;
      }
      return leftRect.left - rightRect.left;
    });
  }
  runtime.collectKakaopageManualTargetCandidates = collectKakaopageManualTargetCandidates;
}
