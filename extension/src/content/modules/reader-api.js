export function installReaderApi(runtime) {
  const kakaoRetryScheduler = runtime.KP.createRetryScheduler({
    store: runtime.state.kakaoStore,
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: timer => window.clearTimeout(timer),
    isPlaceholder: target => target instanceof HTMLImageElement && runtime.isDataUrl(runtime.resolveImageUrl(target)),
    isTargetUsable: target => !!target && target.isConnected && !runtime.state.invalidated,
    isTargetReady: target => target instanceof HTMLImageElement && target.complete && runtime.passesTargetFilter(target, true),
    onReady: runtime.queuePageAutoTranslate
  });
  runtime.kakaoRetryScheduler = kakaoRetryScheduler;
  const kakaoLegacyPipeline = runtime.KP && typeof runtime.KP.createPipeline === "function" ? runtime.KP.createPipeline({
    store: runtime.state.kakaoStore,
    extractTargetPayload: (target, scopedKey) => runtime.extractTargetPayload(target, scopedKey, {
      skipKakaoStitch: true,
      forceLegacyKakao: true
    }),
    requestTranslationForPayload: runtime.requestTranslationForPayload,
    renderTranslationResult: runtime.renderTranslationResult,
    clearRenderedTarget: runtime.clearRenderedTarget,
    renderOverlay: runtime.renderOverlay,
    computeTargetKey: runtime.computeTargetKey,
    getQuickSourceToken: runtime.getQuickSourceToken,
    buildTargetSourceCacheKey: runtime.buildTargetSourceCacheKey,
    captureTargetSnapshot: runtime.captureTargetSnapshot,
    isTargetSnapshotStillValid: runtime.isTargetSnapshotStillValid,
    shouldUseKakaoStitchedOcr: runtime.shouldUseKakaoStitchedOcr,
    buildKakaoStitchedPayload: runtime.buildKakaoStitchedPayload,
    mapStitchedResult: runtime.mapKakaoStitchedResultForPipeline,
    dedupeResult: runtime.dedupeKakaoResultByPageCoordinates,
    renderLoadingOverlay: runtime.renderLoadingOverlay,
    renderPipelineResult: runtime.renderKakaoPipelineResult,
    renderCachedPipelineResult: runtime.renderCachedKakaoPipelineResult,
    releaseAttachedShortPagesOnError: runtime.releaseKakaoPipelineErrorAttachments,
    reportPipelineError: runtime.reportKakaoPipelineError,
    findTargetByScopedKey: runtime.findTargetByScopedKey,
    queueTranslate: runtime.queueTranslate,
    queuePageAutoTranslate: runtime.queuePageAutoTranslate,
    scheduleAutoTranslateRetry: runtime.scheduleAutoTranslateRetry,
    tracePipeline: runtime.tracePipeline,
    state: runtime.state
  }) : null;
  runtime.kakaoLegacyPipeline = kakaoLegacyPipeline;
  const kakaoCanonicalPipeline = runtime.KP && runtime.KR && typeof runtime.KP.createCanonicalPipeline === "function" ? runtime.KP.createCanonicalPipeline({
    store: runtime.state.kakaoStore,
    reconciler: runtime.KR,
    extractTargetPayload: (target, scopedKey) => runtime.extractTargetPayload(target, runtime.buildKakaoCanonicalPayloadCacheKey(scopedKey, target), {
      skipKakaoStitch: true
    }),
    buildPageIdentity: runtime.buildKakaoPageIdentity,
    commitPageIdentity: (target, identity) => runtime.bindKakaoTargetToPage(target, identity && identity.pageId, identity && identity.imageRevision),
    requestOcrForPayload: runtime.requestOcrForPayload,
    requestCanonicalTranslations: runtime.requestCanonicalTranslations,
    findAdjacentPageTargets: runtime.findAdjacentKakaoPageTargets,
    resolvePageRecord: target => {
      return runtime.state.kakaoStore && typeof runtime.state.kakaoStore.getPageHandleForTarget === "function" ? runtime.state.kakaoStore.getPageHandleForTarget(target) : null;
    },
    buildSeamPayload: runtime.buildKakaoSeamPayload,
    detectAdjacentPixelRisk: runtime.detectAdjacentKakaoPixelRisk,
    getTargetForPageId: runtime.getTargetForKakaoPageId,
    renderCanonicalProjections: runtime.renderCanonicalProjections,
    clearCanonicalProjection: target => runtime.clearRenderedTarget(target),
    computeTargetKey: runtime.computeTargetKey,
    getQuickSourceToken: runtime.getQuickSourceToken,
    buildTargetSourceCacheKey: runtime.buildTargetSourceCacheKey,
    captureTargetSnapshot: runtime.captureTargetSnapshot,
    isTargetSnapshotStillValid: runtime.isTargetSnapshotStillValid,
    getTargetGeneration: runtime.getKakaoTargetGeneration,
    renderLoadingOverlay: runtime.renderLoadingOverlay,
    clearLoadingOverlay: runtime.clearKakaoLoadingOverlay,
    scheduleAutoTranslateRetry: runtime.scheduleAutoTranslateRetry,
    reportPipelineError: runtime.reportKakaoPipelineError,
    tracePipeline: runtime.tracePipeline,
    targetLanguage: runtime.KAKAO_CANONICAL_TARGET_LANGUAGE,
    sourceLanguage: runtime.KAKAO_CANONICAL_SOURCE_LANGUAGE,
    edgeWaitTimeoutMs: 8000
  }) : null;
  runtime.kakaoCanonicalPipeline = kakaoCanonicalPipeline;
  const kakaoPipeline = runtime.kakaoCanonicalPipeline || runtime.kakaoLegacyPipeline;
  runtime.kakaoPipeline = kakaoPipeline;
  const api = {
    invalidated: false,
    rescan: runtime.rescan,
    manualTranslateVisible: runtime.manualTranslateVisible,
    togglePageAutoTranslate: runtime.togglePageAutoTranslate,
    getPageAutoTranslateStatus: runtime.getPageAutoTranslateStatus,
    __test: {
      /** 直接访问 pipeline 模块（只读） */
      get pipeline() {
        return globalThis.MangaTranslatorKakaoPipeline;
      },
      /** 访问 Store（已封装） */
      get kakaoStore() {
        return runtime.state.kakaoStore;
      },
      get kakaoPipeline() {
        return runtime.kakaoPipeline;
      },
      get kakaoCanonicalPipeline() {
        return runtime.kakaoCanonicalPipeline;
      },
      get kakaoLegacyPipeline() {
        return runtime.kakaoLegacyPipeline;
      },
      mapKakaoStitchedResult: runtime.mapKakaoStitchedResult,
      dedupeKakaoResultByPageCoordinates: runtime.dedupeKakaoResultByPageCoordinates,
      buildKakaoStitchWindowPlan: runtime.buildKakaoStitchWindowPlan,
      findKakaoStitchNeighborTarget: runtime.findKakaoStitchNeighborTarget,
      isVerifiedKakaoStitchNeighbor: runtime.isVerifiedKakaoStitchNeighbor,
      shouldFallbackFromKakaoStitch: runtime.shouldFallbackFromKakaoStitch,
      hasKakaoFragmentStructureRisk: runtime.hasKakaoFragmentStructureRisk,
      shouldRejectKakaoPageEdgeStitch: runtime.shouldRejectKakaoPageEdgeStitch,
      buildOcrRequestKey: runtime.buildOcrRequestKey,
      shouldUseKakaoCanonicalPipeline: runtime.shouldUseKakaoCanonicalPipeline,
      isKakaoEpisodeImageTarget: runtime.isKakaoEpisodeImageTarget,
      calculateKakaoSeamCaptureBandHeight: runtime.calculateKakaoSeamCaptureBandHeight,
      isMangaTranslatorOverlayTarget: runtime.isMangaTranslatorOverlayTarget,
      isSupportedTarget: runtime.isSupportedTarget,
      normalizeKakaoStableImageSource: runtime.normalizeKakaoStableImageSource,
      buildKakaoPageIdentity: runtime.buildKakaoPageIdentity,
      buildOcrMessageForPayload: runtime.buildOcrMessageForPayload,
      requestOcrForPayload: runtime.requestOcrForPayload,
      detachKakaoTargetForSourceChange: runtime.detachKakaoTargetForSourceChange,
      getTargetForKakaoPageId: runtime.getTargetForKakaoPageId,
      prepareKakaoTargetRevisionCheck: runtime.prepareKakaoTargetRevisionCheck,
      captureTargetSnapshot: runtime.captureTargetSnapshot,
      isTargetSnapshotStillValid: runtime.isTargetSnapshotStillValid,
      shouldReuseTargetInflight: runtime.shouldReuseTargetInflight,
      upgradeQueuedTranslationRequest: runtime.upgradeQueuedTranslationRequest,
      normalizeOcrObservationResult: runtime.normalizeOcrObservationResult,
      projectionToRendererBubble: runtime.projectionToRendererBubble,
      normalizeProjectionPages: runtime.normalizeProjectionPages,
      normalizeSeamRenderSurfaces: runtime.normalizeSeamRenderSurfaces,
      getSeamSurfaceHostPageId: runtime.getSeamSurfaceHostPageId,
      getSeamSegmentTransform: runtime.getSeamSegmentTransform,
      buildSeamSurfaceRenderSignature: runtime.buildSeamSurfaceRenderSignature,
      buildOverlayDebugRenderSignature: runtime.buildOverlayDebugRenderSignature,
      isSeamSurfaceRenderable: runtime.isSeamSurfaceRenderable,
      syncSeamOverlayTransforms: runtime.syncSeamOverlayTransforms,
      setSeamSourceModeForOverlays: runtime.setSeamSourceModeForOverlays,
      toggleSeamSourceMode: runtime.toggleSeamSourceMode,
      classifyCanonicalProjectionRender: runtime.classifyCanonicalProjectionRender,
      isCanonicalRenderComplete: runtime.isCanonicalRenderComplete,
      hasRenderableOcrDebug: runtime.hasRenderableOcrDebug,
      getRenderableOcrDebugStages: runtime.getRenderableOcrDebugStages,
      normalizeDebugCoordinateItems: runtime.normalizeDebugCoordinateItems,
      normalizePretranslateMode: runtime.normalizePretranslateMode,
      matchesTargetMarker: runtime.matchesTargetMarker,
      hasSettledTranslatedMarker: runtime.hasSettledTranslatedMarker,
      hasSettledNoTextMarker: runtime.hasSettledNoTextMarker,
      hasPendingTranslationMarkerState: runtime.hasPendingTranslationMarkerState,
      isTranslationRecoveryDue: runtime.isTranslationRecoveryDue,
      isReusableRenderedState: runtime.isReusableRenderedState,
      shouldPreserveOverlayDuringLoading: runtime.shouldPreserveOverlayDuringLoading,
      ensureLoadingStatusCard: runtime.ensureLoadingStatusCard,
      isReusableKakaoReadyPageBinding: runtime.isReusableKakaoReadyPageBinding,
      isCurrentKakaoPageBinding: runtime.isCurrentKakaoPageBinding,
      buildOverlayRenderSignature: runtime.buildOverlayRenderSignature,
      isSameOverlayRenderPayload: runtime.isSameOverlayRenderPayload,
      passesKakaoAheadTargetFilter: runtime.passesKakaoAheadTargetFilter,
      isAheadTranslationOptions: runtime.isAheadTranslationOptions,
      getTranslationQueueInsertIndex: runtime.getTranslationQueueInsertIndex,
      takeNextKakaoTranslationQueueItem: runtime.takeNextKakaoTranslationQueueItem,
      canStartKakaoTranslationQueueItem: runtime.canStartKakaoTranslationQueueItem,
      isKakaoReaderContentTarget: runtime.isKakaoReaderContentTarget,
      waitForPaint: runtime.waitForPaint,
      canStartQueuedTranslation: runtime.canStartQueuedTranslation,
      textSimilarity: runtime.textSimilarity,
      formatTranslationForOriginalLines: runtime.formatTranslationForOriginalLines,
      normalizeBubbleRotation: runtime.normalizeBubbleRotation,
      normalizeBubbleAlignment: runtime.normalizeBubbleAlignment,
      shouldUseVerticalJapaneseLayout: runtime.shouldUseVerticalJapaneseLayout,
      applyBubbleAnchorStyle: runtime.applyBubbleAnchorStyle,
      buildRegionClipPath: runtime.buildRegionClipPath,
      getBubbleRenderColors: runtime.getBubbleRenderColors,
      getDynamicStrokeWidth: runtime.getDynamicStrokeWidth,
      getCleanedPatchStyle: runtime.getCleanedPatchStyle,
      buildSolidBackgroundBox: runtime.buildSolidBackgroundBox,
      buildAheadTranslationOptions: runtime.buildAheadTranslationOptions,
      compareOverlayViewportRects: runtime.compareOverlayViewportRects,
      getOverlayPositionRect: runtime.getOverlayPositionRect,
      shouldHideOverlayRoot: runtime.shouldHideOverlayRoot,
      getOverlayVisibilityRect: runtime.getOverlayVisibilityRect,
      getVisibleViewportRect: runtime.getVisibleViewportRect,
      syncOverlayPosition: runtime.syncOverlayPosition,
      passesKakaopageTargetGeometry: runtime.passesKakaopageTargetGeometry,
      hasUsableKakaoStripCaptureRect: runtime.hasUsableKakaoStripCaptureRect,
      selectPendingAheadCandidates: runtime.selectPendingAheadCandidates,
      selectPendingContinuousCandidates: runtime.selectPendingContinuousCandidates,
      isAttachableKakaoShortPage: runtime.isAttachableKakaoShortPage,
      findKakaoVerticalOverlap: runtime.findKakaoVerticalOverlap,
      isAutomaticPretranslateMode: runtime.isAutomaticPretranslateMode,
      shouldSchedulePagePretranslation: runtime.shouldSchedulePagePretranslation,
      tracePipeline: runtime.tracePipeline,
      getPipelineTrace: () => globalThis.__MT_PIPELINE_TRACE__ || [],
      clearPipelineTrace: () => {
        globalThis.__MT_PIPELINE_TRACE__ = [];
      },
      findKakaoShortPageAttachmentOwner: runtime.findKakaoShortPageAttachmentOwner,
      normalizeKakaoStitchDebugCoordinates: runtime.normalizeKakaoStitchDebugCoordinates,
      maybeQueueKakaoShortPageAttachmentOwner: runtime.maybeQueueKakaoShortPageAttachmentOwner,
      maybeCropKakaoOverlappedPayload: runtime.maybeCropKakaoOverlappedPayload,
      sampleKakaoImageForOverlap: runtime.sampleKakaoImageForOverlap,
      normalizeKakaoStitchSegments: runtime.normalizeKakaoStitchSegments,
      getKakaoStitchOwnerOverlap: runtime.getKakaoStitchOwnerOverlap,
      getDebugItemPercentWithImageSize: runtime.getDebugItemPercentWithImageSize,
      mapKakaoStitchedFillBox: runtime.mapKakaoStitchedFillBox,
      mapKakaoStitchedPolygon: runtime.mapKakaoStitchedPolygon,
      buildTermDiscoveryMessage: runtime.buildTermDiscoveryMessage,
      releaseUncoveredKakaoShortPages: runtime.releaseUncoveredKakaoShortPages,
      releaseShortPagesAttachedDuringInflight: runtime.releaseShortPagesAttachedDuringInflight,
      hasAttachedShortPageBubble: runtime.hasAttachedShortPageBubble,
      buildKakaoStitchedPayload: runtime.buildKakaoStitchedPayload,
      findTargetByScopedKey: runtime.findTargetByScopedKey,
      setPipelineTraceEnabled: v => {
        runtime.ENABLE_PIPELINE_TRACE = v;
      }
    },
    destroy: runtime.destroy
  };
  runtime.api = api;

  // 初始化 Kakao 管线 Store（如可用）
  if (runtime.KP && typeof runtime.KP.createStore === "function") {
    runtime.state.kakaoStore = runtime.KP.createStore();
  }
}
