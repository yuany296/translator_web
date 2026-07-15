export function installPipeline04(runtime) {
  function mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const mapped = points.map(point => {
      const x = Number(point && point.x);
      const rawY = Number(point && point.y);
      if (!Number.isFinite(x) || !Number.isFinite(rawY)) return null;
      const pixY = rawY / 100 * compositeH;
      return {
        x,
        y: (pixY - ownerY) / ownerH * 100
      };
    });
    return mapped.every(Boolean) ? mapped : null;
  }

  /**
   * Sutherland-Hodgman polygon clipping against owner top/bottom boundaries.
   * Clips polygon points to the horizontal strip [ownerTop, ownerBottom].
   * Returns the clipped polygon, or null if entirely outside.
   */
  runtime.mapKakaoStitchedPolygon = mapKakaoStitchedPolygon;
  function clipKakaoPolygonToOwnerBounds(points, ownerTop, ownerBottom) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const clipEdge = (input, edgeY, isTop) => {
      if (input.length === 0) return [];
      const result = [];
      for (let i = 0; i < input.length; i++) {
        const current = input[i];
        const previous = input[(i + input.length - 1) % input.length];
        const currentInside = isTop ? current.y >= edgeY : current.y <= edgeY;
        const previousInside = isTop ? previous.y >= edgeY : previous.y <= edgeY;
        if (currentInside) {
          if (!previousInside) {
            const t = (edgeY - previous.y) / (current.y - previous.y);
            if (Number.isFinite(t)) {
              result.push({
                x: previous.x + t * (current.x - previous.x),
                y: edgeY
              });
            }
          }
          result.push(current);
        } else if (previousInside) {
          const t = (edgeY - previous.y) / (current.y - previous.y);
          if (Number.isFinite(t)) {
            result.push({
              x: previous.x + t * (current.x - previous.x),
              y: edgeY
            });
          }
        }
      }
      return result;
    };
    let output = clipEdge(points, ownerTop, true); // clip top
    output = clipEdge(output, ownerBottom, false); // clip bottom

    return output.length >= 3 ? output : null;
  }
  runtime.clipKakaoPolygonToOwnerBounds = clipKakaoPolygonToOwnerBounds;
  function computeKakaoGlobalBox(bubblePercent, scrollX, scrollY, targetRect) {
    if (!targetRect || !(targetRect.width > 0) || !(targetRect.height > 0)) return null;
    const bx = Number(bubblePercent.x);
    const by = Number(bubblePercent.y);
    const bw = Number(bubblePercent.w);
    const bh = Number(bubblePercent.h);
    if (![bx, by, bw, bh].every(Number.isFinite)) return null;
    return {
      left: targetRect.left + (scrollX || 0) + bx / 100 * targetRect.width,
      top: targetRect.top + (scrollY || 0) + by / 100 * targetRect.height,
      width: bw / 100 * targetRect.width,
      height: bh / 100 * targetRect.height
    };
  }

  /**
   * mapKakaoStitchedResult — 将拼接画布上的 OCR 气泡映射回 owner 图像坐标系。
   * 纯函数：不依赖 DOM / scroll 状态，scrollX/Y 显式传入。
   */
  runtime.computeKakaoGlobalBox = computeKakaoGlobalBox;
  function mapKakaoStitchedResult(result, payloadStitch, targetRect, scrollX, scrollY) {
    if (!payloadStitch || !result || !Array.isArray(result.bubbles)) {
      return result;
    }
    const canvasWidth = Math.max(1, Number(payloadStitch.canvasWidth || 1));
    const canvasHeight = Math.max(1, Number(payloadStitch.canvasHeight || 1));
    const ownerDraw = payloadStitch.owner && payloadStitch.owner.drawRect ? payloadStitch.owner.drawRect : {
      x: 0,
      y: 0,
      w: canvasWidth,
      h: canvasHeight
    };
    const segments = runtime.normalizeKakaoStitchSegments(payloadStitch, canvasWidth, canvasHeight, ownerDraw);

    // Compute seam boundaries between owner and neighbor segments
    const seamBoundaries = [];
    for (const seg of segments) {
      if (seg && seg.drawRect) {
        if (seg.source === "previous") {
          seamBoundaries.push(seg.drawRect.y + seg.drawRect.h);
        } else if (seg.source === "next") {
          seamBoundaries.push(seg.drawRect.y);
        }
      }
    }
    const minCrossPx = Math.max(runtime.KAKAO_STITCH_MIN_CROSS_PX, canvasHeight * runtime.KAKAO_STITCH_MIN_CROSS_RATIO);
    const mapped = result.bubbles.map(bubble => {
      const bx = Number(bubble.x);
      const by = Number(bubble.y);
      const bw = Number(bubble.w);
      const bh = Number(bubble.h);
      if (![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) {
        return null;
      }
      const bubblePx = {
        x: bx / 100 * canvasWidth,
        y: by / 100 * canvasHeight,
        w: bw / 100 * canvasWidth,
        h: bh / 100 * canvasHeight
      };
      const crossesSeam = seamBoundaries.some(seamY => bubblePx.y < seamY - minCrossPx && bubblePx.y + bubblePx.h > seamY + minCrossPx);
      const crossesSeamWithClip = crossesSeam ? runtime.clipKakaoPolygonToOwnerBounds(bubble.polygon, ownerDraw.y, ownerDraw.y + ownerDraw.h) : null;
      const bubbleArea = Math.max(1, bubblePx.w * bubblePx.h);
      const ranked = segments.map(seg => {
        const rect = seg && seg.drawRect;
        if (!rect) return {
          segment: seg,
          ratio: 0
        };
        const left = Math.max(bubblePx.x, rect.x);
        const top = Math.max(bubblePx.y, rect.y);
        const right = Math.min(bubblePx.x + bubblePx.w, rect.x + rect.w);
        const bottom = Math.min(bubblePx.y + bubblePx.h, rect.y + rect.h);
        const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
        return {
          segment: seg,
          ratio: overlap / bubbleArea
        };
      }).sort((a, b) => b.ratio - a.ratio);
      const best = ranked[0];
      const ownerRank = ranked.find(r => r.segment && r.segment.source === "owner");
      const ownerRatio = ownerRank ? ownerRank.ratio : 0;
      const isShortPageAttachment = best && best.segment && best.segment.shortPageAttachment === true && (best.segment.source === "previous" || best.segment.source === "next") && best.ratio >= 0.6;
      if (!isShortPageAttachment && (!best || !best.segment || best.segment.source !== "owner" || best.ratio < 0.6)) {
        const boundaryNeighbor = runtime.mapKakaoAdjacentBoundaryRect(bubblePx, best, ownerDraw, canvasHeight);
        if (boundaryNeighbor) {
          return {
            ...bubble,
            ...boundaryNeighbor,
            stitch_overflow: true,
            stitch_boundary_neighbor: true,
            crossesSeam: false,
            sourceType: "seam",
            clippedPolygon: null,
            fill_box: runtime.mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
            polygon: runtime.mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
            region_polygon: runtime.mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
          };
        }
        return null;
      }
      if (isShortPageAttachment) {
        const mappedY = (bubblePx.y - ownerDraw.y) / ownerDraw.h * 100;
        const mappedH = bubblePx.h / ownerDraw.h * 100;
        if (mappedY + mappedH < -80 || mappedY > 180 || mappedH > 70) return null;
        return {
          ...bubble,
          x: (bubblePx.x - ownerDraw.x) / ownerDraw.w * 100,
          y: mappedY,
          w: bubblePx.w / ownerDraw.w * 100,
          h: mappedH,
          stitch_overflow: true,
          stitch_attached_short_page: true,
          crossesSeam,
          sourceType: crossesSeam ? "seam" : "single",
          clippedPolygon: crossesSeamWithClip,
          fill_box: runtime.mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
          polygon: runtime.mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
          region_polygon: runtime.mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
        };
      }

      // Overflow handling
      const crossesBoundary = bubblePx.y < ownerDraw.y || bubblePx.y + bubblePx.h > ownerDraw.y + ownerDraw.h;
      const overflow = crossesBoundary && ownerRatio >= 0.25;
      if (overflow) {
        const mappedY = (bubblePx.y - ownerDraw.y) / ownerDraw.h * 100;
        const mappedH = bubblePx.h / ownerDraw.h * 100;
        if (mappedY + mappedH < -35 || mappedY > 135 || mappedH > 60) return null;
        return {
          ...bubble,
          x: (bubblePx.x - ownerDraw.x) / ownerDraw.w * 100,
          y: mappedY,
          w: bubblePx.w / ownerDraw.w * 100,
          h: mappedH,
          stitch_overflow: true,
          crossesSeam,
          sourceType: crossesSeam ? "seam" : "single",
          clippedPolygon: crossesSeamWithClip,
          fill_box: runtime.mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
          polygon: runtime.mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
          region_polygon: runtime.mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
        };
      }

      // Normal bubble: clip to owner drawRect
      const clippedLeft = Math.max(bubblePx.x, ownerDraw.x);
      const clippedTop = Math.max(bubblePx.y, ownerDraw.y);
      const clippedRight = Math.min(bubblePx.x + bubblePx.w, ownerDraw.x + ownerDraw.w);
      const clippedBottom = Math.min(bubblePx.y + bubblePx.h, ownerDraw.y + ownerDraw.h);
      const clippedW = Math.max(0, clippedRight - clippedLeft);
      const clippedH = Math.max(0, clippedBottom - clippedTop);
      if (clippedW <= 0 || clippedH <= 0) return null;
      const mappedX = (clippedLeft - ownerDraw.x) / ownerDraw.w * 100;
      const mappedY = (clippedTop - ownerDraw.y) / ownerDraw.h * 100;
      const mappedW = clippedW / ownerDraw.w * 100;
      const mappedH = clippedH / ownerDraw.h * 100;
      const lineCount = runtime.getBubbleLineCount(bubble);
      const maxH = lineCount > 1 ? 60 : 35;
      if (mappedX < -5 || mappedX + mappedW > 105 || mappedY < -5 || mappedY + mappedH > 105) {
        return null;
      }
      const clampedHfinal = mappedH > maxH ? maxH : mappedH;
      const clampAdjusted = mappedH !== clampedHfinal;
      return {
        ...bubble,
        x: mappedX,
        y: mappedY,
        w: mappedW,
        h: clampedHfinal,
        stitch_overflow: false,
        crossesSeam,
        sourceType: crossesSeam ? "seam" : "single",
        clippedPolygon: clampAdjusted ? null : crossesSeamWithClip,
        fill_box: clampAdjusted ? null : runtime.mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
        polygon: clampAdjusted ? null : runtime.mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
        region_polygon: clampAdjusted ? null : runtime.mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
      };
    }).filter(Boolean);

    // Drop stitched bubbles that don't cross the seam — they duplicate single-page OCR.
    // Only applies when there are actual neighbor seam boundaries to cross
    // and no short-page attachments are involved (short pages need full mapping).
    const hasShortPageAttachments = segments.some(seg => seg && seg.shortPageAttachment === true);
    const filtered = seamBoundaries.length === 0 || hasShortPageAttachments ? mapped : mapped.filter(bubble => bubble.stitch_boundary_neighbor === true || bubble.stitch_attached_short_page === true || bubble.crossesSeam === true || bubble.stitch_overflow === true);
    return {
      ...result,
      bubbles: filtered,
      debug: runtime.normalizeKakaoStitchDebugCoordinates(result.debug, payloadStitch)
    };
  }
  runtime.mapKakaoStitchedResult = mapKakaoStitchedResult;
  function mapKakaoAdjacentBoundaryRect(rect, rankedEntry, ownerRect, canvasHeight) {
    const segment = rankedEntry && rankedEntry.segment;
    const segmentRect = segment && segment.drawRect;
    if (!rect || !segmentRect || segment.source !== "previous" && segment.source !== "next" || segment.shortPageAttachment === true) {
      return null;
    }
    const contextSlice = segmentRect.h <= ownerRect.h * 0.45;
    if (!contextSlice) return null;
    const expectedEdge = segment.source === "previous" ? ownerRect.y : ownerRect.y + ownerRect.h;
    const actualEdge = segment.source === "previous" ? segmentRect.y + segmentRect.h : segmentRect.y;
    if (Math.abs(actualEdge - expectedEdge) > Math.max(2, ownerRect.h * 0.02)) {
      return null;
    }
    const rectTop = rect.y;
    const rectBottom = rect.y + rect.h;
    const crossesOwnerEdge = segment.source === "previous" ? rectTop < ownerRect.y && rectBottom > ownerRect.y : rectTop < ownerRect.y + ownerRect.h && rectBottom > ownerRect.y + ownerRect.h;
    const requiredRatio = crossesOwnerEdge ? 0.45 : 0.6;
    if (rankedEntry.ratio < requiredRatio) return null;
    const mappedY = (rect.y - ownerRect.y) / ownerRect.h * 100;
    const mappedH = rect.h / ownerRect.h * 100;
    const segmentStart = (segmentRect.y - ownerRect.y) / ownerRect.h * 100;
    const segmentEnd = (segmentRect.y + segmentRect.h - ownerRect.y) / ownerRect.h * 100;
    const tolerance = 5;
    const inPreviousSlice = segment.source === "previous" && mappedY <= tolerance && mappedY + mappedH >= segmentStart - tolerance;
    const inNextSlice = segment.source === "next" && mappedY + mappedH >= 100 - tolerance && mappedY <= segmentEnd + tolerance;
    if (!inPreviousSlice && !inNextSlice || mappedH <= 0 || mappedH > 60) return null;
    return {
      x: (rect.x - ownerRect.x) / ownerRect.w * 100,
      y: mappedY,
      w: rect.w / ownerRect.w * 100,
      h: mappedH
    };
  }

  /* =================================================================
   * 回退检测（纯）
   * ================================================================= */
  runtime.mapKakaoAdjacentBoundaryRect = mapKakaoAdjacentBoundaryRect;
  function shouldFallbackFromKakaoStitch(stitchPayload, rawResult, mappedResult) {
    if (!stitchPayload || !stitchPayload.stitch || !stitchPayload.singleImagePayload) {
      return "";
    }
    const rawBubbles = rawResult && Array.isArray(rawResult.bubbles) ? rawResult.bubbles : [];
    const mappedBubbles = mappedResult && Array.isArray(mappedResult.bubbles) ? mappedResult.bubbles : [];
    if (rawBubbles.length === 0) return "stitched OCR produced no owner text";
    if (mappedBubbles.length === 0 && rawBubbles.length > 0) return "stitched OCR dropped all bubbles";
    const dropRatio = rawBubbles.length > 0 ? (rawBubbles.length - mappedBubbles.length) / rawBubbles.length : 0;
    if (dropRatio > 0.7) return "stitched OCR drop ratio exceeded 70%";
    const invalid = mappedBubbles.some(bubble => {
      const values = [bubble.x, bubble.y, bubble.w, bubble.h].map(v => Number(v));
      if (values.some(v => !Number.isFinite(v))) return true;
      const bw = values[2];
      const bh = values[3];
      if (bw <= 0 || bh <= 0) return true;
      const bx = values[0];
      const by = values[1];
      if (bubble.stitch_overflow) {
        if (by + bh < -35 || by > 135) return true;
        if (bh > 60) return true;
      } else {
        if (bx < -5 || bx + bw > 105) return true;
        if (by < -5 || by + bh > 105) return true;
        const lineCount = runtime.getBubbleLineCount(bubble);
        if (bh > (lineCount > 1 ? 60 : 35)) return true;
      }
      return false;
    });
    return invalid ? "stitched OCR produced implausible owner coordinates" : "";
  }

  /* =================================================================
   * 调试坐标映射（纯）
   * ================================================================= */
  runtime.shouldFallbackFromKakaoStitch = shouldFallbackFromKakaoStitch;
}
