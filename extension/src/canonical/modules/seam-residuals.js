export function installSeamResiduals(runtime) {
  function seamBoxCoverage(target, container) {
    if (!target || !container) return 0;
    const width = Math.max(0,
      Math.min(target.x + target.w, container.x + container.w) - Math.max(target.x, container.x));
    const height = Math.max(0,
      Math.min(target.y + target.h, container.y + container.h) - Math.max(target.y, container.y));
    return width * height / Math.max(0.0001, target.w * target.h);
  }

  // 残片与 winner 框垂直紧邻且水平对齐时,视为同一气泡的相邻行:
  // 气泡跨页缝时,捕获带外的那一行与 seam 行没有文本续接关系,
  // 但几何(行距内的间隙 + 中心对齐)足以证明同属一个气泡。
  function isSeamAdjacentBubbleLine(residualBox, winnerBox) {
    const minHeight = Math.min(Number(residualBox?.h) || 0, Number(winnerBox?.h) || 0);
    if (!(minHeight > 0) || runtime.seamBoxOverlapOverSmaller(residualBox, winnerBox) >= 0.35) {
      return false;
    }
    const aboveGap = winnerBox.y - (residualBox.y + residualBox.h);
    const belowGap = residualBox.y - (winnerBox.y + winnerBox.h);
    const maxGap = minHeight * 0.55;
    // OCR 相邻行的框常有几像素重叠，允许最多重叠较矮行的四成。现场（RIDI 分片面板）：
    // 被分片剪断的标题行框高 7.42%、紧邻的正文行组框从 5.2% 起，两者重叠 2.2% =
    // 较矮行高的 0.30 —— 旧上限 0.25 差 0.05 就把同一面板的相邻行挡在吸收之外，
    // 于是同一块内容分成「接缝面 + 页级气泡」两份覆盖。
    const minGap = -minHeight * 0.4;
    const adjacent = (aboveGap >= minGap && aboveGap <= maxGap) ||
      (belowGap >= minGap && belowGap <= maxGap);
    if (!adjacent) return false;
    const overlapLeft = Math.max(residualBox.x, winnerBox.x);
    const overlapRight = Math.min(residualBox.x + residualBox.w, winnerBox.x + winnerBox.w);
    const horizontalOverlap = (overlapRight - overlapLeft) /
      Math.max(1, Math.min(residualBox.w, winnerBox.w));
    return horizontalOverlap >= 0.5;
  }
  runtime.isSeamAdjacentBubbleLine = isSeamAdjacentBubbleLine;

  /**
   * 「这条文本是被页边界切断的残字」——只有在识别结果本身就坏掉时才成立。
   *
   * 现场（Lezhin）：气泡被页边界劈开，下页页级 OCR 把半行读成 `ᅥ|고그 없네.`
   * （组合字母 U+1165 + 混进来的 `|`），这种文本永远过不了文本关系门槛
   * （`hasStrongTextRelation`），于是同一气泡会同时留下跨页译文与页级碎片译文。
   * 判据刻意收紧：**干净的字词（如「외부」这种无关小框）不算残字** ——
   * canonical_render_plan 的反例就是用它挡住"贴页边的无关整块文本"，
   * 只按几何放开会把那种情况一并吸收。
   */
  function looksLikeCutFragmentText(text) {
    const raw = String(text || "");
    if (!raw) return false;
    if (/[\u1100-\u11ff\u3130-\u318f\ufffd]/u.test(raw)) return true;
    return /[\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/u.test(raw) && /[|\\^*~_]/u.test(raw);
  }
  runtime.looksLikeCutFragmentText = looksLikeCutFragmentText;

  function findSeamCoveredResidualCanonicals(selected, canonicals, observationsById, segments) {
    const reconciler = runtime.getCanonicalReconciler();
    if (!reconciler?.hasStrongTextRelation || !reconciler?.fuzzyFragmentSimilarity) return [];
    const winners = Array.isArray(selected) ? selected : [];
    const winnerIds = new Set(winners.map(item => String(item?.canonical?.id || "")));
    const segmentByPage = new Map((Array.isArray(segments) ? segments : [])
      .map(segment => [String(segment?.pageId || ""), segment]));
    const rolesOf = canonical => new Set((canonical?.memberObservationIds || []).map(id => {
      const visual = observationsById.get(String(id))?.visual || {};
      return String(visual.translationRole || visual.translation_role || "").trim().toLowerCase();
    }));
    const results = [];
    for (const canonical of Array.isArray(canonicals) ? canonicals : []) {
      if (!canonical || winnerIds.has(String(canonical.id || "")) || canonical.status === "filtered") continue;
      const boxes = runtime.canonicalSeamPageBoxes(canonical, observationsById, segments).text;
      if (boxes.length !== 1) continue;
      const residualBox = boxes[0];
      const segment = segmentByPage.get(String(residualBox.pageId || ""));
      const crop = runtime.normalizeSeamGeometryRect(segment?.sourceCrop);
      const width = Number(segment?.naturalWidth) || 0;
      const height = Number(segment?.naturalHeight) || 0;
      if (!crop || !(width > 0 && height > 0)) continue;
      const captureBox = { x: crop.x / width * 100, y: crop.y / height * 100,
        w: crop.w / width * 100, h: crop.h / height * 100 };
      const captureCoverage = seamBoxCoverage(residualBox, captureBox);
      const residualText = String(canonical.originalText || canonical.original_text || "").trim();
      const compactResidual = residualText.normalize("NFKC").replace(/\s+/gu, "");
      for (const winner of winners) {
        const winnerText = String(
          winner?.canonical?.originalText || winner?.canonical?.original_text || ""
        ).trim();
        const winnerLength = Array.from(winnerText.replace(/\s+/gu, "")).length;
        if (!winnerText) continue;
        const winnerBox = (winner?.bubble?.page_text_boxes || [])
          .find(item => String(item?.pageId || "") === String(residualBox.pageId || "")) ||
          // 没有这一页的文字框时退回覆盖框（覆盖框是文字框的超集，吸收判据只需要"包含"）。
          (winner?.bubble?.page_cover_boxes || [])
            .find(item => String(item?.pageId || "") === String(residualBox.pageId || ""));
        if (!winnerBox) continue;
        const overlap = runtime.seamBoxOverlapOverSmaller(residualBox, winnerBox);
        const residualArea = residualBox.w * residualBox.h;
        const winnerArea = winnerBox.w * winnerBox.h;
        const winnerRoles = rolesOf(winner.canonical);
        const residualRoles = rolesOf(canonical);
        const rolesCompatible = winnerRoles.size === 1 && residualRoles.size === 1 &&
          [...winnerRoles][0] === [...residualRoles][0];
        // 近完全包含的微小残片:几何已证明是 winner 文本的一部分。
        // OCR 会把一行拆成多个小块,1 字符短块过不了文本关系门槛,
        // 这里只用面积比约束,避免误吸收"unrelated"这类整块文本。
        // 残字通道（面积比不再设限）：被页边界切断的半行，OCR 读出来的是残字
        // （组合/兼容字母、�、混进来的符号），且贴着被切开的那条页边（上下 4% 内）——
        // 同一条线被切断后，碎片框可以和 winner 的框一样大（实测面积比 0.96），
        // 所以这条通道只靠"几乎完全包含"（overlap ≥ 0.9）判定；干净字词（「외부」
        // 这类贴页边的无关小框）文本关系门槛照旧，不会被误吸收。
        const touchesPageEdge = (Number(residualBox.y) || 0) <= 4 ||
          (Number(residualBox.y) || 0) + (Number(residualBox.h) || 0) >= 96;
        const cutFragment = touchesPageEdge && runtime.looksLikeCutFragmentText(residualText);
        if (captureCoverage >= 0.72 && overlap >= 0.9 && rolesCompatible &&
            (residualArea <= winnerArea * 0.25 || cutFragment && residualArea <= winnerArea * 1.2)) {
          results.push({ canonical, winnerCanonicalId: String(winner.canonical.id),
            pageId: String(residualBox.pageId), overlap, captureCoverage, kind: "fragment" });
          break;
        }
        // 相邻行是同一气泡的上下行,文本往往比 seam 行更长,
        // 长度守卫只适用于残片路径。
        if (rolesCompatible && runtime.isSeamAdjacentBubbleLine(residualBox, winnerBox)) {
          results.push({ canonical, winnerCanonicalId: String(winner.canonical.id),
            pageId: String(residualBox.pageId), overlap, captureCoverage, kind: "adjacent_line" });
          break;
        }
        if (Array.from(compactResidual).length > winnerLength) continue;
        if (captureCoverage < 0.72 || overlap < 0.72 || residualArea > winnerArea * 1.35) continue;
        if (!rolesCompatible) continue;
        const correctedShort = /^[가-힣]{2,3}$/u.test(compactResidual) &&
          reconciler.fuzzyFragmentSimilarity(winnerText, compactResidual, 4) >=
            reconciler.FUZZY_SEAM_FRAGMENT_THRESHOLD;
        if (!reconciler.hasStrongTextRelation(winnerText, residualText) && !correctedShort) continue;
        results.push({ canonical, winnerCanonicalId: String(winner.canonical.id),
          pageId: String(residualBox.pageId), overlap, captureCoverage, kind: "fragment" });
        break;
      }
    }
    return results.sort((left, right) =>
      String(left.canonical.id).localeCompare(String(right.canonical.id)));
  }
  runtime.findSeamCoveredResidualCanonicals = findSeamCoveredResidualCanonicals;

  function collectSeamSurfaceOwnership(selected, handled, canonicals, observationsById, segments) {
    const coveredResiduals = findSeamCoveredResidualCanonicals(
      selected, canonicals, observationsById, segments
    );
    const records = [
      ...(Array.isArray(handled) ? handled.map(item => item.canonical) : []),
      ...coveredResiduals.map(item => item.canonical)
    ];
    const absorbedIdSet = new Set(records.flatMap(canonical =>
      [canonical.id, canonical.supersedesId].filter(Boolean).map(String)
    ));
    const diagnostics = coveredResiduals.map(item => ({
      canonicalId: String(item.canonical.id),
      winnerCanonicalId: item.winnerCanonicalId,
      pageId: item.pageId,
      reason: "covered_text_fragment",
      overlap: Math.round(item.overlap * 10000) / 10000,
      captureCoverage: Math.round(item.captureCoverage * 10000) / 10000
    }));
    return { coveredResiduals, absorbedIdSet, diagnostics };
  }
  runtime.collectSeamSurfaceOwnership = collectSeamSurfaceOwnership;
}
