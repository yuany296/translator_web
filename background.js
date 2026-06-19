const STORAGE_KEYS = {
  provider: "mt_provider",
  model: "mt_model",
  apiKey: "mt_api_key",
  baseUrl: "mt_base_url",
  baiduApiKey: "mt_baidu_api_key",
  baiduSecretKey: "mt_baidu_secret_key",
  localOcrBaseUrl: "mt_local_ocr_base_url",
  localOcrLang: "mt_local_ocr_lang",
  localOcrMode: "mt_local_ocr_mode",
  localOcrDetThresh: "mt_local_ocr_det_thresh",
  localOcrDetBoxThresh: "mt_local_ocr_det_box_thresh",
  localOcrDetUnclipRatio: "mt_local_ocr_det_unclip_ratio",
  localOcrDebug: "mt_local_ocr_debug",
  ocrConfidenceThreshold: "mt_ocr_confidence_threshold",
  ocrMinBoxArea: "mt_ocr_min_box_area",
  ocrMaxBoxArea: "mt_ocr_max_box_area",
  ocrMinBoxWidth: "mt_ocr_min_box_width",
  ocrMinBoxHeight: "mt_ocr_min_box_height",
  ocrMaxAspectRatio: "mt_ocr_max_aspect_ratio",
  ocrMergeLineGap: "mt_ocr_merge_line_gap",
  overwriteFontScale: "mt_overwrite_font_scale",
  overwriteCoverPadding: "mt_overwrite_cover_padding",
  debugOverlayMode: "mt_debug_overlay_mode",
  overwritePreviewMode: "mt_overwrite_preview_mode",
  visionOcrApiKey: "mt_vision_ocr_api_key",
  visionOcrBaseUrl: "mt_vision_ocr_base_url",
  visionOcrModel: "mt_vision_ocr_model",
  visionOcrEnabled: "mt_vision_ocr_enabled",
  enabled: "mt_enabled",
  showBall: "mt_show_ball",
  captureMode: "mt_capture_mode",
  renderMode: "mt_render_mode",
  pretranslateMode: "mt_pretranslate_mode",
  ignoreSimplifiedChinese: "mt_ignore_simplified_zh"
};

const DEFAULT_SETTINGS = {
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  apiKey: "",
  baseUrl: "",
  baiduApiKey: "",
  baiduSecretKey: "",
  localOcrBaseUrl: "http://127.0.0.1:8765",
  localOcrLang: "auto",
  localOcrMode: "fast",
  localOcrDetThresh: 0.3,
  localOcrDetBoxThresh: 0.6,
  localOcrDetUnclipRatio: 1.2,
  localOcrDebug: false,
  ocrConfidenceThreshold: 0.72,
  ocrMinBoxArea: 36,
  ocrMaxBoxArea: 0.35,
  ocrMinBoxWidth: 6,
  ocrMinBoxHeight: 6,
  ocrMaxAspectRatio: 18,
  ocrMergeLineGap: 1.65,
  overwriteFontScale: 1,
  overwriteCoverPadding: 1.2,
  debugOverlayMode: "final",
  overwritePreviewMode: "full",
  visionOcrApiKey: "",
  visionOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionOcrModel: "qwen-vl-ocr-latest",
  visionOcrEnabled: false,
  enabled: true,
  showBall: true,
  captureMode: "direct",
  renderMode: "overlay",
  pretranslateMode: "manual",
  ignoreSimplifiedChinese: false
};

const PROVIDERS = {
  anthropic: "anthropic",
  openaiCompatible: "openai_compatible",
  baiduDeepSeek: "baidu_deepseek",
  localPaddleDeepSeek: "local_paddle_deepseek"
};

const DEFAULT_MODELS = {
  [PROVIDERS.anthropic]: "claude-3-5-sonnet-20241022",
  [PROVIDERS.openaiCompatible]: "gpt-4o-mini",
  [PROVIDERS.baiduDeepSeek]: "deepseek-chat",
  [PROVIDERS.localPaddleDeepSeek]: "deepseek-chat"
};

const DEFAULT_TRANSLATION_BASE_URL = "https://api.deepseek.com";
const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_VISION_OCR_MODEL = "qwen-vl-ocr-latest";
const DEFAULT_LOCAL_OCR_BASE_URL = "http://127.0.0.1:8765";
const DEFAULT_LOCAL_OCR_LANG = "auto";
const DEFAULT_LOCAL_OCR_MODE = "fast";
const DEFAULT_LOCAL_OCR_DET_THRESH = 0.3;
const DEFAULT_LOCAL_OCR_DET_BOX_THRESH = 0.6;
const DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO = 1.2;
const DEBUG_OVERLAY_MODES = new Set(["raw", "filtered", "merged", "final"]);
const OVERWRITE_PREVIEW_MODES = new Set(["full", "cover", "text"]);

const CACHE_PREFIX = "mt_cache_v2:";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TAB_STATUS_PREFIX = "mt_tab_status_v1:";
const TAB_STATUS_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BUBBLES = 400;
const IMAGE_MAX_SIDE = 1536;
const IMAGE_JPEG_QUALITY = 0.82;
const FAST_PATH_MAX_JPEG_BYTES = 1900000;
const VISIBLE_TAB_CAPTURE_CACHE_MS = 700;
const BAIDU_OCR_MIN_REQUEST_GAP_MS = 1200;
const BAIDU_OCR_QPS_RETRY_DELAYS_MS = [1200, 2400, 4800];
const BAIDU_MERGE_MAX_GAP_RATIO = 1.35;
const BAIDU_MERGE_MAX_INDENT_RATIO = 2.4;
const BAIDU_MERGE_MAX_WIDTH_RATIO = 0.68;
const LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE = 760;
const LOCAL_OCR_WHITE_MIN_AREA_RATIO = 0.006;
const LOCAL_OCR_WHITE_MIN_DIMENSION = 26;
const LOCAL_OCR_CONTAINER_ASSIGN_OVERLAP = 0.48;
const LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO = 2.25;
const LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO = 1.65;
const MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = /[\[\(（【<［]\s*image\s*#?\s*\d+\s*[\]\)）】>］]/giu;
const MODEL_IMAGE_PLACEHOLDER_ONLY_RE = /^image\s*#?\s*\d+$/iu;
const inflightTranslateByCacheKey = new Map();
const visibleTabCaptureCacheByWindow = new Map();
let baiduAccessTokenCache = null;
let baiduOcrQueue = Promise.resolve();
let baiduLastOcrRequestAt = 0;

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensureDefaultSettings();
    await pruneExpiredTabStatuses();
    if (details && details.reason === "update") {
      await reinjectContentScriptsToOpenTabs();
    }
  } catch (error) {
    console.warn("[MangaTranslator] onInstalled init failed:", error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await pruneExpiredTabStatuses();
  } catch (error) {
    console.warn("[MangaTranslator] onStartup init failed:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  handleMessage(message, sender)
    .then((payload) => sendResponse(payload))
    .catch((error) => {
      const safeMessage = error && error.message ? error.message : "Unknown background error";
      sendResponse({ ok: false, error: safeMessage });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "FETCH_IMAGE_DATA_URL":
      return handleFetchImageDataUrl(message);
    case "CAPTURE_VISIBLE_TARGET_DATA_URL":
      return handleCaptureVisibleTargetDataUrl(message, sender);
    case "TRANSLATE_DATA_URL":
      return handleTranslateDataUrl(message, sender);
    case "GET_CACHE_STATS":
      return handleGetCacheStats();
    case "CLEAR_CACHE":
      return handleClearCache();
    case "REPORT_STATUS":
      return handleReportStatus(message, sender);
    case "GET_TAB_STATUS":
      return handleGetTabStatus(message);
    case "GET_SETTINGS":
      return { ok: true, settings: await loadSettings() };
    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

async function handleFetchImageDataUrl(message) {
  const url = String(message.url || "").trim();
  const preserveSize = message.preserveSize === true;
  const maxOriginalBytes = Math.max(1, Number(message.maxOriginalBytes || 0));
  if (!url) {
    return { ok: false, error: "Image URL is required" };
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "force-cache"
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Image fetch failed: ${response.status} ${response.statusText}`
      };
    }

    const blob = await response.blob();
    if (!blob || blob.size <= 0) {
      return { ok: false, error: "Image blob is empty" };
    }

    if (preserveSize && blob.size <= maxOriginalBytes) {
      const originalDataUrl = await blobToDataUrl(blob);
      return {
        ok: true,
        dataUrl: originalDataUrl,
        mimeType: getDataUrlMimeType(originalDataUrl),
        preserved: true
      };
    }

    const dataUrl = await blobToPreferredDataUrl(blob);
    return {
      ok: true,
      dataUrl,
      mimeType: getDataUrlMimeType(dataUrl)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Image fetch error: ${error && error.message ? error.message : "Unknown error"}`
    };
  }
}

async function handleCaptureVisibleTargetDataUrl(message, sender) {
  const tab = sender && sender.tab;
  const windowId = tab && Number.isInteger(tab.windowId) ? tab.windowId : null;
  if (windowId === null) {
    return { ok: false, error: "Visible tab capture requires an active tab" };
  }

  const rect = normalizeCaptureRect(message && message.rect);
  const viewport = normalizeViewportSize(message && message.viewport);
  if (!rect || !viewport) {
    return { ok: false, error: "Invalid visible capture rectangle" };
  }

  try {
    const screenshotDataUrl = await captureVisibleTabDataUrl(windowId);
    const cropped = await cropVisibleTabDataUrl(screenshotDataUrl, rect, viewport);
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

function normalizeCaptureRect(rect) {
  const left = Number(rect && rect.left);
  const top = Number(rect && rect.top);
  const width = Number(rect && rect.width);
  const height = Number(rect && rect.height);
  if (!(Number.isFinite(left) && Number.isFinite(top) && width > 1 && height > 1)) {
    return null;
  }

  return { left, top, width, height };
}

function normalizeViewportSize(viewport) {
  const width = Number(viewport && viewport.width);
  const height = Number(viewport && viewport.height);
  if (!(width > 1 && height > 1)) {
    return null;
  }

  return { width, height };
}

function captureVisibleTabDataUrl(windowId) {
  const now = Date.now();
  const cached = visibleTabCaptureCacheByWindow.get(windowId);
  if (cached && now - cached.createdAt <= VISIBLE_TAB_CAPTURE_CACHE_MS) {
    return cached.promise;
  }

  const promise = new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      {
        format: "jpeg",
        quality: Math.round(IMAGE_JPEG_QUALITY * 100)
      },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!isDataUrl(dataUrl)) {
          reject(new Error("Captured screenshot is empty"));
          return;
        }
        resolve(dataUrl);
      }
    );
  });

  visibleTabCaptureCacheByWindow.set(windowId, {
    createdAt: now,
    promise
  });
  promise.catch(() => {
    const current = visibleTabCaptureCacheByWindow.get(windowId);
    if (current && current.promise === promise) {
      visibleTabCaptureCacheByWindow.delete(windowId);
    }
  });

  return promise;
}

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
    const sourceX = clamp(Math.round(rect.left * scaleX), 0, Math.max(0, bitmap.width - 1));
    const sourceY = clamp(Math.round(rect.top * scaleY), 0, Math.max(0, bitmap.height - 1));
    const sourceRight = clamp(Math.round((rect.left + rect.width) * scaleX), sourceX + 1, bitmap.width);
    const sourceBottom = clamp(Math.round((rect.top + rect.height) * scaleY), sourceY + 1, bitmap.height);
    const sourceWidth = sourceRight - sourceX;
    const sourceHeight = sourceBottom - sourceY;
    const longestSide = Math.max(sourceWidth, sourceHeight);
    const outputScale = longestSide > IMAGE_MAX_SIDE ? IMAGE_MAX_SIDE / longestSide : 1;
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
      quality: IMAGE_JPEG_QUALITY
    });
    if (!converted || converted.size <= 0) {
      throw new Error("Screenshot crop conversion failed");
    }

    return {
      dataUrl: await blobToDataUrl(converted),
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

async function handleTranslateDataUrl(message, sender) {
  const dataUrl = String(message.dataUrl || "").trim();
  const imageUrl = String(message.imageUrl || "").trim();
  const targetKey = String(message.targetKey || "").trim();
  const imageMeta = normalizeImageMeta(message.imageMeta);

  if (!isDataUrl(dataUrl)) {
    return { ok: false, error: "Invalid or empty image data URL" };
  }

  const settings = await loadSettings();
  if (settings.provider === PROVIDERS.baiduDeepSeek) {
    if (!settings.baiduApiKey || !settings.baiduSecretKey) {
      return { ok: false, error: "Baidu OCR AK/SK is missing. Please configure it in popup." };
    }
    if (!settings.apiKey) {
      return { ok: false, error: "Translation API Key is missing. Please configure it in popup." };
    }
  } else if (settings.provider === PROVIDERS.localPaddleDeepSeek) {
    if (!settings.localOcrBaseUrl) {
      return { ok: false, error: "Local OCR service URL is missing. Please configure it in popup." };
    }
    if (!settings.apiKey) {
      return { ok: false, error: "Translation API Key is missing. Please configure it in popup." };
    }
    if (settings.visionOcrEnabled && !settings.visionOcrApiKey) {
      return { ok: false, error: "Vision OCR API Key is missing. Please configure it in popup." };
    }
  } else if (!settings.apiKey) {
    return { ok: false, error: "API Key is missing. Please configure it in popup." };
  }

  if (settings.provider === PROVIDERS.openaiCompatible && !settings.baseUrl) {
    return { ok: false, error: "Base URL is required for openai_compatible provider" };
  }

  const cacheKey = buildCacheKey({
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    captureMode: settings.captureMode,
    localOcrBaseUrl: settings.localOcrBaseUrl,
    localOcrLang: settings.localOcrLang,
    localOcrMode: settings.localOcrMode,
    localOcrDetThresh: settings.localOcrDetThresh,
    localOcrDetBoxThresh: settings.localOcrDetBoxThresh,
    localOcrDetUnclipRatio: settings.localOcrDetUnclipRatio,
    localOcrDebug: settings.localOcrDebug,
    ocrConfidenceThreshold: settings.ocrConfidenceThreshold,
    ocrMinBoxArea: settings.ocrMinBoxArea,
    ocrMaxBoxArea: settings.ocrMaxBoxArea,
    ocrMinBoxWidth: settings.ocrMinBoxWidth,
    ocrMinBoxHeight: settings.ocrMinBoxHeight,
    ocrMaxAspectRatio: settings.ocrMaxAspectRatio,
    ocrMergeLineGap: settings.ocrMergeLineGap,
    overwriteFontScale: settings.overwriteFontScale,
    overwriteCoverPadding: settings.overwriteCoverPadding,
    debugOverlayMode: settings.debugOverlayMode,
    overwritePreviewMode: settings.overwritePreviewMode,
    visionOcrEnabled: settings.visionOcrEnabled,
    visionOcrBaseUrl: settings.visionOcrBaseUrl,
    visionOcrModel: settings.visionOcrModel,
    imageUrl,
    targetKey,
    dataUrl
  });

  const cached = await getCache(cacheKey);
  if (cached) {
    return {
      ok: true,
      result: cached,
      cached: true
    };
  }

  if (inflightTranslateByCacheKey.has(cacheKey)) {
    return inflightTranslateByCacheKey.get(cacheKey);
  }

  const task = (async () => {
    try {
      const prompt = buildVisionPrompt({
        ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese
      });
      let rawText = "";

      if (settings.provider === PROVIDERS.anthropic) {
        rawText = await requestAnthropicVision({
          model: settings.model,
          apiKey: settings.apiKey,
          dataUrl,
          prompt
        });
      } else if (settings.provider === PROVIDERS.openaiCompatible) {
        rawText = await requestOpenAICompatibleVision({
          model: settings.model,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          dataUrl,
          prompt
        });
      } else if (settings.provider === PROVIDERS.baiduDeepSeek) {
        const result = await requestBaiduOcrAndOpenAICompatibleTranslate({
          dataUrl,
          baiduApiKey: settings.baiduApiKey,
          baiduSecretKey: settings.baiduSecretKey,
          translatorApiKey: settings.apiKey,
          translatorBaseUrl: settings.baseUrl || DEFAULT_TRANSLATION_BASE_URL,
          translatorModel: settings.model || DEFAULT_MODELS[PROVIDERS.baiduDeepSeek],
          ocrTuning: getOcrTuning(settings),
          ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese
        });

        await setCache(cacheKey, result);

        await saveTabStatus(sender && sender.tab ? sender.tab.id : null, {
          level: "info",
          message: `Translation success (${settings.provider}/${settings.model})`,
          details: {
            bubbles: result.bubbles.length,
            cached: false
          },
          pageUrl: sender && sender.url ? sender.url : ""
        });

        return {
          ok: true,
          result,
          cached: false
        };
      } else if (settings.provider === PROVIDERS.localPaddleDeepSeek) {
        const result = await requestLocalPaddleOcrAndOpenAICompatibleTranslate({
          dataUrl,
          localOcrBaseUrl: settings.localOcrBaseUrl || DEFAULT_LOCAL_OCR_BASE_URL,
          localOcrLang: settings.localOcrLang || DEFAULT_LOCAL_OCR_LANG,
          localOcrMode: settings.localOcrMode || DEFAULT_LOCAL_OCR_MODE,
          localOcrParams: getLocalOcrParams(settings),
          localOcrDebug: settings.localOcrDebug,
          ocrTuning: getOcrTuning(settings),
          imageMeta,
          targetKey,
          translatorApiKey: settings.apiKey,
          translatorBaseUrl: settings.baseUrl || DEFAULT_TRANSLATION_BASE_URL,
          translatorModel: settings.model || DEFAULT_MODELS[PROVIDERS.localPaddleDeepSeek],
          visionOcrOptions: {
            enabled: settings.visionOcrEnabled,
            apiKey: settings.visionOcrApiKey,
            baseUrl: settings.visionOcrBaseUrl || DEFAULT_QWEN_BASE_URL,
            model: settings.visionOcrModel || DEFAULT_VISION_OCR_MODEL
          },
          ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese
        });

        await setCache(cacheKey, result);

        await saveTabStatus(sender && sender.tab ? sender.tab.id : null, {
          level: "info",
          message: `Translation success (${settings.provider}/${settings.model})`,
          details: {
            bubbles: result.bubbles.length,
            cached: false,
            localOcrLang: settings.localOcrLang
          },
          pageUrl: sender && sender.url ? sender.url : ""
        });

        return {
          ok: true,
          result,
          cached: false
        };
      } else {
        throw new Error(`Unsupported provider: ${settings.provider}`);
      }

      const parsed = parseModelJson(rawText);
      const result = normalizeTranslationResult(parsed, {
        ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese
      });

      await setCache(cacheKey, result);

      await saveTabStatus(sender && sender.tab ? sender.tab.id : null, {
        level: "info",
        message: `Translation success (${settings.provider}/${settings.model})`,
        details: {
          bubbles: result.bubbles.length,
          cached: false
        },
        pageUrl: sender && sender.url ? sender.url : ""
      });

      return {
        ok: true,
        result,
        cached: false
      };
    } catch (error) {
      const safeError = error && error.message ? error.message : "Model request failed";

      await saveTabStatus(sender && sender.tab ? sender.tab.id : null, {
        level: "error",
        message: safeError,
        details: {
          provider: settings.provider,
          model: settings.model
        },
        pageUrl: sender && sender.url ? sender.url : ""
      });

      return {
        ok: false,
        error: `Translate failed (${settings.provider}/${settings.model}): ${safeError}`
      };
    } finally {
      inflightTranslateByCacheKey.delete(cacheKey);
    }
  })();

  inflightTranslateByCacheKey.set(cacheKey, task);
  return task;
}

async function requestAnthropicVision({ model, apiKey, dataUrl, prompt }) {
  const parsed = parseDataUrl(dataUrl);

  const body = {
    model: model || DEFAULT_MODELS[PROVIDERS.anthropic],
    max_tokens: 2600,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: parsed.mediaType,
              data: parsed.base64Data
            }
          },
          {
            type: "text",
            text: prompt
          }
        ]
      }
    ]
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    throw toProviderError(payload, response.status, response.statusText, "Anthropic API error");
  }

  const text = (payload && Array.isArray(payload.content) ? payload.content : [])
    .filter((item) => item && item.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic response is empty");
  }

  return text;
}

