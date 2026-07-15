export function installPipeline12(runtime) {
  function buildSeamSurfaceBubble(canonical, translation, observations, canvasWidth, canvasHeight) {
    const linked = (Array.isArray(observations) ? observations : []).filter(observation => runtime.seamObservationCaptureBox(observation, canvasWidth, canvasHeight));
    if (!linked.length) return null;
    const box = runtime.unionSeamPercentBoxes(linked.map(observation => runtime.seamObservationCaptureBox(observation, canvasWidth, canvasHeight)));
    if (!box) return null;
    const selected = runtime.selectSeamVisualObservation(linked);
    const rawVisual = selected && selected.visual && typeof selected.visual === "object" ? selected.visual : {};
    const translatedText = String(translation && (translation.translated_text || translation.translatedText) || "").trim();
    if (!translatedText) return null;
    const bgType = String(rawVisual.bgType || rawVisual.bg_type || "none");
    const bgColor = String(rawVisual.bgColor || rawVisual.bg_color || "");
    const bgConfidence = Number(rawVisual.bgConfidence ?? rawVisual.bg_confidence) || 0;
    const regionId = String(rawVisual.regionId || rawVisual.region_id || "");
    const regionType = String(rawVisual.regionType || rawVisual.region_type || "plain_text");
    const regionPolygon = rawVisual.regionPolygon || rawVisual.region_polygon || null;
    const polygon = bgType.trim().toLowerCase() === "solid" ? regionPolygon || null : rawVisual.polygon || null;
    const textColor = String(rawVisual.textColor || rawVisual.text_color || "");
    const strokeColor = String(rawVisual.strokeColor || rawVisual.stroke_color || "");
    const alignment = runtime.normalizeTextAlignment(rawVisual.alignment);
    const rotationDeg = Number(rawVisual.rotationDeg ?? rawVisual.rotation_deg) || 0;
    const fontWeight = runtime.normalizeFontWeight(rawVisual.fontWeight ?? rawVisual.font_weight);
    const translationRole = String(rawVisual.translationRole || rawVisual.translation_role || "");
    const sourceLineCount = Math.max(linked.length, Number(rawVisual.sourceLineCount ?? rawVisual.source_line_count) || 1);
    const visual = runtime.freezeCanonicalValue({
      ...rawVisual,
      fillBox: box,
      fill_box: box,
      bgType,
      bg_type: bgType,
      bgColor,
      bg_color: bgColor,
      bgConfidence,
      bg_confidence: bgConfidence,
      regionId,
      region_id: regionId,
      regionType,
      region_type: regionType,
      textColor,
      text_color: textColor,
      strokeColor,
      stroke_color: strokeColor,
      alignment,
      rotationDeg,
      rotation_deg: rotationDeg,
      fontWeight,
      font_weight: fontWeight,
      translationRole,
      translation_role: translationRole,
      sourceLineCount,
      source_line_count: sourceLineCount
    });
    return runtime.freezeCanonicalValue({
      id: `${canonical.id}:seam`,
      block_id: `${canonical.id}:seam`,
      canonicalId: String(canonical.id),
      canonical_id: String(canonical.id),
      canonicalRevision: Math.max(1, Number(canonical.revision) || 1),
      canonical_revision: Math.max(1, Number(canonical.revision) || 1),
      coordinateSpace: "percent",
      coordinate_space: "percent",
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      originalText: String(canonical.originalText || canonical.original_text || ""),
      original_text: String(canonical.originalText || canonical.original_text || ""),
      translatedText,
      translated_text: translatedText,
      visual,
      fill_box: box,
      bg_type: bgType,
      bg_color: bgColor,
      bg_confidence: bgConfidence,
      region_id: regionId,
      region_type: regionType,
      region_polygon: regionPolygon,
      polygon,
      text_color: textColor,
      stroke_color: strokeColor,
      alignment,
      rotation_deg: rotationDeg,
      font_weight: fontWeight,
      translation_role: translationRole,
      source_line_count: sourceLineCount
    });
  }
  runtime.buildSeamSurfaceBubble = buildSeamSurfaceBubble;
  function seamBubbleRequiresCleanedImage(bubble) {
    const bgType = String(bubble && (bubble.bg_type || bubble.visual && (bubble.visual.bgType || bubble.visual.bg_type)) || "none").trim().toLowerCase();
    return bgType !== "solid";
  }
  runtime.seamBubbleRequiresCleanedImage = seamBubbleRequiresCleanedImage;
  function seamProjectionRegionFamily(value) {
    const visual = value && value.visual && typeof value.visual === "object" ? value.visual : {};
    const bubble = value && value.bubble && typeof value.bubble === "object" ? value.bubble : value || {};
    const type = String(bubble.region_type || bubble.regionType || visual.region_type || visual.regionType || "plain_text").trim().toLowerCase();
    if (/effect|sfx|onomatopoeia/u.test(type)) return "effect";
    if (/chat|comment|ui|metadata/u.test(type)) return "ui";
    return "text";
  }
  runtime.seamProjectionRegionFamily = seamProjectionRegionFamily;
  function seamProjectionBox(projection) {
    const geometry = projection && projection.geometry;
    const values = Array.isArray(geometry) ? geometry : [geometry, projection && projection.box, projection && projection.bubble];
    for (const value of values) {
      const box = runtime.normalizeSeamPercentBox(value && (value.box || value.geometry || value));
      if (box) return box;
    }
    return null;
  }
  runtime.seamProjectionBox = seamProjectionBox;
  function projectSeamBubbleToPage(surface, bubble, pageId) {
    const canvasWidth = Number(surface && surface.canvasWidth) || 0;
    const canvasHeight = Number(surface && surface.canvasHeight) || 0;
    const segment = (Array.isArray(surface && surface.segments) ? surface.segments : []).find(item => String(item && item.pageId || "") === String(pageId || ""));
    const drawRect = runtime.normalizeSeamGeometryRect(segment && segment.drawRect);
    const sourceCrop = runtime.normalizeSeamGeometryRect(segment && segment.sourceCrop);
    const bubbleBox = runtime.normalizeSeamPercentBox(bubble);
    const naturalWidth = Number(segment && segment.naturalWidth) || 0;
    const naturalHeight = Number(segment && segment.naturalHeight) || 0;
    if (!drawRect || !sourceCrop || !bubbleBox || !(canvasWidth > 0 && canvasHeight > 0) || !(naturalWidth > 0 && naturalHeight > 0)) return null;
    const compositeBox = {
      left: bubbleBox.x / 100 * canvasWidth,
      top: bubbleBox.y / 100 * canvasHeight,
      width: bubbleBox.w / 100 * canvasWidth,
      height: bubbleBox.h / 100 * canvasHeight
    };
    const drawBox = {
      left: drawRect.x,
      top: drawRect.y,
      width: drawRect.w,
      height: drawRect.h
    };
    const intersectionLeft = Math.max(compositeBox.left, drawBox.left);
    const intersectionTop = Math.max(compositeBox.top, drawBox.top);
    const intersectionRight = Math.min(compositeBox.left + compositeBox.width, drawBox.left + drawBox.width);
    const intersectionBottom = Math.min(compositeBox.top + compositeBox.height, drawBox.top + drawBox.height);
    if (intersectionRight <= intersectionLeft || intersectionBottom <= intersectionTop) return null;
    const intersection = {
      left: intersectionLeft,
      top: intersectionTop,
      width: intersectionRight - intersectionLeft,
      height: intersectionBottom - intersectionTop
    };
    return runtime.normalizeSeamPercentBox({
      x: (sourceCrop.x + (intersection.left - drawRect.x) * sourceCrop.w / drawRect.w) / naturalWidth * 100,
      y: (sourceCrop.y + (intersection.top - drawRect.y) * sourceCrop.h / drawRect.h) / naturalHeight * 100,
      w: intersection.width * sourceCrop.w / drawRect.w / naturalWidth * 100,
      h: intersection.height * sourceCrop.h / drawRect.h / naturalHeight * 100
    });
  }
  runtime.projectSeamBubbleToPage = projectSeamBubbleToPage;
  function seamBoxOverlapOverSmaller(left, right) {
    if (!left || !right) return 0;
    const intersectionWidth = Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x));
    const intersectionHeight = Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y));
    return intersectionWidth * intersectionHeight / Math.max(0.0001, Math.min(left.w * left.h, right.w * right.h));
  }
  runtime.seamBoxOverlapOverSmaller = seamBoxOverlapOverSmaller;
  function collectSeamSuppressedCanonicalIds(surface, projectionsByPage) {
    const suppressed = new Set();
    if (!surface || !Array.isArray(surface.bubbles) || surface.bubbles.length === 0) return suppressed;
    for (const pageId of Array.isArray(surface.pageIds) ? surface.pageIds : []) {
      const coverages = surface.bubbles.map(bubble => ({
        bubble,
        box: runtime.projectSeamBubbleToPage(surface, bubble, pageId)
      })).filter(item => item.box && (item.box.y <= 6 || item.box.y + item.box.h >= 94));
      if (!coverages.length) continue;
      for (const projection of projectionsByPage instanceof Map ? projectionsByPage.get(pageId) || [] : []) {
        const canonicalId = String(projection && projection.canonicalId || "");
        const role = String(projection && projection.role || "");
        if (!canonicalId || role === "cover" || projection.activeText === false) continue;
        const box = runtime.seamProjectionBox(projection);
        if (!box || !(box.y <= 6 || box.y + box.h >= 94)) continue;
        const regionFamily = runtime.seamProjectionRegionFamily(projection);
        const covered = coverages.some(coverage => runtime.seamProjectionRegionFamily(coverage.bubble) === regionFamily && runtime.seamBoxOverlapOverSmaller(box, coverage.box) >= 0.72 && box.w * box.h <= coverage.box.w * coverage.box.h * 1.35);
        if (covered) suppressed.add(canonicalId);
      }
    }
    for (const canonicalId of Array.isArray(surface.handledCanonicalIds) ? surface.handledCanonicalIds : []) {
      suppressed.delete(String(canonicalId));
    }
    return suppressed;
  }
  runtime.collectSeamSuppressedCanonicalIds = collectSeamSuppressedCanonicalIds;
  function addSeamProjectionSuppressions(index, projectionsByPage) {
    if (!index || !Array.isArray(index.surfaces) || index.surfaces.length === 0) return index;
    const surfaces = index.surfaces.map(surface => runtime.freezeCanonicalValue({
      ...surface,
      suppressedCanonicalIds: [...runtime.collectSeamSuppressedCanonicalIds(surface, projectionsByPage)].sort()
    }));
    const byRenderKey = new Map(surfaces.map(surface => [surface.renderKey, surface]));
    const byPage = new Map();
    for (const [pageId, pageSurfaces] of index.byPage instanceof Map ? index.byPage : []) {
      byPage.set(pageId, Object.freeze(pageSurfaces.map(surface => byRenderKey.get(surface.renderKey) || surface)));
    }
    return {
      ...index,
      byPage,
      surfaces: Object.freeze(surfaces)
    };
  }
  runtime.addSeamProjectionSuppressions = addSeamProjectionSuppressions;
  function getSeamSuppressedCanonicalIds(index) {
    return new Set((Array.isArray(index && index.surfaces) ? index.surfaces : []).flatMap(surface => Array.isArray(surface && surface.suppressedCanonicalIds) ? surface.suppressedCanonicalIds.map(String) : []));
  }
  runtime.getSeamSuppressedCanonicalIds = getSeamSuppressedCanonicalIds;
}
