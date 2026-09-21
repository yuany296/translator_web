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

/** 四边形首边的倾角（度，折到 ±90°）：早期「polygon 兜底」口径，保留给探针/回归对照。 */
export function polygonEdgeRotationDeg(points) {
  const normalized = normalizePoints(points, 4);
  if (!normalized) return 0;
  const [first, second] = normalized;
  let deg = Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI;
  while (deg >= 90) deg -= 180;
  while (deg < -90) deg += 180;
  return deg;
}

const LONG_EDGE_MIN_ASPECT = 1.2;

/**
 * 四边形倾角（度，折到 ±90°）：先看这个四边形到底歪没歪，歪了再取**最长边**
 * 作为文字行方向；与顶点起点/绕向无关。
 *
 * 首边口径在两个方向上都会错：OCR 集群合并框从短边起笔时会报出 ≈±90°（水平文字
 * 被竖过来），而「文字框轴对齐、只有区域轮廓倾斜」的气泡又会退回 0°（用户现场：
 * 覆盖层没有跟着斜排原文倾斜）。
 *
 * 轴对齐框（倾斜量 ≤ 0.5°）一律返回 0：一个正正方方的框不管哪条边长，都没有倾角
 * 可恢复，否则高而窄的多行外框会被误读成 90°。确实歪了的四边形里，长边就是文字
 * 行方向；近正方形（长短边比 < 1.2）判断不出行方向，取更接近水平的那条边。
 *
 * scaleX/scaleY 把百分比坐标换算成像素比例：同一族倾斜在不同长宽比的图上角度不同。
 */
export function polygonRotationDeg(points, scaleX = 1, scaleY = 1) {
  const normalized = normalizePoints(points, 4);
  if (!normalized) return 0;
  if (polygonTiltDeg(normalized) <= COVER_TILT_TOLERANCE_DEG) return 0;
  const sx = Number.isFinite(Number(scaleX)) && Number(scaleX) > 0 ? Number(scaleX) : 1;
  const sy = Number.isFinite(Number(scaleY)) && Number(scaleY) > 0 ? Number(scaleY) : 1;
  const edges = normalized.map((current, index) => {
    const next = normalized[(index + 1) % normalized.length];
    const dx = (next.x - current.x) * sx;
    const dy = (next.y - current.y) * sy;
    let deg = Math.atan2(dy, dx) * 180 / Math.PI;
    while (deg >= 90) deg -= 180;
    while (deg < -90) deg += 180;
    return { length: Math.hypot(dx, dy), deg };
  }).filter(edge => edge.length > 0);
  if (edges.length === 0) return 0;
  let longest = edges[0];
  let shortest = edges[0];
  for (const edge of edges) {
    if (edge.length > longest.length) longest = edge;
    if (edge.length < shortest.length) shortest = edge;
  }
  if (longest.length >= shortest.length * LONG_EDGE_MIN_ASPECT) return longest.deg;
  return edges.reduce((best, edge) => Math.abs(edge.deg) < Math.abs(best.deg) ? edge : best, edges[0]).deg;
}

/**
 * 倾角取证：显式 rotationDeg 优先（0/非有限值当作「没有明确信息」），
 * 否则在一串候选四边形里「哪个真的倾斜就用哪个」。
 *
 * 四条渲染路径（DOM 文字节点、遮罩四边形、场景文字层、嵌入式画布）共用这一个口径，
 * 避免出现「文字倾斜、遮罩水平」这类各路径各自解释倾角的组合。
 */
export function resolveTiltRotationDeg(rotationDeg, polygons = [], scaleX = 1, scaleY = 1) {
  const explicit = Number(rotationDeg);
  if (Number.isFinite(explicit) && Math.abs(explicit) > COVER_TILT_TOLERANCE_DEG) return explicit;
  for (const polygon of Array.isArray(polygons) ? polygons : []) {
    const angle = polygonRotationDeg(polygon, scaleX, scaleY);
    if (Math.abs(angle) > COVER_TILT_TOLERANCE_DEG) return angle;
  }
  return 0;
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
 * 遮罩四边形：斜排文字必须落在遮罩里，而且**只覆盖识别到的文字框**。
 *
 * - polygon 本身倾斜 → 直接用它（外扩后）：它才是识别出来的文字框，
 *   遮罩贴着字形，不会糊住周围画面；
 * - polygon 是轴对齐框但 OCR 给了 rotation_deg（「遮罩保持水平」的现场）→ 按倾角旋转外接框；
 * - 两者都没有 → 轴对齐蓝框。
 *
 * 注意：**不能拿 rotation_deg 和 polygon 的夹角「比对是否一致」**。rotation_deg 来自
 * OCR 的像素坐标，polygon 存的是百分比，同一段斜排文字在两套坐标里读出的角度本来
 * 就不同（页面长宽比 720:947 时，35° 与 28° 是同一个倾角）。早期按数值比对会误判成
 * 「冲突」，进而退回「旋转整个外接框」——那会把遮罩撑成外接框的包围盒（实测 362×278
 * 的文字框变成 443×532 的遮罩），用户看到的就是「覆盖层太大」。
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
  const polygonTilted = Boolean(polygonPoints) && polygonTiltDeg(polygonPoints) > COVER_TILT_TOLERANCE_DEG;
  if (polygonPoints && rotationTilted && !polygonTilted) {
    // 文字框本身是轴对齐的，只有 OCR 的 rotation_deg 说它歪：按倾角旋转这个框。
    quad = rotateBoxQuad(polygonBox, rotation, scale);
  } else if (polygonPoints) {
    // 识别到的文字框就是斜的 → 遮罩就是它（外扩一点点），不再放大成外接框。
    quad = inflatePolygonAboutCenter(polygonPoints, scale);
    tilted = rotationTilted || polygonTilted;
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