async function requestOpenAICompatibleVision({ model, apiKey, baseUrl, dataUrl, prompt }) {
  const endpoint = buildOpenAICompatibleEndpoint(baseUrl);

  try {
    return await sendOpenAICompatibleWithJsonFallback({
      endpoint,
      model,
      apiKey,
      dataUrl,
      prompt
    });
  } catch (error) {
    const reason = getErrorMessage(error);
    if (!shouldRetryWithJpeg(reason)) {
      throw new Error(ensureOpenAICompatibleError(reason));
    }

    const jpegDataUrl = await transcodeDataUrlToJpeg(dataUrl);
    if (!jpegDataUrl || jpegDataUrl === dataUrl) {
      throw new Error(ensureOpenAICompatibleError(reason));
    }

    const text = await sendOpenAICompatibleWithJsonFallback({
      endpoint,
      model,
      apiKey,
      dataUrl: jpegDataUrl,
      prompt
    });

    return text;
  }
}

async function requestBaiduOcrAndOpenAICompatibleTranslate({
  dataUrl,
  baiduApiKey,
  baiduSecretKey,
  translatorApiKey,
  translatorBaseUrl,
  translatorModel,
  visionOcrOptions,
  ocrTuning,
  ignoreSimplifiedChinese
}) {
  const imageSize = await decodeDataUrlImageSize(dataUrl);
  const ocrPayload = await requestBaiduAccurateOcr({
    dataUrl,
    apiKey: baiduApiKey,
    secretKey: baiduSecretKey
  });
  const ocrDebug = createOcrDebugSession("baidu", imageSize, ocrTuning, {
    rawItems: Array.isArray(ocrPayload && ocrPayload.words_result) ? ocrPayload.words_result : []
  });
  const debugEnabled = Boolean(ocrTuning && ocrTuning.debugEnabled);
  const ocrItems = buildBaiduBubbleItems(ocrPayload, imageSize, ocrTuning, ocrDebug);

  const candidates = coalesceOverlappingOcrCandidates(ocrItems
    .map((item, index) => normalizeBaiduOcrItem(item, index, imageSize))
    .filter((item) => item && item.original_text)
    .filter((item) => keepOrTraceFinalCandidate(item, imageSize, ocrTuning, ocrDebug, "baidu"))
    .filter((item) => debugEnabled || !shouldDropSymbolOnlyBubble(item))
    .filter((item) => debugEnabled || !shouldDropMeaninglessAlphabeticBubble(item))
    .filter((item) => {
      if (!ignoreSimplifiedChinese) {
        return true;
      }
      return !isConfidentSimplifiedChinese(item.original_text);
    })
    .slice(0, MAX_BUBBLES));

  if (localOcrDebug) {
    console.info("[MangaTranslator][OCR chain]", {
      frontendReceivedItems:
        ocrPayload && Array.isArray(ocrPayload.items)
          ? ocrPayload.items.length
          : ocrPayload && Array.isArray(ocrPayload.results)
            ? ocrPayload.results.length
            : 0,
      frontendMergedBlocks: ocrItems.length,
      frontendTranslatedBlocks: candidates.length,
      serviceCounts: ocrPayload && ocrPayload.counts ? ocrPayload.counts : null
    });
  }

  if (candidates.length === 0) {
    return { bubbles: [] };
  }

  const translated = await requestOpenAICompatibleTextTranslations({
    items: candidates,
    apiKey: translatorApiKey,
    baseUrl: translatorBaseUrl,
    model: translatorModel
  });

  if (localOcrDebug) {
    console.info("[MangaTranslator][OCR chain] translation", {
      frontendTranslatedBlocks: candidates.length,
      translatedMapSize: translated.size
    });
  }

  return {
    bubbles: candidates.map((item) => {
      const translatedText = translated.get(item.id) || item.original_text;
      return {
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        bg_type: "solid",
        original_text: item.original_text,
        translated_text: cleanDecorativeSymbols(translatedText)
      };
    }),
    ...(debugEnabled
      ? {
          debug: buildUnifiedOcrDebugPayload(ocrDebug, candidates, {
            provider: "baidu_deepseek",
            localOcr: ocrPayload && ocrPayload.debug ? ocrPayload.debug : {}
          })
        }
      : {})
  };
}

async function requestLocalPaddleOcrAndOpenAICompatibleTranslate({
  dataUrl,
  localOcrBaseUrl,
  localOcrLang,
  localOcrMode,
  localOcrParams,
  localOcrDebug,
  ocrTuning,
  imageMeta,
  targetKey,
  translatorApiKey,
  translatorBaseUrl,
  translatorModel,
  visionOcrOptions,
  ignoreSimplifiedChinese
}) {
  const imageSize = await decodeDataUrlImageSize(dataUrl);
  let effectiveOcrMode = localOcrMode;
  if (effectiveOcrMode === "enhanced" && imageSize.width * imageSize.height > 4000000) {
    console.info(
      "[MangaTranslator] Large image detected (%dx%d), downgrading OCR from enhanced to fast to avoid timeout",
      imageSize.width,
      imageSize.height
    );
    effectiveOcrMode = "fast";
  }
  const debugId = buildLocalOcrDebugId(targetKey);
  let ocrPayload = await requestLocalPaddleOcr({
    dataUrl,
    baseUrl: localOcrBaseUrl,
    lang: localOcrLang,
    mode: effectiveOcrMode,
    params: localOcrParams,
    debug: localOcrDebug,
    debugId
  });
  const ocrDebug = createOcrDebugSession("local_paddle", imageSize, ocrTuning, {
    rawItems: getLocalOcrPayloadItems(ocrPayload, true)
  });
  let ocrItems = await buildLocalPaddleBubbleItems(ocrPayload, imageSize, dataUrl, localOcrDebug, {
    apiKey: visionOcrOptions && visionOcrOptions.enabled ? visionOcrOptions.apiKey : "",
    baseUrl: visionOcrOptions && visionOcrOptions.enabled ? visionOcrOptions.baseUrl : "",
    model: visionOcrOptions && visionOcrOptions.enabled ? visionOcrOptions.model : ""
  }, ocrTuning, ocrDebug, imageMeta);

  const candidates = coalesceOverlappingOcrCandidates(ocrItems
    .map((item, index) => normalizeBaiduOcrItem(item, index, imageSize))
    .filter((item) => item && item.original_text)
    .filter((item) => keepOrTraceFinalCandidate(item, imageSize, ocrTuning, ocrDebug, "local_paddle"))
    .filter((item) => !shouldDropSymbolOnlyBubble(item))
    .filter((item) => !shouldDropMeaninglessAlphabeticBubble(item))
    .filter((item) => {
      if (!ignoreSimplifiedChinese) {
        return true;
      }
      return !isConfidentSimplifiedChinese(item.original_text);
    })
    .slice(0, MAX_BUBBLES));

  if (candidates.length === 0) {
    return { bubbles: [] };
  }

  const translated = await requestOpenAICompatibleTextTranslations({
    items: candidates,
    apiKey: translatorApiKey,
    baseUrl: translatorBaseUrl,
    model: translatorModel
  });

  const bubbles = candidates.map((item) => {
    const translatedText = translated.get(item.id) || item.original_text;
    return {
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      bg_type: item.bg_type,
      bg_color: item.bg_color || "",
      bg_confidence: Number(item.bg_confidence || 0),
      original_text: item.original_text,
      translated_text: cleanDecorativeSymbols(translatedText)
    };
  });

  return {
    bubbles: collapseDuplicateLocalPaddleTranslations(bubbles),
    ...(localOcrDebug
      ? {
          debug: buildUnifiedOcrDebugPayload(ocrDebug, candidates, {
            localOcr: ocrPayload.debug || {},
            imageMeta,
            ocrImageWidth: Number(ocrPayload.imageWidth || imageSize.width || 0),
            ocrImageHeight: Number(ocrPayload.imageHeight || imageSize.height || 0)
          })
        }
      : {})
  };
}

async function requestLocalPaddleOcr({ dataUrl, baseUrl, lang, mode, params, debug, debugId }) {
  const endpoint = `${sanitizeLocalOcrBaseUrl(baseUrl)}/ocr`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        image: dataUrl,
        lang: normalizeLocalOcrLang(lang),
        mode: normalizeLocalOcrMode(mode),
        text_det_thresh: normalizeLocalOcrNumber(params && params.text_det_thresh, DEFAULT_LOCAL_OCR_DET_THRESH),
        text_det_box_thresh: normalizeLocalOcrNumber(
          params && params.text_det_box_thresh,
          DEFAULT_LOCAL_OCR_DET_BOX_THRESH
        ),
        text_det_unclip_ratio: normalizeLocalOcrNumber(
          params && params.text_det_unclip_ratio,
          DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO
        ),
        text_rec_score_thresh: normalizeLocalOcrNumber(params && params.text_rec_score_thresh, 0),
        debug: debug === true,
        debug_id: debugId || ""
      }),
      signal: controller.signal
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
      throw new Error(`Local OCR request failed: ${message}`);
    }
    return payload;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("本地 OCR 服务请求超时，请确认 local-ocr-service 正在运行");
    }
    const message = error && error.message ? error.message : String(error || "unknown error");
    if (/failed to fetch/i.test(message)) {
      throw new Error("本地 OCR 服务不可用，请先启动 local-ocr-service");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function buildLocalPaddleBubbleItems(
  payload,
  imageSize,
  dataUrl,
  debug,
  visionOcrOptions = null,
  ocrTuning = getDefaultOcrTuning(),
  ocrDebug = null,
  imageMeta = null
) {
  const ocrImageSize = {
    width: Number(payload && payload.imageWidth) || Number(imageSize && imageSize.width) || 1,
    height: Number(payload && payload.imageHeight) || Number(imageSize && imageSize.height) || 1
  };
  const sourceItems = getLocalOcrPayloadItems(payload);
  if (ocrDebug) {
    ocrDebug.rawItems = sourceItems.map((item, index) => toDebugOcrItem(item, index, ocrImageSize, "raw"));
  }

  let words = sourceItems
    .map((item) => normalizeLocalPaddleOcrItem(item, ocrImageSize))
    .filter(Boolean)
    .filter((item) => isOcrItemOwnedByStitch(item, imageMeta && imageMeta.stitch))
    .filter((item, index) => keepOrTraceOcrWord(item, ocrImageSize, ocrTuning, ocrDebug, index, "local_paddle"));

  words = await repairLowConfidenceLocalPaddleWordsWithVision(words, dataUrl, ocrImageSize, visionOcrOptions, debug);
  const imageAnalysis = await analyzeLocalOcrImage(dataUrl, ocrImageSize);
  const clustered = clusterLocalPaddleWords(words, ocrImageSize, imageAnalysis, debug);
  if (ocrDebug) {
    ocrDebug.filteredItems = words.map((item, index) => toDebugOcrItem(item, index, ocrImageSize, "filtered"));
    ocrDebug.mergedItems = clustered.map((item, index) => toDebugOcrItem(item, index, ocrImageSize, "merged"));
  }
  if (debug) {
    console.info("[MangaTranslator][OCR chain]", {
      frontendReceivedItems: sourceItems.length,
      frontendNormalizedItems: words.length,
      frontendMergedBlocks: clustered.length,
      serviceCounts: payload && payload.counts ? payload.counts : null,
      debugPaths: payload && payload.debug ? payload.debug : null
    });
  }
  return clustered;
}

async function analyzeLocalOcrImage(dataUrl, imageSize) {
  if (!isDataUrl(dataUrl) || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return null;
  }

  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const sourceWidth = Math.max(1, Number(imageSize && imageSize.width) || bitmap.width || 1);
      const sourceHeight = Math.max(1, Number(imageSize && imageSize.height) || bitmap.height || 1);
      const scale = Math.min(1, LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const sample = { data: imageData.data, width, height, scale, sourceWidth, sourceHeight };
      return {
        sample,
        whiteContainers: detectLocalOcrWhiteContainers(sample)
      };
    } finally {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  } catch (error) {
    console.warn("[MangaTranslator] Local OCR image analysis failed:", error);
    return null;
  }
}

function detectLocalOcrWhiteContainers(sample) {
  if (!sample || !sample.data || sample.width <= 0 || sample.height <= 0) {
    return [];
  }

  const { data, width, height, scale, sourceWidth, sourceHeight } = sample;
  const total = width * height;
  const mask = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    if (isLocalOcrWhitePixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
      mask[index] = 1;
    }
  }

  const stack = new Int32Array(total);
  const containers = [];
  const minPixels = Math.max(80, Math.round(total * LOCAL_OCR_WHITE_MIN_AREA_RATIO));

  for (let start = 0; start < total; start += 1) {
    if (!mask[start]) {
      continue;
    }

    let stackSize = 0;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    mask[start] = 0;
    stack[stackSize] = start;
    stackSize += 1;

    while (stackSize > 0) {
      stackSize -= 1;
      const current = stack[stackSize];
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [current - 1, current + 1, current - width, current + width];
      for (const next of neighbors) {
        if (next < 0 || next >= total || !mask[next]) {
          continue;
        }
        const nx = next % width;
        if ((next === current - 1 && nx !== x - 1) || (next === current + 1 && nx !== x + 1)) {
          continue;
        }
        mask[next] = 0;
        stack[stackSize] = next;
        stackSize += 1;
      }
    }

    if (count < minPixels) {
      continue;
    }

    const boxWidth = Math.max(1, maxX - minX + 1);
    const boxHeight = Math.max(1, maxY - minY + 1);
    const originalBox = buildBaiduBox(
      minX / scale,
      minY / scale,
      Math.min(sourceWidth, (maxX + 1) / scale),
      Math.min(sourceHeight, (maxY + 1) / scale)
    );
    const areaRatio = count / total;
    const coversPage = originalBox.width >= sourceWidth * 0.86 && originalBox.height >= sourceHeight * 0.86;
    const dimensionOk =
      originalBox.width >= LOCAL_OCR_WHITE_MIN_DIMENSION && originalBox.height >= LOCAL_OCR_WHITE_MIN_DIMENSION;
    if (!dimensionOk || coversPage || areaRatio > 0.38 || boxWidth < 8 || boxHeight < 8) {
      continue;
    }

    containers.push({
      id: `white-${containers.length + 1}`,
      box: originalBox,
      areaRatio,
      pixelCount: count
    });
  }

  return containers.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
}

