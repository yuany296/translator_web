export function installSceneIndexBuilder(runtime) {
  function buildSeamRenderSurfaceIndex(activeStore, options = {}) {
    const byPage = new Map();
    const surfaces = [];
    const handledCanonicalIds = new Set();
    const absorbedCanonicalIds = new Set();
    if (!activeStore) return {
      byPage,
      surfaces: Object.freeze([]),
      handledCanonicalIds,
      absorbedCanonicalIds
    };
    const canonicals = activeStore.getCanonicalSnapshot();
    const retiredCanonicals = typeof activeStore.getRetiredCanonicals === "function" ?
      activeStore.getRetiredCanonicals() : [];
    const observationsById = new Map(activeStore.getObservations().map(item => [String(item.id || ""), item]));
    for (const state of activeStore.getSeamStates()) {
      if (!state || state.status !== "completed") continue;
      const pageIds = (Array.isArray(state.pageIds) ? state.pageIds : []).map(String);
      if (pageIds.length !== 2 || new Set(pageIds).size !== 2) continue;
      const currentRecords = pageIds.map(pageId => activeStore.getPageHandle(pageId));
      if (currentRecords.some((record, index) => !record || String(record.imageRevision || "") !== String(state.imageRevisionByPage && state.imageRevisionByPage[pageIds[index]] || ""))) {
        continue;
      }
      if (currentRecords.some(record => {
        const terminal = activeStore.getPageTerminal(record.pageId);
        return !terminal || terminal.state !== "ready" || terminal.details && terminal.details.imageRevision && String(terminal.details.imageRevision) !== String(record.imageRevision || "");
      })) continue;
      // seam 所有权来自已完成的 canonical 证据，不应随瞬时 DOM 可用性改变。
      // 目标暂时缺席时由内容渲染层延后安装；这里仍需保留 surface，避免退回单页投影。
      const canvasWidth = Number(state.canvasWidth || state.payloadGeometry && state.payloadGeometry.canvasWidth) || 0;
      const canvasHeight = Number(state.canvasHeight || state.payloadGeometry && state.payloadGeometry.canvasHeight) || 0;
      const segments = Array.isArray(state.segments) ? state.segments : [];
      if (!(canvasWidth > 0 && canvasHeight > 0) || pageIds.some(pageId => !segments.some(segment => String(segment && segment.pageId || "") === pageId && runtime.isValidSeamSurfaceSegment(segment)))) {
        continue;
      }
      const stateEvidence = runtime.buildSeamStateEvidence(state); const { observationIds: stateObservationIds, observationsById: stateObservationsById } = stateEvidence;
      const candidates = [];
      const candidateDiagnostics = [];
      const canonicalMemberIds = new Set(canonicals.flatMap(canonical => (Array.isArray(canonical && canonical.memberObservationIds) ? canonical.memberObservationIds : []).map(String)));
      const coverageLedger = activeStore.getCoverageLedger();
      for (const observationId of stateObservationIds) {
        if (canonicalMemberIds.has(observationId)) continue;
        const resolution = coverageLedger.get(observationId) || null;
        candidateDiagnostics.push({
          observationId,
          reason: "no_canonical",
          resolution: String(resolution && (resolution.resolution || resolution.status) || "missing"),
          filterReason: String(resolution && resolution.filterReason || "")
        });
      }
      for (const canonical of canonicals) {
        if (!canonical) continue;
        const canonicalId = String(canonical.id || "");
        const { linkedIds: stateLinkedIds, pairWitness } =
          runtime.linkCanonicalToSeamState(canonical, stateEvidence);
        if (!stateLinkedIds.length && !pairWitness) continue;
        if (handledCanonicalIds.has(canonicalId)) {
          candidateDiagnostics.push({
            canonicalId,
            reason: "already_handled",
            stateLinkedIds
          });
          continue;
        }
        const canonicalPageIds = Object.entries(canonical.geometryByPage || {}).filter(([, geometries]) => Array.isArray(geometries) ? geometries.length > 0 : !!geometries).map(([pageId]) => String(pageId)).sort();
        if (canonicalPageIds.length !== pageIds.length || pageIds.some(pageId => !canonicalPageIds.includes(pageId))) {
          candidateDiagnostics.push({
            canonicalId,
            reason: "page_mismatch",
            stateLinkedIds,
            canonicalPageIds
          });
          continue;
        }
        const seamGeometry = runtime.inspectCanonicalSeamGeometry(canonical, observationsById, segments);
        if (!seamGeometry.represented) {
          candidateDiagnostics.push({
            canonicalId,
            reason: "canonical_geometry_outside_capture",
            stateLinkedIds,
            canonicalPageIds,
            outsideObservationIds: seamGeometry.outsideObservationIds,
            missingObservationIds: seamGeometry.missingObservationIds
          });
          continue;
        }
        const linked = stateLinkedIds.map(id => stateObservationsById.get(String(id)) ||
          observationsById.get(String(id))).filter(observation =>
          runtime.observationHasTrueSeamContribution(observation, pageIds));
        if (!linked.length && !pairWitness) {
          candidateDiagnostics.push({
            canonicalId,
            reason: "no_linked_observation",
            stateLinkedIds,
            canonicalPageIds
          });
          continue;
        }
        if (linked.length && !runtime.seamObservationsCoverPair(linked, pageIds)) {
          candidateDiagnostics.push({
            canonicalId,
            reason: "incomplete_pair",
            stateLinkedIds,
            canonicalPageIds
          });
          continue;
        }
        const translation = activeStore.getTranslation(canonical.id, canonical.revision);
        if (!translation || !String(translation.translated_text || translation.translatedText || "").trim()) {
          candidateDiagnostics.push({
            canonicalId,
            revision: Math.max(1, Number(canonical.revision) || 1),
            reason: "missing_translation",
            stateLinkedIds,
            canonicalPageIds
          });
          continue;
        }
        const bubble = runtime.buildSeamSurfaceBubble(canonical, translation, linked, canvasWidth, canvasHeight, observationsById, segments);
        if (!bubble) {
          candidateDiagnostics.push({
            canonicalId,
            reason: "bubble_build_failed",
            stateLinkedIds,
            canonicalPageIds
          });
          continue;
        }
        candidateDiagnostics.push({
          canonicalId,
          reason: "candidate",
          stateLinkedIds,
          canonicalPageIds
        });
        candidates.push({
          canonical,
          translation,
          bubble
        });
      }
      const hasDebug = runtime.hasRenderableSeamDebug(state.debug);
      if (!candidates.length && !hasDebug) continue;
      const cleanedImage = runtime.isDataUrlValue(state.cleanedImage) ? state.cleanedImage : null;
      const renderable = candidates.filter(candidate => !runtime.seamBubbleRequiresCleanedImage(candidate.bubble) || !!cleanedImage);
      const candidatePlan = runtime.resolveSeamSurfaceCandidates(renderable);
      const selected = candidatePlan.selected;
      const overlapSuppressedIds = new Map(candidatePlan.suppressed.map(item => [String(item.candidate.canonical.id || ""), String(item.winner.canonical.id || "")]));
      const renderableIds = new Set(renderable.map(candidate => String(candidate.canonical.id || "")));
      for (const candidate of candidates) {
        const canonicalId = String(candidate.canonical.id || "");
        const diagnostic = candidateDiagnostics.find(item => item.canonicalId === canonicalId && item.reason === "candidate");
        if (!diagnostic) continue;
        const winnerCanonicalId = overlapSuppressedIds.get(canonicalId);
        diagnostic.reason = winnerCanonicalId ? "ownership_suppressed" : renderableIds.has(canonicalId) ? "accepted" : "missing_cleaned_image";
        if (winnerCanonicalId) diagnostic.winnerCanonicalId = winnerCanonicalId;
      }
      if (!selected.length && !hasDebug) continue;
      const handledCandidates = [...selected, ...candidatePlan.suppressed.map(item => item.candidate)].sort((left, right) => String(left.canonical.id).localeCompare(String(right.canonical.id)));
      const handledIds = Object.freeze(handledCandidates.map(candidate => String(candidate.canonical.id)));
      const ownership = runtime.collectSeamSurfaceOwnership(
        selected, handledCandidates, canonicals, observationsById, segments
      );
      const { coveredResiduals, absorbedIdSet } = ownership;
      candidateDiagnostics.push(...ownership.diagnostics);
      // 同气泡相邻行被吸收后,把译文与几何并入 winner 气泡:
      // 单页投影已被 absorbedIds 抑制,若不并入,跨页气泡会缺少相邻行文本,
      // 原文也会因覆盖框不含相邻行而残留。
      const extendedBubbleByCanonicalId = runtime.buildSeamExtendedBubbles(
        selected, coveredResiduals, activeStore, observationsById, segments,
        canvasWidth, canvasHeight, pageIds
      );
      const bubbleForCandidate = candidate =>
        extendedBubbleByCanonicalId.get(String(candidate.canonical.id)) || candidate.bubble;
      const bubbles = Object.freeze(selected.map(bubbleForCandidate));
      let lineageChanged = true;
      while (lineageChanged) {
        lineageChanged = false;
        for (const retired of retiredCanonicals) {
          const retiredId = String(retired && retired.id || "");
          const successorId = String(retired && retired.retiredById || "");
          if (retiredId && absorbedIdSet.has(successorId) && !absorbedIdSet.has(retiredId)) {
            absorbedIdSet.add(retiredId);
            lineageChanged = true;
          }
        }
      }
      const absorbedIds = Object.freeze([...absorbedIdSet].sort());
      const absorbedRecords = [
        ...handledCandidates.map(candidate => candidate.canonical),
        ...coveredResiduals.map(item => item.canonical),
        ...retiredCanonicals.filter(canonical => absorbedIdSet.has(String(canonical && canonical.id || "")))
      ];
      const absorbedObservationIds = Object.freeze([...new Set(absorbedRecords.flatMap(canonical =>
        (canonical.memberObservationIds || []).map(String)
      ))].sort());
      const absorbedDebugItemIds = Object.freeze([...new Set(absorbedObservationIds.flatMap(id => {
        const observation = observationsById.get(id) || stateObservationsById.get(id) || {};
        return [id, observation.providerBlockId, observation.blockId, observation.block_id]
          .filter(Boolean).map(String);
      }))].sort());
      const requiresCleanedImage = runtime.seamSurfaceRequiresCleanedImage(bubbles);
      const cleanedImageToken = requiresCleanedImage ? String(state.cleanedImageToken || (cleanedImage ? `derived-${runtime.hashFnv1a(cleanedImage)}` : "")) : "";
      const cleanedImageByPage = Object.fromEntries(currentRecords.map(record => [String(record.pageId),
        runtime.isDataUrlValue(record.cleanedImage) ? record.cleanedImage : ""]));
      const canonicalRevisionById = Object.fromEntries(handledCandidates.map(candidate => [String(candidate.canonical.id), Math.max(1, Number(candidate.canonical.revision) || 1)]));
      const translationFingerprintByCanonicalId = Object.fromEntries(handledCandidates.map(candidate => [String(candidate.canonical.id), String(candidate.translation && (candidate.translation.translationFingerprint || candidate.translation.translation_fingerprint) || runtime.hashFnv1a(bubbleForCandidate(candidate).translated_text))]));
      const layoutFingerprint = JSON.stringify({
        pairKey: state.pairKey,
        canvasWidth,
        canvasHeight,
        bubbles: selected.map(candidate => {
          const bubble = bubbleForCandidate(candidate);
          return {
            id: candidate.canonical.id,
            revision: candidate.canonical.revision,
            translationFingerprint: String(candidate.translation && (candidate.translation.translationFingerprint || candidate.translation.translation_fingerprint) || runtime.hashFnv1a(bubble.translated_text)),
            box: [bubble.x, bubble.y, bubble.w, bubble.h]
          };
        })
      });
      const layoutKey = `seam-layout-v1:${runtime.hashFnv1a(layoutFingerprint)}`;
      const renderKey = `seam-render-v1:${runtime.hashFnv1a(JSON.stringify({
        pairKey: state.pairKey,
        imageRevisionByPage: pageIds.map(pageId => [pageId, state.imageRevisionByPage[pageId]]),
        layoutKey,
        cleanedImageToken,
        absorbedIds,
        absorbedObservationIds,
        absorbedDebugItemIds
      }))}`;
      const surface = runtime.freezeCanonicalValue({
        renderKey,
        layoutKey,
        pairKey: String(state.pairKey || ""),
        coordinateSpace: "kakao-seam-v1",
        canvasWidth,
        canvasHeight,
        pageIds,
        imageRevisionByPage: state.imageRevisionByPage || {},
        canonicalRevisionById,
        translationFingerprintByCanonicalId,
        artifactFingerprint: cleanedImageToken,
        segments,
        cleanedImage: requiresCleanedImage ? cleanedImage : null,
        cleanedImageByPage,
        cleanedImageToken,
        bubbles,
        debug: runtime.buildSeamSurfaceDebug(state.debug || null, bubbles),
        diagnostics: Object.freeze(candidateDiagnostics.map(item => Object.freeze({
          ...item
        }))),
        handledCanonicalIds: handledIds,
        absorbedCanonicalIds: absorbedIds,
        absorbedObservationIds,
        absorbedDebugItemIds
      });
      surfaces.push(surface);
      for (const canonicalId of handledIds) handledCanonicalIds.add(canonicalId);
      for (const canonicalId of absorbedIds) absorbedCanonicalIds.add(canonicalId);
      for (const pageId of pageIds) {
        if (!byPage.has(pageId)) byPage.set(pageId, []);
        byPage.get(pageId).push(surface);
      }
    }
    for (const [pageId, pageSurfaces] of byPage) {
      byPage.set(pageId, Object.freeze([...pageSurfaces].sort((left, right) => left.pairKey.localeCompare(right.pairKey))));
    }
    return {
      byPage,
      surfaces: Object.freeze([...surfaces]),
      handledCanonicalIds,
      absorbedCanonicalIds
    };
  }
  runtime.buildSeamRenderSurfaceIndex = buildSeamRenderSurfaceIndex;
  function buildFallbackObservationId(value) {
    const stable = JSON.stringify({
      providerBlockId: value.providerBlockId,
      sourceType: value.sourceType,
      pageIds: [...value.pageIds].sort(),
      imageRevisionByPage: Object.fromEntries(Object.entries(value.imageRevisionByPage).sort(([a], [b]) => a.localeCompare(b))),
      originalText: String(value.originalText || "").normalize("NFKC"),
      pageSpans: value.pageSpans
    });
    return `obs:${runtime.hashFnv1a(stable)}`;
  }
  runtime.buildFallbackObservationId = buildFallbackObservationId;
  function dedupeObservationsById(items) {
    return [...new Map((Array.isArray(items) ? items : []).filter(item => item && item.id).map(item => [item.id, item])).values()].sort(runtime.compareStableIds);
  }
  runtime.dedupeObservationsById = dedupeObservationsById;
  function observationMatchesPageRevisions(observation, records) {
    const current = new Map((Array.isArray(records) ? records : []).map(record => [record.pageId, record.imageRevision]));
    for (const pageId of observation && observation.pageIds || []) {
      if (!current.has(pageId)) continue;
      if (String(observation.imageRevisionByPage && observation.imageRevisionByPage[pageId] || "") !== String(current.get(pageId) || "")) {
        return false;
      }
    }
    return true;
  }
  runtime.observationMatchesPageRevisions = observationMatchesPageRevisions;
  function calculateCanonicalSeamHeight(widthA, widthB) {
    const reconciler = runtime.getCanonicalReconciler();
    if (reconciler && typeof reconciler.calculateSeamBandHeight === "function") {
      return reconciler.calculateSeamBandHeight(widthA, widthB);
    }
    const width = Math.max(1, Math.min(Number(widthA) || 1, Number(widthB) || 1));
    return runtime.clamp(Math.round(width * runtime.KAKAO_SEAM_HEIGHT_WIDTH_RATIO), runtime.KAKAO_SEAM_HEIGHT_MIN_PX, runtime.KAKAO_SEAM_HEIGHT_MAX_PX);
  }
  runtime.calculateCanonicalSeamHeight = calculateCanonicalSeamHeight;
  function buildCanonicalPairKey(pageA, pageB) {
    const reconciler = runtime.getCanonicalReconciler();
    if (reconciler && typeof reconciler.buildSeamPairKey === "function") {
      return reconciler.buildSeamPairKey(runtime.canonicalPageDescriptor(pageA), runtime.canonicalPageDescriptor(pageB));
    }
    return `${pageA.pageId}>${pageB.pageId}@${pageA.imageRevision}>${pageB.imageRevision}`;
  }
  runtime.buildCanonicalPairKey = buildCanonicalPairKey;
  function isCanonicalShortPage(record) {
    if (record && typeof record.shortPage === "boolean") return record.shortPage;
    const width = Math.max(1, Number(record && record.width) || 1);
    const height = Math.max(1, Number(record && record.height) || 1);
    return height <= Math.max(runtime.KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT, width * runtime.KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO);
  }
  runtime.isCanonicalShortPage = isCanonicalShortPage;
  function normalizeAdjacentTargets(value) {
    const output = [];
    if (value && value.previous) output.push(Object.freeze({
      side: "previous",
      target: value.previous
    }));
    if (value && value.next) output.push(Object.freeze({
      side: "next",
      target: value.next
    }));
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item) continue;
        if (item.target) output.push(Object.freeze({
          side: item.side === "previous" ? "previous" : "next",
          target: item.target
        }));else output.push(Object.freeze({
          side: "next",
          target: item
        }));
      }
    }
    return output;
  }
  runtime.normalizeAdjacentTargets = normalizeAdjacentTargets;
  function mergeAdjacentTargetRelation(existing, addition) {
    const output = [];
    for (const relation of [...(Array.isArray(existing) ? existing : []), addition]) {
      if (!relation || !relation.target) continue;
      const side = relation.side === "previous" ? "previous" : "next";
      if (output.some(item => item.side === side && item.target === relation.target)) continue;
      output.push(Object.freeze({
        side,
        target: relation.target
      }));
    }
    return output;
  }
  runtime.mergeAdjacentTargetRelation = mergeAdjacentTargetRelation;
  function collectPageEdgeSides(record, observations, filteredObservations, edgeSignals) {
    const sides = new Set();
    for (const observation of [...observations, ...filteredObservations]) {
      for (const side of runtime.getObservationEdgeSides(observation, record)) sides.add(side);
    }
    const signal = edgeSignals || {};
    if (runtime.isCanonicalEdgeSignalDetected(signal.top) || signal.intersectsTop === true || signal.hasTop === true || signal.topCount > 0) sides.add("top");
    if (runtime.isCanonicalEdgeSignalDetected(signal.bottom) || signal.intersectsBottom === true || signal.hasBottom === true || signal.bottomCount > 0) sides.add("bottom");
    if (Array.isArray(signal.sides)) for (const side of signal.sides) if (side === "top" || side === "bottom") sides.add(side);
    return [...sides].sort();
  }
  runtime.collectPageEdgeSides = collectPageEdgeSides;
  function isCanonicalEdgeSignalDetected(value) {
    if (value === true) return true;
    if (!value || typeof value !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(value, "detected")) return value.detected === true;
    if (Object.prototype.hasOwnProperty.call(value, "visualDetected")) return value.visualDetected === true;
    if (Object.prototype.hasOwnProperty.call(value, "visual_detected")) return value.visual_detected === true;
    return [value.retainedObservationIds, value.filteredObservationIds, value.ids, value.regionIds, value.polygons].some(items => Array.isArray(items) && items.length > 0);
  }
  runtime.isCanonicalEdgeSignalDetected = isCanonicalEdgeSignalDetected;
  function getObservationEdgeSides(observation, record) {
    const sides = new Set();
    const band = Math.min(Number(record.height) || 1, runtime.calculateCanonicalSeamHeight(record.width, record.width));
    for (const span of observation && observation.pageSpans || []) {
      if (String(span && span.pageId || "") !== String(record.pageId)) continue;
      const box = runtime.normalizeSpanBoxPixels(span.box, record);
      if (box && box.top < band && box.top + box.height > 0) sides.add("top");
      if (box && box.top < record.height && box.top + box.height > record.height - band) sides.add("bottom");
      if (!box && Array.isArray(span.polygon) && span.polygon.length) {
        const points = span.polygon.map(point => Array.isArray(point) ? point : [point.x, point.y]);
        const ys = points.map(point => Number(point[1])).filter(Number.isFinite);
        if (ys.length) {
          const percent = Math.max(...ys.map(Math.abs)) <= 100;
          const minY = Math.min(...ys) * (percent ? record.height / 100 : 1);
          const maxY = Math.max(...ys) * (percent ? record.height / 100 : 1);
          if (minY < band) sides.add("top");
          if (maxY > record.height - band) sides.add("bottom");
        }
      }
    }
    return [...sides].sort();
  }
  runtime.getObservationEdgeSides = getObservationEdgeSides;

  // 同气泡相邻行(kind: "adjacent_line" 的 coveredResidual)被吸收进 surface 后,
  // 其译文按页面顺序与纵向位置并入 winner 气泡文本,page_text/cover 框与
  // 复合框一并扩展,保证跨页气泡完整覆盖原文且译文不缺行。
  function buildSeamExtendedBubbles(selected, coveredResiduals, store,
    observationsById, segments, canvasWidth, canvasHeight, pageIds) {
    const extended = new Map();
    const pageIndex = new Map((Array.isArray(pageIds) ? pageIds : [])
      .map((pageId, index) => [String(pageId), index]));
    const residualsByWinner = new Map();
    for (const item of Array.isArray(coveredResiduals) ? coveredResiduals : []) {
      if (item.kind !== "adjacent_line") continue;
      const canonical = item.canonical;
      const residualBox = runtime.canonicalSeamCaptureBox(canonical, observationsById,
        segments, canvasWidth, canvasHeight);
      const residualPageBoxes = runtime.canonicalSeamPageBoxes(canonical, observationsById,
        segments);
      const translation = store.getTranslation(String(canonical.id || ""),
        Math.max(1, Number(canonical.revision) || 1));
      const residualText = String(translation &&
        (translation.translated_text || translation.translatedText) || "").trim();
      if (!residualBox || !residualText ||
          !Array.isArray(residualPageBoxes.text) || !residualPageBoxes.text.length) continue;
      const list = residualsByWinner.get(String(item.winnerCanonicalId)) || [];
      list.push({
        pageId: String(item.pageId || ""),
        box: residualBox,
        pageText: residualPageBoxes.text,
        pageCover: residualPageBoxes.cover || [],
        text: residualText
      });
      residualsByWinner.set(String(item.winnerCanonicalId), list);
    }
    if (!residualsByWinner.size) return extended;
    for (const candidate of Array.isArray(selected) ? selected : []) {
      const canonicalId = String(candidate.canonical && candidate.canonical.id || "");
      const residuals = residualsByWinner.get(canonicalId);
      if (!residuals || !residuals.length) continue;
      const bubble = candidate.bubble;
      const winnerBoxByPage = new Map((Array.isArray(bubble.page_text_boxes) ?
        bubble.page_text_boxes : []).map(box => [String(box.pageId || ""), box]));
      const lines = [{
        pageIndex: pageIndex.get(residuals[0].pageId) ?? 0,
        y: Number((winnerBoxByPage.get(residuals[0].pageId) || {}).y) || 0,
        text: String(bubble.translated_text || bubble.translatedText || "")
      }];
      for (const residual of residuals) {
        const pageBox = residual.pageText[0] || {};
        lines.push({
          pageIndex: pageIndex.get(residual.pageId) ?? 0,
          y: Number(pageBox.y) || 0,
          text: residual.text
        });
      }
      lines.sort((left, right) => left.pageIndex - right.pageIndex ||
        left.y - right.y || left.text.localeCompare(right.text));
      const text = lines.map(line => line.text).filter(Boolean).join("\n");
      const unionBox = runtime.unionSeamPercentBoxes([
        { x: Number(bubble.x), y: Number(bubble.y), w: Number(bubble.w), h: Number(bubble.h) },
        ...residuals.map(item => item.box)
      ]);
      if (!unionBox) continue;
      const sourceLineCount = Math.max(1,
        Number(bubble.source_line_count ||
          (bubble.visual && bubble.visual.sourceLineCount) || 1),
        text.split("\n").length);
      extended.set(canonicalId, runtime.freezeCanonicalValue({
        ...bubble,
        x: unionBox.x,
        y: unionBox.y,
        w: unionBox.w,
        h: unionBox.h,
        translatedText: text,
        translated_text: text,
        source_line_count: sourceLineCount,
        page_text_boxes: [...(bubble.page_text_boxes || []),
          ...residuals.flatMap(item => item.pageText)],
        page_cover_boxes: [...(bubble.page_cover_boxes || []),
          ...residuals.flatMap(item => item.pageCover)],
        visual: {
          ...(bubble.visual || {}),
          fillBox: unionBox,
          fill_box: unionBox,
          sourceLineCount,
          source_line_count: sourceLineCount
        },
        fill_box: unionBox
      }));
    }
    return extended;
  }
  runtime.buildSeamExtendedBubbles = buildSeamExtendedBubbles;
}
