if (typeof importScripts === "function") {
  importScripts("glossary-core.js", "term-discovery-core.js");
}

const glossaryCore = globalThis.MangaGlossary;
const termDiscoveryCore = globalThis.MangaTermDiscovery;

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
  ignoreSimplifiedChinese: "mt_ignore_simplified_zh",
  glossary: glossaryCore.STORAGE_KEY,
  glossaryPending: termDiscoveryCore.PENDING_STORAGE_KEY,
  glossaryIgnored: termDiscoveryCore.IGNORED_STORAGE_KEY,
  termDiscoveryEnabled: termDiscoveryCore.ENABLED_STORAGE_KEY
};

const DEFAULT_SETTINGS = {
  provider: "baidu_deepseek",
  model: "deepseek-chat",
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
  ignoreSimplifiedChinese: false,
  termDiscoveryEnabled: true
};

const PROVIDERS = {
  baiduDeepSeek: "baidu_deepseek",
  localPaddleDeepSeek: "local_paddle_deepseek"
};

const DEFAULT_MODELS = {
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

const CACHE_PREFIX = "mt_cache_v21:";
const OCR_CACHE_PREFIX = "mt_cache_v22:ocr:";
const CANONICAL_TRANSLATION_CACHE_PREFIX = "mt_cache_v22:translation:";
const OCR_COORDINATE_MODEL_VERSION = "page-percent-v1";
const CANONICAL_TRANSLATION_PROMPT_VERSION = "canonical-zh-cn-v1";
const TRANSLATION_CACHE_KEY_RE = /^mt_cache_v\d+:/;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TAB_STATUS_PREFIX = "mt_tab_status_v1:";
const TAB_STATUS_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BUBBLES = 400;
const IMAGE_MAX_SIDE = 1536;
const IMAGE_JPEG_QUALITY = 0.82;
const FAST_PATH_MAX_JPEG_BYTES = 1900000;
const BLOB_TO_DATA_URL_TIMEOUT_MS = 8000;
const VISIBLE_TAB_CAPTURE_CACHE_MS = 700;
const BAIDU_OCR_MIN_REQUEST_GAP_MS = 1200;
const BAIDU_OCR_QPS_RETRY_DELAYS_MS = [1200, 2400, 4800];
const BAIDU_MERGE_MAX_GAP_RATIO = 1.35;
const BAIDU_MERGE_MAX_INDENT_RATIO = 2.4;
const BAIDU_MERGE_MAX_WIDTH_RATIO = 0.68;
const LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE = 760;
const LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO = 2.25;
const LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO = 1.65;
const TERM_EXTRACTOR_TIMEOUT_MS = 8000;
const TERM_EXTRACTOR_COOLDOWN_MS = 5 * 60 * 1000;
const TERM_EXTRACTOR_HEALTH_CACHE_MS = 30 * 1000;
const MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = /[\[\(（【<［]\s*image\s*#?\s*\d+\s*[\]\)）】>］]/giu;
const MODEL_IMAGE_PLACEHOLDER_ONLY_RE = /^image\s*#?\s*\d+$/iu;
const inflightTranslateByCacheKey = new Map();
const inflightOcrByCacheKey = new Map();
const inflightTranslationByFingerprint = new Map();
let backgroundTestHooks = null;
const ocrLinesBySourceImageId = new Map();
const visibleTabCaptureCacheByWindow = new Map();
let baiduAccessTokenCache = null;
let baiduOcrQueue = Promise.resolve();
let baiduLastOcrRequestAt = 0;
let termDiscoveryMutationQueue = Promise.resolve();
let termExtractorRuntime = {
  state: "unknown",
  error: "",
  checkedAt: 0,
  cooldownUntil: 0
};

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
    case "OCR_DATA_URL":
      return handleOcrDataUrl(message);
    case "TRANSLATE_TEXT_BLOCKS":
      return handleTranslateTextBlocks(message);
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
    case "DISCOVER_TERMS":
      return handleDiscoverTerms(message);
    case "GET_TERM_DISCOVERY_STATUS":
      return handleGetTermDiscoveryStatus(message);
    case "GET_TERM_DISCOVERY_STATE":
      return handleGetTermDiscoveryState(message);
    case "SET_TERM_DISCOVERY_ENABLED":
      return handleSetTermDiscoveryEnabled(message);
    case "CONFIRM_TERM_CANDIDATES":
      return handleConfirmTermCandidates(message);
    case "IGNORE_TERM_CANDIDATE":
      return handleIgnoreTermCandidate(message);
    case "RESTORE_IGNORED_TERM":
      return handleRestoreIgnoredTerm(message);
    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

async function handleDiscoverTerms(message) {
  return enqueueTermDiscoveryMutation(async () => {
    const stored = await storageGet([
      STORAGE_KEYS.termDiscoveryEnabled,
      STORAGE_KEYS.glossaryPending,
      STORAGE_KEYS.glossaryIgnored,
      STORAGE_KEYS.glossary,
      STORAGE_KEYS.localOcrBaseUrl
    ]);
    if (stored[STORAGE_KEYS.termDiscoveryEnabled] === false) {
      return { ok: true, skipped: true, reason: "disabled" };
    }

    const pageUrl = String(message.pageUrl || "").trim();
    const targetKey = String(message.targetKey || "").trim();
    const pending = termDiscoveryCore.normalizePendingStore(stored[STORAGE_KEYS.glossaryPending]);
    const blocks = termDiscoveryCore.getUnprocessedBlocks(pending, pageUrl, message.blocks, targetKey);
    if (blocks.length === 0) {
      return { ok: true, skipped: true, reason: "already_processed" };
    }
    if (isTermExtractorCoolingDown()) {
      return { ok: true, skipped: true, reason: "cooldown", status: getTermExtractorStatusSnapshot() };
    }

    const baseUrl = sanitizeLocalOcrBaseUrl(
      stored[STORAGE_KEYS.localOcrBaseUrl] || DEFAULT_LOCAL_OCR_BASE_URL
    );
    try {
      const payload = await requestTermExtractorJson(`${baseUrl}/terms/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "balanced",
          blocks: blocks.map((block) => ({ id: block.id, text: block.originalText })),
          user_terms: [
            ...glossaryCore.normalizeGlossary(stored[STORAGE_KEYS.glossary]).entries
              .map((entry) => entry.source),
            ...pending.chapters
              .flatMap((chapter) => chapter.candidates)
              .filter((candidate) => candidate.kind === "person")
              .map((candidate) => candidate.source)
          ]
            .slice(0, 200)
        })
      });
      markTermExtractorOnline();
      const nextPending = termDiscoveryCore.mergeDiscoveryResult({
        store: pending,
        ignored: stored[STORAGE_KEYS.glossaryIgnored],
        glossary: glossaryCore.normalizeGlossary(stored[STORAGE_KEYS.glossary]),
        pageUrl,
        pageTitle: message.pageTitle,
        targetKey,
        blocks,
        extractedCandidates: payload && payload.candidates
      });
      await storageSet({ [STORAGE_KEYS.glossaryPending]: nextPending });
      return {
        ok: true,
        added: termDiscoveryCore.getPendingCount(nextPending) - termDiscoveryCore.getPendingCount(pending),
        pendingCount: termDiscoveryCore.getPendingCount(nextPending),
        status: getTermExtractorStatusSnapshot()
      };
    } catch (error) {
      markTermExtractorOffline(error);
      console.warn("[MangaTranslator] 术语提取器暂时不可用：", getErrorMessage(error));
      return { ok: true, skipped: true, reason: "offline", status: getTermExtractorStatusSnapshot() };
    }
  });
}

async function handleGetTermDiscoveryStatus(message = {}) {
  const stored = await storageGet([
    STORAGE_KEYS.termDiscoveryEnabled,
    STORAGE_KEYS.glossaryPending,
    STORAGE_KEYS.localOcrBaseUrl
  ]);
  const enabled = stored[STORAGE_KEYS.termDiscoveryEnabled] !== false;
  if (enabled && message.probe === true) {
    await probeTermExtractor(stored[STORAGE_KEYS.localOcrBaseUrl]);
  }
  return {
    ok: true,
    enabled,
    pendingCount: termDiscoveryCore.getPendingCount(stored[STORAGE_KEYS.glossaryPending]),
    status: enabled ? getTermExtractorStatusSnapshot() : { ...getTermExtractorStatusSnapshot(), state: "disabled" }
  };
}

async function handleGetTermDiscoveryState(message = {}) {
  const stored = await storageGet([
    STORAGE_KEYS.termDiscoveryEnabled,
    STORAGE_KEYS.glossaryPending,
    STORAGE_KEYS.glossaryIgnored,
    STORAGE_KEYS.localOcrBaseUrl
  ]);
  const enabled = stored[STORAGE_KEYS.termDiscoveryEnabled] !== false;
  if (enabled && message.probe === true) {
    await probeTermExtractor(stored[STORAGE_KEYS.localOcrBaseUrl]);
  }
  const pending = termDiscoveryCore.normalizePendingStore(stored[STORAGE_KEYS.glossaryPending]);
  return {
    ok: true,
    enabled,
    pending,
    ignored: termDiscoveryCore.normalizeIgnoredStore(stored[STORAGE_KEYS.glossaryIgnored]),
    pendingCount: termDiscoveryCore.getPendingCount(pending),
    status: enabled ? getTermExtractorStatusSnapshot() : { ...getTermExtractorStatusSnapshot(), state: "disabled" }
  };
}

async function handleSetTermDiscoveryEnabled(message) {
  const enabled = message.enabled !== false;
  await storageSet({ [STORAGE_KEYS.termDiscoveryEnabled]: enabled });
  return handleGetTermDiscoveryStatus({ probe: enabled && message.probe === true });
}

async function handleConfirmTermCandidates(message) {
  return enqueueTermDiscoveryMutation(async () => {
    const requestedEntries = (Array.isArray(message.entries) ? message.entries : [])
      .map((entry) => ({
        source: termDiscoveryCore.normalizeSource(entry && entry.source),
        candidateSource: termDiscoveryCore.normalizeSource(
          entry && (entry.candidateSource || entry.source)
        ),
        target: String(entry && entry.target || "").trim().slice(0, glossaryCore.MAX_TARGET_LENGTH),
        note: String(entry && entry.note || "").trim().slice(0, glossaryCore.MAX_NOTE_LENGTH)
      }))
      .filter((entry) => entry.source && entry.target);
    if (requestedEntries.length === 0) {
      return { ok: false, error: "请至少填写一个候选术语的译名" };
    }

    const stored = await storageGet([STORAGE_KEYS.glossary, STORAGE_KEYS.glossaryPending]);
    const glossary = glossaryCore.normalizeGlossary(stored[STORAGE_KEYS.glossary]);
    const entries = [...glossary.entries];
    const indexBySource = new Map(entries.map((entry, index) => [termDiscoveryCore.getSourceKey(entry.source), index]));
    const confirmedSources = [];
    const pendingSourcesToRemove = [];
    for (const requested of requestedEntries) {
      const sourceKey = termDiscoveryCore.getSourceKey(requested.source);
      const entry = glossaryCore.normalizeGlossaryEntry({
        id: `term-auto-${hashString(`${requested.source}\u0000${Date.now()}\u0000${confirmedSources.length}`)}`,
        source: requested.source,
        target: requested.target,
        note: requested.note,
        enabled: true
      });
      if (!entry) {
        continue;
      }
      if (indexBySource.has(sourceKey)) {
        entries[indexBySource.get(sourceKey)] = { ...entries[indexBySource.get(sourceKey)], ...entry };
      } else if (entries.length < glossaryCore.MAX_ENTRIES) {
        indexBySource.set(sourceKey, entries.length);
        entries.push(entry);
      } else {
        return { ok: false, error: `术语库最多保存 ${glossaryCore.MAX_ENTRIES} 条` };
      }
      confirmedSources.push(entry.source);
      pendingSourcesToRemove.push(requested.candidateSource, entry.source);
    }
    if (confirmedSources.length === 0) {
      return { ok: false, error: "没有可加入的候选术语" };
    }

    const nextGlossary = glossaryCore.normalizeGlossary({
      version: glossaryCore.SCHEMA_VERSION,
      revision: glossary.revision + 1,
      updatedAt: Date.now(),
      entries
    });
    const nextPending = termDiscoveryCore.removeSourcesFromPending(
      stored[STORAGE_KEYS.glossaryPending],
      pendingSourcesToRemove
    );
    await storageSet({
      [STORAGE_KEYS.glossary]: nextGlossary,
      [STORAGE_KEYS.glossaryPending]: nextPending
    });
    return {
      ok: true,
      added: confirmedSources.length,
      pendingCount: termDiscoveryCore.getPendingCount(nextPending)
    };
  });
}

async function handleIgnoreTermCandidate(message) {
  return enqueueTermDiscoveryMutation(async () => {
    const stored = await storageGet([STORAGE_KEYS.glossaryPending, STORAGE_KEYS.glossaryIgnored]);
    const next = termDiscoveryCore.ignoreCandidate({
      store: stored[STORAGE_KEYS.glossaryPending],
      ignored: stored[STORAGE_KEYS.glossaryIgnored],
      chapterKey: String(message.chapterKey || ""),
      source: message.source,
      scope: message.scope === "global" ? "global" : "chapter"
    });
    await storageSet({
      [STORAGE_KEYS.glossaryPending]: next.store,
      [STORAGE_KEYS.glossaryIgnored]: next.ignored
    });
    return { ok: true, pendingCount: termDiscoveryCore.getPendingCount(next.store) };
  });
}

async function handleRestoreIgnoredTerm(message) {
  return enqueueTermDiscoveryMutation(async () => {
    const stored = await storageGet([STORAGE_KEYS.glossaryIgnored]);
    const ignored = termDiscoveryCore.restoreIgnoredSource(stored[STORAGE_KEYS.glossaryIgnored], message.source);
    await storageSet({ [STORAGE_KEYS.glossaryIgnored]: ignored });
    return { ok: true };
  });
}

function enqueueTermDiscoveryMutation(task) {
  const running = termDiscoveryMutationQueue.then(task, task);
  termDiscoveryMutationQueue = running.catch(() => undefined);
  return running;
}

function isTermExtractorCoolingDown(now = Date.now()) {
  return termExtractorRuntime.state === "offline" && termExtractorRuntime.cooldownUntil > now;
}

function getTermExtractorStatusSnapshot() {
  return { ...termExtractorRuntime };
}

function markTermExtractorOnline(now = Date.now()) {
  termExtractorRuntime = { state: "online", error: "", checkedAt: now, cooldownUntil: 0 };
}

function markTermExtractorOffline(error, now = Date.now()) {
  termExtractorRuntime = {
    state: "offline",
    error: getErrorMessage(error) || "术语提取器离线",
    checkedAt: now,
    cooldownUntil: now + TERM_EXTRACTOR_COOLDOWN_MS
  };
}

async function probeTermExtractor(baseUrlValue) {
  const now = Date.now();
  if (termExtractorRuntime.checkedAt > 0 && now - termExtractorRuntime.checkedAt < TERM_EXTRACTOR_HEALTH_CACHE_MS) {
    return getTermExtractorStatusSnapshot();
  }
  const baseUrl = sanitizeLocalOcrBaseUrl(baseUrlValue || DEFAULT_LOCAL_OCR_BASE_URL);
  try {
    const payload = await requestTermExtractorJson(`${baseUrl}/terms/health`, { method: "GET" });
    if (!payload || payload.ok !== true || payload.available === false) {
      throw new Error(String(payload && payload.error || "Kiwi 加载失败"));
    }
    markTermExtractorOnline();
  } catch (error) {
    markTermExtractorOffline(error);
  }
  return getTermExtractorStatusSnapshot();
}

async function requestTermExtractorJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TERM_EXTRACTOR_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw new Error(String(payload && (payload.detail || payload.error) || `HTTP ${response.status}`));
    }
    return payload;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("术语提取请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleOcrDataUrl(message) {
  const dataUrl = String(message && message.dataUrl || "").trim();
  if (!isDataUrl(dataUrl)) {
    return { ok: false, error: "Invalid or empty image data URL" };
  }

  const sourceType = normalizeObservationSourceType(message && message.sourceType);
  const pageIds = normalizeObservationPageIds(message && message.pageIds);
  if (pageIds.length === 0) {
    return { ok: false, error: "OCR_DATA_URL requires at least one stable pageId" };
  }
  if (sourceType === "page" && pageIds.length !== 1) {
    return { ok: false, error: "Page OCR must reference exactly one pageId" };
  }
  if (sourceType === "seam" && pageIds.length < 2) {
    return { ok: false, error: "Seam OCR must reference both adjacent pageIds" };
  }

  const settings = await loadSettings();
  const validationError = validateOcrOnlySettings(settings);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const imageDigest = await digestDataUrlSha256(dataUrl);
  const imageRevisionByPage = normalizeImageRevisionByPage(
    pageIds,
    message && (message.imageRevisionByPage || message.imageRevision),
    imageDigest
  );
  if (sourceType === "page") {
    imageRevisionByPage[pageIds[0]] = imageDigest;
  }
  const normalizedMeta = normalizeImageMeta(message && message.imageMeta) || {};
  const imageMeta = {
    ...normalizedMeta,
    pageSpans: normalizeObservationPageSpanMeta(message && message.imageMeta && message.imageMeta.pageSpans)
  };
  const request = {
    dataUrl,
    sourceType,
    pageIds,
    imageRevisionByPage,
    imageDigest,
    imageMeta,
    targetKey: String(message && message.targetKey || "").trim(),
    requireCleanedImage: message && message.requireCleanedImage === true,
    // 该标志只控制易失的渲染图像产物，不参与 OCR 语义缓存指纹。
    forceCleanedImageArtifact: message && message.forceCleanedImageArtifact === true
  };
  const cacheKey = buildOcrCacheKey({ request, settings });

  let cached = settings.localOcrDebug ? null : await getCache(cacheKey);
  const shouldRefreshCleanedImage = Boolean(
    cached &&
    request.requireCleanedImage &&
    settings.provider === PROVIDERS.localPaddleDeepSeek &&
    (cached.requiresCleanedImage === true || request.forceCleanedImageArtifact) &&
    !isDataUrl(cached.cleanedImage)
  );
  if (cached && !shouldRefreshCleanedImage) {
    return { ok: true, result: deepFreezeObservationResult(cached), cached: true };
  }

  if (inflightOcrByCacheKey.has(cacheKey)) {
    return inflightOcrByCacheKey.get(cacheKey);
  }

  const task = (async () => {
    try {
      const refreshed = await requestProviderNeutralOcr({ request, settings });
      // 持久 OCR 缓存中的 Observation 是权威语义结果。暖缓存仅因渲染需要
      // cleaned image 而刷新时，只取新的图像产物，避免一次非确定性 OCR
      // 重新改写 canonical 证据并触发不必要的翻译。
      const result = shouldRefreshCleanedImage
        ? deepFreezeObservationResult({
          ...cached,
          ...(isDataUrl(refreshed && refreshed.cleanedImage)
            ? { cleanedImage: refreshed.cleanedImage }
            : {})
        })
        : refreshed;
      await setCache(cacheKey, result);
      return { ok: true, result, cached: false };
    } catch (error) {
      return {
        ok: false,
        error: `OCR failed (${settings.provider}): ${getErrorMessage(error) || "Unknown OCR error"}`
      };
    } finally {
      inflightOcrByCacheKey.delete(cacheKey);
    }
  })();
  inflightOcrByCacheKey.set(cacheKey, task);
  return task;
}

async function handleTranslateTextBlocks(message) {
  const rawItems = Array.isArray(message && message.items) ? message.items : [];
  if (rawItems.some((item) => !String(item && item.id || "").trim())) {
    return { ok: false, error: "TRANSLATE_TEXT_BLOCKS requires a stable canonical id for every item" };
  }
  const items = rawItems
    .map((item) => ({
      id: String(item && item.id || "").trim(),
      revision: normalizeCanonicalRevision(item && item.revision),
      original_text: normalizeTranslationSourceText(item && item.original_text)
    }))
    .filter((item) => item.original_text);
  if (items.length === 0) {
    return { ok: true, partial: false, translations: [], errors: [] };
  }
  const settings = await loadSettings();
  if (![PROVIDERS.baiduDeepSeek, PROVIDERS.localPaddleDeepSeek].includes(settings.provider)) {
    return { ok: false, error: "Current provider does not support text-only canonical translation" };
  }
  if (!settings.apiKey) {
    return { ok: false, error: "Translation API Key is missing. Please configure it in popup." };
  }

  const sourceLanguage = normalizeLanguageTag(message && message.sourceLanguage, "auto");
  const targetLanguage = normalizeLanguageTag(message && message.targetLanguage, "zh-CN");
  const outcome = await requestCanonicalTextTranslations({
    items,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl || DEFAULT_TRANSLATION_BASE_URL,
    model: settings.model || DEFAULT_MODELS[settings.provider],
    sourceLanguage,
    targetLanguage,
    promptVersion: String(message && message.promptVersion || CANONICAL_TRANSLATION_PROMPT_VERSION),
    translationOptions: message && message.translationOptions,
    glossary: settings.glossary,
    glossaryFingerprint: settings.glossaryFingerprint
  });

  const translations = [];
  const errors = [];
  items.forEach((item) => {
    const row = outcome.get(canonicalTranslationItemKey(item));
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
      translated_text: cleanDecorativeSymbols(row.translatedText),
      translationFingerprint: row.translationFingerprint,
      cached: row.cached === true
    });
  });

  return {
    ok: errors.length === 0 || translations.length > 0,
    partial: errors.length > 0,
    translations,
    errors,
    ...(errors.length > 0 ? { error: `Translation response omitted ${errors.length} item(s)` } : {})
  };
}

function setBackgroundTestHooks(value) {
  backgroundTestHooks = value && typeof value === "object" ? value : null;
}

function normalizeObservationSourceType(value) {
  return String(value || "").trim().toLowerCase() === "seam" ? "seam" : "page";
}

function normalizeObservationPageIds(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry));
}

function normalizeImageRevisionByPage(pageIds, value, fallbackDigest) {
  const provided = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const scalar = provided ? "" : String(value || "").trim();
  return Object.fromEntries(pageIds.map((pageId) => [
    pageId,
    String(provided && provided[pageId] || scalar || fallbackDigest || "").trim()
  ]));
}

function normalizeObservationPageSpanMeta(value) {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const canvasBox = normalizeObservationPixelBox(entry && (entry.canvasBox || entry.canvas || entry.drawRect));
    const pageBox = normalizeObservationPixelBox(entry && (entry.pageBox || entry.sourceBox || entry.cropRect));
    return {
      pageId: String(entry && entry.pageId || "").trim(),
      canvasBox,
      pageBox,
      pageWidth: Math.max(0, Number(entry && (entry.pageWidth || entry.sourceWidth)) || 0),
      pageHeight: Math.max(0, Number(entry && (entry.pageHeight || entry.sourceHeight)) || 0)
    };
  }).filter((entry) => entry.pageId && entry.canvasBox && entry.pageBox && entry.pageWidth > 0 && entry.pageHeight > 0);
}

function normalizeObservationPixelBox(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { left, top, width, height };
}

function validateOcrOnlySettings(settings) {
  if (settings.provider === PROVIDERS.baiduDeepSeek) {
    return settings.baiduApiKey && settings.baiduSecretKey
      ? ""
      : "Baidu OCR AK/SK is missing. Please configure it in popup.";
  }
  if (settings.provider === PROVIDERS.localPaddleDeepSeek) {
    if (!settings.localOcrBaseUrl) {
      return "Local OCR service URL is missing. Please configure it in popup.";
    }
    if (settings.visionOcrEnabled && !settings.visionOcrApiKey) {
      return "Vision OCR API Key is missing. Please configure it in popup.";
    }
    return "";
  }
  return `Unsupported OCR provider: ${settings.provider}`;
}

async function digestDataUrlSha256(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  const binary = typeof atob === "function" ? atob(parsed.base64Data) : "";
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (globalThis.crypto && globalThis.crypto.subtle && bytes.length > 0) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }
  // Chrome Service Worker 始终提供 WebCrypto；仅测试壳缺失该能力时使用完整载荷的确定性回退。
  return `fallback-${hashString(parsed.base64Data)}-${parsed.base64Data.length}`;
}

function buildOcrCacheKey({ request, settings }) {
  const source = stableSerialize({
    imageDigest: request && request.imageDigest || "",
    provider: settings && settings.provider || "",
    sourceType: request && request.sourceType || "page",
    pageIds: request && request.pageIds || [],
    imageRevisionByPage: request && request.imageRevisionByPage || {},
    coordinateModelVersion: OCR_COORDINATE_MODEL_VERSION,
    imageMeta: {
      width: Number(request && request.imageMeta && request.imageMeta.width) || 0,
      height: Number(request && request.imageMeta && request.imageMeta.height) || 0,
      pageSpans: request && request.imageMeta && request.imageMeta.pageSpans || []
    },
    ocr: {
      ignoreSimplifiedChinese: settings && settings.ignoreSimplifiedChinese === true,
      localOcrBaseUrl: settings && settings.localOcrBaseUrl || "",
      localOcrLang: settings && settings.localOcrLang || "",
      localOcrMode: settings && settings.localOcrMode || "",
      localOcrDetThresh: settings && settings.localOcrDetThresh || "",
      localOcrDetBoxThresh: settings && settings.localOcrDetBoxThresh || "",
      localOcrDetUnclipRatio: settings && settings.localOcrDetUnclipRatio || "",
      tuning: settings ? {
        confidenceThreshold: settings.ocrConfidenceThreshold,
        minBoxArea: settings.ocrMinBoxArea,
        maxBoxArea: settings.ocrMaxBoxArea,
        minBoxWidth: settings.ocrMinBoxWidth,
        minBoxHeight: settings.ocrMinBoxHeight,
        maxAspectRatio: settings.ocrMaxAspectRatio,
        mergeLineGap: settings.ocrMergeLineGap
      } : {},
      visionOcrEnabled: settings && settings.visionOcrEnabled === true,
      visionOcrBaseUrl: settings && settings.visionOcrBaseUrl || "",
      visionOcrModel: settings && settings.visionOcrModel || ""
    }
  });
  return `${OCR_CACHE_PREFIX}${String(request && request.imageDigest || "no-digest")}:${stableHash128(source)}`;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function requestProviderNeutralOcr({ request, settings }) {
  if (backgroundTestHooks && typeof backgroundTestHooks.requestProviderNeutralOcr === "function") {
    return backgroundTestHooks.requestProviderNeutralOcr({ request, settings });
  }
  if (settings.provider === PROVIDERS.baiduDeepSeek) {
    return requestBaiduOcrObservations({ request, settings });
  }
  if (settings.provider === PROVIDERS.localPaddleDeepSeek) {
    return requestLocalPaddleOcrObservations({ request, settings });
  }
  throw new Error(`Unsupported OCR provider: ${settings.provider}`);
}

async function requestBaiduOcrObservations({ request, settings }) {
  const imageSize = await decodeObservationImageSize(request.dataUrl, request.imageMeta);
  const ocrPayload = await requestBaiduAccurateOcr({
    dataUrl: request.dataUrl,
    apiKey: settings.baiduApiKey,
    secretKey: settings.baiduSecretKey
  });
  const ocrTuning = getOcrTuning(settings);
  const ocrDebug = createOcrDebugSession("baidu", imageSize, ocrTuning, {
    rawItems: Array.isArray(ocrPayload && ocrPayload.words_result) ? ocrPayload.words_result : []
  });
  const normalized = buildBaiduBubbleItems(ocrPayload, imageSize, ocrTuning, ocrDebug)
    .map((item, index) => normalizeBaiduOcrItem(item, index, imageSize))
    .filter(Boolean);
  return buildProviderNeutralObservationResult({
    provider: "baidu",
    request,
    imageSize,
    normalized,
    ocrTuning,
    ocrDebug,
    ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese,
    serviceCounts: ocrPayload && ocrPayload.counts,
    debug: settings.localOcrDebug === true
  });
}

async function requestLocalPaddleOcrObservations({ request, settings }) {
  const imageSize = await decodeObservationImageSize(request.dataUrl, request.imageMeta);
  let mode = settings.localOcrMode || DEFAULT_LOCAL_OCR_MODE;
  if (mode === "enhanced" && imageSize.width * imageSize.height > 4000000) {
    mode = "fast";
  }
  let ocrPayload = await requestLocalPaddleOcr({
    dataUrl: request.dataUrl,
    baseUrl: settings.localOcrBaseUrl || DEFAULT_LOCAL_OCR_BASE_URL,
    lang: settings.localOcrLang || DEFAULT_LOCAL_OCR_LANG,
    mode,
    params: getLocalOcrParams(settings),
    debug: settings.localOcrDebug === true,
    debugId: buildLocalOcrDebugId(request.targetKey || request.pageIds.join("-"), request.imageMeta)
  });
  ocrPayload = collectSourceImageOcrPayload(ocrPayload, imageSize, request.imageMeta);
  const coordinateImageSize = {
    width: Number(ocrPayload && ocrPayload.imageWidth) || imageSize.width,
    height: Number(ocrPayload && ocrPayload.imageHeight) || imageSize.height
  };
  const ocrTuning = getOcrTuning(settings);
  const ocrDebug = createOcrDebugSession("local_paddle", coordinateImageSize, ocrTuning, {
    rawItems: getLocalOcrPayloadItems(ocrPayload, true)
  });
  const items = await buildLocalPaddleBubbleItems(
    ocrPayload,
    coordinateImageSize,
    request.imageMeta && request.imageMeta.coordinateSpace === "source-image-v1" ? "" : request.dataUrl,
    settings.localOcrDebug === true,
    {
      apiKey: settings.visionOcrEnabled ? settings.visionOcrApiKey : "",
      baseUrl: settings.visionOcrEnabled ? settings.visionOcrBaseUrl || DEFAULT_QWEN_BASE_URL : "",
      model: settings.visionOcrEnabled ? settings.visionOcrModel || DEFAULT_VISION_OCR_MODEL : ""
    },
    ocrTuning,
    ocrDebug,
    request.imageMeta
  );
  const normalized = items.map((item, index) => normalizeBaiduOcrItem(item, index, coordinateImageSize)).filter(Boolean);
  return buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request,
    imageSize: coordinateImageSize,
    normalized,
    ocrTuning,
    ocrDebug,
    ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese,
    serviceCounts: ocrPayload && ocrPayload.counts,
    cleanedImage: ocrPayload && ocrPayload.cleanedImage,
    debug: settings.localOcrDebug === true
  });
}

async function decodeObservationImageSize(dataUrl, imageMeta) {
  if (backgroundTestHooks && typeof backgroundTestHooks.decodeImageSize === "function") {
    return backgroundTestHooks.decodeImageSize(dataUrl, imageMeta);
  }
  return decodeDataUrlImageSize(dataUrl);
}

function buildProviderNeutralObservationResult({
  provider,
  request,
  imageSize,
  normalized,
  ocrTuning,
  ocrDebug,
  ignoreSimplifiedChinese,
  serviceCounts,
  cleanedImage,
  debug
}) {
  const retained = [];
  const filteredRows = [];
  (Array.isArray(normalized) ? normalized : []).forEach((candidate) => {
    let reason = getFinalCandidateDropReason(candidate, imageSize, ocrTuning, provider);
    if (!reason && shouldDropSymbolOnlyBubble(candidate)) {
      reason = "symbol-only-final";
    }
    if (!reason && shouldDropMeaninglessAlphabeticBubble(candidate)) {
      reason = "meaningless-alphabetic-final";
    }
    if (!reason && ignoreSimplifiedChinese && isConfidentSimplifiedChinese(candidate.original_text)) {
      reason = "ignored-simplified-chinese";
    }
    if (reason) {
      filteredRows.push({ candidate, reason });
    } else {
      retained.push(candidate);
    }
  });

  collectDebugFilteredObservationRows(ocrDebug, imageSize).forEach((row) => {
    const key = buildCandidateGeometryKey(row.candidate);
    const exists = filteredRows.some((entry) => buildCandidateGeometryKey(entry.candidate) === key);
    if (!exists) {
      filteredRows.push(row);
    }
  });

  const coalesced = coalesceOverlappingOcrCandidates(retained);
  coalesced.slice(MAX_BUBBLES).forEach((candidate) => {
    filteredRows.push({ candidate, reason: "max_bubbles" });
  });
  const observations = coalesced
    .slice(0, MAX_BUBBLES)
    .map((candidate) => buildProviderNeutralObservation(provider, request, candidate, imageSize));
  const filteredObservations = filteredRows
    .map(({ candidate, reason }) => ({
      ...buildProviderNeutralObservation(provider, request, candidate, imageSize),
      filterReason: String(reason || "filtered")
    }));
  const sortedObservations = sortProviderNeutralObservations(observations);
  const sortedFiltered = sortProviderNeutralObservations(filteredObservations);
  const edgeSignals = buildObservationEdgeSignals(sortedObservations, sortedFiltered, imageSize);
  const result = {
    provider,
    sourceType: request.sourceType,
    pageIds: [...request.pageIds],
    imageRevisionByPage: { ...request.imageRevisionByPage },
    imageDigest: request.imageDigest,
    coordinateModelVersion: OCR_COORDINATE_MODEL_VERSION,
    observations: sortedObservations,
    filteredObservations: sortedFiltered,
    edgeSignals,
    counts: {
      retained: sortedObservations.length,
      filtered: sortedFiltered.length,
      ...(serviceCounts && typeof serviceCounts === "object" ? serviceCounts : {})
    },
    ...(isDataUrl(cleanedImage) ? { cleanedImage } : {}),
    ...(debug ? { debug: buildUnifiedOcrDebugPayload(ocrDebug, retained, { provider, sourceType: request.sourceType }) } : {})
  };
  return deepFreezeObservationResult(result);
}

function collectDebugFilteredObservationRows(ocrDebug, imageSize) {
  return (ocrDebug && Array.isArray(ocrDebug.filterReasons) ? ocrDebug.filterReasons : []).map((entry) => {
    const item = entry && entry.item;
    const percent = item && item.percent;
    const rawBox = item && item.rawBox;
    const text = normalizeTranslationSourceText(item && item.text);
    if (!text || !percent || !rawBox) {
      return null;
    }
    return {
      reason: String(entry.reason || "filtered"),
      candidate: {
        id: "",
        x: Number(percent.x) || 0,
        y: Number(percent.y) || 0,
        w: Math.max(0.1, Number(percent.w) || 0.1),
        h: Math.max(0.1, Number(percent.h) || 0.1),
        original_text: text,
        confidence: Number(item.confidence) || 0,
        rawBox: normalizeObservationPixelBox(rawBox) || {
          left: (Number(percent.x) || 0) / 100 * imageSize.width,
          top: (Number(percent.y) || 0) / 100 * imageSize.height,
          width: Math.max(1, (Number(percent.w) || 0.1) / 100 * imageSize.width),
          height: Math.max(1, (Number(percent.h) || 0.1) / 100 * imageSize.height)
        }
      }
    };
  }).filter(Boolean);
}

function buildProviderNeutralObservation(provider, request, candidate, imageSize) {
  const pageSpans = buildObservationPageSpans(request, candidate, imageSize);
  const originalText = normalizeTranslationSourceText(candidate && candidate.original_text);
  const captureIdentity = [
    provider,
    request.sourceType,
    request.pageIds.join(","),
    stableSerialize(request.imageRevisionByPage)
  ].join("|");
  const providerBlockId = buildOcrBlockId(captureIdentity, candidate);
  const geometryFingerprint = pageSpans.map((span) => [
    span.pageId,
    span.box.x,
    span.box.y,
    span.box.w,
    span.box.h,
    span.overlapRatio
  ].join(",")).join(";");
  const id = `obs-v1-${stableHash128([
    captureIdentity,
    normalizeTranslationSourceText(originalText),
    geometryFingerprint
  ].join("|"))}`;
  const visual = {
    box: quantizePercentBox(candidate),
    rawBox: normalizeObservationPixelBox(candidate && candidate.rawBox),
    fillBox: quantizePercentBox(candidate && candidate.fill_box),
    bgType: String(candidate && candidate.bg_type || "solid"),
    bgColor: String(candidate && candidate.bg_color || ""),
    bgConfidence: quantizeObservationNumber(candidate && candidate.bg_confidence, 0.001),
    regionId: String(candidate && candidate.region_id || ""),
    regionType: String(candidate && candidate.region_type || ""),
    regionPolygon: quantizeObservationPolygon(candidate && candidate.region_polygon),
    textColor: String(candidate && candidate.text_color || ""),
    strokeColor: String(candidate && candidate.stroke_color || ""),
    polygon: quantizeObservationPolygon(candidate && candidate.polygon),
    rotationDeg: quantizeObservationNumber(candidate && candidate.rotation_deg, 0.1),
    sourceLineCount: Math.max(1, Number(candidate && candidate.source_line_count) || 1)
  };
  return {
    id,
    provider,
    captureId: captureIdentity,
    sourceType: request.sourceType,
    pageIds: [...request.pageIds],
    imageRevisionByPage: { ...request.imageRevisionByPage },
    pageSpans,
    originalText,
    confidence: quantizeObservationNumber(candidate && candidate.confidence, 0.001),
    visual,
    providerBlockId
  };
}

function buildObservationPageSpans(request, candidate, imageSize) {
  const rawBox = normalizeObservationPixelBox(candidate && candidate.rawBox) || {
    left: Number(candidate && candidate.x || 0) / 100 * imageSize.width,
    top: Number(candidate && candidate.y || 0) / 100 * imageSize.height,
    width: Number(candidate && candidate.w || 0) / 100 * imageSize.width,
    height: Number(candidate && candidate.h || 0) / 100 * imageSize.height
  };
  const configured = request && request.imageMeta && Array.isArray(request.imageMeta.pageSpans)
    ? request.imageMeta.pageSpans
    : [];
  if (configured.length === 0) {
    return request.pageIds.map((pageId) => ({
      pageId,
      box: quantizePercentBox(candidate),
      polygon: quantizeObservationPolygon(candidate && candidate.polygon),
      overlapRatio: quantizeObservationNumber(1 / request.pageIds.length, 0.001)
    }));
  }
  const spans = [];
  configured.forEach((entry) => {
    const intersection = intersectObservationBoxes(rawBox, entry.canvasBox);
    if (!intersection) {
      return;
    }
    const scaleX = entry.pageBox.width / entry.canvasBox.width;
    const scaleY = entry.pageBox.height / entry.canvasBox.height;
    const pageLeft = entry.pageBox.left + (intersection.left - entry.canvasBox.left) * scaleX;
    const pageTop = entry.pageBox.top + (intersection.top - entry.canvasBox.top) * scaleY;
    spans.push({
      pageId: entry.pageId,
      box: {
        x: quantizeObservationNumber(pageLeft / entry.pageWidth * 100, 0.01),
        y: quantizeObservationNumber(pageTop / entry.pageHeight * 100, 0.01),
        w: quantizeObservationNumber(intersection.width * scaleX / entry.pageWidth * 100, 0.01),
        h: quantizeObservationNumber(intersection.height * scaleY / entry.pageHeight * 100, 0.01)
      },
      polygon: null,
      overlapRatio: quantizeObservationNumber(
        intersection.width * intersection.height / Math.max(1, rawBox.width * rawBox.height),
        0.001
      )
    });
  });
  return spans.length > 0 ? spans : request.pageIds.map((pageId) => ({
    pageId,
    box: quantizePercentBox(candidate),
    polygon: null,
    overlapRatio: 0
  }));
}

function intersectObservationBoxes(left, right) {
  if (!left || !right) {
    return null;
  }
  const x1 = Math.max(left.left, right.left);
  const y1 = Math.max(left.top, right.top);
  const x2 = Math.min(left.left + left.width, right.left + right.width);
  const y2 = Math.min(left.top + left.height, right.top + right.height);
  return x2 > x1 && y2 > y1 ? { left: x1, top: y1, width: x2 - x1, height: y2 - y1 } : null;
}

function quantizePercentBox(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const w = Number(value.w ?? value.width);
  const h = Number(value.h ?? value.height);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return null;
  }
  return {
    x: quantizeObservationNumber(x, 0.01),
    y: quantizeObservationNumber(y, 0.01),
    w: quantizeObservationNumber(w, 0.01),
    h: quantizeObservationNumber(h, 0.01)
  };
}

function quantizeObservationPolygon(value) {
  return Array.isArray(value) ? value.map((point) => ({
    x: quantizeObservationNumber(Array.isArray(point) ? point[0] : point && point.x, 0.01),
    y: quantizeObservationNumber(Array.isArray(point) ? point[1] : point && point.y, 0.01)
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) : null;
}

function quantizeObservationNumber(value, quantum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number / quantum) * quantum : 0;
}

function buildCandidateGeometryKey(candidate) {
  return [
    normalizeTranslationSourceText(candidate && candidate.original_text),
    quantizeObservationNumber(candidate && candidate.x, 0.1),
    quantizeObservationNumber(candidate && candidate.y, 0.1),
    quantizeObservationNumber(candidate && candidate.w, 0.1),
    quantizeObservationNumber(candidate && candidate.h, 0.1)
  ].join("|");
}

function sortProviderNeutralObservations(value) {
  return [...value].sort((left, right) => {
    const leftSpan = left.pageSpans && left.pageSpans[0];
    const rightSpan = right.pageSpans && right.pageSpans[0];
    return String(leftSpan && leftSpan.pageId || "").localeCompare(String(rightSpan && rightSpan.pageId || "")) ||
      Number(leftSpan && leftSpan.box && leftSpan.box.y || 0) - Number(rightSpan && rightSpan.box && rightSpan.box.y || 0) ||
      Number(leftSpan && leftSpan.box && leftSpan.box.x || 0) - Number(rightSpan && rightSpan.box && rightSpan.box.x || 0) ||
      String(left.id).localeCompare(String(right.id));
  });
}

function buildObservationEdgeSignals(observations, filteredObservations, imageSize) {
  const bandHeight = Math.min(
    Math.max(1, Number(imageSize && imageSize.height) || 1),
    clamp(Math.round(Math.max(1, Number(imageSize && imageSize.width) || 1) * 0.15), 160, 420)
  );
  const bandPercent = bandHeight / Math.max(1, Number(imageSize && imageSize.height) || 1) * 100;
  const buildSide = (side) => {
    const retainedIds = observations.filter((item) => observationTouchesEdge(item, side, bandPercent)).map((item) => item.id);
    const filteredIds = filteredObservations.filter((item) => observationTouchesEdge(item, side, bandPercent)).map((item) => item.id);
    const visualDetected = [...observations, ...filteredObservations].some((item) => observationVisualTouchesEdge(item, side, bandPercent));
    return {
      detected: retainedIds.length > 0 || filteredIds.length > 0 || visualDetected,
      retainedObservationIds: retainedIds,
      filteredObservationIds: filteredIds,
      visualDetected
    };
  };
  const top = buildSide("top");
  const bottom = buildSide("bottom");
  return { bandHeight, top, bottom, hasAny: top.detected || bottom.detected };
}

function observationTouchesEdge(observation, side, bandPercent) {
  return (observation && observation.pageSpans || []).some((span) => {
    const box = span && span.box;
    return box && (side === "top" ? box.y <= bandPercent : box.y + box.h >= 100 - bandPercent);
  });
}

function observationVisualTouchesEdge(observation, side, bandPercent) {
  const visual = observation && observation.visual || {};
  const polygons = [visual.polygon, visual.regionPolygon, visual.region_polygon]
    .filter((value) => Array.isArray(value) && value.length > 0);
  const polygonTouches = polygons.some((polygon) => {
    const values = polygon.map((point) => Number(point && point.y)).filter(Number.isFinite);
    return values.length > 0 && (side === "top" ? Math.min(...values) <= bandPercent : Math.max(...values) >= 100 - bandPercent);
  });
  if (polygonTouches) return true;
  return [visual.fillBox, visual.fill_box, visual.regionBox, visual.region_box, visual.box]
    .filter((box) => box && typeof box === "object")
    .some((box) => {
      const y = Number(box.y ?? box.top);
      const height = Number(box.h ?? box.height);
      return Number.isFinite(y) && Number.isFinite(height) && height > 0 && (
        side === "top" ? y <= bandPercent : y + height >= 100 - bandPercent
      );
    });
}

function deepFreezeObservationResult(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreezeObservationResult);
  return Object.freeze(value);
}

function normalizeCanonicalRevision(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : 1;
}

function normalizeLanguageTag(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeTranslationSourceText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function handleFetchImageDataUrl(message) {
  const url = String(message.url || "").trim();
  const preserveSize = message.preserveSize === true;
  const maxOriginalBytes = Math.max(1, Number(message.maxOriginalBytes || 0));
  const referrer = String(message.referrer || "").trim();
  if (!url) {
    return { ok: false, error: "Image URL is required" };
  }

  // 总体超时：两个 fetch 尝试总时间不超过 5 秒
  const FETCH_TOTAL_TIMEOUT_MS = 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TOTAL_TIMEOUT_MS);

  // Build fetch options: include referrer to satisfy CDN hotlink protection.
  // Kakao CDNs (page-edge, dw-img-page) may check the Referer header.
  const buildFetchOptions = (credentials) => {
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const tryFetch = async (credentials) => {
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
          } catch { /* 继续下一个 credentials 模式 */ }
        }
        // 继续尝试下一种 credentials 模式
      }
    }
    if (!blob) {
      // 所有尝试都失败
      clearTimeout(timeoutId);
      return { ok: false, error: "Image fetch error: all fetch attempts failed" };
    }
    clearTimeout(timeoutId);

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
    clearTimeout(timeoutId);
    const msg = error && error.name === "AbortError"
      ? "Image fetch timed out after 5s"
      : (error && error.message ? error.message : "Unknown error");
    return { ok: false, error: `Image fetch error: ${msg}` };
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
  const ocrMode = normalizeOcrRequestMode(message.ocrMode || (message.imageMeta && message.imageMeta.ocrMode));
  const sourceToken = String(message.sourceToken || (message.imageMeta && message.imageMeta.sourceToken) || "").trim();
  const fallbackReason = String(message.fallbackReason || (message.imageMeta && message.imageMeta.fallbackReason) || "").trim();
  const stitchAdmission = String(message.stitchAdmission || (message.imageMeta && message.imageMeta.stitchAdmission) || "").trim();
  const imageMeta = normalizeImageMeta({
    ...(message.imageMeta || {}),
    ocrMode,
    sourceToken,
    fallbackReason,
    stitchAdmission
  });

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
    glossaryFingerprint: settings.glossaryFingerprint,
    imageUrl,
    targetKey,
    ocrMode,
    sourceToken,
    fallbackReason,
    stitchAdmission,
    dataUrl
  });

  let cached = await getCache(cacheKey);
  if (settings.localOcrDebug) {
    cached = null;
  }
  if (
    cached &&
    settings.provider === PROVIDERS.localPaddleDeepSeek &&
    translationResultNeedsCleanedImage(cached) &&
    !isDataUrl(cached.cleanedImage)
  ) {
    try {
      const refreshedOcr = await requestLocalPaddleOcr({
        dataUrl,
        baseUrl: settings.localOcrBaseUrl || DEFAULT_LOCAL_OCR_BASE_URL,
        lang: settings.localOcrLang || DEFAULT_LOCAL_OCR_LANG,
        mode: settings.localOcrMode || DEFAULT_LOCAL_OCR_MODE,
        params: getLocalOcrParams(settings),
        debug: false,
        debugId: buildLocalOcrDebugId(targetKey, imageMeta)
      });
      cached = isDataUrl(refreshedOcr && refreshedOcr.cleanedImage)
        ? { ...cached, cleanedImage: refreshedOcr.cleanedImage }
        : null;
    } catch (error) {
      console.warn("[MangaTranslator] Cached translation could not refresh its cleaned image.", error);
      cached = null;
    }
  }
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
      if (settings.provider === PROVIDERS.baiduDeepSeek) {
        const result = await requestBaiduOcrAndOpenAICompatibleTranslate({
          dataUrl,
          baiduApiKey: settings.baiduApiKey,
          baiduSecretKey: settings.baiduSecretKey,
          translatorApiKey: settings.apiKey,
          translatorBaseUrl: settings.baseUrl || DEFAULT_TRANSLATION_BASE_URL,
          translatorModel: settings.model || DEFAULT_MODELS[PROVIDERS.baiduDeepSeek],
          ocrTuning: getOcrTuning(settings),
          ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese,
          glossary: settings.glossary,
          glossaryFingerprint: settings.glossaryFingerprint
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
          ignoreSimplifiedChinese: settings.ignoreSimplifiedChinese,
          glossary: settings.glossary,
          glossaryFingerprint: settings.glossaryFingerprint
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

function settingsFromOcrTuning(value) {
  const tuning = value || getDefaultOcrTuning();
  return {
    ocrConfidenceThreshold: tuning.confidenceThreshold,
    ocrMinBoxArea: tuning.minBoxArea,
    ocrMaxBoxArea: tuning.maxBoxArea,
    ocrMinBoxWidth: tuning.minBoxWidth,
    ocrMinBoxHeight: tuning.minBoxHeight,
    ocrMaxAspectRatio: tuning.maxAspectRatio,
    ocrMergeLineGap: tuning.mergeLineGap,
    localOcrDebug: tuning.debugEnabled === true
  };
}

async function requestLegacyTranslatedResultFromOcr({
  provider,
  dataUrl,
  imageMeta,
  targetKey,
  ocrSettings,
  translatorApiKey,
  translatorBaseUrl,
  translatorModel,
  glossary,
  glossaryFingerprint
}) {
  const imageDigest = await digestDataUrlSha256(dataUrl);
  const pageId = `legacy-${imageDigest}`;
  const request = {
    dataUrl,
    sourceType: "page",
    pageIds: [pageId],
    imageRevisionByPage: { [pageId]: imageDigest },
    imageDigest,
    imageMeta: imageMeta || {},
    targetKey: String(targetKey || ""),
    requireCleanedImage: true
  };
  const settings = { ...DEFAULT_SETTINGS, ...(ocrSettings || {}), provider };
  const ocrResult = await requestProviderNeutralOcr({ request, settings });
  if (!Array.isArray(ocrResult.observations) || ocrResult.observations.length === 0) {
    return {
      bubbles: [],
      ...(isDataUrl(ocrResult.cleanedImage) ? { cleanedImage: ocrResult.cleanedImage } : {}),
      ...(ocrResult.debug ? { debug: ocrResult.debug } : {})
    };
  }

  const translated = await requestCanonicalTextTranslations({
    items: ocrResult.observations.map((observation) => ({
      id: observation.id,
      revision: 1,
      original_text: observation.originalText
    })),
    apiKey: translatorApiKey,
    baseUrl: translatorBaseUrl,
    model: translatorModel,
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    promptVersion: CANONICAL_TRANSLATION_PROMPT_VERSION,
    translationOptions: { legacyWireShape: true },
    glossary,
    glossaryFingerprint
  });
  const missingObservationIds = ocrResult.observations
    .filter((observation) => {
      const row = translated.get(canonicalTranslationItemKey({ id: observation.id, revision: 1 }));
      return !row || !row.translatedText;
    })
    .map((observation) => observation.id);
  if (missingObservationIds.length > 0) {
    throw new Error(`Translation response omitted ${missingObservationIds.length} OCR block(s)`);
  }
  const bubbles = ocrResult.observations.map((observation) => {
    const visual = observation.visual || {};
    const span = observation.pageSpans && observation.pageSpans[0];
    const box = span && span.box || visual.box || { x: 0, y: 0, w: 0.1, h: 0.1 };
    const row = translated.get(canonicalTranslationItemKey({ id: observation.id, revision: 1 }));
    return {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      fill_box: visual.fillBox || null,
      bg_type: visual.bgType || "solid",
      bg_color: visual.bgColor || "",
      bg_confidence: Number(visual.bgConfidence || 0),
      region_id: visual.regionId || "",
      region_type: visual.regionType || "plain_text",
      region_polygon: visual.regionPolygon || null,
      text_color: visual.textColor || "",
      stroke_color: visual.strokeColor || "",
      polygon: visual.polygon || null,
      rotation_deg: Number(visual.rotationDeg || 0),
      source_line_count: Math.max(1, Number(visual.sourceLineCount) || 1),
      block_id: observation.providerBlockId,
      original_text: observation.originalText,
      translated_text: cleanDecorativeSymbols(row.translatedText)
    };
  });
  return {
    bubbles: provider === PROVIDERS.localPaddleDeepSeek
      ? collapseDuplicateLocalPaddleTranslations(bubbles)
      : bubbles,
    ...(isDataUrl(ocrResult.cleanedImage) ? { cleanedImage: ocrResult.cleanedImage } : {}),
    ...(ocrResult.debug ? { debug: ocrResult.debug } : {})
  };
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
  ignoreSimplifiedChinese,
  glossary,
  glossaryFingerprint
}) {
  return requestLegacyTranslatedResultFromOcr({
    provider: PROVIDERS.baiduDeepSeek,
    dataUrl,
    imageMeta: null,
    targetKey: "legacy-baidu",
    ocrSettings: {
      provider: PROVIDERS.baiduDeepSeek,
      baiduApiKey,
      baiduSecretKey,
      ignoreSimplifiedChinese,
      ...settingsFromOcrTuning(ocrTuning)
    },
    translatorApiKey,
    translatorBaseUrl,
    translatorModel,
    glossary,
    glossaryFingerprint
  });
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
  ignoreSimplifiedChinese,
  glossary,
  glossaryFingerprint
}) {
  return requestLegacyTranslatedResultFromOcr({
    provider: PROVIDERS.localPaddleDeepSeek,
    dataUrl,
    imageMeta,
    targetKey,
    ocrSettings: {
      provider: PROVIDERS.localPaddleDeepSeek,
      localOcrBaseUrl,
      localOcrLang,
      localOcrMode,
      localOcrDebug,
      localOcrDetThresh: localOcrParams && localOcrParams.text_det_thresh,
      localOcrDetBoxThresh: localOcrParams && localOcrParams.text_det_box_thresh,
      localOcrDetUnclipRatio: localOcrParams && localOcrParams.text_det_unclip_ratio,
      visionOcrEnabled: Boolean(visionOcrOptions && visionOcrOptions.enabled),
      visionOcrApiKey: visionOcrOptions && visionOcrOptions.apiKey,
      visionOcrBaseUrl: visionOcrOptions && visionOcrOptions.baseUrl,
      visionOcrModel: visionOcrOptions && visionOcrOptions.model,
      ignoreSimplifiedChinese,
      ...settingsFromOcrTuning(ocrTuning)
    },
    translatorApiKey,
    translatorBaseUrl,
    translatorModel,
    glossary,
    glossaryFingerprint
  });
}
function collectSourceImageOcrPayload(payload, cropImageSize, imageMeta) {
  if (
    !payload || !imageMeta || imageMeta.stitch || imageMeta.coordinateSpace !== "source-image-v1" ||
    !imageMeta.sourceImageId || imageMeta.sourceWidth <= 0 || imageMeta.sourceHeight <= 0 ||
    imageMeta.targetCssWidth <= 0 || imageMeta.targetCssHeight <= 0
  ) {
    return payload;
  }
  const mappedItems = getLocalOcrPayloadItems(payload).map((item) =>
    mapOcrItemToSourceImageCoordinates(item, cropImageSize, imageMeta)
  ).filter(Boolean);
  const now = Date.now();
  for (const [key, session] of ocrLinesBySourceImageId.entries()) {
    if (!session || now - session.updatedAt > 10 * 60 * 1000) {
      ocrLinesBySourceImageId.delete(key);
    }
  }
  const existing = ocrLinesBySourceImageId.get(imageMeta.sourceImageId);
  const items = [...(existing && existing.items || []), ...mappedItems].slice(-800);
  ocrLinesBySourceImageId.set(imageMeta.sourceImageId, { items, updatedAt: now });
  return {
    ...payload,
    items,
    rawItems: items,
    imageWidth: imageMeta.sourceWidth,
    imageHeight: imageMeta.sourceHeight,
    counts: {
      ...(payload.counts || {}),
      source_image_lines: items.length,
      current_crop_lines: mappedItems.length
    }
  };
}

function mapOcrItemToSourceImageCoordinates(item, cropImageSize, imageMeta) {
  const cropWidth = Math.max(1, Number(cropImageSize && cropImageSize.width) || 1);
  const cropHeight = Math.max(1, Number(cropImageSize && cropImageSize.height) || 1);
  const scaleX = imageMeta.cropCssWidth / cropWidth;
  const scaleY = imageMeta.cropCssHeight / cropHeight;
  const toSourcePoint = (x, y) => ({
    x: ((imageMeta.cropCssX + Number(x) * scaleX) / imageMeta.targetCssWidth) * imageMeta.sourceWidth,
    y: ((imageMeta.cropCssY + Number(y) * scaleY) / imageMeta.targetCssHeight) * imageMeta.sourceHeight
  });
  const box = normalizeDebugBox(item && (item.box || item.location));
  if (!box) {
    return null;
  }
  const topLeft = toSourcePoint(box.left, box.top);
  const bottomRight = toSourcePoint(box.left + box.width, box.top + box.height);
  const mapPolygon = (value) => Array.isArray(value) ? value.map((point) => {
    const x = Array.isArray(point) ? point[0] : point && point.x;
    const y = Array.isArray(point) ? point[1] : point && point.y;
    const mapped = toSourcePoint(x, y);
    return [mapped.x, mapped.y];
  }) : null;
  const regionBox = normalizeDebugBox(item && item.region_box);
  let mappedRegionBox = null;
  if (regionBox) {
    const regionTopLeft = toSourcePoint(regionBox.left, regionBox.top);
    const regionBottomRight = toSourcePoint(regionBox.left + regionBox.width, regionBox.top + regionBox.height);
    mappedRegionBox = {
      left: regionTopLeft.x,
      top: regionTopLeft.y,
      width: regionBottomRight.x - regionTopLeft.x,
      height: regionBottomRight.y - regionTopLeft.y
    };
  }
  return {
    ...item,
    region_id: item && item.region_id
      ? `slice-${Math.round(imageMeta.cropCssX)}-${Math.round(imageMeta.cropCssY)}:${item.region_id}`
      : "",
    box: {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y
    },
    polygon: mapPolygon(item && item.polygon),
    region_polygon: mapPolygon(item && item.region_polygon),
    region_box: mappedRegionBox
  };
}

function buildOcrBlockId(sourceImageId, item) {
  const bbox = [item.x, item.y, item.w, item.h].map((value) => Math.round(Number(value || 0) * 10) / 10).join(",");
  return `block-${hashString(`${sourceImageId}|${normalizeTextForLocalPaddle(item.original_text)}|${bbox}`)}`;
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
    console.debug("[MangaTranslator][OCR] Server response items:", payload && Array.isArray(payload.items) ? payload.items.length : 0, "boxes:", payload && Array.isArray(payload.boxes) ? payload.boxes.length : 0, "imageWidth:", payload && payload.imageWidth, "imageHeight:", payload && payload.imageHeight);
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
  console.debug("[MangaTranslator][buildBubbles] sourceItems count:", sourceItems.length, "imageSize:", ocrImageSize);
  if (sourceItems.length === 0) {
    console.warn("[MangaTranslator][buildBubbles] OCR returned zero items, ocrPayload keys:", Object.keys(payload || {}));
  }
  if (ocrDebug) {
    ocrDebug.rawItems = sourceItems.map((item, index) => toDebugOcrItem(item, index, ocrImageSize, "raw"));
  }

  let words = sourceItems
    .map((item) => normalizeLocalPaddleOcrItem(item, ocrImageSize))
    .filter(Boolean)
    .filter((item, index) => keepOrTraceOcrWord(item, ocrImageSize, ocrTuning, ocrDebug, index, "local_paddle"));

  words = await repairLowConfidenceLocalPaddleWordsWithVision(words, dataUrl, ocrImageSize, visionOcrOptions, debug);
  const imageAnalysis = await analyzeLocalOcrImage(dataUrl, ocrImageSize);
  // 跨图窗口聚类全部 OCR 行；归属判断统一由 content.js 在 mapKakaoStitchedResult() 中处理。
  // 不在此处用 isOcrItemOwnedByStitch 过滤，避免按单行中心误拆跨页框。
  const clustered = clusterLocalPaddleWords(words, ocrImageSize, imageAnalysis, debug);
  // Stitch ownership filtering is now handled exclusively by content.js mapKakaoStitchedResult()
  if (imageMeta && imageMeta.stitch) {
    if (debug) {
      console.debug("[MangaTranslator][KakaoStitch] Background: passing all clustered items to content.js for ownership filtering", {
        clusteredCount: clustered.length,
        stitchKeys: (imageMeta.stitch.sourceKeys || []).join(",")
      });
    }
  }
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
      return { sample };
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
  const rawEntries = words
    .map((item, index) => buildLocalPaddleClusterEntry(item, index, imageSize, imageAnalysis, debug))
    .filter((entry) => entry && entry.kind !== "noise");
  const dedupeResult = dedupeLocalPaddleEntries(rawEntries);
  const entries = dedupeResult.entries;
  const lineGroups = buildLocalPaddleLineGroups(entries);
  const paragraphGroups = buildLocalPaddleParagraphGroups(lineGroups);
  const clusters = paragraphGroups.map((group) => group.flatMap((line) => line.entries));
  const merged = clusters
    .map((cluster) => mergeLocalPaddleCluster(cluster, imageSize, imageAnalysis))
    .filter((item) => item && item.words && item.location)
    .sort(compareBaiduWordItems);

  if (debug) {
    debug.dedupedItems = entries.map((entry, index) => toDebugOcrItem(entry.item, index, imageSize, "deduped"));
    debug.lineItems = lineGroups.map((line, index) => toDebugOcrItem({
      words: line.text,
      confidence: line.confidence,
      location: line.box
    }, index, imageSize, "line"));
    debug.duplicateItems = dedupeResult.duplicates.map((duplicate, index) => ({
      ...toDebugOcrItem(duplicate.entry.item, index, imageSize, "duplicate"),
      duplicateOf: duplicate.kept.text,
      isDuplicate: true
    }));
    console.debug("[MangaTranslator] Local OCR clustering:", {
      containers: [...new Map(entries.filter((entry) => entry.container).map((entry) => [entry.container.id, entry.container])).values()],
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

function dedupeLocalPaddleEntries(entries) {
  const kept = [];
  const duplicates = [];
  [...entries]
    .sort((left, right) => getLocalPaddleEntryQuality(right) - getLocalPaddleEntryQuality(left))
    .forEach((entry) => {
      const duplicate = kept.find((candidate) => areDuplicateLocalPaddleEntries(entry, candidate));
      if (duplicate) {
        duplicates.push({ entry, kept: duplicate });
      } else {
        kept.push(entry);
      }
    });
  return {
    entries: kept.sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left),
    duplicates
  };
}

function areDuplicateLocalPaddleEntries(left, right) {
  if (!left || !right || !left.box || !right.box) {
    return false;
  }
  const similarity = normalizedTextSimilarity(left.text, right.text);
  if (similarity < 0.82) {
    return false;
  }
  const iou = localPaddleBoxIou(left.box, right.box);
  if (iou > 0.5) {
    return true;
  }
  const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
  const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
  const centerDistance = Math.hypot(left.box.centerX - right.box.centerX, left.box.centerY - right.box.centerY);
  return similarity >= 0.88 && heightRatio >= 0.72 && centerDistance <= avgHeight * 0.55;
}

function getLocalPaddleEntryQuality(entry) {
  const confidence = Number(entry && entry.item && entry.item.confidence) || 0;
  const completeness = normalizeTextForLocalPaddle(entry && entry.text).length;
  const area = entry && entry.box ? entry.box.width * entry.box.height : 0;
  return confidence * 1000000 + completeness * 1000 + Math.min(area, 999);
}

function normalizedTextSimilarity(left, right) {
  const first = normalizeTextForLocalPaddle(left);
  const second = normalizeTextForLocalPaddle(right);
  if (first === second) {
    return first ? 1 : 0;
  }
  if (!first || !second) {
    return 0;
  }
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex];
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current.push(Math.min(
        current[secondIndex - 1] + 1,
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
      ));
    }
    previous = current;
  }
  return 1 - previous[previous.length - 1] / Math.max(first.length, second.length);
}

function normalizeTextForLocalPaddle(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function localPaddleBoxIou(left, right) {
  const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const intersection = overlapWidth * overlapHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return intersection / Math.max(1, union);
}

function buildLocalPaddleLineGroups(entries) {
  return buildConnectedLocalPaddleGroups(entries, shouldMergeLocalPaddleSameLine)
    .map(buildLocalPaddleLineGroup)
    .sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
}

function buildConnectedLocalPaddleGroups(items, predicate) {
  const groups = [];
  const visited = new Set();
  items.forEach((item, index) => {
    if (visited.has(index)) {
      return;
    }
    const group = [];
    const queue = [index];
    visited.add(index);
    while (queue.length > 0) {
      const currentIndex = queue.shift();
      const current = items[currentIndex];
      group.push(current);
      items.forEach((candidate, candidateIndex) => {
        if (!visited.has(candidateIndex) && predicate(current, candidate)) {
          visited.add(candidateIndex);
          queue.push(candidateIndex);
        }
      });
    }
    groups.push(group);
  });
  return groups;
}

function shouldMergeLocalPaddleSameLine(left, right) {
  if (!left || !right || rotationDistance(left.rotation, right.rotation) > 18) {
    return false;
  }
  if (!areLocalPaddleRegionsCompatible(left, right) || !areLocalPaddleScriptsCompatible(left.text, right.text)) {
    return false;
  }
  const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
  if (heightRatio < 0.65) {
    return false;
  }
  const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
  const verticalOverlap = Math.min(left.box.bottom, right.box.bottom) - Math.max(left.box.top, right.box.top);
  const baselineDistance = Math.abs(left.box.bottom - right.box.bottom);
  return (
    verticalOverlap >= Math.min(left.box.height, right.box.height) * 0.5 &&
    baselineDistance <= avgHeight * 0.35 &&
    getHorizontalGap(left.box, right.box) < avgHeight * 1.2
  );
}

function buildLocalPaddleLineGroup(entries) {
  const sorted = [...entries].sort((left, right) => left.box.left - right.box.left);
  const box = sorted.map((entry) => entry.box).reduce(unionLocalPaddleBoxes);
  return {
    entries: sorted,
    box,
    text: sorted.map((entry) => String(entry.item && entry.item.words || entry.text || "").trim()).filter(Boolean).join(" "),
    rotation: medianRotation(sorted.map((entry) => entry.rotation)),
    confidence: Math.max(...sorted.map((entry) => Number(entry.item && entry.item.confidence) || 0))
  };
}

function buildLocalPaddleParagraphGroups(lines) {
  return buildConnectedLocalPaddleGroups(lines, shouldMergeLocalPaddleParagraphLines)
    .flatMap(splitLocalPaddleParagraphGroup);
}

function splitLocalPaddleParagraphGroup(group) {
  const sorted = [...group].sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left);
  if (sorted.length < 4) {
    return [sorted];
  }
  for (let index = 2; index < sorted.length - 1; index += 1) {
    if (!isLocalPaddleParagraphBoundary(sorted[index - 1], sorted[index])) {
      continue;
    }
    return [
      ...splitLocalPaddleParagraphGroup(sorted.slice(0, index)),
      ...splitLocalPaddleParagraphGroup(sorted.slice(index))
    ];
  }
  return [sorted];
}

function isLocalPaddleParagraphBoundary(left, right) {
  if (!left || !right || !left.box || !right.box) {
    return false;
  }
  const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
  const verticalGap = getVerticalGap(left.box, right.box);
  const overlapX = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left));
  const overlapRatio = overlapX / Math.max(1, Math.min(left.box.width, right.box.width));
  const centerOffset = Math.abs(left.box.centerX - right.box.centerX);
  const widthRatio = Math.min(left.box.width, right.box.width) / Math.max(left.box.width, right.box.width);
  const largeBlankBreak = verticalGap >= avgHeight * 1.1;
  const shiftedLayoutBreak = (
    verticalGap >= avgHeight * 0.65 &&
    centerOffset >= avgHeight * 2.5 &&
    widthRatio < 0.62 &&
    overlapRatio < 0.68
  );
  return largeBlankBreak || shiftedLayoutBreak;
}

function shouldMergeLocalPaddleParagraphLines(left, right) {
  const rotationDelta = left && right ? rotationDistance(left.rotation, right.rotation) : Infinity;
  if (!left || !right || rotationDelta > 18) {
    return false;
  }
  if (!areLocalPaddleLineRegionsCompatible(left, right) || !areLocalPaddleScriptsCompatible(left.text, right.text)) {
    return false;
  }
  const heightRatio = Math.min(left.box.height, right.box.height) / Math.max(left.box.height, right.box.height);
  if (heightRatio < 0.65) {
    return false;
  }
  const avgHeight = Math.max(1, (left.box.height + right.box.height) / 2);
  const verticalGap = getVerticalGap(left.box, right.box);
  if (verticalGap >= avgHeight * 1.2) {
    return false;
  }
  const overlapX = Math.max(0, Math.min(left.box.right, right.box.right) - Math.max(left.box.left, right.box.left));
  const overlapRatio = overlapX / Math.max(1, Math.min(left.box.width, right.box.width));
  const centerOffset = Math.abs(left.box.centerX - right.box.centerX);
  // 气泡边缘常有斜体手写补充语。只有方向变化、超过两个行高的中心偏移和局部重叠同时出现时才拆分，
  // 这些比例在同一区域的 owner / 相邻页 OCR 中保持稳定，也能避免把普通短句或整段倾斜误拆。
  const hasEdgeLetteringStyleBreak = (
    rotationDelta >= 3.5 &&
    centerOffset > avgHeight * 2 &&
    overlapRatio < 0.65
  );
  if (hasEdgeLetteringStyleBreak) {
    return false;
  }
  const centerClose = centerOffset <= Math.max(left.box.width, right.box.width) * 0.35;
  if (!centerClose && overlapRatio <= 0.35) {
    return false;
  }
  const widthRatio = Math.min(left.box.width, right.box.width) / Math.max(left.box.width, right.box.width);
  const leftAligned = Math.abs(left.box.left - right.box.left) <= avgHeight * 2.2;
  const rightAligned = Math.abs(left.box.right - right.box.right) <= avgHeight * 2.2;
  return widthRatio >= 0.35 || leftAligned || rightAligned || centerClose;
}

function areLocalPaddleRegionsCompatible(left, right) {
  const leftContainer = left && left.container;
  const rightContainer = right && right.container;
  if (!leftContainer || !rightContainer) {
    return true;
  }
  if (leftContainer.type === "caption_panel" && rightContainer.type === "caption_panel") {
    return true;
  }
  return leftContainer.id === rightContainer.id;
}

function areLocalPaddleLineRegionsCompatible(left, right) {
  return left.entries.some((leftEntry) => right.entries.some((rightEntry) => areLocalPaddleRegionsCompatible(leftEntry, rightEntry)));
}

function areLocalPaddleScriptsCompatible(leftText, rightText) {
  const leftHangul = /[\uac00-\ud7af]/.test(leftText);
  const rightHangul = /[\uac00-\ud7af]/.test(rightText);
  const leftHan = /[\u3400-\u9fff]/.test(leftText);
  const rightHan = /[\u3400-\u9fff]/.test(rightText);
  return !((leftHangul && rightHan && !rightHangul) || (rightHangul && leftHan && !leftHangul));
}

function unionLocalPaddleBoxes(left, right) {
  return buildBaiduBox(
    Math.min(left.left, right.left),
    Math.min(left.top, right.top),
    Math.max(left.right, right.right),
    Math.max(left.bottom, right.bottom)
  );
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

  const serviceRegionId = String(item && item.region_id ? item.region_id : "");
  const container = serviceRegionId
    ? {
        id: serviceRegionId,
        box: normalizeLocalOcrRegionBox(item.region_box),
        polygon: item.region_polygon || null,
        type: String(item.region_type || "speech_bubble"),
        color: String(item.bg_color || ""),
        confidence: Number(item.region_confidence || 0)
      }
    : null;
  const color = sampleLocalOcrTextColor(imageAnalysis && imageAnalysis.sample, box);
  let kind = "normalOutsideText";
  if (container) {
    kind = "bubbleText";
  } else if (isLocalOcrEffectColor(color)) {
    kind = "effectText";
  }

  return {
    item,
    index,
    box,
    text,
    kind,
    container,
    color,
    textColor: String(item && item.text_color ? item.text_color : ""),
    strokeColor: String(item && item.stroke_color ? item.stroke_color : ""),
    rotation: normalizeRotationDegrees(item && item.rotation_deg)
  };
}

function normalizeLocalOcrRegionBox(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const left = Number(value.left);
  const top = Number(value.top);
  const width = Number(value.width);
  const height = Number(value.height);
  return Number.isFinite(left) && Number.isFinite(top) && width > 0 && height > 0
    ? buildBaiduBox(left, top, left + width, top + height)
    : null;
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
  if (!left || !right) {
    return false;
  }
  // 不把不同方向、但空间上恰好相交的拟声词拼成一句。
  if (rotationDistance(left.rotation, right.rotation) > 18) {
    return false;
  }
  if (shouldJoinLocalPaddleCaptionText(left, right)) {
    return true;
  }
  if (left.kind !== right.kind) {
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

function shouldJoinLocalPaddleCaptionText(left, right) {
  const leftCaption = isLocalPaddleCaptionEntry(left);
  const rightCaption = isLocalPaddleCaptionEntry(right);
  if (!leftCaption && !rightCaption) {
    return false;
  }
  // 语音气泡仍按各自区域隔离；这里仅修正被纯色背景检测切碎的说明面板。
  if ((left.container && !leftCaption) || (right.container && !rightCaption)) {
    return false;
  }

  const leftBox = left.box;
  const rightBox = right.box;
  const avgHeight = Math.max(1, (leftBox.height + rightBox.height) / 2);
  const verticalOverlap = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
  const sameLine = verticalOverlap >= Math.min(leftBox.height, rightBox.height) * 0.45;
  if (sameLine) {
    return getHorizontalGap(leftBox, rightBox) <= avgHeight * 1.25;
  }

  const verticalGap = getVerticalGap(leftBox, rightBox);
  const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
  const overlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(leftBox.width, rightBox.width)) : 0;
  const rightEdgeDistance = Math.abs(leftBox.right - rightBox.right);
  return (
    verticalGap <= avgHeight * 0.95 &&
    (overlapRatio >= 0.12 || rightEdgeDistance <= avgHeight * 1.6)
  );
}

function isLocalPaddleCaptionEntry(entry) {
  return Boolean(entry && entry.container && entry.container.type === "caption_panel");
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
  const geometry = buildRotatedClusterGeometry(cluster, imageSize);
  if (geometry) {
    merged.polygon = geometry.polygon;
    merged.rotation_deg = geometry.rotation;
    merged.sourceLineCount = geometry.lineCount;
    merged.words = composeRotatedClusterWords(cluster, geometry.rotation);
  } else {
    const rotation = medianRotation(cluster.map((entry) => entry.rotation));
    merged.rotation_deg = rotation;
    merged.sourceLineCount = estimateRotatedClusterLineCount(cluster, rotation);
    merged.words = composeRotatedClusterWords(cluster, rotation);
  }
  const captionEntries = cluster.filter(isLocalPaddleCaptionEntry);
  const representative = captionEntries[0] || cluster[0];
  const representativeContainer = representative.container || null;
  const containerIds = new Set(cluster.map((entry) => entry.container && entry.container.id).filter(Boolean));
  const hasSingleCompleteContainer = containerIds.size === 1 && cluster.every((entry) => entry.container);
  const displayBox = buildLocalPaddleDisplayBox(
    cluster,
    hasSingleCompleteContainer ? representativeContainer.box : null,
    imageSize
  );
  if (displayBox) {
    merged.location = displayBox;
    merged.rawBox = displayBox;
  }
  merged.localOcrClusterKind = representativeContainer ? "bubbleText" : representative.kind;
  merged.localOcrContainerId = hasSingleCompleteContainer ? representativeContainer.id : "";
  merged.localOcrRegionType = representativeContainer ? representativeContainer.type : "effect_text";
  merged.regionPolygon = hasSingleCompleteContainer ? representativeContainer.polygon : null;
  merged.regionBox = hasSingleCompleteContainer ? representativeContainer.box : null;
  merged.textColor = representative.textColor || "";
  merged.strokeColor = representative.strokeColor || "";
  merged.adaptiveBackground = representativeContainer && representativeContainer.color
    ? {
        type: "solid",
        color: representativeContainer.color,
        confidence: representativeContainer.confidence
      }
    : { type: "outline", color: "", confidence: 0 };
  return merged;
}

function buildLocalPaddleDisplayBox(cluster, regionBox, imageSize) {
  const boxes = (Array.isArray(cluster) ? cluster : []).map((entry) => entry && entry.box).filter(Boolean);
  if (boxes.length === 0) {
    return null;
  }
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const union = boxes.reduce(unionLocalPaddleBoxes);
  const avgHeight = Math.max(1, boxes.reduce((sum, box) => sum + box.height, 0) / boxes.length);
  // 文字排版框只保留少量呼吸空间；擦除原文所需的更大范围由 fill_box 单独负责。
  const marginX = Math.max(2, Math.min(union.width * 0.035, avgHeight * 0.25));
  const marginY = Math.max(2, Math.min(union.height * 0.04, avgHeight * 0.15));
  let left = Math.max(0, union.left - marginX);
  let top = Math.max(0, union.top - marginY);
  let right = Math.min(imageWidth, union.right + marginX);
  let bottom = Math.min(imageHeight, union.bottom + marginY);

  if (regionBox) {
    left = Math.max(left, Number(regionBox.left) || 0);
    top = Math.max(top, Number(regionBox.top) || 0);
    right = Math.min(right, (Number(regionBox.left) || 0) + Math.max(0, Number(regionBox.width) || 0));
    bottom = Math.min(bottom, (Number(regionBox.top) || 0) + Math.max(0, Number(regionBox.height) || 0));
  }
  return right > left && bottom > top
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}

function buildRotatedClusterGeometry(cluster, imageSize) {
  const points = cluster.flatMap((entry) =>
    Array.isArray(entry.item && entry.item.polygon) ? entry.item.polygon : []
  );
  if (points.length < 4) {
    return null;
  }
  const angles = cluster
    .map((entry) => normalizeRotationDegrees(entry.rotation))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const rotation = angles[Math.floor(angles.length / 2)] || 0;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const projected = points.map((point) => ({
    x: point.x * cos + point.y * sin,
    y: -point.x * sin + point.y * cos
  }));
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const inverse = (x, y) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const polygon = [inverse(minX, minY), inverse(maxX, minY), inverse(maxX, maxY), inverse(minX, maxY)]
    .map((point) => ({ x: clamp(point.x, 0, width), y: clamp(point.y, 0, height) }));
  return {
    polygon,
    rotation,
    lineCount: estimateRotatedClusterLineCount(cluster, rotation)
  };
}

function projectClusterCenter(entry, rotation) {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: entry.box.centerX * cos + entry.box.centerY * sin,
    y: -entry.box.centerX * sin + entry.box.centerY * cos,
    height: Math.max(1, Math.min(entry.box.width, entry.box.height))
  };
}

function buildRotatedClusterRows(cluster, rotation) {
  const rows = [];
  cluster.forEach((entry) => {
    const point = projectClusterCenter(entry, rotation);
    let row = rows.find((candidate) => Math.abs(candidate.y - point.y) <= Math.max(candidate.height, point.height) * 0.7);
    if (!row) {
      row = { y: point.y, height: point.height, entries: [] };
      rows.push(row);
    }
    row.entries.push({ entry, point });
    row.y = row.entries.reduce((sum, item) => sum + item.point.y, 0) / row.entries.length;
    row.height = Math.max(row.height, point.height);
  });
  return rows.sort((left, right) => left.y - right.y);
}

function estimateRotatedClusterLineCount(cluster, rotation) {
  return Math.max(1, buildRotatedClusterRows(cluster, rotation).length);
}

function composeRotatedClusterWords(cluster, rotation) {
  return buildRotatedClusterRows(cluster, rotation)
    .map((row) => row.entries
      .sort((left, right) => left.point.x - right.point.x)
      .map((item) => String(item.entry.item && item.entry.item.words || item.entry.text || "").trim())
      .filter(Boolean)
      .join(" "))
    .filter(Boolean)
    .join("\n");
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
  if (isReliableShortSpeechBubbleItem(item)) {
    return false;
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
  if (isReliableShortSpeechBubbleItem(item)) {
    return false;
  }
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const areaRatio = (box.width * box.height) / Math.max(1, imageWidth * imageHeight);
  return countScriptChars(text) <= 1 && (areaRatio < 0.012 || box.width <= imageWidth * 0.08);
}

function countScriptChars(text) {
  return (String(text || "").match(/[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
}

function isReliableShortSpeechBubbleItem(item) {
  const text = String(item && (item.words ?? item.text ?? item.original_text) || "").replace(/\s+/g, "");
  const hangulChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
  if (
    hangulChars < 1 || hangulChars > 2 || countScriptChars(text) !== hangulChars ||
    /[A-Za-z0-9\u3130-\u318f]/.test(text)
  ) {
    return false;
  }

  const regionId = String(item && item.region_id || "").trim();
  const regionType = String(item && item.region_type || "").trim().toLowerCase();
  const confidence = Number(item && (item.confidence ?? item.score)) || 0;
  const regionConfidence = Number(item && (item.region_confidence ?? item.bg_confidence)) || 0;
  return (
    !!regionId &&
    regionType === "speech_bubble" &&
    confidence >= 0.7 &&
    regionConfidence >= 0.9
  );
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
    polygon: normalizeLocalPaddlePolygon(item && item.polygon, imageSize),
    rotation_deg: normalizeRotationDegrees(item && item.rotation_deg),
    orientation_applied: Number(item && item.orientation_applied) || 0,
    det_score: Number(item && item.det_score) || 0,
    region_id: String(item && item.region_id ? item.region_id : ""),
    region_type: String(item && item.region_type ? item.region_type : "effect_text"),
    region_polygon: normalizeLocalPaddleRegionPolygon(item && item.region_polygon, imageSize),
    region_box: item && item.region_box && typeof item.region_box === "object" ? { ...item.region_box } : null,
    bg_color: String(item && item.bg_color ? item.bg_color : ""),
    text_color: String(item && item.text_color ? item.text_color : ""),
    stroke_color: String(item && item.stroke_color ? item.stroke_color : ""),
    region_confidence: Number(item && item.region_confidence) || 0,
    rawBox: box,
    location: {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height
    }
  };
}

function normalizeLocalPaddleRegionPolygon(value, imageSize) {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }
  const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const points = value.map((point) => {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x: clamp(x, 0, width), y: clamp(y, 0, height) } : null;
  });
  return points.every(Boolean) ? points : null;
}

function normalizeLocalPaddlePolygon(value, imageSize) {
  if (!Array.isArray(value) || value.length < 4) {
    return null;
  }
  const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const points = value.slice(0, 4).map((point) => {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
    return Number.isFinite(x) && Number.isFinite(y)
      ? { x: clamp(x, 0, width), y: clamp(y, 0, height) }
      : null;
  });
  return points.every(Boolean) ? points : null;
}

function normalizeRotationDegrees(value) {
  let angle = Number(value) || 0;
  while (angle >= 90) angle -= 180;
  while (angle < -90) angle += 180;
  return angle;
}

function rotationDistance(left, right) {
  const distance = Math.abs(normalizeRotationDegrees(left) - normalizeRotationDegrees(right));
  return Math.min(distance, 180 - distance);
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
    sourceImageId: String(value.sourceImageId || ""),
    sourceWidth: toNumber(value.sourceWidth, 0),
    sourceHeight: toNumber(value.sourceHeight, 0),
    targetCssWidth: toNumber(value.targetCssWidth, 0),
    targetCssHeight: toNumber(value.targetCssHeight, 0),
    coordinateSpace: String(value.coordinateSpace || ""),
    ocrMode: normalizeOcrRequestMode(value.ocrMode),
    sourceToken: String(value.sourceToken || ""),
    fallbackReason: String(value.fallbackReason || ""),
    stitchAdmission: String(value.stitchAdmission || ""),
    stitchRejectionReason: String(value.stitchRejectionReason || ""),
    stitch: normalizeStitchMeta(value.stitch)
  };
  return meta.width > 0 || meta.height > 0 || meta.cropCssWidth > 0 ? meta : null;
}

function normalizeOcrRequestMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "stitch" || text === "single-fallback" ? text : "single";
}

function normalizeStitchMeta(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  // New structure: canvasWidth/canvasHeight, owner segment with drawRect
  const canvasWidth = toNumber(value.canvasWidth || value.compositeWidth, 0);
  const canvasHeight = toNumber(value.canvasHeight || value.compositeHeight, 0);
  // Derive ownerTop/ownerHeight from owner.drawRect (new) or legacy flat fields
  const ownerDraw = value.owner && value.owner.drawRect;
  const ownerTop = toNumber(ownerDraw ? ownerDraw.y : value.ownerTop, -1);
  const ownerHeight = toNumber(ownerDraw ? ownerDraw.h : value.ownerHeight, 0);
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return null;
  }
  return {
    ownerTop,
    ownerHeight,
    canvasWidth,
    canvasHeight,
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
    dedupedItems: [],
    lineItems: [],
    mergedItems: [],
    duplicateItems: [],
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
  const reliableShortSpeechBubble = isReliableShortSpeechBubbleItem(item);

  if (!reliableShortSpeechBubble && confidence > 0 && confidence < Number(tuning.confidenceThreshold || 0)) {
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
  const maxAspectRatio = Number(tuning.maxAspectRatio || 100);
  if (aspectRatio > maxAspectRatio && !isReadableHorizontalOcrLine(item, box, text, maxAspectRatio)) {
    return "bad-aspect-ratio";
  }
  if (!reliableShortSpeechBubble && scriptChars <= 1 && areaRatio < 0.003 && confidence < 0.98) {
    return "tiny-single-character";
  }
  if (!reliableShortSpeechBubble && shouldDropLowConfidenceLocalPaddleText(text, confidence)) {
    return "weak-script-confidence";
  }
  return "";
}

function isReadableHorizontalOcrLine(item, box, text, maxAspectRatio) {
  if (!box || !(box.width > box.height)) {
    return false;
  }
  const confidence = Number(item && (item.confidence || item.score) || 0);
  const readableChars = normalizeTextForLocalPaddle(text).length;
  const aspectRatio = box.width / Math.max(1, box.height);
  const configuredLimit = Math.max(1, Number(maxAspectRatio) || 1);

  // 长横排句子的宽高比天然会超过普通气泡阈值；使用字符密度和置信度确认它是完整文本行，
  // 同时继续拒绝字符很少的细长装饰框或检测噪声。
  return (
    confidence >= 0.72 &&
    readableChars >= 12 &&
    readableChars / aspectRatio >= 0.8 &&
    aspectRatio <= configuredLimit * 1.75
  );
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
  const reliableShortSpeechBubble = isReliableShortSpeechBubbleItem(item);
  if (!reliableShortSpeechBubble && confidence > 0 && confidence < Number(tuning.confidenceThreshold || 0)) {
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
    blockId: item.block_id || item.id,
    text: item.original_text,
    confidence: item.confidence || 0,
    rawBox: item.rawBox || null,
    box: item.rawBox || null,
    percent: { x: item.x, y: item.y, w: item.w, h: item.h },
    translatedText: item.translated_text || "",
    isDuplicate: false
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

function buildLocalOcrDebugId(targetKey, imageMeta = null) {
  const mode = normalizeOcrRequestMode(imageMeta && imageMeta.ocrMode);
  const admission = String(imageMeta && imageMeta.stitchAdmission || "").trim();
  const reason = String(imageMeta && imageMeta.fallbackReason || imageMeta && imageMeta.stitchRejectionReason || "").trim();
  return [String(targetKey || `target-${Date.now()}`), `mode-${mode}`, admission, reason ? `reason-${hashString(reason).slice(0, 8)}` : ""]
    .filter(Boolean)
    .join("-")
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
    console.warn("[MangaTranslator][norm] drop item", index, {hasLocation: !!location, text, imgSize: imageSize, itemKeys: item ? Object.keys(item) : null});
    return null;
  }

  const sourceLeft = toNumber(location.left);
  const sourceTop = toNumber(location.top);
  const sourceWidth = toNumber(location.width);
  const sourceHeight = toNumber(location.height);
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    console.debug("[MangaTranslator][norm] drop item zero box", index, {sourceLeft, sourceTop, sourceWidth, sourceHeight});
    return null;
  }

  const clusterKind = String(item && item.localOcrClusterKind ? item.localOcrClusterKind : "");
  const adaptiveBackground = item && item.adaptiveBackground ? item.adaptiveBackground : null;
  let bgType = adaptiveBackground
    ? adaptiveBackground.type === "solid" ? "solid" : "none"
    : clusterKind && clusterKind !== "bubbleText" ? "none" : "solid";
  const regionBox = normalizeLocalOcrRegionBox(item && item.regionBox);
  const rawDisplayBox = buildBaiduBox(sourceLeft, sourceTop, sourceLeft + sourceWidth, sourceTop + sourceHeight);
  // 本地 OCR 的 displayBox 已经包含全部原文字框和安全边距，纯色背景无需再次向外扩张。
  const expandSolidPaintBox = !clusterKind;
  const solidPaintBox = bgType === "solid"
    ? buildLocalSolidPaintBox(rawDisplayBox, regionBox, imageSize, expandSolidPaintBox)
    : null;
  if (bgType === "solid" && !solidPaintBox) {
    bgType = "none";
  }
  const displayBox = rawDisplayBox;
  const { left, top, width, height } = displayBox;
  const expandX = bgType === "solid" ? 0 : Math.min(1, width * 0.01);
  const expandY = bgType === "solid" ? 0 : Math.min(1, height * 0.02);
  const x = ((left - expandX) / imageSize.width) * 100;
  const y = ((top - expandY) / imageSize.height) * 100;
  const w = ((width + expandX * 2) / imageSize.width) * 100;
  const h = ((height + expandY * 2) / imageSize.height) * 100;
  const polygon = normalizePercentPolygon(item && item.polygon, imageSize);
  const rotation = normalizeRotationDegrees(item && item.rotation_deg);

  return {
    id: `t${index}`,
    x: clamp(x, 0, 100),
    y: clamp(y, 0, 100),
    w: clamp(w, 0.1, 100),
    h: clamp(h, 0.1, 100),
    fill_box: solidPaintBox ? {
      x: clamp((solidPaintBox.left / imageSize.width) * 100, 0, 100),
      y: clamp((solidPaintBox.top / imageSize.height) * 100, 0, 100),
      w: clamp((solidPaintBox.width / imageSize.width) * 100, 0, 100),
      h: clamp((solidPaintBox.height / imageSize.height) * 100, 0, 100)
    } : null,
    bg_type: bgType,
    bg_color: adaptiveBackground && adaptiveBackground.type === "solid" ? adaptiveBackground.color : "",
    bg_confidence: adaptiveBackground ? Number(adaptiveBackground.confidence || 0) : 0,
    region_id: String(item && item.localOcrContainerId ? item.localOcrContainerId : ""),
    region_type: String(item && item.localOcrRegionType ? item.localOcrRegionType : "effect_text"),
    region_polygon: normalizePercentRegionPolygon(item && item.regionPolygon, imageSize),
    text_color: String(item && item.textColor ? item.textColor : ""),
    stroke_color: String(item && item.strokeColor ? item.strokeColor : ""),
    polygon,
    rotation_deg: rotation,
    source_line_count: Math.max(1, Math.round(Number(item && item.sourceLineCount) || String(text).split(/\n/).length)),
    original_text: text,
    translated_text: "",
    confidence: Number(item.confidence || 0),
    rawBox: {
      left: sourceLeft,
      top: sourceTop,
      width: sourceWidth,
      height: sourceHeight
    }
  };
}

function buildLocalSolidPaintBox(rawBox, regionBox, imageSize, expand = true) {
  if (!rawBox || !(rawBox.width > 0) || !(rawBox.height > 0)) {
    return null;
  }
  const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
  const expandX = expand ? rawBox.width * 0.1 : 0;
  const expandY = expand ? rawBox.height * 0.15 : 0;
  let left = Math.max(0, rawBox.left - expandX);
  let top = Math.max(0, rawBox.top - expandY);
  let right = Math.min(imageWidth, rawBox.right + expandX);
  let bottom = Math.min(imageHeight, rawBox.bottom + expandY);

  if (regionBox) {
    left = Math.max(left, Number(regionBox.left) || 0);
    top = Math.max(top, Number(regionBox.top) || 0);
    right = Math.min(right, (Number(regionBox.left) || 0) + Math.max(0, Number(regionBox.width) || 0));
    bottom = Math.min(bottom, (Number(regionBox.top) || 0) + Math.max(0, Number(regionBox.height) || 0));
  }

  if (right <= left || bottom <= top) {
    return null;
  }

  const width = right - left;
  const height = bottom - top;
  const rawArea = Math.max(1, rawBox.width * rawBox.height);
  if (width * height > rawArea * 2) {
    return null;
  }

  return buildBaiduBox(left, top, right, bottom);
}

function normalizePercentRegionPolygon(value, imageSize) {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }
  const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
  return value.map((point) => {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
    return {
      x: clamp((x / width) * 100, 0, 100),
      y: clamp((y / height) * 100, 0, 100)
    };
  });
}

function normalizePercentPolygon(value, imageSize) {
  if (!Array.isArray(value) || value.length < 4) {
    return null;
  }
  const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
  const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
  return value.slice(0, 4).map((point) => {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point && point.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point && point.y);
    return {
      x: clamp((x / width) * 100, 0, 100),
      y: clamp((y / height) * 100, 0, 100)
    };
  });
}

async function requestCanonicalTextTranslations({
  items,
  apiKey,
  baseUrl,
  model,
  sourceLanguage,
  targetLanguage,
  promptVersion,
  translationOptions,
  glossary,
  glossaryFingerprint
}) {
  const outcome = new Map();
  const pending = [];
  const newRequests = [];
  const configuredModel = model || DEFAULT_MODELS[PROVIDERS.baiduDeepSeek];
  const configuredBaseUrl = baseUrl || DEFAULT_TRANSLATION_BASE_URL;

  for (const item of items) {
    const translationFingerprint = buildCanonicalTranslationFingerprint({
      originalText: item.original_text,
      sourceLanguage,
      targetLanguage,
      model: configuredModel,
      baseUrl: configuredBaseUrl,
      promptVersion,
      glossaryFingerprint,
      translationOptions
    });
    const cacheKey = `${CANONICAL_TRANSLATION_CACHE_PREFIX}${translationFingerprint}`;
    const cached = await getCache(cacheKey);
    if (cached && typeof cached.translatedText === "string" && cached.translatedText.trim()) {
      outcome.set(canonicalTranslationItemKey(item), {
        translatedText: cached.translatedText.trim(),
        translationFingerprint,
        cached: true
      });
      continue;
    }

    let inflight = inflightTranslationByFingerprint.get(translationFingerprint);
    if (!inflight) {
      let resolveRequest;
      let rejectRequest;
      inflight = new Promise((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      });
      inflightTranslationByFingerprint.set(translationFingerprint, inflight);
      newRequests.push({
        item,
        translationFingerprint,
        cacheKey,
        resolve: resolveRequest,
        reject: rejectRequest
      });
    }
    pending.push({ item, translationFingerprint, promise: inflight });
  }

  if (newRequests.length > 0) {
    const batchTask = (async () => {
      const requestItems = newRequests.map((entry, index) => ({
        id: `canonical-request-${index}`,
        original_text: entry.item.original_text
      }));
      try {
        const rows = await requestCanonicalTranslationBatch({
          items: requestItems,
          apiKey,
          baseUrl: configuredBaseUrl,
          model: configuredModel,
          sourceLanguage,
          targetLanguage,
          promptVersion,
          translationOptions,
          glossary
        });
        const rowById = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row && row.id || ""), row]));
        for (let index = 0; index < newRequests.length; index += 1) {
          const entry = newRequests[index];
          const row = rowById.get(requestItems[index].id);
          const translatedText = normalizeTranslationSourceText(row && row.translated_text);
          if (!translatedText) {
            entry.resolve({
              translatedText: "",
              translationFingerprint: entry.translationFingerprint,
              cached: false,
              error: "model_missing_translation"
            });
            continue;
          }
          await setCache(entry.cacheKey, {
            translatedText,
            translationFingerprint: entry.translationFingerprint
          });
          entry.resolve({
            translatedText,
            translationFingerprint: entry.translationFingerprint,
            cached: false
          });
        }
      } catch (error) {
        newRequests.forEach((entry) => entry.reject(error));
      } finally {
        newRequests.forEach((entry) => inflightTranslationByFingerprint.delete(entry.translationFingerprint));
      }
    })();
    await batchTask;
  }

  for (const entry of pending) {
    outcome.set(canonicalTranslationItemKey(entry.item), await entry.promise);
  }
  return outcome;
}

function canonicalTranslationItemKey(item) {
  return `${String(item && item.id || "")}@${normalizeCanonicalRevision(item && item.revision)}`;
}

function buildCanonicalTranslationFingerprint({
  originalText,
  sourceLanguage,
  targetLanguage,
  model,
  baseUrl,
  promptVersion,
  glossaryFingerprint,
  translationOptions
}) {
  const source = stableSerialize({
    text: normalizeTranslationSourceText(originalText),
    sourceLanguage: normalizeLanguageTag(sourceLanguage, "auto").toLowerCase(),
    targetLanguage: normalizeLanguageTag(targetLanguage, "zh-CN").toLowerCase(),
    model: String(model || ""),
    baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
    promptVersion: String(promptVersion || CANONICAL_TRANSLATION_PROMPT_VERSION),
    glossaryFingerprint: String(glossaryFingerprint || ""),
    translationOptions: translationOptions && typeof translationOptions === "object" ? translationOptions : {}
  });
  return stableHash128(source);
}

async function requestCanonicalTranslationBatch({
  items,
  apiKey,
  baseUrl,
  model,
  sourceLanguage,
  targetLanguage,
  promptVersion,
  translationOptions,
  glossary
}) {
  if (backgroundTestHooks && typeof backgroundTestHooks.requestCanonicalTranslationBatch === "function") {
    return backgroundTestHooks.requestCanonicalTranslationBatch({
      items,
      sourceLanguage,
      targetLanguage,
      promptVersion,
      translationOptions,
      glossary
    });
  }
  const endpoint = buildOpenAICompatibleEndpoint(baseUrl || DEFAULT_TRANSLATION_BASE_URL);
  const body = {
    model: model || DEFAULT_MODELS[PROVIDERS.baiduDeepSeek],
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `You are a manga dialogue translator. Translate from ${sourceLanguage || "auto-detected source"} to ${targetLanguage || "zh-CN"}. Return JSON only and preserve every supplied id.`
      },
      {
        role: "user",
        content: [
          `Prompt version: ${promptVersion || CANONICAL_TRANSLATION_PROMPT_VERSION}`,
          `Translation options: ${stableSerialize(translationOptions && typeof translationOptions === "object" ? translationOptions : {})}`,
          buildOpenAICompatibleTranslationPrompt(items, glossary)
        ].join("\n")
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
  const parsed = parseModelJson(extractOpenAIMessageText(payload).trim());
  return parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
}

async function requestOpenAICompatibleTextTranslations({
  items,
  apiKey,
  baseUrl,
  model,
  sourceImageId = "",
  glossary = null,
  glossaryFingerprint = ""
}) {
  const result = new Map();
  const cacheKeys = new Map();
  const uncachedItems = [];
  for (const item of items) {
    const cacheKey = buildBlockTranslationCacheKey(
      sourceImageId,
      item,
      model,
      baseUrl,
      glossaryFingerprint
    );
    cacheKeys.set(item.id, cacheKey);
    const cached = await getCache(cacheKey);
    if (cached && typeof cached.translatedText === "string" && cached.translatedText.trim()) {
      result.set(item.id, cached.translatedText.trim());
    } else {
      uncachedItems.push(item);
    }
  }
  if (uncachedItems.length === 0) {
    return result;
  }
  const endpoint = buildOpenAICompatibleEndpoint(baseUrl || DEFAULT_TRANSLATION_BASE_URL);
  const body = {
    model: model || DEFAULT_MODELS[PROVIDERS.baiduDeepSeek],
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a manga dialogue translator. Translate grouped OCR blocks into natural Simplified Chinese, obey every supplied glossary mapping, and return JSON only."
      },
      {
        role: "user",
        content: buildOpenAICompatibleTranslationPrompt(uncachedItems, glossary)
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
  for (const row of rows) {
    const id = String(row && row.id ? row.id : "").trim();
    const translatedText = String(row && row.translated_text ? row.translated_text : "").trim();
    if (id && translatedText) {
      result.set(id, translatedText);
      const cacheKey = cacheKeys.get(id);
      if (cacheKey) {
        await setCache(cacheKey, { translatedText });
      }
    }
  }

  return result;
}

function buildBlockTranslationCacheKey(sourceImageId, item, model, baseUrl, glossaryFingerprint = "") {
  const text = normalizeTextForLocalPaddle(item && item.original_text);
  const box = item && item.rawBox ? item.rawBox : item || {};
  const bbox = [box.left ?? box.x, box.top ?? box.y, box.width ?? box.w, box.height ?? box.h]
    .map((value) => Math.round(Number(value || 0) * 10) / 10)
    .join(",");
  return `${CACHE_PREFIX}block:${hashString([
    sourceImageId || "unknown-image",
    text,
    bbox,
    model || "",
    baseUrl || "",
    glossaryFingerprint || ""
  ].join("|"))}`;
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

function buildOpenAICompatibleTranslationPrompt(items, glossary = null) {
  const rows = items.map((item) => ({
    id: item.id,
    text: item.original_text
  }));
  const glossaryPrompt = glossaryCore.buildPrompt(glossary, items);

  return [
    "Translate each OCR block into Simplified Chinese as one complete manga bubble or narration box.",
    "Each input text may contain multiple OCR lines from the same bubble. Understand them together; do not translate line by line mechanically.",
    "Rewrite word order naturally for Chinese, merge broken OCR fragments when needed, and keep character names and tone natural for manga dialogue.",
    "If an input contains a model attachment label such as [Image #1], [Image#1], or Image 1, ignore that label and do not output it.",
    "Preserve the input id exactly. Return one translated_text per id.",
    "Return JSON only with this schema:",
    '{"translations":[{"id":"t0","translated_text":"..."}]}',
    ...(glossaryPrompt ? [glossaryPrompt] : []),
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
    model: model || DEFAULT_VISION_OCR_MODEL,
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
  if (isReliableShortSpeechBubbleItem(item)) {
    return false;
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
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

function shouldCoalesceOcrCandidateGroups(leftGroup, rightGroup) {
  const left = getPercentBubbleGroupBox(leftGroup);
  const right = getPercentBubbleGroupBox(rightGroup);
  if (!left || !right) {
    return false;
  }
  const leftBgType = normalizeBgType(leftGroup[0] && leftGroup[0].bg_type);
  const rightBgType = normalizeBgType(rightGroup[0] && rightGroup[0].bg_type);
  const leftRegionId = String(leftGroup[0] && leftGroup[0].region_id || "");
  const rightRegionId = String(rightGroup[0] && rightGroup[0].region_id || "");
  if (leftRegionId || rightRegionId) {
    // 带区域标识的本地 OCR 候选已经完成了行与段落聚类；此处再次按相同 region_id 合并，
    // 会把刻意拆开的气泡边缘补充语、异体字或不同段落重新粘回正文。
    return false;
  }
  if (leftBgType !== rightBgType) {
    return false;
  }
  if (rotationDistance(leftGroup[0] && leftGroup[0].rotation_deg, rightGroup[0] && rightGroup[0].rotation_deg) > 18) {
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
  const requestedBgType = normalizeBgType(sorted[0] && sorted[0].bg_type);
  const mergedFillBox = requestedBgType === "solid" ? mergePercentFillBoxes(sorted) : null;
  const mergedTextArea = Math.max(0.01, box.width * box.height);
  const hasSafeSolidFill = requestedBgType !== "solid" || (
    mergedFillBox && mergedFillBox.w * mergedFillBox.h <= mergedTextArea * 2
  );
  const bgType = hasSafeSolidFill ? requestedBgType : "none";
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
    fill_box: bgType === "solid" ? mergedFillBox : null,
    bg_type: bgType,
    bg_color: bgType === "solid" ? String(sorted[0] && sorted[0].bg_color || "") : "",
    bg_confidence: Number(sorted[0] && sorted[0].bg_confidence || 0),
    region_id: String(sorted[0] && sorted[0].region_id || ""),
    region_type: String(sorted[0] && sorted[0].region_type || "plain_text"),
    region_polygon: sorted[0] && sorted[0].region_polygon || null,
    text_color: bgType === "none" ? "#000000" : String(sorted[0] && sorted[0].text_color || ""),
    stroke_color: bgType === "none" ? "#ffffff" : String(sorted[0] && sorted[0].stroke_color || ""),
    polygon: mergePercentPolygons(sorted),
    rotation_deg: medianRotation(sorted.map((item) => item.rotation_deg)),
    source_line_count: Math.max(1, ...sorted.map((item) => Number(item.source_line_count) || 1)),
    confidence: Math.max(...sorted.map((item) => Number(item.confidence || 0))),
    ...(rawBoxes.length > 0
      ? { rawBox: { left: rawLeft, top: rawTop, width: rawRight - rawLeft, height: rawBottom - rawTop } }
      : {})
  };
}

function mergePercentFillBoxes(items) {
  const boxes = items.map((item) => item && item.fill_box).filter((box) => (
    box && [box.x, box.y, box.w, box.h].every((value) => Number.isFinite(Number(value))) &&
    Number(box.w) > 0 && Number(box.h) > 0
  ));
  if (boxes.length !== items.length || boxes.length === 0) {
    return null;
  }
  const left = Math.min(...boxes.map((box) => Number(box.x)));
  const top = Math.min(...boxes.map((box) => Number(box.y)));
  const right = Math.max(...boxes.map((box) => Number(box.x) + Number(box.w)));
  const bottom = Math.max(...boxes.map((box) => Number(box.y) + Number(box.h)));
  return {
    x: clamp(left, 0, 100),
    y: clamp(top, 0, 100),
    w: clamp(right - left, 0.1, 100),
    h: clamp(bottom - top, 0.1, 100)
  };
}

function medianRotation(values) {
  const angles = values.map(normalizeRotationDegrees).sort((left, right) => left - right);
  return angles.length > 0 ? angles[Math.floor(angles.length / 2)] : 0;
}

function mergePercentPolygons(items) {
  const points = items.flatMap((item) => Array.isArray(item && item.polygon) ? item.polygon : []);
  if (points.length < 4) {
    return items[0] && items[0].polygon ? items[0].polygon : null;
  }
  const rotation = medianRotation(items.map((item) => item.rotation_deg));
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const projected = points.map((point) => ({ x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos }));
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const inverse = (x, y) => ({ x: clamp(x * cos - y * sin, 0, 100), y: clamp(x * sin + y * cos, 0, 100) });
  return [inverse(minX, minY), inverse(maxX, minY), inverse(maxX, maxY), inverse(minX, maxY)];
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
  if (!baseText || !nextText) {
    return false;
  }

  const exactDuplicate = baseText === nextText && baseText.length >= 8;
  const shorterText = baseText.length <= nextText.length ? baseText : nextText;
  const longerText = baseText.length > nextText.length ? baseText : nextText;
  const containedDuplicate = shorterText.length >= 3 && longerText.includes(shorterText);
  if (!exactDuplicate && !containedDuplicate) {
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

  if (containedDuplicate && !exactDuplicate) {
    const groupRegionId = String(group[0] && group[0].region_id || "");
    const nextRegionId = String(bubble && bubble.region_id || "");
    const sameRegion = Boolean(groupRegionId && groupRegionId === nextRegionId);
    const closeOverlap = verticalGap <= avgHeight * 0.35 &&
      (overlapRatio >= 0.35 || centerDistance <= Math.max(groupBox.width, nextBox.width) * 0.35);
    return unionWidth <= 86 && (sameRegion || closeOverlap);
  }

  return verticalGap <= avgHeight * 2.4 && unionWidth <= 86 && (overlapRatio >= 0.12 || centerDistance <= 26);
}

function mergeDuplicateTranslationBubbles(group) {
  const box = getPercentBubbleGroupBox(group);
  const preferred = [...group].sort((left, right) => {
    const textLengthDelta = normalizeDuplicateTranslationText(right && right.translated_text).length -
      normalizeDuplicateTranslationText(left && left.translated_text).length;
    if (textLengthDelta !== 0) {
      return textLengthDelta;
    }
    const leftBox = getPercentBubbleBox(left);
    const rightBox = getPercentBubbleBox(right);
    return (rightBox ? rightBox.width * rightBox.height : 0) - (leftBox ? leftBox.width * leftBox.height : 0);
  })[0];
  const mergedFillBox = mergePercentFillBoxes(group);
  return {
    ...preferred,
    x: clamp(box.left, 0, 100),
    y: clamp(box.top, 0, 100),
    w: clamp(box.width, 0.1, 100),
    h: clamp(box.height, 0.1, 100),
    fill_box: mergedFillBox || preferred.fill_box || null,
    original_text: preferred.original_text,
    translated_text: preferred.translated_text,
    source_line_count: Math.max(1, ...group.map((item) => Number(item && item.source_line_count) || 1))
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
    const cacheKeys = Object.keys(store).filter(isTranslationCacheKey);

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
    const cacheKeys = Object.keys(store).filter(isTranslationCacheKey);
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
  glossaryFingerprint,
  imageUrl,
  targetKey,
  ocrMode,
  sourceToken,
  fallbackReason,
  stitchAdmission,
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
    glossaryFingerprint || "",
    imageUrl || "",
    targetKey || "",
    normalizeOcrRequestMode(ocrMode),
    sourceToken || "",
    fallbackReason || "",
    stitchAdmission || "",
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
  const entry = {
    [cacheKey]: {
      timestamp: Date.now(),
      value: String(cacheKey || "").startsWith(OCR_CACHE_PREFIX)
        ? buildCacheSafeOcrResult(value)
        : buildCacheSafeTranslationResult(value)
    }
  };

  try {
    await storageSet(entry);
    return true;
  } catch (error) {
    if (!isStorageQuotaError(error)) {
      console.warn("[MangaTranslator] Cache write failed; translation will continue without cache.", error);
      return false;
    }
  }

  try {
    const store = await storageGet(null);
    const cacheKeys = Object.keys(store).filter(isTranslationCacheKey);
    if (cacheKeys.length > 0) {
      await storageRemove(cacheKeys);
    }
    await storageSet(entry);
    console.info(`[MangaTranslator] Storage quota recovered by clearing ${cacheKeys.length} translation cache entries.`);
    return true;
  } catch (error) {
    // 缓存是可选加速层，即使单条结果仍然过大，也不能让已完成的翻译失败。
    console.warn("[MangaTranslator] Cache quota recovery failed; translation will continue without cache.", error);
    return false;
  }
}

function isTranslationCacheKey(key) {
  return TRANSLATION_CACHE_KEY_RE.test(String(key || ""));
}

function isStorageQuotaError(error) {
  return /quota|kQuotaBytes/i.test(getErrorMessage(error));
}

function buildCacheSafeTranslationResult(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  // 清理图和逐阶段调试数据可能达到数 MB；缓存只保留重新渲染所需的翻译气泡。
  const { cleanedImage: _cleanedImage, debug: _debug, ...cacheSafeValue } = value;
  return {
    ...cacheSafeValue,
    ...(translationResultNeedsCleanedImage(value) ? { requiresCleanedImage: true } : {})
  };
}

function translationResultNeedsCleanedImage(value) {
  return Boolean(
    value &&
    (value.requiresCleanedImage === true ||
      (Array.isArray(value.bubbles) && value.bubbles.some((bubble) => normalizeBgType(bubble && bubble.bg_type) === "none")))
  );
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
    STORAGE_KEYS.ignoreSimplifiedChinese,
    STORAGE_KEYS.glossary,
    STORAGE_KEYS.glossaryPending,
    STORAGE_KEYS.glossaryIgnored,
    STORAGE_KEYS.termDiscoveryEnabled
  ]);

  const patch = {};

  const storedProvider = String(stored[STORAGE_KEYS.provider] || "").trim().toLowerCase();
  const providerIsSupported = [
    PROVIDERS.baiduDeepSeek,
    PROVIDERS.localPaddleDeepSeek
  ].includes(storedProvider);
  if (!providerIsSupported) {
    patch[STORAGE_KEYS.provider] = DEFAULT_SETTINGS.provider;
    patch[STORAGE_KEYS.model] = DEFAULT_SETTINGS.model;
  }
  if (providerIsSupported && typeof stored[STORAGE_KEYS.model] !== "string") {
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
  if (
    !stored[STORAGE_KEYS.glossary] ||
    typeof stored[STORAGE_KEYS.glossary] !== "object" ||
    !Array.isArray(stored[STORAGE_KEYS.glossary].entries)
  ) {
    patch[STORAGE_KEYS.glossary] = glossaryCore.normalizeGlossary(null);
  }
  if (!stored[STORAGE_KEYS.glossaryPending] || typeof stored[STORAGE_KEYS.glossaryPending] !== "object") {
    patch[STORAGE_KEYS.glossaryPending] = termDiscoveryCore.normalizePendingStore(null);
  }
  if (!stored[STORAGE_KEYS.glossaryIgnored] || typeof stored[STORAGE_KEYS.glossaryIgnored] !== "object") {
    patch[STORAGE_KEYS.glossaryIgnored] = termDiscoveryCore.normalizeIgnoredStore(null);
  }
  if (typeof stored[STORAGE_KEYS.termDiscoveryEnabled] !== "boolean") {
    patch[STORAGE_KEYS.termDiscoveryEnabled] = DEFAULT_SETTINGS.termDiscoveryEnabled;
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
    STORAGE_KEYS.ignoreSimplifiedChinese,
    STORAGE_KEYS.glossary,
    STORAGE_KEYS.termDiscoveryEnabled
  ]);

  const storedProvider = String(raw[STORAGE_KEYS.provider] || "").trim().toLowerCase();
  const provider = normalizeProvider(storedProvider);
  const modelRaw = String(raw[STORAGE_KEYS.model] || "").trim();
  const model = (storedProvider === provider ? modelRaw : "") || DEFAULT_MODELS[provider];
  const glossary = glossaryCore.normalizeGlossary(raw[STORAGE_KEYS.glossary]);

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
    pretranslateMode: ["ahead", "continuous"].includes(
      String(raw[STORAGE_KEYS.pretranslateMode] || "").trim().toLowerCase()
    )
      ? String(raw[STORAGE_KEYS.pretranslateMode]).trim().toLowerCase()
      : "manual",
    ignoreSimplifiedChinese: raw[STORAGE_KEYS.ignoreSimplifiedChinese] === true,
    termDiscoveryEnabled: raw[STORAGE_KEYS.termDiscoveryEnabled] !== false,
    glossary,
    glossaryEntries: glossary.entries,
    glossaryFingerprint: glossaryCore.getFingerprint(glossary)
  };
}

function buildCacheSafeOcrResult(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  const { cleanedImage: _cleanedImage, debug: _debug, ...cacheSafeValue } = value;
  const requiresCleanedImage = Boolean(
    Array.isArray(value.observations) &&
    value.observations.some((observation) => observation && observation.visual && observation.visual.bgType === "none")
  );
  return {
    ...cacheSafeValue,
    ...(requiresCleanedImage ? { requiresCleanedImage: true } : {})
  };
}

function normalizeProvider(provider) {
  const text = String(provider || "").trim().toLowerCase();
  if (
    text === PROVIDERS.baiduDeepSeek ||
    text === PROVIDERS.localPaddleDeepSeek
  ) {
    return text;
  }
  return PROVIDERS.baiduDeepSeek;
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

// Stable synchronous 128-bit digest for semantic IDs and v22 cache fingerprints.
// Image bytes continue to use SHA-256; this avoids 32-bit birthday collisions in large chapters.
function stableHash128(input) {
  const text = String(input || "");
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x5bd1e995);
    h3 = Math.imul(h3 ^ code, 0x27d4eb2d);
    h4 = Math.imul(h4 ^ code, 0x165667b1);
    h2 ^= h1 >>> 13;
    h3 ^= h2 >>> 15;
    h4 ^= h3 >>> 16;
  }
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
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

function blobToDataUrl(blob, timeoutMs = BLOB_TO_DATA_URL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let reader = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    const timer = safeTimeoutMs > 0 ? setTimeout(() => {
      finish(reject, new Error(`Blob to data URL timed out after ${safeTimeoutMs}ms`));
      try {
        if (reader && typeof reader.abort === "function") reader.abort();
      } catch {
        // FileReader 可能已在完成和 timeout 的竞态中关闭。
      }
    }, safeTimeoutMs) : 0;
    try {
      reader = new FileReader();
      reader.onerror = () => finish(reject, new Error("Blob to data URL failed"));
      reader.onabort = () => finish(reject, new Error("Blob to data URL was aborted"));
      reader.onload = () => finish(resolve, reader.result);
      reader.readAsDataURL(blob);
    } catch (error) {
      finish(reject, error);
    }
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
