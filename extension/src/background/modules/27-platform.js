export function installBackground27(runtime) {
  async function ensureDefaultSettings() {
    const stored = await runtime.storageGet([runtime.STORAGE_KEYS.provider, runtime.STORAGE_KEYS.model, runtime.STORAGE_KEYS.apiKey, runtime.STORAGE_KEYS.baseUrl, runtime.STORAGE_KEYS.baiduApiKey, runtime.STORAGE_KEYS.baiduSecretKey, runtime.STORAGE_KEYS.localOcrBaseUrl, runtime.STORAGE_KEYS.localOcrLang, runtime.STORAGE_KEYS.localOcrMode, runtime.STORAGE_KEYS.localOcrDetThresh, runtime.STORAGE_KEYS.localOcrDetBoxThresh, runtime.STORAGE_KEYS.localOcrDetUnclipRatio, runtime.STORAGE_KEYS.localOcrDebug, runtime.STORAGE_KEYS.ocrConfidenceThreshold, runtime.STORAGE_KEYS.ocrMinBoxArea, runtime.STORAGE_KEYS.ocrMaxBoxArea, runtime.STORAGE_KEYS.ocrMinBoxWidth, runtime.STORAGE_KEYS.ocrMinBoxHeight, runtime.STORAGE_KEYS.ocrMaxAspectRatio, runtime.STORAGE_KEYS.ocrMergeLineGap, runtime.STORAGE_KEYS.overwriteFontScale, runtime.STORAGE_KEYS.overwriteCoverPadding, runtime.STORAGE_KEYS.debugOverlayMode, runtime.STORAGE_KEYS.overwritePreviewMode, runtime.STORAGE_KEYS.visionOcrApiKey, runtime.STORAGE_KEYS.visionOcrBaseUrl, runtime.STORAGE_KEYS.visionOcrModel, runtime.STORAGE_KEYS.visionOcrEnabled, runtime.STORAGE_KEYS.enabled, runtime.STORAGE_KEYS.showBall, runtime.STORAGE_KEYS.captureMode, runtime.STORAGE_KEYS.renderMode, runtime.STORAGE_KEYS.pretranslateMode, runtime.STORAGE_KEYS.ignoreSimplifiedChinese, runtime.STORAGE_KEYS.glossary, runtime.STORAGE_KEYS.glossaryPending, runtime.STORAGE_KEYS.glossaryIgnored, runtime.STORAGE_KEYS.termDiscoveryEnabled]);
    const patch = {};
    const storedProvider = String(stored[runtime.STORAGE_KEYS.provider] || "").trim().toLowerCase();
    const providerIsSupported = [runtime.PROVIDERS.baiduDeepSeek, runtime.PROVIDERS.localPaddleDeepSeek].includes(storedProvider);
    if (!providerIsSupported) {
      patch[runtime.STORAGE_KEYS.provider] = runtime.DEFAULT_SETTINGS.provider;
      patch[runtime.STORAGE_KEYS.model] = runtime.DEFAULT_SETTINGS.model;
    }
    if (providerIsSupported && typeof stored[runtime.STORAGE_KEYS.model] !== "string") {
      patch[runtime.STORAGE_KEYS.model] = runtime.DEFAULT_SETTINGS.model;
    }
    if (typeof stored[runtime.STORAGE_KEYS.apiKey] !== "string") {
      patch[runtime.STORAGE_KEYS.apiKey] = runtime.DEFAULT_SETTINGS.apiKey;
    }
    if (typeof stored[runtime.STORAGE_KEYS.baseUrl] !== "string") {
      patch[runtime.STORAGE_KEYS.baseUrl] = runtime.DEFAULT_SETTINGS.baseUrl;
    }
    if (typeof stored[runtime.STORAGE_KEYS.baiduApiKey] !== "string") {
      patch[runtime.STORAGE_KEYS.baiduApiKey] = runtime.DEFAULT_SETTINGS.baiduApiKey;
    }
    if (typeof stored[runtime.STORAGE_KEYS.baiduSecretKey] !== "string") {
      patch[runtime.STORAGE_KEYS.baiduSecretKey] = runtime.DEFAULT_SETTINGS.baiduSecretKey;
    }
    if (typeof stored[runtime.STORAGE_KEYS.localOcrBaseUrl] !== "string") {
      patch[runtime.STORAGE_KEYS.localOcrBaseUrl] = runtime.DEFAULT_SETTINGS.localOcrBaseUrl;
    }
    if (typeof stored[runtime.STORAGE_KEYS.localOcrLang] !== "string") {
      patch[runtime.STORAGE_KEYS.localOcrLang] = runtime.DEFAULT_SETTINGS.localOcrLang;
    }
    patch[runtime.STORAGE_KEYS.localOcrMode] = runtime.DEFAULT_SETTINGS.localOcrMode;
    patch[runtime.STORAGE_KEYS.localOcrDetThresh] = runtime.DEFAULT_SETTINGS.localOcrDetThresh;
    patch[runtime.STORAGE_KEYS.localOcrDetBoxThresh] = runtime.DEFAULT_SETTINGS.localOcrDetBoxThresh;
    patch[runtime.STORAGE_KEYS.localOcrDetUnclipRatio] = runtime.DEFAULT_SETTINGS.localOcrDetUnclipRatio;
    if (typeof stored[runtime.STORAGE_KEYS.localOcrDebug] !== "boolean") {
      patch[runtime.STORAGE_KEYS.localOcrDebug] = runtime.DEFAULT_SETTINGS.localOcrDebug;
    }
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrConfidenceThreshold, runtime.DEFAULT_SETTINGS.ocrConfidenceThreshold);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrMinBoxArea, runtime.DEFAULT_SETTINGS.ocrMinBoxArea);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrMaxBoxArea, runtime.DEFAULT_SETTINGS.ocrMaxBoxArea);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrMinBoxWidth, runtime.DEFAULT_SETTINGS.ocrMinBoxWidth);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrMinBoxHeight, runtime.DEFAULT_SETTINGS.ocrMinBoxHeight);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrMaxAspectRatio, runtime.DEFAULT_SETTINGS.ocrMaxAspectRatio);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.ocrMergeLineGap, runtime.DEFAULT_SETTINGS.ocrMergeLineGap);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.overwriteFontScale, runtime.DEFAULT_SETTINGS.overwriteFontScale);
    runtime.ensureNumberSettingPatch(stored, patch, runtime.STORAGE_KEYS.overwriteCoverPadding, runtime.DEFAULT_SETTINGS.overwriteCoverPadding);
    if (!runtime.DEBUG_OVERLAY_MODES.has(String(stored[runtime.STORAGE_KEYS.debugOverlayMode] || ""))) {
      patch[runtime.STORAGE_KEYS.debugOverlayMode] = runtime.DEFAULT_SETTINGS.debugOverlayMode;
    }
    if (!runtime.OVERWRITE_PREVIEW_MODES.has(String(stored[runtime.STORAGE_KEYS.overwritePreviewMode] || ""))) {
      patch[runtime.STORAGE_KEYS.overwritePreviewMode] = runtime.DEFAULT_SETTINGS.overwritePreviewMode;
    }
    if (typeof stored[runtime.STORAGE_KEYS.visionOcrApiKey] !== "string") {
      patch[runtime.STORAGE_KEYS.visionOcrApiKey] = runtime.DEFAULT_SETTINGS.visionOcrApiKey;
    }
    if (typeof stored[runtime.STORAGE_KEYS.visionOcrBaseUrl] !== "string") {
      patch[runtime.STORAGE_KEYS.visionOcrBaseUrl] = runtime.DEFAULT_SETTINGS.visionOcrBaseUrl;
    }
    if (typeof stored[runtime.STORAGE_KEYS.visionOcrModel] !== "string") {
      patch[runtime.STORAGE_KEYS.visionOcrModel] = runtime.DEFAULT_SETTINGS.visionOcrModel;
    }
    if (typeof stored[runtime.STORAGE_KEYS.visionOcrEnabled] !== "boolean") {
      patch[runtime.STORAGE_KEYS.visionOcrEnabled] = runtime.DEFAULT_SETTINGS.visionOcrEnabled;
    }
    if (typeof stored[runtime.STORAGE_KEYS.enabled] !== "boolean") {
      patch[runtime.STORAGE_KEYS.enabled] = runtime.DEFAULT_SETTINGS.enabled;
    }
    if (typeof stored[runtime.STORAGE_KEYS.showBall] !== "boolean") {
      patch[runtime.STORAGE_KEYS.showBall] = runtime.DEFAULT_SETTINGS.showBall;
    }
    if (typeof stored[runtime.STORAGE_KEYS.captureMode] !== "string") {
      patch[runtime.STORAGE_KEYS.captureMode] = runtime.DEFAULT_SETTINGS.captureMode;
    }
    if (typeof stored[runtime.STORAGE_KEYS.renderMode] !== "string") {
      patch[runtime.STORAGE_KEYS.renderMode] = runtime.DEFAULT_SETTINGS.renderMode;
    }
    if (typeof stored[runtime.STORAGE_KEYS.pretranslateMode] !== "string") {
      patch[runtime.STORAGE_KEYS.pretranslateMode] = runtime.DEFAULT_SETTINGS.pretranslateMode;
    }
    if (typeof stored[runtime.STORAGE_KEYS.ignoreSimplifiedChinese] !== "boolean") {
      patch[runtime.STORAGE_KEYS.ignoreSimplifiedChinese] = runtime.DEFAULT_SETTINGS.ignoreSimplifiedChinese;
    }
    if (!stored[runtime.STORAGE_KEYS.glossary] || typeof stored[runtime.STORAGE_KEYS.glossary] !== "object" || !Array.isArray(stored[runtime.STORAGE_KEYS.glossary].entries)) {
      patch[runtime.STORAGE_KEYS.glossary] = runtime.glossaryCore.normalizeGlossary(null);
    }
    if (!stored[runtime.STORAGE_KEYS.glossaryPending] || typeof stored[runtime.STORAGE_KEYS.glossaryPending] !== "object") {
      patch[runtime.STORAGE_KEYS.glossaryPending] = runtime.termDiscoveryCore.normalizePendingStore(null);
    }
    if (!stored[runtime.STORAGE_KEYS.glossaryIgnored] || typeof stored[runtime.STORAGE_KEYS.glossaryIgnored] !== "object") {
      patch[runtime.STORAGE_KEYS.glossaryIgnored] = runtime.termDiscoveryCore.normalizeIgnoredStore(null);
    }
    if (typeof stored[runtime.STORAGE_KEYS.termDiscoveryEnabled] !== "boolean") {
      patch[runtime.STORAGE_KEYS.termDiscoveryEnabled] = runtime.DEFAULT_SETTINGS.termDiscoveryEnabled;
    }
    if (Object.keys(patch).length > 0) {
      await runtime.storageSet(patch);
    }
  }
  runtime.ensureDefaultSettings = ensureDefaultSettings;
  function ensureNumberSettingPatch(stored, patch, key, fallback) {
    if (!Number.isFinite(Number(stored[key]))) {
      patch[key] = fallback;
    }
  }
  runtime.ensureNumberSettingPatch = ensureNumberSettingPatch;
  async function loadSettings() {
    const raw = await runtime.storageGet([runtime.STORAGE_KEYS.provider, runtime.STORAGE_KEYS.model, runtime.STORAGE_KEYS.apiKey, runtime.STORAGE_KEYS.baseUrl, runtime.STORAGE_KEYS.baiduApiKey, runtime.STORAGE_KEYS.baiduSecretKey, runtime.STORAGE_KEYS.localOcrBaseUrl, runtime.STORAGE_KEYS.localOcrLang, runtime.STORAGE_KEYS.localOcrMode, runtime.STORAGE_KEYS.localOcrDetThresh, runtime.STORAGE_KEYS.localOcrDetBoxThresh, runtime.STORAGE_KEYS.localOcrDetUnclipRatio, runtime.STORAGE_KEYS.localOcrDebug, runtime.STORAGE_KEYS.ocrConfidenceThreshold, runtime.STORAGE_KEYS.ocrMinBoxArea, runtime.STORAGE_KEYS.ocrMaxBoxArea, runtime.STORAGE_KEYS.ocrMinBoxWidth, runtime.STORAGE_KEYS.ocrMinBoxHeight, runtime.STORAGE_KEYS.ocrMaxAspectRatio, runtime.STORAGE_KEYS.ocrMergeLineGap, runtime.STORAGE_KEYS.overwriteFontScale, runtime.STORAGE_KEYS.overwriteCoverPadding, runtime.STORAGE_KEYS.debugOverlayMode, runtime.STORAGE_KEYS.overwritePreviewMode, runtime.STORAGE_KEYS.visionOcrApiKey, runtime.STORAGE_KEYS.visionOcrBaseUrl, runtime.STORAGE_KEYS.visionOcrModel, runtime.STORAGE_KEYS.visionOcrEnabled, runtime.STORAGE_KEYS.enabled, runtime.STORAGE_KEYS.showBall, runtime.STORAGE_KEYS.captureMode, runtime.STORAGE_KEYS.renderMode, runtime.STORAGE_KEYS.pretranslateMode, runtime.STORAGE_KEYS.ignoreSimplifiedChinese, runtime.STORAGE_KEYS.glossary, runtime.STORAGE_KEYS.termDiscoveryEnabled]);
    const storedProvider = String(raw[runtime.STORAGE_KEYS.provider] || "").trim().toLowerCase();
    const provider = runtime.normalizeProvider(storedProvider);
    const modelRaw = String(raw[runtime.STORAGE_KEYS.model] || "").trim();
    const model = (storedProvider === provider ? modelRaw : "") || runtime.DEFAULT_MODELS[provider];
    const glossary = runtime.glossaryCore.normalizeGlossary(raw[runtime.STORAGE_KEYS.glossary]);
    return {
      provider,
      model,
      apiKey: String(raw[runtime.STORAGE_KEYS.apiKey] || "").trim(),
      baseUrl: String(raw[runtime.STORAGE_KEYS.baseUrl] || "").trim(),
      baiduApiKey: String(raw[runtime.STORAGE_KEYS.baiduApiKey] || "").trim(),
      baiduSecretKey: String(raw[runtime.STORAGE_KEYS.baiduSecretKey] || "").trim(),
      localOcrBaseUrl: runtime.sanitizeLocalOcrBaseUrl(raw[runtime.STORAGE_KEYS.localOcrBaseUrl] || runtime.DEFAULT_LOCAL_OCR_BASE_URL),
      localOcrLang: runtime.normalizeLocalOcrLang(raw[runtime.STORAGE_KEYS.localOcrLang]),
      localOcrMode: runtime.normalizeLocalOcrMode(raw[runtime.STORAGE_KEYS.localOcrMode]),
      localOcrDetThresh: runtime.clampNumber(raw[runtime.STORAGE_KEYS.localOcrDetThresh], 0.01, 0.99, runtime.DEFAULT_LOCAL_OCR_DET_THRESH),
      localOcrDetBoxThresh: runtime.clampNumber(raw[runtime.STORAGE_KEYS.localOcrDetBoxThresh], 0.01, 0.99, runtime.DEFAULT_LOCAL_OCR_DET_BOX_THRESH),
      localOcrDetUnclipRatio: runtime.clampNumber(raw[runtime.STORAGE_KEYS.localOcrDetUnclipRatio], 1, 5, runtime.DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO),
      localOcrDebug: raw[runtime.STORAGE_KEYS.localOcrDebug] === true,
      ocrConfidenceThreshold: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrConfidenceThreshold], 0, 1, runtime.DEFAULT_SETTINGS.ocrConfidenceThreshold),
      ocrMinBoxArea: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrMinBoxArea], 0, 1000000, runtime.DEFAULT_SETTINGS.ocrMinBoxArea),
      ocrMaxBoxArea: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrMaxBoxArea], 0.001, 1, runtime.DEFAULT_SETTINGS.ocrMaxBoxArea),
      ocrMinBoxWidth: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrMinBoxWidth], 0, 10000, runtime.DEFAULT_SETTINGS.ocrMinBoxWidth),
      ocrMinBoxHeight: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrMinBoxHeight], 0, 10000, runtime.DEFAULT_SETTINGS.ocrMinBoxHeight),
      ocrMaxAspectRatio: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrMaxAspectRatio], 1, 100, runtime.DEFAULT_SETTINGS.ocrMaxAspectRatio),
      ocrMergeLineGap: runtime.clampNumber(raw[runtime.STORAGE_KEYS.ocrMergeLineGap], 0.2, 8, runtime.DEFAULT_SETTINGS.ocrMergeLineGap),
      overwriteFontScale: runtime.clampNumber(raw[runtime.STORAGE_KEYS.overwriteFontScale], 0.5, 2.5, runtime.DEFAULT_SETTINGS.overwriteFontScale),
      overwriteCoverPadding: runtime.clampNumber(raw[runtime.STORAGE_KEYS.overwriteCoverPadding], 0, 1.2, runtime.DEFAULT_SETTINGS.overwriteCoverPadding),
      debugOverlayMode: runtime.normalizeDebugOverlayMode(raw[runtime.STORAGE_KEYS.debugOverlayMode]),
      overwritePreviewMode: runtime.normalizeOverwritePreviewMode(raw[runtime.STORAGE_KEYS.overwritePreviewMode]),
      visionOcrApiKey: String(raw[runtime.STORAGE_KEYS.visionOcrApiKey] || "").trim(),
      visionOcrBaseUrl: runtime.sanitizeOpenAICompatibleBaseUrl(raw[runtime.STORAGE_KEYS.visionOcrBaseUrl] || runtime.DEFAULT_QWEN_BASE_URL),
      visionOcrModel: String(raw[runtime.STORAGE_KEYS.visionOcrModel] || runtime.DEFAULT_VISION_OCR_MODEL).trim(),
      visionOcrEnabled: raw[runtime.STORAGE_KEYS.visionOcrEnabled] === true,
      enabled: raw[runtime.STORAGE_KEYS.enabled] !== false,
      showBall: raw[runtime.STORAGE_KEYS.showBall] !== false,
      captureMode: runtime.normalizeCaptureMode(raw[runtime.STORAGE_KEYS.captureMode]),
      renderMode: runtime.normalizeRenderMode(raw[runtime.STORAGE_KEYS.renderMode]),
      pretranslateMode: ["ahead", "continuous"].includes(String(raw[runtime.STORAGE_KEYS.pretranslateMode] || "").trim().toLowerCase()) ? String(raw[runtime.STORAGE_KEYS.pretranslateMode]).trim().toLowerCase() : "manual",
      ignoreSimplifiedChinese: raw[runtime.STORAGE_KEYS.ignoreSimplifiedChinese] === true,
      termDiscoveryEnabled: raw[runtime.STORAGE_KEYS.termDiscoveryEnabled] !== false,
      glossary,
      glossaryEntries: glossary.entries,
      glossaryFingerprint: runtime.glossaryCore.getFingerprint(glossary)
    };
  }
  runtime.loadSettings = loadSettings;
  function buildCacheSafeOcrResult(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    const {
      cleanedImage: _cleanedImage,
      cleanedImageToken: _cleanedImageToken,
      debug: _debug,
      ...cacheSafeValue
    } = value;
    const requiresCleanedImage = Boolean(Array.isArray(value.observations) && value.observations.some(observation => observation && observation.visual && observation.visual.bgType === "none"));
    return {
      ...cacheSafeValue,
      ...(requiresCleanedImage ? {
        requiresCleanedImage: true
      } : {})
    };
  }
  runtime.buildCacheSafeOcrResult = buildCacheSafeOcrResult;
  function normalizeProvider(provider) {
    const text = String(provider || "").trim().toLowerCase();
    if (text === runtime.PROVIDERS.baiduDeepSeek || text === runtime.PROVIDERS.localPaddleDeepSeek) {
      return text;
    }
    return runtime.PROVIDERS.baiduDeepSeek;
  }
  runtime.normalizeProvider = normalizeProvider;
  function sanitizeLocalOcrBaseUrl(value) {
    const normalized = String(value || "").trim().replace(/\/+$/, "");
    if (!normalized) {
      return runtime.DEFAULT_LOCAL_OCR_BASE_URL;
    }
    return /^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`;
  }
  runtime.sanitizeLocalOcrBaseUrl = sanitizeLocalOcrBaseUrl;
  function normalizeLocalOcrLang(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "japan" || text === "korean") {
      return text;
    }
    return runtime.DEFAULT_LOCAL_OCR_LANG;
  }
  runtime.normalizeLocalOcrLang = normalizeLocalOcrLang;
  function normalizeLocalOcrMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "fast" ? "fast" : runtime.DEFAULT_LOCAL_OCR_MODE;
  }
  runtime.normalizeLocalOcrMode = normalizeLocalOcrMode;
  function normalizeLocalOcrNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  runtime.normalizeLocalOcrNumber = normalizeLocalOcrNumber;
  function normalizeRenderMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "embedded" ? "embedded" : "overlay";
  }
  runtime.normalizeRenderMode = normalizeRenderMode;
  function normalizeCaptureMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "screenshot" ? "screenshot" : "direct";
  }
  runtime.normalizeCaptureMode = normalizeCaptureMode;
  function buildTabStatusKey(tabId) {
    return `${runtime.TAB_STATUS_PREFIX}${tabId}`;
  }
  runtime.buildTabStatusKey = buildTabStatusKey;
  function toNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }
  runtime.toNumber = toNumber;
  function clamp(value, min, max) {
    const safe = Number.isFinite(value) ? value : min;
    return Math.min(max, Math.max(min, safe));
  }
  runtime.clamp = clamp;
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
  runtime.hashString = hashString;
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
    return [h1, h2, h3, h4].map(part => (part >>> 0).toString(16).padStart(8, "0")).join("");
  }
  runtime.stableHash128 = stableHash128;
  function isDataUrl(value) {
    return /^data:[^;]+;base64,/i.test(String(value || ""));
  }
  runtime.isDataUrl = isDataUrl;
  function getDataUrlMimeType(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;]+);base64,/i);
    return match ? String(match[1]).toLowerCase() : "";
  }
  runtime.getDataUrlMimeType = getDataUrlMimeType;
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
  runtime.parseDataUrl = parseDataUrl;
  async function blobToPreferredDataUrl(blob) {
    const type = String(blob && blob.type ? blob.type : "").toLowerCase();
    if (type === "image/jpeg" && blob.size > 0 && blob.size <= runtime.FAST_PATH_MAX_JPEG_BYTES) {
      return runtime.blobToDataUrl(blob);
    }
    const jpegBlob = await runtime.transcodeBlob(blob, "image/jpeg", runtime.IMAGE_JPEG_QUALITY);
    if (jpegBlob) {
      return runtime.blobToDataUrl(jpegBlob);
    }
    const pngBlob = await runtime.transcodeBlob(blob, "image/png", 0.92);
    if (pngBlob) {
      return runtime.blobToDataUrl(pngBlob);
    }
    return runtime.blobToDataUrl(blob);
  }
  runtime.blobToPreferredDataUrl = blobToPreferredDataUrl;
  async function transcodeDataUrlToJpeg(dataUrl) {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const jpegBlob = await runtime.transcodeBlob(blob, "image/jpeg", runtime.IMAGE_JPEG_QUALITY);
      if (!jpegBlob) {
        return "";
      }
      return runtime.blobToDataUrl(jpegBlob);
    } catch {
      return "";
    }
  }
  runtime.transcodeDataUrlToJpeg = transcodeDataUrlToJpeg;
}
