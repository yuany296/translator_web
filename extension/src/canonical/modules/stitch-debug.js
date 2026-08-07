export function installStitchDebug(runtime) {
  /* =================================================================
   * 调试坐标映射（纯）
   * ================================================================= */
  function normalizeKakaoStitchDebugCoordinates(debug, stitch) {
    if (!debug || !stitch) return debug;
    const cw = Math.max(1, Number(stitch.canvasWidth || stitch.compositeWidth) || Number(debug.imageWidth) || 1);
    const ch = Math.max(1, Number(stitch.canvasHeight || stitch.compositeHeight) || Number(debug.imageHeight) || 1);
    const ownerDraw = stitch.owner && stitch.owner.drawRect ? stitch.owner.drawRect : {
      x: 0,
      y: 0,
      w: cw,
      h: ch
    };
    const ownerRect = runtime.normalizeRectLike(ownerDraw) || {
      x: 0,
      y: 0,
      w: cw,
      h: ch
    };
    const ctx = {
      stitch,
      compositeWidth: cw,
      compositeHeight: ch,
      ownerDraw: ownerRect,
      segments: runtime.normalizeKakaoStitchSegments(stitch, cw, ch, ownerRect)
    };
    return {
      ...debug,
      imageWidth: ownerRect.w,
      imageHeight: ownerRect.h,
      rawItems: runtime.normalizeDebugCoordinateItems(debug.rawItems, debug, ctx),
      duplicateItems: runtime.normalizeDebugCoordinateItems(debug.duplicateItems, debug, ctx),
      dedupedItems: runtime.normalizeDebugCoordinateItems(debug.dedupedItems, debug, ctx)
    };
  }
  runtime.normalizeKakaoStitchDebugCoordinates = normalizeKakaoStitchDebugCoordinates;
  function normalizeDebugCoordinateItems(items, debug, context) {
    if (!Array.isArray(items)) return [];
    if (!context || !context.stitch) return items;
    const imageWidth = Math.max(1, Number(debug && debug.imageWidth) || Number(context.compositeWidth) || 1);
    const imageHeight = Math.max(1, Number(debug && debug.imageHeight) || Number(context.compositeHeight) || 1);
    const compositeWidth = Math.max(1, Number(context.compositeWidth) || imageWidth);
    const compositeHeight = Math.max(1, Number(context.compositeHeight) || imageHeight);
    const ownerDraw = context.ownerDraw || {
      x: 0,
      y: 0,
      w: compositeWidth,
      h: compositeHeight
    };
    const segments = Array.isArray(context.segments) ? context.segments : [];
    return items.map(item => {
      const percent = runtime.getDebugItemPercent(item, imageWidth, imageHeight);
      if (!percent) return null;
      const rect = {
        x: Number(percent.x) / 100 * compositeWidth,
        y: Number(percent.y) / 100 * compositeHeight,
        w: Number(percent.w) / 100 * compositeWidth,
        h: Number(percent.h) / 100 * compositeHeight
      };
      const ownerOverlap = runtime.getKakaoStitchOwnerOverlap(rect, segments);
      const mapped = ownerOverlap ? runtime.mapKakaoOwnerDebugRect(rect, ownerDraw) : runtime.mapKakaoAdjacentBoundaryRect(rect, runtime.getKakaoStitchBestOverlap(rect, segments), ownerDraw, compositeHeight);
      return mapped && mapped.w > 0 && mapped.h > 0 ? {
        ...item,
        percent: mapped
      } : null;
    }).filter(Boolean);
  }
  runtime.normalizeDebugCoordinateItems = normalizeDebugCoordinateItems;
  function getDebugItemPercent(item, imageWidth, imageHeight) {
    if (item && item.percent && [item.percent.x, item.percent.y, item.percent.w, item.percent.h].every(v => Number.isFinite(Number(v)))) {
      return item.percent;
    }
    const box = item && (item.rawBox || item.box);
    if (!box || ![box.left, box.top, box.width, box.height].every(v => Number.isFinite(Number(v)))) return null;
    return {
      x: Number(box.left) / imageWidth * 100,
      y: Number(box.top) / imageHeight * 100,
      w: Number(box.width) / imageWidth * 100,
      h: Number(box.height) / imageHeight * 100
    };
  }
  runtime.getDebugItemPercent = getDebugItemPercent;
  function mapKakaoOwnerDebugRect(rect, ownerDraw) {
    const left = Math.max(rect.x, ownerDraw.x);
    const top = Math.max(rect.y, ownerDraw.y);
    const right = Math.min(rect.x + rect.w, ownerDraw.x + ownerDraw.w);
    const bottom = Math.min(rect.y + rect.h, ownerDraw.y + ownerDraw.h);
    return {
      x: (left - ownerDraw.x) / ownerDraw.w * 100,
      y: (top - ownerDraw.y) / ownerDraw.h * 100,
      w: Math.max(0, right - left) / ownerDraw.w * 100,
      h: Math.max(0, bottom - top) / ownerDraw.h * 100
    };
  }

  /* =================================================================
   * 调试气泡过滤（纯）
   * ================================================================= */
  runtime.mapKakaoOwnerDebugRect = mapKakaoOwnerDebugRect;
  function filterOcrDebugFinalBubbles(debug, bubbles) {
    if (!debug || typeof debug !== "object") return debug;
    const keptBlockIds = new Set((Array.isArray(bubbles) ? bubbles : []).map(b => String(b && (b.block_id || b.id) || "")).filter(Boolean));
    const finalBubbles = (Array.isArray(debug.finalBubbles) ? debug.finalBubbles : []).filter(item => keptBlockIds.has(String(item && (item.blockId || item.block_id || item.id) || "")));
    return {
      ...debug,
      finalBubbles,
      items: finalBubbles
    };
  }
  runtime.filterOcrDebugFinalBubbles = filterOcrDebugFinalBubbles;
  function syncOcrDebugFinalBubbles(debug, bubbles) {
    const filtered = runtime.filterOcrDebugFinalBubbles(debug, bubbles);
    if (!filtered) return filtered;
    const byId = new Map((Array.isArray(bubbles) ? bubbles : []).map(b => [String(b && (b.block_id || b.id) || ""), b]));
    const finalBubbles = filtered.finalBubbles.map(item => {
      const bubble = byId.get(String(item && (item.blockId || item.block_id || item.id) || ""));
      return bubble ? {
        ...item,
        text: bubble.original_text,
        translatedText: bubble.translated_text,
        percent: {
          x: bubble.x,
          y: bubble.y,
          w: bubble.w,
          h: bubble.h
        }
      } : item;
    });
    return {
      ...filtered,
      finalBubbles,
      items: finalBubbles
    };
  }

  /* =================================================================
   * 去重函数（纯——状态由 Store 管理）
   * ================================================================= */
  runtime.syncOcrDebugFinalBubbles = syncOcrDebugFinalBubbles;
  function trimKakaoBubbleBoundary(bubble, overlap) {
    if (!bubble || !overlap || !(overlap.length > 0)) return null;
    const originalText = String(bubble.original_text || "");
    const normalizedLength = Math.max(1, runtime.normalizeOcrSimilarityText(originalText).length);
    const uniqueLength = normalizedLength - overlap.length;
    if (uniqueLength < 2) return null;
    const keepRatio = Math.max(0.12, Math.min(1, uniqueLength / normalizedLength));
    const keepSuffix = overlap.trim === "prefix";
    const uniqueText = runtime.sliceTextByNormalizedBoundary(originalText, overlap.length, keepSuffix);
    if (runtime.normalizeOcrSimilarityText(uniqueText).length < 2) return null;
    const originalY = Number(bubble.y);
    const originalH = Number(bubble.h);
    const nextY = keepSuffix ? originalY + originalH * (1 - keepRatio) : originalY;
    const nextH = originalH * keepRatio;
    const globalBox = bubble.global_box ? {
      ...bubble.global_box,
      top: keepSuffix ? Number(bubble.global_box.top) + Number(bubble.global_box.height) * (1 - keepRatio) : Number(bubble.global_box.top),
      height: Number(bubble.global_box.height) * keepRatio
    } : null;
    return {
      ...bubble,
      original_text: uniqueText,
      translated_text: "",
      y: nextY,
      h: nextH,
      fill_box: null,
      polygon: null,
      region_polygon: null,
      global_box: globalBox,
      source_line_count: Math.max(1, Math.round(Number(bubble.source_line_count || 1) * keepRatio)),
      boundary_trimmed: true
    };
  }
  runtime.trimKakaoBubbleBoundary = trimKakaoBubbleBoundary;
  function isKakaoBoundaryNeighborBubble(bubble) {
    return !!(bubble && bubble.stitch_boundary_neighbor);
  }
  runtime.isKakaoBoundaryNeighborBubble = isKakaoBoundaryNeighborBubble;
  function isKakaoBoundaryOwnPair(candidate, entry) {
    return runtime.isKakaoBoundaryNeighborBubble(candidate && candidate.bubble) !== runtime.isKakaoBoundaryNeighborBubble(entry && entry.bubble);
  }
  runtime.isKakaoBoundaryOwnPair = isKakaoBoundaryOwnPair;
  function isKakaoBoundaryOwnDuplicateCandidate(candidate, entry) {
    return runtime.areOcrTextsDuplicateOrContained(candidate.text, entry.text) || runtime.hasSubstantialOcrTokenOverlap(candidate.text, entry.text);
  }
  runtime.isKakaoBoundaryOwnDuplicateCandidate = isKakaoBoundaryOwnDuplicateCandidate;
  const MIN_TRANSLATED_TEXT_DEDUP_LENGTH = 6;
  function areTranslatedTextsDuplicateOrContained(first, second) {
    if (!first || !second) return false;
    const shorter = first.length <= second.length ? first : second;
    if (shorter.length < MIN_TRANSLATED_TEXT_DEDUP_LENGTH) return false;
    return runtime.areOcrTextsDuplicateOrContained(first, second);
  }
  runtime.areTranslatedTextsDuplicateOrContained = areTranslatedTextsDuplicateOrContained;
  function selectKakaoVisualDuplicateLoser(left, right) {
    const leftKey = String(left && left.scopeKey || "");
    const rightKey = String(right && right.scopeKey || "");
    if (!leftKey || !rightKey || leftKey === rightKey) return null;
    const leftRegion = String(left && left.regionType || "").trim();
    const rightRegion = String(right && right.regionType || "").trim();
    if (!leftRegion || leftRegion !== rightRegion) return null;
    const leftOverflow = left && left.stitchOverflow === true;
    const rightOverflow = right && right.stitchOverflow === true;
    if (!leftOverflow && !rightOverflow) return null;
    const leftBox = left && left.box;
    const rightBox = right && right.box;
    if (!leftBox || !rightBox) return null;
    const leftArea = Number(leftBox.width) * Number(leftBox.height);
    const rightArea = Number(rightBox.width) * Number(rightBox.height);
    if (!(leftArea > 0) || !(rightArea > 0)) return null;
    const areaRatio = Math.min(leftArea, rightArea) / Math.max(leftArea, rightArea);
    if (areaRatio < runtime.KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO || runtime.pageBoxIntersectionRatio(leftBox, rightBox) < runtime.KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION) {
      return null;
    }

    // owner/overflow 成对时始终保留 owner；两个 overflow 副本则必须有文本证据，
    // 避免仅凭相邻页边界处的几何重叠误删不同对白。
    if (leftOverflow && rightOverflow) {
      const leftOriginal = runtime.normalizeOcrSimilarityText(left && left.originalText);
      const rightOriginal = runtime.normalizeOcrSimilarityText(right && right.originalText);
      const leftTranslated = runtime.normalizeOcrSimilarityText(left && left.translatedText);
      const rightTranslated = runtime.normalizeOcrSimilarityText(right && right.translatedText);
      const textRelated = runtime.areOcrTextsDuplicateOrContained(leftOriginal, rightOriginal) || runtime.areOcrTextsDuplicateOrContained(leftTranslated, rightTranslated);
      if (!textRelated) return null;
      const leftCompleteness = Math.max(leftOriginal.length, leftTranslated.length);
      const rightCompleteness = Math.max(rightOriginal.length, rightTranslated.length);
      if (leftCompleteness !== rightCompleteness) {
        return leftCompleteness < rightCompleteness ? "left" : "right";
      }
      if (leftArea !== rightArea) {
        return leftArea < rightArea ? "left" : "right";
      }
      return "right";
    }
    return leftOverflow ? "left" : "right";
  }
  runtime.selectKakaoVisualDuplicateLoser = selectKakaoVisualDuplicateLoser;
  function isKakaoCrossPageOverflowGeometryDuplicate(candidate, entry) {
    const candidateKey = String(candidate && candidate.targetKey || "");
    const entryKey = String(entry && entry.targetKey || "");
    const candidateBubble = candidate && candidate.bubble;
    const entryBubble = entry && entry.bubble;
    return !!runtime.selectKakaoVisualDuplicateLoser({
      scopeKey: candidateKey,
      regionType: candidateBubble && candidateBubble.region_type,
      stitchOverflow: candidateBubble && candidateBubble.stitch_overflow === true,
      originalText: candidate && candidate.text,
      translatedText: candidate && candidate.translatedText,
      box: candidate.box
    }, {
      scopeKey: entryKey,
      regionType: entryBubble && entryBubble.region_type,
      stitchOverflow: entryBubble && entryBubble.stitch_overflow === true,
      originalText: entry && entry.text,
      translatedText: entry && entry.translatedText,
      box: entry.box
    });
  }
  runtime.isKakaoCrossPageOverflowGeometryDuplicate = isKakaoCrossPageOverflowGeometryDuplicate;
  function isKakaoGlobalDuplicateCandidate(candidate, entry) {
    if (!candidate || !entry || !candidate.box || !entry.box) return false;
    if (!runtime.areKakaoGlobalBoxesRelated(candidate.box, entry.box)) return false;
    if (runtime.isKakaoCrossPageOverflowGeometryDuplicate(candidate, entry)) return true;
    if (runtime.isKakaoBoundaryOwnPair(candidate, entry)) {
      return runtime.isKakaoBoundaryOwnDuplicateCandidate(candidate, entry);
    }
    const sourceRelated = runtime.areOcrTextsDuplicateOrContained(candidate.text, entry.text);
    const translationRelated = runtime.areTranslatedTextsDuplicateOrContained(candidate.translatedText, entry.translatedText);
    return sourceRelated || translationRelated;
  }

  /* =================================================================
   * Store — 封装 Kakao 全局去重与页面状态
   * ================================================================= */
  runtime.isKakaoGlobalDuplicateCandidate = isKakaoGlobalDuplicateCandidate;
}
