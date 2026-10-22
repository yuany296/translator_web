/**
 * 遮罩几何：原文斜排时遮罩必须跟着倾角走，不能停留在轴对齐矩形。
 *
 * 坐标单位由调用方决定（页面百分比或像素），本模块只做纯数学；
 * DOM 覆盖层、Kakao 跨页遮罩、嵌入式 canvas 合成共用同一套推导，
 * 避免三条渲染路径各自解释倾角而产生不一致的覆盖范围。
 */

export const COVER_TILT_TOLERANCE_DEG = 0.5;
/**
 * 「OCR 的 rotation_deg 是不是真在说这块文字歪了」的**旋转噪声地板**。
 *
 * 与 COVER_TILT_TOLERANCE_DEG 分工不同：那个判定的是**四边形本身**是否轴对齐，
 * 这个判定的是 rotation_deg 这条独立证据值不值得相信。现场（Lezhin 跨页气泡）：
 * rotation_deg = -0.6° 是纯粹的识别噪声（0.6° 在 122px 高的框上只挪动约 1px），
 * 却让 `rotationTilted` 成立 → 跨页遮罩被按字形四边形裁剪，上页那一段只留下
 * 56.8% 以下的一条横带，气泡第一行原文直接露在译文下面。真正的斜排 SFX 远大于
 * 这个角度（夹具实测 12°/20°/35°），所以地板取 2°：低于它一律按轴对齐处理
 * （不旋转、不裁剪）。
 */
export const COVER_ROTATION_NOISE_DEG = 2;
export const COVER_PADDING_MAX = 1.2;
export const COVER_PADDING_BASE = 0.05;

function clampPadding(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(COVER_PADDING_MAX, Math.max(0, numeric));
}

