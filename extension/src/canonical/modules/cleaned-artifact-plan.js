export function installCleanedArtifactPlan(runtime) {
  function buildCleanedArtifactProjectionPlan(projectionsByPage, seamSurfaceIndex) {
    const planned = new Map([...(projectionsByPage instanceof Map ? projectionsByPage : new Map())]
      .map(([pageId, projections]) => [String(pageId), [...(Array.isArray(projections) ? projections : [])]]));
    const surfaces = Array.isArray(seamSurfaceIndex?.surfaces) ? seamSurfaceIndex.surfaces : [];
    for (const surface of surfaces) {
      const segments = new Map((surface.segments || []).map(segment => [String(segment?.pageId || ""), segment]));
      for (const bubble of surface.bubbles || []) {
        if (!runtime.seamBubbleRequiresCleanedImage(bubble)) continue;
        for (const value of bubble.page_cover_boxes || []) {
          const pageId = String(value?.pageId || "");
          const segment = segments.get(pageId);
          const box = runtime.normalizeSeamPercentBox(value);
          const crop = runtime.normalizeSeamGeometryRect(segment?.sourceCrop);
          const naturalWidth = Number(segment?.naturalWidth) || 0;
          const naturalHeight = Number(segment?.naturalHeight) || 0;
          if (!pageId || !box || !crop || !(naturalWidth > 0 && naturalHeight > 0)) continue;
          const source = {
            left: box.x / 100 * naturalWidth,
            top: box.y / 100 * naturalHeight,
            right: (box.x + box.w) / 100 * naturalWidth,
            bottom: (box.y + box.h) / 100 * naturalHeight
          };
          const tolerance = Math.max(0.01, Math.min(naturalWidth, naturalHeight) * 0.00001);
          const contained = source.left >= crop.x - tolerance && source.top >= crop.y - tolerance &&
            source.right <= crop.x + crop.w + tolerance && source.bottom <= crop.y + crop.h + tolerance;
          if (contained) continue;
          const projections = planned.get(pageId) || [];
          projections.push({
            canonicalId: `${String(bubble.canonicalId || bubble.canonical_id || bubble.id || "seam")}:page-cover`,
            active: true,
            activeText: true,
            geometry: box,
            visual: {
              bgType: "none"
            }
          });
          planned.set(pageId, projections);
        }
      }
    }
    return planned;
  }
  runtime.buildCleanedArtifactProjectionPlan = buildCleanedArtifactProjectionPlan;

  function buildSeamCleanedArtifactPlan(seamSurfaceIndex) {
    const plans = new Map();
    for (const surface of Array.isArray(seamSurfaceIndex?.surfaces) ?
      seamSurfaceIndex.surfaces : []) {
      const pageIds = (surface.pageIds || []).map(String);
      const projections = (surface.bubbles || []).map(bubble => ({
        canonicalId: String(bubble?.canonicalId || bubble?.canonical_id ||
          bubble?.id || ""),
        active: true,
        activeText: true,
        geometry: bubble?.fill_box || bubble,
        visual: {
          bgType: String(bubble?.bg_type || bubble?.visual?.bgType || "none")
        }
      }));
      const cleanedMasks = runtime.buildCanonicalCleanMasks(projections);
      if (!surface.pairKey || pageIds.length !== 2 || cleanedMasks.length === 0) continue;
      const revisions = Object.entries(surface.imageRevisionByPage || {})
        .map(([pageId, revision]) => [String(pageId), String(revision)])
        .sort(([left], [right]) => left.localeCompare(right));
      plans.set(String(surface.pairKey), {
        pairKey: String(surface.pairKey),
        pageIds,
        revisionKey: JSON.stringify(revisions),
        cleanedMasks
      });
    }
    return [...plans.values()].sort((left, right) =>
      left.pairKey.localeCompare(right.pairKey));
  }
  runtime.buildSeamCleanedArtifactPlan = buildSeamCleanedArtifactPlan;

  function buildSeamCleanedArtifactPayload(state) {
    const width = Number(state?.canvasWidth || state?.payloadGeometry?.canvasWidth) || 0;
    const height = Number(state?.canvasHeight || state?.payloadGeometry?.canvasHeight) || 0;
    return {
      dataUrl: String(state?.cleanedImage || ""),
      imageUrl: `kakao-seam-artifact:${String(state?.pairKey || "")}`,
      width,
      height,
      sourceWidth: width,
      sourceHeight: height,
      cssWidth: width,
      cssHeight: height,
      source: "kakao-seam-artifact",
      sourceType: "seam",
      ocrMode: "seam",
      pageIds: Array.isArray(state?.pageIds) ? state.pageIds.map(String) : [],
      imageRevisionByPage: state?.imageRevisionByPage || {},
      pageSpans: state?.pageSpans || state?.payloadGeometry?.pageSpans || [],
      seam: state?.seam || state?.payloadGeometry?.seam || null,
      coordinateSpace: "kakao-seam-v1"
    };
  }
  runtime.buildSeamCleanedArtifactPayload = buildSeamCleanedArtifactPayload;
}