function isLocalOcrWhitePixel(red, green, blue, alpha) {
  if (alpha !== undefined && alpha < 24) {
    return false;
  }
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const brightness = (red + green + blue) / 3;
  return (red >= 238 && green >= 238 && blue >= 238 && max - min <= 34) || (brightness >= 246 && max - min <= 24);
}

async function repairLowConfidenceLocalPaddleWordsWithVision(words, dataUrl, imageSize, options, debug) {
  if (!shouldUseVisionCropOcr(options) || !Array.isArray(words) || words.length === 0) {
    return words;
  }

  const groups = buildVisionCropOcrGroups(words, imageSize).slice(0, 8);
  if (groups.length === 0) {
    return words;
  }

  const usedIndexes = new Set();
  const replacements = [];
  for (const group of groups) {
    const box = getBaiduGroupBox(group.map((entry) => entry.item));
    if (!box) {
      continue;
    }
    try {
      const cropDataUrl = await cropDataUrlByImageBox(dataUrl, box, imageSize);
      const recognized = await requestVisionCropOcr({
        dataUrl: cropDataUrl,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model
      });
      if (!isUsableVisionCropOcrText(recognized)) {
        continue;
      }
      group.forEach((entry) => usedIndexes.add(entry.index));
      replacements.push({
        words: recognized,
        confidence: 0.99,
        rawBox: {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height
        },
        location: {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height
        },
        visionOcr: true,
        visionOcrOriginal: group.map((entry) => entry.text).join(" ")
      });
      if (debug) {
        console.info("[MangaTranslator][OCR chain] vision crop repaired", {
          from: group.map((entry) => ({ text: entry.text, confidence: entry.confidence, box: entry.box })),
          to: recognized,
          box
        });
      }
    } catch (error) {
      if (debug) {
        console.warn("[MangaTranslator][OCR chain] vision crop OCR failed:", getErrorMessage(error));
      }
    }
  }

  if (replacements.length === 0) {
    return words;
  }

  return words
    .filter((item, index) => !usedIndexes.has(index))
    .concat(replacements)
    .sort(compareBaiduWordItems);
}

function shouldUseVisionCropOcr(options) {
  if (
    !options ||
    !options.apiKey ||
    !options.model ||
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    return false;
  }
  const model = String(options.model || "").toLowerCase();
  const baseUrl = String(options.baseUrl || "").toLowerCase();
  if (/deepseek-chat|deepseek-reasoner/.test(model)) {
    return false;
  }
  return /vision|vl|qwen.*vl|gpt-4o|gpt-4\.1|gemini|claude|pixtral|llava|omni/.test(model + " " + baseUrl);
}

function buildVisionCropOcrGroups(words, imageSize) {
  const entries = words
    .map((item, index) => {
      const box = getBaiduItemBox(item);
      const text = String(item && item.words ? item.words : "").trim();
      const confidence = Number(item && item.confidence ? item.confidence : 0);
      return box && shouldRepairLocalPaddleWordWithVision(text, confidence)
        ? { item, index, box, text, confidence }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);

  const groups = [];
  entries.forEach((entry) => {
    const group = groups.find((candidate) => shouldJoinVisionCropOcrGroup(candidate, entry, imageSize));
    if (group) {
      group.push(entry);
    } else {
      groups.push([entry]);
    }
  });
  return groups;
}

function shouldRepairLocalPaddleWordWithVision(text, confidence) {
  const raw = String(text || "").trim();
  if (!raw || confidence >= 0.78) {
    return false;
  }
  const hangul = (raw.match(/[\uac00-\ud7af]/g) || []).length;
  const jamo = (raw.match(/[\u3130-\u318f]/g) || []).length;
  const latin = (raw.match(/[A-Za-z]/g) || []).length;
  if (latin > 0 || jamo > 0) {
    return true;
  }
  return hangul <= 3 || confidence < 0.58;
}

function shouldJoinVisionCropOcrGroup(group, entry, imageSize) {
  const groupBox = getBaiduGroupBox(group.map((row) => row.item));
  const box = entry.box;
  if (!groupBox || !box) {
    return false;
  }
  const avgHeight = Math.max(1, (groupBox.height + box.height) / 2);
  const verticalOverlap = Math.min(groupBox.bottom, box.bottom) - Math.max(groupBox.top, box.top);
  const sameLine = verticalOverlap >= Math.min(groupBox.height, box.height) * 0.38;
  if (!sameLine) {
    return false;
  }
  const gap = getHorizontalGap(groupBox, box);
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const unionWidth = Math.max(groupBox.right, box.right) - Math.min(groupBox.left, box.left);
  return gap <= avgHeight * 2.8 && unionWidth <= imageWidth * 0.72;
}

async function cropDataUrlByImageBox(dataUrl, box, imageSize) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const sourceWidth = Math.max(1, Number(imageSize && imageSize.width) || bitmap.width || 1);
    const sourceHeight = Math.max(1, Number(imageSize && imageSize.height) || bitmap.height || 1);
    const scaleX = bitmap.width / sourceWidth;
    const scaleY = bitmap.height / sourceHeight;
    const marginX = Math.max(8, box.width * 0.18);
    const marginY = Math.max(8, box.height * 0.22);
    const left = clamp(Math.floor((box.left - marginX) * scaleX), 0, bitmap.width - 1);
    const top = clamp(Math.floor((box.top - marginY) * scaleY), 0, bitmap.height - 1);
    const right = clamp(Math.ceil((box.right + marginX) * scaleX), left + 1, bitmap.width);
    const bottom = clamp(Math.ceil((box.bottom + marginY) * scaleY), top + 1, bitmap.height);
    const canvas = new OffscreenCanvas(Math.max(1, right - left), Math.max(1, bottom - top));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("OffscreenCanvas context unavailable for crop OCR");
    }
    ctx.drawImage(bitmap, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
    const output = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(output);
  } finally {
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
  }
}

async function requestVisionCropOcr({ dataUrl, apiKey, baseUrl, model }) {
  const prompt = [
    "Read the Korean text in this cropped manga image.",
    "Return JSON only: {\"text\":\"...\"}.",
    "Do not translate. Preserve Korean text, spaces, and punctuation.",
    "If the crop is unreadable or contains no Korean text, return {\"text\":\"\"}."
  ].join("\n");
  const raw = await requestOpenAICompatibleVision({ model, apiKey, baseUrl, dataUrl, prompt });
  try {
    const payload = parseModelJson(raw);
    return cleanDecorativeSymbols(String(payload && payload.text ? payload.text : "").trim());
  } catch {
    return cleanDecorativeSymbols(
      String(raw || "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^[\s"'`{[\]]+|[\s"'`}\]]+$/g, "")
        .trim()
    );
  }
}

function isUsableVisionCropOcrText(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 80) {
    return false;
  }
  const hangul = (raw.match(/[\uac00-\ud7af]/g) || []).length;
  return hangul >= 2;
}

function clusterLocalPaddleWords(words, imageSize, imageAnalysis, debug) {
  const entries = words
    .map((item, index) => buildLocalPaddleClusterEntry(item, index, imageSize, imageAnalysis, debug))
    .filter((entry) => entry && entry.kind !== "noise");
  const clusters = buildLocalPaddleConnectedClusters(entries, imageSize);
  const merged = clusters
    .map((cluster) => mergeLocalPaddleCluster(cluster, imageSize, imageAnalysis))
    .filter((item) => item && item.words && item.location)
    .sort(compareBaiduWordItems);

  if (debug) {
    console.debug("[MangaTranslator] Local OCR clustering:", {
      containers: (imageAnalysis && imageAnalysis.whiteContainers ? imageAnalysis.whiteContainers : []).map((container) => ({
        id: container.id,
        box: container.box,
        areaRatio: container.areaRatio
      })),
      entries: entries.map((entry) => ({
        text: entry.text,
        kind: entry.kind,
        containerId: entry.container ? entry.container.id : "",
        color: entry.color,
        box: entry.box
      })),
      clusters: clusters.map((cluster) => cluster.map((entry) => entry.text))
    });
  }

  return merged;
}

function buildLocalPaddleClusterEntry(item, index, imageSize, imageAnalysis, debug) {
  const box = getBaiduItemBox(item);
  const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
  if (!box || !text || (!debug && shouldDropLocalPaddleNoiseItem(item, imageSize))) {
    return null;
  }

  const areaRatio =
    (box.width * box.height) /
    Math.max(1, (Number(imageSize && imageSize.width) || 1) * (Number(imageSize && imageSize.height) || 1));
  if (!debug && /^[xX×]+$/.test(text) && areaRatio < 0.02) {
    return { item, index, box, text, kind: "noise" };
  }
  if (!debug && /^[A-Za-z]$/.test(text) && !isMeaningfulLatinToken(text)) {
    return { item, index, box, text, kind: "noise" };
  }
  if (!debug && countScriptChars(text) === 0 && !/[0-9A-Za-z]/.test(text)) {
    return { item, index, box, text, kind: "noise" };
  }

  const container = assignLocalOcrWhiteContainer(box, imageAnalysis && imageAnalysis.whiteContainers);
  const color = sampleLocalOcrTextColor(imageAnalysis && imageAnalysis.sample, box);
  let kind = "normalOutsideText";
  if (container) {
    kind = "bubbleText";
  } else if (isLocalOcrEffectColor(color)) {
    kind = "effectText";
  }

  return { item, index, box, text, kind, container, color };
}

function assignLocalOcrWhiteContainer(box, containers) {
  if (!box || !Array.isArray(containers) || containers.length === 0) {
    return null;
  }

  let best = null;
  let bestScore = 0;
  for (const container of containers) {
    const containerBox = container && container.box;
    if (!containerBox) {
      continue;
    }
    const centerInside =
      box.centerX >= containerBox.left &&
      box.centerX <= containerBox.right &&
      box.centerY >= containerBox.top &&
      box.centerY <= containerBox.bottom;
    const overlap = getBoxOverlapArea(box, containerBox);
    const overlapRatio = overlap / Math.max(1, box.width * box.height);
    const score = overlapRatio + (centerInside ? 0.5 : 0);
    if ((centerInside && overlapRatio >= 0.18) || overlapRatio >= LOCAL_OCR_CONTAINER_ASSIGN_OVERLAP) {
      if (score > bestScore) {
        best = container;
        bestScore = score;
      }
    }
  }
  return best;
}

function sampleLocalOcrTextColor(sample, box) {
  if (!sample || !sample.data || !box) {
    return { redScore: 0, brightness: 0, redDominance: 0, selected: 0 };
  }

  const { data, width, height, scale } = sample;
  const left = clamp(Math.floor(box.left * scale), 0, width - 1);
  const top = clamp(Math.floor(box.top * scale), 0, height - 1);
  const right = clamp(Math.ceil(box.right * scale), left + 1, width);
  const bottom = clamp(Math.ceil(box.bottom * scale), top + 1, height);
  const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 90));
  let selected = 0;
  let redPixels = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;

  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];
      if (alpha < 24) {
        continue;
      }
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const brightness = (red + green + blue) / 3;
      const saturated = max - min >= 32;
      if (brightness > 214 && !saturated) {
        continue;
      }
      selected += 1;
      redSum += red;
      greenSum += green;
      blueSum += blue;
      if (red >= 88 && red >= green + 18 && red >= blue + 18) {
        redPixels += 1;
      }
    }
  }

  if (selected === 0) {
    return { redScore: 0, brightness: 0, redDominance: 0, selected: 0 };
  }

  const avgRed = redSum / selected;
  const avgGreen = greenSum / selected;
  const avgBlue = blueSum / selected;
  return {
    redScore: redPixels / selected,
    brightness: (avgRed + avgGreen + avgBlue) / 3,
    redDominance: avgRed - Math.max(avgGreen, avgBlue),
    selected
  };
}

function isLocalOcrEffectColor(color) {
  if (!color || color.selected <= 0) {
    return false;
  }
  return color.redScore >= 0.18 || color.redDominance >= 24;
}

function buildLocalPaddleConnectedClusters(entries, imageSize) {
  const clusters = [];
  const visited = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }
    const cluster = [];
    const queue = [index];
    visited.add(index);
    while (queue.length > 0) {
      const current = queue.shift();
      const entry = entries[current];
      cluster.push(entry);
      for (let otherIndex = 0; otherIndex < entries.length; otherIndex += 1) {
        if (visited.has(otherIndex)) {
          continue;
        }
        if (shouldJoinLocalPaddleCluster(entry, entries[otherIndex], imageSize)) {
          visited.add(otherIndex);
          queue.push(otherIndex);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function shouldJoinLocalPaddleCluster(left, right, imageSize) {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "bubbleText") {
    if (!left.container || !right.container || left.container.id !== right.container.id) {
      return false;
    }
    return shouldJoinLocalPaddleBubbleText(left.box, right.box);
  }
  if (left.kind === "effectText") {
    return shouldJoinLocalPaddleEffectText(left, right, imageSize);
  }
  return shouldJoinLocalPaddleNormalOutsideText(left, right, imageSize);
}

function shouldJoinLocalPaddleBubbleText(leftBox, rightBox) {
  const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
  const avgWidth = Math.max(1, (leftBox.width + rightBox.width) / 2);
  const verticalOverlap = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
  const sameLine = verticalOverlap >= Math.min(leftBox.height, rightBox.height) * 0.45;
  const horizontalGap = getHorizontalGap(leftBox, rightBox);
  if (sameLine) {
    return horizontalGap <= avgHeight * 2.2;
  }

  const verticalGap = getVerticalGap(leftBox, rightBox);
  if (isLocalPaddleVerticalPair(leftBox, rightBox)) {
    return verticalGap <= Math.max(avgHeight, avgWidth) * 1.45;
  }

  const centerDistance = Math.abs(leftBox.centerX - rightBox.centerX);
  const indent = Math.abs(leftBox.left - rightBox.left);
  const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
  return (
    verticalGap <= avgHeight * LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO &&
    (centerDistance <= Math.max(leftBox.width, rightBox.width) * 0.52 ||
      indent <= avgHeight * 2.6 ||
      overlapRatio >= 0.2)
  );
}

function shouldJoinLocalPaddleEffectText(left, right, imageSize) {
  const leftBox = left.box;
  const rightBox = right.box;
  const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
  const maxWidth = Math.max(leftBox.width, rightBox.width);
  const horizontalGap = getHorizontalGap(leftBox, rightBox);
  const verticalGap = getVerticalGap(leftBox, rightBox);
  const centerDistance = Math.hypot(leftBox.centerX - rightBox.centerX, leftBox.centerY - rightBox.centerY);
  const unionLeft = Math.min(leftBox.left, rightBox.left);
  const unionRight = Math.max(leftBox.right, rightBox.right);
  const unionTop = Math.min(leftBox.top, rightBox.top);
  const unionBottom = Math.max(leftBox.bottom, rightBox.bottom);
  const unionWidth = unionRight - unionLeft;
  const unionHeight = unionBottom - unionTop;
  const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const leftRedScore = Number(left.color && left.color.redScore) || 0;
  const rightRedScore = Number(right.color && right.color.redScore) || 0;
  const colorClose = Math.abs(leftRedScore - rightRedScore) <= 0.48;
  if (!colorClose) {
    return false;
  }
  if (unionWidth > Math.min(imageWidth * 0.5, maxWidth * 1.7 + avgHeight * 2.2)) {
    return false;
  }
  if (centerDistance > Math.max(maxWidth * 0.95, avgHeight * 5.2)) {
    return false;
  }
  if (verticalGap > avgHeight * 0.75 && overlapRatio < 0.2) {
    return false;
  }
  return (
    horizontalGap <= avgHeight * LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO &&
    verticalGap <= avgHeight * 1.45 &&
    unionHeight <= avgHeight * 4.8
  );
}

function shouldJoinLocalPaddleNormalOutsideText(left, right, imageSize) {
  const leftBox = left.box;
  const rightBox = right.box;
  const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const verticalOverlap = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
  const sameLine = verticalOverlap >= Math.min(leftBox.height, rightBox.height) * 0.45;
  if (sameLine) {
    return getHorizontalGap(leftBox, rightBox) <= avgHeight * 1.2;
  }
  const verticalGap = getVerticalGap(leftBox, rightBox);
  const centerDistance = Math.abs(leftBox.centerX - rightBox.centerX);
  const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
  const unionWidth = Math.max(leftBox.right, rightBox.right) - Math.min(leftBox.left, rightBox.left);
  const unionHeight = Math.max(leftBox.bottom, rightBox.bottom) - Math.min(leftBox.top, rightBox.top);
  const leftText = String(left.text || "");
  const rightText = String(right.text || "");
  const hasHangul = /[\uac00-\ud7af]/.test(leftText + rightText);
  const redScore = Math.max(Number(left.color && left.color.redScore) || 0, Number(right.color && right.color.redScore) || 0);

  if (verticalGap <= avgHeight * 0.9 && centerDistance <= Math.max(leftBox.width, rightBox.width) * 0.42) {
    return true;
  }

  // Kakao-style large speech bubbles sometimes fail white-container detection.
  // Treat aligned black Hangul lines as one bubble block instead of translating
  // every OCR line separately.
  return (
    hasHangul &&
    redScore < 0.12 &&
    verticalGap <= avgHeight * 1.45 &&
    unionWidth <= imageWidth * 0.72 &&
    unionHeight <= avgHeight * 6.2 &&
    (centerDistance <= Math.max(leftBox.width, rightBox.width) * 0.72 || overlapRatio >= 0.18)
  );
}

function isLocalPaddleVerticalPair(leftBox, rightBox) {
  const avgWidth = Math.max(1, (leftBox.width + rightBox.width) / 2);
  const leftTall = leftBox.height >= leftBox.width * 1.1;
  const rightTall = rightBox.height >= rightBox.width * 1.1;
  return leftTall && rightTall && Math.abs(leftBox.centerX - rightBox.centerX) <= avgWidth * 1.35;
}

function mergeLocalPaddleCluster(cluster, imageSize, imageAnalysis) {
  if (!Array.isArray(cluster) || cluster.length === 0) {
    return null;
  }
  const items = cluster.map((entry) => entry.item);
  const merged = mergeBaiduWordItems(items, imageSize);
  if (!merged) {
    return null;
  }
  merged.localOcrClusterKind = cluster[0].kind;
  merged.localOcrContainerId = cluster[0].container ? cluster[0].container.id : "";
  merged.adaptiveBackground = analyzeLocalOcrAdaptiveBackground(
    imageAnalysis && imageAnalysis.sample,
    getBaiduItemBox(merged),
    cluster[0].kind
  );
  return merged;
}

function analyzeLocalOcrAdaptiveBackground(sample, box, clusterKind) {
  if (!sample || !sample.data || !box) {
    return { type: clusterKind === "bubbleText" ? "solid" : "outline", color: "#ffffff", confidence: 0 };
  }
  const { data, width, height, scale } = sample;
  const padX = box.width * 0.08;
  const padY = box.height * 0.12;
  const left = clamp(Math.floor((box.left - padX) * scale), 0, width - 1);
  const top = clamp(Math.floor((box.top - padY) * scale), 0, height - 1);
  const right = clamp(Math.ceil((box.right + padX) * scale), left + 1, width);
  const bottom = clamp(Math.ceil((box.bottom + padY) * scale), top + 1, height);
  const border = Math.max(1, Math.round(Math.min(right - left, bottom - top) * 0.16));
  const pixels = [];
  const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 80));
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      if (x >= left + border && x < right - border && y >= top + border && y < bottom - border) {
        continue;
      }
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 32) {
        continue;
      }
      pixels.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
  }
  if (pixels.length < 16) {
    return { type: clusterKind === "bubbleText" ? "solid" : "outline", color: "#ffffff", confidence: 0 };
  }
  const medianChannel = (channel) => pixels.map((pixel) => pixel[channel]).sort((a, b) => a - b)[Math.floor(pixels.length / 2)];
  const red = medianChannel(0);
  const green = medianChannel(1);
  const blue = medianChannel(2);
  const matching = pixels.filter((pixel) =>
    Math.max(Math.abs(pixel[0] - red), Math.abs(pixel[1] - green), Math.abs(pixel[2] - blue)) <= 30
  ).length;
  const confidence = matching / pixels.length;
  const color = `#${[red, green, blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
  return {
    type: confidence >= 0.84 || clusterKind === "bubbleText" ? "solid" : "outline",
    color,
    confidence
  };
}

function getHorizontalGap(leftBox, rightBox) {
  return leftBox.left > rightBox.right
    ? leftBox.left - rightBox.right
    : rightBox.left > leftBox.right
      ? rightBox.left - leftBox.right
      : 0;
}

function getVerticalGap(leftBox, rightBox) {
  return leftBox.top > rightBox.bottom
    ? leftBox.top - rightBox.bottom
    : rightBox.top > leftBox.bottom
      ? rightBox.top - leftBox.bottom
      : 0;
}

function getBoxOverlapArea(leftBox, rightBox) {
  if (!leftBox || !rightBox) {
    return 0;
  }
  const width = Math.max(0, Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left));
  const height = Math.max(0, Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top));
  return width * height;
}

function prepareLocalPaddleWords(words, imageSize) {
  const usableWords = words.filter((item) => !shouldDropLocalPaddleNoiseItem(item, imageSize));
  const { merged, usedIndexes } = mergeLocalPaddleVerticalWords(usableWords, imageSize);
  const remaining = usableWords.filter((item, index) => !usedIndexes.has(index) && !shouldDropUnmergedLocalPaddleFragment(item, imageSize));
  return [...remaining, ...merged].sort(compareBaiduWordItems);
}

function mergeLocalPaddleVerticalWords(words, imageSize) {
  const candidates = words
    .map((item, index) => ({ item, index, box: getBaiduItemBox(item) }))
    .filter((entry) => entry.box && isLocalPaddleVerticalCandidate(entry.item, entry.box, imageSize))
    .sort((left, right) => left.box.left - right.box.left || left.box.top - right.box.top);
  const groups = [];

  candidates.forEach((entry) => {
    const group = groups.find((candidate) => shouldJoinLocalPaddleVerticalGroup(candidate, entry));
    if (group) {
      group.entries.push(entry);
      group.box = getBaiduGroupBox(group.entries.map((item) => item.item));
      return;
    }
    groups.push({ entries: [entry], box: entry.box });
  });

  const usedIndexes = new Set();
  const merged = [];
  groups.forEach((group) => {
    const entries = group.entries.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
    if (entries.length < 2) {
      return;
    }
    const text = entries.map((entry) => String(entry.item.words || "").trim()).filter(Boolean).join("");
    if (countScriptChars(text) < 2) {
      return;
    }
    const boxes = entries.map((entry) => entry.box).filter(Boolean);
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const location = expandBaiduMergedLocation(
      {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
      },
      boxes,
      imageSize
    );
    entries.forEach((entry) => usedIndexes.add(entry.index));
    merged.push({
      words: text,
      confidence: Math.max(...entries.map((entry) => Number(entry.item.confidence || 0))),
      rawBox: location,
      location
    });
  });

  return { merged, usedIndexes };
}

function isLocalPaddleVerticalCandidate(item, box, imageSize) {
  const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
  if (!text || !/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/.test(text)) {
    return false;
  }
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  return box.height >= box.width * 1.35 || (box.width <= imageWidth * 0.075 && box.height >= box.width * 1.1);
}

function shouldJoinLocalPaddleVerticalGroup(group, entry) {
  const groupBox = group.box;
  const box = entry.box;
  if (!groupBox || !box) {
    return false;
  }
  const avgWidth = Math.max(1, (groupBox.width + box.width) / 2);
  const centerDistance = Math.abs(groupBox.centerX - box.centerX);
  const verticalGap =
    box.top > groupBox.bottom ? box.top - groupBox.bottom : groupBox.top > box.bottom ? groupBox.top - box.bottom : 0;
  const overlapX = Math.min(groupBox.right, box.right) - Math.max(groupBox.left, box.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, box.width)) : 0;
  return (centerDistance <= avgWidth * 1.35 || overlapRatio >= 0.18) && verticalGap <= avgWidth * 2.2;
}

