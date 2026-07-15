export function installReconciler03(runtime) {
  function seamSupportsPair(seam, upperObservation, lowerObservation, upperPage, lowerPage) {
    if (!seam.pageIds.includes(upperPage.pageId) || !seam.pageIds.includes(lowerPage.pageId)) return null;
    if (!runtime.isRevisionCurrent(seam, new Map([[upperPage.pageId, upperPage], [lowerPage.pageId, lowerPage]]))) return null;
    const upperSeamSpan = runtime.getSpan(seam, upperPage.pageId);
    const lowerSeamSpan = runtime.getSpan(seam, lowerPage.pageId);
    if (!upperSeamSpan || !lowerSeamSpan) return null;
    if (!runtime.hasMeaningfulCrossPageContribution(seam, [upperPage.pageId, lowerPage.pageId])) return null;
    const upperBox = runtime.boxInNormalizedPage(runtime.getSpan(upperObservation, upperPage.pageId), upperPage);
    const lowerBox = runtime.boxInNormalizedPage(runtime.getSpan(lowerObservation, lowerPage.pageId), lowerPage);
    const upperSupportBox = runtime.boxInNormalizedPage(upperSeamSpan, upperPage);
    const lowerSupportBox = runtime.boxInNormalizedPage(lowerSeamSpan, lowerPage);
    const upperGeometry = Math.max(runtime.overlapOverSmaller(upperBox, upperSupportBox), runtime.horizontalRelation(upperBox, upperSupportBox).centerScore);
    const lowerGeometry = Math.max(runtime.overlapOverSmaller(lowerBox, lowerSupportBox), runtime.horizontalRelation(lowerBox, lowerSupportBox).centerScore);
    const geometry = (upperGeometry + lowerGeometry) / 2;
    if (geometry < 0.32) return null;
    const seamText = runtime.normalizeComparableText(seam.originalText);
    const upperText = runtime.normalizeComparableText(upperObservation.originalText);
    const lowerText = runtime.normalizeComparableText(lowerObservation.originalText);
    const combined = `${upperText}${lowerText}`;
    const upperSimilarity = runtime.textSimilarity(seamText, upperText);
    const lowerSimilarity = runtime.textSimilarity(seamText, lowerText);
    const combinedSimilarity = runtime.textSimilarity(seamText, combined);
    const upperBoundarySimilarity = runtime.fuzzyBoundaryFragmentSimilarity(upperText, seamText, "suffix");
    const lowerBoundarySimilarity = runtime.fuzzyBoundaryFragmentSimilarity(lowerText, seamText, "prefix");
    const upperSupported = runtime.hasStrongTextRelation(seamText, upperText) || upperSimilarity >= 0.45 || upperBoundarySimilarity >= 0.78;
    const lowerSupported = runtime.hasStrongTextRelation(seamText, lowerText) || lowerSimilarity >= 0.45 || lowerBoundarySimilarity >= 0.78;
    const text = Math.max(combinedSimilarity, Math.min(upperSimilarity, lowerSimilarity), Math.min(upperBoundarySimilarity, lowerBoundarySimilarity));
    // 接缝文本必须能解释两侧，而不是只复述其中一页。
    const textSupported = upperSupported && lowerSupported && (combinedSimilarity >= 0.35 || seamText.includes(upperText) && seamText.includes(lowerText) || runtime.hasStrongTextRelation(seamText, combined));
    const visualSupported = runtime.hasSharedVisualIdentity(seam, upperObservation, lowerObservation);
    if (!textSupported && !visualSupported) return null;
    const trulyCrosses = true;
    return {
      seam,
      score: runtime.clamp((trulyCrosses ? 0.58 : 0.40) + geometry * 0.25 + text * 0.17 + (visualSupported ? 0.08 : 0), 0, 1),
      geometry,
      text,
      trulyCrosses
    };
  }
  runtime.seamSupportsPair = seamSupportsPair;
  function geometryScoreForPair(upperObservation, lowerObservation, upperPage, lowerPage, bandHeight, options = {}) {
    const upperSpan = runtime.getSpan(upperObservation, upperPage.pageId);
    const lowerSpan = runtime.getSpan(lowerObservation, lowerPage.pageId);
    if (!upperSpan || !lowerSpan) return null;
    if (!runtime.isSpanAtEdge(upperSpan, upperPage, "bottom", bandHeight) || !runtime.isSpanAtEdge(lowerSpan, lowerPage, "top", bandHeight)) return null;
    if (!runtime.regionsCompatible(upperObservation, upperSpan, lowerObservation, lowerSpan) && options.allowRegionMismatch !== true) return null;
    const upperBox = runtime.boxInNormalizedPage(upperSpan, upperPage);
    const lowerBox = runtime.boxInNormalizedPage(lowerSpan, lowerPage);
    const horizontal = runtime.horizontalRelation(upperBox, lowerBox);
    if (horizontal.overlapRatio < 0.12 && horizontal.centerDistance > Math.max(upperBox.width, lowerBox.width) * 0.8) return null;
    const upperBandRatio = Math.min(1, bandHeight / upperPage.height);
    const lowerBandRatio = Math.min(1, bandHeight / lowerPage.height);
    const upperDistance = runtime.clamp((1 - (upperBox.top + upperBox.height)) / Math.max(upperBandRatio, 0.0001), 0, 1);
    const lowerDistance = runtime.clamp(lowerBox.top / Math.max(lowerBandRatio, 0.0001), 0, 1);
    const boundary = 1 - (upperDistance + lowerDistance) / 2;
    const widthRatio = Math.min(upperBox.width, lowerBox.width) / Math.max(upperBox.width, lowerBox.width, 0.0001);
    const score = horizontal.overlapRatio * 0.45 + horizontal.centerScore * 0.25 + boundary * 0.20 + widthRatio * 0.10;
    return {
      score: runtime.clamp(score, 0, 1),
      upperBox,
      lowerBox,
      horizontal,
      boundary
    };
  }
  runtime.geometryScoreForPair = geometryScoreForPair;
  function visualScoreForPair(left, right, leftSpan, rightSpan, geometry) {
    const leftVisual = left.visual || {};
    const rightVisual = right.visual || {};
    let score = 0.68 + runtime.clamp(geometry?.horizontal?.centerScore, 0, 1) * 0.10;
    const leftRegion = runtime.regionTypeOf(left, leftSpan);
    const rightRegion = runtime.regionTypeOf(right, rightSpan);
    if (leftRegion && rightRegion && leftRegion === rightRegion) score += 0.12;
    const leftHash = String(leftVisual.regionHash || leftVisual.visualHash || leftVisual.hash || "");
    const rightHash = String(rightVisual.regionHash || rightVisual.visualHash || rightVisual.hash || "");
    if (leftHash && rightHash) score += leftHash === rightHash ? 0.10 : -0.16;
    const leftTone = Number(leftVisual.meanLuma ?? leftVisual.mean_luma);
    const rightTone = Number(rightVisual.meanLuma ?? rightVisual.mean_luma);
    if (Number.isFinite(leftTone) && Number.isFinite(rightTone)) {
      score += 0.08 * (1 - runtime.clamp(Math.abs(leftTone - rightTone) / 80, 0, 1));
    }
    return runtime.clamp(score, 0, 1);
  }
  runtime.visualScoreForPair = visualScoreForPair;
  function classifyPair(left, right) {
    const similarity = runtime.textSimilarity(left.originalText, right.originalText);
    const leftText = runtime.normalizeComparableText(left.originalText);
    const rightText = runtime.normalizeComparableText(right.originalText);
    const shorter = leftText.length <= rightText.length ? leftText : rightText;
    const longer = leftText.length > rightText.length ? leftText : rightText;
    const contained = Boolean(shorter && longer.includes(shorter) && shorter.length / Math.max(1, longer.length) >= 0.72);
    return {
      type: similarity >= 0.72 || contained ? "duplicate" : "continuation",
      similarity
    };
  }
  runtime.classifyPair = classifyPair;
  function adjacencyToken(leftPageId, rightPageId) {
    return [String(leftPageId || ""), String(rightPageId || "")].sort().join("\u0000");
  }
  runtime.adjacencyToken = adjacencyToken;
  function normalizeAdjacencyPairs(values) {
    const output = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const ids = Array.isArray(value) ? value : Array.isArray(value?.pageIds) ? value.pageIds : [value?.pageAId ?? value?.previousPageId, value?.pageBId ?? value?.nextPageId];
      if (ids.length >= 2 && ids[0] && ids[1]) output.add(runtime.adjacencyToken(ids[0], ids[1]));
    }
    return output;
  }
  runtime.normalizeAdjacencyPairs = normalizeAdjacencyPairs;
  function isConfirmedAdjacentPair(upperPage, lowerPage, seamObservations, pageById, adjacencyPairs) {
    if (adjacencyPairs.has(runtime.adjacencyToken(upperPage.pageId, lowerPage.pageId))) return true;
    if (String(upperPage.nextPageId || "") === lowerPage.pageId || String(lowerPage.previousPageId || "") === upperPage.pageId) return true;
    return seamObservations.some(seam => seam.pageIds.length === 2 && seam.pageIds.includes(upperPage.pageId) && seam.pageIds.includes(lowerPage.pageId) && runtime.isRevisionCurrent(seam, pageById));
  }
  runtime.isConfirmedAdjacentPair = isConfirmedAdjacentPair;
  function sameChapter(leftPage, rightPage) {
    return String(leftPage?.chapterId || "") === String(rightPage?.chapterId || "");
  }
  runtime.sameChapter = sameChapter;
  function buildCandidatePagePairs(pages, seamObservations, pageById, adjacencyPairs) {
    const pairs = new Map();
    function add(leftPage, rightPage) {
      if (!leftPage || !rightPage || leftPage.pageId === rightPage.pageId || !runtime.sameChapter(leftPage, rightPage)) return;
      const [upperPage, lowerPage] = [leftPage, rightPage].sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
      pairs.set(runtime.adjacencyToken(upperPage.pageId, lowerPage.pageId), {
        upperPage,
        lowerPage
      });
    }
    const pagesByChapter = new Map();
    for (const page of pages) {
      const chapterId = String(page.chapterId || "");
      if (!pagesByChapter.has(chapterId)) pagesByChapter.set(chapterId, []);
      pagesByChapter.get(chapterId).push(page);
    }
    for (const chapterPages of pagesByChapter.values()) {
      chapterPages.sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
      for (let index = 0; index < chapterPages.length - 1; index += 1) add(chapterPages[index], chapterPages[index + 1]);
    }
    for (const token of adjacencyPairs) {
      const [leftId, rightId] = token.split("\u0000");
      add(pageById.get(leftId), pageById.get(rightId));
    }
    for (const page of pages) {
      add(page, pageById.get(String(page.nextPageId || "")));
      add(pageById.get(String(page.previousPageId || "")), page);
    }
    for (const seam of seamObservations) {
      if (seam.pageIds.length === 2) add(pageById.get(seam.pageIds[0]), pageById.get(seam.pageIds[1]));
    }
    return Array.from(pairs.values()).sort((left, right) => left.upperPage.readingOrder - right.upperPage.readingOrder || left.lowerPage.readingOrder - right.lowerPage.readingOrder || left.upperPage.pageId.localeCompare(right.upperPage.pageId) || left.lowerPage.pageId.localeCompare(right.lowerPage.pageId));
  }
  runtime.buildCandidatePagePairs = buildCandidatePagePairs;
}
