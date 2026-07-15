export function installRecognitionOverlap(runtime) {
  function textSimilarity(first, second) {
    return runtime.KP.textSimilarity(first, second);
  }
  runtime.textSimilarity = textSimilarity;
  async function normalizeKakaopagePayload(target, payload, options = {}) {
    if (!runtime.IS_KAKAOPAGE_READER || !payload || !runtime.isSupportedTarget(target)) {
      return payload;
    }

    // Canonical 链路的单页 OCR 输入是权威证据：重复像素仅用于 seam 对齐，
    // 短页/碎图片也必须按自身完整字节独立进入 OCR。
    if (runtime.shouldUseKakaoCanonicalPipeline(target) && options.forceLegacyKakao !== true) {
      return payload;
    }
    const overlapCropped = await runtime.maybeCropKakaoOverlappedPayload(target, payload);
    if (overlapCropped) {
      return overlapCropped;
    }
    const rect = target.getBoundingClientRect();
    if (!runtime.KP.isKakaoStripPayload(payload, rect)) {
      return payload;
    }
    const captureRect = runtime.getVisibleViewportRect(target);
    if (!runtime.hasUsableKakaoStripCaptureRect(captureRect)) {
      // 页面滚动或虚拟列表重排可能让目标在提取期间只露出一小部分；这是可重试状态，不应上报为 OCR 错误。
      throw new Error(runtime.SCREENSHOT_TARGET_NOT_VISIBLE);
    }
    return runtime.captureVisibleTargetPayload(target, new Error("Kakao source image is a strip"), payload.imageUrl || "kakao-strip");
  }
  runtime.normalizeKakaopagePayload = normalizeKakaopagePayload;
  async function maybeCropKakaoOverlappedPayload(target, payload) {
    return runtime.KP.maybeCropKakaoOverlappedPayload(target, payload, {
      isReadyImageTarget: candidate => candidate instanceof HTMLImageElement && candidate.isConnected && candidate.complete,
      isDataUrl: runtime.isDataUrl,
      directCapture: runtime.state.captureMode === runtime.CAPTURE_MODE_DIRECT,
      collectCandidates: owner => runtime.collectKakaopageManualTargetCandidates(true, owner),
      describeTarget: runtime.describeKakaoStitchTarget,
      getNeighborPayload: runtime.getKakaoNeighborPayloadForOverlap,
      loadImage: runtime.loadImageFromDataUrl,
      sampleImage: runtime.sampleKakaoImageForOverlap,
      createCanvas: (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      getTargetRect: candidate => candidate.getBoundingClientRect(),
      getQuickSourceToken: runtime.getQuickSourceToken,
      imageJpegQuality: runtime.IMAGE_JPEG_QUALITY
    });
  }
  runtime.maybeCropKakaoOverlappedPayload = maybeCropKakaoOverlappedPayload;
  async function getKakaoNeighborPayloadForOverlap(target) {
    const targetKey = runtime.computeTargetKey(target);
    const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
    const cached = runtime.getPayloadCache(scopedTargetKey) || runtime.getPayloadCache(targetKey);
    if (cached && !cached.stitch && cached.kakaoOverlapCrop !== true && runtime.isDataUrl(cached.dataUrl)) {
      return cached;
    }
    return runtime.extractAdjacentKakaoPayload(target);
  }
  runtime.getKakaoNeighborPayloadForOverlap = getKakaoNeighborPayloadForOverlap;
  function sampleKakaoImageForOverlap(image) {
    const sourceWidth = image.naturalWidth || image.width || 0;
    const sourceHeight = image.naturalHeight || image.height || 0;
    if (!(sourceWidth > 0 && sourceHeight > 0)) {
      return null;
    }
    const width = runtime.KAKAO_OVERLAP_SAMPLE_WIDTH;
    const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true
    });
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return runtime.KP.computeGraySample({
      data: pixels,
      width,
      height
    });
  }
  runtime.sampleKakaoImageForOverlap = sampleKakaoImageForOverlap;
  function findKakaoVerticalOverlap(previousSample, currentSample) {
    return runtime.KP.findKakaoVerticalOverlap(previousSample, currentSample);
  }
  runtime.findKakaoVerticalOverlap = findKakaoVerticalOverlap;
}
