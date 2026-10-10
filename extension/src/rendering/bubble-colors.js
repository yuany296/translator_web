/**
 * 从原图直接采样气泡外观色（背景 / 墨色 → 文字色 / 描边色）。
 *
 * 与 local-ocr-service/ocr_service/pipeline/appearance_colors.py 同口径：
 * - 背景色 = 文字框外圈边框环的中位数；
 * - 墨色   = 框内与背景色距离 ≥ 42 的像素做 24 级量化，按像素数降序取第一个
 *           与背景对比度 ≥ 2 的桶（桶内均值色算对比度；像素最多的桶可能是白
 *           描边而非笔画）；该桶若是无彩近白（chroma < 20 且 min(r,g,b) ≥ 200
 *           —— 白描边靠对比度或像素数总能当选）且存在色度足、离背景够远、
 *           像素数够的彩色桶，则让位给色度最高者；否则维持该桶；全部不满足
 *           时回退像素数最多者；
 * - 配色   = 墨色与背景对比度 ≥ 4.5、或色度 ≥ 40（彩色字可读性由必渲染的描边
 *           保证）时直接用墨色，否则按对比度在黑/白里选；文字深则白描边、
 *           文字浅则黑描边。
 *
 * 用途：本地 OCR 服务已经采样过；这里是"服务没给颜色"（其它 provider、缓存条目、
 * 合并后的候选）时的兜底，避免渲染层退回写死的黑字白边。
 */

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/iu;
const INK_DISTANCE_THRESHOLD = 42;
// 墨色主色挑选的背景对比度门槛：不足 2 的墨色即使选中也必然被
// chooseReadableTextColors 拒掉（彩色保留线是 2.2），等价于没采到；
// 取 2 略低于 2.2，避免在门槛附近来回抖动。
const INK_BACKGROUND_MIN_CONTRAST = 2;
const READABLE_CONTRAST = 4.5;
// 白描边守卫（与 appearance_colors.py 同口径）：白描边靠对比度或像素数总能当选
// （浅底 ct < 2 被 v2 跳过、深底 ct 15.6 当选、中灰蓝底 ct 4.5 当选而真笔画
// ct 1.0~1.8 被埋），判别尺不能只靠亮度对比度 —— TOP 桶无彩（chroma < 20）且
// 近白（min(r,g,b) ≥ 200）时，在其余桶里找彩色笔画候选：chroma ≥ 40、与背景
// RGB 欧氏距离 ≥ 60（色相不同，亮度可比）、count ≥ max(64, 0.5% × 全部墨色像素)
// 且 count ≥ 4% × TOP.count；找到即让位给色度最高者（并列取像素多者），不比
// 总量（厚描边下彩色合计远小于白桶），否则维持 TOP。
const WHITE_OUTLINE_MAX_CHROMA = 20;
const NEAR_WHITE_MIN_CHANNEL = 200;
const STROKE_GUARD_MIN_BUCKET_COUNT = 64;
const STROKE_GUARD_COLOURED_CHROMA = 40;
const STROKE_GUARD_MIN_BG_DISTANCE = 60;
const STROKE_GUARD_TOTAL_INK_RATIO = 0.005;
const STROKE_GUARD_TOP_COUNT_RATIO = 0.04;
// 「外圈是不是一条均匀的平底色」的容忍距离（RGB 欧氏），与本地服务
// SOLID_BACKGROUND_MAX_DELTA_E_P90 = 20（Lab）同一量级的保守取值。
const BG_RING_UNIFORM_DISTANCE = 24;
// 判成实底需要的环内一致率与最低亮度：亮度门槛沿用服务端 classify_solid_region_type
// 的 bright_background（relative_luminance ≥ 0.72），两边对「亮底」是同一个口径。
const BG_SOLID_MIN_COVERAGE = 0.92;
const BG_SOLID_MIN_LUMINANCE = 0.72;

