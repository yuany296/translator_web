export function installSceneCrossPage(runtime) {
  function isValidCrossPageSegment(segment) {
    const draw = runtime.normalizeSeamRect(segment && segment.drawRect);
    const crop = runtime.normalizeSeamRect(segment && segment.sourceCrop);
    return draw.w > 0 && draw.h > 0 && crop.w > 0 && crop.h > 0 &&
      Number(segment && segment.naturalWidth) > 0 &&
      Number(segment && segment.naturalHeight) > 0;
  }
  runtime.isValidCrossPageSegment = isValidCrossPageSegment;

  function toCompositeBox(surface, value) {
    const width = Number(surface && surface.canvasWidth) || 0;
    const height = Number(surface && surface.canvasHeight) || 0;
    const x = Number(value && value.x);
    const y = Number(value && value.y);
    const w = Number(value && (value.w ?? value.width));
    const h = Number(value && (value.h ?? value.height));
    if (!(width > 0 && height > 0) || ![x, y, w, h].every(Number.isFinite) || !(w > 0 && h > 0)) {
      return null;
    }
    return {
      left: x / 100 * width,
      top: y / 100 * height,
      width: w / 100 * width,
      height: h / 100 * height
    };
  }
  runtime.toCrossPageCompositeBox = toCompositeBox;

  function intersectRect(left, right) {
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.left + left.width, right.left + right.width);
    const y2 = Math.min(left.top + left.height, right.top + right.height);
    return x2 > x1 && y2 > y1 ? {
      left: x1,
      top: y1,
      width: x2 - x1,
      height: y2 - y1
    } : null;
  }

  function mapCompositeRectToRoot(surface, compositeBox, segment, pageRect, rootRect) {
    if (!runtime.isValidCrossPageSegment(segment) || !compositeBox || !pageRect || !rootRect) return null;
    const draw = runtime.normalizeSeamRect(segment.drawRect);
    const crop = runtime.normalizeSeamRect(segment.sourceCrop);
    const intersection = intersectRect(compositeBox, {
      left: draw.x,
      top: draw.y,
      width: draw.w,
      height: draw.h
    });
    if (!intersection || !(pageRect.width > 0 && pageRect.height > 0)) return null;
    const naturalWidth = Number(segment.naturalWidth);
    const naturalHeight = Number(segment.naturalHeight);
    const scaleX = crop.w / draw.w * pageRect.width / naturalWidth;
    const scaleY = crop.h / draw.h * pageRect.height / naturalHeight;
    const sourceLeft = crop.x + (intersection.left - draw.x) * crop.w / draw.w;
    const sourceTop = crop.y + (intersection.top - draw.y) * crop.h / draw.h;
    return {
      pageId: String(segment.pageId || ""),
      left: Math.max(0, pageRect.left + sourceLeft / naturalWidth * pageRect.width - rootRect.left),
      top: Math.max(0, pageRect.top + sourceTop / naturalHeight * pageRect.height - rootRect.top),
      width: intersection.width * scaleX,
      height: intersection.height * scaleY,
      scaleX,
      scaleY,
      compositeIntersection: intersection
    };
  }
  runtime.mapCompositeRectToCrossPageRoot = mapCompositeRectToRoot;

  function mapPageBoxToRoot(surface, value, targetRects, rootRect) {
    const pageId = String(value?.pageId || "");
    const pageRect = targetRects.get(pageId);
    const box = runtime.normalizeSeamRect(value);
    if (!pageRect || !rootRect || !(pageRect.width > 0 && pageRect.height > 0) || !(box.w > 0 && box.h > 0)) return null;
    const sourceLeft = box.x / 100 * pageRect.width;
    const sourceTop = box.y / 100 * pageRect.height;
    const segment = (Array.isArray(surface?.segments) ? surface.segments : [])
      .find(item => String(item?.pageId || "") === pageId);
    const validSegment = runtime.isValidCrossPageSegment(segment);
    const draw = validSegment ? runtime.normalizeSeamRect(segment.drawRect) : null;
    const crop = validSegment ? runtime.normalizeSeamRect(segment.sourceCrop) : null;
    const naturalWidth = validSegment ? Number(segment.naturalWidth) : 0;
    const naturalHeight = validSegment ? Number(segment.naturalHeight) : 0;
    const mapped = {
      pageId,
      mapping: "page",
      left: Math.max(0, pageRect.left + sourceLeft - rootRect.left),
      top: Math.max(0, pageRect.top + sourceTop - rootRect.top),
      width: box.w / 100 * pageRect.width,
      height: box.h / 100 * pageRect.height,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      sourceLeft,
      sourceTop,
      scaleX: validSegment ? crop.w / draw.w * pageRect.width / naturalWidth : 0,
      scaleY: validSegment ? crop.h / draw.h * pageRect.height / naturalHeight : 0
    };
    if (!validSegment) return mapped;
    const sourceBox = {
      left: box.x / 100 * naturalWidth,
      top: box.y / 100 * naturalHeight,
      width: box.w / 100 * naturalWidth,
      height: box.h / 100 * naturalHeight
    };
    const tolerance = 0.01;
    const contained = sourceBox.left >= crop.x - tolerance &&
      sourceBox.top >= crop.y - tolerance &&
      sourceBox.left + sourceBox.width <= crop.x + crop.w + tolerance &&
      sourceBox.top + sourceBox.height <= crop.y + crop.h + tolerance;
    if (!contained) return mapped;
    return {
      ...mapped,
      compositeIntersection: {
        left: draw.x + (sourceBox.left - crop.x) * draw.w / crop.w,
        top: draw.y + (sourceBox.top - crop.y) * draw.h / crop.h,
        width: sourceBox.width * draw.w / crop.w,
        height: sourceBox.height * draw.h / crop.h
      }
    };
  }

  function mapCompositePointToRoot(surface, point, targetRects, rootRect) {
    const segments = Array.isArray(surface && surface.segments) ? surface.segments : [];
    const candidates = segments.filter(segment => {
      const draw = runtime.normalizeSeamRect(segment.drawRect);
      const tolerance = 0.01;
      return point.x >= draw.x - tolerance && point.x <= draw.x + draw.w + tolerance &&
        point.y >= draw.y - tolerance && point.y <= draw.y + draw.h + tolerance;
    });
    const segment = candidates.sort((left, right) => {
      const leftDraw = runtime.normalizeSeamRect(left.drawRect);
      const rightDraw = runtime.normalizeSeamRect(right.drawRect);
      return Math.abs(point.y - (leftDraw.y + leftDraw.h / 2)) -
        Math.abs(point.y - (rightDraw.y + rightDraw.h / 2));
    })[0];
    const pageRect = segment && targetRects.get(String(segment.pageId || ""));
    if (!segment || !pageRect || !runtime.isValidCrossPageSegment(segment)) return null;
    const draw = runtime.normalizeSeamRect(segment.drawRect);
    const crop = runtime.normalizeSeamRect(segment.sourceCrop);
    const naturalWidth = Number(segment.naturalWidth);
    const naturalHeight = Number(segment.naturalHeight);
    const sourceX = crop.x + (point.x - draw.x) * crop.w / draw.w;
    const sourceY = crop.y + (point.y - draw.y) * crop.h / draw.h;
    return {
      x: Math.max(0, pageRect.left + sourceX / naturalWidth * pageRect.width - rootRect.left),
      y: Math.max(0, pageRect.top + sourceY / naturalHeight * pageRect.height - rootRect.top)
    };
  }

  function unionRects(rects) {
    if (!rects.length) return null;
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.left + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.top + rect.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  function addSolidCoverBridges(bubble, segments) {
    if (String(bubble?.bg_type || "").toLowerCase() !== "solid" || segments.length < 2) {
      return segments;
    }
    const ordered = [...segments].sort((left, right) => left.top - right.top || left.left - right.left);
    const bridges = [];
    ordered.slice(1).forEach((segment, index) => {
      const previous = ordered[index];
      if (previous.pageId === segment.pageId) return;
      const gap = segment.top - (previous.top + previous.height);
      const overlapLeft = Math.max(previous.left, segment.left);
      const overlapRight = Math.min(previous.left + previous.width, segment.left + segment.width);
      const overlap = overlapRight - overlapLeft;
      const overlapRatio = overlap / Math.max(1, Math.min(previous.width, segment.width));
      const maxGap = Math.max(2, Math.min(32, Math.min(previous.height, segment.height) * 0.85));
      if (!(gap > 0.5 && gap <= maxGap && overlapRatio >= 0.25)) return;
      bridges.push({
        pageId: `bridge:${previous.pageId}:${segment.pageId}:${index}`,
        mapping: "bridge",
        left: overlapLeft,
        top: previous.top + previous.height,
        width: overlap,
        height: gap,
        scaleX: (Number(previous.scaleX) + Number(segment.scaleX)) / 2,
        scaleY: (Number(previous.scaleY) + Number(segment.scaleY)) / 2
      });
    });
    return [...segments, ...bridges];
  }

  function buildMappedPolygonFrame(surface, bubble, targetRects, rootRect) {
    if (!Array.isArray(bubble && bubble.polygon) || bubble.polygon.length < 4) return null;
    const points = bubble.polygon.slice(0, 4).map(point => mapCompositePointToRoot(surface, {
      x: Number(point && point.x) / 100 * surface.canvasWidth,
      y: Number(point && point.y) / 100 * surface.canvasHeight
    }, targetRects, rootRect));
    if (!points.every(Boolean)) return null;
    const edges = points.map((point, index) => {
      const next = points[(index + 1) % points.length];
      return Math.hypot(next.x - point.x, next.y - point.y);
    });
    return {
      bounds: unionRects(points.map(point => ({ left: point.x, top: point.y, width: 0, height: 0 }))),
      centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      width: Math.max(8, (edges[0] + edges[2]) / 2),
      height: Math.max(8, (edges[1] + edges[3]) / 2)
    };
  }

  function buildCrossPageBubbleGeometry(surface, bubble, targetRects, rootRect) {
    const textBox = toCompositeBox(surface, bubble);
    const coverBox = toCompositeBox(surface, runtime.resolveBubbleCoverBox(bubble) || bubble);
    if (!textBox || !coverBox) return null;
    const mapBox = box => surface.segments.map(segment => {
      const pageRect = targetRects.get(String(segment.pageId || ""));
      return mapCompositeRectToRoot(surface, box, segment, pageRect, rootRect);
    }).filter(Boolean);
    const pageTextBoxes = Array.isArray(bubble?.page_text_boxes) ? bubble.page_text_boxes : [];
    const pageCoverBoxes = Array.isArray(bubble?.page_cover_boxes) ? bubble.page_cover_boxes : [];
    const textSegments = (pageTextBoxes.length ? pageTextBoxes.map(value => mapPageBoxToRoot(surface, value, targetRects, rootRect)) : mapBox(textBox)).filter(Boolean);
    const mappedCoverSegments = (pageCoverBoxes.length ? pageCoverBoxes.map(value =>
      mapPageBoxToRoot(surface, value, targetRects, rootRect)) : mapBox(coverBox)).filter(Boolean);
    const coverSegments = addSolidCoverBridges(bubble, mappedCoverSegments);
    const fallbackTextBounds = unionRects(textSegments);
    const polygonFrame = pageTextBoxes.length ? null : buildMappedPolygonFrame(surface, bubble, targetRects, rootRect);
    const textBounds = polygonFrame && polygonFrame.bounds || fallbackTextBounds;
    const outer = unionRects([...(coverSegments || []), textBounds].filter(Boolean));
    if (!outer || !(outer.width > 0 && outer.height > 0) || !textBounds) return null;
    const frame = polygonFrame || {
      centerX: textBounds.left + textBounds.width / 2,
      centerY: textBounds.top + textBounds.height / 2,
      width: textBounds.width,
      height: textBounds.height
    };
    const scaleValues = textSegments.map(segment => Number(segment.scaleY)).filter(value => value > 0)
      .sort((left, right) => left - right);
    const scaleY = scaleValues.length ? scaleValues[Math.floor(scaleValues.length / 2)] : 1;
    // font_height_percent 的分母是"单条捕获带"的图片高(baidu-results 按页 OCR 输入图算),
    // 原文字高必须用文本所在那条带的屏高(drawRect.h × scaleY)还原;
    // 用 canvasHeight(上下两条带拼接)或 frame 并集高都会把原文字高放大近一倍。
    const bandScreenHeight = Math.max(0, ...textSegments.map(segment => {
      const surfaceSegment = (Array.isArray(surface && surface.segments) ? surface.segments : [])
        .find(item => String(item && item.pageId || "") === segment.pageId);
      const draw = runtime.normalizeSeamRect(surfaceSegment && surfaceSegment.drawRect);
      return draw.h > 0 ? draw.h * Number(segment.scaleY || 0) : 0;
    }));
    return {
      outer: {
        left: Math.max(0, outer.left),
        top: Math.max(0, outer.top),
        width: outer.width,
        height: outer.height
      },
      textFrame: {
        centerX: frame.centerX - outer.left,
        centerY: frame.centerY - outer.top,
        width: frame.width,
        height: frame.height,
        sourceImageHeight: bandScreenHeight > 0 ? bandScreenHeight : Number(surface.canvasHeight) * scaleY
      },
      coverSegments: coverSegments.map(segment => ({
        ...segment,
        left: segment.left - outer.left,
        top: segment.top - outer.top
      }))
    };
  }
  runtime.buildCrossPageBubbleGeometry = buildCrossPageBubbleGeometry;
}
