import { hasTraditionalOnlyChar } from "./traditional-chinese.js";

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

/**
 * 语言码别名表：同一门语言的方言化写法收敛到规范短码。
 *
 * 这张表是**跨端契约**：本地服务 `glossary_store/common.py#normalize_tgt_lng` 会把
 * `ja` 升格成 `ja-JP` 落库并原样回传，所以扩展侧读入与比较时必须能折回 `ja`，
 * 否则 `entry.targetLanguage === targetLanguage` 永远不成立
 * （历史 bug：日语/韩语/英语目标下，同步过的词条整库被静默滤掉）。
 */
const LANGUAGE_ALIASES = Object.freeze({
  korean: "ko", "ko-KR": "ko", ko_KR: "ko",
  japan: "ja", japanese: "ja", "ja-JP": "ja", ja_JP: "ja",
  english: "en", "en-US": "en", en_US: "en",
  zh: "zh-CN", ch: "zh-CN", "zh-Hans": "zh-CN", zh_CN: "zh-CN",
  chinese_cht: "zh-TW", "zh-Hant": "zh-TW", zh_TW: "zh-TW"
});
// 查表用小写键：`zh-CN` 与 `zh-cn`、`ja-JP` 与 `ja-jp` 必须落到同一个值。
// 先播规范码自身的恒等映射，别名表覆盖在其上。
const LANGUAGE_ALIAS_LOOKUP = new Map([
  ...[...SOURCE_LANGUAGES, ...TARGET_LANGUAGES].map(code => [code.toLowerCase(), code]),
  ...Object.entries(LANGUAGE_ALIASES).map(([key, value]) => [key.toLowerCase(), value])
]);

/**
 * 只做别名映射，**不套 fallback**：无法识别的码原样返回。
 * 不能复用 normalizeLanguage —— 它会把未知码回落成 zh-CN，
 * 于是「未知语言的词条」会去匹配中文请求。
 */
function canonicalLanguage(value) {
  const raw = String(value || "").trim();
  return LANGUAGE_ALIAS_LOOKUP.get(raw.toLowerCase()) || raw;
}

function canonicalSourceLanguage(value) {
  return canonicalLanguage(value);
}

function canonicalTargetLanguage(value) {
  return canonicalLanguage(value);
}

function normalizeLanguage(value, fallback, allowed) {
  const normalized = canonicalLanguage(value);
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

const TARGET_LANGUAGE_LABELS = Object.freeze({
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  en: "English (英语)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)"
});

function describeTargetLanguage(value) {
  const key = normalizeTargetLanguage(value);
  return TARGET_LANGUAGE_LABELS[key] || key;
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
    // 繁体专用字集合的唯一定义在 shared/traditional-chinese.js：以前这里另有一份
    // 18 字小表，于是「含 嗎/沒/見/問/聽 的文本」在语言判定里被当成 zh-CN，
    // 在手机版字形兜底里却被当成繁体 —— 同一个问题两个答案。
    return hasTraditionalOnlyChar(value) ? "zh-TW" : "zh-CN";
  }
  if (/[a-z]/iu.test(value)) return "en";
  return "auto";
}

export default Object.freeze({
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  LANGUAGE_NAMES,
  LANGUAGE_ALIASES,
  canonicalSourceLanguage,
  canonicalTargetLanguage,
  normalizeSourceLanguage,
  normalizeTargetLanguage,
  languageName,
  describeTargetLanguage,
  isSameLanguagePair,
  ocrLanguageToTranslationLanguage,
  translationLanguageToOcrLanguage,
  languagePairKey,
  resolveSourceLanguage
});
