import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installTranslationCacheLookup } from "../extension/src/background/modules/translation-cache-lookup.js";
import { installPlatformCache } from "../extension/src/background/modules/platform-cache.js";

const CACHE_PREFIX = "mt_cache_v1:";

function makeLookupRuntime(options = {}) {
  const reads = [];
  const runtime = {
    CANONICAL_TRANSLATION_CACHE_PREFIX: "mt_canonical_translation_v1:",
    buildCanonicalTranslationFingerprint: ({ originalText }) => `fp:${originalText}`,
    getErrorMessage: error => String(error && error.message || error),
    async getCacheMany(keys) {
      reads.push([...keys]);
      if (options.failRead) throw new Error("storage unavailable");
      return options.values || new Map();
    }
  };
  installTranslationCacheLookup(runtime);
  return { runtime, reads };
}

test("批量缓存查询用一次读取覆盖整页气泡", async () => {
  const values = new Map([["mt_canonical_translation_v1:fp:안녕", { translatedText: "你好" }]]);
  const { runtime, reads } = makeLookupRuntime({ values });

  const entries = await runtime.lookupCanonicalTranslationCache({
    items: [{ id: "c1", revision: 1, original_text: "안녕" }, { id: "c2", revision: 1, original_text: "잘가" }],
    fingerprintArgs: { targetLanguage: "zh-CN" }
  });

  assert.equal(reads.length, 1, "只允许一次存储读取");
  assert.deepEqual(reads[0], ["mt_canonical_translation_v1:fp:안녕", "mt_canonical_translation_v1:fp:잘가"]);
  assert.equal(entries[0].cached.translatedText, "你好");
  assert.equal(entries[1].cached, null);
  assert.equal(entries[0].translationFingerprint, "fp:안녕");
});

test("force 与空列表不读存储", async () => {
  const forced = makeLookupRuntime();
  await forced.runtime.lookupCanonicalTranslationCache({
    items: [{ id: "c1", original_text: "안녕" }],
    force: true,
    fingerprintArgs: {}
  });
  assert.deepEqual(forced.reads, []);

  const empty = makeLookupRuntime();
  assert.deepEqual(await empty.runtime.lookupCanonicalTranslationCache({ items: [], fingerprintArgs: {} }), []);
  assert.deepEqual(empty.reads, []);
});

test("批量读失败按未命中处理，不挡住翻译", async () => {
  const { runtime } = makeLookupRuntime({ failRead: true });
  const entries = await runtime.lookupCanonicalTranslationCache({
    items: [{ id: "c1", original_text: "안녕" }],
    fingerprintArgs: {}
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cached, null);
});

test("getCacheMany 一次读取并清理过期条目", async () => {
  const removed = [];
  const now = Date.now();
  const runtime = {
    CACHE_TTL_MS: 1000,
    CACHE_PREFIX,
    storageGet: async keys => ({
      [`${CACHE_PREFIX}fresh`]: { timestamp: now, value: { translatedText: "新" } },
      [`${CACHE_PREFIX}stale`]: { timestamp: now - 5000, value: { translatedText: "旧" } },
      [`${CACHE_PREFIX}broken`]: null
    }),
    storageRemove: async keys => removed.push([...keys])
  };
  installPlatformCache(runtime);

  const values = await runtime.getCacheMany([`${CACHE_PREFIX}fresh`, `${CACHE_PREFIX}stale`, `${CACHE_PREFIX}broken`, `${CACHE_PREFIX}fresh`]);

  assert.equal(values.size, 1);
  assert.deepEqual(values.get(`${CACHE_PREFIX}fresh`), { translatedText: "新" });
  assert.deepEqual(removed, [[`${CACHE_PREFIX}stale`]]);
});

function makeCacheWriteRuntime(options = {}) {
  const writes = [];
  const removed = [];
  let failed = false;
  const runtime = {
    CACHE_TTL_MS: 1000,
    CACHE_PREFIX,
    OCR_CACHE_PREFIX: "mt_ocr_v1:",
    TRANSLATION_CACHE_KEY_RE: /^mt_cache_v1:/,
    getErrorMessage: error => String(error && error.message || error),
    storageSet: async payload => {
      if (options.failOnce && !failed) {
        failed = true;
        throw new Error(options.quota ? "QUOTA_BYTES exceeded" : "storage broken");
      }
      writes.push(payload);
    },
    storageRemove: async keys => removed.push([...keys]),
    storageGet: async () => ({ [`${CACHE_PREFIX}old`]: { timestamp: 1, value: {} } })
  };
  installPlatformCache(runtime);
  return { runtime, writes, removed };
}

test("setCacheMany 一次写完全部条目", async () => {
  const { runtime, writes } = makeCacheWriteRuntime();

  const ok = await runtime.setCacheMany([
    [`${CACHE_PREFIX}block:1`, { translatedText: "一", cleanedImage: "data:image/png;base64,AAAA", debug: { heavy: true } }],
    ["mt_ocr_v1:abc", { items: [], cleanedImage: "data:image/png;base64,BBBB" }],
    ["", { ignored: true }]
  ]);

  assert.equal(ok, true);
  assert.equal(writes.length, 1, "只允许一次 storageSet");
  assert.deepEqual(Object.keys(writes[0]).sort(), [`${CACHE_PREFIX}block:1`, "mt_ocr_v1:abc"]);
  assert.equal(typeof writes[0][`${CACHE_PREFIX}block:1`].timestamp, "number");
  // 缓存写入必须走 setCache 同一套瘦身逻辑：去掉清理图与逐阶段调试数据。
  assert.deepEqual(writes[0][`${CACHE_PREFIX}block:1`].value, { translatedText: "一" });
  assert.deepEqual(writes[0]["mt_ocr_v1:abc"].value, { items: [] });
});

test("setCacheMany 遇到配额错误先清译文缓存再重试", async () => {
  const { runtime, writes, removed } = makeCacheWriteRuntime({ failOnce: true, quota: true });

  const ok = await runtime.setCacheMany([[`${CACHE_PREFIX}block:1`, { translatedText: "一" }]]);

  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(removed, [[`${CACHE_PREFIX}old`]]);
});

test("setCacheMany 非配额错误只记日志，不让翻译失败", async () => {
  const { runtime, writes } = makeCacheWriteRuntime({ failOnce: true, quota: false });

  const ok = await runtime.setCacheMany([[`${CACHE_PREFIX}block:1`, { translatedText: "一" }]]);

  assert.equal(ok, false);
  assert.deepEqual(writes, []);
});

test("canonical 结算路径不再逐条 await 缓存写", () => {
  const source = readFileSync(new URL("../extension/src/background/modules/translation-provider.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /await runtime\.setCache\(entry\.cacheKey/u);
  assert.match(source, /void runtime\.setCacheMany\(cacheWrites\)/u);
});
