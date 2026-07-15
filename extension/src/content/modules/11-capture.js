export function installContent11(runtime) {
  function hasUsableKakaoStripCaptureRect(captureRect) {
    return runtime.KP.hasUsableKakaoStripCaptureRect(captureRect);
  }
  runtime.hasUsableKakaoStripCaptureRect = hasUsableKakaoStripCaptureRect;
  async function extractImagePayload(img) {
    if (!img.complete) {
      throw new Error("Image is not loaded yet");
    }
    const imageUrl = await runtime.resolveImageUrlWithAuth(img);

    // 图片 complete 但 naturalWidth=0 → CDN 限流或加载失败（常见于 429）
    if (img.complete && !img.naturalWidth && !img.naturalHeight && imageUrl && !runtime.isDataUrl(imageUrl)) {
      if (runtime.IS_KAKAOPAGE_READER) {
        // 对于 Kakao page-edge 图片，触发自动重试
        throw new Error(runtime.SCREENSHOT_TARGET_NOT_VISIBLE);
      }
      throw new Error(`Image failed to load: ${imageUrl.slice(0, 80)}`);
    }
    if (runtime.isDataUrl(imageUrl)) {
      return {
        dataUrl: imageUrl,
        imageUrl: imageUrl.slice(0, 120),
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        cssWidth: img.getBoundingClientRect().width,
        cssHeight: img.getBoundingClientRect().height,
        source: "img-data-url"
      };
    }
    let imageFetchError = null;
    if (runtime.isHttpUrl(imageUrl)) {
      // Pass page URL as referrer so background fetch can set the Referer header.
      // Kakao CDNs check Referer for hotlink protection.
      try {
        const fetched = await runtime.sendRuntimeMessage({
          type: "FETCH_IMAGE_DATA_URL",
          url: imageUrl,
          referrer: location.href,
          preserveSize: runtime.shouldUseKakaoCanonicalPipeline(img),
          maxOriginalBytes: runtime.EMBEDDED_MAX_ORIGINAL_BYTES
        });
        if (fetched && fetched.ok && runtime.isDataUrl(fetched.dataUrl)) {
          return {
            dataUrl: fetched.dataUrl,
            imageUrl,
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0,
            cssWidth: img.getBoundingClientRect().width,
            cssHeight: img.getBoundingClientRect().height,
            source: "img-fetch"
          };
        }
        imageFetchError = new Error(fetched && fetched.error || "image fetch failed");
      } catch (error) {
        imageFetchError = error;
      }
    }
    try {
      const fallbackDataUrl = runtime.imageElementToDataUrl(img);
      return {
        dataUrl: fallbackDataUrl,
        imageUrl,
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        cssWidth: img.getBoundingClientRect().width,
        cssHeight: img.getBoundingClientRect().height,
        source: "img-canvas"
      };
    } catch (error) {
      // Canvas 被跨域污染（SecurityError）→ 尝试截图回退。
      // 不 scrollIntoView（多图并行会导致页面跳动），改为抛出 SCREENSHOT_TARGET_NOT_VISIBLE
      // 依赖 retry 机制，当用户自然滚动到该位置时截图会成功。
      if (runtime.IS_KAKAOPAGE_READER && img.isConnected && (img.naturalWidth || 0) > 0 && !runtime.getVisibleViewportRect(img)) {
        throw new Error(runtime.SCREENSHOT_TARGET_NOT_VISIBLE);
      }
      console.debug("[MangaTranslator] image-fetch-fallback", imageFetchError || error);
      return runtime.captureVisibleTargetPayload(img, imageFetchError || error, imageUrl || "visible-tab-image-crop");
    }
  }
  runtime.extractImagePayload = extractImagePayload;
  async function extractCanvasPayload(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Invalid canvas target");
    }
    let firstError = null;
    try {
      const jpeg = canvas.toDataURL("image/jpeg", runtime.IMAGE_JPEG_QUALITY);
      if (runtime.isDataUrl(jpeg)) {
        return {
          dataUrl: jpeg,
          imageUrl: "",
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
          source: "canvas"
        };
      }
    } catch (error) {
      firstError = error;
      // Ignore and fallback to png.
    }
    try {
      const png = canvas.toDataURL("image/png");
      if (runtime.isDataUrl(png)) {
        return {
          dataUrl: png,
          imageUrl: "",
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
          source: "canvas"
        };
      }
    } catch (error) {
      firstError = firstError || error;
      return runtime.captureVisibleTargetPayload(canvas, firstError, "visible-tab-canvas-crop");
    }
    throw new Error("Canvas data extraction failed");
  }
  runtime.extractCanvasPayload = extractCanvasPayload;
  async function captureVisibleTargetPayload(target, originalError, imageUrl) {
    const captureRect = runtime.getVisibleViewportRect(target);
    if (!captureRect) {
      throw new Error(runtime.SCREENSHOT_TARGET_NOT_VISIBLE);
    }
    const payload = await runtime.withOverlayLayerHidden(async () => {
      await runtime.waitForPaint();
      const captured = await runtime.sendRuntimeMessage({
        type: "CAPTURE_VISIBLE_TARGET_DATA_URL",
        rect: {
          left: captureRect.left,
          top: captureRect.top,
          width: captureRect.width,
          height: captureRect.height
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        devicePixelRatio: window.devicePixelRatio || 1
      });
      if (!captured || !captured.ok || !runtime.isDataUrl(captured.dataUrl)) {
        const fallbackError = captured && captured.error ? captured.error : "visible tab screenshot failed";
        const originalMessage = originalError && originalError.message ? originalError.message : "";
        throw new Error(originalMessage ? `Target screenshot fallback failed: ${fallbackError}; original error: ${originalMessage}` : `Target screenshot fallback failed: ${fallbackError}`);
      }
      return captured;
    });
    const targetRect = target.getBoundingClientRect();
    return {
      dataUrl: payload.dataUrl,
      imageUrl: String(imageUrl || "visible-tab-target-crop"),
      width: Number(payload.width || 0),
      height: Number(payload.height || 0),
      bitmapWidth: Number(payload.bitmapWidth || 0),
      bitmapHeight: Number(payload.bitmapHeight || 0),
      cropX: Number(payload.cropX || 0),
      cropY: Number(payload.cropY || 0),
      devicePixelRatio: window.devicePixelRatio || 1,
      cssWidth: captureRect.width,
      cssHeight: captureRect.height,
      source: "visible-tab-crop",
      displayRect: {
        offsetX: captureRect.left - targetRect.left,
        offsetY: captureRect.top - targetRect.top,
        width: captureRect.width,
        height: captureRect.height
      }
    };
  }
  runtime.captureVisibleTargetPayload = captureVisibleTargetPayload;
  function getVisibleViewportRect(target) {
    const rect = target.getBoundingClientRect();
    let left = runtime.clamp(Number(rect.left || 0), 0, window.innerWidth);
    let top = runtime.clamp(Number(rect.top || 0), 0, window.innerHeight);
    let right = runtime.clamp(Number.isFinite(Number(rect.right)) ? Number(rect.right) : Number(rect.left || 0) + Number(rect.width || 0), 0, window.innerWidth);
    let bottom = runtime.clamp(Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : Number(rect.top || 0) + Number(rect.height || 0), 0, window.innerHeight);

    // 覆盖层挂在 document 根节点，默认不会继承目标祖先的 overflow 裁剪。
    // 因此可见矩形必须显式与每个滚动/裁剪祖先求交，横向推荐列表尤其依赖这一点。
    let ancestor = target && target.parentElement;
    while (ancestor) {
      let style = null;
      try {
        style = getComputedStyle(ancestor);
      } catch {
        style = null;
      }
      const clipX = /^(?:auto|scroll|hidden|clip)$/.test(String(style && style.overflowX || ""));
      const clipY = /^(?:auto|scroll|hidden|clip)$/.test(String(style && style.overflowY || ""));
      if ((clipX || clipY) && typeof ancestor.getBoundingClientRect === "function") {
        const ancestorRect = ancestor.getBoundingClientRect();
        const ancestorLeft = Number(ancestorRect.left || 0);
        const ancestorTop = Number(ancestorRect.top || 0);
        const ancestorRight = Number.isFinite(Number(ancestorRect.right)) ? Number(ancestorRect.right) : ancestorLeft + Number(ancestorRect.width || 0);
        const ancestorBottom = Number.isFinite(Number(ancestorRect.bottom)) ? Number(ancestorRect.bottom) : ancestorTop + Number(ancestorRect.height || 0);
        if (clipX && ancestorRight > ancestorLeft) {
          left = Math.max(left, ancestorLeft);
          right = Math.min(right, ancestorRight);
        }
        if (clipY && ancestorBottom > ancestorTop) {
          top = Math.max(top, ancestorTop);
          bottom = Math.min(bottom, ancestorBottom);
        }
      }
      ancestor = ancestor.parentElement;
    }
    const width = right - left;
    const height = bottom - top;
    if (!(width >= 2 && height >= 2)) {
      return null;
    }
    return {
      left,
      top,
      right,
      bottom,
      width,
      height
    };
  }
  runtime.getVisibleViewportRect = getVisibleViewportRect;
  async function withOverlayLayerHidden(callback) {
    const overlayLayer = runtime.state.overlayLayer;
    const floatingBallWrap = runtime.state.floatingBallWrap;
    const markedOverlays = Array.from(document.querySelectorAll("[data-manga-translator-overlay]"));
    const shouldHideOverlay = overlayLayer && overlayLayer.isConnected;
    const shouldHideBall = floatingBallWrap && floatingBallWrap.isConnected;
    const previousFloatingVisibility = shouldHideBall ? floatingBallWrap.style.visibility : "";
    const previousMarkedVisibility = markedOverlays.map(node => ({
      node,
      visibility: node.style.visibility
    }));
    if (shouldHideOverlay && runtime.state.overlayHideDepth === 0) {
      runtime.state.overlayPreviousVisibility = overlayLayer.style.visibility;
    }
    if (shouldHideOverlay) {
      runtime.state.overlayHideDepth += 1;
      overlayLayer.style.visibility = "hidden";
    }
    if (shouldHideBall) {
      floatingBallWrap.style.visibility = "hidden";
    }
    markedOverlays.forEach(node => {
      node.style.visibility = "hidden";
    });
    try {
      return await callback();
    } finally {
      if (shouldHideOverlay) {
        runtime.state.overlayHideDepth = Math.max(0, runtime.state.overlayHideDepth - 1);
        if (runtime.state.overlayHideDepth === 0) {
          overlayLayer.style.visibility = runtime.state.overlayPreviousVisibility;
          runtime.state.overlayPreviousVisibility = "";
        }
      }
      if (shouldHideBall && floatingBallWrap.isConnected) {
        floatingBallWrap.style.visibility = previousFloatingVisibility;
      }
      previousMarkedVisibility.forEach(entry => {
        if (entry.node && entry.node.isConnected) {
          entry.node.style.visibility = entry.visibility;
        }
      });
      runtime.ensureExtensionUiMounted();
    }
  }
  runtime.withOverlayLayerHidden = withOverlayLayerHidden;
  function waitForPaint(timeoutMs = 0) {
    return new Promise(resolve => {
      let settled = false;
      let timer = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        resolve();
      };
      if (Number(timeoutMs) > 0 && typeof window.setTimeout === "function") {
        timer = window.setTimeout(finish, Number(timeoutMs));
      }
      if (typeof requestAnimationFrame !== "function") {
        finish();
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  }
  runtime.waitForPaint = waitForPaint;
  async function extractBackgroundImagePayload(target) {
    const imageUrl = runtime.resolveBackgroundImageUrl(target);
    if (!imageUrl) {
      throw new Error("Background image is unavailable");
    }
    if (runtime.isDataUrl(imageUrl)) {
      const size = await runtime.decodeDataUrlImageSize(imageUrl);
      return {
        dataUrl: imageUrl,
        imageUrl: imageUrl.slice(0, 120),
        width: size.width,
        height: size.height
      };
    }
    let dataUrl = "";
    if (runtime.isBlobUrl(imageUrl)) {
      dataUrl = await runtime.fetchPageImageDataUrl(imageUrl);
    } else if (runtime.isHttpUrl(imageUrl)) {
      const fetched = await runtime.sendRuntimeMessage({
        type: "FETCH_IMAGE_DATA_URL",
        url: imageUrl,
        referrer: location.href
      });
      if (fetched && fetched.ok && runtime.isDataUrl(fetched.dataUrl)) {
        dataUrl = fetched.dataUrl;
      }
    }
    if (!runtime.isDataUrl(dataUrl)) {
      return runtime.captureVisibleTargetPayload(target, new Error("Background image data extraction failed"), imageUrl);
    }
    const size = await runtime.decodeDataUrlImageSize(dataUrl);
    return {
      dataUrl,
      imageUrl,
      width: size.width,
      height: size.height
    };
  }
  runtime.extractBackgroundImagePayload = extractBackgroundImagePayload;
}
