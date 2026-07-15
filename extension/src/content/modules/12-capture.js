export function installContent12(runtime) {
  function imageElementToDataUrl(img) {
    const srcWidth = img.naturalWidth || img.width || img.clientWidth;
    const srcHeight = img.naturalHeight || img.height || img.clientHeight;
    if (!srcWidth || !srcHeight) {
      throw new Error("Image size is unavailable");
    }
    const maxSide = runtime.IMAGE_MAX_SIDE;
    const longest = Math.max(srcWidth, srcHeight);
    const scale = longest > maxSide ? maxSide / longest : 1;
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    try {
      return canvas.toDataURL("image/jpeg", runtime.IMAGE_JPEG_QUALITY);
    } catch {
      return canvas.toDataURL("image/png");
    }
  }
  runtime.imageElementToDataUrl = imageElementToDataUrl;
  async function renderCachedKakaoPipelineResult({
    target,
    targetKey,
    scopedTargetKey,
    result
  }) {
    runtime.state.localResultCache.set(scopedTargetKey, result);
    if (result.bubbles.length === 0) {
      runtime.clearRenderedTarget(target);
      return;
    }
    if (runtime.shouldUseEmbeddedRender(target)) {
      runtime.renderLoadingOverlay(target, targetKey, "生成嵌入图片中...");
    }
    const payload = runtime.shouldUseEmbeddedRender(target) ? await runtime.extractTargetPayload(target, scopedTargetKey, {
      skipKakaoStitch: true
    }) : null;
    await runtime.renderTranslationResult(target, targetKey, result, payload);
  }
  runtime.renderCachedKakaoPipelineResult = renderCachedKakaoPipelineResult;
}
