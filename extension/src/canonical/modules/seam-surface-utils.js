export function installSeamSurfaceUtils(runtime) {
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
}
