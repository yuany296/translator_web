export function installReconcilerPairFallback(runtime) {
  function completedStructuralPairs(values, pageById) {
    const pairs = [];
    for (const value of Array.isArray(values) ? values : []) {
      if (!value || Array.isArray(value)) continue;
      const evidence = value.seamEvidence || value.seamState || {};
      if (String(evidence.status || "") !== "completed") continue;
      const pageIds = (Array.isArray(value.pageIds) ? value.pageIds :
        [value.pageAId, value.pageBId]).map(String).filter(Boolean);
      if (pageIds.length !== 2 || new Set(pageIds).size !== 2) continue;
      const pages = pageIds.map(pageId => pageById.get(pageId)).filter(Boolean)
        .sort((left, right) => left.readingOrder - right.readingOrder ||
          left.pageId.localeCompare(right.pageId));
      if (pages.length !== 2 ||
          pages.some(page => String(evidence.imageRevisionByPage?.[page.pageId] || "") !==
            String(page.imageRevision || ""))) continue;
      const reasons = new Set((Array.isArray(evidence.reasons) ?
        evidence.reasons : []).map(String));
      const edgeConfirmed = reasons.has("upper_ocr_edge") &&
        reasons.has("lower_ocr_edge");
      const overlapConfirmed = reasons.has("pixel_overlap") ||
        reasons.has("fragment_structure");
      if (!edgeConfirmed || !overlapConfirmed) continue;
      pairs.push({
        pairKey: String(evidence.pairKey || value.pairKey ||
          runtime.adjacencyToken(pageIds[0], pageIds[1])),
        seamObservationIds: (Array.isArray(evidence.observationIds) ?
          evidence.observationIds : []).map(String).sort(),
        upperPage: pages[0],
        lowerPage: pages[1]
      });
    }
    return pairs.sort((left, right) => left.pairKey.localeCompare(right.pairKey));
  }
  runtime.completedStructuralPairs = completedStructuralPairs;

  function pageEdgeSupport(observation, page, edge, pairKey) {
    if (observation.sourceType !== "page" ||
        !runtime.isRevisionCurrent(observation, new Map([[page.pageId, page]]))) {
      return null;
    }
    const bandHeight = runtime.calculateSeamBandHeight(page.width, page.width);
    if (!runtime.observationTouchesEdge(observation, page, edge, bandHeight)) {
      return null;
    }
    const span = runtime.getSpan(observation, page.pageId);
    if (!span) return null;
    return {
      box: runtime.boxInNormalizedPage(span, page),
      observation,
      seamObservationId: `state:${pairKey}`,
      score: 0.96
    };
  }

  function unionSupportBox(component) {
    const left = Math.min(...component.map(item => item.box.left));
    const top = Math.min(...component.map(item => item.box.top));
    const right = Math.max(...component.map(item =>
      item.box.left + item.box.width));
    const bottom = Math.max(...component.map(item =>
      item.box.top + item.box.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  function componentsAligned(upper, lower) {
    const horizontal = runtime.horizontalRelation(
      unionSupportBox(upper), unionSupportBox(lower)
    );
    return horizontal.overlapRatio >= 0.55 && horizontal.centerScore >= 0.76;
  }

  function buildStatePairFragmentGroups(pageObservations, pageById,
    adjacencyPairs, pageIndex) {
    const candidates = [];
    for (const pair of runtime.completedStructuralPairs(adjacencyPairs, pageById)) {
      const upper = pageObservations.filter(item =>
        item.pageIds.includes(pair.upperPage.pageId)).map(item =>
        pageEdgeSupport(item, pair.upperPage, "bottom", pair.pairKey)
      ).filter(Boolean);
      const lower = pageObservations.filter(item =>
        item.pageIds.includes(pair.lowerPage.pageId)).map(item =>
        pageEdgeSupport(item, pair.lowerPage, "top", pair.pairKey)
      ).filter(Boolean);
      if (upper.length + lower.length < 3) continue;
      const roles = [...new Set([...upper, ...lower].map(item =>
        runtime.translationRoleOf(item.observation)))].sort();
      for (const role of roles) {
        const upperComponents = runtime.connectedFragmentComponents(
          upper.filter(item => runtime.translationRoleOf(item.observation) === role)
        );
        const lowerComponents = runtime.connectedFragmentComponents(
          lower.filter(item => runtime.translationRoleOf(item.observation) === role)
        );
        for (const upperComponent of upperComponents) {
          for (const lowerComponent of lowerComponents) {
            if (upperComponent.length + lowerComponent.length < 3 ||
                !componentsAligned(upperComponent, lowerComponent)) continue;
            const losers = runtime.selectBoundaryDuplicateLosers(
              upperComponent, lowerComponent
            );
            if (!losers.size) continue;
            const textSupports = [...upperComponent, ...lowerComponent]
              .filter(item => !losers.has(item.observation.id));
            const retainedPageIds = new Set(textSupports.flatMap(item =>
              item.observation.pageIds));
            if (!retainedPageIds.has(pair.upperPage.pageId) ||
                !retainedPageIds.has(pair.lowerPage.pageId)) continue;
            const authoritativeText = runtime.normalizeText(
              textSupports.sort((left, right) =>
                runtime.compareObservationsByPage(
                  left.observation, right.observation, pageIndex
                )
              ).map(item => item.observation.originalText).join(" ")
            );
            candidates.push(runtime.groupCandidate(
              { captureId: `state:${pair.pairKey}`, observations: [] },
              pair.upperPage, pair.lowerPage, upperComponent, lowerComponent,
              true, pageIndex, {
                authoritativeText,
                discardedObservationIds: losers,
                seamObservationIds: pair.seamObservationIds,
                seamWitnessPairKeys: [pair.pairKey],
                structuralFallback: true,
                structuralStateFallback: true,
                textSupports
              }
            ));
          }
        }
      }
    }
    return candidates;
  }
  runtime.buildStatePairFragmentGroups = buildStatePairFragmentGroups;

  function isVerticalTextObservation(observation) {
    const visual = observation && observation.visual || {};
    const rotation = Math.abs(Number(visual.rotationDeg ?? visual.rotation_deg) || 0);
    return rotation >= 45 && rotation <= 135;
  }

  function normalizedVerticalBox(observation, page) {
    const visual = observation && observation.visual || {};
    const polygon = visual.polygon || visual.regionPolygon || visual.region_polygon;
    if (Array.isArray(polygon) && polygon.length >= 3) {
      const xs = polygon.map(point => Number(point && (point.x ?? point[0]))).filter(Number.isFinite);
      const ys = polygon.map(point => Number(point && (point.y ?? point[1]))).filter(Number.isFinite);
      if (xs.length >= 3 && ys.length >= 3) {
        const left = Math.min(...xs) / 100;
        const top = Math.min(...ys) / 100;
        const width = (Math.max(...xs) - Math.min(...xs)) / 100;
        const height = (Math.max(...ys) - Math.min(...ys)) / 100;
        if (width > 0 && height > 0) return { left, top, width, height };
      }
    }
    const span = runtime.getSpan(observation, page.pageId);
    return span ? runtime.boxInNormalizedPage(span, page) : null;
  }

  function verticalPageSupport(observation, page, edge) {
    if (observation.sourceType !== "page" || !observation.pageIds.includes(page.pageId)) return null;
    const box = normalizedVerticalBox(observation, page);
    if (!box) return null;
    const bandRatio = Math.min(1, runtime.calculateSeamBandHeight(page.width, page.width) / Math.max(1, page.height));
    const touchesEdge = edge === "bottom"
      ? box.top + box.height >= 1 - bandRatio
      : box.top <= bandRatio;
    if (!touchesEdge) return null;
    return { box, observation, seamObservationId: `vertical:${page.pageId}`, score: 0.9 };
  }

  function verticalSeamWitness(capture, upperPage, lowerPage, upperBox, lowerBox) {
    return capture.observations.find(seam => {
      const upperSpan = runtime.getSpan(seam, upperPage.pageId);
      const lowerSpan = runtime.getSpan(seam, lowerPage.pageId);
      if (!upperSpan || !lowerSpan || Number(upperSpan.overlapRatio) <= 0 || Number(lowerSpan.overlapRatio) <= 0) return false;
      const upperRelation = runtime.horizontalRelation(upperBox, runtime.boxInNormalizedPage(upperSpan, upperPage));
      const lowerRelation = runtime.horizontalRelation(lowerBox, runtime.boxInNormalizedPage(lowerSpan, lowerPage));
      return (upperRelation.overlapRatio >= 0.35 || upperRelation.centerScore >= 0.6) &&
        (lowerRelation.overlapRatio >= 0.35 || lowerRelation.centerScore >= 0.6);
    }) || null;
  }

  /**
   * 竖排文字可能整列跨页，但接缝 OCR 只看到边界两侧的几个字（例如「가저해」），
   * 达不到普通 fragment group 的 3 条证据门槛。这里用「两侧页观测都贴边 + 同一接缝
   * witness + 窄列水平对齐」把两页的整段文字接起来；接缝文本不充当译文，只当几何 witness。
   * 只对竖排窄列生效，横排仍走原有 fragment group / edge 逻辑。
   */
  function buildVerticalContinuationGroups(capture, upperPage, lowerPage, pageObservations, pageIndex, adjacencyConfirmed) {
    if (!capture || !upperPage || !lowerPage) return [];
    const supportsFor = (pageValue, edge) => pageObservations
      .filter(item => item.pageIds.includes(pageValue.pageId))
      .map(item => verticalPageSupport(item, pageValue, edge))
      .filter(Boolean)
      .filter(item => isVerticalTextObservation(item.observation));
    const upper = supportsFor(upperPage, "bottom");
    const lower = supportsFor(lowerPage, "top");
    const candidates = [];
    for (const upperSupport of upper) {
      for (const lowerSupport of lower) {
        const upperBox = upperSupport.box;
        const lowerBox = lowerSupport.box;
        if (!(upperBox.width < upperBox.height * 0.5 && lowerBox.width < lowerBox.height * 0.5)) continue;
        const horizontal = runtime.horizontalRelation(upperBox, lowerBox);
        if (horizontal.overlapRatio < 0.5 && horizontal.centerScore < 0.72) continue;
        const upperText = runtime.normalizeComparableText(upperSupport.observation.originalText);
        const lowerText = runtime.normalizeComparableText(lowerSupport.observation.originalText);
        if (upperText.length < 2 || lowerText.length < 2) continue;
        if (runtime.hasStrongTextRelation(upperText, lowerText)) continue;
        if (/[.!?。！？…]["'’”」』）》】]*$/u.test(upperText)) continue;
        const witness = verticalSeamWitness(capture, upperPage, lowerPage, upperBox, lowerBox);
        if (!witness) continue;
        const supports = [
          { ...upperSupport, seamObservationId: witness.id, score: 0.9 },
          { ...lowerSupport, seamObservationId: witness.id, score: 0.9 }
        ];
        candidates.push(runtime.groupCandidate(capture, upperPage, lowerPage, [supports[0]], [supports[1]],
          adjacencyConfirmed, pageIndex, {
            authoritativeText: runtime.normalizeText(`${upperSupport.observation.originalText} ${lowerSupport.observation.originalText}`),
            seamObservationIds: [witness.id],
            textSupports: supports
          }));
      }
    }
    return candidates;
  }
  runtime.buildVerticalContinuationGroups = buildVerticalContinuationGroups;
}
