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

  /** 实底遮罩的颜色必须来自采样：没有就返回 ""，由调用方保持透明（不兜底纯白）。 */
  function solidCoverColor(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (typeof runtime.normalizeCssColor === "function") return runtime.normalizeCssColor(raw, "");
    return /^#[0-9a-f]{6}$/iu.test(raw) ? raw : "";
  }
  runtime.solidCoverColor = solidCoverColor;

  /**
   * 斜排文字的跨页遮罩：把拼接图坐标下的遮罩四边形映射到覆盖层局部像素，
   * 与当前页节点矩形求交后作为 clip-path。节点矩形与背景补丁映射保持不变，
   * 所以清理图仍然对齐，只是可见范围跟着原文字形倾斜。
   *
   * **裁剪只服务「斜排原文」**：轴对齐文字的覆盖区域本来就等于这一页 OCR 给的
   * 字框/填充框，再拿一个更小的四边形去裁只会砍掉同一气泡的其它行 ——
   * 现场：接缝复合图只读到气泡的第一行（其余行落在接缝带之外），页级 OCR 读到两行，
   * 于是 `page_cover_boxes` 是两行的并集、而 `bubble.polygon` 只有第一行；
   * 按它裁完就变成"上面一行有遮罩、下面一行没有"。
   *
   * **坐标系必须统一**：`mapCompositePointToRoot` 返回的是 root 坐标，而调用方传进来的
   * `rect` 是覆盖层局部坐标（`node.style.left/top` 相对 `.mt-cross-page-overlay`），
   * 两者相差覆盖层在 root 里的原点。少了 context.offsetX/offsetY 这一步平移，
   * 映射点与节点矩形永远不相交，斜排跨页遮罩的 clip-path 从来没真正生效过。
   */
  function applyCoverSegmentTilt(entry, item, geometry, node, context, rect) {
    const quad = Array.isArray(geometry.coverQuad) && geometry.coverQuad.length >= 3 ? geometry.coverQuad : null;
    if (!quad || !geometry.coverTilted) {
      node.style.removeProperty("clip-path");
      node.dataset.coverTilted = "false";
      return false;
    }
    const { targetRects, rootRect, offsetX = 0, offsetY = 0 } = context;
    if (!targetRects || !rootRect) {
      node.dataset.coverTilted = "false";
      return false;
    }
    const mapPoint = runtime.mapCompositePointToRoot;
    if (typeof mapPoint !== "function") {
      // 缺少坐标映射时退回不倾斜的整块遮罩：宁可没有 clip-path，
      // 也不能让跨页渲染在这里抛错（曾经因为没挂到 runtime 而整页不渲染）。
      node.style.removeProperty("clip-path");
      node.dataset.coverTilted = "unsupported";
      return false;
    }
    const shiftX = Number(offsetX) || 0;
    const shiftY = Number(offsetY) || 0;
    const points = quad.map(point => mapPoint.call(runtime, entry.surface, {
      x: Number(point.x) / 100 * entry.surface.canvasWidth,
      y: Number(point.y) / 100 * entry.surface.canvasHeight
    }, targetRects, rootRect)).filter(Boolean).map(point => ({
      x: point.x - shiftX,
      y: point.y - shiftY
    }));
    if (points.length < 3) {
      node.style.removeProperty("clip-path");
      node.dataset.coverTilted = "false";
      return false;
    }
    const clipPath = polygonClipPathPercent(clipConvexPolygonToRect(points, rect), rect);
    if (!clipPath) {
      node.style.removeProperty("clip-path");
      node.dataset.coverTilted = "false";
      return false;
    }
    node.style.clipPath = clipPath;
    node.dataset.coverTilted = "true";
    return true;
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
      const rect = { left, top, width: right - left, height: bottom - top, pageId };
      // 覆盖层局部坐标 = root 坐标 − 覆盖层自身原点（见 syncCrossPageSurfaceEntry 写
      // item.overlay.style.left/top 时的 max(0, outer.left/top)）。
      const layerContext = {
        ...context,
        offsetX: Math.max(0, Number(geometry.outer && geometry.outer.left) || 0),
        offsetY: Math.max(0, Number(geometry.outer && geometry.outer.top) || 0)
      };
      const solidColor = bgType === "solid" ? solidCoverColor(item.bubble.bg_color) : "";
      // 实底遮罩：有采样色就**必须**遮住原文，覆盖范围就是这一页自己的遮罩段矩形
      // （`page_cover_boxes` 按页映射，是这一页全部 OCR 证据的并集，不会串到邻页）；
      // 只有"斜排原文"才额外按字形四边形修剪可见范围（见 applyCoverSegmentTilt）。
      // 没有采样色时才保持透明：凭空纯白比不遮更糟（见 .mt-bg-none 的同一条规矩）。
      applyCoverSegmentTilt(entry, item, geometry, node, layerContext, rect);
      if (bgType === "solid") {
        node.style.background = solidColor || "transparent";
        node.style.removeProperty("background-image");
        return;
      }
      // 组内全部在捕获带内时用复合清理图(带内专用、优先于可能过期的整页图);
      // 只要有一段在带外(如相邻行),union 超出带区,就需要整页清理图补齐带外部分。
      const bandSegments = segments.filter(segment => segment.compositeIntersection);
      const compositeImage = entry.surface.cleanedImage;
      const pageImage = entry.surface.cleanedImageByPage?.[pageId];
      // 复合图的原点要按"带内那一段自己的元素位置"还原，而且必须再减去节点自身原点：
      // 段坐标相对 overlay 外框，background-position 相对节点 padding box。节点矩形是
      // 同页所有段（含被吸收相邻行的带外整页段）的并集，带外段可能落在带内段上方/左侧。
      // 少了这一步，纯复合节点（只有 1 层背景）会因为 background-repeat: no-repeat
      // 在节点顶部/左侧留下一段没有像素的空白 —— 原文直接露出来（实测「在画中」下片
      // 顶部 21.672px 无遮罩，另一条接缝左侧 96.912px 无遮罩）。
      const compositeOrigin = (scaleX, scaleY) => {
        const offsets = bandSegments.map(segment => ({
          x: Number(segment.left || 0) - left - Number(segment.compositeIntersection.left || 0) * scaleX,
          y: Number(segment.top || 0) - top - Number(segment.compositeIntersection.top || 0) * scaleY
        }));
        return {
          x: Math.min(...offsets.map(offset => offset.x)),
          y: Math.min(...offsets.map(offset => offset.y))
        };
      };
      const pagePlacement = () => {
        const pageSegment = segments.find(segment => segment.mapping === "page") || segments[0];
        return {
          size: `${pageSegment.pageWidth}px ${pageSegment.pageHeight}px`,
          position:
            `${-Math.min(...segments.map(segment => segment.sourceLeft ?? 0))}px ` +
            `${-Math.min(...segments.map(segment => segment.sourceTop ?? 0))}px`
        };
      };
      if (bandSegments.length === segments.length && compositeImage && bandSegments.length > 0) {
        const scaleX = bandSegments[0].scaleX;
        const scaleY = bandSegments[0].scaleY;
        const origin = compositeOrigin(scaleX, scaleY);
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${compositeImage}")`;
        node.style.backgroundSize =
          `${entry.surface.canvasWidth * scaleX}px ${entry.surface.canvasHeight * scaleY}px`;
        node.style.backgroundPosition = `${origin.x}px ${origin.y}px`;
        return;
      }
      if (bandSegments.length > 0 && compositeImage && pageImage) {
        // 混合：带内用复合清理图，带外用整页清理图。
        // 之前这里直接退回整页图，而整页图在带内根本没被清理（清理计划认为带内由复合图
        // 负责），接缝处于是残留一条原文（实测 662 像素残留）。CSS 多背景第一层在最上，
        // 正好让复合图压住整页图，两层各管一段。
        const scaleX = bandSegments[0].scaleX;
        const scaleY = bandSegments[0].scaleY;
        const origin = compositeOrigin(scaleX, scaleY);
        const page = pagePlacement();
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${compositeImage}"), url("${pageImage}")`;
        node.style.backgroundSize =
          `${entry.surface.canvasWidth * scaleX}px ${entry.surface.canvasHeight * scaleY}px, ${page.size}`;
        node.style.backgroundPosition =
          `${origin.x}px ${origin.y}px, ${page.position}`;
        return;
      }
      if (pageImage) {
        const page = pagePlacement();
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${pageImage}")`;
        node.style.backgroundSize = page.size;
        node.style.backgroundPosition = page.position;
        return;
      }
      // 复杂背景没有可映射的清理图时保持透明，避免用白色矩形破坏原图。
      node.style.background = "transparent";
      node.style.removeProperty("background-image");
    });
  }
  runtime.updateCoverSegments = updateCoverSegments;
}