/** 百分比坐标 → 物理（像素）比例：只比值的相对大小有意义，非有限/非正值当「没有信息」记 1。 */
function positiveScale(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
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

/**
 * 实底（solid）遮罩的轮廓：容器轮廓（region_polygon）优先，其次才是文字四边形（polygon）。
 *
 * 实底填充**必须**有轮廓才能裁剪：只拿 x/y/w/h 边界框填色就是一块轴对齐矩形，
 * 会从弧形气泡边缘长出白边（跨页气泡最明显 —— 背景轮廓越过分页线、文字像素全在
 * 下一页时，这一侧的几何只剩一个矩形）。三条渲染路径（逐页 DOM 覆盖层、跨页遮罩段、
 * 清理图计划）共用这一个取证口径，避免各自解释"什么算轮廓"。
 *
 * 拿不到轮廓时返回 null，调用方必须保持透明，不得退回包围盒。
 */
export function resolveSolidFillOutline(source) {
  if (!source || typeof source !== "object") return null;
  for (const candidate of [source.region_polygon, source.regionPolygon, source.polygon]) {
    const points = normalizePoints(candidate, 3);
    if (points) return points;
  }
  return null;
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
 * 轴对齐框（换算到同一物理空间后倾斜量 ≤ 0.5°）一律返回 0：一个正正方方的框不管哪条
 * 边长，都没有倾角可恢复，否则高而窄的多行外框会被误读成 90°。确实歪了的四边形里，
 * 长边就是文字行方向；近正方形（长短边比 < 1.2）判断不出行方向，取更接近水平的那条边。
 *
 * scaleX/scaleY 把百分比坐标换算成像素比例：同一族倾斜在不同长宽比的图上角度不同。
 * 「歪没歪」的门槛与最长边角度用同一组比例（见 polygonTiltDeg 的放大教训）。
 */
export function polygonRotationDeg(points, scaleX = 1, scaleY = 1) {
  const normalized = normalizePoints(points, 4);
  if (!normalized) return 0;
  const sx = positiveScale(scaleX);
  const sy = positiveScale(scaleY);
  if (polygonTiltDeg(normalized, sx, sy) <= COVER_TILT_TOLERANCE_DEG) return 0;
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

/**
 * 渲染倾角的几何自洽检查。
 *
 * 接近 ±90° 的倾角语义是「文字沿竖直方向排列」，而旋转 90° 会把宽高互换：
 * 这种文字的包围盒**必然高大于宽**。若实际文字框明显更宽，这个角度只可能来自
 * 判断失误的框——OCR 把高而窄的多行横排框当成竖排（`polygon_rotation_deg` 对
 * 高框直接返回 ±90°）、或者跨分片接缝里被切开的碎片框。照它旋转就会把整块横排
 * 译文转 90°，用户看到的正是「原图明明是横排，译文却变成竖排」。
 *
 * 因此：|倾角| ≥ 60° 且文字框更宽 → 该倾角不可信，按水平渲染。
 * 真正的竖排（框高大于宽）与斜排 SFX（|倾角| < 60°）完全不受影响。
 */
export const RENDER_ROTATION_VERTICAL_MIN_DEG = 60;

/**
 * 竖排时 writing-mode 只负责「字列方向」，OCR 的 ±90° 里还夹着几度真实倾斜
 * （现场韩文竖列 -86° = 竖直方向再歪 4°）。把 90° 剥掉，只保留这部分残余倾角，
 * 否则竖排会被强行扶正，和倾斜的原文字列对不上。
 */
export function verticalRenderRotationDeg(rotation) {
  const angle = Number(rotation) || 0;
  if (Math.abs(angle) < 45) return 0;
  return angle > 0 ? angle - 90 : angle + 90;
}

export function sanitizeRenderRotationDeg(rotation, boxWidth = 0, boxHeight = 0) {
  const angle = Number(rotation) || 0;
  if (Math.abs(angle) < RENDER_ROTATION_VERTICAL_MIN_DEG) return angle;
  const width = Number(boxWidth) || 0;
  const height = Number(boxHeight) || 0;
  if (!(width > 0 && height > 0)) return angle;
  return width > height ? 0 : angle;
}

/**
 * 覆盖层盒子的屏幕尺寸 + 渲染倾角（竖排的唯一判据处，与上面的自洽检查同一份口径）。
 *
 * 竖排（`mt-jp-vertical`）拿到的 widthAxis/heightAxis 是沿**文字轴**量的
 * （像素来自 polygon 的四点，见 content 侧 getOverlayPolygonGeometry；百分比那份在
 * 创建期靠 rotate(±90°) 摆正）：宽 = 字列长度、高 = 字列厚度 —— 横竖与屏幕上正好互换。
 * 不换回来，104px 长的字列会被塞进 30px 高的盒子，`writing-mode: vertical-rl` 只能排出
 * 2~3 字一列的碎列并溢出到相邻分格（现场症状「译文超出格子 / 横竖颠倒」）。换回屏幕轴
 * 之后朝向由 writing-mode 承担，就**不能**再叠一次 ±90° 旋转，否则文字会被转回横排。
 * 横排（含斜排 SFX）走原路径，行为逐字不变。
 */
export function resolveBubbleScreenBox({ widthAxis = 0, heightAxis = 0, declaredRotation = 0, verticalWriting = false } = {}) {
  const width = verticalWriting ? Number(heightAxis) || 0 : Number(widthAxis) || 0;
  const height = verticalWriting ? Number(widthAxis) || 0 : Number(heightAxis) || 0;
  return {
    width,
    height,
    rotation: verticalWriting ? verticalRenderRotationDeg(declaredRotation) : sanitizeRenderRotationDeg(declaredRotation, width, height)
  };
}

/**
 * 四边形相对坐标轴的倾斜角（折到 ±45°）：轴对齐矩形返回 0。
 *
 * **倾斜必须在各向同性的空间里量**：percent 坐标的 x/y 两轴各单位长度不同（跨页拼接图
 * 1280×192 相差 6.7 倍），同一个"横边的像素级微倾"在 percent 空间会被放大成 6.7 倍
 * （反之竖边被压缩）。现场（Lezhin 53 话跨页气泡）：OCR 给出的文字框在像素空间只歪
 * 0.2°（服务端 `rotation_deg=-0.2`），percent 空间读成 1.36°，越过 0.5° 阈值 →
 * 整个气泡被当成斜排 SFX、跨页遮罩按"接缝带里那一行"的四边形裁到只剩顶部 ~18%
 * （用户症状「下面那页只有一部分背景」）。scaleX/scaleY 传坐标空间的长宽（或任意等比
 * 因子），不传（=1/1）时保持旧口径。
 */
export function polygonTiltDeg(points, scaleX = 1, scaleY = 1) {
  const normalized = normalizePoints(points, 4);
  if (!normalized) return 0;
  const sx = positiveScale(scaleX);
  const sy = positiveScale(scaleY);
  return normalized.reduce((max, point, index) => {
    const next = normalized[(index + 1) % normalized.length];
    const dx = (next.x - point.x) * sx;
    const dy = (next.y - point.y) * sy;
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
 *
 * scaleX/scaleY 是 polygon 百分比空间的长宽（见 polygonTiltDeg）：判定「这个四边形
 * 歪没歪」必须带上它，否则各向异性的 percent 空间会把亚度级像素微倾放大成"斜排"。
 */
export function resolveCoverQuad({ polygon, rotationDeg = 0, box, padding = 0, scaleX = 1, scaleY = 1 } = {}) {
  const scale = coverScale(padding);
  const rotation = Number(rotationDeg) || 0;
  // |rotation| ≥ RENDER_ROTATION_VERTICAL_MIN_DEG 的语义是**竖排（文字沿竖直方向排列）**，
  // 不是「歪了」：服务端的 polygon_rotation_deg 对高而窄的框一律给 ±90°（竖排日文台词的
  // 每一列都是这种框），而文字四边形本身是轴对齐的 —— 它就是那一列的准确范围。
  // 这种角度下**必须按四边形走**：照它旋转外接框会把 96×225 的竖列转成 225×96 的横条，
  // 清理图于是擦掉横跨页面的一条、真正的竖排原文只被擦掉一小截（现场症状
  // 「清理图只覆盖了一部分、日文还露着」）。阈值与 sanitizeRenderRotationDeg 同一常量。
  const rotationTilted = Math.abs(rotation) > COVER_ROTATION_NOISE_DEG
    && Math.abs(rotation) < RENDER_ROTATION_VERTICAL_MIN_DEG;
  const polygonPoints = normalizePoints(polygon, 4);
  const polygonBox = polygonPoints && boundsOfPoints(polygonPoints);
  const normalizedBox = normalizeBox(box) || polygonBox;
  if (!polygonPoints && !normalizedBox) return null;
  let quad = null;
  let tilted = rotationTilted;
  const polygonTilted = Boolean(polygonPoints) && polygonTiltDeg(polygonPoints, scaleX, scaleY) > COVER_TILT_TOLERANCE_DEG;
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

/**
 * 多边形 → 相对 bounds 的 clip-path 百分比；退化时返回空串（调用方保留兜底遮罩）。
 *
 * **顶点不能被截断**：`clipConvexPolygonToRect` 的结果最多有 8 个顶点（四边形与矩形的
 * 交集），按「四边形」切到前 4 个会把不相邻的顶点连成一条并不存在的边 ——
 * 现场（KakaoPage 跨页气泡）：交集明明有 87% 面积，画出来只剩 14% 的楔形，
 * 原文整段露在译文下面。Sutherland–Hodgman 的输出是沿边界连续的，原样写进
 * `polygon()` 即可。
 */
export function polygonClipPathPercent(points, bounds) {
  const list = Array.isArray(points) ? points : [];
  const box = normalizeBox(bounds);
  if (list.length < 3 || !box) return "";
  const values = list.map(point => {
    const x = (Number(point && point.x) - box.x) / box.w * 100;
    const y = (Number(point && point.y) - box.y) / box.h * 100;
    return Number.isFinite(x) && Number.isFinite(y) ? `${x.toFixed(2)}% ${y.toFixed(2)}%` : "";
  });
  return values.every(Boolean) ? `polygon(${values.join(", ")})` : "";
}
