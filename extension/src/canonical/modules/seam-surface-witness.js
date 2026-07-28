export function installSeamSurfaceWitness(runtime) {
  function buildSeamStateEvidence(state) {
    const observationIds = new Set(
      (Array.isArray(state?.observationIds) ? state.observationIds : []).map(String)
    );
    const filteredIds = new Set(
      (Array.isArray(state?.filteredObservations) ? state.filteredObservations : [])
        .map(item => String(item?.id || "")).filter(Boolean)
    );
    return {
      pairKey: String(state?.pairKey || ""),
      observationIds,
      evidenceIds: new Set([...observationIds, ...filteredIds]),
      observationsById: new Map([
        ...(Array.isArray(state?.observations) ? state.observations : []),
        ...(Array.isArray(state?.filteredObservations) ? state.filteredObservations : [])
      ].map(item => [String(item?.id || ""), item]))
    };
  }
  runtime.buildSeamStateEvidence = buildSeamStateEvidence;

  function linkCanonicalToSeamState(canonical, evidence) {
    const memberIds = (Array.isArray(canonical?.memberObservationIds) ?
      canonical.memberObservationIds : []).map(String)
      .filter(id => evidence.observationIds.has(id));
    const witnessIds = (Array.isArray(canonical?.seamWitnessObservationIds) ?
      canonical.seamWitnessObservationIds : []).map(String)
      .filter(id => evidence.evidenceIds.has(id));
    const pairWitness = (Array.isArray(canonical?.seamWitnessPairKeys) ?
      canonical.seamWitnessPairKeys : []).map(String)
      .includes(evidence.pairKey);
    return {
      memberIds,
      witnessIds,
      pairWitness,
      linkedIds: [...new Set([...memberIds, ...witnessIds])].sort()
    };
  }
  runtime.linkCanonicalToSeamState = linkCanonicalToSeamState;

  function canonicalSeamCaptureBox(canonical, observationsById, segments,
    canvasWidth, canvasHeight) {
    if (!(canvasWidth > 0 && canvasHeight > 0)) return null;
    const discardedIds = new Set((Array.isArray(canonical?.seamDiscardedObservationIds) ?
      canonical.seamDiscardedObservationIds : []).map(String));
    const segmentByPage = new Map((Array.isArray(segments) ? segments : [])
      .map(segment => [String(segment?.pageId || ""), segment]));
    const boxes = [];
    for (const observationId of Array.isArray(canonical?.memberObservationIds) ?
      canonical.memberObservationIds : []) {
      if (discardedIds.has(String(observationId))) continue;
      const observation = observationsById instanceof Map ?
        observationsById.get(String(observationId)) : null;
      if (!observation || observation.sourceType === "seam") continue;
      for (const span of Array.isArray(observation.pageSpans) ? observation.pageSpans : []) {
        const segment = segmentByPage.get(String(span?.pageId || ""));
        const draw = runtime.normalizeSeamGeometryRect(segment?.drawRect);
        const crop = runtime.normalizeSeamGeometryRect(segment?.sourceCrop);
        const naturalWidth = Number(segment?.naturalWidth) || 0;
        const naturalHeight = Number(segment?.naturalHeight) || 0;
        const spanBox = runtime.normalizeSpanBoxPixels(span?.visual?.fillBox ||
          span?.visual?.fill_box || span?.box, {
          width: naturalWidth,
          height: naturalHeight
        });
        if (!draw || !crop || !spanBox || !(naturalWidth > 0 && naturalHeight > 0)) continue;
        const left = Math.max(spanBox.left, crop.x);
        const top = Math.max(spanBox.top, crop.y);
        const right = Math.min(spanBox.left + spanBox.width, crop.x + crop.w);
        const bottom = Math.min(spanBox.top + spanBox.height, crop.y + crop.h);
        if (right <= left || bottom <= top) continue;
        boxes.push(runtime.normalizeSeamPercentBox({
          x: (draw.x + (left - crop.x) * draw.w / crop.w) / canvasWidth * 100,
          y: (draw.y + (top - crop.y) * draw.h / crop.h) / canvasHeight * 100,
          w: (right - left) * draw.w / crop.w / canvasWidth * 100,
          h: (bottom - top) * draw.h / crop.h / canvasHeight * 100
        }));
      }
    }
    return runtime.unionSeamPercentBoxes(boxes);
  }
  runtime.canonicalSeamCaptureBox = canonicalSeamCaptureBox;
}
