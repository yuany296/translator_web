export function installOcrPipeline(runtime) {
  async function handleOcrDataUrl(message) {
    const dataUrl = String(message && message.dataUrl || "").trim();
    if (!runtime.isDataUrl(dataUrl)) {
      return {
        ok: false,
        error: "Invalid or empty image data URL"
      };
    }
    const sourceType = runtime.normalizeObservationSourceType(message && message.sourceType);
    const pageIds = runtime.normalizeObservationPageIds(message && message.pageIds);
    if (pageIds.length === 0) {
      return {
        ok: false,
        error: "OCR_DATA_URL requires at least one stable pageId"
      };
    }
    if (sourceType === "page" && pageIds.length !== 1) {
      return {
        ok: false,
        error: "Page OCR must reference exactly one pageId"
      };
    }
    if (sourceType === "seam" && pageIds.length < 2) {
      return {
        ok: false,
        error: "Seam OCR must reference both adjacent pageIds"
      };
    }
    const settings = await runtime.loadSettings();
    const validationError = runtime.validateOcrOnlySettings(settings);
    if (validationError) {
      return {
        ok: false,
        error: validationError
      };
    }
    const imageDigest = await runtime.digestDataUrlSha256(dataUrl);
    const imageRevisionByPage = runtime.normalizeImageRevisionByPage(pageIds, message && (message.imageRevisionByPage || message.imageRevision), imageDigest);
    if (sourceType === "page") {
      imageRevisionByPage[pageIds[0]] = imageDigest;
    }
    const normalizedMeta = runtime.normalizeImageMeta(message && message.imageMeta) || {};
    const imageMeta = {
      ...normalizedMeta,
      pageSpans: runtime.normalizeObservationPageSpanMeta(message && message.imageMeta && message.imageMeta.pageSpans)
    };
    const cleanedMasks = runtime.normalizeCleanedMasks(message && message.cleanedMasks);
    const request = {
      dataUrl,
      sourceType,
      pageIds,
      imageRevisionByPage,
      imageDigest,
      imageMeta,
      targetKey: String(message && message.targetKey || "").trim(),
      cleanedMasks,
      requireCleanedImage: message && message.requireCleanedImage === true,
      // 该标志只控制易失的渲染图像产物，不参与 OCR 语义缓存指纹。
      forceCleanedImageArtifact: message && message.forceCleanedImageArtifact === true
    };
    const cacheKey = runtime.buildOcrCacheKey({
      request,
      settings
    });
    const wantsCleanedImageArtifact = Boolean(settings.provider === runtime.PROVIDERS.localPaddle && (request.requireCleanedImage || request.forceCleanedImageArtifact));
    // 清理图是易失渲染产物，不进入持久语义缓存指纹；但并发中的强制产物请求
    // 不能复用一个未请求 cleaned image 的普通 OCR promise。
    const artifactFingerprint = wantsCleanedImageArtifact ? runtime.buildCleanedMasksFingerprint(cleanedMasks) : "none";
    const inflightKey = `${cacheKey}:cleaned-image:${wantsCleanedImageArtifact ? "1" : "0"}:${artifactFingerprint}`;
    let cached = settings.localOcrDebug ? null : await runtime.getCache(cacheKey);
    const shouldRefreshCleanedImage = Boolean(cached && request.requireCleanedImage && settings.provider === runtime.PROVIDERS.localPaddle && (cached.requiresCleanedImage === true || request.forceCleanedImageArtifact) && !runtime.isDataUrl(cached.cleanedImage));
    if (cached && !shouldRefreshCleanedImage) {
      return {
        ok: true,
        result: runtime.deepFreezeObservationResult(cached),
        cached: true
      };
    }
    if (runtime.inflightOcrByCacheKey.has(inflightKey)) {
      return runtime.inflightOcrByCacheKey.get(inflightKey);
    }
    const task = (async () => {
      try {
        const refreshed = await runtime.requestProviderNeutralOcr({
          request,
          settings
        });
        // 持久 OCR 缓存中的 Observation 是权威语义结果。暖缓存仅因渲染需要
        // cleaned image 而刷新时，只取新的图像产物，避免一次非确定性 OCR
        // 重新改写 canonical 证据并触发不必要的翻译。
        const result = shouldRefreshCleanedImage ? runtime.deepFreezeObservationResult({
          ...cached,
          ...(runtime.isDataUrl(refreshed && refreshed.cleanedImage) ? {
            cleanedImage: refreshed.cleanedImage
          } : {}),
          ...(String(refreshed && refreshed.cleanedImageToken || "") ? {
            cleanedImageToken: String(refreshed.cleanedImageToken)
          } : {})
        }) : refreshed;
        await runtime.setCache(cacheKey, result);
        return {
          ok: true,
          result,
          cached: false
        };
      } catch (error) {
        return {
          ok: false,
          error: `OCR failed (${settings.provider}): ${runtime.getErrorMessage(error) || "Unknown OCR error"}`
        };
      } finally {
        runtime.inflightOcrByCacheKey.delete(inflightKey);
      }
    })();
    runtime.inflightOcrByCacheKey.set(inflightKey, task);
    return task;
  }
  runtime.handleOcrDataUrl = handleOcrDataUrl;
  async function handleTranslateTextBlocks(message, sender = {}) {
    const mode = message && message.mode === "webpage" ? "webpage" : "comic";
    const rawItems = Array.isArray(message && message.items) ? message.items : [];
    if (rawItems.some(item => !String(item && item.id || "").trim())) {
      return {
        ok: false,
        error: "TRANSLATE_TEXT_BLOCKS requires a stable canonical id for every item"
      };
    }
    const items = rawItems.map(item => ({
      id: String(item && item.id || "").trim(),
      revision: runtime.normalizeCanonicalRevision(item && item.revision),
      original_text: runtime.normalizeTranslationSourceText(item && item.original_text),
      non_translate: item && item.non_translate === true
    })).filter(item => item.original_text);
    if (items.length === 0) {
      return {
        ok: true,
        partial: false,
        translations: [],
        errors: []
      };
    }
    const translatableItems = items.filter(item => !item.non_translate);
    if (translatableItems.length === 0) {
      return {
        ok: true,
        partial: false,
        translations: items.map(item => ({
          id: item.id,
          revision: item.revision,
          translated_text: item.original_text,
          translationFingerprint: `passthrough_${runtime.stableHash128(item.original_text)}`,
          cached: true
        })),
        errors: []
      };
    }
    const settings = await runtime.loadSettings();
    const sourceLanguage = runtime.normalizeLanguageTag(message && message.sourceLanguage, "auto");
    const targetLanguage = runtime.normalizeLanguageTag(message && message.targetLanguage, "zh-CN");
    const translationOptions = message && message.translationOptions;
    const glossaryContext = {
      scopeKey: String(translationOptions && translationOptions.scopeKey || "")
    };
    const force = message && message.force === true;
    const descriptors = mode === "comic" ? runtime.buildComicTranslationDescriptors(
      translatableItems, sourceLanguage, targetLanguage, translationOptions
        || {}
    ) : [];
    let outcome = new Map();
    let serviceOnline = true;
    let serviceError = "";
    const bypassOfficialLibrary = Boolean(runtime.backgroundTestHooks?.requestCanonicalTranslationBatch)
      || !globalThis.indexedDB;
    if (mode === "comic" && !bypassOfficialLibrary) {
      const official = force
        ? await runtime.getTranslationServiceStatus()
        : await runtime.loadOfficialComicTranslations(descriptors);
      serviceOnline = official.online ?? official.ok === true;
      serviceError = official.error || "本地服务未启动，当前仅显示已缓存译文";
      if (official.outcome) outcome = official.outcome;
    }
    const requestItems = translatableItems.filter(item =>
      !outcome.has(runtime.canonicalTranslationItemKey(item))
    );
    if (requestItems.length && (!serviceOnline || !settings.apiKey)) {
      const error = !serviceOnline ? serviceError
        : "Translation API Key is missing. Please configure it in popup.";
      requestItems.forEach(item => outcome.set(runtime.canonicalTranslationItemKey(item), { error }));
    }
    const taskId = String(message && message.taskId || "");
    const controller = taskId ? new AbortController() : null;
    if (controller) runtime.registerTaskAbort(taskId, controller, sender && sender.tab && sender.tab.id);
    try {
      const requested = requestItems.length && serviceOnline && settings.apiKey
        ? await runtime.requestCanonicalTextTranslations({
        items: requestItems,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL,
        model: settings.model || runtime.DEFAULT_TRANSLATION_MODEL,
        sourceLanguage,
        targetLanguage,
        promptVersion: String(message && message.promptVersion || (mode === "webpage" ? runtime.WEBPAGE_TRANSLATION_PROMPT_VERSION : runtime.CANONICAL_TRANSLATION_PROMPT_VERSION)),
        translationOptions,
        glossary: settings.glossary,
        glossaryFingerprint: runtime.glossaryCore.getFingerprint(settings.glossary, glossaryContext),
        force,
        mode,
        signal: controller ? controller.signal : null,
        taskId
      }) : new Map();
      requested.forEach((value, key) => outcome.set(key, value));
    } catch (error) {
      if (controller) runtime.unregisterTaskAbort(taskId, controller);
      if (runtime.isAbortError(error)) {
        return { ok: false, cancelled: true, translations: [], errors: [] };
      }
      throw error;
    }
    if (controller) runtime.unregisterTaskAbort(taskId, controller);
    const configFingerprint = mode === "comic"
      ? await runtime.getTranslationConfigFingerprint("comic") : "";
    const pendingRecordKeys = mode === "comic" && serviceOnline && !bypassOfficialLibrary
      ? await runtime.commitOfficialComicTranslations(descriptors, outcome, configFingerprint)
      : new Set();
    const translations = [];
    const errors = [];
    items.forEach(item => {
      const row = item.non_translate ? {
        translatedText: item.original_text,
        translationFingerprint: `passthrough_${runtime.stableHash128(item.original_text)}`,
        cached: true
      } : outcome.get(runtime.canonicalTranslationItemKey(item));
      if (!row || !row.translatedText) {
        errors.push({
          id: item.id,
          revision: item.revision,
          translationFingerprint: row && row.translationFingerprint || "",
          error: row && row.error || "model_missing_translation"
        });
        return;
      }
      translations.push({
        id: item.id,
        revision: item.revision,
        translated_text: runtime.cleanDecorativeSymbols(row.translatedText),
        translationFingerprint: row.translationFingerprint,
        cached: row.cached === true,
        pending: descriptors.some(descriptor => descriptor.item.id === item.id
          && pendingRecordKeys.has(descriptor.recordKey))
      });
    });
    return {
      ok: errors.length === 0 || translations.length > 0,
      partial: errors.length > 0,
      translations,
      errors,
      ...(errors.length > 0 ? {
        error: `Translation response omitted ${errors.length} item(s)`
      } : {})
    };
  }
  runtime.handleTranslateTextBlocks = handleTranslateTextBlocks;
  function setBackgroundTestHooks(value) {
    runtime.backgroundTestHooks = value && typeof value === "object" ? value : null;
  }
  runtime.setBackgroundTestHooks = setBackgroundTestHooks;
  function normalizeObservationSourceType(value) {
    return String(value || "").trim().toLowerCase() === "seam" ? "seam" : "page";
  }
  runtime.normalizeObservationSourceType = normalizeObservationSourceType;
  function normalizeObservationPageIds(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map(entry => String(entry || "").trim()).filter(entry => entry && !seen.has(entry) && seen.add(entry));
  }
  runtime.normalizeObservationPageIds = normalizeObservationPageIds;
  function normalizeImageRevisionByPage(pageIds, value, fallbackDigest) {
    const provided = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    const scalar = provided ? "" : String(value || "").trim();
    return Object.fromEntries(pageIds.map(pageId => [pageId, String(provided && provided[pageId] || scalar || fallbackDigest || "").trim()]));
  }
  runtime.normalizeImageRevisionByPage = normalizeImageRevisionByPage;
  function normalizeObservationPageSpanMeta(value) {
    return (Array.isArray(value) ? value : []).map(entry => {
      const canvasBox = runtime.normalizeObservationPixelBox(entry && (entry.canvasBox || entry.canvas || entry.drawRect));
      const pageBox = runtime.normalizeObservationPixelBox(entry && (entry.pageBox || entry.sourceBox || entry.cropRect));
      return {
        pageId: String(entry && entry.pageId || "").trim(),
        canvasBox,
        pageBox,
        pageWidth: Math.max(0, Number(entry && (entry.pageWidth || entry.sourceWidth)) || 0),
        pageHeight: Math.max(0, Number(entry && (entry.pageHeight || entry.sourceHeight)) || 0)
      };
    }).filter(entry => entry.pageId && entry.canvasBox && entry.pageBox && entry.pageWidth > 0 && entry.pageHeight > 0);
  }
  runtime.normalizeObservationPageSpanMeta = normalizeObservationPageSpanMeta;
  function normalizeCleanedMasks(value) {
    const unique = new Map();
    // 先规范化和稳定排序，再截取协议上限；这样同一组几何不会因输入顺序
    // 不同而生成另一份 artifact 指纹。
    for (const rawMask of Array.isArray(value) ? value : []) {
      const mask = runtime.normalizeCleanedMask(rawMask);
      if (!mask) continue;
      const key = runtime.stableSerialize(mask);
      if (!unique.has(key)) unique.set(key, mask);
    }
    return [...unique.entries()].sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1).slice(0, runtime.MAX_CLEANED_MASKS).map(([, mask]) => mask);
  }
  runtime.normalizeCleanedMasks = normalizeCleanedMasks;
  function normalizeCleanedMask(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const coordinateSpace = String(value.coordinateSpace || value.coordinate_space || "").trim().toLowerCase();
    if (coordinateSpace !== "percent") return null;
    const box = runtime.normalizeCleanedMaskBox(value.box);
    // 一个 mask 只表达一种明确几何；canonical outer frame 优先使用 box，
    // 避免同时携带较窄 polygon 时由下游误选而再次漏掉半截文字。
    const polygon = box ? null : runtime.normalizeCleanedMaskPolygon(value.polygon);
    if (!box && !polygon) return null;
    return {
      coordinateSpace: "percent",
      ...(box ? {
        box
      } : {}),
      ...(polygon ? {
        polygon
      } : {})
    };
  }
  runtime.normalizeCleanedMask = normalizeCleanedMask;
  function normalizeCleanedMaskBox(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const rawX = Number(value.x ?? value.left);
    const rawY = Number(value.y ?? value.top);
    const rawWidth = Number(value.w ?? value.width);
    const rawHeight = Number(value.h ?? value.height);
    if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite) || rawWidth <= 0 || rawHeight <= 0) {
      return null;
    }
    const left = runtime.quantizeCleanedMaskCoordinate(rawX);
    const top = runtime.quantizeCleanedMaskCoordinate(rawY);
    const right = runtime.quantizeCleanedMaskCoordinate(rawX + rawWidth);
    const bottom = runtime.quantizeCleanedMaskCoordinate(rawY + rawHeight);
    if (right <= left || bottom <= top) return null;
    return {
      x: left,
      y: top,
      w: runtime.quantizeCleanedMaskCoordinate(right - left),
      h: runtime.quantizeCleanedMaskCoordinate(bottom - top)
    };
  }
  runtime.normalizeCleanedMaskBox = normalizeCleanedMaskBox;
  function normalizeCleanedMaskPolygon(value) {
    if (!Array.isArray(value)) return null;
    const points = [];
    const seen = new Set();
    for (const rawPoint of value) {
      const rawX = Number(Array.isArray(rawPoint) ? rawPoint[0] : rawPoint && rawPoint.x);
      const rawY = Number(Array.isArray(rawPoint) ? rawPoint[1] : rawPoint && rawPoint.y);
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
      const point = {
        x: runtime.quantizeCleanedMaskCoordinate(rawX),
        y: runtime.quantizeCleanedMaskCoordinate(rawY)
      };
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(point);
    }
    if (points.length < 3 || runtime.cleanedMaskPolygonArea(points) <= 0) return null;
    return runtime.canonicalizeCleanedMaskPolygon(points);
  }
  runtime.normalizeCleanedMaskPolygon = normalizeCleanedMaskPolygon;
}
