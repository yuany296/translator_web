export function installRendererEmbed(runtime) {
  async function renderEmbeddedTranslation(target, targetKey, result, payload) {
    const bubbles = Array.isArray(result.bubbles) ? result.bubbles : [];
    const renderPayload = runtime.isDataUrl(result.cleanedImage) ? { ...payload, cleanedImage: result.cleanedImage } : payload;
    if (bubbles.length === 0) {
      runtime.clearRenderedTarget(target);
      return;
    }
    if (target instanceof HTMLImageElement) {
      await runtime.renderEmbeddedImageTarget(target, targetKey, bubbles, renderPayload);
      return;
    }
    if (target instanceof HTMLCanvasElement) {
      await runtime.renderEmbeddedCanvasTarget(target, targetKey, bubbles, renderPayload);
      return;
    }
    if (runtime.isBackgroundImageTarget(target)) {
      await runtime.renderEmbeddedBackgroundTarget(target, targetKey, bubbles, renderPayload);
      return;
    }
    throw new Error("Unsupported embedded render target");
  }
  runtime.renderEmbeddedTranslation = renderEmbeddedTranslation;
  async function renderEmbeddedImageTarget(img, targetKey, bubbles, payload) {
    const targetId = runtime.getTargetId(img);
    const cachedDataUrl = runtime.state.embeddedImageCache.get(targetKey);
    const baseDataUrl = runtime.isDataUrl(payload?.cleanedImage) ? payload.cleanedImage : await runtime.getEmbeddedBaseDataUrl(img, payload);
    const outputDataUrl = cachedDataUrl || (await runtime.composeEmbeddedImageDataUrl(baseDataUrl, bubbles));
    if (!cachedDataUrl) {
      runtime.rememberEmbeddedImageCache(targetKey, outputDataUrl);
    }
    const existing = runtime.state.embeddedById.get(targetId);
    if (existing && existing.kind !== "image") {
      runtime.restoreEmbeddedForTarget(img);
    }
    if (!img.dataset.mtEmbeddedOriginalSource) {
      img.dataset.mtEmbeddedOriginalSource = runtime.resolveImageUrl(img);
    }
    if (!img.dataset.mtEmbeddedOriginalSrc) {
      img.dataset.mtEmbeddedOriginalSrc = img.getAttribute("src") || "";
    }
    if (!img.dataset.mtEmbeddedOriginalSrcset) {
      img.dataset.mtEmbeddedOriginalSrcset = img.getAttribute("srcset") || "";
    }
    img.dataset.mtEmbeddedActive = "true";
    img.dataset.mtEmbeddedOutputKey = targetKey;
    img.removeAttribute("srcset");
    img.src = outputDataUrl;
    runtime.state.embeddedById.set(targetId, {
      target: img,
      targetId,
      targetKey,
      kind: "image",
      mode: "embedded",
      bubbleCount: bubbles.length
    });
  }
  runtime.renderEmbeddedImageTarget = renderEmbeddedImageTarget;
  async function renderEmbeddedCanvasTarget(canvas, targetKey, bubbles, payload) {
    const targetId = runtime.getTargetId(canvas);
    const existing = runtime.state.embeddedById.get(targetId);
    const originalDataUrl = runtime.isDataUrl(payload?.cleanedImage) ? payload.cleanedImage : existing && existing.kind === "canvas" && existing.originalDataUrl ? existing.originalDataUrl : payload && runtime.isDataUrl(payload.dataUrl) ? payload.dataUrl : "";
    if (!originalDataUrl) {
      throw new Error("Canvas original image is unavailable for embedded rendering");
    }
    const image = await runtime.loadImageFromDataUrl(originalDataUrl);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    runtime.drawEmbeddedBubbles(ctx, canvas.width, canvas.height, bubbles);
    ctx.restore();
    runtime.state.embeddedById.set(targetId, {
      target: canvas,
      targetId,
      targetKey,
      kind: "canvas",
      mode: "embedded",
      bubbleCount: bubbles.length,
      originalDataUrl
    });
  }
  runtime.renderEmbeddedCanvasTarget = renderEmbeddedCanvasTarget;
  async function renderEmbeddedBackgroundTarget(target, targetKey, bubbles, payload) {
    const targetId = runtime.getTargetId(target);
    const cachedDataUrl = runtime.state.embeddedImageCache.get(targetKey);
    const baseDataUrl = runtime.isDataUrl(payload?.cleanedImage) ? payload.cleanedImage : payload && runtime.isDataUrl(payload.dataUrl) ? payload.dataUrl : "";
    const originalSource = runtime.resolveBackgroundImageUrl(target);
    if (!baseDataUrl) {
      throw new Error("Background image is unavailable for embedded rendering");
    }
    const outputDataUrl = cachedDataUrl || (await runtime.composeEmbeddedImageDataUrl(baseDataUrl, bubbles));
    if (!cachedDataUrl) {
      runtime.rememberEmbeddedImageCache(targetKey, outputDataUrl);
    }
    const existing = runtime.state.embeddedById.get(targetId);
    if (existing && existing.kind !== "background") {
      runtime.restoreEmbeddedForTarget(target);
    }
    if (!target.dataset.mtEmbeddedOriginalBackground) {
      target.dataset.mtEmbeddedOriginalBackground = target.style.backgroundImage || "";
    }
    if (!target.dataset.mtEmbeddedOriginalBackgroundSource) {
      target.dataset.mtEmbeddedOriginalBackgroundSource = originalSource;
    }
    target.dataset.mtEmbeddedActive = "true";
    target.dataset.mtEmbeddedOutputKey = targetKey;
    target.style.backgroundImage = `url("${outputDataUrl}")`;
    runtime.state.embeddedById.set(targetId, {
      target,
      targetId,
      targetKey,
      kind: "background",
      mode: "embedded",
      bubbleCount: bubbles.length
    });
  }
  runtime.renderEmbeddedBackgroundTarget = renderEmbeddedBackgroundTarget;
  async function getEmbeddedBaseDataUrl(img, payload) {
    try {
      return runtime.imageElementToEmbeddedDataUrl(img);
    } catch {
      const imageUrl = runtime.resolveImageUrl(img);
      if (runtime.isHttpUrl(imageUrl)) {
        try {
          const fetched = await runtime.sendRuntimeMessage({
            type: "FETCH_IMAGE_DATA_URL",
            url: imageUrl,
            preserveSize: true,
            maxOriginalBytes: runtime.EMBEDDED_MAX_ORIGINAL_BYTES,
            referrer: location.href
          });
          if (fetched && fetched.ok && runtime.isDataUrl(fetched.dataUrl)) {
            return fetched.dataUrl;
          }
        } catch {
          // 跨域原图抓取失败时降级到模型输入图，保持功能可用。
        }
      }
      if (payload && runtime.isDataUrl(payload.dataUrl)) {
        return payload.dataUrl;
      }
      throw new Error("Image data extraction failed for embedded rendering");
    }
  }
  runtime.getEmbeddedBaseDataUrl = getEmbeddedBaseDataUrl;
  function imageElementToEmbeddedDataUrl(img) {
    const srcWidth = img.naturalWidth || img.width || img.clientWidth;
    const srcHeight = img.naturalHeight || img.height || img.clientHeight;
    if (!srcWidth || !srcHeight) {
      throw new Error("Image size is unavailable");
    }
    const pixelCount = srcWidth * srcHeight;
    const scale = pixelCount > runtime.EMBEDDED_MAX_CANVAS_PIXELS ? Math.sqrt(runtime.EMBEDDED_MAX_CANVAS_PIXELS / pixelCount) : 1;
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL("image/jpeg", runtime.EMBEDDED_JPEG_QUALITY);
  }
  runtime.imageElementToEmbeddedDataUrl = imageElementToEmbeddedDataUrl;
  async function composeEmbeddedImageDataUrl(baseDataUrl, bubbles) {
    const image = await runtime.loadImageFromDataUrl(baseDataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new Error("Embedded base image size is unavailable");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    runtime.drawEmbeddedBubbles(ctx, width, height, bubbles);
    return canvas.toDataURL("image/jpeg", runtime.EMBEDDED_JPEG_QUALITY);
  }
  runtime.composeEmbeddedImageDataUrl = composeEmbeddedImageDataUrl;
}
