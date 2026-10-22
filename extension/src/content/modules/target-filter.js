export function installTargetFilter(runtime) {
  function passesTargetFilter(target, manual, options = {}) {
    const relaxed = options.relaxed === true;
    const allowOffscreen = options.allowOffscreen === true;
    if (!runtime.isSupportedTarget(target) || !target.isConnected) {
      return false;
    }
    // 懒加载空白占位图不是漫画页：放它进队列会白跑一次 OCR，还会因 data URL
    // 完全相同而把所有占位图塌缩成同一个 pageId。仍然允许它被 registerTarget
    // 观察到（源变化时的句柄/覆盖层清理依赖那条路径）。
    if (runtime.isBlankPlaceholderImage(target)) {
      runtime.debugTargetFilter("blank placeholder image", {
        src: (target.currentSrc || target.src || '').slice(0, 60)
      });
      return false;
    }
    if (runtime.isNovelImageTarget(target)) {
      if (target instanceof HTMLImageElement && !target.complete) return false;
      const novelRect = target.getBoundingClientRect();
      const width = Number(target.naturalWidth || novelRect.width || 0);
      const height = Number(target.naturalHeight || novelRect.height || 0);
      return width >= 48 && height >= 32;
    }
    if (!runtime.isSitePreferredTarget(target, {
      allowLoose: relaxed
    })) {
      return false;
    }
    if (target instanceof HTMLImageElement && !target.complete) {
      runtime.debugTargetFilter("image not complete", {
        src: (target.currentSrc || target.src || '').slice(0, 60)
      });
      return false;
    }
    // complete=true 也可能是加载失败（naturalWidth=0）：这种图送 OCR 只会得到空结果，
    // 还会被写成“无文字”终态。等真正的 load 事件后再处理。
    if (target instanceof HTMLImageElement && target.complete && !target.naturalWidth && !target.naturalHeight
      && !runtime.isDataUrl(target.currentSrc || target.src || "")) {
      runtime.debugTargetFilter("image decode empty", {
        src: (target.currentSrc || target.src || '').slice(0, 60)
      });
      return false;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return false;
    }
    const widthLimit = manual ? runtime.MANUAL_MIN_WIDTH : runtime.AUTO_MIN_WIDTH;
    const heightLimit = manual ? runtime.MANUAL_MIN_HEIGHT : runtime.AUTO_MIN_HEIGHT;
    const effectiveWidthLimit = relaxed ? Math.max(90, Math.min(widthLimit, 100)) : widthLimit;
    // KakaoPage/RIDI: accept thin strips so they can be stitched into neighbors
    const stripMinHeight = runtime.IS_STRIP_TILE_READER ? runtime.KAKAO_THIN_STRIP_MIN_HEIGHT : 0;
    // 分片长条判定（定义在 content/configure.js）：为真即按"长条切片"对待 —— 更矮的条
    // 也收（下面用 stripMinHeight 而不是常规高度门限），因为切缝两侧要靠接缝 OCR 拼回完整台词。
    const effectiveHeightLimit = runtime.shouldUseKakaoCanonicalPipeline(target) ? stripMinHeight : relaxed ? Math.max(90, Math.min(heightLimit, 100)) : Math.max(stripMinHeight, heightLimit);
    if (rect.width < effectiveWidthLimit || rect.height < effectiveHeightLimit) {
      runtime.debugTargetFilter("rect too small", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        min: `${effectiveWidthLimit}x${effectiveHeightLimit}`,
        manual
      });
      return false;
    }
    // 分片长条阅读器（KakaoPage、RIDI）用低可见面积阈值：分片会被 DOM 回收、
    // 多数时候只露出一部分，按整页门槛会把正在滚动经过的分片丢掉（只有 Kakao 站名
    // 生效时，RIDI 的分片要露出 8000px² 才受理）。
    if (runtime.IS_STRIP_TILE_READER && !runtime.passesKakaopageTargetGeometry(target, rect, manual, relaxed, allowOffscreen)) {
      runtime.debugTargetFilter("strip tile geometry rejected", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        manual,
        relaxed
      });
      return false;
    }
    const ratio = rect.height / rect.width;
    // KakaoPage/RIDI: accept thin strips (down to ~0.01 ratio) so they aren't dropped.
    // The KakaoPage geometry check already handles per-mode visibility thresholds.
    const effectiveMinRatio = runtime.IS_STRIP_TILE_READER ? 0.01 : relaxed ? 0.10 : runtime.AUTO_MIN_RATIO;
    const maxRatio = relaxed ? 20 : 14;
    if (ratio < effectiveMinRatio || ratio > maxRatio) {
      runtime.debugTargetFilter("aspect ratio out of bounds", {
        src: (target.currentSrc || target.src || '').slice(0, 60),
        ratio: ratio.toFixed(3),
        min: effectiveMinRatio,
        max: maxRatio
      });
      return false;
    }
    if (runtime.IS_CMOA_SPEED_READER) {
      const area = runtime.getVisibleArea(rect);
      const baseMinVisibleArea = manual ? runtime.CMOA_MANUAL_MIN_VISIBLE_AREA : runtime.CMOA_AUTO_MIN_VISIBLE_AREA;
      const minVisibleArea = relaxed ? Math.max(1200, Math.floor(baseMinVisibleArea * 0.2)) : baseMinVisibleArea;
      if (area < minVisibleArea) {
        return false;
      }
    }
    return true;
  }
  runtime.passesTargetFilter = passesTargetFilter;
  function passesKakaopageTargetGeometry(target, rect, manual, relaxed, allowOffscreen = false) {
    if (!allowOffscreen) {
      // 分片长条目标按"部分可视也要收"处理：虚拟滚动下长图常常只露出一截。
      const canonicalTarget = runtime.shouldUseKakaoCanonicalPipeline(target);
      const visibleArea = runtime.getVisibleArea(rect);
      const visibleRect = runtime.getVisibleViewportRect(target);
      // KakaoPage uses virtual scrolling with tall images (up to 1100px+).
      // Lower thresholds so partially-scrolled images aren't filtered out.
      const minVisibleArea = canonicalTarget ? 1200 : relaxed ? 3000 : manual ? 6000 : 8000;
      if (!visibleRect || visibleArea < minVisibleArea) {
        runtime.debugTargetFilter("KakaoPage not enough visible area", {
          src: (target.currentSrc || target.src || '').slice(0, 60),
          visibleArea: visibleArea,
          minVisibleArea,
          manual,
          relaxed
        });
        return false;
      }
      const minVisibleHeight = canonicalTarget ? runtime.KAKAO_THIN_STRIP_MIN_HEIGHT : relaxed ? 40 : manual ? 50 : 60;
      const minVisibleWidth = relaxed ? 50 : manual ? 60 : 80;
      if (visibleRect.height < minVisibleHeight || visibleRect.width < minVisibleWidth) {
        runtime.debugTargetFilter("KakaoPage visible rect too small", {
          src: (target.currentSrc || target.src || '').slice(0, 60),
          visibleRect: `${Math.round(visibleRect.width)}x${Math.round(visibleRect.height)}`,
          min: `${minVisibleWidth}x${minVisibleHeight}`
        });
        return false;
      }
      const visibleRatio = visibleRect.height / Math.max(1, visibleRect.width);
      if (visibleRatio < 0.01 || visibleRatio > 22) {
        return false;
      }
    }
    if (target instanceof HTMLImageElement) {
      const naturalWidth = Number(target.naturalWidth || 0);
      const naturalHeight = Number(target.naturalHeight || 0);
      if (naturalWidth > 0 && naturalHeight > 0) {
        const naturalRatio = naturalHeight / Math.max(1, naturalWidth);
        // Accept thin strips (down to 8px, ratio ≥ 0.01) so they
        // get their own translation with stitching context.
        if (naturalHeight < runtime.KAKAO_THIN_STRIP_MIN_HEIGHT || naturalRatio < 0.01) {
          runtime.debugTargetFilter("KakaoPage natural size too thin", {
            src: (target.currentSrc || target.src || '').slice(0, 60),
            natural: `${naturalWidth}x${naturalHeight}`
          });
          return false;
        }
      }
    }
    return true;
  }
  runtime.passesKakaopageTargetGeometry = passesKakaopageTargetGeometry;
  function isSitePreferredTarget(target, options = {}) {
    const allowLoose = options.allowLoose === true;
    if (runtime.IS_PIXIV_COMIC_VIEWER) {
      return runtime.isBackgroundImageTarget(target) || target instanceof HTMLImageElement || target instanceof HTMLCanvasElement;
    }
    if (!runtime.IS_CMOA_SPEED_READER) {
      return true;
    }
    // 「整页容器是一张图」时，容器内部的瓦片 img 不再单独成目标（它所属的容器才是），
    // 否则同一页会被 3 条瓦片各翻一遍、跨瓦片的竖排台词被切断。放在 allowLoose 回退
    // **之前**：否则 relaxed 时下面那条 [class*='page'] 又会把瓦片放回来。
    const compositeHost = runtime.compositePageTargetOf(target);
    if (compositeHost) {
      return target === compositeHost;
    }
    const inReader = !!target.closest("#content .pt-img, #content [id^='content-p'], #content");
    if (inReader) {
      return true;
    }
    if (!allowLoose) {
      return false;
    }
    if (target.closest("[id*='reader'], [class*='reader'], [class*='comic'], [class*='page']")) {
      return true;
    }
    if (!(target instanceof HTMLImageElement)) {
      return false;
    }
    const src = runtime.resolveImageUrl(target);
    return !!src;
  }
  runtime.isSitePreferredTarget = isSitePreferredTarget;
  function computeTargetKey(target) {
    const captureSegment = runtime.getCaptureModeTargetKeySegment(target);
    if (runtime.isCompositePageTarget(target)) {
      // 整页容器：身份取瓦片集合的哈希（URL 串很长，不进 key），尺寸另算。
      const rect = target.getBoundingClientRect();
      return `${captureSegment}|page-composite|${runtime.hashSourceIdentity(runtime.compositePageSourceToken(target))}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
    }
    if (target instanceof HTMLImageElement) {
      const url = runtime.resolveImageUrl(target);
      const width = target.naturalWidth || target.width || Math.round(target.getBoundingClientRect().width);
      const height = target.naturalHeight || target.height || Math.round(target.getBoundingClientRect().height);
      return `${captureSegment}|img|${url}|${width}x${height}`;
    }
    if (target instanceof HTMLCanvasElement) {
      const signature = runtime.computeCanvasSignature(target);
      return `${captureSegment}|canvas|${signature}`;
    }
    if (runtime.isBackgroundImageTarget(target)) {
      const rect = target.getBoundingClientRect();
      return `${captureSegment}|background|${runtime.resolveBackgroundImageUrl(target)}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
    }
    return `${captureSegment}|unknown|${Date.now()}`;
  }
  runtime.computeTargetKey = computeTargetKey;
  function findTargetByScopedKey(scopedKey) {
    if (!scopedKey) return null;
    const targets = document.querySelectorAll(runtime.TARGET_SELECTOR);
    for (const candidate of targets) {
      if (!runtime.isSupportedTarget(candidate) || !candidate.isConnected) continue;
      const key = runtime.computeTargetKey(candidate);
      if (runtime.buildTargetSourceCacheKey(key, runtime.getQuickSourceToken(candidate)) === scopedKey) {
        return candidate;
      }
    }
    return null;
  }
  runtime.findTargetByScopedKey = findTargetByScopedKey;
  function getCaptureModeTargetKeySegment(target) {
    if (!runtime.isScreenshotCaptureMode()) {
      return runtime.CAPTURE_MODE_DIRECT;
    }
    const visibleRect = runtime.getVisibleViewportRect(target);
    if (!visibleRect) {
      return `${runtime.CAPTURE_MODE_SCREENSHOT}|not-visible`;
    }
    const targetRect = target.getBoundingClientRect();
    const offsetX = Math.round(visibleRect.left - targetRect.left);
    const offsetY = Math.round(visibleRect.top - targetRect.top);
    const width = Math.round(visibleRect.width);
    const height = Math.round(visibleRect.height);
    return `${runtime.CAPTURE_MODE_SCREENSHOT}|${offsetX},${offsetY},${width}x${height}`;
  }
  runtime.getCaptureModeTargetKeySegment = getCaptureModeTargetKeySegment;
  function buildScreenshotImageUrl(target) {
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "target";
    return `visible-tab-${tag}-crop`;
  }
  runtime.buildScreenshotImageUrl = buildScreenshotImageUrl;
  function getPayloadImageMeta(payload) {
    const width = Number(payload && payload.width);
    const height = Number(payload && payload.height);
    if (width > 0 && height > 0) {
      return {
        width,
        height,
        cssWidth: Number(payload && payload.cssWidth) || 0,
        cssHeight: Number(payload && payload.cssHeight) || 0,
        bitmapWidth: Number(payload && payload.bitmapWidth) || width,
        bitmapHeight: Number(payload && payload.bitmapHeight) || height,
        cropX: Number(payload && payload.cropX) || 0,
        cropY: Number(payload && payload.cropY) || 0,
        devicePixelRatio: Number(payload && payload.devicePixelRatio) || window.devicePixelRatio || 1,
        source: String(payload && payload.source || "")
      };
    }
    return null;
  }
  runtime.getPayloadImageMeta = getPayloadImageMeta;
  function getPayloadDisplayRect(payload) {
    const rect = payload && payload.displayRect;
    if (!rect || typeof rect !== "object") {
      return null;
    }
    const offsetX = Number(rect.offsetX);
    const offsetY = Number(rect.offsetY);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!(Number.isFinite(offsetX) && Number.isFinite(offsetY) && width > 0 && height > 0)) {
      return null;
    }
    return {
      offsetX,
      offsetY,
      width,
      height
    };
  }
  runtime.getPayloadDisplayRect = getPayloadDisplayRect;
  function computeCanvasSignature(canvas) {
    const width = canvas.width || Math.round(canvas.getBoundingClientRect().width);
    const height = canvas.height || Math.round(canvas.getBoundingClientRect().height);
    const signature = `${width}x${height}`;
    if (width <= 1 || height <= 1) {
      return signature;
    }
    try {
      const probe = document.createElement("canvas");
      probe.width = 16;
      probe.height = 16;
      const probeCtx = probe.getContext("2d", {
        alpha: false,
        desynchronized: true
      });
      if (!probeCtx) {
        return signature;
      }
      probeCtx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const tinyDataUrl = probe.toDataURL("image/jpeg", 0.45);
      return `${signature}|${tinyDataUrl.slice(-128)}`;
    } catch {
      const rect = canvas.getBoundingClientRect();
      const timeBucket = Math.floor(Date.now() / 5000);
      return `${signature}|tainted|${Math.round(rect.left)}x${Math.round(rect.top)}|${Math.round(window.scrollX)}x${Math.round(window.scrollY)}|${timeBucket}`;
    }
  }
  runtime.computeCanvasSignature = computeCanvasSignature;
  function resolveImageUrl(img) {
    if (img.dataset.mtEmbeddedActive === "true") {
      const currentSource = String(img.currentSrc || img.getAttribute("src") || "").trim();
      if (runtime.isDataUrl(currentSource) && img.dataset.mtEmbeddedOriginalSource) {
        return img.dataset.mtEmbeddedOriginalSource;
      }
      if (currentSource && !runtime.isDataUrl(currentSource)) {
        delete img.dataset.mtEmbeddedActive;
        delete img.dataset.mtEmbeddedOutputKey;
        delete img.dataset.mtEmbeddedOriginalSource;
        delete img.dataset.mtEmbeddedOriginalSrc;
        delete img.dataset.mtEmbeddedOriginalSrcset;
      }
    }
    const candidates = [img.currentSrc, img.getAttribute("src"), img.getAttribute("data-src"), img.getAttribute("data-original"), img.getAttribute("data-lazy-src")].filter(Boolean);
    if (candidates.length === 0) {
      return "";
    }
    const first = String(candidates[0]).trim();
    if (!first) {
      return "";
    }
    if (first.startsWith("data:")) {
      return first;
    }
    if (first.startsWith("blob:")) {
      return first;
    }
    try {
      if (first.startsWith("//")) {
        return `${location.protocol}${first}`;
      }
      return new URL(first, location.href).href;
    } catch {
      return first;
    }
  }
  runtime.resolveImageUrl = resolveImageUrl;
}
