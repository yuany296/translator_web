export function installOcrItemFilter(runtime) {
  function shouldDropUnmergedLocalPaddleFragment(item, imageSize) {
    const box = runtime.getBaiduItemBox(item);
    const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
    if (!box || !text) {
      return true;
    }
    // 长度不是噪声依据；低置信度、符号和损坏文本由其他过滤阶段判断。
    return false;
  }
  runtime.shouldDropUnmergedLocalPaddleFragment = shouldDropUnmergedLocalPaddleFragment;
  function countScriptChars(text) {
    return (String(text || "").match(/[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
  }
  runtime.countScriptChars = countScriptChars;
  function isReliableShortSpeechBubbleItem(item) {
    const text = String(item && (item.words ?? item.text ?? item.original_text) || "").replace(/\s+/g, "");
    const hangulChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
    if (hangulChars < 1 || hangulChars > 2 || runtime.countScriptChars(text) !== hangulChars || /[A-Za-z0-9\u3130-\u318f]/.test(text)) {
      return false;
    }
    const regionId = String(item && item.region_id || "").trim();
    const regionType = String(item && item.region_type || "").trim().toLowerCase();
    const confidence = Number(item && (item.confidence ?? item.score)) || 0;
    const regionConfidence = Number(item && (item.region_confidence ?? item.bg_confidence)) || 0;
    return !!regionId && regionType === "speech_bubble" && confidence >= 0.7 && regionConfidence >= 0.9;
  }
  runtime.isReliableShortSpeechBubbleItem = isReliableShortSpeechBubbleItem;
  function normalizeLocalPaddleOcrItem(item, imageSize) {
    const text = runtime.cleanDecorativeSymbols(item && item.text !== undefined ? item.text : item && item.words !== undefined ? item.words : "");
    if (!text) {
      return null;
    }
    if (runtime.isSymbolOnlyText(text)) {
      return null;
    }
    const box = runtime.normalizeLocalPaddleOcrBox(item, imageSize);
    if (!box) {
      return null;
    }
    const polygon = runtime.normalizeLocalPaddlePolygon(item && item.polygon, imageSize);
    const explicitRotation = Number(item && (item.rotation_deg ?? item.rotationDeg));
    const rotation = Number.isFinite(explicitRotation) && explicitRotation !== 0 ? runtime.normalizeRotationDegrees(explicitRotation) : runtime.inferLocalPaddlePolygonRotation(polygon);
    return {
      words: text,
      confidence: Number(item.score || item.confidence || 0),
      polygon,
      rotation_deg: rotation,
      orientation_applied: Number(item && item.orientation_applied) || 0,
      det_score: Number(item && item.det_score) || 0,
      region_id: String(item && item.region_id ? item.region_id : ""),
      region_type: String(item && item.region_type ? item.region_type : "effect_text"),
      region_polygon: runtime.normalizeLocalPaddleRegionPolygon(item && item.region_polygon, imageSize),
      region_box: item && item.region_box && typeof item.region_box === "object" ? {
        ...item.region_box
      } : null,
      bg_color: String(item && item.bg_color ? item.bg_color : ""),
      text_color: String(item && item.text_color ? item.text_color : ""),
      stroke_color: String(item && item.stroke_color ? item.stroke_color : ""),
      non_translate: item && (item.nonTranslate === true || item.non_translate === true),
      translation_role: runtime.normalizeChatTranslationRole(item && (item.translation_role || item.translationRole)),
      font_weight: runtime.normalizeOcrFontWeight(item && (item.font_weight || item.fontWeight)),
      region_confidence: Number(item && item.region_confidence) || 0,
      detected_region: item && item.detected_region ? item.detected_region : null,
      line_thickness: Number(item && item.line_thickness) || 0,
      member_region_ids: Array.isArray(item && item.member_region_ids) ? [...item.member_region_ids] : [String(item && item.region_id || "")].filter(Boolean),
      rawBox: box,
      location: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height
      }
    };
  }
  runtime.normalizeLocalPaddleOcrItem = normalizeLocalPaddleOcrItem;
  function inferLocalPaddlePolygonRotation(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 2) {
      return 0;
    }
    const toPoint = value => ({
      x: Array.isArray(value) ? Number(value[0]) : Number(value && value.x),
      y: Array.isArray(value) ? Number(value[1]) : Number(value && value.y)
    });
    const first = toPoint(polygon[0]);
    const second = toPoint(polygon[1]);
    const angle = Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI;
    return Number.isFinite(angle) ? runtime.normalizeRotationDegrees(angle) : 0;
  }
  runtime.inferLocalPaddlePolygonRotation = inferLocalPaddlePolygonRotation;
  function normalizeLocalPaddleRegionPolygon(value, imageSize) {
    if (!Array.isArray(value) || value.length < 3) {
      return null;
    }
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const points = value.map(point => {
      const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
      const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
      return Number.isFinite(x) && Number.isFinite(y) ? {
        x: runtime.clamp(x, 0, width),
        y: runtime.clamp(y, 0, height)
      } : null;
    });
    return points.every(Boolean) ? points : null;
  }
  runtime.normalizeLocalPaddleRegionPolygon = normalizeLocalPaddleRegionPolygon;
  function normalizeLocalPaddlePolygon(value, imageSize) {
    if (!Array.isArray(value) || value.length < 4) {
      return null;
    }
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const points = value.slice(0, 4).map(point => {
      const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
      const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
      return Number.isFinite(x) && Number.isFinite(y) ? {
        x: runtime.clamp(x, 0, width),
        y: runtime.clamp(y, 0, height)
      } : null;
    });
    return points.every(Boolean) ? points : null;
  }
  runtime.normalizeLocalPaddlePolygon = normalizeLocalPaddlePolygon;
  function normalizeRotationDegrees(value) {
    let angle = Number(value) || 0;
    while (angle >= 90) angle -= 180;
    while (angle < -90) angle += 180;
    return angle;
  }
  runtime.normalizeRotationDegrees = normalizeRotationDegrees;
  function rotationDistance(left, right) {
    const distance = Math.abs(runtime.normalizeRotationDegrees(left) - runtime.normalizeRotationDegrees(right));
    return Math.min(distance, 180 - distance);
  }
  runtime.rotationDistance = rotationDistance;
  function isOcrItemOwnedByStitch(item, stitch) {
    if (!stitch || !item || !item.location) {
      return true;
    }
    const ownerTop = Number(stitch.ownerTop);
    const ownerHeight = Number(stitch.ownerHeight);
    if (!(Number.isFinite(ownerTop) && ownerHeight > 0)) {
      return true;
    }
    const centerY = Number(item.location.top || 0) + Number(item.location.height || 0) / 2;
    return centerY >= ownerTop && centerY < ownerTop + ownerHeight;
  }
  runtime.isOcrItemOwnedByStitch = isOcrItemOwnedByStitch;
  function normalizeImageMeta(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const meta = {
      width: runtime.toNumber(value.width, 0),
      height: runtime.toNumber(value.height, 0),
      cssWidth: runtime.toNumber(value.cssWidth, 0),
      cssHeight: runtime.toNumber(value.cssHeight, 0),
      bitmapWidth: runtime.toNumber(value.bitmapWidth, 0),
      bitmapHeight: runtime.toNumber(value.bitmapHeight, 0),
      cropX: runtime.toNumber(value.cropX, 0),
      cropY: runtime.toNumber(value.cropY, 0),
      cropCssX: runtime.toNumber(value.cropCssX, 0),
      cropCssY: runtime.toNumber(value.cropCssY, 0),
      cropCssWidth: runtime.toNumber(value.cropCssWidth, 0),
      cropCssHeight: runtime.toNumber(value.cropCssHeight, 0),
      devicePixelRatio: runtime.toNumber(value.devicePixelRatio, 1),
      source: String(value.source || ""),
      sourceImageId: String(value.sourceImageId || ""),
      sourceWidth: runtime.toNumber(value.sourceWidth, 0),
      sourceHeight: runtime.toNumber(value.sourceHeight, 0),
      targetCssWidth: runtime.toNumber(value.targetCssWidth, 0),
      targetCssHeight: runtime.toNumber(value.targetCssHeight, 0),
      coordinateSpace: String(value.coordinateSpace || ""),
      ocrMode: runtime.normalizeOcrRequestMode(value.ocrMode),
      sourceToken: String(value.sourceToken || ""),
      fallbackReason: String(value.fallbackReason || ""),
      stitchAdmission: String(value.stitchAdmission || ""),
      stitchRejectionReason: String(value.stitchRejectionReason || ""),
      novelImage: value.novelImage === true,
      stitch: runtime.normalizeStitchMeta(value.stitch)
    };
    return meta.width > 0 || meta.height > 0 || meta.cropCssWidth > 0 ? meta : null;
  }
  runtime.normalizeImageMeta = normalizeImageMeta;
  function normalizeOcrRequestMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "stitch" || text === "single-fallback" ? text : "single";
  }
  runtime.normalizeOcrRequestMode = normalizeOcrRequestMode;
  function normalizeStitchMeta(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    // New structure: canvasWidth/canvasHeight, owner segment with drawRect
    const canvasWidth = runtime.toNumber(value.canvasWidth || value.compositeWidth, 0);
    const canvasHeight = runtime.toNumber(value.canvasHeight || value.compositeHeight, 0);
    // Derive ownerTop/ownerHeight from owner.drawRect (new) or legacy flat fields
    const ownerDraw = value.owner && value.owner.drawRect;
    const ownerTop = runtime.toNumber(ownerDraw ? ownerDraw.y : value.ownerTop, -1);
    const ownerHeight = runtime.toNumber(ownerDraw ? ownerDraw.h : value.ownerHeight, 0);
    if (canvasWidth <= 0 || canvasHeight <= 0) {
      return null;
    }
    return {
      ownerTop,
      ownerHeight,
      canvasWidth,
      canvasHeight,
      overlap: runtime.toNumber(value.overlap, 0),
      sourceKeys: Array.isArray(value.sourceKeys) ? value.sourceKeys.map(entry => String(entry || "")) : []
    };
  }
  runtime.normalizeStitchMeta = normalizeStitchMeta;
  function getLocalOcrParams(settings = {}) {
    return {
      text_det_thresh: runtime.clampNumber(settings.localOcrDetThresh, 0.01, 0.99, runtime.DEFAULT_LOCAL_OCR_DET_THRESH),
      text_det_box_thresh: runtime.clampNumber(settings.localOcrDetBoxThresh, 0.01, 0.99, runtime.DEFAULT_LOCAL_OCR_DET_BOX_THRESH),
      text_det_unclip_ratio: runtime.clampNumber(settings.localOcrDetUnclipRatio, 1, 5, runtime.DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO),
      text_rec_score_thresh: runtime.clampNumber(settings.ocrConfidenceThreshold, 0, 1, 0)
    };
  }
  runtime.getLocalOcrParams = getLocalOcrParams;
  function getDefaultOcrTuning() {
    return {
      confidenceThreshold: runtime.DEFAULT_SETTINGS.ocrConfidenceThreshold,
      minBoxArea: runtime.DEFAULT_SETTINGS.ocrMinBoxArea,
      maxBoxArea: runtime.DEFAULT_SETTINGS.ocrMaxBoxArea,
      minBoxWidth: runtime.DEFAULT_SETTINGS.ocrMinBoxWidth,
      minBoxHeight: runtime.DEFAULT_SETTINGS.ocrMinBoxHeight,
      maxAspectRatio: runtime.DEFAULT_SETTINGS.ocrMaxAspectRatio,
      mergeLineGap: runtime.DEFAULT_SETTINGS.ocrMergeLineGap,
      novelImageMergeLines: runtime.DEFAULT_SETTINGS.ocrNovelImageMergeLines === true,
      fontScale: runtime.DEFAULT_SETTINGS.overwriteFontScale,
      coverPadding: runtime.DEFAULT_SETTINGS.overwriteCoverPadding,
      debugOverlayMode: runtime.DEFAULT_SETTINGS.debugOverlayMode,
      overwritePreviewMode: runtime.DEFAULT_SETTINGS.overwritePreviewMode,
      debugEnabled: false
    };
  }
  runtime.getDefaultOcrTuning = getDefaultOcrTuning;
  function getOcrTuning(settings = {}) {
    const defaults = runtime.getDefaultOcrTuning();
    return {
      confidenceThreshold: runtime.clampNumber(settings.ocrConfidenceThreshold, 0, 1, defaults.confidenceThreshold),
      minBoxArea: runtime.clampNumber(settings.ocrMinBoxArea, 0, 1000000, defaults.minBoxArea),
      maxBoxArea: runtime.clampNumber(settings.ocrMaxBoxArea, 0.001, 1, defaults.maxBoxArea),
      minBoxWidth: runtime.clampNumber(settings.ocrMinBoxWidth, 0, 10000, defaults.minBoxWidth),
      minBoxHeight: runtime.clampNumber(settings.ocrMinBoxHeight, 0, 10000, defaults.minBoxHeight),
      maxAspectRatio: runtime.clampNumber(settings.ocrMaxAspectRatio, 1, 100, defaults.maxAspectRatio),
      mergeLineGap: runtime.clampNumber(settings.ocrMergeLineGap, 0.2, 8, defaults.mergeLineGap),
      fontScale: runtime.clampNumber(settings.overwriteFontScale, 0.5, 2.5, defaults.fontScale),
      coverPadding: runtime.clampNumber(settings.overwriteCoverPadding, 0, 1.2, defaults.coverPadding),
      debugOverlayMode: runtime.normalizeDebugOverlayMode(settings.debugOverlayMode),
      overwritePreviewMode: runtime.normalizeOverwritePreviewMode(settings.overwritePreviewMode),
      debugEnabled: settings.localOcrDebug === true
    };
  }
  runtime.getOcrTuning = getOcrTuning;
  function normalizeDebugOverlayMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return runtime.DEBUG_OVERLAY_MODES.has(text) ? text : runtime.DEFAULT_SETTINGS.debugOverlayMode;
  }
  runtime.normalizeDebugOverlayMode = normalizeDebugOverlayMode;
  function normalizeOverwritePreviewMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return runtime.OVERWRITE_PREVIEW_MODES.has(text) ? text : runtime.DEFAULT_SETTINGS.overwritePreviewMode;
  }
  runtime.normalizeOverwritePreviewMode = normalizeOverwritePreviewMode;
  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, number));
  }
  runtime.clampNumber = clampNumber;
  function createOcrDebugSession(engine, imageSize, tuning, extras = {}) {
    return {
      version: 1,
      engine,
      imageWidth: Number(imageSize && imageSize.width) || 0,
      imageHeight: Number(imageSize && imageSize.height) || 0,
      params: {
        ...runtime.getDefaultOcrTuning(),
        ...(tuning || {})
      },
      rawItems: Array.isArray(extras.rawItems) ? extras.rawItems : [],
      filteredItems: [],
      dedupedItems: [],
      lineItems: [],
      mergedItems: [],
      duplicateItems: [],
      finalBubbles: [],
      filterReasons: []
    };
  }
  runtime.createOcrDebugSession = createOcrDebugSession;
  function getLocalOcrPayloadItems(payload, preferRaw = false) {
    if (preferRaw && payload && Array.isArray(payload.rawItems) && payload.rawItems.length > 0) {
      return payload.rawItems;
    }
    return payload && Array.isArray(payload.items) ? payload.items : payload && Array.isArray(payload.results) ? payload.results : payload && Array.isArray(payload.ocr) ? payload.ocr : [];
  }
  runtime.getLocalOcrPayloadItems = getLocalOcrPayloadItems;
  function keepOrTraceOcrWord(item, imageSize, tuning, debug, index, engine) {
    const reason = runtime.getOcrWordDropReason(item, imageSize, tuning);
    if (!reason) {
      return true;
    }
    runtime.traceFilterReason(debug, {
      stage: "filter",
      engine,
      index,
      dropReason: reason,
      reason,
      item: runtime.toDebugOcrItem(item, index, imageSize, "filtered")
    });
    return false;
  }
  runtime.keepOrTraceOcrWord = keepOrTraceOcrWord;
}