export function normalizeHexColor(value) {
  const text = String(value || "").trim();
  return HEX_COLOR_RE.test(text) ? text.toLowerCase() : "";
}

export function hexToRgb(value) {
  const hex = normalizeHexColor(value);
  if (!hex) return null;
  return [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

export function relativeLuminance(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return 0;
  const [red, green, blue] = rgb.map(channel => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrastRatio(first, second) {
  const high = Math.max(relativeLuminance(first), relativeLuminance(second));
  const low = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

function rgbToHex(rgb) {
  return `#${rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

export function colorChroma(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return 0;
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * 保留原图墨色的门槛：
 * - 对比度 ≥ 4.5：直接用原墨色（含深色）
 * - 或者是"彩色字"（色度 ≥ 40）：也保留原色，可读性交给白/黑描边保证 ——
 *   否则蓝字会被对比度规则压成黑字白边。（v4）不再要求彩色字对比度 ≥ 2.2：
 *   渐变红字与中灰蓝背景亮度几乎相同（ct 1.0），ct 下限会把真彩字拒成黑字；
 *   彩色墨色的可读性由必渲染的描边保证。灰阶（chroma < 40）路径不变。
 */
export function chooseReadableTextColors(originalInk, background) {
  const ink = normalizeHexColor(originalInk);
  const bg = normalizeHexColor(background) || "#ffffff";
  const inkContrast = ink ? contrastRatio(ink, bg) : 0;
  const keepInk = Boolean(ink) && (inkContrast >= READABLE_CONTRAST ||
    colorChroma(ink) >= 40);
  const textColor = keepInk
    ? ink
    : (contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff");
  return {
    textColor,
    strokeColor: relativeLuminance(textColor) < 0.45 ? "#ffffff" : "#000000"
  };
}

/** 纯黑/纯白是"对比度兜底"而不是采样墨色：复杂背景上要用原图重新推导一次。 */
export function isFallbackTextColor(value) {
  const hex = normalizeHexColor(value);
  return hex === "#000000" || hex === "#ffffff";
}

function normalizePixelBox(value) {
  if (!value || typeof value !== "object") return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![left, top, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) return null;
  return { left, top, width, height };
}

/**
 * 墨色主色挑选：像素数最多的桶可能是**白描边**而不是笔画。
 * 第一层（v2）：浅色背景上白描边与背景对比度不足 2 —— 按像素数降序遍历，取
 * 第一个与背景对比度 ≥ INK_BACKGROUND_MIN_CONTRAST 的桶即可跳过；全部不满足
 * 时回退旧行为：像素数最多者（可能为空 → inkColor 为 ""）。
 * 第二层（v3/v4）白描边守卫：白描边在各种背景上都能靠对比度或像素数当选
 * （RIDI 粉字案：白桶 27.7%、ct 15.6 当选；渐变红字案：白桶 24.5%、ct 4.5
 * 当选，红笔画 ct 1.0~1.8 全被 ct≥2 跳过）—— TOP 无彩近白时按「色度 + 与
 * 背景 RGB 距离 + 像素数」找彩色笔画候选（见 resolveWhiteOutlineSuspicion）。
 */
function pickDominantInkBucket(buckets, background) {
  const backgroundHex = rgbToHex(background);
  const entries = [...buckets.values()]
    .map(bucket => ({ bucket, hex: rgbToHex(bucket.sums.map(sum => sum / bucket.count)) }))
    .sort((left, right) => right.bucket.count - left.bucket.count);
  if (entries.length === 0) return null;
  const top = entries.find(entry =>
    contrastRatio(entry.hex, backgroundHex) >= INK_BACKGROUND_MIN_CONTRAST
  ) || entries[0];
  const totalInk = entries.reduce((sum, entry) => sum + entry.bucket.count, 0);
  return (resolveWhiteOutlineSuspicion(entries, top, backgroundHex, totalInk) || top).bucket;
}

/**
 * 白描边守卫（v4）：TOP 无彩（chroma < WHITE_OUTLINE_MAX_CHROMA）且近白
 * （min(r,g,b) ≥ NEAR_WHITE_MIN_CHANNEL）时，在其余桶里找彩色笔画候选：
 * - chroma ≥ STROKE_GUARD_COLOURED_CHROMA（有彩倾向）；
 * - 与背景 RGB 欧氏距离 ≥ STROKE_GUARD_MIN_BG_DISTANCE（色相不同；亮度对比度
 *   不可靠 —— 红笔画与中灰蓝背景 ct 只有 1.0，不能再用 ct 过滤候选）；
 * - count ≥ max(64, STROKE_GUARD_TOTAL_INK_RATIO × totalInk)（排除噪点小桶）；
 * - count ≥ STROKE_GUARD_TOP_COUNT_RATIO × TOP.count（单桶也要有存在感，
 *   RIDI 红字案 #f30269 占白桶 2.5% 被挡）。
 * 找到任一候选就让位给色度最高者（并列取像素多者）—— 不比总量：厚描边大字
 * 下彩色像素合计（2.5 万）永远比不过白桶（8.1 万）。无候选维持 TOP（蓝字案
 * TOP 已是彩色、黑字白底 TOP 非近白、白实底负例被 4% 门槛挡住，全部零回归）。
 */
function resolveWhiteOutlineSuspicion(entries, top, backgroundHex, totalInk) {
  const topRgb = hexToRgb(top.hex);
  if (!topRgb) return null;
  if (Math.min(...topRgb) < NEAR_WHITE_MIN_CHANNEL) return null;
  if (colorChroma(top.hex) >= WHITE_OUTLINE_MAX_CHROMA) return null;
  const backgroundRgb = hexToRgb(backgroundHex);
  if (!backgroundRgb) return null;
  const minimumByInk = Math.max(STROKE_GUARD_MIN_BUCKET_COUNT, STROKE_GUARD_TOTAL_INK_RATIO * totalInk);
  const minimumByTop = STROKE_GUARD_TOP_COUNT_RATIO * top.bucket.count;
  let best = null;
  entries.forEach(entry => {
    if (entry === top) return;
    if (entry.bucket.count < minimumByInk || entry.bucket.count < minimumByTop) return;
    if (colorChroma(entry.hex) < STROKE_GUARD_COLOURED_CHROMA) return;
    const entryRgb = hexToRgb(entry.hex);
    const entryDistance = entryRgb && Math.hypot(
      entryRgb[0] - backgroundRgb[0],
      entryRgb[1] - backgroundRgb[1],
      entryRgb[2] - backgroundRgb[2]
    );
    if (!entryDistance || entryDistance < STROKE_GUARD_MIN_BG_DISTANCE) return;
    const better = !best || colorChroma(entry.hex) > colorChroma(best.hex) ||
      (colorChroma(entry.hex) === colorChroma(best.hex) && entry.bucket.count > best.bucket.count);
    if (better) best = entry;
  });
  return best;
}

/**
 * 采样一个气泡的背景色与墨色。sample 是 { data, width, height, scale } 的缩放后
 * ImageData（scale = 采样图 / 原图像素），box 用原图像素坐标。
 */
export function sampleBubbleAppearance(sample, box) {
  if (!sample || !sample.data || !(sample.width > 0) || !(sample.height > 0)) return null;
  const normalized = normalizePixelBox(box);
  if (!normalized) return null;
  const scale = Number(sample.scale) > 0 ? Number(sample.scale) : 1;
  const left = Math.max(0, Math.floor(normalized.left * scale));
  const top = Math.max(0, Math.floor(normalized.top * scale));
  const right = Math.min(sample.width, Math.ceil((normalized.left + normalized.width) * scale));
  const bottom = Math.min(sample.height, Math.ceil((normalized.top + normalized.height) * scale));
  if (right - left < 3 || bottom - top < 3) return null;
  const pixelAt = (x, y) => {
    const offset = (y * sample.width + x) * 4;
    return [sample.data[offset], sample.data[offset + 1], sample.data[offset + 2]];
  };
  // 背景：外圈边框环的逐通道中位数
  const border = Math.max(1, Math.min(right - left, bottom - top) >> 3);
  const ring = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (x - left < border || right - 1 - x < border || y - top < border || bottom - 1 - y < border) {
        ring.push(pixelAt(x, y));
      }
    }
  }
  if (ring.length === 0) return null;
  const background = [0, 1, 2].map(channel => {
    const values = ring.map(pixel => pixel[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
  // 环内一致率：有多少边框像素就贴着这个中位色。`applySampledBubbleColors` 用它判断
  // 「外圈是一条平底色（白气泡）还是一片插画」—— 只有贴得够紧才允许画平涂。
  const bgCoverage = ring.filter(pixel => Math.hypot(
    pixel[0] - background[0], pixel[1] - background[1], pixel[2] - background[2]
  ) <= BG_RING_UNIFORM_DISTANCE).length / ring.length;
  // 墨色：与背景距离足够的像素，按 24 级量化取主色
  const buckets = new Map();
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const pixel = pixelAt(x, y);
      const distance = Math.hypot(pixel[0] - background[0], pixel[1] - background[1], pixel[2] - background[2]);
      if (distance < INK_DISTANCE_THRESHOLD) continue;
      const key = pixel.map(channel => Math.floor(channel / 24)).join(":");
      const bucket = buckets.get(key) || { count: 0, sums: [0, 0, 0] };
      bucket.count += 1;
      bucket.sums = bucket.sums.map((sum, index) => sum + pixel[index]);
      buckets.set(key, bucket);
    }
  }
  const dominant = pickDominantInkBucket(buckets, background);
  const ink = dominant
    ? dominant.sums.map(sum => sum / dominant.count)
    : null;
  return {
    bgColor: rgbToHex(background),
    bgCoverage,
    inkColor: ink ? rgbToHex(ink) : ""
  };
}

/**
 * 渲染用配色：采样的文字/描边色优先；缺色时按采样到的背景色做对比度推导；
 * 完全没有背景信息时才退回历史默认值（复杂背景=黑字白边，实底=深灰字白边）。
 */
export function resolveBubbleRenderColors(bubble, bgType, normalizeColor = normalizeHexColor) {
  const visual = bubble && bubble.visual || {};
  const normalize = value => normalizeColor(value, "");
  const background = normalize(bubble && (bubble.bg_color || visual.bgColor || visual.bg_color));
  const textColor = normalize(bubble && bubble.text_color) || (background
    ? (relativeLuminance(background) > 0.45 ? "#000000" : "#ffffff")
    : bgType === "none" ? "#000000" : "#111827");
  const fallbackStroke = relativeLuminance(textColor) < 0.45 ? "#ffffff" : "#000000";
  return {
    textColor,
    strokeColor: normalize(bubble && bubble.stroke_color) ||
      (background || bgType === "none" ? fallbackStroke : "#ffffff")
  };
}

function itemBox(item) {
  return normalizePixelBox(item && (item.box || item.location || item.rawBox || item.region_box));
}

function hasColor(value) {
  return Boolean(normalizeHexColor(value));
}

/**
 * 复杂背景（没有实底容器）判定。
 *
 * 服务端的黑白配色在复杂背景上只是"对比度兜底"：`region_id` 为空或 `region_type`
 * 是 effect_text（旁白/嵌字这类没有实底容器的文字）时，说明它没找到实底，
 * 此时纯黑/纯白不可能是采样到的墨色。
 */
function isComplexBackgroundItem(item) {
  const bgType = String(item && (item.bg_type || item.bgType) || "").trim().toLowerCase();
  if (bgType === "none" || bgType === "transparent") return true;
  if (bgType === "solid") return false;
  const regionId = String(item && (item.region_id || item.regionId) || "").trim();
  const regionType = String(item && (item.region_type || item.regionType) || "").trim().toLowerCase();
  return !regionId || regionType === "effect_text";
}

/**
 * 只给"缺色"的条目补采样结果；服务已经采样过的值一律保留。
 * 直接写回 text_color/stroke_color/bg_color（同时写 camelCase 别名）。
 *
 * 唯一的例外是"复杂背景 + 纯黑/纯白"：那是服务端按对比度兜底写死的颜色，
 * 不是原图墨色（旁白的蓝字就会被压成黑字白边）。这种条目允许重新按原图推导；
 * 描边始终与「最终生效的文字色」配对推导（文字色被保留时描边跟着它走，
 * 不用独立重采的墨色），可读性由文字/描边的亮度反差保证。
 */
export function applySampledBubbleColors(items, imageAnalysis) {
  const sample = imageAnalysis && imageAnalysis.sample;
  if (!sample || !Array.isArray(items)) return 0;
  let filled = 0;
  items.forEach(item => {
    if (!item || typeof item !== "object") return;
    const complexBackground = isComplexBackgroundItem(item);
    const fallbackText = complexBackground && isFallbackTextColor(item.text_color || item.textColor);
    const fallbackStroke = complexBackground && isFallbackTextColor(item.stroke_color || item.strokeColor);
    const needsText = !hasColor(item.text_color || item.textColor) || fallbackText;
    const needsStroke = !hasColor(item.stroke_color || item.strokeColor) || fallbackStroke;
    const needsBackground = !hasColor(item.bg_color || item.bgColor);
    // 复杂背景条目即使颜色齐全也要走一遍：平底色升级（见下面 adaptiveBackground）
    // 依赖采样结果，而它可能在上一次调用里才刚被补齐。
    if (!needsText && !needsStroke && !needsBackground && !complexBackground) return;
    const appearance = sampleBubbleAppearance(sample, itemBox(item));
    if (!appearance || !appearance.bgColor) return;
    const colors = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
    if (needsBackground) {
      item.bg_color = appearance.bgColor;
      item.bgColor = appearance.bgColor;
    }
    // 「纯粹的白色气泡框直接用实底，别等清理图」：清理图是 inpaint 出来的，
    // 白底上必然留下擦不干净的痕迹（用户看到的「背景不纯净」），而这类气泡本来就是
    // 一块平底色。条件是**量到的**：文字框外圈一致率够高、且是亮底 ——
    // 环不够均匀就什么都不做（平涂一块网点/渐变会把插画糊成色块，这条底线不能破）。
    if (complexBackground && appearance.bgCoverage >= BG_SOLID_MIN_COVERAGE
        && relativeLuminance(appearance.bgColor) >= BG_SOLID_MIN_LUMINANCE) {
      item.adaptiveBackground = {
        type: "solid", color: appearance.bgColor, confidence: Number(appearance.bgCoverage.toFixed(3))
      };
    }
    if (needsText) {
      item.text_color = colors.textColor;
      item.textColor = colors.textColor;
    }
    if (needsStroke) {
      // 描边必须与「最终生效的文字色」配对：needsText 未触发（文字色保留服务端
      // /已有值）时，若用独立重采的墨色决定描边，会产出与文字色无关的白描边
      // （真机实证：白字 #fcfcfc 被配成 #ffffff 描边 = 白字白边）。needsText 与
      // needsStroke 同时触发时读到的 item.text_color 已是重采结果，与旧成对逻辑
      // 等价；描边公式与 chooseReadableTextColors 的描边线一致（亮度 < 0.45 白描边）。
      const effectiveText = normalizeHexColor(item.text_color || item.textColor) || colors.textColor;
      const pairedStroke = relativeLuminance(effectiveText) < 0.45 ? "#ffffff" : "#000000";
      item.stroke_color = pairedStroke;
      item.strokeColor = pairedStroke;
    }
    filled += 1;
  });
  return filled;
}
