import assert from "node:assert/strict";
import test from "node:test";
import { installComicTranslationStore } from "../extension/src/background/modules/comic-translation-store.js";

function runtime(overrides = {}) {
  const value = {
    normalizeTranslationSourceText: text => String(text).normalize("NFC").trim(),
    stableHash128: text => `hash:${String(text)}`,
    canonicalTranslationItemKey: item => `${item.id}@${item.revision || 1}`,
    ...overrides
  };
  installComicTranslationStore(value);
  return value;
}

test("comic record identity includes stable scope, block, source hash and language pair", () => {
  const api = runtime();
  const item = { id: "canonical-1", revision: 2, original_text: "원문" };
  const korean = api.buildComicTranslationDescriptors([item], "ko", "zh-CN", {
    scopeKey: "comic:chapter", workId: "work", chapterId: "chapter", imageHash: "image-a"
  })[0];
  const japanese = api.buildComicTranslationDescriptors([item], "ja", "zh-CN", {
    scopeKey: "comic:chapter", workId: "work", chapterId: "chapter", imageHash: "image-a"
  })[0];
  assert.notEqual(korean.recordKey, japanese.recordKey);
  assert.equal(korean.payload.segmentKey, "canonical-1");
  assert.equal(korean.payload.recovery.imageHash, "image-a");
  assert.equal(korean.payload.resolvedSourceLanguage, "ko");
});

test("comic cache can serve an official IndexedDB snapshot while SQLite is offline", async () => {
  let queries = 0;
  const api = runtime({
    getTranslationCacheRecords: async keys => new Map([[keys[0], {
      id: keys[0], recordId: "record-1", recordKey: keys[0], translatedText: "缓存译文",
      translationConfigFingerprint: "fp"
    }]]),
    syncTranslationService: async () => { queries += 1; return { ok: false, error: "offline" }; },
    deleteTranslationCacheRecord: async () => ({ ok: true })
  });
  const descriptor = api.buildComicTranslationDescriptors([
    { id: "c1", revision: 1, original_text: "원문" }
  ], "ko", "zh-CN", { scopeKey: "comic:chapter" });
  const loaded = await api.loadOfficialComicTranslations(descriptor);
  assert.equal(loaded.online, false);
  assert.equal(loaded.outcome.get("c1@1").translatedText, "缓存译文");
  assert.equal(queries, 1);
});
