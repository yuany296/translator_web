import languages from "../shared/languages.js";
import llmProviders from "../shared/llm-providers.js";

export const CONFIG_KEYS = Object.freeze({
  ocr: "mt_ocr_config_v1",
  translation: "mt_translation_config_v1",
  runtime: "mt_runtime_config_v1",
  termExtraction: "mt_term_extraction_config_v1",
  sentenceExtraction: "mt_sentence_extraction_config_v1"
});

export const OCR_PROVIDERS = Object.freeze({ BAIDU: "baidu", LOCAL_PADDLE: "local_paddle" });
export const TRANSLATION_PROVIDERS = Object.freeze({ OPENAI_COMPATIBLE: "openai_compatible" });

export const DEFAULT_OCR_CONFIG = Object.freeze({
  provider: OCR_PROVIDERS.LOCAL_PADDLE,
  baidu: { apiKey: "", secretKey: "" },
  localPaddle: {
    baseUrl: "http://127.0.0.1:8765", lang: "auto", mode: "fast", debug: false,
    detThresh: 0.3, detBoxThresh: 0.6, detUnclipRatio: 1.2
  },
  tuning: {
    confidenceThreshold: 0.72, minBoxArea: 36, maxBoxArea: 0.35,
    minBoxWidth: 6, minBoxHeight: 6, maxAspectRatio: 18, mergeLineGap: 1.65,
    novelImageMergeLines: false
  },
  visionRepair: {
    enabled: false, apiKey: "", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-ocr-latest"
  }
});

export const DEFAULT_TRANSLATION_CONFIG = Object.freeze({
  provider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN"
});

// 提取类配置只保留「用配置库里的哪一条」（vendor）与两个兼容字段：
// followTranslation 供旧存档解析，旧的自有字段在迁移后清空即表示「没有可用 AI 服务」。
export const DEFAULT_TERM_EXTRACTION_CONFIG = Object.freeze({
  provider: "",
  apiKey: "",
  baseUrl: "",
  model: "qwen2.5:7b",
  vendor: "",
  followTranslation: true
});

export const DEFAULT_SENTENCE_EXTRACTION_CONFIG = Object.freeze({
  provider: "",
  apiKey: "",
  baseUrl: "",
  model: "qwen2.5:7b",
  vendor: "",
  followTranslation: true
});

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  enabled: true, showBall: true, captureMode: "direct", renderMode: "overlay",
  pretranslateMode: "manual", ignoreSimplifiedChinese: false, novelMemoryEnabled: true,
  overwriteFontScale: 1, overwriteCoverPadding: 1.2,
  debugOverlayMode: "final", overwritePreviewMode: "full", termDiscoveryEnabled: true,
  floatingSide: "right", floatingYRatio: 0.72,
  displayMode: "translated", webpageDisplayMode: "translated", novelDisplayMode: "translated",
  novelStreamBatchSize: 50,
  // 两个提取服务的开关：整章提取复用 termDiscoveryEnabled，句子级提取用 sentenceExtractionEnabled。
  sentenceExtractionEnabled: true,
  webpageBatchItems: 32, webpageBatchChars: 3200, webpageConcurrency: 5
});

const numberIn = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const text = (value, fallback = "") => String(value ?? fallback).trim();
const httpUrl = (value, fallback) => {
  const normalized = text(value, fallback).replace(/\/+$/u, "");
  return /^https?:\/\//iu.test(normalized) ? normalized : fallback;
};

