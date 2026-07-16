export function installBaiduResults(runtime) {
  function compareBaiduWordItems(left, right) {
    const leftBox = runtime.getBaiduItemBox(left);
    const rightBox = runtime.getBaiduItemBox(right);
    if (!leftBox || !rightBox) {
      return leftBox ? -1 : rightBox ? 1 : 0;
    }
    const averageHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
    if (Math.abs(leftBox.top - rightBox.top) <= averageHeight * 0.55) {
      return leftBox.left - rightBox.left;
    }
    return leftBox.top - rightBox.top;
  }
  runtime.compareBaiduWordItems = compareBaiduWordItems;
  function normalizeBaiduOcrItem(item, index, imageSize) {
    const location = item && item.location && typeof item.location === "object" ? item.location : null;
    const text = runtime.cleanDecorativeSymbols(item && item.words ? item.words : "");
    if (!location || !text || imageSize.width <= 0 || imageSize.height <= 0) {
      console.warn("[MangaTranslator][norm] drop item", index, {
        hasLocation: !!location,
        text,
        imgSize: imageSize,
        itemKeys: item ? Object.keys(item) : null
      });
      return null;
    }
    const sourceLeft = runtime.toNumber(location.left);
    const sourceTop = runtime.toNumber(location.top);
    const sourceWidth = runtime.toNumber(location.width);
    const sourceHeight = runtime.toNumber(location.height);
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      console.debug("[MangaTranslator][norm] drop item zero box", index, {
        sourceLeft,
        sourceTop,
        sourceWidth,
        sourceHeight
      });
      return null;
    }
    const clusterKind = String(item && item.localOcrClusterKind ? item.localOcrClusterKind : "");
    const adaptiveBackground = item && item.adaptiveBackground ? item.adaptiveBackground : null;
    let bgType = adaptiveBackground ? adaptiveBackground.type === "solid" ? "solid" : "none" : clusterKind && clusterKind !== "bubbleText" ? "none" : "solid";
    const regionBox = runtime.normalizeLocalOcrRegionBox(item && item.regionBox);
    const rawDisplayBox = runtime.buildBaiduBox(sourceLeft, sourceTop, sourceLeft + sourceWidth, sourceTop + sourceHeight);
    // 本地 OCR 的 displayBox 已经包含全部原文字框和安全边距，纯色背景无需再次向外扩张。
    const expandSolidPaintBox = !clusterKind;
    const regionType = item.region_type || item.localOcrRegionType || clusterKind;
    const solidPaintBox = bgType === "solid" ? runtime.buildLocalSolidPaintBox(rawDisplayBox, regionBox, imageSize, expandSolidPaintBox, regionType) : null;
    if (bgType === "solid" && !solidPaintBox) {
      bgType = "none";
    }
    const displayBox = rawDisplayBox;
    const {
      left,
      top,
      width,
      height
    } = displayBox;
    const expandX = bgType === "solid" ? 0 : Math.min(1, width * 0.01);
    const expandY = bgType === "solid" ? 0 : Math.min(1, height * 0.02);
    const x = (left - expandX) / imageSize.width * 100;
    const y = (top - expandY) / imageSize.height * 100;
    const w = (width + expandX * 2) / imageSize.width * 100;
    const h = (height + expandY * 2) / imageSize.height * 100;
    const polygon = runtime.normalizePercentPolygon(item && item.polygon, imageSize);
    const rotation = runtime.normalizeRotationDegrees(item && item.rotation_deg);
    const sourceLineCount = Math.max(1, Math.round(Number(item && item.sourceLineCount) || String(text).split(/\n/).length));
    const fontHeight = Math.max(1, Number(item && (item.fontHeight ?? item.font_height)) || sourceHeight / sourceLineCount);
    return {
      id: `t${index}`,
      x: runtime.clamp(x, 0, 100),
      y: runtime.clamp(y, 0, 100),
      w: runtime.clamp(w, 0.1, 100),
      h: runtime.clamp(h, 0.1, 100),
      fill_box: solidPaintBox ? {
        x: runtime.clamp(solidPaintBox.left / imageSize.width * 100, 0, 100),
        y: runtime.clamp(solidPaintBox.top / imageSize.height * 100, 0, 100),
        w: runtime.clamp(solidPaintBox.width / imageSize.width * 100, 0, 100),
        h: runtime.clamp(solidPaintBox.height / imageSize.height * 100, 0, 100)
      } : null,
      bg_type: bgType,
      bg_color: adaptiveBackground && adaptiveBackground.type === "solid" ? adaptiveBackground.color : "",
      bg_confidence: adaptiveBackground ? Number(adaptiveBackground.confidence || 0) : 0,
      region_id: String(item && item.localOcrContainerId ? item.localOcrContainerId : ""),
      region_type: String(item && (item.region_type || item.localOcrRegionType) ? item.region_type || item.localOcrRegionType : "effect_text"),
      region_polygon: runtime.normalizePercentRegionPolygon(item && item.regionPolygon, imageSize),
      text_color: String(item && item.textColor ? item.textColor : ""),
      stroke_color: String(item && item.strokeColor ? item.strokeColor : ""),
      alignment: runtime.normalizeOcrTextAlignment(item && item.alignment),
      polygon,
      rotation_deg: rotation,
      source_line_count: sourceLineCount,
      font_height: fontHeight,
      font_height_percent: fontHeight / Math.max(1, imageSize.height) * 100,
      font_weight: runtime.normalizeOcrFontWeight(item && (item.fontWeight ?? item.font_weight)),
      member_region_ids: Array.isArray(item && item.memberRegionIds) ? [...item.memberRegionIds] : [],
      detected_regions: Array.isArray(item && item.detectedRegions) ? item.detectedRegions : [],
      original_text: text,
      translated_text: "",
      non_translate: item && (item.nonTranslate === true || item.non_translate === true),
      translation_role: runtime.normalizeChatTranslationRole(item && (item.translation_role || item.translationRole)),
      confidence: Number(item.confidence || 0),
      rawBox: {
        left: sourceLeft,
        top: sourceTop,
        width: sourceWidth,
        height: sourceHeight
      }
    };
  }
  runtime.normalizeBaiduOcrItem = normalizeBaiduOcrItem;
  function buildLocalSolidPaintBox(rawBox, regionBox, imageSize, expand = true, regionType) {
    if (!rawBox || !(rawBox.width > 0) || !(rawBox.height > 0)) {
      return null;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const isCompactRegion = String(regionType || "") === "chat" || String(regionType || "") === "ui";
    let expandX, expandY;
    if (expand) {
      if (isCompactRegion) {
        expandX = Math.min(runtime.CHAT_PAINT_PADDING_X, rawBox.height * runtime.CHAT_PAINT_PADDING_RATIO_X);
        expandY = Math.min(runtime.CHAT_PAINT_PADDING_Y, rawBox.height * runtime.CHAT_PAINT_PADDING_RATIO_Y);
      } else {
        expandX = rawBox.width * 0.1;
        expandY = rawBox.height * 0.15;
      }
    } else {
      expandX = 0;
      expandY = 0;
    }
    let left = Math.max(0, rawBox.left - expandX);
    let top = Math.max(0, rawBox.top - expandY);
    let right = Math.min(imageWidth, rawBox.right + expandX);
    let bottom = Math.min(imageHeight, rawBox.bottom + expandY);
    if (regionBox) {
      left = Math.max(left, Number(regionBox.left) || 0);
      top = Math.max(top, Number(regionBox.top) || 0);
      right = Math.min(right, (Number(regionBox.left) || 0) + Math.max(0, Number(regionBox.width) || 0));
      bottom = Math.min(bottom, (Number(regionBox.top) || 0) + Math.max(0, Number(regionBox.height) || 0));
    }
    if (right <= left || bottom <= top) {
      return null;
    }
    const width = right - left;
    const height = bottom - top;
    const rawArea = Math.max(1, rawBox.width * rawBox.height);
    if (width * height > rawArea * 2) {
      return null;
    }
    return runtime.buildBaiduBox(left, top, right, bottom);
  }
  runtime.buildLocalSolidPaintBox = buildLocalSolidPaintBox;
  function normalizePercentRegionPolygon(value, imageSize) {
    if (!Array.isArray(value) || value.length < 3) {
      return null;
    }
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    return value.map(point => {
      const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
      const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
      return {
        x: runtime.clamp(x / width * 100, 0, 100),
        y: runtime.clamp(y / height * 100, 0, 100)
      };
    });
  }
  runtime.normalizePercentRegionPolygon = normalizePercentRegionPolygon;
  function normalizePercentPolygon(value, imageSize) {
    if (!Array.isArray(value) || value.length < 4) {
      return null;
    }
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    return value.slice(0, 4).map(point => {
      const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
      const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
      return {
        x: runtime.clamp(x / width * 100, 0, 100),
        y: runtime.clamp(y / height * 100, 0, 100)
      };
    });
  }
  runtime.normalizePercentPolygon = normalizePercentPolygon;
}
