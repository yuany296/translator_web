export function installCapture(runtime) {
  async function handleFetchImageDataUrl(message) {
    const url = String(message.url || "").trim();
    const preserveSize = message.preserveSize === true;
    const maxOriginalBytes = Math.max(1, Number(message.maxOriginalBytes || 0));
    const referrer = String(message.referrer || "").trim();
    if (!url) {
      return {
        ok: false,
        error: "Image URL is required"
      };
    }

    // 总体超时：两个 fetch 尝试总时间不超过 5 秒
    const FETCH_TOTAL_TIMEOUT_MS = 5000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TOTAL_TIMEOUT_MS);

    // Build fetch options: include referrer to satisfy CDN hotlink protection.
    // Kakao CDNs (page-edge, dw-img-page) may check the Referer header.
    const buildFetchOptions = credentials => {
      const opts = {
        method: "GET",
        credentials,
        cache: "force-cache",
        signal: controller.signal
      };
      if (referrer) {
        opts.referrer = referrer;
        opts.referrerPolicy = "unsafe-url";
      }
      return opts;
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const tryFetch = async credentials => {
      const response = await fetch(url, buildFetchOptions(credentials));
      if (!response.ok) {
        throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`);
      }
      const blob = await response.blob();
      if (!blob || blob.size <= 0) {
        throw new Error("Image blob is empty");
      }
      return blob;
    };
    try {
      let blob;
      // 先尝试 include（携带 cookies，Kakao CDN 需要）→ omit（CORS 兼容）
      // 对 Kakao page-edge CDN，include 更可能成功
      for (const credentials of ["include", "omit"]) {
        try {
          blob = await tryFetch(credentials);
          break; // 成功
        } catch (err) {
          // 网络不稳定时短延迟重试一次
          if (err.message && err.message.includes("Failed to fetch")) {
            await sleep(300);
            try {
              blob = await tryFetch(credentials);
              break;
            } catch {/* 继续下一个 credentials 模式 */}
          }
          // 继续尝试下一种 credentials 模式
        }
      }
      if (!blob) {
        // 所有尝试都失败
        clearTimeout(timeoutId);
        return {
          ok: false,
          error: "Image fetch error: all fetch attempts failed"
        };
      }
      clearTimeout(timeoutId);
      if (preserveSize && blob.size <= maxOriginalBytes) {
        const originalDataUrl = await runtime.blobToDataUrl(blob);
        return {
          ok: true,
          dataUrl: originalDataUrl,
          mimeType: runtime.getDataUrlMimeType(originalDataUrl),
          preserved: true
        };
      }
      const dataUrl = await runtime.blobToPreferredDataUrl(blob);
      return {
        ok: true,
        dataUrl,
        mimeType: runtime.getDataUrlMimeType(dataUrl)
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const msg = error && error.name === "AbortError" ? "Image fetch timed out after 5s" : error && error.message ? error.message : "Unknown error";
      return {
        ok: false,
        error: `Image fetch error: ${msg}`
      };
    }
  }
  runtime.handleFetchImageDataUrl = handleFetchImageDataUrl;
  async function handleCaptureVisibleTargetDataUrl(message, sender) {
    const tab = sender && sender.tab;
    const windowId = tab && Number.isInteger(tab.windowId) ? tab.windowId : null;
    if (windowId === null) {
      return {
        ok: false,
        error: "Visible tab capture requires an active tab"
      };
    }
    const rect = runtime.normalizeCaptureRect(message && message.rect);
    const viewport = runtime.normalizeViewportSize(message && message.viewport);
    if (!rect || !viewport) {
      return {
        ok: false,
        error: "Invalid visible capture rectangle"
      };
    }
    try {
      const screenshotDataUrl = await runtime.captureVisibleTabDataUrl(windowId);
      const cropped = await runtime.cropVisibleTabDataUrl(screenshotDataUrl, rect, viewport);
      return {
        ok: true,
        dataUrl: cropped.dataUrl,
        width: cropped.width,
        height: cropped.height,
        bitmapWidth: cropped.bitmapWidth,
        bitmapHeight: cropped.bitmapHeight,
        cropX: cropped.cropX,
        cropY: cropped.cropY,
        cropScaleX: cropped.scaleX,
        cropScaleY: cropped.scaleY,
        source: "visible-tab"
      };
    } catch (error) {
      return {
        ok: false,
        error: `Visible tab capture failed: ${error && error.message ? error.message : "Unknown error"}`
      };
    }
  }
  runtime.handleCaptureVisibleTargetDataUrl = handleCaptureVisibleTargetDataUrl;
  function normalizeCaptureRect(rect) {
    const left = Number(rect && rect.left);
    const top = Number(rect && rect.top);
    const width = Number(rect && rect.width);
    const height = Number(rect && rect.height);
    if (!(Number.isFinite(left) && Number.isFinite(top) && width > 1 && height > 1)) {
      return null;
    }
    return {
      left,
      top,
      width,
      height
    };
  }
  runtime.normalizeCaptureRect = normalizeCaptureRect;
  function normalizeViewportSize(viewport) {
    const width = Number(viewport && viewport.width);
    const height = Number(viewport && viewport.height);
    if (!(width > 1 && height > 1)) {
      return null;
    }
    return {
      width,
      height
    };
  }
  runtime.normalizeViewportSize = normalizeViewportSize;
  function captureVisibleTabDataUrl(windowId) {
    const now = Date.now();
    const cached = runtime.visibleTabCaptureCacheByWindow.get(windowId);
    if (cached && now - cached.createdAt <= runtime.VISIBLE_TAB_CAPTURE_CACHE_MS) {
      return cached.promise;
    }
    const promise = new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: Math.round(runtime.IMAGE_JPEG_QUALITY * 100)
      }, dataUrl => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!runtime.isDataUrl(dataUrl)) {
          reject(new Error("Captured screenshot is empty"));
          return;
        }
        resolve(dataUrl);
      });
    });
    runtime.visibleTabCaptureCacheByWindow.set(windowId, {
      createdAt: now,
      promise
    });
    promise.catch(() => {
      const current = runtime.visibleTabCaptureCacheByWindow.get(windowId);
      if (current && current.promise === promise) {
        runtime.visibleTabCaptureCacheByWindow.delete(windowId);
      }
    });
    return promise;
  }
  runtime.captureVisibleTabDataUrl = captureVisibleTabDataUrl;
  async function cropVisibleTabDataUrl(dataUrl, rect, viewport) {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      throw new Error("OffscreenCanvas screenshot crop is unavailable");
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const scaleX = bitmap.width / viewport.width;
      const scaleY = bitmap.height / viewport.height;
      const sourceX = runtime.clamp(Math.round(rect.left * scaleX), 0, Math.max(0, bitmap.width - 1));
      const sourceY = runtime.clamp(Math.round(rect.top * scaleY), 0, Math.max(0, bitmap.height - 1));
      const sourceRight = runtime.clamp(Math.round((rect.left + rect.width) * scaleX), sourceX + 1, bitmap.width);
      const sourceBottom = runtime.clamp(Math.round((rect.top + rect.height) * scaleY), sourceY + 1, bitmap.height);
      const sourceWidth = sourceRight - sourceX;
      const sourceHeight = sourceBottom - sourceY;
      const longestSide = Math.max(sourceWidth, sourceHeight);
      const outputScale = longestSide > runtime.IMAGE_MAX_SIDE ? runtime.IMAGE_MAX_SIDE / longestSide : 1;
      const outputWidth = Math.max(1, Math.round(sourceWidth * outputScale));
      const outputHeight = Math.max(1, Math.round(sourceHeight * outputScale));
      const canvas = new OffscreenCanvas(outputWidth, outputHeight);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Screenshot crop context is unavailable");
      }
      ctx.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
      const converted = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: runtime.IMAGE_JPEG_QUALITY
      });
      if (!converted || converted.size <= 0) {
        throw new Error("Screenshot crop conversion failed");
      }
      return {
        dataUrl: await runtime.blobToDataUrl(converted),
        width: outputWidth,
        height: outputHeight,
        bitmapWidth: bitmap.width,
        bitmapHeight: bitmap.height,
        cropX: sourceX,
        cropY: sourceY,
        scaleX,
        scaleY
      };
    } finally {
      bitmap.close();
    }
  }
  runtime.cropVisibleTabDataUrl = cropVisibleTabDataUrl;
}
