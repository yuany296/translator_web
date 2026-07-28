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
}
