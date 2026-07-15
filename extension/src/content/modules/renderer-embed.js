export function installRendererEmbed(runtime) {
  async function renderEmbeddedTranslation(target, targetKey, result, payload) {
    const bubbles = Array.isArray(result.bubbles) ? result.bubbles : [];
    if (bubbles.length === 0) {
      runtime.clearRenderedTarget(target);
      return;
    }
    if (target instanceof HTMLImageElement) {
      await runtime.renderEmbeddedImageTarget(target, targetKey, bubbles, payload);
      return;
    }
    if (target instanceof HTMLCanvasElement) {
      await runtime.renderEmbeddedCanvasTarget(target, targetKey, bubbles, payload);
      return;
    }
    if (runtime.isBackgroundImageTarget(target)) {
      await runtime.renderEmbeddedBackgroundTarget(target, targetKey, bubbles, payload);
      return;
    }
    throw new Error("Unsupported embedded render target");
  }
  runtime.renderEmbeddedTranslation = renderEmbeddedTranslation;
  async function renderEmbeddedImageTarget(img, targetKey, bubbles, payload) {
    const targetId = runtime.getTargetId(img);
    const cachedDataUrl = runtime.state.embeddedImageCache.get(targetKey);
    const outputDataUrl = cachedDataUrl || (await runtime.composeEmbeddedImageDataUrl(await runtime.getEmbeddedBaseDataUrl(img, payload), bubbles));
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
    const originalDataUrl = existing && existing.kind === "canvas" && existing.originalDataUrl ? existing.originalDataUrl : payload && runtime.isDataUrl(payload.dataUrl) ? payload.dataUrl : "";
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
    const baseDataUrl = payload && runtime.isDataUrl(payload.dataUrl) ? payload.dataUrl : "";
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
  function drawEmbeddedBubbles(ctx, canvasWidth, canvasHeight, bubbles, options = {}) {
    const textOptions = options && typeof options === "object" ? options : {};
    bubbles.forEach(bubble => {
      const text = runtime.formatTranslationForOriginalLines(runtime.cleanRenderableText(bubble.translated_text || bubble.original_text || ""), Number(bubble.source_line_count) || 1);
      if (!text) {
        return;
      }
      let x = runtime.clamp(Number(bubble.x), 0, 100) / 100 * canvasWidth;
      let y = runtime.clamp(Number(bubble.y), 0, 100) / 100 * canvasHeight;
      let w = runtime.clamp(Number(bubble.w), 0, 100) / 100 * canvasWidth;
      let h = runtime.clamp(Number(bubble.h), 0, 100) / 100 * canvasHeight;
      const embeddedGeometry = runtime.getEmbeddedPolygonGeometry(bubble.polygon, canvasWidth, canvasHeight);
      const rotation = runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type);
      if (embeddedGeometry) {
        x = embeddedGeometry.centerX - embeddedGeometry.width / 2;
        y = embeddedGeometry.centerY - embeddedGeometry.height / 2;
        w = embeddedGeometry.width;
        h = embeddedGeometry.height;
      }
      if (w < 2 || h < 2) {
        return;
      }
      const boxScale = Math.max(1, Number(textOptions.boxScale || 1));
      if (boxScale > 1) {
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        w = Math.min(canvasWidth, w * boxScale);
        h = Math.min(canvasHeight, h * boxScale);
        x = runtime.clamp(centerX - w / 2, 0, Math.max(0, canvasWidth - w));
        y = runtime.clamp(centerY - h / 2, 0, Math.max(0, canvasHeight - h));
      }
      const bgType = runtime.normalizeBgType(bubble.bg_type);
      const paddingScale = Number(textOptions.paddingScale || 1);
      const paddingX = Math.max(1, paddingScale);
      const paddingY = Math.max(1, paddingScale);
      const boxX = Math.max(0, x - paddingX);
      const boxY = Math.max(0, y - paddingY);
      const box = {
        x: boxX,
        y: boxY,
        w: Math.min(canvasWidth - boxX, w + paddingX * 2),
        h: Math.min(canvasHeight - boxY, h + paddingY * 2)
      };
      const sourceFillBox = runtime.getCanvasFillBox(bubble.fill_box, canvasWidth, canvasHeight);
      let fillBox = runtime.unionRenderBoxes(box, sourceFillBox);

      // Guard against oversized merged-group fill boxes (chat/forum regions)
      // If the fill box is >3x the bubble box area, it's likely a group-merge artifact
      const bubbleArea = Math.max(1, box.w * box.h);
      const fillArea = Math.max(1, fillBox.w * fillBox.h);
      const isChatRegion = String(bubble.region_type || "") === "chat" || String(bubble.region_type || "") === "ui";
      if (isChatRegion && fillArea > bubbleArea * 3) {
        fillBox = box;
      }
      if (bgType === "solid" && Array.isArray(bubble.region_polygon) && bubble.region_polygon.length >= 3) {
        ctx.save();
        ctx.beginPath();
        bubble.region_polygon.forEach((point, index) => {
          const pointX = Number(point && point.x) / 100 * canvasWidth;
          const pointY = Number(point && point.y) / 100 * canvasHeight;
          if (index === 0) ctx.moveTo(pointX, pointY);else ctx.lineTo(pointX, pointY);
        });
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = String(bubble.bg_color || "#ffffff");
        ctx.fillRect(fillBox.x, fillBox.y, fillBox.w, fillBox.h);
        ctx.restore();
      } else if (bgType === "solid") {
        ctx.save();
        ctx.fillStyle = String(bubble.bg_color || "#ffffff");
        ctx.fillRect(fillBox.x, fillBox.y, fillBox.w, fillBox.h);
        ctx.restore();
      }
      ctx.save();
      const centerX = box.x + box.w / 2;
      const centerY = box.y + box.h / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation * Math.PI / 180);
      const localBox = {
        x: -box.w / 2,
        y: -box.h / 2,
        w: box.w,
        h: box.h
      };
      const renderColors = runtime.getBubbleRenderColors(bubble, bgType);
      runtime.drawFittedText(ctx, text, localBox, bgType, {
        ...textOptions,
        textColor: renderColors.textColor,
        strokeColor: renderColors.strokeColor
      });
      ctx.restore();
    });
  }
  runtime.drawEmbeddedBubbles = drawEmbeddedBubbles;
  function getCanvasFillBox(value, canvasWidth, canvasHeight) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const x = Number(value.x) / 100 * canvasWidth;
    const y = Number(value.y) / 100 * canvasHeight;
    const w = Number(value.w) / 100 * canvasWidth;
    const h = Number(value.h) / 100 * canvasHeight;
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? {
      x,
      y,
      w,
      h
    } : null;
  }
  runtime.getCanvasFillBox = getCanvasFillBox;
  function unionRenderBoxes(primary, secondary) {
    if (!secondary) {
      return primary;
    }
    if (!primary) {
      return secondary;
    }
    const left = Math.min(primary.x, secondary.x);
    const top = Math.min(primary.y, secondary.y);
    const right = Math.max(primary.x + primary.w, secondary.x + secondary.w);
    const bottom = Math.max(primary.y + primary.h, secondary.y + secondary.h);
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    };
  }
  runtime.unionRenderBoxes = unionRenderBoxes;
}
