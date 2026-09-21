import { resolveCoverQuad, resolveTiltRotationDeg } from "../../rendering/cover-geometry.js";

// 斜排清理：0.5° 以下肉眼看不出倾斜，仍按轴对齐蓝框处理（与遮罩几何同一阈值）。
const CLEAN_MASK_TILT_TOLERANCE_DEG = 0.5;
// 斜排清理多边形比遮罩略胀一点（1%），盖住抗锯齿边缘，避免擦不干净留下笔画。
const CLEAN_MASK_PADDING = 0.2;

/**
 * 清理图（cleaned image）的遮罩几何。
 *
 * 清理图是嵌入式渲染（小说正文图片）的底图，「被擦掉的那块」就是用户眼里的覆盖层。
 * 这里与渲染侧共用 `resolveCoverQuad`：擦掉的范围和画上去的遮罩永远是同一个四边形，
 * 斜排原文不会被遗留成一块水平的补丁。
 */
export function installCleanMasks(runtime) {
  function projectionsRequireCleanedImage(projections) {
    return (Array.isArray(projections) ? projections : []).some(runtime.projectionRequiresCleanedImage);
  }
  runtime.projectionsRequireCleanedImage = projectionsRequireCleanedImage;

  function projectionRequiresCleanedImage(projection) {
    if (!projection || projection.active === false) return false;
    const role = String(projection.role || "");
    const cover = role === "cover" || role === "cover_only" || projection.coverOnly === true;
    if (!cover && projection.activeText !== true) return false;
    const bgType = String(projection.visual && (projection.visual.bgType || projection.visual.bg_type) || projection.bubble && (projection.bubble.bg_type || projection.bubble.bgType) || projection.bgType || projection.bg_type || "").trim().toLowerCase();
    return bgType === "none";
  }
  runtime.projectionRequiresCleanedImage = projectionRequiresCleanedImage;

  function quantizeCleanMaskNumber(value) {
    return Math.round(runtime.clamp(Number(value) || 0, 0, 100) * 100) / 100;
  }
  runtime.quantizeCleanMaskNumber = quantizeCleanMaskNumber;

  function normalizeCanonicalCleanMaskGeometry(geometry) {
    const inputs = Array.isArray(geometry) ? geometry : [geometry];
    const bounds = [];
    for (const input of inputs) {
      if (!input || typeof input !== "object") continue;
      const box = input.box || input.geometry || input;
      const x = Number(box && (box.x ?? box.left));
      const y = Number(box && (box.y ?? box.top));
      const w = Number(box && (box.w ?? box.width));
      const h = Number(box && (box.h ?? box.height));
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
        bounds.push({
          left: x,
          top: y,
          right: x + w,
          bottom: y + h
        });
        continue;
      }
      const points = (Array.isArray(input.polygon) ? input.polygon : []).map(point => ({
        x: Number(Array.isArray(point) ? point[0] : point && point.x),
        y: Number(Array.isArray(point) ? point[1] : point && point.y)
      })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length >= 3) {
        bounds.push({
          left: Math.min(...points.map(point => point.x)),
          top: Math.min(...points.map(point => point.y)),
          right: Math.max(...points.map(point => point.x)),
          bottom: Math.max(...points.map(point => point.y))
        });
      }
    }
    if (!bounds.length) return null;
    const left = runtime.quantizeCleanMaskNumber(Math.min(...bounds.map(box => box.left)));
    const top = runtime.quantizeCleanMaskNumber(Math.min(...bounds.map(box => box.top)));
    const right = runtime.quantizeCleanMaskNumber(Math.max(...bounds.map(box => box.right)));
    const bottom = runtime.quantizeCleanMaskNumber(Math.max(...bounds.map(box => box.bottom)));
    if (right <= left || bottom <= top) return null;
    return {
      coordinateSpace: "percent",
      box: {
        x: left,
        y: top,
        w: runtime.quantizeCleanMaskNumber(right - left),
        h: runtime.quantizeCleanMaskNumber(bottom - top)
      }
    };
  }
  runtime.normalizeCanonicalCleanMaskGeometry = normalizeCanonicalCleanMaskGeometry;

  /** 投影的倾斜角：显式 rotation_deg/rotationDeg 优先，其余在文字/区域多边形里取真正歪的那一个。 */
  function projectionCleanMaskTiltDeg(projection) {
    const visual = projection && typeof projection.visual === "object" ? projection.visual : {};
    const bubble = projection && typeof projection.bubble === "object" ? projection.bubble : {};
    const explicit = Number(
      visual.rotation_deg ?? visual.rotationDeg ?? bubble.rotation_deg ?? bubble.rotationDeg
    );
    const polygons = [
      visual.polygon, bubble.polygon,
      visual.regionPolygon, visual.region_polygon, bubble.region_polygon, bubble.regionPolygon
    ].filter(Boolean);
    return resolveTiltRotationDeg(explicit, polygons);
  }
  runtime.projectionCleanMaskTiltDeg = projectionCleanMaskTiltDeg;

  /**
   * 斜排文字的清理范围必须跟着倾角走。
   *
   * 按轴对齐蓝框清理，斜排原文会在插画上留下一块水平补丁，而译文却是斜的
   * （用户缺陷：覆盖层没有根据倾斜的文本进行倾斜）。这里复用渲染侧的遮罩几何
   * `resolveCoverQuad`，让「擦掉的范围」与「画上去的遮罩」永远是同一个四边形。
   */
  function buildTiltedCleanMask(projection, box) {
    const tilt = projectionCleanMaskTiltDeg(projection);
    if (Math.abs(tilt) <= CLEAN_MASK_TILT_TOLERANCE_DEG) return null;
    const visual = projection && typeof projection.visual === "object" ? projection.visual : {};
    const bubble = projection && typeof projection.bubble === "object" ? projection.bubble : {};
    const cover = resolveCoverQuad({
      polygon: visual.polygon || bubble.polygon || visual.regionPolygon || visual.region_polygon || null,
      rotationDeg: tilt,
      box,
      padding: CLEAN_MASK_PADDING
    });
    const quad = cover && Array.isArray(cover.quad) ? cover.quad : null;
    if (!quad || quad.length < 3) return null;
    return {
      coordinateSpace: "percent",
      polygon: quad.map(point => ({
        x: runtime.quantizeCleanMaskNumber(point.x),
        y: runtime.quantizeCleanMaskNumber(point.y)
      }))
    };
  }
  runtime.buildTiltedCleanMask = buildTiltedCleanMask;

  function buildCanonicalCleanMasks(projections) {
    const byKey = new Map();
    for (const projection of Array.isArray(projections) ? projections : []) {
      const canonicalId = String(projection && projection.canonicalId || "");
      if (!canonicalId || !runtime.projectionRequiresCleanedImage(projection)) continue;
      // 原始红框只覆盖 OCR 字形，容易残留笔画；清理范围统一采用最终渲染蓝框。
      // 文字排版仍使用 placement，清理几何不会放大译文布局。
      const mask = runtime.normalizeCanonicalCleanMaskGeometry(projection.geometry || projection.box);
      if (!mask) continue;
      // 斜排投影改发倾斜四边形：轴对齐矩形会在清理图上留下水平的补丁。
      const resolved = runtime.buildTiltedCleanMask(projection, mask.box) || mask;
      byKey.set(JSON.stringify(resolved), resolved);
    }
    return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, mask]) => mask);
  }
  runtime.buildCanonicalCleanMasks = buildCanonicalCleanMasks;

  function buildCleanedMaskFingerprint(masks) {
    const text = JSON.stringify(Array.isArray(masks) ? masks : []);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  runtime.buildCleanedMaskFingerprint = buildCleanedMaskFingerprint;
}
