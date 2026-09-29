export function installCleanedArtifactPlan(runtime) {
  function projectionKey(projection) {
    return String(projection && (projection.projectionId || projection.id) ||
      `${projection && projection.canonicalId || ""}|${projection && projection.role || ""}`);
  }
  /**
   * 清理图要覆盖"即将渲染的投影"，而不是只覆盖未被子接缝接管的那一份。
   *
   * 渲染侧会把 fallback 投影并回页面（见 scene-canonical 的 fallbackPages），
   * 而清理计划原先只看 plan 那一份：于是会出现"渲染画的是 bg_type=none 的透明遮罩、
   * 清理计划却认为这一页不需要清理图"的分叉，那一页就永远没有 inpainted 遮罩。
   * 这里把两份按 projectionId 取并集，页面要画什么就为它要什么清理图。
   */
  function mergeCleanedArtifactProjectionSource(planProjections, fallbackProjections) {
    const merged = new Map();
    const put = source => {
      const entries = source instanceof Map ? source : new Map();
      for (const [pageId, projections] of entries) {
        const key = String(pageId);
        const list = merged.get(key) || [];
        const known = new Set(list.map(projectionKey));
        for (const projection of Array.isArray(projections) ? projections : []) {
          const itemKey = projectionKey(projection);
          if (known.has(itemKey)) continue;
          known.add(itemKey);
          list.push(projection);
        }
        merged.set(key, list);
      }
    };
    put(planProjections);
    put(fallbackProjections);
    return merged;
  }
  runtime.mergeCleanedArtifactProjectionSource = mergeCleanedArtifactProjectionSource;

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