function shouldDropLocalPaddleNoiseItem(item, imageSize) {
  const box = getBaiduItemBox(item);
  const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
  if (!box || !text) {
    return true;
  }
  if (shouldDropLowConfidenceLocalPaddleText(text, Number(item.confidence || 0))) {
    return true;
  }
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const areaRatio = (box.width * box.height) / Math.max(1, imageWidth * imageHeight);
  if (countScriptChars(text) <= 1 && areaRatio < 0.003 && Number(item.confidence || 0) < 0.98) {
    return true;
  }
  return false;
}

function shouldDropLowConfidenceLocalPaddleText(text, confidence) {
  const raw = String(text || "").trim();
  const score = Number(confidence || 0);
  if (!raw || score >= 0.72) {
    return false;
  }

  const hangul = (raw.match(/[\uac00-\ud7af]/g) || []).length;
  const jamo = (raw.match(/[\u3130-\u318f]/g) || []).length;
  const latin = (raw.match(/[A-Za-z]/g) || []).length;
  const script = countScriptChars(raw);
  if (latin > 0 && script <= 3) {
    return true;
  }
  if (hangul <= 1 && jamo > 0) {
    return true;
  }
  if (hangul <= 2 && score < 0.5) {
    return true;
  }
  if (hangul <= 1 && score < 0.62) {
    return true;
  }
  return false;
}

function shouldDropUnmergedLocalPaddleFragment(item, imageSize) {
  const box = getBaiduItemBox(item);
  const text = String(item && item.words ? item.words : "").replace(/\s+/g, "");
  if (!box || !text) {
    return true;
  }
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const areaRatio = (box.width * box.height) / Math.max(1, imageWidth * imageHeight);
  return countScriptChars(text) <= 1 && (areaRatio < 0.012 || box.width <= imageWidth * 0.08);
}

function countScriptChars(text) {
  return (String(text || "").match(/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
}

function normalizeLocalPaddleOcrItem(item, imageSize) {
  const text = cleanDecorativeSymbols(
    item && item.text !== undefined
      ? item.text
      : item && item.words !== undefined
        ? item.words
        : ""
  );
  if (!text) {
    return null;
  }
  if (isSymbolOnlyText(text)) {
    return null;
  }

  const box = normalizeLocalPaddleOcrBox(item, imageSize);
  if (!box) {
    return null;
  }

  return {
    words: text,
    confidence: Number(item.score || item.confidence || 0),
    rawBox: box,
    location: {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height
    }
  };
}

function isOcrItemOwnedByStitch(item, stitch) {
  if (!stitch || !item || !item.location) {
    return true;
  }
  const ownerTop = Number(stitch.ownerTop);
  const ownerHeight = Number(stitch.ownerHeight);
  if (!(Number.isFinite(ownerTop) && ownerHeight > 0)) {
    return true;
  }
  const centerY = Number(item.location.top || 0) + Number(item.location.height || 0) / 2;
  return centerY >= ownerTop && centerY < ownerTop + ownerHeight;
}

function normalizeImageMeta(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const meta = {
    width: toNumber(value.width, 0),
    height: toNumber(value.height, 0),
    cssWidth: toNumber(value.cssWidth, 0),
    cssHeight: toNumber(value.cssHeight, 0),
    bitmapWidth: toNumber(value.bitmapWidth, 0),
    bitmapHeight: toNumber(value.bitmapHeight, 0),
    cropX: toNumber(value.cropX, 0),
    cropY: toNumber(value.cropY, 0),
    cropCssX: toNumber(value.cropCssX, 0),
    cropCssY: toNumber(value.cropCssY, 0),
    cropCssWidth: toNumber(value.cropCssWidth, 0),
    cropCssHeight: toNumber(value.cropCssHeight, 0),
    devicePixelRatio: toNumber(value.devicePixelRatio, 1),
    source: String(value.source || ""),
    stitch: normalizeStitchMeta(value.stitch)
  };
  return meta.width > 0 || meta.height > 0 || meta.cropCssWidth > 0 ? meta : null;
}

function normalizeStitchMeta(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ownerTop = toNumber(value.ownerTop, -1);
  const ownerHeight = toNumber(value.ownerHeight, 0);
  const compositeWidth = toNumber(value.compositeWidth, 0);
  const compositeHeight = toNumber(value.compositeHeight, 0);
  if (ownerTop < 0 || ownerHeight <= 0 || compositeWidth <= 0 || compositeHeight <= 0) {
    return null;
  }
  return {
    ownerTop,
    ownerHeight,
    compositeWidth,
    compositeHeight,
    overlap: toNumber(value.overlap, 0),
    sourceKeys: Array.isArray(value.sourceKeys) ? value.sourceKeys.map((entry) => String(entry || "")) : []
  };
}

function getLocalOcrParams(settings = {}) {
  return {
    text_det_thresh: clampNumber(settings.localOcrDetThresh, 0.01, 0.99, DEFAULT_LOCAL_OCR_DET_THRESH),
    text_det_box_thresh: clampNumber(settings.localOcrDetBoxThresh, 0.01, 0.99, DEFAULT_LOCAL_OCR_DET_BOX_THRESH),
    text_det_unclip_ratio: clampNumber(settings.localOcrDetUnclipRatio, 1, 5, DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO),
    text_rec_score_thresh: clampNumber(settings.ocrConfidenceThreshold, 0, 1, 0)
  };
}

function getDefaultOcrTuning() {
  return {
    confidenceThreshold: DEFAULT_SETTINGS.ocrConfidenceThreshold,
    minBoxArea: DEFAULT_SETTINGS.ocrMinBoxArea,
    maxBoxArea: DEFAULT_SETTINGS.ocrMaxBoxArea,
    minBoxWidth: DEFAULT_SETTINGS.ocrMinBoxWidth,
    minBoxHeight: DEFAULT_SETTINGS.ocrMinBoxHeight,
    maxAspectRatio: DEFAULT_SETTINGS.ocrMaxAspectRatio,
    mergeLineGap: DEFAULT_SETTINGS.ocrMergeLineGap,
    fontScale: DEFAULT_SETTINGS.overwriteFontScale,
    coverPadding: DEFAULT_SETTINGS.overwriteCoverPadding,
    debugOverlayMode: DEFAULT_SETTINGS.debugOverlayMode,
    overwritePreviewMode: DEFAULT_SETTINGS.overwritePreviewMode,
    debugEnabled: false
  };
}

function getOcrTuning(settings = {}) {
  const defaults = getDefaultOcrTuning();
  return {
    confidenceThreshold: clampNumber(settings.ocrConfidenceThreshold, 0, 1, defaults.confidenceThreshold),
    minBoxArea: clampNumber(settings.ocrMinBoxArea, 0, 1000000, defaults.minBoxArea),
    maxBoxArea: clampNumber(settings.ocrMaxBoxArea, 0.001, 1, defaults.maxBoxArea),
    minBoxWidth: clampNumber(settings.ocrMinBoxWidth, 0, 10000, defaults.minBoxWidth),
    minBoxHeight: clampNumber(settings.ocrMinBoxHeight, 0, 10000, defaults.minBoxHeight),
    maxAspectRatio: clampNumber(settings.ocrMaxAspectRatio, 1, 100, defaults.maxAspectRatio),
    mergeLineGap: clampNumber(settings.ocrMergeLineGap, 0.2, 8, defaults.mergeLineGap),
    fontScale: clampNumber(settings.overwriteFontScale, 0.5, 2.5, defaults.fontScale),
    coverPadding: clampNumber(settings.overwriteCoverPadding, 0, 1.2, defaults.coverPadding),
    debugOverlayMode: normalizeDebugOverlayMode(settings.debugOverlayMode),
    overwritePreviewMode: normalizeOverwritePreviewMode(settings.overwritePreviewMode),
    debugEnabled: settings.localOcrDebug === true
  };
}

function normalizeDebugOverlayMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return DEBUG_OVERLAY_MODES.has(text) ? text : DEFAULT_SETTINGS.debugOverlayMode;
}

function normalizeOverwritePreviewMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return OVERWRITE_PREVIEW_MODES.has(text) ? text : DEFAULT_SETTINGS.overwritePreviewMode;
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, number));
}

function createOcrDebugSession(engine, imageSize, tuning, extras = {}) {
  return {
    version: 1,
    engine,
    imageWidth: Number(imageSize && imageSize.width) || 0,
    imageHeight: Number(imageSize && imageSize.height) || 0,
    params: { ...getDefaultOcrTuning(), ...(tuning || {}) },
    rawItems: Array.isArray(extras.rawItems) ? extras.rawItems : [],
    filteredItems: [],
    mergedItems: [],
    finalBubbles: [],
    filterReasons: []
  };
}

function getLocalOcrPayloadItems(payload, preferRaw = false) {
  if (preferRaw && payload && Array.isArray(payload.rawItems) && payload.rawItems.length > 0) {
    return payload.rawItems;
  }
  return payload && Array.isArray(payload.items)
    ? payload.items
    : payload && Array.isArray(payload.results)
      ? payload.results
      : payload && Array.isArray(payload.ocr)
        ? payload.ocr
        : [];
}

function keepOrTraceOcrWord(item, imageSize, tuning, debug, index, engine) {
  const reason = getOcrWordDropReason(item, imageSize, tuning);
  if (!reason) {
    return true;
  }
  traceFilterReason(debug, {
    stage: "filter",
    engine,
    index,
    reason,
    item: toDebugOcrItem(item, index, imageSize, "filtered")
  });
  return false;
}

function keepOrTraceFinalCandidate(item, imageSize, tuning, debug, engine) {
  const reason = getFinalCandidateDropReason(item, imageSize, tuning, engine);
  if (!reason) {
    return true;
  }
  traceFilterReason(debug, {
    stage: "final",
    engine,
    id: item && item.id,
    reason,
    item: {
      text: item && item.original_text ? item.original_text : "",
      confidence: Number(item && item.confidence) || 0,
      rawBox: item && item.rawBox ? item.rawBox : null,
      percent: item ? { x: item.x, y: item.y, w: item.w, h: item.h } : null
    }
  });
  return false;
}

