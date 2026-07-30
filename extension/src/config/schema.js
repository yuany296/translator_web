export const CONFIG_KEYS = Object.freeze({
  ocr: "mt_ocr_config_v1",
  translation: "mt_translation_config_v1",
  runtime: "mt_runtime_config_v1"
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
    minBoxWidth: 6, minBoxHeight: 6, maxAspectRatio: 18, mergeLineGap: 1.65
  },
  visionRepair: {
    enabled: false, apiKey: "", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-ocr-latest"
  }
});

export const DEFAULT_TRANSLATION_CONFIG = Object.freeze({
  provider: TRANSLATION_PROVIDERS.OPENAI_COMPATIBLE,
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat"
});

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  enabled: true, showBall: true, captureMode: "direct", renderMode: "overlay",
  pretranslateMode: "manual", ignoreSimplifiedChinese: false,
  overwriteFontScale: 1, overwriteCoverPadding: 1.2,
  debugOverlayMode: "final", overwritePreviewMode: "full", termDiscoveryEnabled: true,
  floatingSide: "right", floatingYRatio: 0.72
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
      lang: ["auto", "japan", "korean"].includes(local.lang) ? local.lang : "auto",
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
      mergeLineGap: numberIn(tuning.mergeLineGap, 0.2, 8, 1.65)
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
  return {
    provider: TRANSLATION_PROVIDERS.OPENAI_COMPATIBLE,
    apiKey: text(value.apiKey),
    baseUrl: httpUrl(value.baseUrl, DEFAULT_TRANSLATION_CONFIG.baseUrl),
    model: text(value.model, DEFAULT_TRANSLATION_CONFIG.model)
  };
}

export function normalizeRuntimeConfig(value = {}) {
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
    floatingSide: value.floatingSide === "left" ? "left" : "right",
    floatingYRatio: numberIn(value.floatingYRatio, 0, 1, DEFAULT_RUNTIME_CONFIG.floatingYRatio)
  };
}
