import { clipConvexPolygonToRect, polygonClipPathPercent } from "../../rendering/cover-geometry.js";

export function installCrossPageCover(runtime) {
  function createCoverSegmentNode(item, pageId) {
    const node = document.createElement("div");
    node.className = "mt-cover-segment";
    node.dataset.mangaTranslatorOverlay = "true";
    node.dataset.pageId = pageId;
    item.coverLayer.appendChild(node);
    item.coverNodes.set(pageId, node);
    return node;
  }
  runtime.createCoverSegmentNode = createCoverSegmentNode;

  /**
   * 斜排文字的跨页遮罩：把拼接图坐标下的遮罩四边形映射到 root 像素，
   * 与当前页节点矩形求交后作为 clip-path。节点矩形与背景补丁映射保持不变，
   * 所以清理图仍然对齐，只是可见范围跟着原文字形倾斜。
   */
  function applyCoverSegmentTilt(entry, item, geometry, node, context, rect) {
    if (!geometry.coverTilted || !Array.isArray(geometry.coverQuad)) {
      node.style.removeProperty("clip-path");
      node.dataset.coverTilted = "false";
      return;
    }
    const { targetRects, rootRect } = context;
    if (!targetRects || !rootRect) {
      node.dataset.coverTilted = "false";
      return;
    }
    const points = geometry.coverQuad.map(point => runtime.mapCompositePointToRoot(entry.surface, {
      x: Number(point.x) / 100 * entry.surface.canvasWidth,
      y: Number(point.y) / 100 * entry.surface.canvasHeight
    }, targetRects, rootRect)).filter(Boolean);
    if (points.length < 3) {
      node.style.removeProperty("clip-path");
      node.dataset.coverTilted = "false";
      return;
    }
    const clipPath = polygonClipPathPercent(clipConvexPolygonToRect(points, rect), rect);
    if (clipPath) node.style.clipPath = clipPath;
    else node.style.removeProperty("clip-path");
    node.dataset.coverTilted = "true";
  }
  runtime.applyCoverSegmentTilt = applyCoverSegmentTilt;

  function updateCoverSegments(entry, item, geometry, context = {}) {
    const activePageIds = new Set(geometry.coverSegments.map(segment => segment.pageId));
    for (const [pageId, node] of item.coverNodes) {
      if (!activePageIds.has(pageId)) {
        node.remove();
        item.coverNodes.delete(pageId);
      }
    }
    const bgType = runtime.normalizeBgType(item.bubble.bg_type);
    // 同一页可能有多段遮罩（如 seam 行 + 捕获带外的相邻行），coverNodes
    // 按 pageId 缓存节点，逐段覆盖会让后一段顶掉前一段导致覆盖残缺；
    // 这里按页合并成一块 union 矩形，每页只设置一次。
    const byPage = new Map();
    geometry.coverSegments.forEach(segment => {
      const list = byPage.get(segment.pageId) || [];
      list.push(segment);
      byPage.set(segment.pageId, list);
    });
    byPage.forEach((segments, pageId) => {
      const node = item.coverNodes.get(pageId) || createCoverSegmentNode(item, pageId);
      const left = Math.min(...segments.map(segment => segment.left));
      const top = Math.min(...segments.map(segment => segment.top));
      const right = Math.max(...segments.map(segment => segment.left + segment.width));
      const bottom = Math.max(...segments.map(segment => segment.top + segment.height));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${right - left}px`;
      node.style.height = `${bottom - top}px`;
      applyCoverSegmentTilt(entry, item, geometry, node, context, {
        left, top, width: right - left, height: bottom - top, pageId
      });
      if (bgType === "solid") {
        node.style.background = String(item.bubble.bg_color || "rgba(255,255,255,0.96)");
        node.style.removeProperty("background-image");
        return;
      }
      // 组内全部在捕获带内时用复合清理图(带内专用、优先于可能过期的整页图);
      // 只要有一段在带外(如相邻行),union 超出带区,必须用整页清理图才能全覆盖。
      const bandSegments = segments.filter(segment => segment.compositeIntersection);
      if (bandSegments.length === segments.length && entry.surface.cleanedImage && bandSegments.length > 0) {
        const scaleX = bandSegments[0].scaleX;
        const scaleY = bandSegments[0].scaleY;
        const unionComposite = {
          left: Math.min(...bandSegments.map(segment => segment.compositeIntersection.left)),
          top: Math.min(...bandSegments.map(segment => segment.compositeIntersection.top)),
          right: Math.max(...bandSegments.map(segment =>
            segment.compositeIntersection.left + segment.compositeIntersection.width)),
          bottom: Math.max(...bandSegments.map(segment =>
            segment.compositeIntersection.top + segment.compositeIntersection.height))
        };
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${entry.surface.cleanedImage}")`;
        node.style.backgroundSize =
          `${entry.surface.canvasWidth * scaleX}px ${entry.surface.canvasHeight * scaleY}px`;
        node.style.backgroundPosition =
          `${-unionComposite.left * scaleX}px ${-unionComposite.top * scaleY}px`;
        return;
      }
      const pageImage = entry.surface.cleanedImageByPage?.[pageId];
      if (pageImage) {
        const pageSegment = segments.find(segment => segment.mapping === "page") || segments[0];
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${pageImage}")`;
        node.style.backgroundSize = `${pageSegment.pageWidth}px ${pageSegment.pageHeight}px`;
        node.style.backgroundPosition =
          `${-Math.min(...segments.map(segment => segment.sourceLeft ?? 0))}px ` +
          `${-Math.min(...segments.map(segment => segment.sourceTop ?? 0))}px`;
        return;
      }
      // 复杂背景没有可映射的清理图时保持透明，避免用白色矩形破坏原图。
      node.style.background = "transparent";
      node.style.removeProperty("background-image");
    });
  }
  runtime.updateCoverSegments = updateCoverSegments;
}