function getOcrWordDropReason(item, imageSize, tuning = getDefaultOcrTuning()) {
  const box = getBaiduItemBox(item);
  const text = String(item && (item.words || item.text) ? item.words || item.text : "").replace(/\s+/g, "");
  if (!box || !text) {
    return "empty-text-or-box";
  }
  if (isSymbolOnlyText(text)) {
    return "symbol-only";
  }

  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const area = box.width * box.height;
  const areaRatio = area / Math.max(1, imageWidth * imageHeight);
  const confidence = Number(item.confidence || item.score || 0);
  const aspectRatio = Math.max(box.width / Math.max(1, box.height), box.height / Math.max(1, box.width));
  const scriptChars = countScriptChars(text);

  if (confidence > 0 && confidence < Number(tuning.confidenceThreshold || 0)) {
    if (scriptChars <= 2 || areaRatio < 0.012) {
      return "low-confidence";
    }
  }
  if (area < Number(tuning.minBoxArea || 0)) {
    return "too-small-area";
  }
  if (areaRatio > Number(tuning.maxBoxArea || 1)) {
    return "too-large-area";
  }
  if (box.width < Number(tuning.minBoxWidth || 0) || box.height < Number(tuning.minBoxHeight || 0)) {
    return "too-small-dimension";
  }
  if (aspectRatio > Number(tuning.maxAspectRatio || 100)) {
    return "bad-aspect-ratio";
  }
  if (scriptChars <= 1 && areaRatio < 0.003 && confidence < 0.98) {
    return "tiny-single-character";
  }
  if (shouldDropLowConfidenceLocalPaddleText(text, confidence)) {
    return "weak-script-confidence";
  }
  return "";
}

function getFinalCandidateDropReason(item, imageSize, tuning, engine) {
  if (!item || !item.original_text) {
    return "empty-final-text";
  }
  const box = getNormalizedCandidatePixelBox(item, imageSize);
  if (!box) {
    return "invalid-final-box";
  }
  const confidence = Number(item.confidence || 0);
  if (confidence > 0 && confidence < Number(tuning.confidenceThreshold || 0)) {
    const text = String(item.original_text || "");
    const scriptChars = countScriptChars(text);
    const areaRatio =
      (box.width * box.height) /
      Math.max(1, (Number(imageSize && imageSize.width) || 1) * (Number(imageSize && imageSize.height) || 1));
    if (scriptChars <= 2 || areaRatio < 0.012) {
      return "low-confidence-final";
    }
  }
  if (engine === "local_paddle" && shouldDropLocalPaddleCandidateBubble(item, imageSize)) {
    return "local-paddle-candidate-noise";
  }
  return "";
}

function traceFilterReason(debug, entry) {
  if (!debug || !Array.isArray(debug.filterReasons)) {
    return;
  }
  debug.filterReasons.push(entry);
}

function toDebugOcrItem(item, index, imageSize, stage) {
  const box = getDebugItemBox(item);
  const text = String(item && (item.words || item.text) ? item.words || item.text : "").trim();
  return {
    id: `${stage || "ocr"}-${index}`,
    stage,
    text,
    confidence: Number(item && (item.confidence ?? item.score)) || 0,
    rawBox: box,
    percent: boxToPercent(box, imageSize),
    engine: item && item.lang ? item.lang : "",
    source: item && item.variant ? item.variant : "",
    raw: item || null
  };
}

function getDebugItemBox(item) {
  if (!item) {
    return null;
  }
  if (item.rawBox) {
    return normalizeDebugBox(item.rawBox);
  }
  if (item.location) {
    return normalizeDebugBox(item.location);
  }
  if (item.box) {
    return normalizeDebugBox(item.box);
  }
  return null;
}

function normalizeDebugBox(box) {
  const left = Number(box && (box.left ?? box.x));
  const top = Number(box && (box.top ?? box.y));
  const width = Number(box && (box.width ?? box.w));
  const height = Number(box && (box.height ?? box.h));
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { left, top, width, height };
}

function boxToPercent(box, imageSize) {
  if (!box) {
    return null;
  }
  const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
  return {
    x: (box.left / width) * 100,
    y: (box.top / height) * 100,
    w: (box.width / width) * 100,
    h: (box.height / height) * 100
  };
}

function buildUnifiedOcrDebugPayload(debug, candidates, extras = {}) {
  const finalBubbles = (candidates || []).map((item) => ({
    id: item.id,
    text: item.original_text,
    confidence: item.confidence || 0,
    rawBox: item.rawBox || null,
    box: item.rawBox || null,
    percent: { x: item.x, y: item.y, w: item.w, h: item.h },
    translatedText: item.translated_text || ""
  }));
  if (debug) {
    debug.finalBubbles = finalBubbles;
  }
  return {
    ...(debug || {}),
    ...extras,
    items: finalBubbles,
    finalBubbles
  };
}

function buildLocalOcrDebugId(targetKey) {
  return String(targetKey || `target-${Date.now()}`)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .slice(0, 80);
}

function normalizeLocalPaddleOcrBox(item, imageSize) {
  const rawBox = item && (item.box || item.location || item.bbox || item.boundingBox);
  let left;
  let top;
  let right;
  let bottom;

  if (Array.isArray(rawBox) && rawBox.length >= 4 && rawBox.every((value) => typeof value === "number")) {
    left = rawBox[0];
    top = rawBox[1];
    right = rawBox[2];
    bottom = rawBox[3];
    if (right <= left || bottom <= top) {
      right = left + Math.max(1, rawBox[2]);
      bottom = top + Math.max(1, rawBox[3]);
    }
  } else if (rawBox && typeof rawBox === "object") {
    left = toNumber(rawBox.left !== undefined ? rawBox.left : rawBox.x, NaN);
    top = toNumber(rawBox.top !== undefined ? rawBox.top : rawBox.y, NaN);
    const width = toNumber(rawBox.width !== undefined ? rawBox.width : rawBox.w, NaN);
    const height = toNumber(rawBox.height !== undefined ? rawBox.height : rawBox.h, NaN);
    right = rawBox.right !== undefined ? toNumber(rawBox.right, NaN) : left + width;
    bottom = rawBox.bottom !== undefined ? toNumber(rawBox.bottom, NaN) : top + height;
  } else if (Array.isArray(item && item.points)) {
    const points = item.points
      .map((point) => {
        if (Array.isArray(point) && point.length >= 2) {
          return { x: Number(point[0]), y: Number(point[1]) };
        }
        if (point && typeof point === "object") {
          return { x: Number(point.x), y: Number(point.y) };
        }
        return null;
      })
      .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length > 0) {
      left = Math.min(...points.map((point) => point.x));
      top = Math.min(...points.map((point) => point.y));
      right = Math.max(...points.map((point) => point.x));
      bottom = Math.max(...points.map((point) => point.y));
    }
  }

  if (![left, top, right, bottom].every(Number.isFinite)) {
    return null;
  }

  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const safeLeft = clamp(left, 0, imageWidth);
  const safeTop = clamp(top, 0, imageHeight);
  const safeRight = clamp(right, safeLeft + 1, imageWidth);
  const safeBottom = clamp(bottom, safeTop + 1, imageHeight);

  return {
    left: safeLeft,
    top: safeTop,
    width: safeRight - safeLeft,
    height: safeBottom - safeTop
  };
}

async function requestBaiduAccurateOcr({ dataUrl, apiKey, secretKey }) {
  const accessToken = await requestBaiduAccessToken({ apiKey, secretKey });
  return enqueueBaiduOcrRequest(() => requestBaiduAccurateOcrOnce({ dataUrl, accessToken }));
}

async function enqueueBaiduOcrRequest(taskFactory) {
  const run = baiduOcrQueue
    .catch(() => {
      // 前一个 OCR 失败不应阻塞后续排队任务。
    })
    .then(() => runBaiduOcrWithThrottle(taskFactory));

  baiduOcrQueue = run.catch(() => {
    // 队列状态只负责串行化，错误交给当前调用方处理。
  });

  return run;
}

async function runBaiduOcrWithThrottle(taskFactory) {
  let attempt = 0;

  while (true) {
    await waitForBaiduOcrSlot();

    try {
      baiduLastOcrRequestAt = Date.now();
      return await taskFactory();
    } catch (error) {
      if (!isBaiduQpsLimitError(error) || attempt >= BAIDU_OCR_QPS_RETRY_DELAYS_MS.length) {
        throw error;
      }

      const delayMs = BAIDU_OCR_QPS_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      await delay(delayMs);
    }
  }
}

async function waitForBaiduOcrSlot() {
  const elapsed = Date.now() - baiduLastOcrRequestAt;
  const waitMs = BAIDU_OCR_MIN_REQUEST_GAP_MS - elapsed;
  if (waitMs > 0) {
    await delay(waitMs);
  }
}

function isBaiduQpsLimitError(error) {
  const reason = getErrorMessage(error);
  return /\b18\b/.test(reason) || /qps request limit|open api qps|rate limit/i.test(reason);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function requestBaiduAccurateOcrOnce({ dataUrl, accessToken }) {
  const endpoint = `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=${encodeURIComponent(
    accessToken
  )}`;
  const parsed = parseDataUrl(dataUrl);
  const body = new URLSearchParams();
  body.set("image", parsed.base64Data);
  body.set("detect_direction", "false");
  body.set("vertexes_location", "false");
  body.set("paragraph", "true");
  body.set("probability", "false");
  body.set("char_probability", "false");
  body.set("multidirectional_recognize", "true");
  body.set("language_type", "auto_detect");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  const payload = await safeJson(response);
  if (!response.ok || !payload || payload.error_code) {
    throw new Error(`Baidu OCR request failed: ${formatBaiduError(payload, response)}`);
  }

  return {
    words_result: Array.isArray(payload.words_result) ? payload.words_result : [],
    paragraphs_result: Array.isArray(payload.paragraphs_result) ? payload.paragraphs_result : []
  };
}

async function requestBaiduAccessToken({ apiKey, secretKey }) {
  const now = Date.now();
  if (
    baiduAccessTokenCache &&
    baiduAccessTokenCache.apiKey === apiKey &&
    baiduAccessTokenCache.secretKey === secretKey &&
    baiduAccessTokenCache.expiresAt > now + 60 * 1000
  ) {
    return baiduAccessTokenCache.token;
  }

  const url =
    "https://aip.baidubce.com/oauth/2.0/token" +
    `?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}` +
    `&client_secret=${encodeURIComponent(secretKey)}`;

  const response = await fetch(url, { method: "POST" });
  const payload = await safeJson(response);
  if (!response.ok || !payload || payload.error) {
    throw new Error(`Baidu token request failed: ${formatBaiduError(payload, response)}`);
  }

  const token = String(payload.access_token || "").trim();
  if (!token) {
    throw new Error("Baidu token response missing access_token");
  }

  const expiresIn = Math.max(300, Number(payload.expires_in || 2592000));
  baiduAccessTokenCache = {
    apiKey,
    secretKey,
    token,
    expiresAt: now + expiresIn * 1000
  };

  return token;
}

function buildBaiduBubbleItems(payload, imageSize, ocrTuning = getDefaultOcrTuning(), ocrDebug = null) {
  const words = Array.isArray(payload && payload.words_result) ? payload.words_result : [];
  if (words.length === 0) {
    return [];
  }
  if (ocrDebug) {
    ocrDebug.rawItems = words.map((item, index) => toDebugOcrItem(item, index, imageSize, "raw"));
  }

  const usedIndexes = new Set();
  const filteredWords = words.filter((item, index) =>
    keepOrTraceOcrWord(item, imageSize, ocrTuning, ocrDebug, index, "baidu")
  );
  if (ocrDebug) {
    ocrDebug.filteredItems = filteredWords.map((item, index) => toDebugOcrItem(item, index, imageSize, "filtered"));
  }
  const filteredIndexes = new Set(filteredWords.map((item) => words.indexOf(item)));
  const paragraphItems = buildBaiduParagraphItems(payload, words, imageSize, usedIndexes, filteredIndexes);
  const remainingItems = filteredWords.filter((item) => !usedIndexes.has(words.indexOf(item)) && getBaiduItemBox(item));
  const geometricItems = mergeBaiduGeometryItems(remainingItems, imageSize, ocrTuning);
  const mergedItems = [...paragraphItems, ...geometricItems]
    .filter((item) => item && item.words && item.location)
    .sort(compareBaiduWordItems);
  if (ocrDebug) {
    ocrDebug.mergedItems = mergedItems.map((item, index) => toDebugOcrItem(item, index, imageSize, "merged"));
  }

  return mergedItems;
}

function buildBaiduParagraphItems(payload, words, imageSize, usedIndexes, filteredIndexes = null) {
  const paragraphs = Array.isArray(payload && payload.paragraphs_result) ? payload.paragraphs_result : [];
  const grouped = [];

  paragraphs.forEach((paragraph) => {
    const indexes = Array.isArray(paragraph.words_result_idx) ? paragraph.words_result_idx : [];
    const group = indexes
      .map((index) => {
        const numericIndex = Number(index);
        const item = words[numericIndex];
        if (filteredIndexes && !filteredIndexes.has(numericIndex)) {
          return null;
        }
        if (!item || !getBaiduItemBox(item)) {
          return null;
        }
        usedIndexes.add(numericIndex);
        return item;
      })
      .filter(Boolean);

    if (group.length > 0) {
      grouped.push(mergeBaiduWordItems(group, imageSize));
    }
  });

  return grouped;
}

function mergeBaiduGeometryItems(items, imageSize, ocrTuning = getDefaultOcrTuning()) {
  const sorted = items.filter((item) => item && getBaiduItemBox(item)).sort(compareBaiduWordItems);
  const groups = [];

  sorted.forEach((item) => {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && shouldMergeBaiduWordItem(lastGroup, item, imageSize, ocrTuning)) {
      lastGroup.push(item);
      return;
    }

    groups.push([item]);
  });

  return groups.map((group) => mergeBaiduWordItems(group, imageSize));
}

function shouldMergeBaiduWordItem(group, item, imageSize, ocrTuning = getDefaultOcrTuning()) {
  const groupBox = getBaiduGroupBox(group);
  const itemBox = getBaiduItemBox(item);
  if (!groupBox || !itemBox) {
    return false;
  }

  const avgHeight = Math.max(1, getBaiduAverageHeight([...group, item]));
  const verticalOverlap = Math.min(groupBox.bottom, itemBox.bottom) - Math.max(groupBox.top, itemBox.top);
  const sameLine = verticalOverlap >= Math.min(groupBox.height, itemBox.height) * 0.45;
  const horizontalGap =
    itemBox.left > groupBox.right
      ? itemBox.left - groupBox.right
      : groupBox.left > itemBox.right
        ? groupBox.left - itemBox.right
        : 0;

  if (sameLine) {
    return horizontalGap <= avgHeight * 2.2;
  }

  const verticalGap = itemBox.top - groupBox.bottom;
  const mergeGap = Math.max(0.2, Number(ocrTuning.mergeLineGap || BAIDU_MERGE_MAX_GAP_RATIO));
  if (verticalGap < -avgHeight * 0.5 || verticalGap > avgHeight * mergeGap) {
    return false;
  }

  const centerDistance = Math.abs(itemBox.centerX - groupBox.centerX);
  const maxWidth = Math.max(groupBox.width, itemBox.width, avgHeight * 4);
  const indent = Math.abs(itemBox.left - groupBox.left);
  const overlapX = Math.min(groupBox.right, itemBox.right) - Math.max(groupBox.left, itemBox.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, itemBox.width)) : 0;
  const groupWidthRatio = imageSize && imageSize.width > 0 ? groupBox.width / imageSize.width : 0;

  return (
    centerDistance <= maxWidth * 0.62 &&
    groupWidthRatio <= BAIDU_MERGE_MAX_WIDTH_RATIO &&
    (overlapRatio >= 0.2 || indent <= avgHeight * BAIDU_MERGE_MAX_INDENT_RATIO)
  );
}

function mergeBaiduWordItems(items, imageSize) {
  const boxes = items.map((item) => getBaiduItemBox(item)).filter(Boolean);
  if (boxes.length === 0) {
    return null;
  }

  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  const location = expandBaiduMergedLocation(
    {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    },
    boxes,
    imageSize
  );

  return {
    words: composeBaiduMergedWords(items),
    location,
    confidence: Math.max(...items.map((item) => Number(item.confidence || 0))),
    rawBox: location
  };
}

function composeBaiduMergedWords(items) {
  const rows = [];
  const sorted = items.filter((item) => item && String(item.words || "").trim()).sort(compareBaiduWordItems);

  sorted.forEach((item) => {
    const box = getBaiduItemBox(item);
    const text = String(item.words || "").trim();
    if (!box || !text) {
      return;
    }

    const row = rows.find((candidate) => {
      const overlap = Math.min(candidate.bottom, box.bottom) - Math.max(candidate.top, box.top);
      return overlap >= Math.min(candidate.height, box.height) * 0.45;
    });

    if (row) {
      row.items.push({ item, box, text });
      row.top = Math.min(row.top, box.top);
      row.bottom = Math.max(row.bottom, box.bottom);
      row.height = Math.max(1, row.bottom - row.top);
    } else {
      rows.push({
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        items: [{ item, box, text }]
      });
    }
  });

  return rows
    .sort((left, right) => left.top - right.top)
    .map((row) =>
      row.items
        .sort((left, right) => left.box.left - right.box.left)
        .map((entry) => entry.text)
        .join(" ")
    )
    .filter(Boolean)
    .join("\n");
}

