/**
 * 遮罩几何：原文斜排时遮罩必须跟着倾角走，不能停留在轴对齐矩形。
 *
 * 坐标单位由调用方决定（页面百分比或像素），本模块只做纯数学；
 * DOM 覆盖层、Kakao 跨页遮罩、嵌入式 canvas 合成共用同一套推导，
 * 避免三条渲染路径各自解释倾角而产生不一致的覆盖范围。
 */

export const COVER_TILT_TOLERANCE_DEG = 0.5;
export const COVER_PADDING_MAX = 1.2;
export const COVER_PADDING_BASE = 0.05;

function clampPadding(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(COVER_PADDING_MAX, Math.max(0, numeric));
}

/** 「覆盖范围」配置 → 绕中心外扩倍数：0 贴合文字轮廓，1.2 外扩约 6%。 */
export function coverScale(padding, base = COVER_PADDING_BASE) {
  return 1 + base * clampPadding(padding);
}

export function normalizeBox(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const w = Number(value.w ?? value.width);
  const h = Number(value.h ?? value.height);
  if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

export function normalizePoints(points, minimum = 4) {
  if (!Array.isArray(points) || points.length < minimum) return null;
  const normalized = points.slice(0, 4).map(point => ({
    x: Number(point && point.x), y: Number(point && point.y)
  }));
  return normalized.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? normalized : null;
}

export function boundsOfPoints(points) {
  const normalized = normalizePoints(points, 1);
  if (!normalized) return null;
  const xs = normalized.map(point => point.x);
  const ys = normalized.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** 绕外接框中心等比外扩：方向无关，因此对任意四边形都成立。 */
export function inflatePolygonAboutCenter(points, scale) {
  const normalized = normalizePoints(points, 1);
  const bounds = normalized && boundsOfPoints(normalized);
  if (!bounds) return null;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  return normalized.map(point => ({
    x: centerX + (point.x - centerX) * factor,
    y: centerY + (point.y - centerY) * factor
  }));
}

/** 轴对齐框 → 绕自身中心缩放后再旋转的四边形；用于只有 rotation_deg、没有倾斜 polygon 的气泡。 */
export function rotateBoxQuad(box, rotationDeg = 0, scale = 1) {
  const normalized = normalizeBox(box);
  if (!normalized) return null;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const centerX = normalized.x + normalized.w / 2;
  const centerY = normalized.y + normalized.h / 2;
  const halfW = normalized.w / 2 * factor;
  const halfH = normalized.h / 2 * factor;
  const radians = (Number(rotationDeg) || 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([dx, dy]) => ({
    x: centerX + dx * cos - dy * sin,
    y: centerY + dx * sin + dy * cos
  }));
}

/**
 * 四边形首边的倾角（度，折到 ±90°）：与内容层 `resolveBubblePolygonRotation`
 * 的「polygon 兜底」同一语义。OCR/投影只把倾角放进 polygon 而 rotation_deg 缺失
 * 时，纯几何渲染路径（scene builder / 画布遮罩）用它恢复倾角，避免退回轴对齐。
 */
export function polygonEdgeRotationDeg(points) {
  const normalized = normalizePoints(points, 4);
  if (!normalized) return 0;
  const [first, second] = normalized;
  let deg = Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI;
  while (deg >= 90) deg -= 180;
  while (deg < -90) deg += 180;
  return deg;
}

/** 四边形相对坐标轴的倾斜角（折到 ±45°）：轴对齐矩形返回 0。 */
export function polygonTiltDeg(points) {
  const normalized = normalizePoints(points, 4);
  if (!normalized) return 0;
  return normalized.reduce((max, point, index) => {
    const next = normalized[(index + 1) % normalized.length];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    if (!(Math.abs(dx) > 0 || Math.abs(dy) > 0)) return max;
    let deg = Math.atan2(dy, dx) * 180 / Math.PI;
    while (deg >= 90) deg -= 180;
    while (deg < -90) deg += 180;
    deg = Math.abs(deg) <= 45 ? Math.abs(deg) : 90 - Math.abs(deg);
    return Math.max(max, deg);
  }, 0);
}

/**
 * 遮罩四边形：斜排文字必须落在遮罩里。
 *
 * - polygon 本身倾斜 → 直接用它（外扩后），最贴合字形；
 * - polygon 是轴对齐框但 OCR 给了 rotation_deg（历史上正是「遮罩保持水平」的现场）→ 按倾角旋转外接框；
 * - 两者都没有 → 轴对齐蓝框。
 */
export function resolveCoverQuad({ polygon, rotationDeg = 0, box, padding = 0 } = {}) {
  const scale = coverScale(padding);
  const rotation = Number(rotationDeg) || 0;
  const rotationTilted = Math.abs(rotation) > COVER_TILT_TOLERANCE_DEG;
  const polygonPoints = normalizePoints(polygon, 4);
  const polygonBox = polygonPoints && boundsOfPoints(polygonPoints);
  const normalizedBox = normalizeBox(box) || polygonBox;
  if (!polygonPoints && !normalizedBox) return null;
  let quad = null;
  let tilted = rotationTilted;
  if (polygonPoints && rotationTilted && polygonTiltDeg(polygonPoints) <= COVER_TILT_TOLERANCE_DEG) {
    quad = rotateBoxQuad(polygonBox, rotation, scale);
  } else if (polygonPoints) {
    quad = inflatePolygonAboutCenter(polygonPoints, scale);
    tilted = rotationTilted || polygonTiltDeg(polygonPoints) > COVER_TILT_TOLERANCE_DEG;
  } else {
    quad = rotateBoxQuad(normalizedBox, rotation, scale);
  }
  const bounds = boundsOfPoints(quad || []);
  if (!bounds) {
    const fallback = rotateBoxQuad(normalizedBox, rotation, 1);
    const fallbackBounds = boundsOfPoints(fallback || []);
    return fallbackBounds ? { quad: fallback, bounds: fallbackBounds, rotationDeg: rotation, tilted } : null;
  }
  return { quad, bounds, rotationDeg: rotation, tilted };
}

/** Sutherland–Hodgman：把凸四边形裁到矩形内（跨页遮罩按页取交）。 */
export function clipConvexPolygonToRect(points, rect) {
  const normalized = normalizePoints(points, 3);
  const box = normalizeBox(rect);
  if (!normalized || !box) return [];
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const boundaries = [
    { inside: point => point.x >= box.x, intersect: (a, b) => cutVertical(a, b, box.x) },
    { inside: point => point.x <= right, intersect: (a, b) => cutVertical(a, b, right) },
    { inside: point => point.y >= box.y, intersect: (a, b) => cutHorizontal(a, b, box.y) },
    { inside: point => point.y <= bottom, intersect: (a, b) => cutHorizontal(a, b, bottom) }
  ];
  let output = normalized;
  for (const boundary of boundaries) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = boundary.inside(current);
      const previousInside = boundary.inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(boundary.intersect(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(boundary.intersect(previous, current));
      }
    }
    if (output.length === 0) return [];
  }
  return output;
}

function cutVertical(a, b, x) {
  const dx = b.x - a.x;
  const ratio = Math.abs(dx) > Number.EPSILON ? (x - a.x) / dx : 0;
  return { x, y: a.y + (b.y - a.y) * ratio };
}

function cutHorizontal(a, b, y) {
  const dy = b.y - a.y;
  const ratio = Math.abs(dy) > Number.EPSILON ? (y - a.y) / dy : 0;
  return { x: a.x + (b.x - a.x) * ratio, y };
}

/** 四边形 → 相对 bounds 的 clip-path 百分比；退化时返回空串（调用方保留兜底遮罩）。 */
export function polygonClipPathPercent(points, bounds) {
  const normalized = normalizePoints(points, 3);
  const box = normalizeBox(bounds);
  if (!normalized || !box) return "";
  const values = normalized.map(point => {
    const x = (point.x - box.x) / box.w * 100;
    const y = (point.y - box.y) / box.h * 100;
    return Number.isFinite(x) && Number.isFinite(y) ? `${x.toFixed(2)}% ${y.toFixed(2)}%` : "";
  });
  return values.every(Boolean) ? `polygon(${values.join(", ")})` : "";
}
