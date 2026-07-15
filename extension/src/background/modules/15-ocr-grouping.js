export function installBackground15(runtime) {
  /**
   * Auto-detect chat/forum region type from a group of OCR entries.
   * Returns "chat" if the entries exhibit chat-like patterns (timestamps,
   * small-above-large stacking, left alignment, regular arrangement), or null.
   */
  function detectLocalPaddleRegionType(entries) {
    if (!Array.isArray(entries) || entries.length < 3) return null;
    const boxes = entries.map(e => e.box).filter(Boolean);
    const texts = entries.map(e => e.text).filter(Boolean);
    if (boxes.length < 3 || texts.length < 3) return null;
    const CHAT_LEFT_ALIGN_TOLERANCE = 0.15;

    // 1. Korean time format check
    let timeMatchCount = 0;
    for (const t of texts) {
      if (runtime.CHAT_TIME_RE.test(t)) timeMatchCount++;
    }
    const hasTimestamp = timeMatchCount >= 1;

    // 2. Height pattern: mix of small and large boxes (username + body)
    const heights = boxes.map(b => b.height).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)];
    const hasSizeVariation = heights.some(h => h < medianH * 0.6) && heights.some(h => h > medianH * 1.3);

    // 3. Left alignment check
    const lefts = boxes.map(b => b.left);
    const avgWidth = boxes.reduce((s, b) => s + b.width, 0) / boxes.length;
    const leftSpread = Math.max(...lefts) - Math.min(...lefts);
    const isLeftAligned = leftSpread < avgWidth * CHAT_LEFT_ALIGN_TOLERANCE;

    // 4. Vertical regularity: consistent vertical gaps
    const tops = boxes.map(b => b.top).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < tops.length; i++) gaps.push(tops[i] - tops[i - 1]);
    if (gaps.length > 0) {
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const gapVariance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
      var isRegularArrangement = gapVariance < avgGap * 0.5 && avgGap > 0;
    } else {
      var isRegularArrangement = false;
    }

    // 5. Font size pattern: repeated font size clusters
    const fontSizeClusters = new Set(boxes.map(b => Math.round(b.height / 5) * 5));
    const hasRepeatedFontSizes = fontSizeClusters.size >= 2 && fontSizeClusters.size <= Math.ceil(boxes.length / 2);

    // 6. Container type hint from model
    const containsChatRegion = entries.some(e => e.container && (e.container.type === "chat" || e.container.type === "ui" || e.container.type === "comment"));
    const hasStackedMetadata = entries.some(upper => entries.some(lower => {
      if (upper === lower || !upper.box || !lower.box) return false;
      const small = upper.box.height <= lower.box.height ? upper : lower;
      const large = small === upper ? lower : upper;
      const overlapX = Math.max(0, Math.min(small.box.right, large.box.right) - Math.max(small.box.left, large.box.left));
      const overlapRatio = overlapX / Math.max(1, Math.min(small.box.width, large.box.width));
      return small.box.top <= large.box.top && large.box.height >= small.box.height * runtime.OCR_STYLE_SPLIT_HEIGHT_RATIO && runtime.getVerticalGap(small.box, large.box) <= large.box.height * 0.65 && overlapRatio >= 0.3;
    }));

    // Scoring
    let chatScore = 0;
    if (hasTimestamp) chatScore += 3;
    if (hasSizeVariation) chatScore += 2;
    if (isLeftAligned) chatScore += 2;
    if (isRegularArrangement) chatScore += 1;
    if (hasRepeatedFontSizes) chatScore += 1;
    if (containsChatRegion) chatScore += 3;
    const hasChatShape = hasStackedMetadata || hasSizeVariation || isLeftAligned || containsChatRegion;
    return chatScore >= 4 && (hasTimestamp || containsChatRegion) && hasChatShape ? "chat" : null;
  }
  runtime.detectLocalPaddleRegionType = detectLocalPaddleRegionType;
  function normalizeOcrTextAlignment(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "left" || text === "right" || text === "center" ? text : "center";
  }
  runtime.normalizeOcrTextAlignment = normalizeOcrTextAlignment;
  function inferLocalPaddleClusterAlignment(cluster, imageSize, regionType = "") {
    const boxes = (Array.isArray(cluster) ? cluster : []).map(entry => entry && entry.box).filter(Boolean);
    return runtime.inferTextAlignmentFromBoxes(boxes, imageSize, regionType);
  }
  runtime.inferLocalPaddleClusterAlignment = inferLocalPaddleClusterAlignment;
  function inferTextAlignmentFromBoxes(boxes, imageSize, regionType = "") {
    if (runtime.isChatRegionType(regionType)) {
      return "left";
    }
    const usable = (Array.isArray(boxes) ? boxes : []).filter(box => box && [box.left, box.right, box.centerX, box.width, box.height].every(value => Number.isFinite(Number(value))));
    if (usable.length < 2) {
      const type = String(regionType || "").toLowerCase();
      return type === "chat" || type === "comment" || type === "ui" ? "left" : "center";
    }
    const avgHeight = Math.max(1, usable.reduce((sum, box) => sum + Number(box.height || 0), 0) / usable.length);
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const lefts = usable.map(box => Number(box.left));
    const rights = usable.map(box => Number(box.right));
    const centers = usable.map(box => Number(box.centerX));
    const widths = usable.map(box => Number(box.width));
    const spread = values => Math.max(...values) - Math.min(...values);
    const leftSpread = spread(lefts);
    const rightSpread = spread(rights);
    const centerSpread = spread(centers);
    const widthSpread = spread(widths);
    const edgeTolerance = Math.max(avgHeight * 1.15, imageWidth * 0.012);
    const centerTolerance = Math.max(avgHeight * 1.2, imageWidth * 0.018);
    const closestEdgeSpread = Math.min(leftSpread, rightSpread);

    // 气泡中常见“短行嵌在长行中间”的排版。此时左右边缘可能仍落入按字高放宽的
    // 对齐容差，但中心线会明显更稳定，必须先于宽松的边缘规则判为居中。
    if (centerSpread <= centerTolerance && centerSpread <= closestEdgeSpread * 0.6) {
      return "center";
    }
    if (leftSpread <= edgeTolerance && (rightSpread > leftSpread * 1.35 || widthSpread > avgHeight * 0.75)) {
      return "left";
    }
    if (rightSpread <= edgeTolerance && (leftSpread > rightSpread * 1.35 || widthSpread > avgHeight * 0.75)) {
      return "right";
    }
    if (centerSpread <= centerTolerance) {
      return "center";
    }
    if (leftSpread <= rightSpread && leftSpread <= centerSpread) {
      return "left";
    }
    if (rightSpread <= leftSpread && rightSpread <= centerSpread) {
      return "right";
    }
    return "center";
  }
  runtime.inferTextAlignmentFromBoxes = inferTextAlignmentFromBoxes;
  function unionLocalPaddleBoxes(left, right) {
    return runtime.buildBaiduBox(Math.min(left.left, right.left), Math.min(left.top, right.top), Math.max(left.right, right.right), Math.max(left.bottom, right.bottom));
  }
  runtime.unionLocalPaddleBoxes = unionLocalPaddleBoxes;
  function buildLocalPaddleClusterEntry(item, index, imageSize, imageAnalysis, debug) {
    const box = runtime.getBaiduItemBox(item);
    const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
    if (!box || !text || !debug && runtime.shouldDropLocalPaddleNoiseItem(item, imageSize)) {
      return null;
    }
    const areaRatio = box.width * box.height / Math.max(1, (Number(imageSize && imageSize.width) || 1) * (Number(imageSize && imageSize.height) || 1));
    if (!debug && /^[xX×]+$/.test(text) && areaRatio < 0.02) {
      return {
        item,
        index,
        box,
        text,
        kind: "noise"
      };
    }
    if (!debug && /^[A-Za-z]$/.test(text) && !runtime.isMeaningfulLatinToken(text)) {
      return {
        item,
        index,
        box,
        text,
        kind: "noise"
      };
    }
    if (!debug && runtime.countScriptChars(text) === 0 && !/[0-9A-Za-z]/.test(text)) {
      return {
        item,
        index,
        box,
        text,
        kind: "noise"
      };
    }
    const serviceRegionId = String(item && item.region_id ? item.region_id : "");
    const container = serviceRegionId ? {
      id: serviceRegionId,
      box: runtime.normalizeLocalOcrRegionBox(item.region_box),
      polygon: item.region_polygon || null,
      type: String(item.region_type || "speech_bubble"),
      color: String(item.bg_color || ""),
      confidence: Number(item.region_confidence || 0)
    } : null;
    const color = runtime.sampleLocalOcrTextColor(imageAnalysis && imageAnalysis.sample, box);
    let kind = "normalOutsideText";
    if (container) {
      kind = "bubbleText";
    } else if (runtime.isLocalOcrEffectColor(color)) {
      kind = "effectText";
    }
    return {
      item,
      index,
      box,
      text,
      kind,
      container,
      color,
      textColor: String(item && item.text_color ? item.text_color : ""),
      strokeColor: String(item && item.stroke_color ? item.stroke_color : ""),
      translationRole: runtime.normalizeChatTranslationRole(item && (item.translation_role || item.translationRole)),
      fontWeight: runtime.normalizeOcrFontWeight(item && (item.font_weight || item.fontWeight)),
      rotation: Number.isFinite(Number(item && item.rotation_deg)) && Number(item && item.rotation_deg) !== 0 ? runtime.normalizeRotationDegrees(item && item.rotation_deg) : runtime.inferLocalPaddlePolygonRotation(item && item.polygon)
    };
  }
  runtime.buildLocalPaddleClusterEntry = buildLocalPaddleClusterEntry;
  function normalizeLocalOcrRegionBox(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const left = Number(value.left);
    const top = Number(value.top);
    const width = Number(value.width);
    const height = Number(value.height);
    return Number.isFinite(left) && Number.isFinite(top) && width > 0 && height > 0 ? runtime.buildBaiduBox(left, top, left + width, top + height) : null;
  }
  runtime.normalizeLocalOcrRegionBox = normalizeLocalOcrRegionBox;
  function sampleLocalOcrTextColor(sample, box) {
    if (!sample || !sample.data || !box) {
      return {
        redScore: 0,
        brightness: 0,
        redDominance: 0,
        selected: 0
      };
    }
    const {
      data,
      width,
      height,
      scale
    } = sample;
    const left = runtime.clamp(Math.floor(box.left * scale), 0, width - 1);
    const top = runtime.clamp(Math.floor(box.top * scale), 0, height - 1);
    const right = runtime.clamp(Math.ceil(box.right * scale), left + 1, width);
    const bottom = runtime.clamp(Math.ceil(box.bottom * scale), top + 1, height);
    const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 90));
    let selected = 0;
    let redPixels = 0;
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    for (let y = top; y < bottom; y += step) {
      for (let x = left; x < right; x += step) {
        const offset = (y * width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const alpha = data[offset + 3];
        if (alpha < 24) {
          continue;
        }
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const brightness = (red + green + blue) / 3;
        const saturated = max - min >= 32;
        if (brightness > 214 && !saturated) {
          continue;
        }
        selected += 1;
        redSum += red;
        greenSum += green;
        blueSum += blue;
        if (red >= 88 && red >= green + 18 && red >= blue + 18) {
          redPixels += 1;
        }
      }
    }
    if (selected === 0) {
      return {
        redScore: 0,
        brightness: 0,
        redDominance: 0,
        selected: 0
      };
    }
    const avgRed = redSum / selected;
    const avgGreen = greenSum / selected;
    const avgBlue = blueSum / selected;
    return {
      redScore: redPixels / selected,
      brightness: (avgRed + avgGreen + avgBlue) / 3,
      redDominance: avgRed - Math.max(avgGreen, avgBlue),
      selected
    };
  }
  runtime.sampleLocalOcrTextColor = sampleLocalOcrTextColor;
  function isLocalOcrEffectColor(color) {
    if (!color || color.selected <= 0) {
      return false;
    }
    return color.redScore >= 0.18 || color.redDominance >= 24;
  }
  runtime.isLocalOcrEffectColor = isLocalOcrEffectColor;
}