function expandBaiduMergedLocation(location, boxes, imageSize) {
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const avgHeight = Math.max(1, boxes.reduce((sum, box) => sum + box.height, 0) / Math.max(1, boxes.length));
  const marginX = Math.max(3, Math.min(location.width * 0.1, avgHeight * 0.6));
  const marginY = Math.max(3, Math.min(location.height * 0.1, avgHeight * 0.5));
  const left = clamp(location.left - marginX, 0, imageWidth);
  const top = clamp(location.top - marginY, 0, imageHeight);
  const right = clamp(location.left + location.width + marginX, left + 1, imageWidth);
  const bottom = clamp(location.top + location.height + marginY, top + 1, imageHeight);

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function getBaiduGroupBox(group) {
  const boxes = group.map((item) => getBaiduItemBox(item)).filter(Boolean);
  if (boxes.length === 0) {
    return null;
  }

  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  return buildBaiduBox(left, top, right, bottom);
}

function getBaiduItemBox(item) {
  const location = item && item.location && typeof item.location === "object" ? item.location : null;
  if (!location) {
    return null;
  }

  const left = toNumber(location.left);
  const top = toNumber(location.top);
  const width = toNumber(location.width);
  const height = toNumber(location.height);
  if (!(width > 0 && height > 0)) {
    return null;
  }

  return buildBaiduBox(left, top, left + width, top + height);
}

function buildBaiduBox(left, top, right, bottom) {
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2
  };
}

function getBaiduAverageHeight(items) {
  const boxes = items.map((item) => getBaiduItemBox(item)).filter(Boolean);
  if (boxes.length === 0) {
    return 1;
  }

  return boxes.reduce((sum, box) => sum + box.height, 0) / boxes.length;
}

function compareBaiduWordItems(left, right) {
  const leftBox = getBaiduItemBox(left);
  const rightBox = getBaiduItemBox(right);
  if (!leftBox || !rightBox) {
    return leftBox ? -1 : rightBox ? 1 : 0;
  }

  const averageHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
  if (Math.abs(leftBox.top - rightBox.top) <= averageHeight * 0.55) {
    return leftBox.left - rightBox.left;
  }

  return leftBox.top - rightBox.top;
}

function normalizeBaiduOcrItem(item, index, imageSize) {
  const location = item && item.location && typeof item.location === "object" ? item.location : null;
  const text = cleanDecorativeSymbols(item && item.words ? item.words : "");
  if (!location || !text || imageSize.width <= 0 || imageSize.height <= 0) {
    return null;
  }

  const left = toNumber(location.left);
  const top = toNumber(location.top);
  const width = toNumber(location.width);
  const height = toNumber(location.height);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const expandX = Math.min(1, width * 0.01);
  const expandY = Math.min(1, height * 0.02);
  const x = ((left - expandX) / imageSize.width) * 100;
  const y = ((top - expandY) / imageSize.height) * 100;
  const w = ((width + expandX * 2) / imageSize.width) * 100;
  const h = ((height + expandY * 2) / imageSize.height) * 100;

  const clusterKind = String(item && item.localOcrClusterKind ? item.localOcrClusterKind : "");
  const adaptiveBackground = item && item.adaptiveBackground ? item.adaptiveBackground : null;
  const bgType = adaptiveBackground
    ? adaptiveBackground.type === "solid" ? "solid" : "none"
    : clusterKind && clusterKind !== "bubbleText" ? "none" : "solid";

  return {
    id: `t${index}`,
    x: clamp(x, 0, 100),
    y: clamp(y, 0, 100),
    w: clamp(w, 0.1, 100),
    h: clamp(h, 0.1, 100),
    bg_type: bgType,
    bg_color: adaptiveBackground && adaptiveBackground.type === "solid" ? adaptiveBackground.color : "",
    bg_confidence: adaptiveBackground ? Number(adaptiveBackground.confidence || 0) : 0,
    original_text: text,
    translated_text: "",
    confidence: Number(item.confidence || 0),
    rawBox: {
      left,
      top,
      width,
      height
    }
  };
}

async function requestOpenAICompatibleTextTranslations({ items, apiKey, baseUrl, model }) {
  const endpoint = buildOpenAICompatibleEndpoint(baseUrl || DEFAULT_TRANSLATION_BASE_URL);
  const body = {
    model: model || DEFAULT_MODELS[PROVIDERS.baiduDeepSeek],
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a manga dialogue translator. Translate grouped OCR blocks into natural Simplified Chinese. Return JSON only."
      },
      {
        role: "user",
        content: buildOpenAICompatibleTranslationPrompt(items)
      }
    ],
    response_format: { type: "json_object" }
  };

  let payload = await sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body);
  if (!payload) {
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    payload = await sendOpenAICompatibleTranslationRequest(endpoint, apiKey, fallbackBody);
  }

  const text = extractOpenAIMessageText(payload).trim();
  const parsed = parseModelJson(text);
  const rows = parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
  const result = new Map();

  rows.forEach((row) => {
    const id = String(row && row.id ? row.id : "").trim();
    const translatedText = String(row && row.translated_text ? row.translated_text : "").trim();
    if (id && translatedText) {
      result.set(id, translatedText);
    }
  });

  return result;
}

async function sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    const reason = getErrorMessage(toProviderError(payload, response.status, response.statusText, "OpenAI-compatible translation API error"));
    if (body.response_format && shouldRetryWithoutJsonResponseFormat(reason)) {
      return null;
    }
    throw new Error(reason);
  }

  return payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : "";
}

function buildOpenAICompatibleTranslationPrompt(items) {
  const rows = items.map((item) => ({
    id: item.id,
    text: item.original_text
  }));

  return [
    "Translate each OCR block into Simplified Chinese as one complete manga bubble or narration box.",
    "Each input text may contain multiple OCR lines from the same bubble. Understand them together; do not translate line by line mechanically.",
    "Rewrite word order naturally for Chinese, merge broken OCR fragments when needed, and keep character names and tone natural for manga dialogue.",
    "If an input contains a model attachment label such as [Image #1], [Image#1], or Image 1, ignore that label and do not output it.",
    "Preserve the input id exactly. Return one translated_text per id.",
    "Return JSON only with this schema:",
    '{"translations":[{"id":"t0","translated_text":"..."}]}',
    "Input:",
    JSON.stringify(rows)
  ].join("\n");
}

async function decodeDataUrlImageSize(dataUrl) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is unavailable for image size decoding");
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    return {
      width: bitmap.width,
      height: bitmap.height
    };
  } finally {
    bitmap.close();
  }
}

function formatBaiduError(payload, response) {
  if (payload && payload.error_description) {
    return payload.error_description;
  }
  if (payload && payload.error_msg) {
    return `${payload.error_code || "error"} ${payload.error_msg}`;
  }
  if (payload && payload.error) {
    return String(payload.error);
  }
  return response ? `${response.status} ${response.statusText}` : "Unknown Baidu error";
}

async function sendOpenAICompatibleWithJsonFallback({ endpoint, model, apiKey, dataUrl, prompt }) {
  try {
    return await sendOpenAICompatibleOnce({
      endpoint,
      model,
      apiKey,
      dataUrl,
      prompt,
      useJsonResponseFormat: true
    });
  } catch (error) {
    const reason = getErrorMessage(error);
    if (!shouldRetryWithoutJsonResponseFormat(reason)) {
      throw error;
    }

    return sendOpenAICompatibleOnce({
      endpoint,
      model,
      apiKey,
      dataUrl,
      prompt,
      useJsonResponseFormat: false
    });
  }
}

async function sendOpenAICompatibleOnce({
  endpoint,
  model,
  apiKey,
  dataUrl,
  prompt,
  useJsonResponseFormat
}) {
  const body = {
    model: model || DEFAULT_MODELS[PROVIDERS.openaiCompatible],
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "You are a manga OCR + translation engine. Return JSON only."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrl
            }
          }
        ]
      }
    ]
  };

  if (useJsonResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    throw toProviderError(payload, response.status, response.statusText, "OpenAI-compatible API error");
  }

  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const text = extractOpenAIMessageText(message ? message.content : "").trim();
  if (!text) {
    throw new Error("OpenAI-compatible response is empty");
  }

  return text;
}

function buildOpenAICompatibleEndpoint(baseUrl) {
  const normalized = sanitizeOpenAICompatibleBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Base URL is empty");
  }

  return `${normalized}/chat/completions`;
}

function sanitizeOpenAICompatibleBaseUrl(baseUrl) {
  let normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  normalized = normalized.replace(/\/chat\/completions$/i, "");
  normalized = normalized.replace(/\/responses$/i, "");
  return normalized;
}

function ensureOpenAICompatibleError(reason) {
  const text = String(reason || "Unknown error");
  if (/^OpenAI-compatible API error:/i.test(text)) {
    return text;
  }
  return `OpenAI-compatible API error: ${text}`;
}

function buildVisionPrompt({ ignoreSimplifiedChinese = false } = {}) {
  const promptLines = [
    "You are a manga OCR + translation engine.",
    "Do OCR, translation, and speech bubble localization on this manga image.",
    "Translate all detected text into Simplified Chinese.",
    "For every text item, return the replacement box that should be erased and redrawn, not just the tight OCR glyph bounds.",
    "For speech bubbles, x/y/w/h should cover the whole usable inner bubble area including the original text, with a small margin.",
    "For narration boxes or floating sound-effect text, x/y/w/h should cover enough area to hide the original text completely.",
    "Prefer one box per visually connected bubble or caption. Do not split one speech bubble into multiple small boxes unless there are separate texts far apart.",
    "Ignore decorative symbols, musical notes, and standalone punctuation marks (e.g. ♪ ♫ ♩ ♬ ♭ ♯).",
    "Ignore meaningless alphabetic noise (e.g. random letters like 'aaa', 'hm', 'zzz', isolated short Latin fragments).",
    "Ignore model attachment labels such as [Image #1], [Image#1], or Image 1. They are not manga text and must never appear in original_text or translated_text.",
    "If a bubble contains only symbols (no meaningful text), do not include it in output.",
    "Return JSON only. No markdown, no explanation, no code fences.",
    "Output schema:",
    "{",
    '  "bubbles": [',
    "    {",
    '      "x": 0-100,',
    '      "y": 0-100,',
    '      "w": 0-100,',
    '      "h": 0-100,',
    '      "bg_type": "solid|transparent|none",',
    '      "original_text": "...",',
    '      "translated_text": "..."',
    "    }",
    "  ]",
    "}",
    "Coordinates should be percentages relative to the whole image, using top-left x/y and width/height.",
    "Coordinates must be large enough for the translated Chinese text to fit inside and must fully cover the original text.",
    "If there is no text, return exactly: {\"bubbles\":[]}",
    "bg_type must be one of: solid, transparent, none."
  ];

  if (ignoreSimplifiedChinese) {
    promptLines.push(
      "Important: Ignore already Simplified Chinese text. Do not include those bubbles in output."
    );
  }

  return promptLines.join("\n");
}

function parseModelJson(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("Model output is empty");
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Model output does not contain valid JSON object");
  }

  const jsonText = candidate.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function normalizeTranslationResult(payload, { ignoreSimplifiedChinese = false } = {}) {
  const rawBubbles = payload && Array.isArray(payload.bubbles) ? payload.bubbles : [];

  const normalized = rawBubbles.map((item) => {
    return {
      x: toNumber(item && item.x !== undefined ? item.x : item && item.left),
      y: toNumber(item && item.y !== undefined ? item.y : item && item.top),
      w: toNumber(item && item.w !== undefined ? item.w : item && item.width),
      h: toNumber(item && item.h !== undefined ? item.h : item && item.height),
      bg_type: normalizeBgType(item ? item.bg_type : "solid"),
      original_text: String(item && item.original_text ? item.original_text : "").trim(),
      translated_text: String(item && item.translated_text ? item.translated_text : "").trim()
    };
  });

  const looksLikeUnitCoordinate =
    normalized.length > 0 &&
    normalized.every((item) => {
      const values = [item.x, item.y, item.w, item.h];
      return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1.2);
    });

  const scale = looksLikeUnitCoordinate ? 100 : 1;

  const bubbles = normalized
    .map((item) => {
      const x = clamp(item.x * scale, 0, 100);
      const y = clamp(item.y * scale, 0, 100);
      const w = clamp(item.w * scale, 0, 100);
      const h = clamp(item.h * scale, 0, 100);
      const rawOriginalText = String(item.original_text || "").trim();
      const rawTranslatedText = String(item.translated_text || "").trim();
      const sourceWasImagePlaceholder = isModelImagePlaceholderOnly(rawOriginalText);
      const originalText = sourceWasImagePlaceholder ? "" : cleanDecorativeSymbols(rawOriginalText);
      const translatedText = sourceWasImagePlaceholder
        ? ""
        : cleanDecorativeSymbols(rawTranslatedText) || originalText;

      return {
        x,
        y,
        w,
        h,
        bg_type: item.bg_type,
        original_text: originalText,
        translated_text: translatedText
      };
    })
    .filter((item) => !shouldDropSymbolOnlyBubble(item))
    .filter((item) => !shouldDropMeaninglessAlphabeticBubble(item))
    .filter((item) => {
      if (!ignoreSimplifiedChinese) {
        return true;
      }
      return !isConfidentSimplifiedChinese(item.original_text);
    })
    .filter((item) => item.w > 0 && item.h > 0)
    .slice(0, MAX_BUBBLES);

  return { bubbles };
}

function normalizeBgType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "solid" || text === "transparent" || text === "none") {
    return text;
  }
  return "solid";
}

function cleanDecorativeSymbols(text) {
  if (!text) {
    return "";
  }

  return String(text)
    .replace(/[♪♫♩♬♭♯𝄞]/gu, "")
    .replace(MODEL_IMAGE_PLACEHOLDER_BRACKET_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(MODEL_IMAGE_PLACEHOLDER_ONLY_RE, "");
}

function isModelImagePlaceholderOnly(text) {
  const compact = String(text || "")
    .trim()
    .replace(MODEL_IMAGE_PLACEHOLDER_BRACKET_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return MODEL_IMAGE_PLACEHOLDER_ONLY_RE.test(compact);
}

function shouldDropSymbolOnlyBubble(item) {
  const original = String(item && item.original_text ? item.original_text : "").trim();
  const translated = String(item && item.translated_text ? item.translated_text : "").trim();

  if (!original && !translated) {
    return true;
  }

  if (isSymbolOnlyText(original) && isSymbolOnlyText(translated)) {
    return true;
  }

  return false;
}

function shouldDropMeaninglessAlphabeticBubble(item) {
  const original = String(item && item.original_text ? item.original_text : "").trim();
  const translated = String(item && item.translated_text ? item.translated_text : "").trim();

  if (!original) {
    return false;
  }

  const originalCompact = original.replace(/\s+/g, "");
  const translatedCompact = translated.replace(/\s+/g, "");

  if (!isLatinOnlyFragment(originalCompact)) {
    return false;
  }

  if (isMeaningfulLatinToken(originalCompact)) {
    return false;
  }

  const lowerOriginal = originalCompact.toLowerCase();
  const lowerTranslated = translatedCompact.toLowerCase();

  // Very short alphabetic fragments are usually OCR noise.
  if (lowerOriginal.length <= 2) {
    return true;
  }

  // Repeated same letter (aaa/zzz) tends to be decorative noise.
  if (/^(.)\1{2,}$/i.test(lowerOriginal)) {
    return true;
  }

  // Common meaningless filler tokens.
  if (/^(ah|oh|uh|hm|hmm|mm|ng|ha|haha|heh|eh|uhh|huh|zzz|lol|wow)$/i.test(lowerOriginal)) {
    return true;
  }

  // If model effectively kept the same Latin text, treat short fragments as noise.
  if (lowerTranslated === lowerOriginal && lowerOriginal.length <= 7) {
    return true;
  }

  // Consonant-heavy short tokens are likely OCR artifacts.
  if (lowerOriginal.length <= 6 && !/[aeiou]/i.test(lowerOriginal)) {
    return true;
  }

  return false;
}

function shouldDropLocalPaddleCandidateBubble(item, imageSize) {
  const text = String(item && item.original_text ? item.original_text : "").replace(/\s+/g, "");
  if (!text) {
    return true;
  }

  const box = getNormalizedCandidatePixelBox(item, imageSize);
  if (!box) {
    return true;
  }

  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const areaRatio = (box.width * box.height) / Math.max(1, imageWidth * imageHeight);
  const score = Number(item.confidence || 0);
  const scriptChars = countScriptChars(text);
  const hangulChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const digitChars = (text.match(/\d/g) || []).length;
  const compactText = text.replace(/[^\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]/g, "");
  const verySmall = areaRatio < 0.0045 || box.width < imageWidth * 0.065 || box.height < imageHeight * 0.018;

  if (/^\d+$/.test(text) && text.length <= 3) {
    return true;
  }

  if (digitChars >= 1 && compactText.length <= 2 && areaRatio < 0.01) {
    return true;
  }

  if (scriptChars <= 1 && areaRatio < 0.012) {
    return true;
  }

  if (scriptChars <= 2 && verySmall && score < 0.96) {
    return true;
  }

  if (hangulChars === 0 && cjkChars > 0 && text.length <= 4 && areaRatio < 0.02) {
    return true;
  }

  if (hangulChars === 0 && scriptChars <= 3 && score < 0.82) {
    return true;
  }

  return false;
}

function getNormalizedCandidatePixelBox(item, imageSize) {
  if (item && item.rawBox) {
    const left = Number(item.rawBox.left || 0);
    const top = Number(item.rawBox.top || 0);
    const width = Number(item.rawBox.width || 0);
    const height = Number(item.rawBox.height || 0);
    if (width > 0 && height > 0) {
      return buildBaiduBox(left, top, left + width, top + height);
    }
  }

  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const left = (Number(item && item.x) / 100) * imageWidth;
  const top = (Number(item && item.y) / 100) * imageHeight;
  const width = (Number(item && item.w) / 100) * imageWidth;
  const height = (Number(item && item.h) / 100) * imageHeight;
  if (!(width > 0 && height > 0)) {
    return null;
  }
  return buildBaiduBox(left, top, left + width, top + height);
}

function coalesceOverlappingOcrCandidates(candidates) {
  const groups = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item && getPercentBubbleBox(item))
    .map((item) => [item]);

  let changed = true;
  while (changed) {
    changed = false;
    for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
        if (!shouldCoalesceOcrCandidateGroups(groups[leftIndex], groups[rightIndex])) {
          continue;
        }
        groups[leftIndex].push(...groups[rightIndex]);
        groups.splice(rightIndex, 1);
        changed = true;
        rightIndex -= 1;
      }
    }
  }

  return groups
    .map((group, index) => mergeOcrCandidateGroup(group, index))
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .slice(0, MAX_BUBBLES);
}