export function normalizeOcrConfig(value = {}) {
  const local = value.localPaddle || {};
  const baidu = value.baidu || {};
  const tuning = value.tuning || {};
  const vision = value.visionRepair || {};
  const provider = Object.values(OCR_PROVIDERS).includes(value.provider) ? value.provider : DEFAULT_OCR_CONFIG.provider;
  return {
    provider,
    baidu: { apiKey: text(baidu.apiKey), secretKey: text(baidu.secretKey) },
    localPaddle: {
      baseUrl: httpUrl(local.baseUrl, DEFAULT_OCR_CONFIG.localPaddle.baseUrl),
      lang: ["auto", "japan", "korean", "en", "ch", "chinese_cht"].includes(local.lang) ? local.lang : "auto",
      mode: ["fast", "enhanced"].includes(local.mode) ? local.mode : "fast",
      debug: local.debug === true,
      detThresh: numberIn(local.detThresh, 0.01, 0.99, 0.3),
      detBoxThresh: numberIn(local.detBoxThresh, 0.01, 0.99, 0.6),
      detUnclipRatio: numberIn(local.detUnclipRatio, 1, 5, 1.2)
    },
    tuning: {
      confidenceThreshold: numberIn(tuning.confidenceThreshold, 0, 1, 0.72),
      minBoxArea: numberIn(tuning.minBoxArea, 0, 1_000_000, 36),
      maxBoxArea: numberIn(tuning.maxBoxArea, 0.001, 1, 0.35),
      minBoxWidth: numberIn(tuning.minBoxWidth, 0, 10_000, 6),
      minBoxHeight: numberIn(tuning.minBoxHeight, 0, 10_000, 6),
      maxAspectRatio: numberIn(tuning.maxAspectRatio, 1, 100, 18),
      mergeLineGap: numberIn(tuning.mergeLineGap, 0.2, 8, 1.65),
      novelImageMergeLines: tuning.novelImageMergeLines === true
    },
    visionRepair: {
      enabled: vision.enabled === true,
      apiKey: text(vision.apiKey),
      baseUrl: httpUrl(vision.baseUrl, DEFAULT_OCR_CONFIG.visionRepair.baseUrl),
      model: text(vision.model, DEFAULT_OCR_CONFIG.visionRepair.model)
    }
  };
}

export function normalizeTranslationConfig(value = {}) {
  const sourceLanguage = languages.normalizeSourceLanguage(value.sourceLanguage);
  const targetLanguage = languages.normalizeTargetLanguage(value.targetLanguage);
  const provider = llmProviders.getProvider(value.provider)
    ? value.provider
    : llmProviders.inferProviderId(value.baseUrl) || "custom";
  const preset = llmProviders.getProvider(provider);
  const baseUrl = httpUrl(value.baseUrl, preset && preset.baseUrl || DEFAULT_TRANSLATION_CONFIG.baseUrl);
  const model = text(value.model, DEFAULT_TRANSLATION_CONFIG.model);
  const perProvider = normalizePerProviderValues(value, provider, {
    baseUrl,
    model,
    apiKey: text(value.apiKey)
  });
  return {
    provider,
    baseUrl: perProvider.baseUrls[provider] || perProvider.baseUrls.custom || baseUrl,
    baseUrls: perProvider.baseUrls,
    model: perProvider.models[provider] || perProvider.models.custom || model,
    models: perProvider.models,
    apiKey: perProvider.apiKeys[provider] || perProvider.apiKeys.custom || "",
    apiKeys: perProvider.apiKeys,
    sourceLanguage,
    targetLanguage
  };
}

function normalizeLlmExtractionConfig(value = {}, defaults) {
  const selected = llmProviders.getProvider(value.provider) ? value.provider : "";
  const baseUrl = httpUrl(value.baseUrl, llmProviders.getProvider(selected)?.baseUrl || "");
  const provider = selected || llmProviders.inferProviderId(baseUrl) || "";
  const perProvider = normalizePerProviderValues(value, provider, {
    baseUrl,
    model: text(value.model, defaults.model),
    apiKey: text(value.apiKey)
  });
  return {
    provider,
    baseUrl: perProvider.baseUrls[provider] || perProvider.baseUrls.custom || baseUrl,
    baseUrls: perProvider.baseUrls,
    model: perProvider.models[provider] || perProvider.models.custom || text(value.model, defaults.model),
    models: perProvider.models,
    apiKey: perProvider.apiKeys[provider] || perProvider.apiKeys.custom || "",
    apiKeys: perProvider.apiKeys,
    // 配置库条目名（mt_translation_vendors_v1）：有名字就用它那一条，空则用本节自有字段。
    vendor: text(value.vendor),
    // 未显式关掉就跟随翻译服务（老的存档没有这个字段 → 也跟随，省得再填一遍 Key）
    followTranslation: value.followTranslation !== false
  };
}

