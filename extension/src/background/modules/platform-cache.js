export function installPlatformCache(runtime) {
  function getErrorMessage(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    return String(error);
  }
  runtime.getErrorMessage = getErrorMessage;
  async function handleGetCacheStats() {
    try {
      const store = await runtime.storageGet(null);
      const cacheKeys = Object.keys(store).filter(runtime.isTranslationCacheKey);
      let aliveCount = 0;
      let staleCount = 0;
      let bytes = 0;
      for (const key of cacheKeys) {
        const entry = store[key];
        if (!entry || typeof entry !== "object") {
          staleCount += 1;
          continue;
        }
        const timestamp = Number(entry.timestamp || 0);
        if (!timestamp || Date.now() - timestamp > runtime.CACHE_TTL_MS) {
          staleCount += 1;
        } else {
          aliveCount += 1;
        }
        bytes += JSON.stringify(entry).length;
      }
      return {
        ok: true,
        stats: {
          aliveCount,
          staleCount,
          totalCount: cacheKeys.length,
          approxKB: Math.round(bytes / 1024)
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: `Read cache stats failed: ${runtime.getErrorMessage(error)}`
      };
    }
  }
  runtime.handleGetCacheStats = handleGetCacheStats;
  async function handleClearCache() {
    try {
      const store = await runtime.storageGet(null);
      const cacheKeys = Object.keys(store).filter(runtime.isTranslationCacheKey);
      if (cacheKeys.length > 0) {
        await runtime.storageRemove(cacheKeys);
      }
      return {
        ok: true,
        removed: cacheKeys.length
      };
    } catch (error) {
      return {
        ok: false,
        error: `Clear cache failed: ${runtime.getErrorMessage(error)}`
      };
    }
  }
  runtime.handleClearCache = handleClearCache;
  async function handleReportStatus(message, sender) {
    const tabIdRaw = message.tabId !== undefined ? message.tabId : sender && sender.tab ? sender.tab.id : null;
    const tabId = Number(tabIdRaw);
    if (!Number.isInteger(tabId) || tabId < 0) {
      return {
        ok: false,
        error: "Valid tab id is required"
      };
    }
    const status = {
      timestamp: Date.now(),
      level: String(message.level || "info"),
      message: String(message.message || ""),
      details: message.details && typeof message.details === "object" ? message.details : {},
      pageUrl: String(message.pageUrl || (sender && sender.url ? sender.url : ""))
    };
    await runtime.storageSet({
      [runtime.buildTabStatusKey(tabId)]: status
    });
    return {
      ok: true
    };
  }
  runtime.handleReportStatus = handleReportStatus;
  async function handleGetTabStatus(message) {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) {
      return {
        ok: true,
        status: null
      };
    }
    const key = runtime.buildTabStatusKey(tabId);
    const store = await runtime.storageGet([key]);
    const status = store[key];
    if (!status || typeof status !== "object") {
      return {
        ok: true,
        status: null
      };
    }
    if (Date.now() - Number(status.timestamp || 0) > runtime.TAB_STATUS_TTL_MS) {
      await runtime.storageRemove([key]);
      return {
        ok: true,
        status: null
      };
    }
    return {
      ok: true,
      status
    };
  }
  runtime.handleGetTabStatus = handleGetTabStatus;
  async function saveTabStatus(tabIdRaw, status) {
    const tabId = Number(tabIdRaw);
    if (!Number.isInteger(tabId) || tabId < 0) {
      return;
    }
    await runtime.storageSet({
      [runtime.buildTabStatusKey(tabId)]: {
        timestamp: Date.now(),
        level: status.level || "info",
        message: status.message || "",
        details: status.details || {},
        pageUrl: status.pageUrl || ""
      }
    });
  }
  runtime.saveTabStatus = saveTabStatus;
  async function pruneExpiredTabStatuses() {
    const store = await runtime.storageGet(null);
    const now = Date.now();
    const staleKeys = [];
    for (const key of Object.keys(store)) {
      if (!key.startsWith(runtime.TAB_STATUS_PREFIX)) {
        continue;
      }
      const item = store[key];
      const timestamp = Number(item && item.timestamp ? item.timestamp : 0);
      if (!timestamp || now - timestamp > runtime.TAB_STATUS_TTL_MS) {
        staleKeys.push(key);
      }
    }
    if (staleKeys.length > 0) {
      await runtime.storageRemove(staleKeys);
    }
  }
  runtime.pruneExpiredTabStatuses = pruneExpiredTabStatuses;
  function buildCacheKey({
    provider,
    model,
    baseUrl,
    captureMode,
    localOcrBaseUrl,
    localOcrLang,
    localOcrMode,
    localOcrDetThresh,
    localOcrDetBoxThresh,
    localOcrDetUnclipRatio,
    localOcrDebug,
    ocrConfidenceThreshold,
    ocrMinBoxArea,
    ocrMaxBoxArea,
    ocrMinBoxWidth,
    ocrMinBoxHeight,
    ocrMaxAspectRatio,
    ocrMergeLineGap,
    overwriteFontScale,
    overwriteCoverPadding,
    debugOverlayMode,
    overwritePreviewMode,
    visionOcrEnabled,
    visionOcrBaseUrl,
    visionOcrModel,
    glossaryFingerprint,
    imageUrl,
    targetKey,
    ocrMode,
    sourceToken,
    fallbackReason,
    stitchAdmission,
    dataUrl
  }) {
    const source = [provider, model, baseUrl || "", captureMode || "", localOcrBaseUrl || "", localOcrLang || "", localOcrMode || "", localOcrDetThresh || "", localOcrDetBoxThresh || "", localOcrDetUnclipRatio || "", localOcrDebug ? "debug" : "", ocrConfidenceThreshold || "", ocrMinBoxArea || "", ocrMaxBoxArea || "", ocrMinBoxWidth || "", ocrMinBoxHeight || "", ocrMaxAspectRatio || "", ocrMergeLineGap || "", overwriteFontScale || "", overwriteCoverPadding || "", debugOverlayMode || "", overwritePreviewMode || "", visionOcrEnabled ? "vision-ocr" : "", visionOcrBaseUrl || "", visionOcrModel || "", glossaryFingerprint || "", imageUrl || "", targetKey || "", runtime.normalizeOcrRequestMode(ocrMode), sourceToken || "", fallbackReason || "", stitchAdmission || "", dataUrl.slice(0, 220), String(dataUrl.length)].join("|");
    return `${runtime.CACHE_PREFIX}${runtime.hashString(source)}`;
  }
  runtime.buildCacheKey = buildCacheKey;
  async function getCache(cacheKey) {
    const store = await runtime.storageGet([cacheKey]);
    const entry = store[cacheKey];
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const timestamp = Number(entry.timestamp || 0);
    if (!timestamp || Date.now() - timestamp > runtime.CACHE_TTL_MS) {
      await runtime.storageRemove([cacheKey]);
      return null;
    }
    return entry.value || null;
  }
  runtime.getCache = getCache;
  async function setCache(cacheKey, value) {
    const entry = {
      [cacheKey]: {
        timestamp: Date.now(),
        value: String(cacheKey || "").startsWith(runtime.OCR_CACHE_PREFIX) ? runtime.buildCacheSafeOcrResult(value) : runtime.buildCacheSafeTranslationResult(value)
      }
    };
    try {
      await runtime.storageSet(entry);
      return true;
    } catch (error) {
      if (!runtime.isStorageQuotaError(error)) {
        console.warn("[MangaTranslator] Cache write failed; translation will continue without cache.", error);
        return false;
      }
    }
    try {
      const store = await runtime.storageGet(null);
      const cacheKeys = Object.keys(store).filter(runtime.isTranslationCacheKey);
      if (cacheKeys.length > 0) {
        await runtime.storageRemove(cacheKeys);
      }
      await runtime.storageSet(entry);
      console.info(`[MangaTranslator] Storage quota recovered by clearing ${cacheKeys.length} translation cache entries.`);
      return true;
    } catch (error) {
      // 缓存是可选加速层，即使单条结果仍然过大，也不能让已完成的翻译失败。
      console.warn("[MangaTranslator] Cache quota recovery failed; translation will continue without cache.", error);
      return false;
    }
  }
  runtime.setCache = setCache;
  function isTranslationCacheKey(key) {
    return runtime.TRANSLATION_CACHE_KEY_RE.test(String(key || ""));
  }
  runtime.isTranslationCacheKey = isTranslationCacheKey;
  function isStorageQuotaError(error) {
    return /quota|kQuotaBytes/i.test(runtime.getErrorMessage(error));
  }
  runtime.isStorageQuotaError = isStorageQuotaError;
  function buildCacheSafeTranslationResult(value) {
    if (!value || typeof value !== "object") {
      return value;
    }

    // 清理图和逐阶段调试数据可能达到数 MB；缓存只保留重新渲染所需的翻译气泡。
    const {
      cleanedImage: _cleanedImage,
      cleanedImageToken: _cleanedImageToken,
      debug: _debug,
      ...cacheSafeValue
    } = value;
    return {
      ...cacheSafeValue,
      ...(runtime.translationResultNeedsCleanedImage(value) ? {
        requiresCleanedImage: true
      } : {})
    };
  }
  runtime.buildCacheSafeTranslationResult = buildCacheSafeTranslationResult;
  function translationResultNeedsCleanedImage(value) {
    return Boolean(value && (value.requiresCleanedImage === true || Array.isArray(value.bubbles) && value.bubbles.some(bubble => runtime.normalizeBgType(bubble && bubble.bg_type) === "none")));
  }
  runtime.translationResultNeedsCleanedImage = translationResultNeedsCleanedImage;
}
