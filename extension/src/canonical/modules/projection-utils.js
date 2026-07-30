export function installProjectionUtils(runtime) {
  function unionPageBoxes(boxes) {
    const valid = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
    if (!valid.length) return null;
    const left = Math.min(...valid.map(box => box.x));
    const top = Math.min(...valid.map(box => box.y));
    const right = Math.max(...valid.map(box => box.x + box.w));
    const bottom = Math.max(...valid.map(box => box.y + box.h));
    return runtime.normalizeSeamPercentBox({ x: left, y: top, w: right - left, h: bottom - top });
  }

  function canonicalSeamPageBoxes(canonical, observationsById, segments) {
    const segmentByPage = new Map((Array.isArray(segments) ? segments : []).map(segment => [String(segment?.pageId || ""), segment]));
    const pageOrder = new Map([...segmentByPage.keys()].map((pageId, index) => [pageId, index]));
    const textByPage = new Map();
    const coverByPage = new Map();
    for (const observationId of Array.isArray(canonical?.memberObservationIds) ? canonical.memberObservationIds : []) {
      const observation = observationsById instanceof Map ? observationsById.get(String(observationId)) : null;
      for (const span of Array.isArray(observation?.pageSpans) ? observation.pageSpans : []) {
        const pageId = String(span?.pageId || "");
        const segment = segmentByPage.get(pageId);
        const width = Number(segment?.naturalWidth) || 0;
        const height = Number(segment?.naturalHeight) || 0;
        if (!(width > 0 && height > 0)) continue;
        const toPercent = value => {
          const box = runtime.normalizeSpanBoxPixels(value, { width, height });
          return box && runtime.normalizeSeamPercentBox({
            x: box.left / width * 100,
            y: box.top / height * 100,
            w: box.width / width * 100,
            h: box.height / height * 100
          });
        };
        const textBox = toPercent(span?.visual?.textBox || span?.visual?.text_box || span?.box);
        const coverBox = toPercent(span?.visual?.fillBox || span?.visual?.fill_box || span?.box);
        if (textBox) textByPage.set(pageId, [...(textByPage.get(pageId) || []), textBox]);
        if (coverBox) coverByPage.set(pageId, [...(coverByPage.get(pageId) || []), coverBox]);
      }
    }
    const serialize = values => [...values.entries()].map(([pageId, boxes]) => ({
      pageId,
      ...unionPageBoxes(boxes)
    })).filter(item => item.w > 0 && item.h > 0).sort((left, right) =>
      (pageOrder.get(left.pageId) ?? Number.MAX_SAFE_INTEGER) -
      (pageOrder.get(right.pageId) ?? Number.MAX_SAFE_INTEGER) || left.pageId.localeCompare(right.pageId));
    return { text: serialize(textByPage), cover: serialize(coverByPage) };
  }
  runtime.canonicalSeamPageBoxes = canonicalSeamPageBoxes;

  function buildSeamSurfaceBubble(canonical, translation, observations, canvasWidth, canvasHeight, observationsById, segments) {
    const linked = (Array.isArray(observations) ? observations : []).filter(observation => runtime.seamObservationCaptureBox(observation, canvasWidth, canvasHeight));
    const witnessBox = linked.length ? runtime.unionSeamPercentBoxes(linked.map(observation =>
      runtime.seamObservationCaptureBox(observation, canvasWidth, canvasHeight)
    )) : null;
    const hasStructuralWitness = (Array.isArray(canonical?.seamWitnessObservationIds) &&
      canonical.seamWitnessObservationIds.length) ||
      (Array.isArray(canonical?.seamWitnessPairKeys) &&
        canonical.seamWitnessPairKeys.length);
    const structuralBox = hasStructuralWitness ? runtime.canonicalSeamCaptureBox(
        canonical, observationsById, segments, canvasWidth, canvasHeight
      ) : null;
    // 过滤 seam 只提供跨页关系；最终蓝框由可信 page OCR 的几何重建。
    const box = structuralBox || witnessBox;
    if (!box) return null;
    const discardedIds = new Set((canonical?.seamDiscardedObservationIds || []).map(String));
    const trustedMembers = (canonical?.memberObservationIds || []).map(id =>
      observationsById instanceof Map ? observationsById.get(String(id)) : null
    ).filter(item => item && item.sourceType === "page" &&
      !discardedIds.has(String(item.id)));
    const selected = runtime.selectSeamVisualObservation(
      linked.length ? linked : trustedMembers
    );
    const rawVisual = selected && selected.visual && typeof selected.visual === "object" ? selected.visual : {};
    const translatedText = String(translation && (translation.translated_text || translation.translatedText) || "").trim();
    if (!translatedText) return null;
    const bgType = String(rawVisual.bgType || rawVisual.bg_type || "none");
    const bgColor = String(rawVisual.bgColor || rawVisual.bg_color || "");
    const bgConfidence = Number(rawVisual.bgConfidence ?? rawVisual.bg_confidence) || 0;
    const regionId = String(rawVisual.regionId || rawVisual.region_id || "");
    const regionType = String(rawVisual.regionType || rawVisual.region_type || "plain_text");
    const regionPolygon = rawVisual.regionPolygon || rawVisual.region_polygon || null;
    const polygon = rawVisual.polygon || null;
    const textColor = String(rawVisual.textColor || rawVisual.text_color || "");
    const strokeColor = String(rawVisual.strokeColor || rawVisual.stroke_color || "");
    const alignment = runtime.normalizeTextAlignment(rawVisual.alignment);
    const rotationDeg = Number(rawVisual.rotationDeg ?? rawVisual.rotation_deg) || 0;
    const fontWeight = runtime.normalizeFontWeight(rawVisual.fontWeight ?? rawVisual.font_weight);
    const translationRole = String(rawVisual.translationRole || rawVisual.translation_role || "");
    const lineCountObservations = [...linked, ...trustedMembers, selected].filter(Boolean);
    const reportedLineCount = Math.max(1, ...lineCountObservations.map(observation =>
      Number(observation?.visual?.sourceLineCount ?? observation?.visual?.source_line_count) || 1));
    const fontHeightPercent = Math.max(0, ...lineCountObservations.map(observation =>
      Number(observation?.visual?.fontHeightPercent ?? observation?.visual?.font_height_percent) || 0));
    const geometryLineCount = fontHeightPercent > 0
      ? runtime.clamp(Math.round(box.h / Math.max(0.1, fontHeightPercent * 1.18)), 1, 12)
      : 1;
    const sourceLineCount = Math.max(linked.length, trustedMembers.length,
      reportedLineCount, geometryLineCount);
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
    const pageBoxes = runtime.canonicalSeamPageBoxes(canonical, observationsById, segments);
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
      source_line_count: sourceLineCount,
      page_text_boxes: pageBoxes.text,
      page_cover_boxes: pageBoxes.cover
    });
  }
  runtime.buildSeamSurfaceBubble = buildSeamSurfaceBubble;
  function seamBubbleRequiresCleanedImage(bubble) {
    const bgType = String(bubble && (bubble.bg_type || bubble.visual && (bubble.visual.bgType || bubble.visual.bg_type)) || "none").trim().toLowerCase();
    return bgType !== "solid";
  }
  runtime.seamBubbleRequiresCleanedImage = seamBubbleRequiresCleanedImage;
  function seamSurfaceRequiresCleanedImage(bubbles) {
    return (Array.isArray(bubbles) ? bubbles : []).some(runtime.seamBubbleRequiresCleanedImage);
  }
  runtime.seamSurfaceRequiresCleanedImage = seamSurfaceRequiresCleanedImage;
  function inspectCanonicalSeamGeometry(canonical, observationsById, segments) {
    const segmentByPage = new Map((Array.isArray(segments) ? segments : []).map(segment => [String(segment && segment.pageId || ""), segment]));
    const outsideObservationIds = [];
    const missingObservationIds = [];
    let pageObservationCount = 0;
    for (const observationId of Array.isArray(canonical && canonical.memberObservationIds) ? canonical.memberObservationIds : []) {
      const observation = observationsById instanceof Map ? observationsById.get(String(observationId)) : null;
      if (!observation) {
        missingObservationIds.push(String(observationId));
        continue;
      }
      if (observation.sourceType === "seam") continue;
      pageObservationCount += 1;
      const spans = (Array.isArray(observation.pageSpans) ? observation.pageSpans : []).filter(span => segmentByPage.has(String(span && span.pageId || "")));
      const represented = spans.length > 0 && spans.every(span => {
        const segment = segmentByPage.get(String(span.pageId));
        const sourceCrop = runtime.normalizeSeamGeometryRect(segment && segment.sourceCrop);
        const naturalWidth = Number(segment && segment.naturalWidth) || 0;
        const naturalHeight = Number(segment && segment.naturalHeight) || 0;
        const box = runtime.normalizeSpanBoxPixels(span && span.box, {
          width: naturalWidth,
          height: naturalHeight
        });
        if (!sourceCrop || !box || !(naturalWidth > 0 && naturalHeight > 0)) return false;
        const tolerance = Math.max(2, Math.min(naturalWidth, naturalHeight) * 0.002);
        return box.left < sourceCrop.x + sourceCrop.w + tolerance && box.left + box.width > sourceCrop.x - tolerance &&
          box.top < sourceCrop.y + sourceCrop.h + tolerance && box.top + box.height > sourceCrop.y - tolerance;
      });
      if (!represented) outsideObservationIds.push(String(observationId));
    }
    return {
      represented: missingObservationIds.length === 0 && outsideObservationIds.length === 0,
      pageObservationCount,
      outsideObservationIds: outsideObservationIds.sort(),
      missingObservationIds: missingObservationIds.sort()
    };
  }
  runtime.inspectCanonicalSeamGeometry = inspectCanonicalSeamGeometry;
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
  function resolveSeamSurfaceCandidates(candidates) {
    const ranked = [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => {
      const leftBox = runtime.normalizeSeamPercentBox(left && left.bubble);
      const rightBox = runtime.normalizeSeamPercentBox(right && right.bubble);
      const areaDifference = (rightBox ? rightBox.w * rightBox.h : 0) - (leftBox ? leftBox.w * leftBox.h : 0);
      if (Math.abs(areaDifference) > 0.0001) return areaDifference;
      const lineDifference = Number(right && right.bubble && right.bubble.source_line_count || 1) - Number(left && left.bubble && left.bubble.source_line_count || 1);
      if (lineDifference) return lineDifference;
      const textDifference = String(right && right.bubble && right.bubble.original_text || "").length - String(left && left.bubble && left.bubble.original_text || "").length;
      return textDifference || String(left && left.canonical && left.canonical.id || "").localeCompare(String(right && right.canonical && right.canonical.id || ""));
    });
    const selected = [];
    const suppressed = [];
    for (const candidate of ranked) {
      const canonical = candidate && candidate.canonical || {};
      const ownershipIds = new Set((canonical.memberObservationIds || []).map(String));
      const lineageIds = new Set([canonical.id, canonical.supersedesId].filter(Boolean).map(String));
      const winner = selected.find(item => {
        const winnerCanonical = item.candidate.canonical || {};
        const winnerMembers = (winnerCanonical.memberObservationIds || []).map(String);
        const winnerLineage = [winnerCanonical.id, winnerCanonical.supersedesId].filter(Boolean).map(String);
        return winnerMembers.some(id => ownershipIds.has(id)) || winnerLineage.some(id => lineageIds.has(id));
      });
      if (winner) {
        suppressed.push({
          candidate,
          winner: winner.candidate,
          ownership: "canonical_or_observation"
        });
      } else {
        selected.push({ candidate });
      }
    }
    return {
      selected: selected.map(item => item.candidate).sort((left, right) => left.bubble.y - right.bubble.y || left.bubble.x - right.bubble.x || String(left.canonical.id).localeCompare(String(right.canonical.id))),
      suppressed
    };
  }
  runtime.resolveSeamSurfaceCandidates = resolveSeamSurfaceCandidates;
  function buildSeamSurfaceDebug(debug, bubbles) {
    if (!debug || typeof debug !== "object") return debug;
    const finalBubbles = (Array.isArray(bubbles) ? bubbles : []).map((bubble, index) => ({
      id: `c${index}`,
      blockId: `c${index}`,
      text: String(bubble && (bubble.original_text || bubble.originalText) || ""),
      translatedText: String(bubble && (bubble.translated_text || bubble.translatedText) || ""),
      percent: {
        x: Number(bubble.x) || 0,
        y: Number(bubble.y) || 0,
        w: Number(bubble.w) || 0,
        h: Number(bubble.h) || 0
      }
    }));
    return {
      ...debug,
      finalBubbles,
      items: finalBubbles
    };
  }
  runtime.buildSeamSurfaceDebug = buildSeamSurfaceDebug;
  function resolvePageDebugForSeamSurfaces(debug, surfaces, _pageId) {
    if (!debug || typeof debug !== "object" || !Array.isArray(debug.finalBubbles)) return debug;
    const ownershipIds = new Set((Array.isArray(surfaces) ? surfaces : []).flatMap(surface => [
      ...(surface && surface.absorbedCanonicalIds || []),
      ...(surface && surface.absorbedObservationIds || []),
      ...(surface && surface.absorbedDebugItemIds || [])
    ]).map(String));
    if (!ownershipIds.size) return debug;
    const finalBubbles = debug.finalBubbles.filter(item => {
      const ids = [item && item.canonicalId, item && item.canonical_id, item && item.observationId,
        item && item.observation_id, item && item.blockId, item && item.block_id, item && item.id]
        .filter(Boolean).map(String);
      return !ids.some(id => ownershipIds.has(id));
    });
    if (finalBubbles.length === debug.finalBubbles.length) return debug;
    return {
      ...debug,
      finalBubbles,
      items: finalBubbles
    };
  }
  runtime.resolvePageDebugForSeamSurfaces = resolvePageDebugForSeamSurfaces;
  function resolveSeamProjectionPlan(index, buildProjections) {
    if (!index || typeof buildProjections !== "function") return {
      seamSurfaceIndex: index,
      handledCanonicalIds: new Set(),
      projections: new Map()
    };
    // 跨页 surface 对 canonical/observation 的所有权由 reconcile 明确给出，
    // 普通页 projection 不再通过蓝框重叠率猜测是否应该隐藏。
    const handledCanonicalIds = new Set([
      ...Array.from(index.handledCanonicalIds || [], String),
      ...Array.from(index.absorbedCanonicalIds || [], String)
    ]);
    return {
      seamSurfaceIndex: index,
      handledCanonicalIds,
      projections: buildProjections(handledCanonicalIds)
    };
  }
  runtime.resolveSeamProjectionPlan = resolveSeamProjectionPlan;
}
