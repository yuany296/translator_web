const SOURCE_LANGUAGES = Object.freeze(["auto", "ko", "ja", "en", "zh-CN", "zh-TW"]);
const TARGET_LANGUAGES = Object.freeze(["zh-CN", "zh-TW", "en", "ja", "ko"]);

const LANGUAGE_NAMES = Object.freeze({
  auto: "auto-detected source language",
  ko: "Korean",
  ja: "Japanese",
  en: "English",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese"
});

function normalizeLanguage(value, fallback, allowed) {
  const raw = String(value || "").trim();
  const aliases = {
    korean: "ko", "ko-KR": "ko", ko_KR: "ko",
    japan: "ja", japanese: "ja", "ja-JP": "ja", ja_JP: "ja",
    english: "en", "en-US": "en", en_US: "en",
    zh: "zh-CN", ch: "zh-CN", "zh-Hans": "zh-CN", zh_CN: "zh-CN",
    chinese_cht: "zh-TW", "zh-Hant": "zh-TW", zh_TW: "zh-TW"
  };
  const normalized = aliases[raw] || raw;
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeSourceLanguage(value, fallback = "auto") {
  return normalizeLanguage(value, fallback, SOURCE_LANGUAGES);
}

function normalizeTargetLanguage(value, fallback = "zh-CN") {
  return normalizeLanguage(value, fallback, TARGET_LANGUAGES);
}

function languageName(value) {
  return LANGUAGE_NAMES[value] || String(value || "auto");
}

function isSameLanguagePair(sourceLanguage, targetLanguage) {
  const source = normalizeSourceLanguage(sourceLanguage);
  const target = normalizeTargetLanguage(targetLanguage);
  return source !== "auto" && source === target;
}

function ocrLanguageToTranslationLanguage(value, fallback = "auto") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "japan" || normalized === "japanese" || normalized === "ja") return "ja";
  if (normalized === "korean" || normalized === "ko") return "ko";
  if (normalized === "en" || normalized === "english") return "en";
  if (normalized === "ch" || normalized === "zh" || normalized === "zh-cn") return "zh-CN";
  if (normalized === "chinese_cht" || normalized === "zh-tw") return "zh-TW";
  return normalizeSourceLanguage(fallback);
}

function translationLanguageToOcrLanguage(value) {
  const normalized = normalizeSourceLanguage(value);
  const mapping = {
    auto: "auto",
    ko: "korean",
    ja: "japan",
    en: "en",
    "zh-CN": "ch",
    "zh-TW": "chinese_cht"
  };
  return mapping[normalized] || "auto";
}

function languagePairKey(sourceLanguage, targetLanguage) {
  return `${normalizeSourceLanguage(sourceLanguage)}>${normalizeTargetLanguage(targetLanguage)}`;
}

function resolveSourceLanguage(configured, text = "", recognized = "") {
  const recognizedLanguage = normalizeSourceLanguage(recognized, "auto");
  if (recognizedLanguage !== "auto") return recognizedLanguage;
  const configuredLanguage = normalizeSourceLanguage(configured);
  if (configuredLanguage !== "auto") return configuredLanguage;
  const value = String(text || "");
  if (/[\uac00-\ud7af]/u.test(value)) return "ko";
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\u3400-\u9fff]/u.test(value)) {
    const traditional = /[這個們為與還來說時會裡後發國門體學書車開關點]/u.test(value);
    return traditional ? "zh-TW" : "zh-CN";
  }
  if (/[a-z]/iu.test(value)) return "en";
  return "auto";
}

export default Object.freeze({
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  LANGUAGE_NAMES,
  normalizeSourceLanguage,
  normalizeTargetLanguage,
  languageName,
  isSameLanguagePair,
  ocrLanguageToTranslationLanguage,
  translationLanguageToOcrLanguage,
  languagePairKey,
  resolveSourceLanguage
});
