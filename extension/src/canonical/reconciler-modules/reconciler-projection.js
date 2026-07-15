export function installReconcilerProjection(runtime) {
  function reconcileObservations({
    pages: pageInputs = [],
    observations = [],
    filteredObservations = [],
    previousCanonicals = [],
    adjacentPagePairs = [],
    adjacencyPairs = adjacentPagePairs
  } = {}) {
    const pages = runtime.sortPages(pageInputs);
    const pageById = new Map(pages.map(page => [page.pageId, page]));
    const pageIndex = new Map(pages.map((page, index) => [page.pageId, index]));
    const activeInput = observations.map(observation => observation?.pageSpans ? runtime.createObservation(observation) : runtime.createObservation(observation));
    const filteredInput = filteredObservations.map(observation => runtime.createObservation(observation));
    const allById = new Map();
    for (const observation of [...activeInput, ...filteredInput]) {
      const existing = allById.get(observation.id);
      if (existing && runtime.stableSerialize(existing) !== runtime.stableSerialize(observation)) {
        throw new Error(`Conflicting Observation id: ${observation.id}`);
      }
      allById.set(observation.id, observation);
    }
    const ledgerBuilder = runtime.createCoverageLedger();
    const explicitlyFilteredIds = new Set(filteredInput.map(observation => observation.id));
    const staleIds = new Set(activeInput.filter(observation => !runtime.isRevisionCurrent(observation, pageById)).map(observation => observation.id));
    const crossChapterIds = new Set(activeInput.filter(observation => {
      const chapters = observation.pageIds.map(pageId => pageById.get(pageId)?.chapterId).filter(value => value !== undefined);
      return new Set(chapters).size > 1;
    }).map(observation => observation.id));
    const seamContextOnlyIds = new Set(activeInput.filter(observation => {
      return observation.sourceType === "seam" && !runtime.hasMeaningfulCrossPageContribution(observation, observation.pageIds);
    }).map(observation => observation.id));
    for (const observation of filteredInput.sort((left, right) => left.id.localeCompare(right.id))) {
      ledgerBuilder.resolve(observation.id, "filtered", {
        filterReason: observation.filterReason || "provider_filtered"
      });
    }
    for (const observation of activeInput.filter(item => staleIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!ledgerBuilder.has(observation.id)) ledgerBuilder.resolve(observation.id, "filtered", {
        filterReason: "stale_revision"
      });
    }
    for (const observation of activeInput.filter(item => crossChapterIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!ledgerBuilder.has(observation.id)) ledgerBuilder.resolve(observation.id, "filtered", {
        filterReason: "cross_chapter_evidence"
      });
    }
    for (const observation of activeInput.filter(item => seamContextOnlyIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!ledgerBuilder.has(observation.id)) ledgerBuilder.resolve(observation.id, "filtered", {
        filterReason: "seam_context_only"
      });
    }
    const active = activeInput.filter(observation => !explicitlyFilteredIds.has(observation.id) && !staleIds.has(observation.id) && !crossChapterIds.has(observation.id) && !seamContextOnlyIds.has(observation.id)).filter((observation, index, array) => array.findIndex(item => item.id === observation.id) === index).sort((left, right) => left.id.localeCompare(right.id));
    const pageObservations = active.filter(observation => observation.sourceType === "page");
    const seamObservations = active.filter(observation => observation.sourceType === "seam");
    const observationById = new Map(active.map(observation => [observation.id, observation]));
    const unionFind = runtime.createUnionFind(pageObservations);
    const confirmedAdjacencyPairs = runtime.normalizeAdjacencyPairs(adjacencyPairs);
    const edges = runtime.buildCandidateEdges(pageObservations, seamObservations, pages, pageById, confirmedAdjacencyPairs);
    const acceptedEdges = [];
    const reviewEdges = [];
    for (const edge of edges) {
      if (edge.score >= runtime.MERGE_THRESHOLD && edge.adjacencyConfirmed && runtime.canUnionComponents(unionFind, edge.upperId, edge.lowerId, observationById, pageById)) {
        unionFind.union(edge.upperId, edge.lowerId);
        acceptedEdges.push(edge);
      } else if (edge.score >= runtime.REVIEW_THRESHOLD) {
        reviewEdges.push({
          ...edge,
          reason: !edge.adjacencyConfirmed ? "unconfirmed_adjacency" : edge.score >= runtime.MERGE_THRESHOLD ? "component_constraint" : "ambiguous_score"
        });
      }
    }
    const componentByRoot = new Map();
    for (const observation of pageObservations) {
      const root = unionFind.find(observation.id);
      componentByRoot.set(root, componentByRoot.get(root) || []);
      componentByRoot.get(root).push(observation);
    }
    const componentSeams = new Map(Array.from(componentByRoot.keys()).map(root => [root, []]));
    const explicitlySupported = new Map();
    for (const edge of acceptedEdges) {
      const root = unionFind.find(edge.upperId);
      for (const seamId of edge.supportingSeamIds) explicitlySupported.set(seamId, root);
    }
    for (const seam of seamObservations) {
      let root = explicitlySupported.get(seam.id) || null;
      if (!root) {
        const candidates = Array.from(componentByRoot.entries()).map(([candidateRoot, members]) => ({
          root: candidateRoot,
          members,
          score: Math.max(0, ...members.map(member => runtime.relationBetweenSeamAndPage(seam, member, pageById)))
        })).filter(candidate => candidate.score >= 0.50 && runtime.canAttachSeamToComponent(seam, candidate.members, pageById)).sort((left, right) => right.score - left.score || left.root.localeCompare(right.root));
        root = candidates[0]?.root || null;
      }
      if (root && componentSeams.has(root)) componentSeams.get(root).push(seam);else {
        const seamRoot = `seam:${seam.id}`;
        componentByRoot.set(seamRoot, []);
        componentSeams.set(seamRoot, [seam]);
      }
    }
    const reviewObservationIds = new Set(reviewEdges.flatMap(edge => [edge.upperId, edge.lowerId]));
    const drafts = [];
    for (const [root, pageMembers] of componentByRoot) {
      const seamMembers = componentSeams.get(root) || [];
      const members = [...pageMembers, ...seamMembers].sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex));
      if (!members.length) continue;
      const memberIds = members.map(observation => observation.id).sort();
      const componentEdges = acceptedEdges.filter(edge => memberIds.includes(edge.upperId) && memberIds.includes(edge.lowerId));
      const anchor = pageMembers.length ? [...pageMembers].sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex))[0] : members[0];
      const geometryByPage = runtime.geometryByPageForMembers(members, pageIndex);
      const originalText = runtime.chooseCanonicalText(members, componentEdges, pageIndex);
      const status = pageMembers.some(member => reviewObservationIds.has(member.id)) && componentEdges.length === 0 ? "needs_review" : originalText ? "ready" : "filtered";
      const canonicalId = `canonical_${runtime.stableHash(anchor.id)}`;
      drafts.push({
        id: canonicalId,
        revision: 1,
        supersedesId: runtime.deterministicSupersedesId(pageMembers, pageIndex, canonicalId),
        memberObservationIds: memberIds,
        originalText,
        nonTranslate: members.every(member => member.visual && member.visual.nonTranslate === true),
        geometryByPage,
        status,
        translationFingerprint: `text_${runtime.stableHash(runtime.normalizeText(originalText))}`,
        evidenceGeneration: runtime.canonicalEvidenceGeneration(members)
      });
    }
    drafts.sort((left, right) => runtime.earliestPageIndexForCanonical(left, pageIndex) - runtime.earliestPageIndexForCanonical(right, pageIndex) || runtime.stableSerialize(left.geometryByPage).localeCompare(runtime.stableSerialize(right.geometryByPage)) || left.id.localeCompare(right.id));
    const history = runtime.applyCanonicalHistory(drafts, previousCanonicals, pageIndex, pageById);
    const canonicalByMember = new Map();
    for (const canonical of history.canonicals) {
      for (const observationId of canonical.memberObservationIds) canonicalByMember.set(observationId, canonical);
    }
    for (const canonical of history.canonicals) {
      const members = canonical.memberObservationIds.map(id => observationById.get(id)).filter(Boolean).sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex));
      const isStandaloneCanonical = members.length === 1;
      for (const member of members) {
        ledgerBuilder.resolve(member.id, isStandaloneCanonical ? "standalone" : "consumed", {
          canonicalId: canonical.id,
          canonicalRevision: canonical.revision
        });
      }
    }
    const ledger = ledgerBuilder.toJSON();
    const allObservations = Array.from(allById.values()).sort((left, right) => left.id.localeCompare(right.id));
    runtime.assertCoverageInvariants({
      observations: allObservations,
      canonicals: history.canonicals,
      ledger
    });
    return runtime.deepFreeze({
      modelVersion: runtime.RECONCILE_MODEL_VERSION,
      canonicals: history.canonicals,
      retiredCanonicals: history.retiredCanonicals,
      ledger,
      diagnostics: {
        acceptedEdges: acceptedEdges.map(edge => ({
          ...edge
        })),
        needsReview: reviewEdges.map(edge => ({
          ...edge
        })),
        rejectedEdgeCount: Math.max(0, edges.length - acceptedEdges.length - reviewEdges.length)
      }
    });
  }
  runtime.reconcileObservations = reconcileObservations;
  function geometryAreaOnPage(geometries, page) {
    const boxes = (geometries || []).map(geometry => runtime.boxInNormalizedPage(geometry, page)).filter(box => box.width > 0 && box.height > 0);
    if (!boxes.length) return 0;
    const xs = Array.from(new Set(boxes.flatMap(box => [box.left, box.left + box.width]))).sort((left, right) => left - right);
    let area = 0;
    for (let index = 0; index < xs.length - 1; index += 1) {
      const left = xs[index];
      const right = xs[index + 1];
      if (right <= left) continue;
      const intervals = boxes.filter(box => box.left < right && box.left + box.width > left).map(box => [box.top, box.top + box.height]).sort((first, second) => first[0] - second[0] || first[1] - second[1]);
      let coveredY = 0;
      let current = null;
      for (const interval of intervals) {
        if (!current || interval[0] > current[1]) {
          if (current) coveredY += current[1] - current[0];
          current = [...interval];
        } else {
          current[1] = Math.max(current[1], interval[1]);
        }
      }
      if (current) coveredY += current[1] - current[0];
      area += (right - left) * coveredY;
    }
    return area;
  }
  runtime.geometryAreaOnPage = geometryAreaOnPage;
  function unionGeometry(geometries) {
    const boxes = (geometries || []).map(geometry => runtime.normalizeBox(geometry.box));
    if (!boxes.length) return runtime.normalizeBox({});
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.left + box.width));
    const bottom = Math.max(...boxes.map(box => box.top + box.height));
    return runtime.normalizeBox({
      left,
      top,
      width: right - left,
      height: bottom - top
    });
  }
  runtime.unionGeometry = unionGeometry;
  function chooseProjectionEvidence(geometries) {
    return [...(geometries || [])].sort((left, right) => {
      const leftVisualConfidence = Number(left.visual?.bgConfidence ?? left.visual?.bg_confidence ?? 0) || 0;
      const rightVisualConfidence = Number(right.visual?.bgConfidence ?? right.visual?.bg_confidence ?? 0) || 0;
      const leftQuality = runtime.clamp(left.confidence, 0, 1) * 0.65 + runtime.clamp(leftVisualConfidence, 0, 1) * 0.25 + (left.sourceType === "page" ? 0.10 : 0);
      const rightQuality = runtime.clamp(right.confidence, 0, 1) * 0.65 + runtime.clamp(rightVisualConfidence, 0, 1) * 0.25 + (right.sourceType === "page" ? 0.10 : 0);
      const pageSourceOrder = (right.sourceType === "page" ? 1 : 0) - (left.sourceType === "page" ? 1 : 0);
      return pageSourceOrder || rightQuality - leftQuality || Array.from(String(right.originalText || "")).length - Array.from(String(left.originalText || "")).length || String(left.observationId || "").localeCompare(String(right.observationId || ""));
    })[0] || null;
  }
  runtime.chooseProjectionEvidence = chooseProjectionEvidence;
  function projectionVisualForEvidence(evidence, fallbackBox) {
    const raw = evidence?.visual && typeof evidence.visual === "object" ? evidence.visual : {};
    if (evidence?.sourceType !== "seam") return raw;
    const mappedBox = evidence?.box ? runtime.normalizeBox(evidence.box) : fallbackBox;
    const mappedPolygon = Array.isArray(evidence?.polygon) && evidence.polygon.length ? evidence.polygon.map(point => ({
      x: point.x,
      y: point.y
    })) : null;
    const spanVisual = evidence?.spanVisual && typeof evidence.spanVisual === "object" ? evidence.spanVisual : {};
    const mappedTextPolygon = Array.isArray(spanVisual.polygon) && spanVisual.polygon.length ? spanVisual.polygon.map(point => ({
      x: point.x,
      y: point.y
    })) : mappedPolygon;
    const rawRegionPolygon = runtime.normalizePolygon(raw.regionPolygon ?? raw.region_polygon);
    const rawTextPolygon = runtime.normalizePolygon(raw.polygon);
    const sameRawPolygon = rawRegionPolygon.length > 0 && rawTextPolygon.length > 0 && runtime.stableSerialize(rawRegionPolygon) === runtime.stableSerialize(rawTextPolygon);
    const mappedRegionPolygon = Array.isArray(spanVisual.regionPolygon) && spanVisual.regionPolygon.length ? spanVisual.regionPolygon.map(point => ({
      x: point.x,
      y: point.y
    })) : sameRawPolygon ? mappedTextPolygon : null;
    const mappedFillBox = spanVisual.fillBox && Number(spanVisual.fillBox.width) > 0 ? runtime.normalizeBox(spanVisual.fillBox) : mappedBox;
    // seam visual 的 fillBox/polygon 属于接缝画布；只继承非几何样式，
    // 几何一律替换为已经映射回页面的 pageSpan。
    return {
      bgType: raw.bgType ?? raw.bg_type,
      bg_type: raw.bg_type ?? raw.bgType,
      bgColor: raw.bgColor ?? raw.bg_color,
      bg_color: raw.bg_color ?? raw.bgColor,
      bgConfidence: raw.bgConfidence ?? raw.bg_confidence,
      bg_confidence: raw.bg_confidence ?? raw.bgConfidence,
      regionId: raw.regionId ?? raw.region_id,
      region_id: raw.region_id ?? raw.regionId,
      regionType: raw.regionType ?? raw.region_type,
      region_type: raw.region_type ?? raw.regionType,
      textColor: raw.textColor ?? raw.text_color,
      text_color: raw.text_color ?? raw.textColor,
      strokeColor: raw.strokeColor ?? raw.stroke_color,
      stroke_color: raw.stroke_color ?? raw.strokeColor,
      alignment: raw.alignment,
      fontWeight: raw.fontWeight ?? raw.font_weight,
      font_weight: raw.font_weight ?? raw.fontWeight,
      translationRole: raw.translationRole ?? raw.translation_role,
      translation_role: raw.translation_role ?? raw.translationRole,
      rotationDeg: raw.rotationDeg ?? raw.rotation_deg,
      rotation_deg: raw.rotation_deg ?? raw.rotationDeg,
      sourceLineCount: raw.sourceLineCount ?? raw.source_line_count,
      source_line_count: raw.source_line_count ?? raw.sourceLineCount,
      textBox: spanVisual.textBox && Number(spanVisual.textBox.width) > 0 ? runtime.normalizeBox(spanVisual.textBox) : mappedBox,
      fillBox: mappedFillBox,
      fill_box: mappedFillBox,
      polygon: mappedTextPolygon,
      regionPolygon: mappedRegionPolygon,
      region_polygon: mappedRegionPolygon
    };
  }
  runtime.projectionVisualForEvidence = projectionVisualForEvidence;
  function projectionRegionFamily(projection) {
    const visual = projection?.visual || {};
    const regionId = String(visual.regionId || visual.region_id || "").trim();
    if (regionId) return `id:${regionId}`;
    return `type:${String(visual.regionType || visual.region_type || "plain_text").trim().toLowerCase()}`;
  }
  runtime.projectionRegionFamily = projectionRegionFamily;
  function projectionsShareOneVisualTextLayer(left, right) {
    if (!left?.activeText || !right?.activeText || left.pageId !== right.pageId) return false;
    if (runtime.projectionRegionFamily(left) !== runtime.projectionRegionFamily(right)) return false;
    const leftBox = runtime.normalizeBox(left.geometry || left.box);
    const rightBox = runtime.normalizeBox(right.geometry || right.box);
    const verticalOverlap = Math.max(0, Math.min(leftBox.top + leftBox.height, rightBox.top + rightBox.height) - Math.max(leftBox.top, rightBox.top)) / Math.max(0.0001, Math.min(leftBox.height, rightBox.height));
    const horizontalOverlap = Math.max(0, Math.min(leftBox.left + leftBox.width, rightBox.left + rightBox.width) - Math.max(leftBox.left, rightBox.left)) / Math.max(0.0001, Math.min(leftBox.width, rightBox.width));
    return verticalOverlap >= 0.72 && horizontalOverlap >= 0.45 && runtime.hasStrongTextRelation(left.originalText, right.originalText);
  }
  runtime.projectionsShareOneVisualTextLayer = projectionsShareOneVisualTextLayer;
  function projectionAuthorityScore(projection) {
    const textLength = Array.from(runtime.normalizeComparableText(projection?.originalText)).length;
    const geometries = Array.isArray(projection?.geometries) ? projection.geometries : [];
    const confidence = Math.max(0, ...geometries.map(item => Number(item?.confidence) || 0));
    const hasPageEvidence = geometries.some(item => item?.sourceType === "page");
    return textLength * 100 + confidence * 10 + (hasPageEvidence ? 1 : 0);
  }
  runtime.projectionAuthorityScore = projectionAuthorityScore;
  function arbitrateActiveTextProjections(projections) {
    const suppressed = new Map();
    const active = (Array.isArray(projections) ? projections : []).filter(projection => projection?.activeText).sort((left, right) => runtime.projectionAuthorityScore(right) - runtime.projectionAuthorityScore(left) || String(left.projectionId || "").localeCompare(String(right.projectionId || "")));
    const kept = [];
    for (const projection of active) {
      const winner = kept.find(candidate => runtime.projectionsShareOneVisualTextLayer(projection, candidate));
      if (winner) suppressed.set(projection.projectionId, winner.projectionId);else kept.push(projection);
    }
    return projections.map(projection => {
      const winnerId = suppressed.get(projection.projectionId);
      if (!winnerId) return projection;
      return runtime.deepFreeze({
        ...projection,
        role: "cover",
        activeText: false,
        coverOnly: true,
        translatedText: "",
        translated_text: "",
        suppressedByProjectionId: winnerId,
        bubble: {
          ...projection.bubble,
          translated_text: "",
          projection_role: "cover",
          cover_only: true
        }
      });
    });
  }
  runtime.arbitrateActiveTextProjections = arbitrateActiveTextProjections;
  function readTranslation(translations, canonical) {
    const key = `${canonical.id}@${canonical.revision}`;
    const value = translations instanceof Map ? translations.get(key) ?? translations.get(canonical.id) : translations?.[key] ?? translations?.[canonical.id];
    if (typeof value === "string") return value;
    return String(value?.translatedText ?? value?.translated_text ?? canonical.translation?.translatedText ?? canonical.translation?.translated_text ?? canonical.translatedText ?? canonical.translated_text ?? "");
  }
  runtime.readTranslation = readTranslation;
}
