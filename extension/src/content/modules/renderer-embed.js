export function installRendererEmbed(runtime) {
  function getEmbeddedTranslatedLines(bubbles) {
    const values = (Array.isArray(bubbles) ? bubbles : []).map(bubble =>
      runtime.cleanRenderableText(bubble?.translated_text || "")
    ).filter(Boolean);
    return [...new Set(values)];
  }
  runtime.getEmbeddedTranslatedLines = getEmbeddedTranslatedLines;

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
  function getEmbeddedDisplayScale(target) {
    const displayWidth = Number(target && target.clientWidth || 0);
    const naturalWidth = Number(target && (target.naturalWidth || target.width) || 0);
    if (!displayWidth || !naturalWidth || displayWidth >= naturalWidth) return 1;
    return naturalWidth / displayWidth;
  }
  runtime.getEmbeddedDisplayScale = getEmbeddedDisplayScale;
  function embeddedDisplayOptions(target) {
    const scale = getEmbeddedDisplayScale(target);
    return scale > 1
      ? { textScale: scale, maxFont: Math.max(16, Math.round(52 * scale)), widthUsage: 0.82, heightUsage: 0.68 }
      : {};
  }
  runtime.embeddedDisplayOptions = embeddedDisplayOptions;
  async function renderEmbeddedImageTarget(img, targetKey, bubbles, payload) {
    const cachedDataUrl = runtime.state.embeddedImageCache.get(targetKey);
    const baseDataUrl = runtime.isDataUrl(payload?.cleanedImage) ? payload.cleanedImage : await runtime.getEmbeddedBaseDataUrl(img, payload);
    const outputDataUrl = cachedDataUrl || (await runtime.composeEmbeddedImageDataUrl(baseDataUrl, bubbles, embeddedDisplayOptions(img)));
    if (!cachedDataUrl) {
      runtime.rememberEmbeddedImageCache(targetKey, outputDataUrl);
    }
    applyEmbeddedImageDataUrl(img, targetKey, outputDataUrl, {
      bubbleCount: bubbles.length,
      translatedLines: getEmbeddedTranslatedLines(bubbles)
    });
  }
  runtime.renderEmbeddedImageTarget = renderEmbeddedImageTarget;

  function applyEmbeddedImageDataUrl(img, targetKey, outputDataUrl, metadata = {}) {
    if (!(img instanceof HTMLImageElement) || !runtime.isDataUrl(outputDataUrl)) {
      throw new Error("Embedded image output is invalid");
    }
    const targetId = runtime.getTargetId(img);
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
      outputDataUrl,
      bubbleCount: Math.max(0, Number(metadata.bubbleCount) || 0),
      translatedLines: Array.isArray(metadata.translatedLines)
        ? [...new Set(metadata.translatedLines.map(String).map(value => value.trim()).filter(Boolean))]
        : []
    });
  }
  runtime.applyEmbeddedImageDataUrl = applyEmbeddedImageDataUrl;
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
    runtime.drawEmbeddedBubbles(ctx, canvas.width, canvas.height, bubbles, embeddedDisplayOptions(canvas));
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
    const outputDataUrl = cachedDataUrl || (await runtime.composeEmbeddedImageDataUrl(baseDataUrl, bubbles, {
      heightUsage: 0.86,
      maxFont: 44,
      minFont: 9,
      paddingScale: 3,
      textScale: 1.55,
      widthUsage: 0.9,
      boxScale: 1.28
    }));
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
  function drawEmbeddedBubbles(ctx, canvasWidth, canvasHeight, bubbles, options = {}) {
    const textOptions = options && typeof options === "object" ? options : {};
    bubbles.forEach(bubble => {
      const translatedText = runtime.cleanRenderableText(bubble.translated_text || bubble.original_text || "");
      const originalText = runtime.cleanRenderableText(bubble.original_text || "");
      const rawText = runtime.state.displayMode === "bilingual" && originalText
        && originalText !== translatedText ? `${originalText}\n${translatedText}` : translatedText;
      const text = runtime.formatTranslationForOriginalLines(
        rawText,
        Number(bubble.source_line_count) || 1
      );
      if (!text) return;
      let x = runtime.clamp(Number(bubble.x), 0, 100) / 100 * canvasWidth;
      let y = runtime.clamp(Number(bubble.y), 0, 100) / 100 * canvasHeight;
      let w = runtime.clamp(Number(bubble.w), 0, 100) / 100 * canvasWidth;
      let h = runtime.clamp(Number(bubble.h), 0, 100) / 100 * canvasHeight;
      const polygon = runtime.getEmbeddedPolygonGeometry(bubble.polygon, canvasWidth, canvasHeight);
      const rotation = runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type);
      if (polygon) {
        x = polygon.centerX - polygon.width / 2;
        y = polygon.centerY - polygon.height / 2;
        w = polygon.width;
        h = polygon.height;
      }
      if (w < 2 || h < 2) return;

      const boxScale = Math.max(1, Number(textOptions.boxScale || 1));
      if (boxScale > 1) {
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        w = Math.min(canvasWidth, w * boxScale);
        h = Math.min(canvasHeight, h * boxScale);
        x = runtime.clamp(centerX - w / 2, 0, Math.max(0, canvasWidth - w));
        y = runtime.clamp(centerY - h / 2, 0, Math.max(0, canvasHeight - h));
      }
      const padding = Math.max(1, Number(textOptions.paddingScale || 1));
      const boxX = Math.max(0, x - padding);
      const boxY = Math.max(0, y - padding);
      const box = {
        x: boxX,
        y: boxY,
        w: Math.min(canvasWidth - boxX, w + padding * 2),
        h: Math.min(canvasHeight - boxY, h + padding * 2)
      };
      const bgType = runtime.normalizeBgType(bubble.bg_type);
      const sourceFillBox = runtime.getCanvasFillBox(bubble.fill_box, canvasWidth, canvasHeight);
      let fillBox = runtime.unionRenderBoxes(box, sourceFillBox);
      const bubbleArea = Math.max(1, box.w * box.h);
      const fillArea = Math.max(1, fillBox.w * fillBox.h);
      const regionType = String(bubble.region_type || "");
      if ((regionType === "chat" || regionType === "ui") && fillArea > bubbleArea * 3) {
        fillBox = box;
      }
      if (bgType === "solid") {
        ctx.save();
        const clipPoly = Array.isArray(bubble.region_polygon) && bubble.region_polygon.length >= 3 ? bubble.region_polygon : Array.isArray(bubble.polygon) && bubble.polygon.length >= 4 ? bubble.polygon : null;
        if (clipPoly) {
          ctx.beginPath();
          clipPoly.forEach((point, index) => {
            const px = Number(point?.x) / 100 * canvasWidth;
            const py = Number(point?.y) / 100 * canvasHeight;
            if (index === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.closePath();
          ctx.clip();
        }
        ctx.fillStyle = String(bubble.bg_color || "#ffffff");
        ctx.fillRect(fillBox.x, fillBox.y, fillBox.w, fillBox.h);
        ctx.restore();
      }
      ctx.save();
      const centerX = box.x + box.w / 2;
      const centerY = box.y + box.h / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation * Math.PI / 180);
      const renderColors = runtime.getBubbleRenderColors(bubble, bgType);
      // OCR 原文字高（占整页图高度的百分比）→ canvas 像素，作为目标字号
      const sourceFontHeightPercent = Number(bubble.font_height_percent || bubble.fontHeightPercent || bubble.visual && (bubble.visual.fontHeightPercent || bubble.visual.font_height_percent) || 0);
      runtime.drawFittedText(ctx, text, {
        x: -box.w / 2,
        y: -box.h / 2,
        w: box.w,
        h: box.h
      }, bgType, {
        ...textOptions,
        preferredFont: sourceFontHeightPercent > 0 ? canvasHeight * sourceFontHeightPercent / 100 : 0,
        textColor: renderColors.textColor,
        strokeColor: renderColors.strokeColor
      });
      ctx.restore();
    });
  }
  runtime.drawEmbeddedBubbles = drawEmbeddedBubbles;

  function getCanvasFillBox(value, canvasWidth, canvasHeight) {
    if (!value || typeof value !== "object") return null;
    const box = {
      x: Number(value.x) / 100 * canvasWidth,
      y: Number(value.y) / 100 * canvasHeight,
      w: Number(value.w) / 100 * canvasWidth,
      h: Number(value.h) / 100 * canvasHeight
    };
    return Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0 ? box : null;
  }
  runtime.getCanvasFillBox = getCanvasFillBox;

  function unionRenderBoxes(primary, secondary) {
    if (!secondary) return primary;
    if (!primary) return secondary;
    const left = Math.min(primary.x, secondary.x);
    const top = Math.min(primary.y, secondary.y);
    const right = Math.max(primary.x + primary.w, secondary.x + secondary.w);
    const bottom = Math.max(primary.y + primary.h, secondary.y + secondary.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }
  runtime.unionRenderBoxes = unionRenderBoxes;

  async function composeEmbeddedImageDataUrl(baseDataUrl, bubbles, options = {}) {
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
    runtime.drawEmbeddedBubbles(ctx, width, height, bubbles, options);
    return canvas.toDataURL("image/jpeg", runtime.EMBEDDED_JPEG_QUALITY);
  }
  runtime.composeEmbeddedImageDataUrl = composeEmbeddedImageDataUrl;
}
