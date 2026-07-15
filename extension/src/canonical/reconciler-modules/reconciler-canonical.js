export function installReconcilerCanonical(runtime) {
  function buildCandidateEdges(pageObservations, seamObservations, pages, pageById, adjacencyPairs) {
    const observationsByPage = new Map(pages.map(page => [page.pageId, []]));
    for (const observation of pageObservations) {
      for (const pageId of observation.pageIds) observationsByPage.get(pageId)?.push(observation);
    }
    const edges = [];
    for (const {
      upperPage,
      lowerPage
    } of runtime.buildCandidatePagePairs(pages, seamObservations, pageById, adjacencyPairs)) {
      const adjacencyConfirmed = runtime.isConfirmedAdjacentPair(upperPage, lowerPage, seamObservations, pageById, adjacencyPairs);
      const bandHeight = runtime.calculateSeamBandHeight(upperPage.width, lowerPage.width);
      for (const upperObservation of observationsByPage.get(upperPage.pageId) || []) {
        if (!runtime.isRevisionCurrent(upperObservation, pageById)) continue;
        for (const lowerObservation of observationsByPage.get(lowerPage.pageId) || []) {
          if (!runtime.isRevisionCurrent(lowerObservation, pageById)) continue;
          const supports = seamObservations.map(seam => runtime.seamSupportsPair(seam, upperObservation, lowerObservation, upperPage, lowerPage)).filter(Boolean).sort((left, right) => right.score - left.score || left.seam.id.localeCompare(right.seam.id));
          const seamScore = supports[0]?.score || 0;
          // 单页视觉分类会在页面边界处漂移（例如同一标题上半页被判 effect_text，
          // 下半页被判 caption_panel）。只有同时覆盖两页、且文字与几何都能解释
          // 两侧的强 seam 证据，才允许越过这个分类差异；普通异区文字仍是硬约束。
          const geometry = runtime.geometryScoreForPair(upperObservation, lowerObservation, upperPage, lowerPage, bandHeight, {
            allowRegionMismatch: seamScore >= runtime.MERGE_THRESHOLD
          });
          if (!geometry) continue;
          const pair = runtime.classifyPair(upperObservation, lowerObservation);
          const visualScore = runtime.visualScoreForPair(upperObservation, lowerObservation, runtime.getSpan(upperObservation, upperPage.pageId), runtime.getSpan(lowerObservation, lowerPage.pageId), geometry);
          const score = geometry.score * runtime.GEOMETRY_WEIGHT + visualScore * runtime.VISUAL_WEIGHT + seamScore * runtime.SEAM_WEIGHT + pair.similarity * runtime.TEXT_WEIGHT;
          edges.push({
            id: `edge_${runtime.stableHash([upperObservation.id, lowerObservation.id])}`,
            upperId: upperObservation.id,
            lowerId: lowerObservation.id,
            upperPageId: upperPage.pageId,
            lowerPageId: lowerPage.pageId,
            adjacencyConfirmed,
            type: pair.type,
            score: runtime.roundTo(score, 6),
            scores: {
              geometry: runtime.roundTo(geometry.score, 6),
              visual: runtime.roundTo(visualScore, 6),
              seam: runtime.roundTo(seamScore, 6),
              text: runtime.roundTo(pair.similarity, 6)
            },
            supportingSeamIds: supports.filter(support => support.score >= seamScore - 0.08).map(support => support.seam.id).sort()
          });
        }
      }
    }
    return edges.sort((left, right) => right.score - left.score || left.upperPageId.localeCompare(right.upperPageId) || left.lowerPageId.localeCompare(right.lowerPageId) || left.upperId.localeCompare(right.upperId) || left.lowerId.localeCompare(right.lowerId));
  }
  runtime.buildCandidateEdges = buildCandidateEdges;
  function createUnionFind(observations) {
    const parent = new Map();
    const members = new Map();
    for (const observation of observations) {
      parent.set(observation.id, observation.id);
      members.set(observation.id, new Set([observation.id]));
    }
    function find(id) {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      let cursor = id;
      while (parent.get(cursor) !== cursor) {
        const next = parent.get(cursor);
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    }
    function union(leftId, rightId) {
      const leftRoot = find(leftId);
      const rightRoot = find(rightId);
      if (leftRoot === rightRoot) return leftRoot;
      const root = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
      const child = root === leftRoot ? rightRoot : leftRoot;
      parent.set(child, root);
      const target = members.get(root);
      for (const id of members.get(child)) target.add(id);
      members.delete(child);
      return root;
    }
    return {
      find,
      union,
      getMembers: id => new Set(members.get(find(id)))
    };
  }
  runtime.createUnionFind = createUnionFind;
  function spanTouchesBothEdges(observations, page, bandHeight) {
    let top = false;
    let bottom = false;
    for (const observation of observations) {
      const span = runtime.getSpan(observation, page.pageId);
      if (!span) continue;
      top ||= runtime.isSpanAtEdge(span, page, "top", bandHeight);
      bottom ||= runtime.isSpanAtEdge(span, page, "bottom", bandHeight);
    }
    return top && bottom;
  }
  runtime.spanTouchesBothEdges = spanTouchesBothEdges;
  function pageMembersCompatible(observations, page) {
    if (observations.length < 2) return true;
    for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
        const left = observations[leftIndex];
        const right = observations[rightIndex];
        const leftBox = runtime.boxInNormalizedPage(runtime.getSpan(left, page.pageId), page);
        const rightBox = runtime.boxInNormalizedPage(runtime.getSpan(right, page.pageId), page);
        // 单页权威证据不能仅因原文相同而被折叠；同页多证据进入一个
        // canonical 必须先证明是同一几何实体。
        if (runtime.overlapOverSmaller(leftBox, rightBox) < 0.35) {
          return false;
        }
      }
    }
    return true;
  }
  runtime.pageMembersCompatible = pageMembersCompatible;
  function canUnionComponents(unionFind, leftId, rightId, observationById, pageById) {
    const ids = new Set([...unionFind.getMembers(leftId), ...unionFind.getMembers(rightId)]);
    const observations = Array.from(ids).map(id => observationById.get(id));
    const pageIds = Array.from(new Set(observations.flatMap(observation => observation.pageIds)));
    const componentPages = pageIds.map(pageId => pageById.get(pageId)).filter(Boolean).sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    if (!componentPages.length || componentPages.length > runtime.MAX_COMPONENT_PAGES) return false;
    if (new Set(componentPages.map(page => page.chapterId)).size > 1) return false;
    for (const pageId of pageIds) {
      const page = pageById.get(pageId);
      const onPage = observations.filter(observation => observation.pageIds.includes(pageId));
      if (!runtime.pageMembersCompatible(onPage, page)) return false;
    }
    if (componentPages.length === 3) {
      const [previous, middle, next] = componentPages;
      const middleObservations = observations.filter(observation => observation.pageIds.includes(middle.pageId));
      const bandHeight = runtime.calculateSeamBandHeight(Math.min(previous.width, middle.width), Math.min(middle.width, next.width));
      if (!middle.shortPage && !runtime.spanTouchesBothEdges(middleObservations, middle, bandHeight)) return false;
    }
    return true;
  }
  runtime.canUnionComponents = canUnionComponents;
  function relationBetweenSeamAndPage(seam, pageObservation, pageById) {
    if (!runtime.hasStrongTextRelation(seam.originalText, pageObservation.originalText)) return 0;
    let total = 0;
    let matches = 0;
    for (const pageId of pageObservation.pageIds) {
      if (!seam.pageIds.includes(pageId)) continue;
      const page = pageById.get(pageId);
      const seamSpan = runtime.getSpan(seam, pageId);
      const pageSpan = runtime.getSpan(pageObservation, pageId);
      if (!page || !seamSpan || !pageSpan) continue;
      if (!runtime.regionsCompatible(seam, seamSpan, pageObservation, pageSpan)) continue;
      const seamBox = runtime.boxInNormalizedPage(seamSpan, page);
      const pageBox = runtime.boxInNormalizedPage(pageSpan, page);
      const overlap = runtime.overlapOverSmaller(seamBox, pageBox);
      const center = runtime.horizontalRelation(seamBox, pageBox).centerScore;
      if (overlap < 0.12 && center < 0.88) continue;
      total += Math.max(overlap, center * 0.72);
      matches += 1;
    }
    if (!matches) return 0;
    return runtime.clamp(total / matches * 0.78 + runtime.textSimilarity(seam.originalText, pageObservation.originalText) * 0.22, 0, 1);
  }
  runtime.relationBetweenSeamAndPage = relationBetweenSeamAndPage;
  function canAttachSeamToComponent(seam, members, pageById) {
    const pageIds = Array.from(new Set([...seam.pageIds, ...members.flatMap(observation => observation.pageIds)]));
    const componentPages = pageIds.map(pageId => pageById.get(pageId)).filter(Boolean);
    return componentPages.length === pageIds.length && componentPages.length > 0 && componentPages.length <= runtime.MAX_COMPONENT_PAGES && new Set(componentPages.map(page => page.chapterId)).size === 1;
  }
  runtime.canAttachSeamToComponent = canAttachSeamToComponent;
  function createCoverageLedger() {
    const resolutions = new Map();
    return {
      resolve(observationId, resolution, details = {}) {
        const id = String(observationId || "");
        if (!id) throw new Error("CoverageLedger requires an observation id");
        if (resolutions.has(id)) throw new Error(`Observation ${id} was resolved more than once`);
        if (!["standalone", "consumed", "filtered"].includes(resolution)) {
          throw new Error(`Invalid observation resolution: ${resolution}`);
        }
        if (resolution === "filtered" && !String(details.filterReason || "")) {
          throw new Error(`Filtered observation ${id} requires filterReason`);
        }
        resolutions.set(id, runtime.deepFreeze({
          resolution,
          ...details
        }));
      },
      has(observationId) {
        return resolutions.has(String(observationId));
      },
      get(observationId) {
        return resolutions.get(String(observationId)) || null;
      },
      toJSON() {
        return runtime.deepFreeze(Object.fromEntries(Array.from(resolutions.entries()).sort(([left], [right]) => left.localeCompare(right))));
      }
    };
  }
  runtime.createCoverageLedger = createCoverageLedger;
  function geometryByPageForMembers(memberObservations, pageIndex) {
    const output = {};
    const sorted = [...memberObservations].sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex));
    for (const observation of sorted) {
      for (const span of observation.pageSpans) {
        output[span.pageId] ||= [];
        output[span.pageId].push({
          observationId: observation.id,
          sourceType: observation.sourceType,
          confidence: observation.confidence,
          originalText: observation.originalText,
          visual: observation.visual,
          spanVisual: span.visual,
          box: span.box,
          polygon: span.polygon,
          overlapRatio: span.overlapRatio,
          coordinateSpace: span.coordinateSpace,
          regionType: span.regionType || runtime.regionTypeOf(observation, span)
        });
      }
    }
    return Object.fromEntries(Object.entries(output).sort(([left], [right]) => (pageIndex.get(left) ?? 0) - (pageIndex.get(right) ?? 0) || left.localeCompare(right)).map(([pageId, geometries]) => [pageId, geometries.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left || left.observationId.localeCompare(right.observationId))]));
  }
  runtime.geometryByPageForMembers = geometryByPageForMembers;
  function chooseDuplicateText(observations) {
    return [...observations].sort((left, right) => runtime.observationQuality(right) - runtime.observationQuality(left) || Array.from(right.originalText).length - Array.from(left.originalText).length || left.id.localeCompare(right.id))[0]?.originalText || "";
  }
  runtime.chooseDuplicateText = chooseDuplicateText;
  function isTrueCrossPageSeam(observation) {
    return runtime.hasMeaningfulCrossPageContribution(observation);
  }
  runtime.isTrueCrossPageSeam = isTrueCrossPageSeam;
  function chooseCanonicalText(memberObservations, componentEdges, pageIndex) {
    const pageObservations = memberObservations.filter(observation => observation.sourceType === "page").sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex));
    const continuation = componentEdges.some(edge => edge.type === "continuation");
    if (!continuation || pageObservations.length <= 1) {
      // duplicate 也可能是两个截断 page observation 被完整 seam observation
      // 覆盖；完整接缝证据参与质量竞争，不能只在 continuation 分支使用。
      return runtime.chooseDuplicateText(memberObservations);
    }
    const seamCandidates = memberObservations.filter(runtime.isTrueCrossPageSeam).sort((left, right) => runtime.observationQuality(right) - runtime.observationQuality(left) || Array.from(right.originalText).length - Array.from(left.originalText).length || left.id.localeCompare(right.id));
    if (seamCandidates.length) return seamCandidates[0].originalText;
    return pageObservations.reduce((text, observation) => runtime.joinContinuationText(text, observation.originalText), "");
  }
  runtime.chooseCanonicalText = chooseCanonicalText;
  function earliestPageIndexForCanonical(canonical, pageIndex) {
    return Math.min(...Object.keys(canonical.geometryByPage || {}).map(pageId => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
  }
  runtime.earliestPageIndexForCanonical = earliestPageIndexForCanonical;
  function canonicalGeometrySimilarity(left, right, pageById) {
    const sharedPages = Object.keys(left.geometryByPage || {}).filter(pageId => right.geometryByPage?.[pageId]);
    if (!sharedPages.length) return 0;
    let best = 0;
    for (const pageId of sharedPages) {
      const page = pageById.get(pageId);
      if (!page) continue;
      for (const leftGeometry of left.geometryByPage[pageId]) {
        for (const rightGeometry of right.geometryByPage[pageId]) {
          best = Math.max(best, runtime.overlapOverSmaller(runtime.boxInNormalizedPage(leftGeometry, page), runtime.boxInNormalizedPage(rightGeometry, page)));
        }
      }
    }
    return best;
  }
  runtime.canonicalGeometrySimilarity = canonicalGeometrySimilarity;
  function canonicalSignature(canonical) {
    return runtime.stableHash({
      memberObservationIds: canonical.memberObservationIds,
      originalText: canonical.originalText,
      nonTranslate: canonical.nonTranslate === true,
      geometryByPage: canonical.geometryByPage
    });
  }
  runtime.canonicalSignature = canonicalSignature;
  function observationCaptureGeneration(observation) {
    const revisions = Object.entries(observation.imageRevisionByPage || {}).sort(([left], [right]) => left.localeCompare(right)).map(([pageId, revision]) => `${pageId}@${revision}`).join("+");
    return String(observation.captureId || "").trim() || `${observation.sourceType}:${revisions}:${observation.provider || "unknown"}`;
  }
  runtime.observationCaptureGeneration = observationCaptureGeneration;
  function canonicalEvidenceGeneration(observations) {
    return Math.max(1, new Set(observations.map(runtime.observationCaptureGeneration)).size);
  }
  runtime.canonicalEvidenceGeneration = canonicalEvidenceGeneration;
  function deterministicSupersedesId(pageMembers, pageIndex, canonicalId) {
    const ordered = [...pageMembers].sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex));
    if (ordered.length < 2) return null;
    const anchorPageIndex = Math.min(...ordered[0].pageIds.map(pageId => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
    const laterAnchor = ordered.find(observation => Math.min(...observation.pageIds.map(pageId => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER)) > anchorPageIndex);
    if (!laterAnchor) return null;
    const obsoleteId = `canonical_${runtime.stableHash(laterAnchor.id)}`;
    return obsoleteId === canonicalId ? null : obsoleteId;
  }
  runtime.deterministicSupersedesId = deterministicSupersedesId;
}