function slotMap(value, key, fallback, provider) {
  const map = {};
  for (const p of llmProviders.LLM_PROVIDERS) {
    const slot = value && typeof value === "object" && value[key]
      ? value[key][p.id] : undefined;
    map[p.id] = typeof slot === "string" ? slot.trim() : "";
  }
  if (fallback && !map[provider]) {
    map[provider] = fallback;
  }
  return map;
}

function normalizePerProviderValues(value, provider, legacy) {
  return {
    baseUrls: slotMap(value, "baseUrls", legacy.baseUrl, provider),
    models: slotMap(value, "models", legacy.model, provider),
    apiKeys: slotMap(value, "apiKeys", legacy.apiKey, provider)
  };
}

export function normalizeTermExtractionConfig(value = {}) {
  return normalizeLlmExtractionConfig(value, DEFAULT_TERM_EXTRACTION_CONFIG);
}

export function normalizeSentenceExtractionConfig(value = {}) {
  return normalizeLlmExtractionConfig(value, DEFAULT_SENTENCE_EXTRACTION_CONFIG);
}

export function normalizeRuntimeConfig(value = {}) {
  const legacyBilingual = value.webpageDisplayMode === "bilingual" || value.novelDisplayMode === "bilingual";
  const displayMode = value.displayMode === "bilingual" || value.displayMode === undefined && legacyBilingual
    ? "bilingual" : "translated";
  return {
    enabled: value.enabled !== false,
    showBall: value.showBall !== false,
    captureMode: value.captureMode === "screenshot" ? "screenshot" : "direct",
    renderMode: value.renderMode === "embedded" ? "embedded" : "overlay",
    pretranslateMode: ["ahead", "continuous"].includes(value.pretranslateMode) ? value.pretranslateMode : "manual",
    ignoreSimplifiedChinese: value.ignoreSimplifiedChinese === true,
    overwriteFontScale: numberIn(value.overwriteFontScale, 0.5, 2.5, 1),
    overwriteCoverPadding: numberIn(value.overwriteCoverPadding, 0, 1.2, 1.2),
    debugOverlayMode: ["raw", "filtered", "merged", "final"].includes(value.debugOverlayMode) ? value.debugOverlayMode : "final",
    overwritePreviewMode: ["full", "cover", "text"].includes(value.overwritePreviewMode) ? value.overwritePreviewMode : "full",
    termDiscoveryEnabled: value.termDiscoveryEnabled !== false,
    // 句子级提取开关：关掉后候选卡的「AI 提取」与侧边栏提取按钮不再显示。
    sentenceExtractionEnabled: value.sentenceExtractionEnabled !== false,
    // 小说记忆总开关：关掉后翻译请求里不再带跨话记忆（长篇读多了能省不少 token）
    novelMemoryEnabled: value.novelMemoryEnabled !== false,
    floatingSide: value.floatingSide === "left" ? "left" : "right",
    floatingYRatio: numberIn(value.floatingYRatio, 0, 1, DEFAULT_RUNTIME_CONFIG.floatingYRatio),
    // 流式请求每批段落数:整章拆成多个请求,每个请求结果一到就逐段替换,避免整章一次替换。
    novelStreamBatchSize: numberIn(value.novelStreamBatchSize, 5, 150, DEFAULT_RUNTIME_CONFIG.novelStreamBatchSize),
    // 网页翻译批次与并发:数值越大请求越少,但单请求等待时间可能变长。
    webpageBatchItems: numberIn(value.webpageBatchItems, 4, 96, DEFAULT_RUNTIME_CONFIG.webpageBatchItems),
    webpageBatchChars: numberIn(value.webpageBatchChars, 400, 8000, DEFAULT_RUNTIME_CONFIG.webpageBatchChars),
    webpageConcurrency: numberIn(value.webpageConcurrency, 1, 8, DEFAULT_RUNTIME_CONFIG.webpageConcurrency),
    displayMode,
    // 旧字段继续镜像统一值，保证升级期间的旧内容脚本不会读到冲突配置。
    webpageDisplayMode: displayMode,
    novelDisplayMode: displayMode
  };
}
