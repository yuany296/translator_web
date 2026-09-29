export function installReconcilerSeamEval(runtime) {
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

  /** 一份接缝证据的身份：同一次复合图 OCR 的观测共享它（captureId 优先）。 */
  function seamCaptureKey(observation) {
    const captureId = String(observation && observation.captureId || "").trim();
    if (captureId) return captureId;
    return `seam_capture_${runtime.stableHash({
      pageIds: observation && observation.pageIds,
      revisions: observation && observation.imageRevisionByPage,
      provider: observation && observation.provider
    })}`;
  }
  runtime.seamCaptureKey = seamCaptureKey;

  /** 按证据身份分组，只保留真正横跨两页的观测（单页贡献的观测不算这份证据的成员）。 */
  function seamEvidenceCaptures(observations) {
    const grouped = new Map();
    for (const observation of Array.isArray(observations) ? observations : []) {
      if (!runtime.isTrueCrossPageSeam(observation)) continue;
      const key = runtime.seamCaptureKey(observation);
      grouped.set(key, [...(grouped.get(key) || []), observation]);
    }
    return [...grouped.values()].map(group =>
      group.sort((left, right) => String(left.id).localeCompare(String(right.id))));
  }
  runtime.seamEvidenceCaptures = seamEvidenceCaptures;

  /** 这份证据该挂到哪个组件：显式支持优先，否则取与任一成员关系最好的组件。 */
  function resolveSeamCaptureRoot(capture, componentByRoot, explicitlySupported, pageById) {
    for (const seam of capture) {
      const supported = explicitlySupported.get(seam.id);
      if (supported) return supported;
    }
    let best = null;
    for (const seam of capture) {
      for (const [root, members] of componentByRoot.entries()) {
        if (!members.length || best && root === best.root) continue;
        const score = Math.max(0, ...members.map(member => runtime.relationBetweenSeamAndPage(seam, member, pageById)));
        if (score < 0.50 || best && score <= best.score) continue;
        if (!runtime.canAttachSeamToComponent(seam, members, pageById)) continue;
        best = { root, score };
      }
    }
    return best && best.root;
  }
  runtime.resolveSeamCaptureRoot = resolveSeamCaptureRoot;

  /**
   * 把接缝证据挂到组件上：**同一次复合图的观测是一份证据**。
   *
   * 复合图会把被分片边界劈开的一行字拼回原样，但 OCR 可能把它切成左右两个框
   * （现场：`[지오의` + `초상화]`）。逐条挂载时只有一个框能通过文本关联到达 canonical，
   * 另一个自成一条 —— 同一行于是变成两条 canonical，各带半句原文、半幅几何，跨页遮罩
   * 也只能盖住一半。整份证据一起挂载后，几何是两半的并集，原文由这份证据拼出。
   */
  function attachSeamEvidenceToComponents({
    componentByRoot, componentSeams, seamObservations, explicitlySupported, pageById
  }) {
    const individual = Array.isArray(seamObservations) ? seamObservations : [];
    const captures = runtime.seamEvidenceCaptures(individual);
    const grouped = new Set(captures.flat().map(seam => seam.id));
    for (const capture of captures) {
      const root = runtime.resolveSeamCaptureRoot(capture, componentByRoot, explicitlySupported, pageById);
      if (root && componentSeams.has(root)) {
        for (const seam of capture) componentSeams.get(root).push(seam);
        continue;
      }
      for (const seam of capture) {
        const seamRoot = `seam:${seam.id}`;
        componentByRoot.set(seamRoot, []);
        componentSeams.set(seamRoot, [seam]);
      }
    }
    // 只有单页贡献、但被显式支持（片段组/边）的接缝仍按原口径逐条挂载。
    for (const seam of individual) {
      if (grouped.has(seam.id)) continue;
      const root = explicitlySupported.get(seam.id) || null;
      if (root && componentSeams.has(root)) componentSeams.get(root).push(seam);
      else {
        const seamRoot = `seam:${seam.id}`;
        componentByRoot.set(seamRoot, []);
        componentSeams.set(seamRoot, [seam]);
      }
    }
  }
  runtime.attachSeamEvidenceToComponents = attachSeamEvidenceToComponents;

  /**
   * canonical 拥有整份接缝证据时，这份证据按页/纵向顺序拼出来的原文。
   * 单独挑「质量最高的一条」会把一行字交成半句；被包含的重复读法（例如同一行既有
   * 合并框又有半句框）只保留最完整的那条，不重复拼接。
   */
  function joinSeamCaptureMemberText(memberObservations, pageIndex) {
    const byCapture = new Map();
    for (const observation of Array.isArray(memberObservations) ? memberObservations : []) {
      if (!runtime.isTrueCrossPageSeam(observation)) continue;
      const key = runtime.seamCaptureKey(observation);
      byCapture.set(key, [...(byCapture.get(key) || []), observation]);
    }
    const complete = [...byCapture.values()].filter(group => group.length >= 2)
      .sort((left, right) => right.length - left.length)[0];
    if (!complete) return "";
    const ordered = [...complete].sort((left, right) => runtime.compareObservationsByPage(left, right, pageIndex));
    const texts = ordered.map(observation => runtime.normalizeText(observation.originalText)).filter(Boolean);
    const kept = texts.filter(text => !texts.some(other => other !== text &&
      runtime.normalizeComparableText(other).includes(runtime.normalizeComparableText(text))));
    const unique = kept.filter((text, index) =>
      kept.findIndex(item => runtime.normalizeComparableText(item) === runtime.normalizeComparableText(text)) === index);
    return unique.length >= 2 ? unique.join(" ") : "";
  }
  runtime.joinSeamCaptureMemberText = joinSeamCaptureMemberText;

  /**
   * 接缝证据与页级证据「读的是同一行」的几何判据。
   *
   * 现场（RIDI 1280 分片）：边界把一行特效字劈成两半，复合图把两半合成**一条**观测
   * （原文是完整的 `[지오의 초상화]`），而整页 OCR 只看到下半截、读成 `'지오의조정화]`。
   * 两者文本差着被切掉的字形，边界重叠与模糊子串都过不了 0.80 的门槛，于是同一行裂成
   * 两条 canonical：接缝面一条、页级一条，页级那条还盖在接缝面上（用户看到的「第一行的
   * 一半 + 下面两行」）。但几何上它们就是同一行：两边在同一页上的框几乎重合。
   * 文本不可比时以几何为准——但几何之外仍要有一点文字证据：两边至少共享一段连续片段
   * （≥ 较短一侧的 30%）。现场那一行两半的读法共享 `지오의`（3/8）✓；而「同位置却互不
   * 相干的接缝」共享 0~1 个字符，必须继续各走各的。
   */
  function seamPageGeometryDuplicateRelation(seam, pageObservation, pageById) {
    if (seam?.sourceType !== "seam" || pageObservation?.sourceType !== "page") return null;
    if (!runtime.isTrueCrossPageSeam(seam)) return null;
    const seamText = runtime.normalizeComparableText(seam.originalText);
    const pageText = runtime.normalizeComparableText(pageObservation.originalText);
    const shorter = Math.min(Array.from(seamText).length, Array.from(pageText).length);
    if (!(shorter > 0) || runtime.sharedComparableRun(seamText, pageText) < Math.max(2, shorter * 0.3)) return null;
    let best = null;
    for (const pageId of pageObservation.pageIds) {
      if (!seam.pageIds.includes(pageId)) continue;
      const page = pageById.get(pageId);
      const seamSpan = runtime.getSpan(seam, pageId);
      const pageSpan = runtime.getSpan(pageObservation, pageId);
      if (!page || !seamSpan || !pageSpan) continue;
      const coverage = runtime.overlapOverSmaller(
        runtime.boxInNormalizedPage(seamSpan, page),
        runtime.boxInNormalizedPage(pageSpan, page)
      );
      if (coverage < 0.8) continue;
      const center = runtime.horizontalRelation(
        runtime.boxInNormalizedPage(seamSpan, page),
        runtime.boxInNormalizedPage(pageSpan, page)
      ).centerScore;
      if (center < 0.85) continue;
      if (!best || coverage > best.coverage) {
        best = {
          pageId,
          coverage: runtime.roundTo(coverage, 6),
          score: runtime.clamp(coverage * 0.8 + center * 0.2, 0, 1)
        };
      }
    }
    return best;
  }
  runtime.seamPageGeometryDuplicateRelation = seamPageGeometryDuplicateRelation;

  /** 两段文本共享的最长连续片段长度（按可比较字符）。 */
  function sharedComparableRun(leftValue, rightValue) {
    const left = Array.from(runtime.normalizeComparableText(leftValue));
    const right = Array.from(runtime.normalizeComparableText(rightValue));
    let best = 0;
    let previous = new Array(right.length + 1).fill(0);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = new Array(right.length + 1).fill(0);
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
        current[rightIndex] = previous[rightIndex - 1] + 1;
        if (current[rightIndex] > best) best = current[rightIndex];
      }
      previous = current;
    }
    return best;
  }
  runtime.sharedComparableRun = sharedComparableRun;

  /** 接缝证据挂到页级证据上的关系分：文本续接优先，其次是「同一行」的几何重复读法。 */
  function relationBetweenSeamAndPage(seam, pageObservation, pageById) {
    const continuation = runtime.seamPageContinuationRelation(seam, pageObservation, pageById);
    const duplicate = runtime.seamPageGeometryDuplicateRelation(seam, pageObservation, pageById);
    if (!runtime.hasStrongTextRelation(seam.originalText, pageObservation.originalText) && !continuation && !duplicate) return 0;
    let total = 0;
    let matches = 0;
    for (const pageId of pageObservation.pageIds) {
      if (!seam.pageIds.includes(pageId)) continue;
      const page = pageById.get(pageId);
      const seamSpan = runtime.getSpan(seam, pageId);
      const pageSpan = runtime.getSpan(pageObservation, pageId);
      if (!page || !seamSpan || !pageSpan) continue;
      const known = continuation?.pageId === pageId || duplicate?.pageId === pageId;
      if (!known && !runtime.regionsCompatible(seam, seamSpan, pageObservation, pageSpan)) continue;
      const seamBox = runtime.boxInNormalizedPage(seamSpan, page);
      const pageBox = runtime.boxInNormalizedPage(pageSpan, page);
      const overlap = runtime.overlapOverSmaller(seamBox, pageBox);
      const center = runtime.horizontalRelation(seamBox, pageBox).centerScore;
      if (overlap < 0.12 && center < 0.88) continue;
      total += Math.max(overlap, center * 0.72);
      matches += 1;
    }
    if (!matches) return 0;
    const textScore = Math.max(
      runtime.textSimilarity(seam.originalText, pageObservation.originalText),
      continuation?.textScore || 0,
      duplicate?.score || 0
    );
    return Math.max(runtime.clamp(total / matches * 0.78 + textScore * 0.22, 0, 1), continuation?.score || 0);
  }
  runtime.relationBetweenSeamAndPage = relationBetweenSeamAndPage;
}
