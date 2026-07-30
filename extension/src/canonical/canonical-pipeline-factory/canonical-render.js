export function installCanonicalRender(runtime, scope) {
  function getCanonicalPageTranslationStatus(pageId, projections = []) {
    const normalizedPageId = String(pageId || "");
    const observationById = new Map(scope.store.getObservations().map(item => [String(item.id || ""), item]));
    const relevant = scope.store.getCanonicalSnapshot().filter(canonical => {
      if (!canonical || canonical.status === "filtered") return false;
      if (canonical.geometryByPage && canonical.geometryByPage[normalizedPageId]) return true;
      return (Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : []).some(id => {
        const observation = observationById.get(String(id || ""));
        return observation && Array.isArray(observation.pageIds) && observation.pageIds.includes(normalizedPageId);
      });
    });
    const provisional = (Array.isArray(projections) ? projections : []).some(projection => projection && (projection.provisional === true || projection.pendingCanonicalId));
    const complete = !provisional && relevant.every(canonical => !scope.canonicalWaitsForEdge(canonical) && !!scope.store.getTranslation(canonical.id, canonical.revision));
    return {
      relevantCount: relevant.length,
      complete
    };
  }
  scope.getCanonicalPageTranslationStatus = getCanonicalPageTranslationStatus;
  async function renderAllCanonicalPages(reason, guardAllows = () => true, options = {}) {
    const focusPageIds = new Set((Array.isArray(options.focusPageIds) ? options.focusPageIds : []).map(String));
    const seamSurfaceIndex = options.seamSurfaceIndex || runtime.buildSeamRenderSurfaceIndex(scope.store, {
      isPageAvailable: scope.isPageAvailable
    });
    const fallbackProjectionMap = options.fallbackProjectionsByPage instanceof Map ? options.fallbackProjectionsByPage : new Map();
    const descriptors = [];
    for (const handle of scope.store.getPageHandles()) {
      if (!guardAllows()) return;
      // 全局 reconcile 会遍历已经登记的所有页面，其中可能包含仍在 OCR 的并发页面。
      // 这类页面的空 projections 只是“尚未产出”，不能交给渲染层结算为无文字。
      if (!scope.isReadyPageRecord(handle)) continue;
      const seamSurfaces = seamSurfaceIndex.byPage.get(String(handle.pageId)) || Object.freeze([]);
      const pageDebug = runtime.resolvePageDebugForSeamSurfaces(handle.ocrDebug || null, seamSurfaces, handle.pageId);
      const handledCanonicalIds = new Set(seamSurfaces.flatMap(surface => [
        ...(surface.handledCanonicalIds || []),
        ...(surface.absorbedCanonicalIds || [])
      ]));
      if (options.debugOnly === true && !handle.ocrDebug && !seamSurfaces.some(surface => surface.debug)) continue;
      if (options.debugOnly === true && focusPageIds.size > 0 && !focusPageIds.has(String(handle.pageId)) && seamSurfaces.length === 0) continue;
      const target = scope.getTargetForPageId ? scope.getTargetForPageId(handle.pageId) : handle.target;
      if (!scope.targetIsUsable(target)) continue;
      if (target.dataset) {
        const relatedStates = scope.store.getSeamStates().filter(state =>
          Array.isArray(state?.pageIds) && state.pageIds.map(String).includes(String(handle.pageId))
        );
        const stateObservationIds = new Set(relatedStates.flatMap(state =>
          (state.observationIds || []).map(String)
        ));
        const canonicalMembership = scope.store.getCanonicalSnapshot().filter(canonical =>
          Object.keys(canonical?.geometryByPage || {}).includes(String(handle.pageId)) ||
          (canonical?.memberObservationIds || []).some(id => stateObservationIds.has(String(id)))
        ).map(canonical => ({
          type: "canonical",
          canonicalId: canonical.id,
          revision: canonical.revision,
          memberObservationIds: canonical.memberObservationIds,
          geometryPageIds: Object.keys(canonical.geometryByPage || {}).sort(),
          sharedSeamObservationIds: (canonical.memberObservationIds || []).filter(id => stateObservationIds.has(String(id)))
        }));
        target.dataset.mtSeamDiagnostics = JSON.stringify([
          ...seamSurfaces.map(surface => ({ type: "surface", renderKey: surface.renderKey, pageIds: surface.pageIds, diagnostics: surface.diagnostics })),
          ...relatedStates.map(state => ({ type: "state", pairKey: state.pairKey, status: state.status, pageIds: state.pageIds, imageRevisionByPage: state.imageRevisionByPage, observationIds: state.observationIds, filteredObservationIds: (state.filteredObservations || []).map(item => item.id), reasons: state.reasons, error: state.error || "" })),
          ...canonicalMembership
        ]);
      }
      const storedProjections = scope.store.getProjections(handle.pageId).filter(projection => !handledCanonicalIds.has(String(projection && projection.canonicalId || "")) && !handledCanonicalIds.has(String(projection && projection.pendingCanonicalId || "")));
      if (options.debugOnly === true && seamSurfaces.length === 0 && storedProjections.some(item => item.activeText && item.translated_text)) {
        continue;
      }
      const projections = options.debugOnly === true ? [] : storedProjections;
      const terminal = scope.store.getPageTerminal(handle.pageId);
      const observationCount = Number(terminal && terminal.details && terminal.details.observationCount);
      const translationStatus = scope.getCanonicalPageTranslationStatus(handle.pageId, projections);
      const authoritativeEmpty = options.debugOnly !== true && seamSurfaces.length === 0 && Number.isFinite(observationCount) && (observationCount === 0 || translationStatus.relevantCount === 0);
      const translationComplete = options.debugOnly !== true && options.translationComplete !== false && translationStatus.complete;
      const activeBubbles = projections.filter(item => item.activeText && item.translated_text).map(runtime.projectionToBubble);
      descriptors.push({
        handle,
        target,
        pageId: handle.pageId,
        projections,
        fallbackProjections: fallbackProjectionMap.get(String(handle.pageId)) || projections,
        seamSurfaces,
        debug: pageDebug,
        activeBubbles,
        translationComplete,
        authoritativeEmpty
      });
    }
    const descriptorByPage = new Map(descriptors.map(descriptor => [String(descriptor.pageId), descriptor]));
    const uniqueSurfaces = new Map();
    for (const descriptor of descriptors) {
      for (const surface of descriptor.seamSurfaces) {
        uniqueSurfaces.set(String(surface.renderKey || surface.pairKey || ""), surface);
      }
    }
    const batchSurfaces = [...uniqueSurfaces.values()].filter(surface => (surface.pageIds || []).every(pageId => descriptorByPage.has(String(pageId))));
    const batchPageIds = new Set(batchSurfaces.flatMap(surface => surface.pageIds || []).map(String));
    const renderDescriptor = async (descriptor, extra = {}) => scope.renderCanonicalProjections({
      target: descriptor.target,
      pageId: descriptor.pageId,
      targetKey: descriptor.handle.targetKey,
      scopedTargetKey: descriptor.handle.scopedTargetKey,
      projections: descriptor.projections,
      seamSurfaces: extra.seamSurfaces || descriptor.seamSurfaces,
      allSeamSurfaces: seamSurfaceIndex.surfaces,
      result: {
        bubbles: descriptor.activeBubbles,
        cleanedImage: descriptor.handle.cleanedImage || null,
        debug: descriptor.debug
      },
      payload: descriptor.handle.payload,
      cleanedImage: descriptor.handle.cleanedImage || null,
      debug: descriptor.debug,
      debugOnly: options.debugOnly === true,
      translationComplete: descriptor.translationComplete,
      authoritativeEmpty: descriptor.authoritativeEmpty,
      reason,
      ...extra
    });
    if (batchPageIds.size > 0) {
      const batchDescriptors = [...batchPageIds].map(pageId => descriptorByPage.get(pageId)).filter(Boolean);
      const first = batchDescriptors[0];
      const mapByPage = selector => new Map(batchDescriptors.map(descriptor => [String(descriptor.pageId), selector(descriptor)]));
      // 两个裁剪视窗携带各自完整的普通 projection/debug/payload，在同一次调用里原子安装。
      await renderDescriptor(first, {
        seamSurfaces: batchSurfaces,
        projectionsByPage: mapByPage(descriptor => descriptor.projections),
        fallbackProjectionsByPage: mapByPage(descriptor => descriptor.fallbackProjections),
        payloadByPage: mapByPage(descriptor => descriptor.handle.payload),
        cleanedImageByPage: mapByPage(descriptor => descriptor.handle.cleanedImage || null),
        debugByPage: mapByPage(descriptor => descriptor.debug),
        translationCompleteByPage: mapByPage(descriptor => descriptor.translationComplete),
        authoritativeEmptyByPage: mapByPage(descriptor => descriptor.authoritativeEmpty)
      });
    }
    for (const descriptor of descriptors) {
      if (!guardAllows()) return;
      if (batchPageIds.has(String(descriptor.pageId))) continue;
      // surface 已取得 canonical 所有权但另一页 DOM 暂不可用时，延后统一 overlay，
      // 同时继续压制被吸收的单页 fallback，避免完整 seam 文本退回某一页重复显示。
      const deferredSurfaceOwnership = descriptor.seamSurfaces.length > 0;
      await renderDescriptor(descriptor, {
        seamSurfaces: [],
        fallbackProjectionsByPage: new Map([[
          String(descriptor.pageId),
          deferredSurfaceOwnership ? descriptor.projections : descriptor.fallbackProjections
        ]])
      });
    }
  }
  scope.renderAllCanonicalPages = renderAllCanonicalPages;
  async function runCached(target, _cachedResult, options = {}) {
    const handle = scope.store.getPageHandleForTarget(target);
    if (!handle || !scope.isReadyPageRecord(handle)) {
      return scope.run(target, {
        ...options,
        reason: options.reason || "store-cache-miss"
      });
    }
    await scope.refreshCanonicalState({
      reason: "store-cache",
      focusPageIds: [handle.pageId]
    });
    return {
      ok: true,
      reused: true,
      pageId: handle.pageId,
      bubbles: scope.store.getProjections(handle.pageId).filter(item => item.activeText).length
    };
  }
  scope.runCached = runCached;
  function pageRevisionsStillMatch(records) {
    return records.every(record => {
      const current = scope.store.getPageHandle(record.pageId);
      return current && current.imageRevision === record.imageRevision;
    });
  }
  scope.pageRevisionsStillMatch = pageRevisionsStillMatch;
  async function onAdjacentTargetAvailable(previousTarget, nextTarget) {
    let previous = scope.store.getPageHandleForTarget(previousTarget);
    let next = scope.store.getPageHandleForTarget(nextTarget);
    if (!previous || !next) return {
      ok: false,
      skipped: true,
      reason: "page-not-observed"
    };
    if (!previous.chapterId || previous.chapterId !== next.chapterId) {
      return {
        ok: false,
        skipped: true,
        reason: "chapter-mismatch"
      };
    }
    previous = scope.store.registerPageHandle({
      ...previous,
      nextPageId: next.pageId,
      adjacentPageIds: Object.freeze(Array.from(new Set([...(previous.adjacentPageIds || []), next.pageId])).sort()),
      adjacentTargets: Object.freeze(runtime.mergeAdjacentTargetRelation(previous.adjacentTargets, {
        side: "next",
        target: nextTarget
      }))
    });
    next = scope.store.registerPageHandle({
      ...next,
      previousPageId: previous.pageId,
      adjacentPageIds: Object.freeze(Array.from(new Set([...(next.adjacentPageIds || []), previous.pageId])).sort()),
      adjacentTargets: Object.freeze(runtime.mergeAdjacentTargetRelation(next.adjacentTargets, {
        side: "previous",
        target: previousTarget
      }))
    });
    if (!scope.isReadyPageRecord(previous) || !scope.isReadyPageRecord(next)) {
      return {
        ok: false,
        skipped: true,
        reason: "page-ocr-pending"
      };
    }
    const pairKey = runtime.buildCanonicalPairKey(previous, next);
    const pairState = scope.store.getSeamState(pairKey);
    const loadingRecords = !pairState || pairState.status === "running" ? [previous, next] : [];
    loadingRecords.forEach(record => {
      scope.loading(record.target, record.targetKey, "处理跨页...");
    });
    try {
      await scope.processSeamPair(previous, next);
      scope.releaseCompletedEdgeWaits();
      loadingRecords.forEach(record => {
        scope.loading(record.target, record.targetKey, "渲染结果...");
      });
      await scope.refreshCanonicalState({
        reason: "adjacent-target-available",
        focusPageIds: [previous.pageId, next.pageId]
      });
      return {
        ok: true,
        pageIds: [previous.pageId, next.pageId]
      };
    } finally {
      if (typeof scope.adapters.clearLoadingOverlay === "function") {
        loadingRecords.forEach(record => {
          scope.adapters.clearLoadingOverlay(record.target);
        });
      }
    }
  }
  scope.onAdjacentTargetAvailable = onAdjacentTargetAvailable;
  scope.result = Object.freeze({
    store: scope.store,
    run: scope.run,
    runCached: scope.runCached,
    refresh: scope.refreshCanonicalState,
    processAdjacentPairs: scope.processAdjacentPairs,
    processSeamPair: scope.processSeamPair,
    onAdjacentTargetAvailable: scope.onAdjacentTargetAvailable,
    CanonicalPhase: runtime.CanonicalPhase
  });
}
