export function installSceneIndexResolve(runtime) {
  function normalizeSpanBoxPixels(box, record) {
    if (!box || typeof box !== "object") return null;
    const left = Number(box.left ?? box.x);
    const top = Number(box.top ?? box.y);
    const width = Number(box.width ?? box.w);
    const height = Number(box.height ?? box.h);
    if (![left, top, width, height].every(Number.isFinite)) return null;
    const coordinateModel = String(box.coordinateModel || box.coordinate_model || "").toLowerCase();
    const isPercent = coordinateModel.includes("percent") || Math.max(Math.abs(left), Math.abs(top), Math.abs(width), Math.abs(height)) <= 100 && (Number(record.width) > 100 || Number(record.height) > 100);
    return {
      left: left * (isPercent ? Number(record.width) / 100 : 1),
      top: top * (isPercent ? Number(record.height) / 100 : 1),
      width: width * (isPercent ? Number(record.width) / 100 : 1),
      height: height * (isPercent ? Number(record.height) / 100 : 1)
    };
  }
  runtime.normalizeSpanBoxPixels = normalizeSpanBoxPixels;
  function reconcileCanonicalEvidence(store) {
    const pages = store.getPageHandles().map(runtime.canonicalPageDescriptor);
    const adjacentPagePairs = runtime.buildConfirmedAdjacentPagePairs(
      store.getPageHandles(), store.getSeamStates()
    );
    const observations = store.getObservations().filter(item => !store.getFilteredObservations().some(filtered => filtered.id === item.id));
    const filteredObservations = store.getFilteredObservations();
    const previousCanonicals = store.getCanonicalSnapshot();
    const reconciler = runtime.getCanonicalReconciler();
    if (reconciler && typeof reconciler.reconcileObservations === "function") {
      const result = reconciler.reconcileObservations({
        pages,
        observations,
        filteredObservations,
        previousCanonicals,
        adjacentPagePairs
      });
      return runtime.normalizeReconciliationResult(result, observations, filteredObservations, previousCanonicals);
    }
    return runtime.fallbackReconcileObservations({
      pages,
      observations,
      filteredObservations,
      previousCanonicals
    });
  }
  runtime.reconcileCanonicalEvidence = reconcileCanonicalEvidence;
  function buildConfirmedAdjacentPagePairs(records, seamStates = []) {
    const pageById = new Map((Array.isArray(records) ? records : []).map(record => [record.pageId, record]));
    const pairToken = (left, right) => [String(left || ""), String(right || "")].sort().join("\u0000");
    const stateByPair = new Map((Array.isArray(seamStates) ? seamStates : [])
      .filter(state => Array.isArray(state?.pageIds) && state.pageIds.length === 2)
      .map(state => [pairToken(state.pageIds[0], state.pageIds[1]), state]));
    const pairs = new Map();
    for (const record of pageById.values()) {
      const candidates = new Set([String(record.previousPageId || ""), String(record.nextPageId || ""), ...(Array.isArray(record.adjacentPageIds) ? record.adjacentPageIds.map(String) : [])]);
      for (const adjacentPageId of candidates) {
        const adjacent = pageById.get(adjacentPageId);
        if (!adjacent || adjacent.pageId === record.pageId) continue;
        const ordered = [record, adjacent].sort(runtime.comparePageRecords);
        const key = `${ordered[0].pageId}|${ordered[1].pageId}`;
        const state = stateByPair.get(pairToken(
          ordered[0].pageId, ordered[1].pageId
        ));
        pairs.set(key, Object.freeze({
          pageIds: Object.freeze(ordered.map(page => page.pageId)),
          pageAId: ordered[0].pageId,
          pageBId: ordered[1].pageId,
          imageRevisionByPage: Object.freeze(runtime.revisionsForPages(ordered)),
          ...(state ? {
            seamEvidence: Object.freeze({
              pairKey: String(state.pairKey || ""),
              status: String(state.status || ""),
              reasons: Object.freeze((Array.isArray(state.reasons) ?
                state.reasons : []).map(String).sort()),
              observationIds: Object.freeze((Array.isArray(state.observationIds) ?
                state.observationIds : []).map(String).sort()),
              imageRevisionByPage: Object.freeze({
                ...(state.imageRevisionByPage || {})
              })
            })
          } : {})
        }));
      }
    }
    return [...pairs.values()].sort((left, right) => left.pageIds.join("|").localeCompare(right.pageIds.join("|")));
  }
  runtime.buildConfirmedAdjacentPagePairs = buildConfirmedAdjacentPagePairs;
  function normalizeReconciliationResult(result, observations, filteredObservations, previousCanonicals) {
    if (!result || !Array.isArray(result.canonicals)) {
      return runtime.fallbackReconcileObservations({
        observations,
        filteredObservations,
        previousCanonicals
      });
    }
    return {
      ...result,
      canonicals: result.canonicals.map(runtime.freezeCanonical).sort(runtime.compareCanonicalRecords),
      ledger: result.ledger || result.coverageLedger || {},
      diagnostics: result.diagnostics || []
    };
  }
  runtime.normalizeReconciliationResult = normalizeReconciliationResult;
  function fallbackReconcileObservations({
    observations = [],
    filteredObservations = [],
    previousCanonicals = []
  }) {
    const previousById = new Map(previousCanonicals.map(canonical => [canonical.id, canonical]));
    const canonicals = [];
    const ledger = {};
    for (const observation of [...observations].sort(runtime.compareStableIds)) {
      const id = `canonical:${observation.id}`;
      const geometryByPage = {};
      for (const span of observation.pageSpans || []) {
        if (!geometryByPage[span.pageId]) geometryByPage[span.pageId] = [];
        geometryByPage[span.pageId].push(span.box || {
          polygon: span.polygon
        });
      }
      const previous = previousById.get(id);
      const stableValue = JSON.stringify({
        memberObservationIds: [observation.id],
        originalText: observation.originalText,
        geometryByPage
      });
      const previousValue = previous && JSON.stringify({
        memberObservationIds: previous.memberObservationIds,
        originalText: previous.originalText,
        geometryByPage: previous.geometryByPage
      });
      canonicals.push(runtime.freezeCanonical({
        id,
        revision: previous ? stableValue === previousValue ? previous.revision : Number(previous.revision) + 1 : 1,
        supersedesId: null,
        memberObservationIds: [observation.id],
        originalText: observation.originalText,
        geometryByPage,
        status: "ready",
        translationFingerprint: ""
      }));
      ledger[observation.id] = {
        observationId: observation.id,
        resolution: "standalone",
        canonicalId: id
      };
    }
    for (const observation of filteredObservations) {
      ledger[observation.id] = {
        observationId: observation.id,
        resolution: "filtered",
        filterReason: observation.filterReason || "provider_filtered"
      };
    }
    return {
      canonicals: canonicals.sort(runtime.compareCanonicalRecords),
      ledger,
      diagnostics: []
    };
  }
  runtime.fallbackReconcileObservations = fallbackReconcileObservations;
  function assertCoverageInvariant(store) {
    const ledger = store.getCoverageLedger();
    const observations = store.getObservations();
    const activeMembership = new Map();
    for (const canonical of store.getCanonicalSnapshot()) {
      for (const observationId of canonical.memberObservationIds) {
        if (activeMembership.has(observationId)) {
          throw new Error(`Canonical invariant violated: observation ${observationId} belongs to multiple canonicals`);
        }
        activeMembership.set(observationId, canonical.id);
      }
    }
    for (const observation of observations) {
      const resolution = ledger.get(observation.id);
      if (!resolution || !["standalone", "consumed", "filtered"].includes(String(resolution.resolution || resolution.status))) {
        throw new Error(`Canonical invariant violated: unresolved observation ${observation.id}`);
      }
    }
  }
  runtime.assertCoverageInvariant = assertCoverageInvariant;
  function fallbackBuildRenderProjections({
    pages,
    canonicals,
    availablePageIds
  }) {
    const pageById = new Map(pages.map(page => [page.pageId, page]));
    const available = new Set(availablePageIds || []);
    const projections = [];
    for (const canonical of canonicals) {
      const translation = canonical.translation || null;
      if (!translation || !String(translation.translated_text || "").trim()) continue;
      const geometries = Object.entries(canonical.geometryByPage || {}).map(([pageId, geometry]) => ({
        pageId,
        geometry,
        area: runtime.geometryArea(geometry),
        page: pageById.get(pageId) || {
          pageId
        }
      })).sort((left, right) => right.area - left.area || runtime.comparePageRecords(left.page, right.page));
      if (geometries.length === 0) continue;
      const desiredPrimary = geometries[0].pageId;
      const activePrimary = available.has(desiredPrimary) ? desiredPrimary : (geometries.find(item => available.has(item.pageId)) || geometries[0]).pageId;
      for (const item of geometries) {
        const role = item.pageId === activePrimary ? "primary" : "standby";
        // 把该页几何上带的外观（bgType/textColor…）挂到投影上：清理图计划靠
        // projectionRequiresCleanedImage 判断"复杂背景需要 inpainted 清理图"，
        // 不带 visual/bg_type 时它恒为 false —— 页面级复杂背景（旁白/嵌字）
        // 于是永远拿不到清理图，遮罩节点是透明的（接缝层有自己的计划所以有图）。
        const geometryList = Array.isArray(item.geometry) ? item.geometry : [item.geometry];
        const styled = geometryList.find(entry => entry && (entry.visual || entry.spanVisual)) || null;
        const visual = styled ? styled.visual || styled.spanVisual || null : null;
        projections.push({
          canonicalId: canonical.id,
          revision: canonical.revision,
          pageId: item.pageId,
          role,
          activeText: role === "primary",
          geometry: item.geometry,
          visual,
          bg_type: String(visual && (visual.bgType || visual.bg_type) || ""),
          original_text: canonical.originalText,
          translated_text: translation.translated_text,
          translation
        });
      }
    }
    return projections.sort((left, right) => String(left.pageId).localeCompare(String(right.pageId)) || runtime.compareProjectionRecords(left, right));
  }
  runtime.fallbackBuildRenderProjections = fallbackBuildRenderProjections;
  function geometryArea(geometry) {
    const items = Array.isArray(geometry) ? geometry : [geometry];
    return items.reduce((total, item) => {
      if (!item) return total;
      const width = Math.max(0, Number(item.width ?? item.w) || 0);
      const height = Math.max(0, Number(item.height ?? item.h) || 0);
      return total + width * height;
    }, 0);
  }
  runtime.geometryArea = geometryArea;
  function projectionToBubble(projection) {
    if (projection && projection.bubble) {
      return {
        ...projection.bubble,
        original_text: projection.original_text,
        translated_text: projection.translated_text
      };
    }
    const geometry = Array.isArray(projection.geometry) ? projection.geometry[0] : projection.geometry || {};
    return {
      id: projection.canonicalId,
      revision: projection.revision,
      x: Number(geometry.x ?? geometry.left) || 0,
      y: Number(geometry.y ?? geometry.top) || 0,
      w: Number(geometry.w ?? geometry.width) || 0,
      h: Number(geometry.h ?? geometry.height) || 0,
      original_text: projection.original_text,
      translated_text: projection.translated_text,
      canonical_id: projection.canonicalId,
      canonical_revision: projection.revision
    };
  }
  runtime.projectionToBubble = projectionToBubble;
  function buildStandbyCoverProjections(projection) {
    if (!projection || projection.role !== "standby" || projection.coverEligible === false) return [];
    return [Object.freeze({
      ...projection,
      id: `${String(projection.id || projection.canonicalId || "projection")}:cover`,
      projectionId: `${String(projection.projectionId || projection.id || projection.canonicalId || "projection")}:cover`,
      role: "cover",
      active: true,
      activeText: false,
      coverOnly: true,
      translated_text: "",
      translatedText: "",
      bubble: projection.bubble ? Object.freeze({
        ...projection.bubble,
        translated_text: "",
        projection_role: "cover_only",
        cover_only: true
      }) : projection.bubble
    })];
  }
  runtime.buildStandbyCoverProjections = buildStandbyCoverProjections;
}
