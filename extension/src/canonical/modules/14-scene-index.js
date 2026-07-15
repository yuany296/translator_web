export function installPipeline14(runtime) {
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
    const adjacentPagePairs = runtime.buildConfirmedAdjacentPagePairs(store.getPageHandles());
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
  function buildConfirmedAdjacentPagePairs(records) {
    const pageById = new Map((Array.isArray(records) ? records : []).map(record => [record.pageId, record]));
    const pairs = new Map();
    for (const record of pageById.values()) {
      const candidates = new Set([String(record.previousPageId || ""), String(record.nextPageId || ""), ...(Array.isArray(record.adjacentPageIds) ? record.adjacentPageIds.map(String) : [])]);
      for (const adjacentPageId of candidates) {
        const adjacent = pageById.get(adjacentPageId);
        if (!adjacent || adjacent.pageId === record.pageId) continue;
        const ordered = [record, adjacent].sort(runtime.comparePageRecords);
        const key = `${ordered[0].pageId}|${ordered[1].pageId}`;
        pairs.set(key, Object.freeze({
          pageIds: Object.freeze(ordered.map(page => page.pageId)),
          pageAId: ordered[0].pageId,
          pageBId: ordered[1].pageId,
          imageRevisionByPage: Object.freeze(runtime.revisionsForPages(ordered))
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
        projections.push({
          canonicalId: canonical.id,
          revision: canonical.revision,
          pageId: item.pageId,
          role,
          activeText: role === "primary",
          geometry: item.geometry,
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
    if (!projection || projection.role !== "standby") return [];
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
  function projectionsRequireCleanedImage(projections) {
    return (Array.isArray(projections) ? projections : []).some(runtime.projectionRequiresCleanedImage);
  }
  runtime.projectionsRequireCleanedImage = projectionsRequireCleanedImage;
  function projectionRequiresCleanedImage(projection) {
    if (!projection || projection.active === false) return false;
    const role = String(projection.role || "");
    const cover = role === "cover" || role === "cover_only" || projection.coverOnly === true;
    if (!cover && projection.activeText !== true) return false;
    const bgType = String(projection.visual && (projection.visual.bgType || projection.visual.bg_type) || projection.bubble && (projection.bubble.bg_type || projection.bubble.bgType) || projection.bgType || projection.bg_type || "").trim().toLowerCase();
    return bgType === "none";
  }
  runtime.projectionRequiresCleanedImage = projectionRequiresCleanedImage;
  function quantizeCleanMaskNumber(value) {
    return Math.round(runtime.clamp(Number(value) || 0, 0, 100) * 100) / 100;
  }
  runtime.quantizeCleanMaskNumber = quantizeCleanMaskNumber;
  function normalizeCanonicalCleanMaskGeometry(geometry) {
    const inputs = Array.isArray(geometry) ? geometry : [geometry];
    const bounds = [];
    for (const input of inputs) {
      if (!input || typeof input !== "object") continue;
      const box = input.box || input.geometry || input;
      const x = Number(box && (box.x ?? box.left));
      const y = Number(box && (box.y ?? box.top));
      const w = Number(box && (box.w ?? box.width));
      const h = Number(box && (box.h ?? box.height));
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
        bounds.push({
          left: x,
          top: y,
          right: x + w,
          bottom: y + h
        });
        continue;
      }
      const points = (Array.isArray(input.polygon) ? input.polygon : []).map(point => ({
        x: Number(Array.isArray(point) ? point[0] : point && point.x),
        y: Number(Array.isArray(point) ? point[1] : point && point.y)
      })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length >= 3) {
        bounds.push({
          left: Math.min(...points.map(point => point.x)),
          top: Math.min(...points.map(point => point.y)),
          right: Math.max(...points.map(point => point.x)),
          bottom: Math.max(...points.map(point => point.y))
        });
      }
    }
    if (!bounds.length) return null;
    const left = runtime.quantizeCleanMaskNumber(Math.min(...bounds.map(box => box.left)));
    const top = runtime.quantizeCleanMaskNumber(Math.min(...bounds.map(box => box.top)));
    const right = runtime.quantizeCleanMaskNumber(Math.max(...bounds.map(box => box.right)));
    const bottom = runtime.quantizeCleanMaskNumber(Math.max(...bounds.map(box => box.bottom)));
    if (right <= left || bottom <= top) return null;
    return {
      coordinateSpace: "percent",
      box: {
        x: left,
        y: top,
        w: runtime.quantizeCleanMaskNumber(right - left),
        h: runtime.quantizeCleanMaskNumber(bottom - top)
      }
    };
  }
  runtime.normalizeCanonicalCleanMaskGeometry = normalizeCanonicalCleanMaskGeometry;
  function buildCanonicalCleanMasks(projections, crossPageCanonicalIds = new Set()) {
    const crossPageIds = crossPageCanonicalIds instanceof Set ? crossPageCanonicalIds : new Set(Array.from(crossPageCanonicalIds || [], String));
    const byKey = new Map();
    for (const projection of Array.isArray(projections) ? projections : []) {
      const canonicalId = String(projection && projection.canonicalId || "");
      if (!canonicalId || !crossPageIds.has(canonicalId) || !runtime.projectionRequiresCleanedImage(projection)) continue;
      // 跨页漏字往往恰好落在单页 OCR 多边形之外；清理范围必须采用渲染蓝框
      // 对应的 canonical union，而不能退回某一行文字或某个 seam 字框。
      const mask = runtime.normalizeCanonicalCleanMaskGeometry(projection.geometry || projection.box);
      if (mask) byKey.set(JSON.stringify(mask), mask);
    }
    return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, mask]) => mask);
  }
  runtime.buildCanonicalCleanMasks = buildCanonicalCleanMasks;
  function buildCleanedMaskFingerprint(masks) {
    const text = JSON.stringify(Array.isArray(masks) ? masks : []);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  runtime.buildCleanedMaskFingerprint = buildCleanedMaskFingerprint;
}
