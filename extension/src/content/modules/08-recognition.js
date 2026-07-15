export function installContent08(runtime) {
  async function buildKakaoSeamPayload(pageARecord, pageBRecord, options = {}) {
    const payloadA = pageARecord && pageARecord.payload;
    const payloadB = pageBRecord && pageBRecord.payload;
    const identityA = pageARecord && (pageARecord.identity || pageARecord.pageIdentity || pageARecord);
    const identityB = pageBRecord && (pageBRecord.identity || pageBRecord.pageIdentity || pageBRecord);
    if (!payloadA || !payloadB || !identityA || !identityB) return null;
    if (!runtime.isDataUrl(payloadA.dataUrl) || !runtime.isDataUrl(payloadB.dataUrl)) return null;
    const [imageA, imageB] = await Promise.all([runtime.loadImageFromDataUrl(payloadA.dataUrl), runtime.loadImageFromDataUrl(payloadB.dataUrl)]);
    const widthA = Number(identityA.width || imageA.naturalWidth || imageA.width || 0);
    const widthB = Number(identityB.width || imageB.naturalWidth || imageB.width || 0);
    const heightA = Number(identityA.height || imageA.naturalHeight || imageA.height || 0);
    const heightB = Number(identityB.height || imageB.naturalHeight || imageB.height || 0);
    const bitmapWidthA = Number(imageA.naturalWidth || imageA.width || 0);
    const bitmapWidthB = Number(imageB.naturalWidth || imageB.width || 0);
    const bitmapHeightA = Number(imageA.naturalHeight || imageA.height || 0);
    const bitmapHeightB = Number(imageB.naturalHeight || imageB.height || 0);
    if (!(widthA > 0 && widthB > 0 && heightA > 0 && heightB > 0)) return null;
    const requestedHeight = Number(options.height || options.bandHeight || 0);
    const bandHeight = runtime.calculateKakaoSeamCaptureBandHeight(widthA, widthB, requestedHeight);
    const sourceBandA = Math.min(heightA, bandHeight);
    const sourceBandB = Math.min(heightB, bandHeight);
    const bitmapBandA = Math.min(bitmapHeightA, sourceBandA * bitmapHeightA / heightA);
    const bitmapBandB = Math.min(bitmapHeightB, sourceBandB * bitmapHeightB / heightB);
    const canvasWidth = Math.max(1, Math.round(Math.min(widthA, widthB)));
    const drawnHeightA = Math.max(1, Math.round(sourceBandA * canvasWidth / widthA));
    const drawnHeightB = Math.max(1, Math.round(sourceBandB * canvasWidth / widthB));
    const overlap = options.overlap || null;
    const overlapRows = overlap && overlap.accepted ? Math.round(Number(overlap.rows || 0) / Math.max(1, Number(overlap.currentRows || 1)) * drawnHeightB) : 0;
    const alignedOverlap = Math.max(0, Math.min(overlapRows, drawnHeightA - 1, drawnHeightB - 1));
    const canvasHeight = drawnHeightA + drawnHeightB - alignedOverlap;
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext("2d", {
      alpha: false
    });
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.drawImage(imageA, 0, bitmapHeightA - bitmapBandA, bitmapWidthA, bitmapBandA, 0, 0, canvasWidth, drawnHeightA);
    context.drawImage(imageB, 0, 0, bitmapWidthB, bitmapBandB, 0, drawnHeightA - alignedOverlap, canvasWidth, drawnHeightB);
    const pageIds = [String(identityA.pageId), String(identityB.pageId)];
    const imageRevisionByPage = {
      [pageIds[0]]: String(identityA.imageRevision || ""),
      [pageIds[1]]: String(identityB.imageRevision || "")
    };
    const segments = [{
      pageId: pageIds[0],
      drawRect: {
        x: 0,
        y: 0,
        w: canvasWidth,
        h: drawnHeightA
      },
      sourceCrop: {
        x: 0,
        y: heightA - sourceBandA,
        w: widthA,
        h: sourceBandA
      },
      naturalWidth: widthA,
      naturalHeight: heightA
    }, {
      pageId: pageIds[1],
      drawRect: {
        x: 0,
        y: drawnHeightA - alignedOverlap,
        w: canvasWidth,
        h: drawnHeightB
      },
      sourceCrop: {
        x: 0,
        y: 0,
        w: widthB,
        h: sourceBandB
      },
      naturalWidth: widthB,
      naturalHeight: heightB
    }];
    const pageSpans = segments.map(segment => ({
      pageId: segment.pageId,
      canvasBox: {
        x: segment.drawRect.x,
        y: segment.drawRect.y,
        w: segment.drawRect.w,
        h: segment.drawRect.h
      },
      pageBox: {
        x: segment.sourceCrop.x,
        y: segment.sourceCrop.y,
        w: segment.sourceCrop.w,
        h: segment.sourceCrop.h
      },
      pageWidth: segment.naturalWidth,
      pageHeight: segment.naturalHeight
    }));
    return {
      dataUrl: canvas.toDataURL("image/jpeg", runtime.IMAGE_JPEG_QUALITY),
      imageUrl: `kakao-seam:${pageIds.join("+")}`,
      width: canvasWidth,
      height: canvasHeight,
      sourceWidth: canvasWidth,
      sourceHeight: canvasHeight,
      cssWidth: canvasWidth,
      cssHeight: canvasHeight,
      source: "kakao-seam",
      sourceType: "seam",
      ocrMode: "seam",
      pageIds,
      imageRevisionByPage,
      pageSpans,
      seam: {
        bandHeight,
        alignedOverlap,
        canvasWidth,
        canvasHeight,
        segments
      },
      coordinateSpace: "kakao-seam-v1"
    };
  }
  runtime.buildKakaoSeamPayload = buildKakaoSeamPayload;
  function buildOcrMessageForPayload(payload, context = {}) {
    const sourceType = context.sourceType === "seam" ? "seam" : "page";
    const pageIds = Array.isArray(context.pageIds) ? context.pageIds.map(String) : [];
    const imageRevisionByPage = context.imageRevisionByPage && typeof context.imageRevisionByPage === "object" ? context.imageRevisionByPage : {};
    return {
      type: "OCR_DATA_URL",
      dataUrl: payload && payload.dataUrl,
      imageUrl: payload && payload.imageUrl,
      targetKey: String(context.requestKey || ""),
      ocrMode: String(payload && payload.ocrMode || (sourceType === "seam" ? "seam" : "single")),
      sourceToken: String(payload && payload.sourceToken || ""),
      sourceType,
      pageIds,
      imageRevision: String(context.imageRevision || pageIds[0] && imageRevisionByPage[pageIds[0]] || ""),
      imageRevisionByPage,
      requireCleanedImage: context.requireCleanedImage === true,
      forceCleanedImageArtifact: context.forceCleanedImageArtifact === true,
      cleanedMasks: Array.isArray(context.cleanedMasks) ? context.cleanedMasks : [],
      imageMeta: {
        ...runtime.buildPayloadImageMeta(payload),
        ...(context.imageMeta || {}),
        sourceType,
        pageIds,
        imageRevisionByPage,
        pageSpans: payload && payload.pageSpans || context.imageMeta && context.imageMeta.pageSpans || null,
        seam: payload && payload.seam || null
      }
    };
  }
  runtime.buildOcrMessageForPayload = buildOcrMessageForPayload;
  async function requestOcrForPayload(payload, context = {}) {
    const message = runtime.buildOcrMessageForPayload(payload, context);
    const response = await runtime.sendRuntimeMessage(message);
    if (!response || !response.ok) return response;
    const result = runtime.normalizeOcrObservationResult(response.result, {
      sourceType: message.sourceType,
      pageIds: message.pageIds,
      imageRevisionByPage: message.imageRevisionByPage
    });
    return {
      ...response,
      result
    };
  }
  runtime.requestOcrForPayload = requestOcrForPayload;
  function normalizeOcrObservationResult(result, fallback = {}) {
    const normalizeObservation = (observation, filtered = false) => {
      const {
        translated_text: _legacyTranslatedText,
        translatedText: _legacyTranslatedTextCamel,
        ...evidence
      } = observation && typeof observation === "object" ? observation : {};
      const originalText = runtime.cleanRenderableText(observation && (observation.originalText || observation.original_text) || "");
      return Object.freeze({
        ...evidence,
        id: String(observation && (observation.id || observation.block_id) || ""),
        sourceType: observation && observation.sourceType === "seam" ? "seam" : String(fallback.sourceType || "page"),
        pageIds: Array.isArray(observation && observation.pageIds) ? observation.pageIds.map(String) : Array.from(fallback.pageIds || [], String),
        imageRevisionByPage: observation && observation.imageRevisionByPage || fallback.imageRevisionByPage || {},
        originalText,
        original_text: originalText,
        confidence: Number(observation && observation.confidence || 0),
        ...(filtered ? {
          filterReason: String(observation && observation.filterReason || "unspecified")
        } : {})
      });
    };
    const observations = Array.isArray(result && result.observations) ? result.observations.map(item => normalizeObservation(item, false)) : [];
    const filteredObservations = Array.isArray(result && result.filteredObservations) ? result.filteredObservations.map(item => normalizeObservation(item, true)) : [];
    return {
      ...(result || {}),
      observations,
      filteredObservations,
      edgeSignals: result && result.edgeSignals && typeof result.edgeSignals === "object" ? result.edgeSignals : {
        top: false,
        bottom: false
      },
      counts: result && result.counts || {
        eligible: observations.length,
        filtered: filteredObservations.length
      }
    };
  }
  runtime.normalizeOcrObservationResult = normalizeOcrObservationResult;
  async function requestCanonicalTranslations(items, context = {}) {
    const requestItems = (Array.isArray(items) ? items : []).map(item => ({
      id: String(item && item.id || ""),
      revision: Math.max(1, Number(item && item.revision || 1)),
      original_text: String(item && (item.original_text || item.originalText) || ""),
      non_translate: item && (item.non_translate === true || item.nonTranslate === true)
    })).filter(item => item.id && item.original_text);
    if (requestItems.length === 0) {
      return {
        ok: true,
        result: {
          translations: [],
          errors: [],
          partial: false
        }
      };
    }
    const response = await runtime.sendRuntimeMessage({
      type: "TRANSLATE_TEXT_BLOCKS",
      sourceLanguage: String(context.sourceLanguage || runtime.KAKAO_CANONICAL_SOURCE_LANGUAGE),
      targetLanguage: String(context.targetLanguage || runtime.KAKAO_CANONICAL_TARGET_LANGUAGE),
      items: requestItems
    });
    if (!response) return response;
    const translations = Array.isArray(response.translations) ? response.translations : Array.isArray(response.result && response.result.translations) ? response.result.translations : [];
    const errors = Array.isArray(response.errors) ? response.errors : Array.isArray(response.result && response.result.errors) ? response.result.errors : [];
    if (!response.ok && !(response.partial === true && translations.length > 0)) {
      return response;
    }
    const normalized = {
      translations: translations.map(item => ({
        ...item,
        id: String(item && item.id || ""),
        revision: Math.max(1, Number(item && item.revision || 1)),
        translated_text: runtime.cleanRenderableText(item && item.translated_text || ""),
        translationFingerprint: String(item && item.translationFingerprint || ""),
        cached: item && item.cached === true
      })).filter(item => item.id && item.translated_text),
      errors,
      partial: response.partial === true || response.result && response.result.partial === true || errors.length > 0
    };
    return {
      ...response,
      ok: true,
      partial: normalized.partial,
      result: normalized
    };
  }
  runtime.requestCanonicalTranslations = requestCanonicalTranslations;
  function shouldUseKakaoStitchedOcr(target, payload) {
    return runtime.IS_KAKAOPAGE_READER && runtime.state.captureMode === runtime.CAPTURE_MODE_DIRECT && runtime.state.renderMode === runtime.RENDER_MODE_OVERLAY && target instanceof HTMLImageElement && payload && payload.kakaoOverlapCrop !== true && runtime.isDataUrl(payload.dataUrl);
  }
  runtime.shouldUseKakaoStitchedOcr = shouldUseKakaoStitchedOcr;
  async function buildKakaoStitchedPayload(target, ownerPayload) {
    return runtime.KP.buildKakaoStitchedPayload(target, ownerPayload, {
      collectCandidates: owner => runtime.collectKakaopageManualTargetCandidates(true, owner),
      isReadyImageTarget: candidate => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete,
      describeTarget: runtime.describeKakaoStitchTarget,
      extractAdjacentPayload: runtime.extractAdjacentKakaoPayload,
      loadImage: runtime.loadImageFromDataUrl,
      createCanvas: (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      imageMaxSide: runtime.IMAGE_MAX_SIDE,
      imageJpegQuality: runtime.IMAGE_JPEG_QUALITY,
      computeTargetKey: runtime.computeTargetKey,
      getQuickSourceToken: runtime.getQuickSourceToken,
      buildTargetSourceCacheKey: runtime.buildTargetSourceCacheKey
    });
  }
  runtime.buildKakaoStitchedPayload = buildKakaoStitchedPayload;
  function buildOcrRequestKey(targetKey, payload) {
    return runtime.KP.buildOcrRequestKey(targetKey, payload);
  }
  runtime.buildOcrRequestKey = buildOcrRequestKey;
  function shouldRejectKakaoPageEdgeStitch({
    owner,
    ownerHeight,
    canonicalWidth,
    previous,
    next,
    previousHeight,
    nextHeight
  } = {}) {
    return runtime.KP.shouldRejectKakaoPageEdgeStitch({
      owner,
      ownerHeight,
      canonicalWidth,
      previous,
      next,
      previousHeight,
      nextHeight
    });
  }
  runtime.shouldRejectKakaoPageEdgeStitch = shouldRejectKakaoPageEdgeStitch;
  function isKakaoEdgeUrlMissingAuth(url) {
    if (!url) return false;
    return runtime.isKakaoPageEdgeSource(url) && !runtime.KAKAO_EDGE_AUTH_PARAM_RE.test(url);
  }
  runtime.isKakaoEdgeUrlMissingAuth = isKakaoEdgeUrlMissingAuth;
  async function resolveImageUrlWithAuth(target) {
    let url = runtime.resolveImageUrl(target);
    if (!runtime.isKakaoEdgeUrlMissingAuth(url)) {
      return url;
    }
    // Poll currentSrc for auth params to appear (page JS adds them asynchronously)
    const deadline = Date.now() + runtime.KAKAO_EDGE_URL_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, runtime.KAKAO_EDGE_URL_POLL_MS));
      if (!target.isConnected) break;
      url = runtime.resolveImageUrl(target);
      if (!runtime.isKakaoEdgeUrlMissingAuth(url)) {
        return url;
      }
    }
    // Return whatever we have, even if auth params are still missing.
    // The background fetch will retry with different credential modes.
    console.warn("[MangaTranslator][KakaoPage] page-edge URL still missing auth params after wait, proceeding with:", url.slice(0, 120));
    return url;
  }
  runtime.resolveImageUrlWithAuth = resolveImageUrlWithAuth;
}
