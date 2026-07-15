export function installPipeline11(runtime) {
  function freezeObservation(observation) {
    const pageIds = Object.freeze((Array.isArray(observation.pageIds) ? observation.pageIds : []).map(String));
    const imageRevisionByPage = Object.freeze({
      ...(observation.imageRevisionByPage || {})
    });
    const pageSpans = Object.freeze((Array.isArray(observation.pageSpans) ? observation.pageSpans : []).map(span => Object.freeze({
      ...span,
      pageId: String(span && span.pageId || ""),
      box: span && span.box ? Object.freeze({
        ...span.box
      }) : null,
      polygon: Array.isArray(span && span.polygon) ? Object.freeze(span.polygon.map(point => Object.freeze(Array.isArray(point) ? [...point] : {
        ...point
      }))) : span && span.polygon || null
    })));
    return Object.freeze({
      ...observation,
      id: String(observation.id),
      sourceType: observation.sourceType === "seam" ? "seam" : "page",
      pageIds,
      imageRevisionByPage,
      pageSpans,
      originalText: String(observation.originalText || observation.original_text || ""),
      visual: runtime.freezeCanonicalValue(observation.visual || {})
    });
  }
  runtime.freezeObservation = freezeObservation;
  function freezeCanonical(canonical) {
    const geometryByPage = {};
    for (const [pageId, geometry] of Object.entries(canonical.geometryByPage || {})) {
      geometryByPage[pageId] = runtime.freezeCanonicalValue(geometry);
    }
    return Object.freeze({
      ...canonical,
      id: String(canonical.id),
      revision: Math.max(1, Number(canonical.revision) || 1),
      memberObservationIds: Object.freeze((Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : []).map(String).sort()),
      originalText: String(canonical.originalText || canonical.original_text || ""),
      geometryByPage: Object.freeze(geometryByPage),
      status: String(canonical.status || "ready")
    });
  }
  runtime.freezeCanonical = freezeCanonical;
  function validatePageIdentity(identity) {
    if (!identity || !identity.pageId) throw new Error("KakaoCanonicalPipeline: pageId missing");
    if (!identity.imageRevision) throw new Error("KakaoCanonicalPipeline: imageRevision missing");
    if (!(Number(identity.width) > 0) || !(Number(identity.height) > 0)) {
      throw new Error("KakaoCanonicalPipeline: natural page dimensions missing");
    }
  }
  runtime.validatePageIdentity = validatePageIdentity;
  function revisionsForPages(records) {
    return Object.fromEntries(records.map(record => [record.pageId, record.imageRevision]));
  }
  runtime.revisionsForPages = revisionsForPages;
  function buildOcrMeta(sourceType, records, pairKey = "", options = {}) {
    const pageIds = records.map(record => record.pageId);
    return Object.freeze({
      sourceType,
      pageIds,
      imageRevision: records.length === 1 ? records[0].imageRevision : "",
      imageRevisionByPage: Object.freeze(runtime.revisionsForPages(records)),
      imageMeta: records.length === 1 ? records[0].imageMeta || records[0].identity && records[0].identity.imageMeta || null : {
        pairKey,
        pages: records.map(record => ({
          pageId: record.pageId,
          width: record.width,
          height: record.height
        }))
      },
      requireCleanedImage: options.requireCleanedImage === true,
      forceCleanedImageArtifact: options.forceCleanedImageArtifact === true,
      cleanedMasks: runtime.freezeCanonicalValue(Array.isArray(options.cleanedMasks) ? options.cleanedMasks : []),
      requestKey: sourceType === "page" ? `page:${pageIds[0]}:${records[0].imageRevision}` : `seam:${pairKey}`
    });
  }
  runtime.buildOcrMeta = buildOcrMeta;
  function getCanonicalReconciler() {
    return runtime.reconciler || null;
  }
  runtime.getCanonicalReconciler = getCanonicalReconciler;
  function canonicalPageDescriptor(record) {
    return Object.freeze({
      chapterId: String(record && record.chapterId || ""),
      pageId: String(record && record.pageId || ""),
      imageRevision: String(record && record.imageRevision || ""),
      width: Number(record && record.width) || 1,
      height: Number(record && record.height) || 1,
      readingOrder: Number.isFinite(Number(record && record.readingOrder)) ? Number(record.readingOrder) : undefined,
      shortPage: runtime.isCanonicalShortPage(record),
      edgeSignals: record && record.edgeSignals || null,
      previousPageId: String(record && record.previousPageId || ""),
      nextPageId: String(record && record.nextPageId || ""),
      adjacentPageIds: Object.freeze((Array.isArray(record && record.adjacentPageIds) ? record.adjacentPageIds : []).map(String).sort())
    });
  }
  runtime.canonicalPageDescriptor = canonicalPageDescriptor;
  function normalizeOcrEvidence(result, records, sourceType) {
    const payload = result && typeof result === "object" ? result : {};
    const normalizeItems = (items, filtered) => (Array.isArray(items) ? items : []).map(item => {
      const pageIds = Array.isArray(item && item.pageIds) && item.pageIds.length ? item.pageIds.map(String) : records.map(record => record.pageId);
      const imageRevisionByPage = {
        ...runtime.revisionsForPages(records),
        ...(item && item.imageRevisionByPage || {})
      };
      let pageSpans = Array.isArray(item && item.pageSpans) ? item.pageSpans : [];
      if (pageSpans.length === 0 && records.length === 1 && item && (item.box || item.bbox || item.polygon)) {
        pageSpans = [{
          pageId: records[0].pageId,
          box: item.box || item.bbox || null,
          polygon: item.polygon || null,
          overlapRatio: 1
        }];
      }
      const providerBlockId = String(item && (item.providerBlockId || item.provider_block_id || item.id) || "");
      const originalText = String(item && (item.originalText || item.original_text || item.text) || "");
      const id = String(item && item.id || runtime.buildFallbackObservationId({
        providerBlockId,
        sourceType,
        pageIds,
        imageRevisionByPage,
        originalText,
        pageSpans
      }));
      const candidate = {
        ...(item || {}),
        id,
        sourceType,
        pageIds,
        imageRevisionByPage,
        pageSpans,
        originalText,
        confidence: Number(item && (item.confidence ?? item.score)) || 0,
        visual: item && item.visual || null,
        providerBlockId,
        ...(filtered ? {
          filterReason: String(item && (item.filterReason || item.filter_reason) || "provider_filtered")
        } : {})
      };
      const reconciler = runtime.getCanonicalReconciler();
      if (reconciler && typeof reconciler.createObservation === "function") {
        try {
          return reconciler.createObservation(candidate);
        } catch (_error) {
          // Keep provider-neutral evidence available even when optional validation rejects extras.
        }
      }
      return runtime.freezeObservation(candidate);
    });
    return Object.freeze({
      observations: normalizeItems(payload.observations, false),
      filteredObservations: normalizeItems(payload.filteredObservations || payload.filtered_observations, true),
      edgeSignals: payload.edgeSignals || payload.edge_signals || null,
      cleanedImage: payload.cleanedImage || payload.cleaned_image || null,
      cleanedImageToken: String(payload.cleanedImageToken || payload.cleaned_image_token || ""),
      debug: payload.debug || null
    });
  }
  runtime.normalizeOcrEvidence = normalizeOcrEvidence;
  function normalizeSeamGeometryRect(value) {
    if (!value || typeof value !== "object") return null;
    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    const w = Number(value.w ?? value.width);
    const h = Number(value.h ?? value.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return {
      x,
      y,
      w,
      h
    };
  }
  runtime.normalizeSeamGeometryRect = normalizeSeamGeometryRect;
  function captureSeamPayloadGeometry(payload, records = []) {
    const source = payload && typeof payload === "object" ? payload : {};
    const rawSeam = source.seam && typeof source.seam === "object" ? source.seam : {};
    const canvasWidth = Number(rawSeam.canvasWidth ?? source.width ?? source.sourceWidth) || 0;
    const canvasHeight = Number(rawSeam.canvasHeight ?? source.height ?? source.sourceHeight) || 0;
    const fallbackByPage = new Map((Array.isArray(records) ? records : []).map(record => [String(record.pageId || ""), record]));
    const segments = (Array.isArray(rawSeam.segments) ? rawSeam.segments : Array.isArray(source.segments) ? source.segments : []).map(segment => {
      const pageId = String(segment && segment.pageId || "");
      const fallback = fallbackByPage.get(pageId) || {};
      const drawRect = runtime.normalizeSeamGeometryRect(segment && segment.drawRect);
      const sourceCrop = runtime.normalizeSeamGeometryRect(segment && segment.sourceCrop);
      if (!pageId || !drawRect || !sourceCrop) return null;
      return {
        pageId,
        drawRect,
        sourceCrop,
        naturalWidth: Number(segment && segment.naturalWidth) || Number(fallback.width) || 0,
        naturalHeight: Number(segment && segment.naturalHeight) || Number(fallback.height) || 0
      };
    }).filter(Boolean);
    return runtime.freezeCanonicalValue({
      coordinateSpace: String(source.coordinateSpace || "kakao-seam-v1"),
      canvasWidth,
      canvasHeight,
      pageSpans: Array.isArray(source.pageSpans) ? source.pageSpans : [],
      segments,
      seam: {
        ...rawSeam,
        canvasWidth,
        canvasHeight,
        segments
      }
    });
  }
  runtime.captureSeamPayloadGeometry = captureSeamPayloadGeometry;
  function normalizeSeamPercentBox(value) {
    if (!value || typeof value !== "object") return null;
    let x = Number(value.x ?? value.left);
    let y = Number(value.y ?? value.top);
    let w = Number(value.w ?? value.width);
    let h = Number(value.h ?? value.height);
    const coordinateSpace = String(value.coordinateSpace || value.coordinate_space || "").toLowerCase();
    if (coordinateSpace === "normalized" || coordinateSpace === "ratio") {
      x *= 100;
      y *= 100;
      w *= 100;
      h *= 100;
    }
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const left = runtime.clamp(x, 0, 100);
    const top = runtime.clamp(y, 0, 100);
    const right = runtime.clamp(x + w, 0, 100);
    const bottom = runtime.clamp(y + h, 0, 100);
    if (right <= left || bottom <= top) return null;
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    };
  }
  runtime.normalizeSeamPercentBox = normalizeSeamPercentBox;
  function seamPercentPolygonBounds(value) {
    const points = (Array.isArray(value) ? value : []).map(point => ({
      x: Number(Array.isArray(point) ? point[0] : point && point.x),
      y: Number(Array.isArray(point) ? point[1] : point && point.y)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 3) return null;
    return runtime.normalizeSeamPercentBox({
      x: Math.min(...points.map(point => point.x)),
      y: Math.min(...points.map(point => point.y)),
      w: Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)),
      h: Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y))
    });
  }
  runtime.seamPercentPolygonBounds = seamPercentPolygonBounds;
  function rawSeamBoxToPercent(value, canvasWidth, canvasHeight) {
    const rect = runtime.normalizeSeamGeometryRect(value);
    if (!rect || !(canvasWidth > 0) || !(canvasHeight > 0)) return null;
    return runtime.normalizeSeamPercentBox({
      x: rect.x / canvasWidth * 100,
      y: rect.y / canvasHeight * 100,
      w: rect.w / canvasWidth * 100,
      h: rect.h / canvasHeight * 100
    });
  }
  runtime.rawSeamBoxToPercent = rawSeamBoxToPercent;
  function unionSeamPercentBoxes(boxes) {
    const valid = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
    if (!valid.length) return null;
    const left = Math.min(...valid.map(box => box.x));
    const top = Math.min(...valid.map(box => box.y));
    const right = Math.max(...valid.map(box => box.x + box.w));
    const bottom = Math.max(...valid.map(box => box.y + box.h));
    return runtime.normalizeSeamPercentBox({
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    });
  }
  runtime.unionSeamPercentBoxes = unionSeamPercentBoxes;
  function observationHasTrueSeamContribution(observation, pageIds) {
    if (!observation || observation.sourceType !== "seam") return false;
    const spans = Array.isArray(observation.pageSpans) ? observation.pageSpans : [];
    const acceptedPageIds = new Set((Array.isArray(pageIds) ? pageIds : []).map(String));
    return spans.some(span => {
      if (!acceptedPageIds.has(String(span && span.pageId || ""))) return false;
      if (!runtime.normalizeSeamPercentBox(span && span.box)) return false;
      return span.overlapRatio == null || Number(span.overlapRatio) > 0;
    });
  }
  runtime.observationHasTrueSeamContribution = observationHasTrueSeamContribution;
  function seamObservationsCoverPair(observations, pageIds) {
    const covered = new Set();
    for (const observation of Array.isArray(observations) ? observations : []) {
      for (const span of Array.isArray(observation && observation.pageSpans) ? observation.pageSpans : []) {
        const pageId = String(span && span.pageId || "");
        if (pageIds.includes(pageId) && runtime.normalizeSeamPercentBox(span && span.box) && (span.overlapRatio == null || Number(span.overlapRatio) > 0)) {
          covered.add(pageId);
        }
      }
    }
    return pageIds.every(pageId => covered.has(pageId));
  }
  runtime.seamObservationsCoverPair = seamObservationsCoverPair;
  function isValidSeamSurfaceSegment(segment) {
    return !!segment && !!String(segment.pageId || "") && !!runtime.normalizeSeamGeometryRect(segment.drawRect) && !!runtime.normalizeSeamGeometryRect(segment.sourceCrop) && Number(segment.naturalWidth) > 0 && Number(segment.naturalHeight) > 0;
  }
  runtime.isValidSeamSurfaceSegment = isValidSeamSurfaceSegment;
  function hasRenderableSeamDebug(debug) {
    if (!debug || typeof debug !== "object") return false;
    return [debug.rawItems, debug.duplicateItems, debug.dedupedItems, debug.finalBubbles].some(items => Array.isArray(items) && items.length > 0);
  }
  runtime.hasRenderableSeamDebug = hasRenderableSeamDebug;
  function seamObservationCaptureBox(observation, canvasWidth, canvasHeight) {
    const visual = observation && observation.visual && typeof observation.visual === "object" ? observation.visual : {};
    const bgType = String(visual.bgType || visual.bg_type || "none").trim().toLowerCase();
    const regionBounds = runtime.seamPercentPolygonBounds(visual.regionPolygon || visual.region_polygon);
    const fillBox = runtime.normalizeSeamPercentBox(visual.fillBox || visual.fill_box);
    // 纯色 caption/speech panel 的区域多边形才是单页最终呈现使用的完整清理边界；
    // OCR 文字 union 只覆盖字形，会在跨缝处留下用户看到的半截原文。
    return (bgType === "solid" ? regionBounds || fillBox : fillBox || regionBounds) || runtime.normalizeSeamPercentBox(visual.box) || runtime.seamPercentPolygonBounds(visual.polygon) || runtime.rawSeamBoxToPercent(visual.rawBox || visual.raw_box, canvasWidth, canvasHeight);
  }
  runtime.seamObservationCaptureBox = seamObservationCaptureBox;
  function selectSeamVisualObservation(observations) {
    return [...(Array.isArray(observations) ? observations : [])].sort((left, right) => {
      const leftBg = Number(left && left.visual && (left.visual.bgConfidence ?? left.visual.bg_confidence)) || 0;
      const rightBg = Number(right && right.visual && (right.visual.bgConfidence ?? right.visual.bg_confidence)) || 0;
      return rightBg - leftBg || (Number(right && right.confidence) || 0) - (Number(left && left.confidence) || 0) || Array.from(String(right && right.originalText || "")).length - Array.from(String(left && left.originalText || "")).length || String(left && left.id || "").localeCompare(String(right && right.id || ""));
    })[0] || null;
  }
  runtime.selectSeamVisualObservation = selectSeamVisualObservation;
}
