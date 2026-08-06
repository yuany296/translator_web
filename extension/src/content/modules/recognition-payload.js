export function installRecognitionPayload(runtime) {
  async function extractTargetPayload(target, targetKey, options = {}) {
    const cacheKey = String(targetKey || runtime.computeTargetKey(target));
    // 优先检查 stitch 专用缓存 key，避免单图缓存误吞拼接版本
    if (options.skipKakaoStitch !== true) {
      const cachedStitch = runtime.getPayloadCache(cacheKey + "|stitch");
      if (cachedStitch) {
        return cachedStitch;
      }
    }
    const cached = runtime.getPayloadCache(cacheKey);
    if (cached) {
      return cached;
    }
    let payload = null;
    if (runtime.isScreenshotCaptureMode()) {
      payload = await runtime.captureVisibleTargetPayload(target, null, runtime.buildScreenshotImageUrl(target));
      payload = runtime.enrichPayloadForTarget(payload, target);
      runtime.rememberPayloadCache(cacheKey, payload);
      return payload;
    }
    if (target instanceof HTMLImageElement) {
      payload = await runtime.extractImagePayload(target);
    } else if (target instanceof HTMLCanvasElement) {
      payload = await runtime.extractCanvasPayload(target);
    } else if (runtime.isBackgroundImageTarget(target)) {
      payload = await runtime.extractBackgroundImagePayload(target);
    } else {
      throw new Error("Unsupported target element");
    }
    payload = await runtime.normalizeKakaopagePayload(target, payload, options);
    payload = runtime.enrichPayloadForTarget(payload, target);

    // 单图版本始终缓存到普通 key
    const singlePayload = payload;
    if (options.skipKakaoStitch === true) {
      runtime.rememberPayloadCache(cacheKey, singlePayload);
      return singlePayload;
    }
    if (runtime.shouldUseKakaoStitchedOcr(target, singlePayload)) {
      const stitched = await runtime.buildKakaoStitchedPayload(target, singlePayload);
      if (stitched.stitchAdmission === "accepted") {
        // 拼接版本用独立缓存键 (single | stitch 隔离)
        runtime.rememberPayloadCache(cacheKey + "|stitch", stitched);
        runtime.tracePipeline("requested", target, {
          ocrMode: "stitch",
          stitchKey: stitched.stitchKey,
          neighbors: stitched.stitch && stitched.stitch.sourceKeys || []
        });
        return stitched;
      }
      // 拼接被拒绝，回退到单图
      runtime.rememberPayloadCache(cacheKey, singlePayload);
      runtime.tracePipeline("stitch-rejected", target, {
        stitchRejection: stitched.stitchRejectionReason
      });
      return singlePayload;
    }
    runtime.rememberPayloadCache(cacheKey, payload);
    return payload;
  }
  runtime.extractTargetPayload = extractTargetPayload;
  function enrichPayloadForTarget(payload, target) {
    if (!payload || !target) {
      return payload;
    }
    const rect = target.getBoundingClientRect();
    const sourceWidth = target instanceof HTMLImageElement ? Number(target.naturalWidth || target.width || rect.width) : target instanceof HTMLCanvasElement ? Number(target.width || rect.width) : Number(payload.width || rect.width);
    const sourceHeight = target instanceof HTMLImageElement ? Number(target.naturalHeight || target.height || rect.height) : target instanceof HTMLCanvasElement ? Number(target.height || rect.height) : Number(payload.height || rect.height);
    return {
      ...payload,
      ocrMode: String(payload.ocrMode || "single"),
      sourceToken: runtime.getQuickSourceToken(target),
      sourceImageId: runtime.getSourceImageIdForTarget(target),
      sourceWidth,
      sourceHeight,
      targetCssWidth: Number(rect.width || 0),
      targetCssHeight: Number(rect.height || 0),
      ...(runtime.isNovelImageTarget?.(target) === true ? { novelImage: true } : {}),
      coordinateSpace: payload.source === "visible-tab-crop" ? "source-image-v1" : String(payload.coordinateSpace || "ocr-image-v1")
    };
  }
  runtime.enrichPayloadForTarget = enrichPayloadForTarget;
  function getSourceImageIdForTarget(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return "";
    }
    const rect = target.getBoundingClientRect();
    const width = target instanceof HTMLImageElement ? Number(target.naturalWidth || target.width || rect.width) : target instanceof HTMLCanvasElement ? Number(target.width || rect.width) : Number(rect.width || 0);
    const height = target instanceof HTMLImageElement ? Number(target.naturalHeight || target.height || rect.height) : target instanceof HTMLCanvasElement ? Number(target.height || rect.height) : Number(rect.height || 0);
    const sourceToken = target instanceof HTMLCanvasElement ? `canvas:${runtime.computeCanvasSignature(target)}` : runtime.getQuickSourceToken(target);
    return `image-${runtime.hashSourceIdentity(sourceToken)}|${Math.round(width)}x${Math.round(height)}`;
  }
  runtime.getSourceImageIdForTarget = getSourceImageIdForTarget;
  function hashSourceIdentity(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  runtime.hashSourceIdentity = hashSourceIdentity;
  function buildTargetSourceCacheKey(targetKey, sourceToken) {
    const base = String(targetKey || "");
    const token = String(sourceToken || "");
    return token ? `${base}|src:${runtime.hashSourceIdentity(token)}` : base;
  }
  runtime.buildTargetSourceCacheKey = buildTargetSourceCacheKey;
  function shouldUseKakaoCanonicalPipeline(target) {
    return !!(runtime.IS_KAKAOPAGE_READER && runtime.state.captureMode === runtime.CAPTURE_MODE_DIRECT && runtime.state.renderMode === runtime.RENDER_MODE_OVERLAY && target instanceof HTMLImageElement);
  }
  runtime.shouldUseKakaoCanonicalPipeline = shouldUseKakaoCanonicalPipeline;
  function isKakaoEpisodeImageTarget(target) {
    if (!(target instanceof HTMLImageElement) || typeof target.getBoundingClientRect !== "function") {
      return false;
    }
    const rect = target.getBoundingClientRect();
    const displayWidth = Number(rect && rect.width || 0);
    const naturalWidth = Number(target.naturalWidth || 0);
    return displayWidth >= 240 && (naturalWidth <= 0 || naturalWidth >= 240);
  }
  runtime.isKakaoEpisodeImageTarget = isKakaoEpisodeImageTarget;
  function isKakaoReaderContentTarget(target) {
    if (!runtime.IS_KAKAOPAGE_READER || !(target instanceof HTMLImageElement)) {
      return false;
    }
    const source = String(target.currentSrc || target.src || "");
    if (/dn-img-page\.kakao\.com/i.test(source)) {
      return false;
    }
    return /dw-img-page\.kakao\.com/i.test(source) && runtime.isKakaoEpisodeImageTarget(target);
  }
  runtime.isKakaoReaderContentTarget = isKakaoReaderContentTarget;
  function getStableChapterUrl() {
    const href = String(typeof location !== "undefined" && location.href || `${typeof location !== "undefined" && location.origin || ""}${typeof location !== "undefined" && location.pathname || ""}${typeof location !== "undefined" && location.search || ""}`);
    const hashIndex = href.indexOf("#");
    return hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  }
  runtime.getStableChapterUrl = getStableChapterUrl;
  function normalizeKakaoStableImageSource(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    // Inline data has no stable identity independent of its bytes.
    if (runtime.isDataUrl(raw)) return "";
    // Blob URLs carry a document-local object token that distinguishes equal-size pages.
    if (runtime.isBlobUrl(raw)) {
      const hashIndex = raw.indexOf("#");
      return hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    }
    try {
      const base = typeof location !== "undefined" && location.href || undefined;
      const url = new URL(raw, base);
      url.hash = "";
      const retained = [];
      for (const [key, itemValue] of url.searchParams.entries()) {
        if (!runtime.KAKAO_AUTH_QUERY_PARAM_RE.test(key)) {
          retained.push([key, itemValue]);
        }
      }
      retained.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
      url.search = "";
      for (const [key, itemValue] of retained) {
        url.searchParams.append(key, itemValue);
      }
      return url.toString();
    } catch {
      return raw.replace(/([?&])(?:signature|credential|expires|policy|token|key-pair-id|x-amz-[^=&]+)=[^&#]*/gi, "$1").replace(/[?&]+$/, "").replace(/\?&/, "?");
    }
  }
  runtime.normalizeKakaoStableImageSource = normalizeKakaoStableImageSource;
  function buildKakaoPageSourceIdentity(rawSource, stableSource, imageRevision) {
    const normalized = String(stableSource || "");
    if (!normalized) return `inline:${String(imageRevision || "")}`;
    try {
      const base = typeof location !== "undefined" && location.href || undefined;
      const rawUrl = new URL(String(rawSource || ""), base);
      const stableUrl = new URL(normalized, base);
      const usesOpaqueToken = [...rawUrl.searchParams.keys()].some(key => /^token$/i.test(key));
      const genericResourceEndpoint = /\/s?download\/resource\/?$/i.test(stableUrl.pathname);
      // Kakao 正文 URL 把真实资源身份放在 opaque token 中；若直接删除 token，
      // 同尺寸的整章图片会全部折叠成同一个 pageId。此类端点改用图片字节摘要，
      // 既区分不同页面，也能让同一图片在 token 刷新后保持稳定身份。
      if (usesOpaqueToken && genericResourceEndpoint) {
        return `${normalized}#content-revision=${String(imageRevision || "")}`;
      }
    } catch {
      // URL 无法解析时保留原有稳定源，后续仍由 revision guard 保护。
    }
    return normalized;
  }
  runtime.buildKakaoPageSourceIdentity = buildKakaoPageSourceIdentity;
  async function sha256HexBytes(bytes) {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject && cryptoObject.subtle && typeof cryptoObject.subtle.digest === "function") {
      const digest = await cryptoObject.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    }
    let fallback = 2166136261;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const value of view) {
      fallback ^= value;
      fallback = Math.imul(fallback, 16777619);
    }
    return (fallback >>> 0).toString(16).padStart(8, "0");
  }
  runtime.sha256HexBytes = sha256HexBytes;
  async function sha256HexText(value) {
    return runtime.sha256HexBytes(new TextEncoder().encode(String(value || "")));
  }
  runtime.sha256HexText = sha256HexText;
  function dataUrlToBytes(dataUrl) {
    const raw = String(dataUrl || "");
    const commaIndex = raw.indexOf(",");
    if (commaIndex < 0) {
      return new TextEncoder().encode(raw);
    }
    const header = raw.slice(0, commaIndex);
    const body = raw.slice(commaIndex + 1);
    if (/;base64(?:;|$)/i.test(header)) {
      const decoded = atob(body);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  }
  runtime.dataUrlToBytes = dataUrlToBytes;
  async function buildKakaoPageIdentity(target, payload, context = {}) {
    const width = Math.max(1, Math.round(Number(payload && (payload.sourceWidth || payload.width) || target && (target.naturalWidth || target.width) || 0)));
    const height = Math.max(1, Math.round(Number(payload && (payload.sourceHeight || payload.height) || target && (target.naturalHeight || target.height) || 0)));
    const imageRevision = await runtime.sha256HexBytes(runtime.dataUrlToBytes(payload && payload.dataUrl));
    const chapterId = `chapter-${await runtime.sha256HexText(runtime.getStableChapterUrl())}`;
    const rawSource = String(payload && payload.imageUrl || payload && payload.sourceToken || context.sourceToken || target && target.dataset && runtime.getQuickSourceToken(target) || payload && payload.sourceImageId || "");
    const normalizedStableSource = runtime.normalizeKakaoStableImageSource(rawSource) || `inline:${imageRevision}`;
    const stableSource = runtime.buildKakaoPageSourceIdentity(rawSource, normalizedStableSource, imageRevision);
    const pageId = `page-${await runtime.sha256HexText(`${chapterId}\n${stableSource}\n${width}x${height}`)}`;
    const rect = target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    const identity = Object.freeze({
      chapterId,
      pageId,
      imageRevision,
      stableSource,
      width,
      height,
      readingOrder: Number(rect && rect.top || 0) + Number(window.scrollY || 0),
      shortPage: height <= 420 || height / Math.max(1, width) <= 0.45,
      imageMeta: Object.freeze({
        ...runtime.buildPayloadImageMeta(payload),
        chapterId,
        pageId,
        imageRevision,
        stableSource,
        sourceType: "page",
        pageIds: [pageId],
        imageRevisionByPage: {
          [pageId]: imageRevision
        }
      }),
      targetKey: String(context.targetKey || ""),
      scopedTargetKey: String(context.scopedTargetKey || ""),
      sourceToken: String(context.sourceToken || payload && payload.sourceToken || target && target.dataset && runtime.getQuickSourceToken(target) || "")
    });
    if (context.deferBind !== true) runtime.bindKakaoTargetToPage(target, pageId, imageRevision);
    return identity;
  }
  runtime.buildKakaoPageIdentity = buildKakaoPageIdentity;
  function bindKakaoTargetToPage(target, pageId, imageRevision = "") {
    if (!target || !pageId) {
      return;
    }
    const previousPageId = runtime.state.kakaoPageIdByTarget.get(target);
    if (previousPageId && previousPageId !== pageId) {
      const previousTargets = runtime.state.kakaoTargetsByPageId.get(previousPageId);
      if (previousTargets) {
        previousTargets.delete(target);
        if (previousTargets.size === 0) runtime.state.kakaoTargetsByPageId.delete(previousPageId);
      }
    }
    runtime.state.kakaoPageIdByTarget.set(target, pageId);
    const storedRevision = runtime.state.kakaoStore && typeof runtime.state.kakaoStore.getPageHandle === "function" ? runtime.state.kakaoStore.getPageHandle(pageId)?.imageRevision || "" : "";
    const currentRevision = String(imageRevision || (previousPageId === pageId ? runtime.state.kakaoImageRevisionByTarget.get(target) : "") || storedRevision || "");
    if (currentRevision) runtime.state.kakaoImageRevisionByTarget.set(target, currentRevision);else runtime.state.kakaoImageRevisionByTarget.delete(target);
    const targets = runtime.state.kakaoTargetsByPageId.get(pageId) || new Set();
    targets.add(target);
    runtime.state.kakaoTargetsByPageId.set(pageId, targets);

    // handle 已建立，触发 pending 邻页 seam
    if (runtime.state.pendingKakaoAdjacency && runtime.state.pendingKakaoAdjacency.size > 0 && runtime.kakaoCanonicalPipeline) {
      runtime.resolvePendingKakaoAdjacency(target, pageId);
    }
  }
  runtime.bindKakaoTargetToPage = bindKakaoTargetToPage;
  function queuePendingKakaoAdjacency(target, previous) {
    if (!target || !previous || target === previous) return false;
    if (!runtime.state.pendingKakaoAdjacency) runtime.state.pendingKakaoAdjacency = new Map();
    runtime.state.pendingKakaoAdjacency.set(target, previous);
    return true;
  }
  runtime.queuePendingKakaoAdjacency = queuePendingKakaoAdjacency;
  function hasPendingKakaoAdjacency(target) {
    return !!runtime.state.pendingKakaoAdjacency?.has(target);
  }
  runtime.hasPendingKakaoAdjacency = hasPendingKakaoAdjacency;
  function getReadyKakaoAdjacencyHandle(store, target) {
    if (!store || typeof store.getPageHandleForTarget !== "function") return null;
    const handle = store.getPageHandleForTarget(target);
    if (!handle || handle.pageOcrState !== "ready") return null;
    const terminal = typeof store.getPageTerminal === "function" ? store.getPageTerminal(handle.pageId) : null;
    if (!terminal || terminal.state !== "ready") return null;
    const terminalRevision = String(terminal.details && terminal.details.imageRevision || "");
    return terminalRevision && terminalRevision !== String(handle.imageRevision || "") ? null : handle;
  }
  runtime.getReadyKakaoAdjacencyHandle = getReadyKakaoAdjacencyHandle;
  function resolvePendingKakaoAdjacency(target, _pageId) {
    const pending = runtime.state.pendingKakaoAdjacency;
    const pipeline = runtime.kakaoCanonicalPipeline;
    const store = runtime.state.kakaoStore;
    if (!pending || !pending.size || !pipeline || typeof pipeline.onAdjacentTargetAvailable !== "function") {
      return Promise.resolve([]);
    }
    const candidates = [];
    const directPrevious = pending.get(target);
    if (directPrevious) candidates.push([target, directPrevious]);
    // 也检查是否有其他 target pending 和本 target 配对
    for (const [pendingTarget, pendingPrevious] of pending) {
      if (pendingPrevious === target) candidates.push([pendingTarget, pendingPrevious]);
    }
    const jobs = [];
    const visited = new Set();
    for (const [pendingTarget, pendingPrevious] of candidates) {
      if (!pendingTarget || visited.has(pendingTarget)) continue;
      visited.add(pendingTarget);
      if (pendingTarget.isConnected === false || pendingPrevious.isConnected === false) {
        pending.delete(pendingTarget);
        continue;
      }
      const previousHandle = runtime.getReadyKakaoAdjacencyHandle(store, pendingPrevious);
      const targetHandle = runtime.getReadyKakaoAdjacencyHandle(store, pendingTarget);
      // commitPageIdentity 早于 page handle/terminal ready；此时必须保留关系等待再次通知。
      if (!previousHandle || !targetHandle) continue;
      pending.delete(pendingTarget);
      jobs.push(Promise.resolve(pipeline.onAdjacentTargetAvailable(pendingPrevious, pendingTarget)).catch(error => {
        console.warn("[MangaTranslator][Kakao canonical] pending adjacent reconcile failed:", error);
        return { ok: false, error: runtime.getErrorMessage(error) };
      }));
    }
    return jobs.length ? Promise.all(jobs) : Promise.resolve([]);
  }
  runtime.resolvePendingKakaoAdjacency = resolvePendingKakaoAdjacency;
}