function shouldCoalesceOcrCandidateGroups(leftGroup, rightGroup) {
  const left = getPercentBubbleGroupBox(leftGroup);
  const right = getPercentBubbleGroupBox(rightGroup);
  if (!left || !right) {
    return false;
  }
  const leftBgType = normalizeBgType(leftGroup[0] && leftGroup[0].bg_type);
  const rightBgType = normalizeBgType(rightGroup[0] && rightGroup[0].bg_type);
  if (leftBgType !== rightBgType) {
    return false;
  }

  const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const overlapArea = overlapWidth * overlapHeight;
  const overlapRatio = overlapArea / Math.max(0.1, Math.min(left.width * left.height, right.width * right.height));
  const horizontalOverlap = overlapWidth / Math.max(0.1, Math.min(left.width, right.width));
  const centerDistanceX = Math.abs(left.centerX - right.centerX);
  const unionWidth = Math.max(left.right, right.right) - Math.min(left.left, right.left);
  const unionHeight = Math.max(left.bottom, right.bottom) - Math.min(left.top, right.top);

  return (
    overlapRatio >= 0.22 &&
    horizontalOverlap >= 0.18 &&
    centerDistanceX <= Math.max(left.width, right.width) * 0.82 &&
    unionWidth <= 96 &&
    unionHeight <= 72
  );
}

function mergeOcrCandidateGroup(group, index) {
  const sorted = [...group].sort((left, right) => left.y - right.y || left.x - right.x);
  const box = getPercentBubbleGroupBox(sorted);
  const rawBoxes = sorted.map((item) => item.rawBox).filter(Boolean);
  const rawLeft = rawBoxes.length > 0 ? Math.min(...rawBoxes.map((box) => Number(box.left) || 0)) : 0;
  const rawTop = rawBoxes.length > 0 ? Math.min(...rawBoxes.map((box) => Number(box.top) || 0)) : 0;
  const rawRight = rawBoxes.length > 0
    ? Math.max(...rawBoxes.map((box) => (Number(box.left) || 0) + (Number(box.width) || 0)))
    : 0;
  const rawBottom = rawBoxes.length > 0
    ? Math.max(...rawBoxes.map((box) => (Number(box.top) || 0) + (Number(box.height) || 0)))
    : 0;

  return {
    ...sorted[0],
    id: `t${index}`,
    x: clamp(box.left, 0, 100),
    y: clamp(box.top, 0, 100),
    w: clamp(box.width, 0.1, 100),
    h: clamp(box.height, 0.1, 100),
    original_text: sorted.map((item) => String(item.original_text || "").trim()).filter(Boolean).join("\n"),
    translated_text: "",
    bg_type: normalizeBgType(sorted[0] && sorted[0].bg_type),
    confidence: Math.max(...sorted.map((item) => Number(item.confidence || 0))),
    ...(rawBoxes.length > 0
      ? { rawBox: { left: rawLeft, top: rawTop, width: rawRight - rawLeft, height: rawBottom - rawTop } }
      : {})
  };
}

function collapseDuplicateLocalPaddleTranslations(bubbles) {
  if (!Array.isArray(bubbles) || bubbles.length <= 1) {
    return Array.isArray(bubbles) ? bubbles : [];
  }

  const result = [];
  const used = new Set();
  const sorted = bubbles
    .map((bubble, index) => ({ bubble, index }))
    .sort((left, right) => Number(left.bubble.y || 0) - Number(right.bubble.y || 0));

  for (let i = 0; i < sorted.length; i += 1) {
    if (used.has(sorted[i].index)) {
      continue;
    }

    const group = [sorted[i].bubble];
    used.add(sorted[i].index);
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (used.has(sorted[j].index)) {
        continue;
      }
      if (shouldCollapseDuplicateTranslationGroup(group, sorted[j].bubble)) {
        group.push(sorted[j].bubble);
        used.add(sorted[j].index);
      }
    }

    result.push(group.length > 1 ? mergeDuplicateTranslationBubbles(group) : group[0]);
  }

  return result.sort((left, right) => Number(left.y || 0) - Number(right.y || 0) || Number(left.x || 0) - Number(right.x || 0));
}

function shouldCollapseDuplicateTranslationGroup(group, bubble) {
  const baseText = normalizeDuplicateTranslationText(group[0] && group[0].translated_text);
  const nextText = normalizeDuplicateTranslationText(bubble && bubble.translated_text);
  if (!baseText || baseText.length < 8 || baseText !== nextText) {
    return false;
  }

  const groupBox = getPercentBubbleGroupBox(group);
  const nextBox = getPercentBubbleBox(bubble);
  if (!groupBox || !nextBox) {
    return false;
  }

  const verticalGap = getPercentBoxGapY(groupBox, nextBox);
  const overlapX = Math.min(groupBox.right, nextBox.right) - Math.max(groupBox.left, nextBox.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, nextBox.width)) : 0;
  const centerDistance = Math.abs(groupBox.centerX - nextBox.centerX);
  const unionWidth = Math.max(groupBox.right, nextBox.right) - Math.min(groupBox.left, nextBox.left);
  const avgHeight = Math.max(1, (groupBox.height + nextBox.height) / 2);

  return verticalGap <= avgHeight * 2.4 && unionWidth <= 86 && (overlapRatio >= 0.12 || centerDistance <= 26);
}

function mergeDuplicateTranslationBubbles(group) {
  const box = getPercentBubbleGroupBox(group);
  const first = group[0];
  return {
    ...first,
    x: clamp(box.left, 0, 100),
    y: clamp(box.top, 0, 100),
    w: clamp(box.width, 0.1, 100),
    h: clamp(box.height, 0.1, 100),
    original_text: group.map((bubble) => String(bubble.original_text || "").trim()).filter(Boolean).join(" "),
    translated_text: first.translated_text
  };
}

function normalizeDuplicateTranslationText(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[，。！？!?.,;；:："'“”‘’()\[\]（）【】]/g, "")
    .trim();
}

function getPercentBubbleGroupBox(group) {
  const boxes = group.map((bubble) => getPercentBubbleBox(bubble)).filter(Boolean);
  if (boxes.length === 0) {
    return null;
  }
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  return buildPercentBox(left, top, right, bottom);
}

function getPercentBubbleBox(bubble) {
  const left = Number(bubble && bubble.x);
  const top = Number(bubble && bubble.y);
  const width = Number(bubble && bubble.w);
  const height = Number(bubble && bubble.h);
  if (!(Number.isFinite(left) && Number.isFinite(top) && width > 0 && height > 0)) {
    return null;
  }
  return buildPercentBox(left, top, left + width, top + height);
}

function buildPercentBox(left, top, right, bottom) {
  const width = Math.max(0.1, right - left);
  const height = Math.max(0.1, bottom - top);
  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2
  };
}

function getPercentBoxGapY(left, right) {
  if (left.top > right.bottom) {
    return left.top - right.bottom;
  }
  if (right.top > left.bottom) {
    return right.top - left.bottom;
  }
  return 0;
}

function isLatinOnlyFragment(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return false;
  }
  return /^[A-Za-z'`-]+$/.test(raw);
}

function isMeaningfulLatinToken(text) {
  const token = String(text || "").trim().toUpperCase();
  if (!token) {
    return false;
  }

  const whitelist = new Set([
    "AI",
    "DNA",
    "RNA",
    "CPU",
    "GPU",
    "USB",
    "PC",
    "TV",
    "OK",
    "NO",
    "YES"
  ]);

  return whitelist.has(token);
}

function isSymbolOnlyText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }

  // Keep bubbles that contain meaningful scripts/numbers.
  if (/[0-9A-Za-z]/.test(raw)) {
    return false;
  }
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) {
    return false;
  }

  return /^[\p{P}\p{S}\s]+$/u.test(raw);
}

function isConfidentSimplifiedChinese(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return false;
  }

  // Keep Japanese/Korean text to avoid false filtering.
  if (/[\u3040-\u30ff]/.test(raw) || /[\uac00-\ud7af]/.test(raw)) {
    return false;
  }

  const hanChars = raw.match(/[\u4e00-\u9fff]/g) || [];
  if (hanChars.length === 0) {
    return false;
  }

  const hanRatio = hanChars.length / Math.max(raw.length, 1);
  if (hanRatio < 0.45) {
    return false;
  }

  const simplifiedSignal =
    /[这为来会与后发学实点话说们]|(我们|你们|他们|这个|那个|因为|所以|已经|没有|时候|什么)/.test(
      raw
    );
  if (!simplifiedSignal) {
    return false;
  }

  const traditionalSignal = /[這為來會與後發學實點話說們]/.test(raw);
  return !traditionalSignal;
}

function extractOpenAIMessageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item.text === "string") {
          return item.text;
        }

        return "";
      })
      .join("\n");
  }

  return "";
}

function shouldRetryWithJpeg(reason) {
  const text = String(reason || "").toLowerCase();
  return /image format is not supported|unsupported image format|invalid image|invalid image_url/.test(
    text
  );
}

function shouldRetryWithoutJsonResponseFormat(reason) {
  const text = String(reason || "").toLowerCase();
  return /response_format|unknown field|unsupported field/.test(text);
}

function toProviderError(payload, status, statusText, defaultMessage) {
  const messageFromPayload =
    (payload && payload.error && payload.error.message) ||
    (payload && payload.message) ||
    `${status} ${statusText}`;

  const error = new Error(`${defaultMessage}: ${messageFromPayload}`);
  error.status = status;
  error.payload = payload;
  return error;
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }

  return String(error);
}

async function handleGetCacheStats() {
  try {
    const store = await storageGet(null);
    const cacheKeys = Object.keys(store).filter((key) => key.startsWith(CACHE_PREFIX));

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
      if (!timestamp || Date.now() - timestamp > CACHE_TTL_MS) {
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
      error: `Read cache stats failed: ${getErrorMessage(error)}`
    };
  }
}

async function handleClearCache() {
  try {
    const store = await storageGet(null);
    const cacheKeys = Object.keys(store).filter((key) => key.startsWith(CACHE_PREFIX));
    if (cacheKeys.length > 0) {
      await storageRemove(cacheKeys);
    }

    return {
      ok: true,
      removed: cacheKeys.length
    };
  } catch (error) {
    return {
      ok: false,
      error: `Clear cache failed: ${getErrorMessage(error)}`
    };
  }
}

async function handleReportStatus(message, sender) {
  const tabIdRaw = message.tabId !== undefined ? message.tabId : sender && sender.tab ? sender.tab.id : null;
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, error: "Valid tab id is required" };
  }

  const status = {
    timestamp: Date.now(),
    level: String(message.level || "info"),
    message: String(message.message || ""),
    details: message.details && typeof message.details === "object" ? message.details : {},
    pageUrl: String(message.pageUrl || (sender && sender.url ? sender.url : ""))
  };

  await storageSet({ [buildTabStatusKey(tabId)]: status });
  return { ok: true };
}

async function handleGetTabStatus(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: true, status: null };
  }

  const key = buildTabStatusKey(tabId);
  const store = await storageGet([key]);
  const status = store[key];

  if (!status || typeof status !== "object") {
    return { ok: true, status: null };
  }

  if (Date.now() - Number(status.timestamp || 0) > TAB_STATUS_TTL_MS) {
    await storageRemove([key]);
    return { ok: true, status: null };
  }

  return { ok: true, status };
}

async function saveTabStatus(tabIdRaw, status) {
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  await storageSet({
    [buildTabStatusKey(tabId)]: {
      timestamp: Date.now(),
      level: status.level || "info",
      message: status.message || "",
      details: status.details || {},
      pageUrl: status.pageUrl || ""
    }
  });
}

async function pruneExpiredTabStatuses() {
  const store = await storageGet(null);
  const now = Date.now();
  const staleKeys = [];

  for (const key of Object.keys(store)) {
    if (!key.startsWith(TAB_STATUS_PREFIX)) {
      continue;
    }

    const item = store[key];
    const timestamp = Number(item && item.timestamp ? item.timestamp : 0);
    if (!timestamp || now - timestamp > TAB_STATUS_TTL_MS) {
      staleKeys.push(key);
    }
  }

  if (staleKeys.length > 0) {
    await storageRemove(staleKeys);
  }
}

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
  imageUrl,
  targetKey,
  dataUrl
}) {
  const source = [
    provider,
    model,
    baseUrl || "",
    captureMode || "",
    localOcrBaseUrl || "",
    localOcrLang || "",
    localOcrMode || "",
    localOcrDetThresh || "",
    localOcrDetBoxThresh || "",
    localOcrDetUnclipRatio || "",
    localOcrDebug ? "debug" : "",
    ocrConfidenceThreshold || "",
    ocrMinBoxArea || "",
    ocrMaxBoxArea || "",
    ocrMinBoxWidth || "",
    ocrMinBoxHeight || "",
    ocrMaxAspectRatio || "",
    ocrMergeLineGap || "",
    overwriteFontScale || "",
    overwriteCoverPadding || "",
    debugOverlayMode || "",
    overwritePreviewMode || "",
    visionOcrEnabled ? "vision-ocr" : "",
    visionOcrBaseUrl || "",
    visionOcrModel || "",
    imageUrl || "",
    targetKey || "",
    dataUrl.slice(0, 220),
    String(dataUrl.length)
  ].join("|");

  return `${CACHE_PREFIX}${hashString(source)}`;
}

async function getCache(cacheKey) {
  const store = await storageGet([cacheKey]);
  const entry = store[cacheKey];
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const timestamp = Number(entry.timestamp || 0);
  if (!timestamp || Date.now() - timestamp > CACHE_TTL_MS) {
    await storageRemove([cacheKey]);
    return null;
  }

  return entry.value || null;
}

async function setCache(cacheKey, value) {
  await storageSet({
    [cacheKey]: {
      timestamp: Date.now(),
      value
    }
  });
}

