import assert from "node:assert/strict";
import test from "node:test";
import languages from "../extension/src/shared/languages.js";

test("language defaults and aliases normalize to auto → zh-CN", () => {
  assert.equal(languages.normalizeSourceLanguage(), "auto");
  assert.equal(languages.normalizeTargetLanguage(), "zh-CN");
  assert.equal(languages.normalizeSourceLanguage("korean"), "ko");
  assert.equal(languages.normalizeTargetLanguage("zh-Hant"), "zh-TW");
});

test("recognized comic language overrides OCR/global settings and text detection is the fallback", () => {
  assert.equal(languages.resolveSourceLanguage("ko", "日本語です", "ja"), "ja");
  assert.equal(languages.resolveSourceLanguage("ja", "한국어입니다", "ko"), "ko");
  assert.equal(languages.resolveSourceLanguage("ko", "日本語です"), "ko");
  assert.equal(languages.resolveSourceLanguage("auto", "한국어입니다"), "ko");
  assert.equal(languages.ocrLanguageToTranslationLanguage("japan", "ko"), "ja");
  assert.equal(languages.ocrLanguageToTranslationLanguage("auto", "ko"), "ko");
  assert.equal(languages.ocrLanguageToTranslationLanguage("ch"), "zh-CN");
  assert.equal(languages.ocrLanguageToTranslationLanguage("chinese_cht"), "zh-TW");
  assert.equal(languages.translationLanguageToOcrLanguage("auto"), "auto");
  assert.equal(languages.translationLanguageToOcrLanguage("ja"), "japan");
  assert.equal(languages.translationLanguageToOcrLanguage("ko"), "korean");
  assert.equal(languages.translationLanguageToOcrLanguage("en"), "en");
  assert.equal(languages.translationLanguageToOcrLanguage("zh-CN"), "ch");
  assert.equal(languages.translationLanguageToOcrLanguage("zh-TW"), "chinese_cht");
  assert.equal(languages.resolveSourceLanguage("auto", "", "chinese_cht"), "zh-TW");
  assert.equal(languages.ocrLanguageToTranslationLanguage("ch"), "zh-CN");
  assert.equal(languages.ocrLanguageToTranslationLanguage("chinese_cht"), "zh-TW");
  assert.equal(languages.translationLanguageToOcrLanguage("auto"), "auto");
  assert.equal(languages.translationLanguageToOcrLanguage("ja"), "japan");
  assert.equal(languages.translationLanguageToOcrLanguage("ko"), "korean");
  assert.equal(languages.translationLanguageToOcrLanguage("en"), "en");
  assert.equal(languages.translationLanguageToOcrLanguage("zh-CN"), "ch");
  assert.equal(languages.translationLanguageToOcrLanguage("zh-TW"), "chinese_cht");
  assert.equal(languages.resolveSourceLanguage("auto", "", "chinese_cht"), "zh-TW");
});

test("same-language validation permits only genuinely different language tags", () => {
  assert.equal(languages.isSameLanguagePair("ko", "ko"), true);
  assert.equal(languages.isSameLanguagePair("auto", "ko"), false);
  assert.equal(languages.isSameLanguagePair("zh-TW", "zh-CN"), false);
});
