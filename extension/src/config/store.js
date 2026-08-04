import {
  CONFIG_KEYS, OCR_PROVIDERS, normalizeOcrConfig,
  normalizeRuntimeConfig, normalizeTranslationConfig
} from "./schema.js";
import languages from "../shared/languages.js";

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeUnifiedConfiguration(raw) {
  const rawOcr = raw[CONFIG_KEYS.ocr] || {};
  const rawTranslation = raw[CONFIG_KEYS.translation] || {};
  const migratedSource = hasOwn(rawTranslation, "sourceLanguage")
    ? rawTranslation.sourceLanguage
    : languages.ocrLanguageToTranslationLanguage(rawOcr.localPaddle?.lang, "auto");
  const translation = normalizeTranslationConfig({ ...rawTranslation, sourceLanguage: migratedSource });
  const ocr = normalizeOcrConfig(rawOcr);
  ocr.localPaddle.lang = languages.translationLanguageToOcrLanguage(translation.sourceLanguage);
  return { ocr, translation, runtime: normalizeRuntimeConfig(raw[CONFIG_KEYS.runtime]) };
}

export function createConfigurationStore({ storageGet, storageSet, glossaryCore }) {
  async function load() {
    const keys = [CONFIG_KEYS.ocr, CONFIG_KEYS.translation, CONFIG_KEYS.runtime, glossaryCore.STORAGE_KEY];
    if (glossaryCore.LEGACY_STORAGE_KEY) keys.push(glossaryCore.LEGACY_STORAGE_KEY);
    const raw = await storageGet(keys);
    const storedGlossary = raw[glossaryCore.STORAGE_KEY] ?? raw[glossaryCore.LEGACY_STORAGE_KEY];
    const glossary = glossaryCore.normalizeGlossary(storedGlossary);
    const unified = normalizeUnifiedConfiguration(raw);
    if (raw[glossaryCore.STORAGE_KEY] === undefined && storedGlossary !== undefined) {
      await storageSet({ [glossaryCore.STORAGE_KEY]: glossary });
    }
    return {
      ...unified,
      glossary,
      glossaryFingerprint: glossaryCore.getFingerprint(glossary)
    };
  }

  async function ensure() {
    const config = await load();
    await storageSet({
      [CONFIG_KEYS.ocr]: config.ocr,
      [CONFIG_KEYS.translation]: config.translation,
      [CONFIG_KEYS.runtime]: config.runtime,
      [glossaryCore.STORAGE_KEY]: config.glossary
    });
    return config;
  }

  async function save(section, value) {
    const normalizers = { ocr: normalizeOcrConfig, translation: normalizeTranslationConfig, runtime: normalizeRuntimeConfig };
    if (!normalizers[section]) throw new Error(`Unknown configuration section: ${section}`);
    const normalized = normalizers[section](value);
    await storageSet({ [CONFIG_KEYS[section]]: normalized });
    return normalized;
  }
  return Object.freeze({ load, ensure, save });
}

export function toLegacySettings(config) {
  const { ocr, translation, runtime, glossary, glossaryFingerprint } = config;
  const local = ocr.localPaddle;
  const tuning = ocr.tuning;
  const vision = ocr.visionRepair;
  return {
    provider: ocr.provider,
    ocrProvider: ocr.provider, translationProvider: translation.provider,
    model: translation.model, apiKey: translation.apiKey, baseUrl: translation.baseUrl,
    sourceLanguage: translation.sourceLanguage, targetLanguage: translation.targetLanguage,
    baiduApiKey: ocr.baidu.apiKey, baiduSecretKey: ocr.baidu.secretKey,
    localOcrBaseUrl: local.baseUrl,
    localOcrLang: languages.translationLanguageToOcrLanguage(translation.sourceLanguage),
    localOcrMode: local.mode,
    localOcrDetThresh: local.detThresh, localOcrDetBoxThresh: local.detBoxThresh,
    localOcrDetUnclipRatio: local.detUnclipRatio, localOcrDebug: local.debug,
    ocrConfidenceThreshold: tuning.confidenceThreshold, ocrMinBoxArea: tuning.minBoxArea,
    ocrMaxBoxArea: tuning.maxBoxArea, ocrMinBoxWidth: tuning.minBoxWidth,
    ocrMinBoxHeight: tuning.minBoxHeight, ocrMaxAspectRatio: tuning.maxAspectRatio,
    ocrMergeLineGap: tuning.mergeLineGap,
    visionOcrEnabled: vision.enabled, visionOcrApiKey: vision.apiKey,
    visionOcrBaseUrl: vision.baseUrl, visionOcrModel: vision.model,
    ...runtime, glossary, glossaryEntries: glossary.entries, glossaryFingerprint,
    ocrConfig: ocr, translationConfig: translation, runtimeConfig: runtime
  };
}
