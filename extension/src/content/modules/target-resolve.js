export function installTargetResolve(runtime) {
  function resolveBackgroundImageUrl(target) {
    if (!(target instanceof Element)) {
      return "";
    }
    const backgroundImage = String(getComputedStyle(target).backgroundImage || target.style.backgroundImage || "").trim();
    if (!backgroundImage || backgroundImage === "none") {
      return "";
    }
    const match = backgroundImage.match(/url\((["']?)(.*?)\1\)/i);
    const rawUrl = match ? match[2] : "";
    if (!rawUrl) {
      return "";
    }
    if (target instanceof HTMLElement && target.dataset.mtEmbeddedActive === "true") {
      if (rawUrl.startsWith("data:") && target.dataset.mtEmbeddedOriginalBackgroundSource) {
        return target.dataset.mtEmbeddedOriginalBackgroundSource;
      }
      if (rawUrl && !rawUrl.startsWith("data:")) {
        delete target.dataset.mtEmbeddedActive;
        delete target.dataset.mtEmbeddedOutputKey;
        delete target.dataset.mtEmbeddedOriginalBackground;
        delete target.dataset.mtEmbeddedOriginalBackgroundSource;
      }
    }
    try {
      if (rawUrl.startsWith("//")) {
        return `${location.protocol}${rawUrl}`;
      }
      if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
        return rawUrl;
      }
      return new URL(rawUrl, location.href).href;
    } catch {
      return rawUrl;
    }
  }
  runtime.resolveBackgroundImageUrl = resolveBackgroundImageUrl;
  function isBackgroundImageTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const imageUrl = runtime.resolveBackgroundImageUrl(target);
    if (!imageUrl || runtime.PIXIV_PLACEHOLDER_BACKGROUND_RE.test(imageUrl)) {
      return false;
    }
    if (runtime.IS_PIXIV_COMIC_VIEWER) {
      return runtime.PIXIV_PAGE_ID_RE.test(target.id || "");
    }
    if (!runtime.IS_KAKAOPAGE_READER) {
      return false;
    }
    if (runtime.isDataUrl(imageUrl) || runtime.isBlobUrl(imageUrl)) {
      return true;
    }
    if (!runtime.isHttpUrl(imageUrl)) {
      return false;
    }
    try {
      const host = new URL(imageUrl, location.href).hostname;
      return /(^|\.)kakao(?:cdn)?\.net$/i.test(host) || /(^|\.)kakaocdn\.net$/i.test(host);
    } catch {
      return /kakao|kakaocdn/i.test(imageUrl);
    }
  }
  runtime.isBackgroundImageTarget = isBackgroundImageTarget;
  function getQuickSourceToken(target) {
    if (target instanceof HTMLImageElement) {
      return runtime.resolveImageUrl(target);
    }
    if (target instanceof HTMLCanvasElement) {
      return `canvas:${target.width}x${target.height}`;
    }
    if (runtime.isBackgroundImageTarget(target)) {
      return runtime.resolveBackgroundImageUrl(target);
    }
    return "";
  }
  runtime.getQuickSourceToken = getQuickSourceToken;
  function buildPayloadImageMeta(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const displayRect = runtime.getPayloadDisplayRect(payload);
    return {
      width: Number(payload.width || 0),
      height: Number(payload.height || 0),
      cssWidth: Number(payload.cssWidth || displayRect && displayRect.width || 0),
      cssHeight: Number(payload.cssHeight || displayRect && displayRect.height || 0),
      bitmapWidth: Number(payload.bitmapWidth || payload.width || 0),
      bitmapHeight: Number(payload.bitmapHeight || payload.height || 0),
      cropX: Number(payload.cropX || 0),
      cropY: Number(payload.cropY || 0),
      cropCssX: Number(displayRect && displayRect.offsetX ? displayRect.offsetX : 0),
      cropCssY: Number(displayRect && displayRect.offsetY ? displayRect.offsetY : 0),
      cropCssWidth: Number(displayRect && displayRect.width ? displayRect.width : payload.cssWidth || 0),
      cropCssHeight: Number(displayRect && displayRect.height ? displayRect.height : payload.cssHeight || 0),
      devicePixelRatio: Number(payload.devicePixelRatio || window.devicePixelRatio || 1),
      source: String(payload.source || ""),
      sourceImageId: String(payload.sourceImageId || ""),
      sourceWidth: Number(payload.sourceWidth || 0),
      sourceHeight: Number(payload.sourceHeight || 0),
      targetCssWidth: Number(payload.targetCssWidth || 0),
      targetCssHeight: Number(payload.targetCssHeight || 0),
      coordinateSpace: String(payload.coordinateSpace || ""),
      ocrMode: String(payload.ocrMode || "single"),
      sourceToken: String(payload.sourceToken || ""),
      fallbackReason: String(payload.fallbackReason || ""),
      stitchAdmission: String(payload.stitchAdmission || ""),
      stitchRejectionReason: String(payload.stitchRejectionReason || ""),
      novelImage: payload.novelImage === true,
      stitch: payload.stitch || null
    };
  }
  runtime.buildPayloadImageMeta = buildPayloadImageMeta;
  function logOcrDebugMapping(overlayState, result) {
    if (!runtime.ENABLE_PIPELINE_TRACE) {
      return;
    }
    const debug = result && result.debug;
    if (!debug || !Array.isArray(debug.items) || debug.items.length === 0) {
      return;
    }
    const rect = runtime.getOverlayDisplayRect(overlayState);
    const targetRect = overlayState.target.getBoundingClientRect();
    const imageMeta = debug.imageMeta || {};
    const rows = debug.items.map((item, index) => {
      const percent = item.percent || {};
      const raw = item.box || {};
      const cssLeft = rect.left + Number(percent.x || 0) / 100 * rect.width;
      const cssTop = rect.top + Number(percent.y || 0) / 100 * rect.height;
      const cssWidth = Number(percent.w || 0) / 100 * rect.width;
      const cssHeight = Number(percent.h || 0) / 100 * rect.height;
      return {
        index,
        text: item.text || "",
        confidence: item.confidence || 0,
        rawLeft: raw.left,
        rawTop: raw.top,
        rawWidth: raw.width,
        rawHeight: raw.height,
        rawWithCropLeft: Number(raw.left || 0) + Number(imageMeta.cropX || 0),
        rawWithCropTop: Number(raw.top || 0) + Number(imageMeta.cropY || 0),
        cssLeft: Math.round(cssLeft),
        cssTop: Math.round(cssTop),
        cssWidth: Math.round(cssWidth),
        cssHeight: Math.round(cssHeight),
        targetRelativeLeft: Math.round(cssLeft - targetRect.left),
        targetRelativeTop: Math.round(cssTop - targetRect.top)
      };
    });
    console.info("[MangaTranslator][OCR debug]", {
      imageMeta,
      localOcrDebug: debug.localOcr || {},
      overlayRect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
    console.table(rows);
  }
  runtime.logOcrDebugMapping = logOcrDebugMapping;
  function normalizeResult(result) {
    const bubbles = result && Array.isArray(result.bubbles) ? result.bubbles : [];
    return {
      bubbles: bubbles.map(bubble => {
        return {
          x: runtime.clamp(Number(bubble.x), 0, 100),
          y: bubble.stitch_overflow === true ? Number(bubble.y) : runtime.clamp(Number(bubble.y), 0, 100),
          w: runtime.clamp(Number(bubble.w), 0, 100),
          h: runtime.clamp(Number(bubble.h), 0, 100),
          fill_box: runtime.normalizeFillBox(bubble.fill_box, bubble.stitch_overflow === true),
          cleaned_source_box: runtime.normalizeFillBox(bubble.cleaned_source_box),
          bg_type: runtime.normalizeBgType(bubble.bg_type),
          bg_color: String(bubble.bg_color || ""),
          bg_confidence: Number(bubble.bg_confidence || 0),
          region_id: String(bubble.region_id || ""),
          region_type: String(bubble.region_type || "plain_text"),
          region_polygon: runtime.normalizeRegionPolygon(bubble.region_polygon, bubble.stitch_overflow === true),
          text_color: runtime.normalizeCssColor(bubble.text_color, ""),
          stroke_color: runtime.normalizeCssColor(bubble.stroke_color, ""),
          alignment: runtime.normalizeBubbleAlignment(bubble.alignment),
          polygon: runtime.normalizeBubblePolygon(bubble.polygon, bubble.stitch_overflow === true),
          rotation_deg: runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type),
          font_height: Number(bubble.font_height || bubble.fontHeight || 0),
          font_height_percent: Number(bubble.font_height_percent || bubble.fontHeightPercent || 0),
          font_weight: runtime.normalizeBubbleFontWeight(bubble.font_weight || bubble.fontWeight, 0),
          translation_role: String(bubble.translation_role || bubble.translationRole || ""),
          source_line_count: Math.max(1, Math.round(Number(bubble.source_line_count) || 1)),
          block_id: String(bubble.block_id || bubble.id || ""),
          stitch_overflow: bubble.stitch_overflow === true,
          original_text: runtime.cleanRenderableText(bubble.original_text || ""),
          translated_text: runtime.cleanRenderableText(bubble.translated_text || "")
        };
      }).filter(bubble => bubble.w > 0 && bubble.h > 0).filter(bubble => bubble.original_text || bubble.translated_text),
      debug: result && result.debug && typeof result.debug === "object" ? result.debug : null
    };
  }
  runtime.normalizeResult = normalizeResult;
  function normalizeFillBox(value, allowVerticalOverflow = false) {
    if (!value || typeof value !== "object") {
      return null;
    }
    // canonical 层使用 left/top/width/height，旧渲染结果使用 x/y/w/h；
    // 两种格式在内容层入口统一，避免合法的最终蓝框被误判为空。
    const rawX = Number(value.x ?? value.left);
    const rawY = Number(value.y ?? value.top);
    const rawW = Number(value.w ?? value.width);
    const rawH = Number(value.h ?? value.height);
    if (![rawX, rawY, rawW, rawH].every(Number.isFinite) || rawW <= 0 || rawH <= 0) {
      return null;
    }
    const box = {
      x: runtime.clamp(rawX, 0, 100),
      y: allowVerticalOverflow ? rawY : runtime.clamp(rawY, 0, 100),
      w: runtime.clamp(rawW, 0, 100),
      h: runtime.clamp(rawH, 0, 100)
    };
    return box.w > 0 && box.h > 0 ? box : null;
  }
  runtime.normalizeFillBox = normalizeFillBox;
  function buildSolidBackgroundBox(textBox, fillBoxValue, allowVerticalOverflow = false) {
    const text = runtime.normalizeFillBox(textBox, allowVerticalOverflow);
    const fill = runtime.normalizeFillBox(fillBoxValue, allowVerticalOverflow);
    if (!text) {
      return fill;
    }
    if (!fill) {
      return text;
    }
    const left = Math.min(text.x, fill.x);
    const top = Math.min(text.y, fill.y);
    const right = Math.max(text.x + text.w, fill.x + fill.w);
    const bottom = Math.max(text.y + text.h, fill.y + fill.h);
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    };
  }
  runtime.buildSolidBackgroundBox = buildSolidBackgroundBox;
  function getCleanedPatchStyle(sourceBox) {
    const box = runtime.normalizeFillBox(sourceBox) || {
      x: 0,
      y: 0,
      w: 100,
      h: 100
    };
    const positionX = box.w < 100 ? box.x / (100 - box.w) * 100 : 0;
    const positionY = box.h < 100 ? box.y / (100 - box.h) * 100 : 0;
    return {
      sizeX: `${10000 / box.w}%`,
      sizeY: `${10000 / box.h}%`,
      positionX: `${positionX}%`,
      positionY: `${positionY}%`
    };
  }
  runtime.getCleanedPatchStyle = getCleanedPatchStyle;
  function normalizeBubblePolygon(value, allowOverflow) {
    if (!Array.isArray(value) || value.length < 4) {
      return null;
    }
    const points = value.slice(0, 4).map(point => {
      const x = runtime.clamp(Number(point && point.x), 0, 100);
      const rawY = Number(point && point.y);
      const y = allowOverflow ? rawY : runtime.clamp(rawY, 0, 100);
      return Number.isFinite(x) && Number.isFinite(y) ? {
        x,
        y
      } : null;
    });
    return points.every(Boolean) ? points : null;
  }
  runtime.normalizeBubblePolygon = normalizeBubblePolygon;
  function normalizeRegionPolygon(value, allowOverflow) {
    if (!Array.isArray(value) || value.length < 3) {
      return null;
    }
    const points = value.map(point => {
      const x = runtime.clamp(Number(point && point.x), 0, 100);
      const rawY = Number(point && point.y);
      const y = allowOverflow ? rawY : runtime.clamp(rawY, 0, 100);
      return Number.isFinite(x) && Number.isFinite(y) ? {
        x,
        y
      } : null;
    });
    return points.every(Boolean) ? points : null;
  }
  runtime.normalizeRegionPolygon = normalizeRegionPolygon;
  function getBubbleRenderColors(bubble, bgType) {
    return {
      textColor: runtime.normalizeCssColor(bubble && bubble.text_color, bgType === "none" ? "#000000" : "#111827"),
      strokeColor: runtime.normalizeCssColor(bubble && bubble.stroke_color, "#ffffff")
    };
  }
  runtime.getBubbleRenderColors = getBubbleRenderColors;
  function normalizeCssColor(value, fallback) {
    const text = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  }
  runtime.normalizeCssColor = normalizeCssColor;
  function normalizeBubbleRotation(value, regionType) {
    let angle = Number(value) || 0;
    while (angle >= 90) angle -= 180;
    while (angle < -90) angle += 180;

    // Near-horizontal text: ignore tiny rotation noise
    if (Math.abs(angle) < runtime.BUBBLE_ROTATION_NEAR_HORIZONTAL) return 0;

    // 保留归一化到 -90°～90° 的完整倾角，垂直排版由 writing-mode 单独处理。
    return runtime.clamp(angle, -runtime.BUBBLE_ROTATION_MAX, runtime.BUBBLE_ROTATION_MAX);
  }
  runtime.normalizeBubbleRotation = normalizeBubbleRotation;
  function normalizeBubbleAlignment(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "left" || text === "right" || text === "center" ? text : "center";
  }
  runtime.normalizeBubbleAlignment = normalizeBubbleAlignment;
  function normalizeBubbleFontWeight(value, fallback = 600) {
    const numeric = Math.round(Number(value) || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return fallback;
    }
    return runtime.clamp(Math.round(numeric / 100) * 100, 100, 900);
  }
  runtime.normalizeBubbleFontWeight = normalizeBubbleFontWeight;
  function cleanRenderableText(text) {
    return String(text || "").replace(runtime.MODEL_IMAGE_PLACEHOLDER_BRACKET_RE, " ").replace(/\s+/g, " ").trim().replace(runtime.MODEL_IMAGE_PLACEHOLDER_ONLY_RE, "");
  }
  runtime.cleanRenderableText = cleanRenderableText;
  function normalizeBgType(value) {
    const text = String(value || "").toLowerCase();
    if (text === "solid" || text === "transparent" || text === "none") {
      return text;
    }
    return "solid";
  }
  runtime.normalizeBgType = normalizeBgType;
}
