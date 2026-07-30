export function installOcrDispatch(runtime) {
  function canonicalizeCleanedMaskPolygon(points) {
    const rotateFromSmallestPoint = input => {
      let smallestIndex = 0;
      for (let index = 1; index < input.length; index += 1) {
        const current = input[index];
        const smallest = input[smallestIndex];
        if (current.x < smallest.x || current.x === smallest.x && current.y < smallest.y) {
          smallestIndex = index;
        }
      }
      return [...input.slice(smallestIndex), ...input.slice(0, smallestIndex)];
    };
    const forward = rotateFromSmallestPoint(points);
    const reverse = rotateFromSmallestPoint([...points].reverse());
    return runtime.stableSerialize(forward) <= runtime.stableSerialize(reverse) ? forward : reverse;
  }
  runtime.canonicalizeCleanedMaskPolygon = canonicalizeCleanedMaskPolygon;
  function quantizeCleanedMaskCoordinate(value) {
    const clamped = Math.min(100, Math.max(0, Number(value) || 0));
    const quantized = Math.round(clamped * runtime.CLEANED_MASK_COORDINATE_SCALE) / runtime.CLEANED_MASK_COORDINATE_SCALE;
    return Object.is(quantized, -0) ? 0 : quantized;
  }
  runtime.quantizeCleanedMaskCoordinate = quantizeCleanedMaskCoordinate;
  function cleanedMaskPolygonArea(points) {
    let doubledArea = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      doubledArea += current.x * next.y - next.x * current.y;
    }
    return Math.abs(doubledArea) / 2;
  }
  runtime.cleanedMaskPolygonArea = cleanedMaskPolygonArea;
  function buildCleanedMasksFingerprint(value) {
    return runtime.stableHash128(`${runtime.CLEANED_MASK_FINGERPRINT_VERSION}|${runtime.stableSerialize(runtime.normalizeCleanedMasks(value))}`);
  }
  runtime.buildCleanedMasksFingerprint = buildCleanedMasksFingerprint;
  function normalizeObservationPixelBox(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const left = Number(value.left ?? value.x);
    const top = Number(value.top ?? value.y);
    const width = Number(value.width ?? value.w);
    const height = Number(value.height ?? value.h);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return null;
    }
    return {
      left,
      top,
      width,
      height
    };
  }
  runtime.normalizeObservationPixelBox = normalizeObservationPixelBox;
  function validateOcrOnlySettings(settings) {
    if (settings.provider === runtime.PROVIDERS.baidu) {
      return settings.baiduApiKey && settings.baiduSecretKey ? "" : "Baidu OCR AK/SK is missing. Please configure it in popup.";
    }
    if (settings.provider === runtime.PROVIDERS.localPaddle) {
      if (!settings.localOcrBaseUrl) {
        return "Local OCR service URL is missing. Please configure it in popup.";
      }
      if (settings.visionOcrEnabled && !settings.visionOcrApiKey) {
        return "Vision OCR API Key is missing. Please configure it in popup.";
      }
      return "";
    }
    return `Unsupported OCR provider: ${settings.provider}`;
  }
  runtime.validateOcrOnlySettings = validateOcrOnlySettings;
  async function digestDataUrlSha256(dataUrl) {
    const parsed = runtime.parseDataUrl(dataUrl);
    const binary = typeof atob === "function" ? atob(parsed.base64Data) : "";
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (globalThis.crypto && globalThis.crypto.subtle && bytes.length > 0) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    }
    // Chrome Service Worker 始终提供 WebCrypto；仅测试壳缺失该能力时使用完整载荷的确定性回退。
    return `fallback-${runtime.hashString(parsed.base64Data)}-${parsed.base64Data.length}`;
  }
  runtime.digestDataUrlSha256 = digestDataUrlSha256;
  function buildOcrCacheKey({
    request,
    settings
  }) {
    const source = runtime.stableSerialize({
      imageDigest: request && request.imageDigest || "",
      provider: settings && settings.provider || "",
      sourceType: request && request.sourceType || "page",
      pageIds: request && request.pageIds || [],
      imageRevisionByPage: request && request.imageRevisionByPage || {},
      geometryVersion: runtime.LOCAL_OCR_GEOMETRY_VERSION,
      coordinateModelVersion: runtime.OCR_COORDINATE_MODEL_VERSION,
      imageMeta: {
        width: Number(request && request.imageMeta && request.imageMeta.width) || 0,
        height: Number(request && request.imageMeta && request.imageMeta.height) || 0,
        pageSpans: request && request.imageMeta && request.imageMeta.pageSpans || []
      },
      ocr: {
        ignoreSimplifiedChinese: settings && settings.ignoreSimplifiedChinese === true,
        localOcrBaseUrl: settings && settings.localOcrBaseUrl || "",
        localOcrLang: settings && settings.localOcrLang || "",
        localOcrMode: settings && settings.localOcrMode || "",
        localOcrDetThresh: settings && settings.localOcrDetThresh || "",
        localOcrDetBoxThresh: settings && settings.localOcrDetBoxThresh || "",
        localOcrDetUnclipRatio: settings && settings.localOcrDetUnclipRatio || "",
        tuning: settings ? {
          confidenceThreshold: settings.ocrConfidenceThreshold,
          minBoxArea: settings.ocrMinBoxArea,
          maxBoxArea: settings.ocrMaxBoxArea,
          minBoxWidth: settings.ocrMinBoxWidth,
          minBoxHeight: settings.ocrMinBoxHeight,
          maxAspectRatio: settings.ocrMaxAspectRatio,
          mergeLineGap: settings.ocrMergeLineGap
        } : {},
        visionOcrEnabled: settings && settings.visionOcrEnabled === true,
        visionOcrBaseUrl: settings && settings.visionOcrBaseUrl || "",
        visionOcrModel: settings && settings.visionOcrModel || ""
      }
    });
    return `${runtime.OCR_CACHE_PREFIX}${String(request && request.imageDigest || "no-digest")}:${runtime.stableHash128(source)}`;
  }
  runtime.buildOcrCacheKey = buildOcrCacheKey;
  function stableSerialize(value) {
    if (Array.isArray(value)) {
      return `[${value.map(runtime.stableSerialize).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${runtime.stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }
  runtime.stableSerialize = stableSerialize;
  async function requestProviderNeutralOcr({
    request,
    settings
  }) {
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.requestProviderNeutralOcr === "function") {
      return runtime.backgroundTestHooks.requestProviderNeutralOcr({
        request,
        settings
      });
    }
    if (settings.provider === runtime.PROVIDERS.baidu) {
      return runtime.requestBaiduOcrObservations({
        request,
        settings
      });
    }
    if (settings.provider === runtime.PROVIDERS.localPaddle) {
      return runtime.requestLocalPaddleOcrObservations({
        request,
        settings
      });
    }
    throw new Error(`Unsupported OCR provider: ${settings.provider}`);
  }
  runtime.requestProviderNeutralOcr = requestProviderNeutralOcr;
  async function requestBaiduOcrObservations({
    request,
    settings
  }) {
    const imageSize = await runtime.decodeObservationImageSize(request.dataUrl, request.imageMeta);
    const ocrPayload = await runtime.requestBaiduAccurateOcr({
      dataUrl: request.dataUrl,
      apiKey: settings.baiduApiKey,
      secretKey: settings.baiduSecretKey
    });
    const ocrTuning = runtime.getOcrTuning(settings);
    const ocrDebug = runtime.createOcrDebugSession("baidu", imageSize, ocrTuning, {
      rawItems: Array.isArray(ocrPayload && ocrPayload.words_result) ? ocrPayload.words_result : []
    });
    const normalized = runtime.buildBaiduBubbleItems(ocrPayload, imageSize, ocrTuning, ocrDebug).map((item, index) => runtime.normalizeBaiduOcrItem(item, index, imageSize)).filter(Boolean);
    return runtime.buildProviderNeutralObservationResult({
      provider: "baidu",
      request,
      imageSize,
      normalized,
      ocrTuning,
      ocrDebug,
      ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese,
      serviceCounts: ocrPayload && ocrPayload.counts,
      debugOverlayMode: settings.debugOverlayMode,
      debug: settings.localOcrDebug === true
    });
  }
  runtime.requestBaiduOcrObservations = requestBaiduOcrObservations;
  async function requestLocalPaddleOcrObservations({
    request,
    settings
  }) {
    const imageSize = await runtime.decodeObservationImageSize(request.dataUrl, request.imageMeta);
    let mode = settings.localOcrMode || runtime.DEFAULT_LOCAL_OCR_MODE;
    if (mode === "enhanced" && imageSize.width * imageSize.height > 4000000) {
      mode = "fast";
    }
    const seamRows = request.sourceType === "seam"
      ? [...new Set((request.imageMeta?.pageSpans || []).flatMap(span => {
        const box = span?.canvasBox;
        return box ? [Number(box.top), Number(box.top) + Number(box.height)] : [];
      }).map(value => Math.round(value)).filter(value => value > 0 && value < imageSize.height))].sort((left, right) => left - right)
      : [];
    let ocrPayload = await runtime.requestLocalPaddleOcr({
      dataUrl: request.dataUrl,
      baseUrl: settings.localOcrBaseUrl || runtime.DEFAULT_LOCAL_OCR_BASE_URL,
      lang: settings.localOcrLang || runtime.DEFAULT_LOCAL_OCR_LANG,
      mode,
      params: runtime.getLocalOcrParams(settings),
      debug: settings.localOcrDebug === true,
      debugId: runtime.buildLocalOcrDebugId(request.targetKey || request.pageIds.join("-"), request.imageMeta),
      seamRows,
      returnCleanedImage: request.requireCleanedImage === true || request.forceCleanedImageArtifact === true,
      cleanedMasks: request.cleanedMasks
    });
    ocrPayload = runtime.collectSourceImageOcrPayload(ocrPayload, imageSize, request.imageMeta);
    const detectedById = new Map((Array.isArray(ocrPayload && ocrPayload.detectedRegions) ? ocrPayload.detectedRegions : []).map(region => [String(region && region.regionId || ""), region]));
    if (Array.isArray(ocrPayload && ocrPayload.items)) {
      ocrPayload.items = ocrPayload.items.map(item => ({
        ...item,
        detected_region: detectedById.get(String(item && item.region_id || "")) || null,
        line_thickness: Number(detectedById.get(String(item && item.region_id || ""))?.lineThickness) || 0
      }));
    }
    const coordinateImageSize = {
      width: Number(ocrPayload && ocrPayload.imageWidth) || imageSize.width,
      height: Number(ocrPayload && ocrPayload.imageHeight) || imageSize.height
    };
    const ocrTuning = runtime.getOcrTuning(settings);
    const ocrDebug = runtime.createOcrDebugSession("local_paddle", coordinateImageSize, ocrTuning, {
      rawItems: runtime.getLocalOcrPayloadItems(ocrPayload, true)
    });
    const items = await runtime.buildLocalPaddleBubbleItems(ocrPayload, coordinateImageSize, request.imageMeta && request.imageMeta.coordinateSpace === "source-image-v1" ? "" : request.dataUrl, settings.localOcrDebug === true, {
      apiKey: settings.visionOcrEnabled ? settings.visionOcrApiKey : "",
      baseUrl: settings.visionOcrEnabled ? settings.visionOcrBaseUrl || runtime.DEFAULT_QWEN_BASE_URL : "",
      model: settings.visionOcrEnabled ? settings.visionOcrModel || runtime.DEFAULT_VISION_OCR_MODEL : ""
    }, ocrTuning, ocrDebug, request.imageMeta);
    const normalized = items.map((item, index) => runtime.normalizeBaiduOcrItem(item, index, coordinateImageSize)).filter(Boolean);
    return runtime.buildProviderNeutralObservationResult({
      provider: "local_paddle",
      request,
      imageSize: coordinateImageSize,
      normalized,
      ocrTuning,
      ocrDebug,
      ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese,
      serviceCounts: ocrPayload && ocrPayload.counts,
      cleanedImage: ocrPayload && ocrPayload.cleanedImage,
      cleanedImageToken: ocrPayload && ocrPayload.cleanedMaskToken,
      debugOverlayMode: settings.debugOverlayMode,
      debug: settings.localOcrDebug === true
    });
  }
  runtime.requestLocalPaddleOcrObservations = requestLocalPaddleOcrObservations;
  async function decodeObservationImageSize(dataUrl, imageMeta) {
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.decodeImageSize === "function") {
      return runtime.backgroundTestHooks.decodeImageSize(dataUrl, imageMeta);
    }
    return runtime.decodeDataUrlImageSize(dataUrl);
  }
  runtime.decodeObservationImageSize = decodeObservationImageSize;
}