async function ensureDefaultSettings() {
  const stored = await storageGet([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.model,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.baseUrl,
    STORAGE_KEYS.baiduApiKey,
    STORAGE_KEYS.baiduSecretKey,
    STORAGE_KEYS.localOcrBaseUrl,
    STORAGE_KEYS.localOcrLang,
    STORAGE_KEYS.localOcrMode,
    STORAGE_KEYS.localOcrDetThresh,
    STORAGE_KEYS.localOcrDetBoxThresh,
    STORAGE_KEYS.localOcrDetUnclipRatio,
    STORAGE_KEYS.localOcrDebug,
    STORAGE_KEYS.ocrConfidenceThreshold,
    STORAGE_KEYS.ocrMinBoxArea,
    STORAGE_KEYS.ocrMaxBoxArea,
    STORAGE_KEYS.ocrMinBoxWidth,
    STORAGE_KEYS.ocrMinBoxHeight,
    STORAGE_KEYS.ocrMaxAspectRatio,
    STORAGE_KEYS.ocrMergeLineGap,
    STORAGE_KEYS.overwriteFontScale,
    STORAGE_KEYS.overwriteCoverPadding,
    STORAGE_KEYS.debugOverlayMode,
    STORAGE_KEYS.overwritePreviewMode,
    STORAGE_KEYS.visionOcrApiKey,
    STORAGE_KEYS.visionOcrBaseUrl,
    STORAGE_KEYS.visionOcrModel,
    STORAGE_KEYS.visionOcrEnabled,
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.showBall,
    STORAGE_KEYS.captureMode,
    STORAGE_KEYS.renderMode,
    STORAGE_KEYS.pretranslateMode,
    STORAGE_KEYS.ignoreSimplifiedChinese
  ]);

  const patch = {};

  if (typeof stored[STORAGE_KEYS.provider] !== "string") {
    patch[STORAGE_KEYS.provider] = DEFAULT_SETTINGS.provider;
  }
  if (typeof stored[STORAGE_KEYS.model] !== "string") {
    patch[STORAGE_KEYS.model] = DEFAULT_SETTINGS.model;
  }
  if (typeof stored[STORAGE_KEYS.apiKey] !== "string") {
    patch[STORAGE_KEYS.apiKey] = DEFAULT_SETTINGS.apiKey;
  }
  if (typeof stored[STORAGE_KEYS.baseUrl] !== "string") {
    patch[STORAGE_KEYS.baseUrl] = DEFAULT_SETTINGS.baseUrl;
  }
  if (typeof stored[STORAGE_KEYS.baiduApiKey] !== "string") {
    patch[STORAGE_KEYS.baiduApiKey] = DEFAULT_SETTINGS.baiduApiKey;
  }
  if (typeof stored[STORAGE_KEYS.baiduSecretKey] !== "string") {
    patch[STORAGE_KEYS.baiduSecretKey] = DEFAULT_SETTINGS.baiduSecretKey;
  }
  if (typeof stored[STORAGE_KEYS.localOcrBaseUrl] !== "string") {
    patch[STORAGE_KEYS.localOcrBaseUrl] = DEFAULT_SETTINGS.localOcrBaseUrl;
  }
  if (typeof stored[STORAGE_KEYS.localOcrLang] !== "string") {
    patch[STORAGE_KEYS.localOcrLang] = DEFAULT_SETTINGS.localOcrLang;
  }
  patch[STORAGE_KEYS.localOcrMode] = DEFAULT_SETTINGS.localOcrMode;
  patch[STORAGE_KEYS.localOcrDetThresh] = DEFAULT_SETTINGS.localOcrDetThresh;
  patch[STORAGE_KEYS.localOcrDetBoxThresh] = DEFAULT_SETTINGS.localOcrDetBoxThresh;
  patch[STORAGE_KEYS.localOcrDetUnclipRatio] = DEFAULT_SETTINGS.localOcrDetUnclipRatio;
  if (typeof stored[STORAGE_KEYS.localOcrDebug] !== "boolean") {
    patch[STORAGE_KEYS.localOcrDebug] = DEFAULT_SETTINGS.localOcrDebug;
  }
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrConfidenceThreshold, DEFAULT_SETTINGS.ocrConfidenceThreshold);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrMinBoxArea, DEFAULT_SETTINGS.ocrMinBoxArea);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrMaxBoxArea, DEFAULT_SETTINGS.ocrMaxBoxArea);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrMinBoxWidth, DEFAULT_SETTINGS.ocrMinBoxWidth);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrMinBoxHeight, DEFAULT_SETTINGS.ocrMinBoxHeight);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrMaxAspectRatio, DEFAULT_SETTINGS.ocrMaxAspectRatio);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.ocrMergeLineGap, DEFAULT_SETTINGS.ocrMergeLineGap);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.overwriteFontScale, DEFAULT_SETTINGS.overwriteFontScale);
  ensureNumberSettingPatch(stored, patch, STORAGE_KEYS.overwriteCoverPadding, DEFAULT_SETTINGS.overwriteCoverPadding);
  if (!DEBUG_OVERLAY_MODES.has(String(stored[STORAGE_KEYS.debugOverlayMode] || ""))) {
    patch[STORAGE_KEYS.debugOverlayMode] = DEFAULT_SETTINGS.debugOverlayMode;
  }
  if (!OVERWRITE_PREVIEW_MODES.has(String(stored[STORAGE_KEYS.overwritePreviewMode] || ""))) {
    patch[STORAGE_KEYS.overwritePreviewMode] = DEFAULT_SETTINGS.overwritePreviewMode;
  }
  if (typeof stored[STORAGE_KEYS.visionOcrApiKey] !== "string") {
    patch[STORAGE_KEYS.visionOcrApiKey] = DEFAULT_SETTINGS.visionOcrApiKey;
  }
  if (typeof stored[STORAGE_KEYS.visionOcrBaseUrl] !== "string") {
    patch[STORAGE_KEYS.visionOcrBaseUrl] = DEFAULT_SETTINGS.visionOcrBaseUrl;
  }
  if (typeof stored[STORAGE_KEYS.visionOcrModel] !== "string") {
    patch[STORAGE_KEYS.visionOcrModel] = DEFAULT_SETTINGS.visionOcrModel;
  }
  if (typeof stored[STORAGE_KEYS.visionOcrEnabled] !== "boolean") {
    patch[STORAGE_KEYS.visionOcrEnabled] = DEFAULT_SETTINGS.visionOcrEnabled;
  }
  if (typeof stored[STORAGE_KEYS.enabled] !== "boolean") {
    patch[STORAGE_KEYS.enabled] = DEFAULT_SETTINGS.enabled;
  }
  if (typeof stored[STORAGE_KEYS.showBall] !== "boolean") {
    patch[STORAGE_KEYS.showBall] = DEFAULT_SETTINGS.showBall;
  }
  if (typeof stored[STORAGE_KEYS.captureMode] !== "string") {
    patch[STORAGE_KEYS.captureMode] = DEFAULT_SETTINGS.captureMode;
  }
  if (typeof stored[STORAGE_KEYS.renderMode] !== "string") {
    patch[STORAGE_KEYS.renderMode] = DEFAULT_SETTINGS.renderMode;
  }
  if (typeof stored[STORAGE_KEYS.pretranslateMode] !== "string") {
    patch[STORAGE_KEYS.pretranslateMode] = DEFAULT_SETTINGS.pretranslateMode;
  }
  if (typeof stored[STORAGE_KEYS.ignoreSimplifiedChinese] !== "boolean") {
    patch[STORAGE_KEYS.ignoreSimplifiedChinese] = DEFAULT_SETTINGS.ignoreSimplifiedChinese;
  }

  if (Object.keys(patch).length > 0) {
    await storageSet(patch);
  }
}

function ensureNumberSettingPatch(stored, patch, key, fallback) {
  if (!Number.isFinite(Number(stored[key]))) {
    patch[key] = fallback;
  }
}

async function loadSettings() {
  const raw = await storageGet([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.model,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.baseUrl,
    STORAGE_KEYS.baiduApiKey,
    STORAGE_KEYS.baiduSecretKey,
    STORAGE_KEYS.localOcrBaseUrl,
    STORAGE_KEYS.localOcrLang,
    STORAGE_KEYS.localOcrMode,
    STORAGE_KEYS.localOcrDetThresh,
    STORAGE_KEYS.localOcrDetBoxThresh,
    STORAGE_KEYS.localOcrDetUnclipRatio,
    STORAGE_KEYS.localOcrDebug,
    STORAGE_KEYS.ocrConfidenceThreshold,
    STORAGE_KEYS.ocrMinBoxArea,
    STORAGE_KEYS.ocrMaxBoxArea,
    STORAGE_KEYS.ocrMinBoxWidth,
    STORAGE_KEYS.ocrMinBoxHeight,
    STORAGE_KEYS.ocrMaxAspectRatio,
    STORAGE_KEYS.ocrMergeLineGap,
    STORAGE_KEYS.overwriteFontScale,
    STORAGE_KEYS.overwriteCoverPadding,
    STORAGE_KEYS.debugOverlayMode,
    STORAGE_KEYS.overwritePreviewMode,
    STORAGE_KEYS.visionOcrApiKey,
    STORAGE_KEYS.visionOcrBaseUrl,
    STORAGE_KEYS.visionOcrModel,
    STORAGE_KEYS.visionOcrEnabled,
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.showBall,
    STORAGE_KEYS.captureMode,
    STORAGE_KEYS.renderMode,
    STORAGE_KEYS.pretranslateMode,
    STORAGE_KEYS.ignoreSimplifiedChinese
  ]);

  const provider = normalizeProvider(raw[STORAGE_KEYS.provider]);
  const modelRaw = String(raw[STORAGE_KEYS.model] || "").trim();
  const model = modelRaw || DEFAULT_MODELS[provider];

  return {
    provider,
    model,
    apiKey: String(raw[STORAGE_KEYS.apiKey] || "").trim(),
    baseUrl: String(raw[STORAGE_KEYS.baseUrl] || "").trim(),
    baiduApiKey: String(raw[STORAGE_KEYS.baiduApiKey] || "").trim(),
    baiduSecretKey: String(raw[STORAGE_KEYS.baiduSecretKey] || "").trim(),
    localOcrBaseUrl: sanitizeLocalOcrBaseUrl(raw[STORAGE_KEYS.localOcrBaseUrl] || DEFAULT_LOCAL_OCR_BASE_URL),
    localOcrLang: normalizeLocalOcrLang(raw[STORAGE_KEYS.localOcrLang]),
    localOcrMode: normalizeLocalOcrMode(raw[STORAGE_KEYS.localOcrMode]),
    localOcrDetThresh: clampNumber(raw[STORAGE_KEYS.localOcrDetThresh], 0.01, 0.99, DEFAULT_LOCAL_OCR_DET_THRESH),
    localOcrDetBoxThresh: clampNumber(raw[STORAGE_KEYS.localOcrDetBoxThresh], 0.01, 0.99, DEFAULT_LOCAL_OCR_DET_BOX_THRESH),
    localOcrDetUnclipRatio: clampNumber(raw[STORAGE_KEYS.localOcrDetUnclipRatio], 1, 5, DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO),
    localOcrDebug: raw[STORAGE_KEYS.localOcrDebug] === true,
    ocrConfidenceThreshold: clampNumber(raw[STORAGE_KEYS.ocrConfidenceThreshold], 0, 1, DEFAULT_SETTINGS.ocrConfidenceThreshold),
    ocrMinBoxArea: clampNumber(raw[STORAGE_KEYS.ocrMinBoxArea], 0, 1000000, DEFAULT_SETTINGS.ocrMinBoxArea),
    ocrMaxBoxArea: clampNumber(raw[STORAGE_KEYS.ocrMaxBoxArea], 0.001, 1, DEFAULT_SETTINGS.ocrMaxBoxArea),
    ocrMinBoxWidth: clampNumber(raw[STORAGE_KEYS.ocrMinBoxWidth], 0, 10000, DEFAULT_SETTINGS.ocrMinBoxWidth),
    ocrMinBoxHeight: clampNumber(raw[STORAGE_KEYS.ocrMinBoxHeight], 0, 10000, DEFAULT_SETTINGS.ocrMinBoxHeight),
    ocrMaxAspectRatio: clampNumber(raw[STORAGE_KEYS.ocrMaxAspectRatio], 1, 100, DEFAULT_SETTINGS.ocrMaxAspectRatio),
    ocrMergeLineGap: clampNumber(raw[STORAGE_KEYS.ocrMergeLineGap], 0.2, 8, DEFAULT_SETTINGS.ocrMergeLineGap),
    overwriteFontScale: clampNumber(raw[STORAGE_KEYS.overwriteFontScale], 0.5, 2.5, DEFAULT_SETTINGS.overwriteFontScale),
    overwriteCoverPadding: clampNumber(raw[STORAGE_KEYS.overwriteCoverPadding], 0, 1.2, DEFAULT_SETTINGS.overwriteCoverPadding),
    debugOverlayMode: normalizeDebugOverlayMode(raw[STORAGE_KEYS.debugOverlayMode]),
    overwritePreviewMode: normalizeOverwritePreviewMode(raw[STORAGE_KEYS.overwritePreviewMode]),
    visionOcrApiKey: String(raw[STORAGE_KEYS.visionOcrApiKey] || "").trim(),
    visionOcrBaseUrl: sanitizeOpenAICompatibleBaseUrl(
      raw[STORAGE_KEYS.visionOcrBaseUrl] || DEFAULT_QWEN_BASE_URL
    ),
    visionOcrModel: String(raw[STORAGE_KEYS.visionOcrModel] || DEFAULT_VISION_OCR_MODEL).trim(),
    visionOcrEnabled: raw[STORAGE_KEYS.visionOcrEnabled] === true,
    enabled: raw[STORAGE_KEYS.enabled] !== false,
    showBall: raw[STORAGE_KEYS.showBall] !== false,
    captureMode: normalizeCaptureMode(raw[STORAGE_KEYS.captureMode]),
    renderMode: normalizeRenderMode(raw[STORAGE_KEYS.renderMode]),
    pretranslateMode: String(raw[STORAGE_KEYS.pretranslateMode] || "").toLowerCase() === "ahead" ? "ahead" : "manual",
    ignoreSimplifiedChinese: raw[STORAGE_KEYS.ignoreSimplifiedChinese] === true
  };
}

function normalizeProvider(provider) {
  const text = String(provider || "").trim().toLowerCase();
  if (
    text === PROVIDERS.anthropic ||
    text === PROVIDERS.openaiCompatible ||
    text === PROVIDERS.baiduDeepSeek ||
    text === PROVIDERS.localPaddleDeepSeek
  ) {
    return text;
  }
  return PROVIDERS.anthropic;
}

function sanitizeLocalOcrBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    return DEFAULT_LOCAL_OCR_BASE_URL;
  }
  return /^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`;
}

function normalizeLocalOcrLang(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "japan" || text === "korean") {
    return text;
  }
  return DEFAULT_LOCAL_OCR_LANG;
}

function normalizeLocalOcrMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "fast" ? "fast" : DEFAULT_LOCAL_OCR_MODE;
}

function normalizeLocalOcrNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRenderMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "embedded" ? "embedded" : "overlay";
}

function normalizeCaptureMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "screenshot" ? "screenshot" : "direct";
}

function buildTabStatusKey(tabId) {
  return `${TAB_STATUS_PREFIX}${tabId}`;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  const safe = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, safe));
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function isDataUrl(value) {
  return /^data:[^;]+;base64,/i.test(String(value || ""));
}

function getDataUrlMimeType(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,/i);
  return match ? String(match[1]).toLowerCase() : "";
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error("Invalid data URL format");
  }

  return {
    mediaType: String(match[1]).toLowerCase(),
    base64Data: match[2]
  };
}

async function blobToPreferredDataUrl(blob) {
  const type = String(blob && blob.type ? blob.type : "").toLowerCase();
  if (type === "image/jpeg" && blob.size > 0 && blob.size <= FAST_PATH_MAX_JPEG_BYTES) {
    return blobToDataUrl(blob);
  }

  const jpegBlob = await transcodeBlob(blob, "image/jpeg", IMAGE_JPEG_QUALITY);
  if (jpegBlob) {
    return blobToDataUrl(jpegBlob);
  }

  const pngBlob = await transcodeBlob(blob, "image/png", 0.92);
  if (pngBlob) {
    return blobToDataUrl(pngBlob);
  }

  return blobToDataUrl(blob);
}

async function transcodeDataUrlToJpeg(dataUrl) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const jpegBlob = await transcodeBlob(blob, "image/jpeg", IMAGE_JPEG_QUALITY);
    if (!jpegBlob) {
      return "";
    }
    return blobToDataUrl(jpegBlob);
  } catch {
    return "";
  }
}

async function transcodeBlob(blob, targetMime, quality) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return null;
  }

  try {
    const bitmap = await createImageBitmap(blob);

    try {
      const maxSide = IMAGE_MAX_SIDE;
      const longestSide = Math.max(bitmap.width, bitmap.height);
      let targetWidth = bitmap.width;
      let targetHeight = bitmap.height;

      if (longestSide > maxSide) {
        const scale = maxSide / longestSide;
        targetWidth = Math.max(1, Math.round(bitmap.width * scale));
        targetHeight = Math.max(1, Math.round(bitmap.height * scale));
      }

      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return null;
      }

      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      const options = { type: targetMime };
      if (typeof quality === "number") {
        options.quality = quality;
      }

      const converted = await canvas.convertToBlob(options);
      return converted || null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Blob to data URL failed"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function safeJson(response) {
  return response.json().catch(() => null);
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result || {});
      }
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

async function reinjectContentScriptsToOpenTabs() {
  const tabs = await queryAllTabs();
  const tasks = tabs
    .filter((tab) => isInjectableTab(tab))
    .map(async (tab) => {
      const tabId = Number(tab && tab.id);
      if (!Number.isInteger(tabId) || tabId < 0) {
        return;
      }

      try {
        await safeInsertCss(tabId, "styles.css");
        await safeExecuteScript(tabId, "content.js");
      } catch {
        // Ignore per-tab injection errors.
      }
    });

  await Promise.all(tasks);
}

function isInjectableTab(tab) {
  const url = String((tab && tab.url) || "");
  if (!url) {
    return false;
  }
  return /^(https?:|file:|ftp:)/i.test(url);
}

function queryAllTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function safeExecuteScript(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files: [file]
      },
      () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "executeScript failed";
          if (isSafeInjectError(message)) {
            resolve();
            return;
          }
          reject(new Error(message));
          return;
        }
        resolve();
      }
    );
  });
}

function safeInsertCss(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.insertCSS(
      {
        target: { tabId, allFrames: true },
        files: [file]
      },
      () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "insertCSS failed";
          if (isSafeInjectError(message)) {
            resolve();
            return;
          }
          reject(new Error(message));
          return;
        }
        resolve();
      }
    );
  });
}

function isSafeInjectError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("cannot access contents of") ||
    text.includes("the extensions gallery cannot be scripted") ||
    text.includes("missing host permission")
  );
}
