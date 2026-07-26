export function installRecognitionBinding(runtime) {
  function unbindKakaoTargetFromPage(target) {
    if (!target) return;
    const pageId = runtime.state.kakaoPageIdByTarget.get(target);
    runtime.state.kakaoPageIdByTarget.delete(target);
    runtime.state.kakaoImageRevisionByTarget.delete(target);
    if (!pageId) return;
    const targets = runtime.state.kakaoTargetsByPageId.get(pageId);
    if (!targets) return;
    targets.delete(target);
    if (targets.size === 0) runtime.state.kakaoTargetsByPageId.delete(pageId);
  }
  runtime.unbindKakaoTargetFromPage = unbindKakaoTargetFromPage;
  function detachKakaoTargetHandle(target) {
    if (!target) return "";
    const pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId) return "";
    const targets = runtime.state.kakaoTargetsByPageId.get(pageId);
    if (targets) {
      targets.delete(target);
      if (targets.size === 0) runtime.state.kakaoTargetsByPageId.delete(pageId);
    }
    if (runtime.state.kakaoStore && typeof runtime.state.kakaoStore.unbindPageTarget === "function") {
      runtime.state.kakaoStore.unbindPageTarget(target);
    }
    return pageId;
  }
  runtime.detachKakaoTargetHandle = detachKakaoTargetHandle;
  function detachKakaoTargetForSourceChange(target, scheduleRefresh = runtime.scheduleKakaoProjectionRefresh) {
    if (!target) return "";
    const pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    runtime.unbindKakaoTargetFromPage(target);
    if (runtime.state.kakaoStore && typeof runtime.state.kakaoStore.unbindPageTarget === "function") {
      runtime.state.kakaoStore.unbindPageTarget(target);
    }
    // 新图片尚未完成 OCR 时，也要立刻让旧 canonical 的 standby 接管。
    if (pageId && typeof scheduleRefresh === "function") {
      scheduleRefresh([pageId], "page-handle-source-changed");
    }
    return pageId;
  }
  runtime.detachKakaoTargetForSourceChange = detachKakaoTargetForSourceChange;
  function getKakaoTargetGeneration(target) {
    return Math.max(0, Number(target && target.dataset && target.dataset.mtKakaoSourceGeneration) || 0);
  }
  runtime.getKakaoTargetGeneration = getKakaoTargetGeneration;
  function buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target) {
    return `${String(scopedTargetKey || "")}|generation:${runtime.getKakaoTargetGeneration(target)}`;
  }
  runtime.buildKakaoCanonicalPayloadCacheKey = buildKakaoCanonicalPayloadCacheKey;
  function getTargetExecutionToken(target) {
    return `${runtime.getQuickSourceToken(target)}|generation:${runtime.getKakaoTargetGeneration(target)}`;
  }
  runtime.getTargetExecutionToken = getTargetExecutionToken;
  function shouldRevalidateReconnectedKakaoTarget(target) {
    const pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId || !runtime.state.kakaoStore || typeof runtime.state.kakaoStore.getPageHandle !== "function") return false;
    const handle = runtime.state.kakaoStore.getPageHandle(pageId);
    return !!handle && (!handle.target || handle.target.isConnected === false);
  }
  runtime.shouldRevalidateReconnectedKakaoTarget = shouldRevalidateReconnectedKakaoTarget;
  function shouldRevalidateKakaoImageLoad(target) {
    const pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId || !runtime.state.kakaoStore || typeof runtime.state.kakaoStore.getPageHandle !== "function") return false;
    const handle = runtime.state.kakaoStore.getPageHandle(pageId);
    return !!handle && (handle.target === target || !handle.target || handle.target.isConnected === false);
  }
  runtime.shouldRevalidateKakaoImageLoad = shouldRevalidateKakaoImageLoad;
  function prepareKakaoTargetRevisionCheck(target, reason = "image-reload") {
    if (!target || !target.dataset) return 0;
    const previousPageId = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    const nextGeneration = runtime.getKakaoTargetGeneration(target) + 1;
    target.dataset.mtKakaoSourceGeneration = String(nextGeneration);
    target.dataset.mtKakaoRevisionCheck = "true";
    const targetKey = runtime.computeTargetKey(target);
    const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
    runtime.state.payloadCacheByTargetKey.delete(targetKey);
    runtime.state.payloadCacheByTargetKey.delete(scopedTargetKey);
    runtime.state.payloadCacheByTargetKey.delete(runtime.buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target));
    runtime.state.payloadCacheByTargetKey.delete(`${scopedTargetKey}|stitch`);
    runtime.state.localResultCache.delete(scopedTargetKey);
    if (previousPageId) {
      runtime.unbindKakaoTargetFromPage(target);
      if (runtime.state.kakaoStore && typeof runtime.state.kakaoStore.unbindPageTarget === "function") {
        runtime.state.kakaoStore.unbindPageTarget(target);
      }
      runtime.clearRenderedTarget(target);
      if (typeof window.setTimeout === "function") {
        runtime.scheduleKakaoProjectionRefresh([previousPageId], "page-image-revision-check");
      }
    }
    runtime.tracePipeline("canonical-revision-check", target, {
      reason,
      generation: nextGeneration
    });
    return nextGeneration;
  }
  runtime.prepareKakaoTargetRevisionCheck = prepareKakaoTargetRevisionCheck;
  function scheduleKakaoProjectionRefresh(pageIds, reason) {
    if (!runtime.kakaoCanonicalPipeline || typeof runtime.kakaoCanonicalPipeline.refresh !== "function") return;
    for (const pageId of Array.isArray(pageIds) ? pageIds : [pageIds]) {
      if (pageId) runtime.state.kakaoProjectionRefreshPageIds.add(String(pageId));
    }
    if (runtime.state.kakaoProjectionRefreshTimer || runtime.state.kakaoProjectionRefreshPageIds.size === 0) return;
    runtime.state.kakaoProjectionRefreshTimer = window.setTimeout(() => {
      runtime.state.kakaoProjectionRefreshTimer = 0;
      const focusPageIds = [...runtime.state.kakaoProjectionRefreshPageIds];
      runtime.state.kakaoProjectionRefreshPageIds.clear();
      Promise.resolve(runtime.kakaoCanonicalPipeline.refresh({
        reason: String(reason || "page-handle-change"),
        focusPageIds
      })).catch(error => {
        console.warn("[MangaTranslator][Kakao canonical] projection refresh failed:", error);
      });
    }, 0);
  }
  runtime.scheduleKakaoProjectionRefresh = scheduleKakaoProjectionRefresh;
  function restoreKnownKakaoPageHandle(target, scheduleRefresh = runtime.scheduleKakaoProjectionRefresh) {
    if (!target || !runtime.shouldUseKakaoCanonicalPipeline(target)) return "";
    const store = runtime.state.kakaoStore;
    if (!store || typeof store.getPageHandle !== "function") return "";
    let pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    if (!pageId && typeof store.getPageHandles === "function") {
      const sourceToken = String(runtime.getQuickSourceToken(target) || "");
      const matches = sourceToken ? store.getPageHandles().filter(handle =>
        handle && String(handle.sourceToken || "") === sourceToken
      ) : [];
      // 只接受唯一、完全相同的图片 token；避免把复用 DOM 误绑到旧 revision。
      if (matches.length === 1) pageId = String(matches[0].pageId || "");
    }
    if (!pageId) return "";
    const previous = store.getPageHandle(pageId);
    if (!previous || previous.imageRevision == null) return "";
    const expectedSourceToken = String(previous.sourceToken || "");
    if (expectedSourceToken && String(runtime.getQuickSourceToken(target) || "") !== expectedSourceToken) return "";
    const boundRevision = String(runtime.state.kakaoImageRevisionByTarget.get(target) || "");
    if (boundRevision && boundRevision !== String(previous.imageRevision || "")) return "";
    const boundTargets = runtime.state.kakaoTargetsByPageId.get(pageId);
    if (runtime.isCurrentKakaoPageBinding(target, pageId, previous, boundRevision, boundTargets)) {
      return pageId;
    }
    runtime.bindKakaoTargetToPage(target, pageId, previous.imageRevision);
    if (typeof store.registerPageHandle === "function") {
      store.registerPageHandle({
        ...previous,
        target,
        targetKey: runtime.computeTargetKey(target),
        scopedTargetKey: runtime.buildTargetSourceCacheKey(runtime.computeTargetKey(target), runtime.getQuickSourceToken(target)),
        sourceToken: runtime.getQuickSourceToken(target)
      });
    }
    if (typeof scheduleRefresh === "function") {
      scheduleRefresh([pageId], "page-handle-restored");
    }
    return pageId;
  }
  runtime.restoreKnownKakaoPageHandle = restoreKnownKakaoPageHandle;
  function isCurrentKakaoPageBinding(target, pageId, handle, boundRevision, boundTargets) {
    return !!(target && target.isConnected !== false && pageId && handle && handle.target === target && String(boundRevision || "") === String(handle.imageRevision || "") && boundTargets && typeof boundTargets.has === "function" && boundTargets.has(target));
  }
  runtime.isCurrentKakaoPageBinding = isCurrentKakaoPageBinding;
  function getTargetForKakaoPageId(pageId) {
    const normalizedPageId = String(pageId || "");
    const targets = runtime.state.kakaoTargetsByPageId.get(normalizedPageId);
    if (!targets) return null;
    const isUsable = target => !!target && target.isConnected && runtime.state.kakaoPageIdByTarget.get(target) === normalizedPageId && runtime.shouldUseKakaoCanonicalPipeline(target);
    const currentHandleTarget = runtime.state.kakaoStore && typeof runtime.state.kakaoStore.getPageHandle === "function" ? runtime.state.kakaoStore.getPageHandle(normalizedPageId)?.target : null;
    const currentImageRevision = runtime.state.kakaoStore && typeof runtime.state.kakaoStore.getPageHandle === "function" ? String(runtime.state.kakaoStore.getPageHandle(normalizedPageId)?.imageRevision || "") : "";
    let bestTarget = null;
    let bestVisibleArea = -1;
    for (const target of Array.from(targets)) {
      if (!isUsable(target) || currentImageRevision && String(runtime.state.kakaoImageRevisionByTarget.get(target) || "") !== currentImageRevision) {
        targets.delete(target);
        continue;
      }
      let visibleArea = 0;
      try {
        visibleArea = runtime.getVisibleArea(target.getBoundingClientRect());
      } catch {
        visibleArea = 0;
      }
      // 可见面积优先；面积相同时优先 Store 当前句柄，其次取后绑定 clone。
      if (visibleArea > bestVisibleArea || visibleArea === bestVisibleArea && target === currentHandleTarget || visibleArea === bestVisibleArea && bestTarget !== currentHandleTarget) {
        bestTarget = target;
        bestVisibleArea = visibleArea;
      }
    }
    if (targets.size === 0) runtime.state.kakaoTargetsByPageId.delete(normalizedPageId);
    return bestTarget;
  }
  runtime.getTargetForKakaoPageId = getTargetForKakaoPageId;
  function findAdjacentKakaoPageTargets(target) {
    const targets = runtime.collectKakaopageManualTargetCandidates(true, target).filter(candidate => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete);
    const entries = runtime.buildKakaoStitchCandidateEntries(targets);
    const ownerIndex = entries.findIndex(entry => entry && entry.target === target);
    if (ownerIndex < 0) {
      return {
        previous: null,
        next: null
      };
    }
    return {
      previous: runtime.findKakaoStitchNeighborTarget(entries, ownerIndex, "previous"),
      next: runtime.findKakaoStitchNeighborTarget(entries, ownerIndex, "next")
    };
  }
  runtime.findAdjacentKakaoPageTargets = findAdjacentKakaoPageTargets;
  async function detectAdjacentKakaoPixelRisk(pageARecord, pageBRecord) {
    const payloadA = pageARecord && pageARecord.payload;
    const payloadB = pageBRecord && pageBRecord.payload;
    const fragmentRisk = runtime.hasKakaoFragmentStructureRisk(pageARecord) || runtime.hasKakaoFragmentStructureRisk(pageBRecord);
    if (!payloadA || !payloadB || !runtime.isDataUrl(payloadA.dataUrl) || !runtime.isDataUrl(payloadB.dataUrl)) {
      return fragmentRisk ? Object.freeze({
        risk: true,
        fragmentRisk: true
      }) : null;
    }
    const [imageA, imageB] = await Promise.all([runtime.loadImageFromDataUrl(payloadA.dataUrl), runtime.loadImageFromDataUrl(payloadB.dataUrl)]);
    const overlap = runtime.findKakaoVerticalOverlap(runtime.sampleKakaoImageForOverlap(imageA), runtime.sampleKakaoImageForOverlap(imageB));
    if (overlap && overlap.accepted) {
      return Object.freeze({
        ...overlap,
        risk: true,
        ...(fragmentRisk ? {
          fragmentRisk: true
        } : {})
      });
    }
    return fragmentRisk ? Object.freeze({
      risk: true,
      fragmentRisk: true
    }) : null;
  }
  runtime.detectAdjacentKakaoPixelRisk = detectAdjacentKakaoPixelRisk;
  function hasKakaoFragmentStructureRisk(record) {
    if (!record || typeof runtime.KP.isKakaoPageEdgeFragment !== "function") return false;
    const identity = record.identity || record.pageIdentity || record;
    const payload = record.payload || {};
    const width = Math.max(1, Number(identity.width || payload.sourceWidth || payload.width || 0));
    const height = Math.max(1, Number(identity.height || payload.sourceHeight || payload.height || 0));
    const sourceKey = String(identity.stableSource || payload.imageUrl || record.sourceToken || "");
    return runtime.KP.isKakaoPageEdgeFragment({
      owner: {
        sourceKey,
        width,
        height
      },
      canonicalWidth: width,
      ownerHeight: height
    });
  }
  runtime.hasKakaoFragmentStructureRisk = hasKakaoFragmentStructureRisk;
  function calculateKakaoSeamCaptureBandHeight(widthA, widthB, requestedHeight = 0) {
    const defaultHeight = Math.min(Number(widthA) || 0, Number(widthB) || 0) * runtime.KAKAO_SEAM_CAPTURE_WIDTH_RATIO;
    const value = Number(requestedHeight) || defaultHeight;
    return Math.max(runtime.KAKAO_SEAM_CAPTURE_MIN_PX, Math.min(runtime.KAKAO_SEAM_CAPTURE_MAX_PX, Math.round(value)));
  }
  runtime.calculateKakaoSeamCaptureBandHeight = calculateKakaoSeamCaptureBandHeight;

  const isKakaoPageEdgeSource = runtime.KP.isKakaoPageEdgeSource;

  // Kakao page-edge CDN URLs must include authentication parameters
  // (signature, credential, expires) to be fetchable. If the URL lacks
  // these, wait briefly for the page's JS to inject them.
  runtime.isKakaoPageEdgeSource = isKakaoPageEdgeSource;
  const KAKAO_EDGE_AUTH_PARAM_RE = /[?&](?:signature|credential|expires)=/i;
  runtime.KAKAO_EDGE_AUTH_PARAM_RE = KAKAO_EDGE_AUTH_PARAM_RE;
  const KAKAO_EDGE_URL_WAIT_MS = 600;
  runtime.KAKAO_EDGE_URL_WAIT_MS = KAKAO_EDGE_URL_WAIT_MS;
  const KAKAO_EDGE_URL_POLL_MS = 50;
  runtime.KAKAO_EDGE_URL_POLL_MS = KAKAO_EDGE_URL_POLL_MS;
}
