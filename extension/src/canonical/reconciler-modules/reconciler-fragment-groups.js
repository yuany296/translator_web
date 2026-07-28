export function installReconcilerFragmentGroups(runtime) {
  function translationRoleOf(observation) {
    return String(observation?.visual?.translationRole ?? observation?.visual?.translation_role ?? "").trim().toLowerCase();
  }
  runtime.translationRoleOf = translationRoleOf;

  function translationRolesCompatible(observations) {
    return new Set(observations.map(runtime.translationRoleOf)).size <= 1;
  }
  runtime.translationRolesCompatible = translationRolesCompatible;

  function fragmentBoxesAdjacent(left, right) {
    if (runtime.intersectionArea(left, right) > 0) return true;
    const horizontalGap = Math.max(0, Math.max(left.left, right.left) - Math.min(left.left + left.width, right.left + right.width));
    const verticalGap = Math.max(0, Math.max(left.top, right.top) - Math.min(left.top + left.height, right.top + right.height));
    const heightScale = Math.max(0.008, Math.min(left.height, right.height));
    return horizontalGap <= Math.max(0.012, heightScale * 0.75) && verticalGap <= Math.max(0.012, heightScale * 1.1);
  }
  runtime.fragmentBoxesAdjacent = fragmentBoxesAdjacent;

  function connectedFragmentComponents(supports) {
    const pending = [...supports].sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left || left.observation.id.localeCompare(right.observation.id));
    const components = [];
    while (pending.length) {
      const component = [pending.shift()];
      for (let cursor = 0; cursor < component.length; cursor += 1) {
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          if (!runtime.fragmentBoxesAdjacent(component[cursor].box, pending[index].box)) continue;
          component.push(pending.splice(index, 1)[0]);
        }
      }
      components.push(component.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left || left.observation.id.localeCompare(right.observation.id)));
    }
    return components;
  }
  runtime.connectedFragmentComponents = connectedFragmentComponents;

  function seamFragmentSupport(seam, observation, page, edge) {
    if (!runtime.isRevisionCurrent(observation, new Map([[page.pageId, page]]))) return null;
    const seamRole = runtime.translationRoleOf(seam);
    if (seamRole && seamRole !== runtime.translationRoleOf(observation)) return null;
    const bandHeight = runtime.calculateSeamBandHeight(page.width, page.width);
    if (!runtime.observationTouchesEdge(observation, page, edge, bandHeight)) return null;
    const seamSpan = runtime.getSpan(seam, page.pageId);
    const pageSpan = runtime.getSpan(observation, page.pageId);
    if (!seamSpan || !pageSpan || Number(seamSpan.overlapRatio) <= 0) return null;
    const seamBox = runtime.boxInNormalizedPage(seamSpan, page);
    const box = runtime.boxInNormalizedPage(pageSpan, page);
    const coveredRatio = runtime.intersectionArea(box, seamBox) / Math.max(0.000001, box.width * box.height);
    const horizontal = runtime.horizontalRelation(box, seamBox);
    const geometry = Math.max(coveredRatio, horizontal.overlapRatio * 0.88, horizontal.centerScore * 0.72);
    if (geometry < 0.32) return null;
    const textRelated = runtime.hasStrongTextRelation(seam.originalText, observation.originalText);
    const fragmentText = runtime.normalizeComparableText(observation.originalText);
    // 极短韩文只在 seam 强覆盖且 NFD 仅差一个字形成分时校正，避免纯几何吞并邻近短词。
    const correctedShort = geometry >= 0.72 && /^[가-힣]{2,3}$/u.test(fragmentText) &&
      runtime.fuzzyFragmentSimilarity(seam.originalText, fragmentText, 4) >= runtime.FUZZY_SEAM_FRAGMENT_THRESHOLD;
    const visualRelated = runtime.hasSharedVisualIdentity(seam, observation);
    if (!textRelated && !correctedShort && !visualRelated) return null;
    const text = textRelated || correctedShort ? 1 : runtime.textSimilarity(seam.originalText, observation.originalText);
    return {
      box,
      observation,
      seamObservationId: seam.id,
      score: runtime.clamp(geometry * 0.55 + text * 0.35 + (visualRelated ? 0.10 : 0), 0, 1)
    };
  }
  runtime.seamFragmentSupport = seamFragmentSupport;

  function seamCaptureKey(seam) {
    const captureId = String(seam.captureId || "").trim();
    if (captureId) return captureId;
    return `seam_capture_${runtime.stableHash({ pageIds: seam.pageIds, revisions: seam.imageRevisionByPage, provider: seam.provider })}`;
  }

  function strongSeamCaptures(seamObservations, pageById) {
    const grouped = new Map();
    for (const seam of seamObservations) {
      if (seam.sourceType !== "seam" || seam.pageIds.length !== 2 || !runtime.isRevisionCurrent(seam, pageById)) continue;
      const key = seamCaptureKey(seam);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(seam);
    }
    return [...grouped.entries()].map(([captureId, observations]) => {
      const pageIds = [...new Set(observations.flatMap(item => item.pageIds))].sort();
      const contributionByPage = new Map(pageIds.map(pageId => [pageId, 0]));
      for (const observation of observations) {
        for (const [pageId, value] of runtime.seamContributionByPage(observation)) {
          contributionByPage.set(pageId, Math.max(contributionByPage.get(pageId) || 0, value));
        }
      }
      const weights = pageIds.map(pageId => contributionByPage.get(pageId) || 0);
      const total = weights.reduce((sum, value) => sum + value, 0);
      const collectivelyCrossPage = pageIds.length === 2 && total > 0
        && weights.every(value => value / total >= runtime.MIN_SEAM_PAGE_CONTRIBUTION);
      return { captureId, observations: observations.sort((left, right) => left.id.localeCompare(right.id)), pageIds, collectivelyCrossPage };
    }).filter(group => group.collectivelyCrossPage).sort((left, right) => left.captureId.localeCompare(right.captureId));
  }
  runtime.strongSeamCaptures = strongSeamCaptures;

  function filteredSeamGeometryObservations(observations, pageById) {
    return observations.filter(observation => {
      if (observation.sourceType !== "seam" ||
          !runtime.isRevisionCurrent(observation, pageById)) return false;
      const chapters = observation.pageIds.map(pageId => pageById.get(pageId)?.chapterId)
        .filter(value => value !== undefined);
      return new Set(chapters).size <= 1;
    }).filter((observation, index, array) =>
      array.findIndex(item => item.id === observation.id) === index
    );
  }
  runtime.filteredSeamGeometryObservations = filteredSeamGeometryObservations;

  function captureFragmentSupport(capture, observation, page, edge) {
    return capture.observations.map(seam => runtime.seamFragmentSupport(seam, observation, page, edge)).filter(Boolean)
      .sort((left, right) => right.score - left.score || left.seamObservationId.localeCompare(right.seamObservationId))[0] || null;
  }

  function structuralFragmentSupport(seam, observation, page, edge) {
    if (!runtime.isRevisionCurrent(observation, new Map([[page.pageId, page]]))) return null;
    if (!runtime.translationRolesCompatible([seam, observation])) return null;
    const bandHeight = runtime.calculateSeamBandHeight(page.width, page.width);
    if (!runtime.observationTouchesEdge(observation, page, edge, bandHeight)) return null;
    const seamSpan = runtime.getSpan(seam, page.pageId);
    const pageSpan = runtime.getSpan(observation, page.pageId);
    if (!seamSpan || !pageSpan || Number(seamSpan.overlapRatio) <= 0 ||
        !runtime.regionsCompatible(seam, seamSpan, observation, pageSpan)) return null;
    const seamBox = runtime.boxInNormalizedPage(seamSpan, page);
    const box = runtime.boxInNormalizedPage(pageSpan, page);
    const horizontal = runtime.horizontalRelation(box, seamBox);
    if (horizontal.overlapRatio < 0.72 || horizontal.centerScore < 0.72) return null;
    const coveredRatio = runtime.intersectionArea(box, seamBox) /
      Math.max(0.000001, box.width * box.height);
    const geometry = Math.max(coveredRatio, horizontal.overlapRatio * 0.92);
    return {
      box,
      observation,
      seamObservationId: seam.id,
      score: runtime.clamp(geometry, 0, 1)
    };
  }

  function captureStructuralSupport(capture, observation, page, edge) {
    return capture.observations.map(seam =>
      structuralFragmentSupport(seam, observation, page, edge)
    ).filter(Boolean).sort((left, right) =>
      right.score - left.score ||
      left.seamObservationId.localeCompare(right.seamObservationId)
    )[0] || null;
  }

  function boundaryDuplicateRelation(left, right) {
    const horizontal = runtime.horizontalRelation(left.box, right.box);
    if (horizontal.overlapRatio < 0.55 || horizontal.centerScore < 0.78) return false;
    const leftText = runtime.normalizeComparableText(left.observation.originalText);
    const rightText = runtime.normalizeComparableText(right.observation.originalText);
    if (!leftText || !rightText) return false;
    if (runtime.hasStrongTextRelation(leftText, rightText)) return true;
    const shorter = leftText.length <= rightText.length ? leftText : rightText;
    return /^[가-힣]{2,3}$/u.test(shorter) &&
      runtime.fuzzyFragmentSimilarity(leftText, rightText, 4) >=
        runtime.FUZZY_SEAM_FRAGMENT_THRESHOLD;
  }

  function selectBoundaryDuplicateLosers(upper, lower) {
    const losers = new Set();
    for (const upperSupport of upper) {
      for (const lowerSupport of lower) {
        if (!boundaryDuplicateRelation(upperSupport, lowerSupport)) continue;
        const candidates = [upperSupport, lowerSupport].sort((left, right) =>
          runtime.observationQuality(right.observation) -
            runtime.observationQuality(left.observation) ||
          runtime.normalizeComparableText(right.observation.originalText).length -
            runtime.normalizeComparableText(left.observation.originalText).length ||
          left.observation.id.localeCompare(right.observation.id)
        );
        losers.add(candidates[1].observation.id);
      }
    }
    return losers;
  }
  runtime.selectBoundaryDuplicateLosers = selectBoundaryDuplicateLosers;

  function seamRegionKey(observation) {
    const visual = observation?.visual || {};
    const regionId = String(visual.regionId || visual.region_id || "").trim();
    if (regionId) return `id:${regionId}`;
    const polygon = visual.regionPolygon || visual.region_polygon;
    return Array.isArray(polygon) && polygon.length >= 3 ? `polygon:${runtime.stableHash(polygon)}` : "";
  }

  function componentsCrossLinked(capture, upperComponent, lowerComponent) {
    const upperIds = new Set(upperComponent.map(item => item.seamObservationId));
    if (lowerComponent.some(item => upperIds.has(item.seamObservationId))) return true;
    const seamById = new Map(capture.observations.map(item => [item.id, item]));
    const upperKeys = new Set(upperComponent.map(item => seamRegionKey(seamById.get(item.seamObservationId))).filter(Boolean));
    return lowerComponent.some(item => upperKeys.has(seamRegionKey(seamById.get(item.seamObservationId))));
  }

  function authoritativeFragmentText(capture, supports, pageIndex) {
    const seamIds = new Set(supports.map(item => item.seamObservationId));
    function primarySpan(observation) {
      return observation.pageSpans.filter(span => Number(span.overlapRatio) > 0).sort((first, second) =>
        (pageIndex.get(first.pageId) ?? Number.MAX_SAFE_INTEGER) - (pageIndex.get(second.pageId) ?? Number.MAX_SAFE_INTEGER)
        || first.box.top - second.box.top || first.box.left - second.box.left)[0];
    }
    const matched = capture.observations.filter(item => seamIds.has(item.id)).sort((left, right) => {
      const leftSpan = primarySpan(left);
      const rightSpan = primarySpan(right);
      return (pageIndex.get(leftSpan?.pageId) ?? Number.MAX_SAFE_INTEGER) - (pageIndex.get(rightSpan?.pageId) ?? Number.MAX_SAFE_INTEGER)
        || Number(leftSpan?.box?.top || 0) - Number(rightSpan?.box?.top || 0)
        || Number(leftSpan?.box?.left || 0) - Number(rightSpan?.box?.left || 0)
        || left.id.localeCompare(right.id);
    });
    return runtime.normalizeText(matched.map(item => item.originalText).join(" "));
  }

  function groupCandidate(capture, upperPage, lowerPage, upperSupports, lowerSupports,
    adjacencyConfirmed, pageIndex, options = {}) {
    const supports = [...upperSupports, ...lowerSupports];
    const observations = supports.map(item => item.observation);
    const textSupports = Array.isArray(options.textSupports) ? options.textSupports : supports;
    const textObservations = textSupports.map(item => item.observation);
    const authoritativeText = options.authoritativeText ||
      authoritativeFragmentText(capture, supports, pageIndex);
    const combinedText = textObservations.map(item => item.originalText).join("");
    // 页面片段可能只覆盖完整 seam 句子的一小段；按最佳窗口比较，避免被整句长度稀释。
    const textScore = Math.max(
      runtime.textSimilarity(authoritativeText, combinedText),
      runtime.fuzzyFragmentSimilarity(authoritativeText, combinedText)
    );
    const supportScore = supports.reduce((sum, item) => sum + item.score, 0) / Math.max(1, supports.length);
    const memberObservationIds = observations.map(item => item.id).sort();
    const seamObservationIds = Array.isArray(options.seamObservationIds) ? [...new Set(options.seamObservationIds.map(String))].sort() : [...new Set(supports.map(item => item.seamObservationId))].sort();
    return {
      id: `fragment_group_${runtime.stableHash([capture.captureId, ...memberObservationIds])}`,
      seamId: seamObservationIds[0] || capture.captureId,
      seamCaptureId: capture.captureId,
      seamObservationIds,
      upperPageId: upperPage.pageId,
      lowerPageId: lowerPage.pageId,
      memberObservationIds,
      authoritativeText,
      adjacencyConfirmed,
      role: runtime.translationRoleOf(observations[0]),
      score: runtime.roundTo(supportScore * 0.72 + textScore * 0.28, 6),
      scores: { support: runtime.roundTo(supportScore, 6), text: runtime.roundTo(textScore, 6) },
      ...(options.structuralFallback ? {
        structuralFallback: true,
        discardedObservationIds: [...(options.discardedObservationIds || [])].sort(),
        ...(options.structuralStateFallback ? { structuralStateFallback: true } : {}),
        ...(options.seamWitnessPairKeys?.length ? { seamWitnessPairKeys: [...options.seamWitnessPairKeys].map(String).sort() } : {})
      } : {})
    };
  }
  runtime.groupCandidate = groupCandidate;

  function structuralFallbackCandidates(capture, upperPage, lowerPage, pageObservations,
    adjacencyConfirmed, pageIndex) {
    const upper = pageObservations.filter(item => item.pageIds.includes(upperPage.pageId))
      .map(item => captureStructuralSupport(capture, item, upperPage, "bottom")).filter(Boolean);
    const lower = pageObservations.filter(item => item.pageIds.includes(lowerPage.pageId))
      .map(item => captureStructuralSupport(capture, item, lowerPage, "top")).filter(Boolean);
    if (upper.length + lower.length < 3) return [];
    const candidates = [];
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
          if (!componentsCrossLinked(capture, upperComponent, lowerComponent)) continue;
          const losers = selectBoundaryDuplicateLosers(upperComponent, lowerComponent);
          if (!losers.size) continue;
          const textSupports = [...upperComponent, ...lowerComponent]
            .filter(item => !losers.has(item.observation.id));
          const textPageIds = new Set(textSupports.flatMap(item => item.observation.pageIds));
          if (!textPageIds.has(upperPage.pageId) || !textPageIds.has(lowerPage.pageId)) continue;
          const authoritativeText = runtime.normalizeText(textSupports.sort((left, right) =>
            runtime.compareObservationsByPage(
              left.observation, right.observation, pageIndex
            )
          ).map(item => item.observation.originalText).join(" "));
          candidates.push(groupCandidate(
            capture, upperPage, lowerPage, upperComponent, lowerComponent,
            adjacencyConfirmed, pageIndex, {
              authoritativeText,
              discardedObservationIds: losers,
              structuralFallback: true,
              textSupports
            }
          ));
        }
      }
    }
    return candidates;
  }

  function buildSeamFragmentGroups(pageObservations, seamObservations, pages, pageById, adjacencyPairs, structuralSeamObservations = [], structuralAdjacencyPairs = []) {
    const candidates = [];
    const rejected = [];
    const pageIndex = new Map(pages.map((page, index) => [page.pageId, index]));
    const textCaptureById = new Map(runtime.strongSeamCaptures(
      seamObservations, pageById
    ).map(capture => [capture.captureId, capture]));
    const structuralEvidence = [...new Map([
      ...seamObservations,
      ...structuralSeamObservations
    ].map(observation => [observation.id, observation])).values()];
    for (const capture of runtime.strongSeamCaptures(structuralEvidence, pageById)) {
      const captureStart = candidates.length;
      const seamPages = capture.pageIds.map(pageId => pageById.get(pageId)).filter(Boolean)
        .sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
      if (seamPages.length !== 2) continue;
      const [upperPage, lowerPage] = seamPages;
      const adjacencyConfirmed = runtime.isConfirmedAdjacentPair(
        upperPage, lowerPage, structuralEvidence, pageById, adjacencyPairs
      );
      const textCapture = textCaptureById.get(capture.captureId);
      const upper = pageObservations.filter(item => item.pageIds.includes(upperPage.pageId))
        .map(item => textCapture ?
          captureFragmentSupport(textCapture, item, upperPage, "bottom") : null
        ).filter(Boolean);
      const lower = pageObservations.filter(item => item.pageIds.includes(lowerPage.pageId))
        .map(item => textCapture ?
          captureFragmentSupport(textCapture, item, lowerPage, "top") : null
        ).filter(Boolean);
      const roles = [...new Set([...upper, ...lower].map(item => runtime.translationRoleOf(item.observation)))].sort();
      const captureCandidates = [];
      for (const role of roles) {
        const upperComponents = runtime.connectedFragmentComponents(upper.filter(item => runtime.translationRoleOf(item.observation) === role));
        const lowerComponents = runtime.connectedFragmentComponents(lower.filter(item => runtime.translationRoleOf(item.observation) === role));
        const linkedUpper = new Set();
        const linkedLower = new Set();
        for (let upperIndex = 0; upperIndex < upperComponents.length; upperIndex += 1) {
          for (let lowerIndex = 0; lowerIndex < lowerComponents.length; lowerIndex += 1) {
            const upperComponent = upperComponents[upperIndex];
            const lowerComponent = lowerComponents[lowerIndex];
            if (!componentsCrossLinked(capture, upperComponent, lowerComponent)) continue;
            if (upperComponent.length >= 2 || lowerComponent.length >= 2) {
              captureCandidates.push(groupCandidate(capture, upperPage, lowerPage, upperComponent, lowerComponent, adjacencyConfirmed, pageIndex));
              linkedUpper.add(upperIndex);
              linkedLower.add(lowerIndex);
            }
          }
        }
        upperComponents.forEach((component, index) => {
          if (component.length >= 2 && !linkedUpper.has(index)) captureCandidates.push(groupCandidate(capture, upperPage, lowerPage, component, [], adjacencyConfirmed, pageIndex));
        });
        lowerComponents.forEach((component, index) => {
          if (component.length >= 2 && !linkedLower.has(index)) captureCandidates.push(groupCandidate(capture, upperPage, lowerPage, [], component, adjacencyConfirmed, pageIndex));
        });
      }
      if (!captureCandidates.length) {
        captureCandidates.push(...structuralFallbackCandidates(
          capture, upperPage, lowerPage, pageObservations, adjacencyConfirmed, pageIndex
        ));
      }
      captureCandidates.sort((left, right) => right.score - left.score || right.memberObservationIds.length - left.memberObservationIds.length || left.id.localeCompare(right.id));
      const claimed = new Set();
      for (const candidate of captureCandidates) {
        if (candidate.memberObservationIds.some(id => claimed.has(id))) continue;
        candidates.push(candidate);
        for (const id of candidate.memberObservationIds) claimed.add(id);
      }
      if (candidates.length === captureStart && (upper.length || lower.length)) rejected.push({
        seamId: capture.observations[0]?.id || capture.captureId,
        seamCaptureId: capture.captureId,
        memberObservationIds: [...upper, ...lower].map(item => item.observation.id).sort(),
        reason: "fragment_group_not_coherent"
      });
    }
    candidates.push(...runtime.buildStatePairFragmentGroups(pageObservations, pageById, structuralAdjacencyPairs, pageIndex));
    const uniqueCandidates = new Map();
    for (const candidate of candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))) {
      const key = candidate.memberObservationIds.join("|");
      if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
    }
    return {
      candidates: [...uniqueCandidates.values()],
      rejected: rejected.sort((left, right) => left.seamId.localeCompare(right.seamId))
    };
  }
  runtime.buildSeamFragmentGroups = buildSeamFragmentGroups;

  function canUnionFragmentGroup(unionFind, group, observationById, pageById) {
    const observations = group.memberObservationIds.map(id => observationById.get(id)).filter(Boolean);
    if (observations.length !== group.memberObservationIds.length || !runtime.translationRolesCompatible(observations)) return false;
    if (group.memberObservationIds.some(id => unionFind.getMembers(id).size !== 1)) return false;
    const pages = [pageById.get(group.upperPageId), pageById.get(group.lowerPageId)].filter(Boolean);
    return pages.length === 2 && new Set(pages.map(page => page.chapterId)).size === 1;
  }
  runtime.canUnionFragmentGroup = canUnionFragmentGroup;
}
