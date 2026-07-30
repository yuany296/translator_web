export function installOcrProvider(runtime) {
  function collectSourceImageOcrPayload(payload, cropImageSize, imageMeta) {
    if (!payload || !imageMeta || imageMeta.stitch || imageMeta.coordinateSpace !== "source-image-v1" || !imageMeta.sourceImageId || imageMeta.sourceWidth <= 0 || imageMeta.sourceHeight <= 0 || imageMeta.targetCssWidth <= 0 || imageMeta.targetCssHeight <= 0) {
      return payload;
    }
    const mappedItems = runtime.getLocalOcrPayloadItems(payload).map(item => runtime.mapOcrItemToSourceImageCoordinates(item, cropImageSize, imageMeta)).filter(Boolean);
    const now = Date.now();
    for (const [key, session] of runtime.ocrLinesBySourceImageId.entries()) {
      if (!session || now - session.updatedAt > 10 * 60 * 1000) {
        runtime.ocrLinesBySourceImageId.delete(key);
      }
    }
    const existing = runtime.ocrLinesBySourceImageId.get(imageMeta.sourceImageId);
    const items = [...(existing && existing.items || []), ...mappedItems].slice(-800);
    runtime.ocrLinesBySourceImageId.set(imageMeta.sourceImageId, {
      items,
      updatedAt: now
    });
    return {
      ...payload,
      items,
      rawItems: items,
      imageWidth: imageMeta.sourceWidth,
      imageHeight: imageMeta.sourceHeight,
      counts: {
        ...(payload.counts || {}),
        source_image_lines: items.length,
        current_crop_lines: mappedItems.length
      }
    };
  }
  runtime.collectSourceImageOcrPayload = collectSourceImageOcrPayload;
  function mapOcrItemToSourceImageCoordinates(item, cropImageSize, imageMeta) {
    const cropWidth = Math.max(1, Number(cropImageSize && cropImageSize.width) || 1);
    const cropHeight = Math.max(1, Number(cropImageSize && cropImageSize.height) || 1);
    const scaleX = imageMeta.cropCssWidth / cropWidth;
    const scaleY = imageMeta.cropCssHeight / cropHeight;
    const toSourcePoint = (x, y) => ({
      x: (imageMeta.cropCssX + Number(x) * scaleX) / imageMeta.targetCssWidth * imageMeta.sourceWidth,
      y: (imageMeta.cropCssY + Number(y) * scaleY) / imageMeta.targetCssHeight * imageMeta.sourceHeight
    });
    const box = runtime.normalizeDebugBox(item && (item.box || item.location));
    if (!box) {
      return null;
    }
    const topLeft = toSourcePoint(box.left, box.top);
    const bottomRight = toSourcePoint(box.left + box.width, box.top + box.height);
    const mapPolygon = value => Array.isArray(value) ? value.map(point => {
      const x = Array.isArray(point) ? point[0] : point && point.x;
      const y = Array.isArray(point) ? point[1] : point && point.y;
      const mapped = toSourcePoint(x, y);
      return [mapped.x, mapped.y];
    }) : null;
    const regionBox = runtime.normalizeDebugBox(item && item.region_box);
    let mappedRegionBox = null;
    if (regionBox) {
      const regionTopLeft = toSourcePoint(regionBox.left, regionBox.top);
      const regionBottomRight = toSourcePoint(regionBox.left + regionBox.width, regionBox.top + regionBox.height);
      mappedRegionBox = {
        left: regionTopLeft.x,
        top: regionTopLeft.y,
        width: regionBottomRight.x - regionTopLeft.x,
        height: regionBottomRight.y - regionTopLeft.y
      };
    }
    return {
      ...item,
      region_id: item && item.region_id ? `slice-${Math.round(imageMeta.cropCssX)}-${Math.round(imageMeta.cropCssY)}:${item.region_id}` : "",
      box: {
        left: topLeft.x,
        top: topLeft.y,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y
      },
      polygon: mapPolygon(item && item.polygon),
      region_polygon: mapPolygon(item && item.region_polygon),
      region_box: mappedRegionBox
    };
  }
  runtime.mapOcrItemToSourceImageCoordinates = mapOcrItemToSourceImageCoordinates;
  function buildOcrBlockId(sourceImageId, item) {
    const bbox = [item.x, item.y, item.w, item.h].map(value => Math.round(Number(value || 0) * 10) / 10).join(",");
    return `block-${runtime.hashString(`${sourceImageId}|${runtime.normalizeTextForLocalPaddle(item.original_text)}|${bbox}`)}`;
  }
  runtime.buildOcrBlockId = buildOcrBlockId;
  async function requestLocalPaddleOcr({
    dataUrl,
    baseUrl,
    lang,
    mode,
    params,
    debug,
    debugId,
    returnCleanedImage = false,
    cleanedMasks = [],
    requestTimeoutMs = runtime.LOCAL_OCR_REQUEST_TIMEOUT_MS
  }) {
    const endpoint = `${runtime.sanitizeLocalOcrBaseUrl(baseUrl)}/ocr`;
    const timeoutMs = Math.max(1, Number(requestTimeoutMs) || runtime.LOCAL_OCR_REQUEST_TIMEOUT_MS);
    const normalizedCleanedMasks = runtime.normalizeCleanedMasks(cleanedMasks);
    const cleanedMaskToken = returnCleanedImage === true ? runtime.buildCleanedMasksFingerprint(normalizedCleanedMasks) : "";
    try {
      const {
        response,
        payload
      } = await runtime.fetchJsonWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          image: dataUrl,
          lang: runtime.normalizeLocalOcrLang(lang),
          mode: runtime.normalizeLocalOcrMode(mode),
          text_det_thresh: runtime.normalizeLocalOcrNumber(params && params.text_det_thresh, runtime.DEFAULT_LOCAL_OCR_DET_THRESH),
          text_det_box_thresh: runtime.normalizeLocalOcrNumber(params && params.text_det_box_thresh, runtime.DEFAULT_LOCAL_OCR_DET_BOX_THRESH),
          text_det_unclip_ratio: runtime.normalizeLocalOcrNumber(params && params.text_det_unclip_ratio, runtime.DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO),
          text_rec_score_thresh: runtime.normalizeLocalOcrNumber(params && params.text_rec_score_thresh, 0),
          debug: debug === true,
          debug_id: debugId || "",
          ocr_geometry_version: runtime.LOCAL_OCR_GEOMETRY_VERSION,
          return_cleaned_image: returnCleanedImage === true,
          cleaned_masks: normalizedCleanedMasks,
          cleaned_mask_token: cleanedMaskToken
        })
      }, {
        timeoutMs,
        timeoutMessage: "本地 OCR 服务请求超时，请确认 local-ocr-service 正在运行"
      });
      if (!response.ok) {
        const message = payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
        throw new Error(`Local OCR request failed: ${message}`);
      }
      if (!payload || typeof payload !== "object") {
        throw new Error("本地 OCR 服务返回了无效 JSON");
      }
      if (String(payload.ocrGeometryVersion || "") !== runtime.LOCAL_OCR_GEOMETRY_VERSION) {
        throw new Error("本地 OCR 服务版本过旧，请重启 local-ocr-service 后重试");
      }
      if (cleanedMaskToken && String(payload.cleanedMaskToken || "") !== cleanedMaskToken) {
        throw new Error("本地 OCR 服务未确认跨页清理范围，请重启 local-ocr-service 后重试");
      }
      console.debug("[MangaTranslator][OCR] Server response items:", payload && Array.isArray(payload.items) ? payload.items.length : 0, "boxes:", payload && Array.isArray(payload.boxes) ? payload.boxes.length : 0, "imageWidth:", payload && payload.imageWidth, "imageHeight:", payload && payload.imageHeight);
      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("本地 OCR 服务请求超时，请确认 local-ocr-service 正在运行");
      }
      const message = error && error.message ? error.message : String(error || "unknown error");
      if (/failed to fetch/i.test(message)) {
        throw new Error("本地 OCR 服务不可用，请先启动 local-ocr-service");
      }
      throw error;
    }
  }
  runtime.requestLocalPaddleOcr = requestLocalPaddleOcr;
  async function buildLocalPaddleBubbleItems(payload, imageSize, dataUrl, debug, visionOcrOptions = null, ocrTuning = runtime.getDefaultOcrTuning(), ocrDebug = null, imageMeta = null) {
    const ocrImageSize = {
      width: Number(payload && payload.imageWidth) || Number(imageSize && imageSize.width) || 1,
      height: Number(payload && payload.imageHeight) || Number(imageSize && imageSize.height) || 1
    };
    const sourceItems = runtime.getLocalOcrPayloadItems(payload);
    console.debug("[MangaTranslator][buildBubbles] sourceItems count:", sourceItems.length, "imageSize:", ocrImageSize);
    if (sourceItems.length === 0) {
      console.warn("[MangaTranslator][buildBubbles] OCR returned zero items, ocrPayload keys:", Object.keys(payload || {}));
    }
    if (ocrDebug) {
      const debugSourceItems = runtime.getLocalOcrPayloadItems(payload, true);
      ocrDebug.rawItems = debugSourceItems.map((item, index) => runtime.toDebugOcrItem(item, index, ocrImageSize, "raw"));
    }
    let words = sourceItems.map(item => runtime.normalizeLocalPaddleOcrItem(item, ocrImageSize)).filter(Boolean).filter((item, index) => runtime.keepOrTraceOcrWord(item, ocrImageSize, ocrTuning, ocrDebug, index, "local_paddle"));
    words = await runtime.repairLowConfidenceLocalPaddleWordsWithVision(words, dataUrl, ocrImageSize, visionOcrOptions, debug);
    const imageAnalysis = await runtime.analyzeLocalOcrImage(dataUrl, ocrImageSize);
    // 跨图窗口聚类全部 OCR 行；归属判断统一由 content.js 在 mapKakaoStitchedResult() 中处理。
    // 不在此处用 isOcrItemOwnedByStitch 过滤，避免按单行中心误拆跨页框。
    const clustered = runtime.clusterLocalPaddleWords(words, ocrImageSize, imageAnalysis, debug, ocrDebug, {
      preserveLineGroups: Array.isArray(imageMeta && imageMeta.pageSpans) && imageMeta.pageSpans.length === 2
    });
    // Stitch ownership filtering is now handled exclusively by content.js mapKakaoStitchedResult()
    if (imageMeta && imageMeta.stitch) {
      if (debug) {
        console.debug("[MangaTranslator][KakaoStitch] Background: passing all clustered items to content.js for ownership filtering", {
          clusteredCount: clustered.length,
          stitchKeys: (imageMeta.stitch.sourceKeys || []).join(",")
        });
      }
    }
    if (ocrDebug) {
      ocrDebug.filteredItems = words.map((item, index) => runtime.toDebugOcrItem(item, index, ocrImageSize, "filtered"));
      ocrDebug.mergedItems = clustered.map((item, index) => runtime.toDebugOcrItem(item, index, ocrImageSize, "merged"));
    }
    if (debug) {
      console.info("[MangaTranslator][OCR chain]", {
        frontendReceivedItems: sourceItems.length,
        frontendNormalizedItems: words.length,
        frontendMergedBlocks: clustered.length,
        serviceCounts: payload && payload.counts ? payload.counts : null,
        debugPaths: payload && payload.debug ? payload.debug : null
      });
    }
    return clustered;
  }
  runtime.buildLocalPaddleBubbleItems = buildLocalPaddleBubbleItems;
  async function analyzeLocalOcrImage(dataUrl, imageSize) {
    if (!runtime.isDataUrl(dataUrl) || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return null;
    }
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      try {
        const sourceWidth = Math.max(1, Number(imageSize && imageSize.width) || bitmap.width || 1);
        const sourceHeight = Math.max(1, Number(imageSize && imageSize.height) || bitmap.height || 1);
        const scale = Math.min(1, runtime.LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return null;
        }
        ctx.drawImage(bitmap, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        const sample = {
          data: imageData.data,
          width,
          height,
          scale,
          sourceWidth,
          sourceHeight
        };
        return {
          sample
        };
      } finally {
        if (typeof bitmap.close === "function") {
          bitmap.close();
        }
      }
    } catch (error) {
      console.warn("[MangaTranslator] Local OCR image analysis failed:", error);
      return null;
    }
  }
  runtime.analyzeLocalOcrImage = analyzeLocalOcrImage;
  async function repairLowConfidenceLocalPaddleWordsWithVision(words, dataUrl, imageSize, options, debug) {
    if (!runtime.shouldUseVisionCropOcr(options) || !Array.isArray(words) || words.length === 0) {
      return words;
    }
    const groups = runtime.buildVisionCropOcrGroups(words, imageSize).slice(0, 8);
    if (groups.length === 0) {
      return words;
    }
    const usedIndexes = new Set();
    const replacements = [];
    const deadlineAt = Date.now() + runtime.VISION_OCR_REPAIR_BUDGET_MS;
    for (const group of groups) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        if (debug) console.warn("[MangaTranslator] Vision OCR repair budget exhausted");
        break;
      }
      const box = runtime.getBaiduGroupBox(group.map(entry => entry.item));
      if (!box) {
        continue;
      }
      try {
        const cropDataUrl = await runtime.cropDataUrlByImageBox(dataUrl, box, imageSize);
        const recognized = await runtime.requestVisionCropOcr({
          dataUrl: cropDataUrl,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          model: options.model,
          requestTimeoutMs: Math.min(runtime.VISION_OCR_REQUEST_TIMEOUT_MS, remainingMs)
        });
        if (!runtime.isUsableVisionCropOcrText(recognized)) {
          continue;
        }
        group.forEach(entry => usedIndexes.add(entry.index));
        replacements.push({
          words: recognized,
          confidence: 0.99,
          rawBox: {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height
          },
          location: {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height
          },
          visionOcr: true,
          visionOcrOriginal: group.map(entry => entry.text).join(" ")
        });
        if (debug) {
          console.info("[MangaTranslator][OCR chain] vision crop repaired", {
            from: group.map(entry => ({
              text: entry.text,
              confidence: entry.confidence,
              box: entry.box
            })),
            to: recognized,
            box
          });
        }
      } catch (error) {
        if (debug) {
          console.warn("[MangaTranslator][OCR chain] vision crop OCR failed:", runtime.getErrorMessage(error));
        }
      }
    }
    if (replacements.length === 0) {
      return words;
    }
    return words.filter((item, index) => !usedIndexes.has(index)).concat(replacements).sort(runtime.compareBaiduWordItems);
  }
  runtime.repairLowConfidenceLocalPaddleWordsWithVision = repairLowConfidenceLocalPaddleWordsWithVision;
  function shouldUseVisionCropOcr(options) {
    if (!options || !options.apiKey || !options.model || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return false;
    }
    const model = String(options.model || "").toLowerCase();
    const baseUrl = String(options.baseUrl || "").toLowerCase();
    if (/deepseek-chat|deepseek-reasoner/.test(model)) {
      return false;
    }
    return /vision|vl|qwen.*vl|gpt-4o|gpt-4\.1|gemini|claude|pixtral|llava|omni/.test(model + " " + baseUrl);
  }
  runtime.shouldUseVisionCropOcr = shouldUseVisionCropOcr;
}
