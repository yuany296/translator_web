import assert from "node:assert/strict";
import test from "node:test";
import cacheCore from "../extension/src/shared/translation-cache.js";

test("normalizePageKey strips hash, drops tracking params, sorts the rest", () => {
  assert.equal(
    cacheCore.normalizePageKey("https://example.com/a?b=2&utm_source=x&a=1&gclid=abc#section"),
    "https://example.com/a?a=1&b=2"
  );
  assert.equal(
    cacheCore.normalizePageKey("https://example.com/a?a=1&b=2"),
    "https://example.com/a?a=1&b=2"
  );
  // 无查询参数时没有尾部 ?
  assert.equal(cacheCore.normalizePageKey("https://example.com/a?utm_source=x"), "https://example.com/a");
  // fbclid / msclkid / yclid 也是纯跟踪参数
  assert.equal(
    cacheCore.normalizePageKey("https://example.com/a?fbclid=1&msclkid=2&yclid=3&real=1"),
    "https://example.com/a?real=1"
  );
  // 可能决定内容的参数保留
  assert.equal(
    cacheCore.normalizePageKey("https://example.com/a?episode=7&page=2"),
    "https://example.com/a?episode=7&page=2"
  );
});

test("Kakao root and menu pages are different pageKeys (paths differ)", () => {
  assert.notEqual(
    cacheCore.normalizePageKey("https://page.kakao.com/"),
    cacheCore.normalizePageKey("https://page.kakao.com/menu/10010/")
  );
});

test("normalizePageKey is order-insensitive for query parameters", () => {
  assert.equal(
    cacheCore.normalizePageKey("https://example.com/a?x=1&y=2"),
    cacheCore.normalizePageKey("https://example.com/a?y=2&x=1")
  );
});

test("buildBindingKey is stable across scans and sensitive to container and index", () => {
  const base = { pageKey: "https://example.com/a", sourceHash: "abc12345" };
  const first = cacheCore.buildBindingKey({ ...base, containerSignature: "sig-nav", localIndex: 0 });
  assert.equal(cacheCore.buildBindingKey({ ...base, containerSignature: "sig-nav", localIndex: 0 }), first);
  // 容器内局部序号不同 → 不同 bindingKey
  assert.notEqual(cacheCore.buildBindingKey({ ...base, containerSignature: "sig-nav", localIndex: 1 }), first);
  // 语义容器不同 → 不同 bindingKey（同页同文不同容器不复用）
  assert.notEqual(cacheCore.buildBindingKey({ ...base, containerSignature: "sig-dialog", localIndex: 0 }), first);
  // 页面不同 → 不同 bindingKey
  assert.notEqual(cacheCore.buildBindingKey({ ...base, pageKey: "https://example.com/b", containerSignature: "sig-nav", localIndex: 0 }), first);
});

test("buildTranslationKey enables cross-page reuse; context fingerprint separates short strings", () => {
  const base = { normalized: "Open", sourceLanguage: "ko", targetLanguage: "zh-CN" };
  // 不同页面、相同上下文 → 相同 translationKey（跨页面复用）
  assert.equal(
    cacheCore.buildTranslationKey({ ...base, contextFingerprint: "ctx-menu" }),
    cacheCore.buildTranslationKey({ ...base, contextFingerprint: "ctx-menu" })
  );
  // 上下文指纹不同 → 不同 translationKey（"Open" 不跨上下文误复用）
  assert.notEqual(
    cacheCore.buildTranslationKey({ ...base, contextFingerprint: "ctx-menu" }),
    cacheCore.buildTranslationKey({ ...base, contextFingerprint: "ctx-dialog" })
  );
  // 语言对不同 → 不同 translationKey
  assert.notEqual(
    cacheCore.buildTranslationKey({ ...base, contextFingerprint: "ctx-menu" }),
    cacheCore.buildTranslationKey({ ...base, sourceLanguage: "ja", contextFingerprint: "ctx-menu" })
  );
});

test("buildWebpageRecordIdFromBinding differs from legacy id", () => {
  const binding = {
    bindingKey: "bind-1", sourceHash: "abc12345", sourceLanguage: "ko", targetLanguage: "zh-CN"
  };
  const newId = cacheCore.buildWebpageRecordIdFromBinding(binding);
  assert.equal(cacheCore.buildWebpageRecordIdFromBinding(binding), newId, "确定性的新键");
  const legacy = cacheCore.buildWebpageRecordId(
    "https://example.com/a", "seg-1", "abc12345", "ko", "zh-CN"
  );
  assert.notEqual(newId, legacy, "新旧记录键不同，旧记录通过双读访问");
});

test("record normalize keeps bindingKey/translationKey for webpage mode", () => {
  const record = cacheCore.normalizeRecord({
    id: "r1", mode: "webpage", sourceText: "안녕", translatedText: "你好",
    versions: [{ id: "v1", translatedText: "你好", createdAt: 1 }],
    pageKey: "https://example.com/a", bindingKey: "bk", translationKey: "tk", containerSignature: "sig"
  });
  assert.equal(record.bindingKey, "bk");
  assert.equal(record.translationKey, "tk");
  assert.equal(record.containerSignature, "sig");
  // 旧记录缺字段时默认空字符串，双读仍可用
  const legacy = cacheCore.normalizeRecord({
    id: "r2", mode: "webpage", sourceText: "안녕", translatedText: "你好",
    versions: [{ id: "v2", translatedText: "你好", createdAt: 1 }],
    pageKey: "https://example.com/a"
  });
  assert.equal(legacy.bindingKey, "");
  assert.equal(legacy.translationKey, "");
});

test("buildContextFingerprint uses adjacent text and semantic region", () => {
  assert.equal(cacheCore.buildContextFingerprint({}), undefined);
  const withRegion = cacheCore.buildContextFingerprint({ semanticRegion: "sig-nav" });
  assert.ok(withRegion);
  assert.equal(cacheCore.buildContextFingerprint({ semanticRegion: "sig-nav" }), withRegion);
  assert.notEqual(
    cacheCore.buildContextFingerprint({ previousText: "A", nextText: "B", semanticRegion: "sig-nav" }),
    withRegion
  );
});

test("manual and pinned versions keep priority over bindingKey migration", () => {
  const record = cacheCore.normalizeRecord({
    id: "old", mode: "webpage", sourceText: "원문", translatedText: "手动版",
    versions: [
      { id: "api", translatedText: "AI 版", source: "api", createdAt: 10 },
      { id: "manual", translatedText: "手动版", source: "manual", manual: true, createdAt: 5 }
    ],
    pageKey: "https://example.com/a"
  });
  const active = cacheCore.pickActiveVersion(record);
  assert.equal(active.translatedText, "手动版", "手动版优先于更新的 AI 版");
  const migrated = { ...record, id: "new", bindingKey: "bk", translationKey: "tk" };
  const renormalized = cacheCore.normalizeRecord(migrated);
  assert.equal(renormalized.id, "new");
  assert.equal(cacheCore.pickActiveVersion(renormalized).translatedText, "手动版", "迁移保留全部版本与优先级");
});
