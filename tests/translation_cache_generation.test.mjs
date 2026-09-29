import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installTranslationCacheGeneration } from "../extension/src/background/modules/translation-cache-generation.js";
import { installTranslationCacheLookup } from "../extension/src/background/modules/translation-cache-lookup.js";

const RETIRED = "mt_cache_v22:translation:";
const CURRENT = "mt_cache_v29:translation:";
const OCR = "mt_cache_v28:ocr:";

function makeRuntime(store, options = {}) {
  const removed = [];
  let reads = 0;
  const runtime = {
    CANONICAL_TRANSLATION_CACHE_PREFIX: CURRENT,
    RETIRED_TRANSLATION_CACHE_PREFIXES: Object.freeze([RETIRED]),
    OCR_CACHE_PREFIX: OCR,
    TRANSLATION_CACHE_KEY_RE: /^mt_cache_v\d+:/,
    CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    getErrorMessage: error => String(error && error.message || error),
    async storageGet(keys) {
      reads += 1;
      if (options.failRead) throw new Error("storage unavailable");
      if (keys === null) return { ...store };
      const picked = {};
      for (const key of keys || []) if (key in store) picked[key] = store[key];
      return picked;
    },
    async storageRemove(keys) {
      for (const key of keys || []) delete store[key];
      removed.push([...keys]);
    }
  };
  installTranslationCacheGeneration(runtime);
  return { runtime, removed, readCount: () => reads };
}

test("退役代次的键在首次查询前被清掉，当前代次与 OCR 缓存不受影响", async () => {
  const store = {
    [`${RETIRED}old`]: { timestamp: Date.now(), value: { translatedText: "游乐设施" } },
    [`${CURRENT}fresh`]: { timestamp: Date.now(), value: { translatedText: "听说游乐设施指南里包含这个主题公园的相关内容。" } },
    [`${OCR}page`]: { timestamp: Date.now(), value: { items: [] } }
  };
  const { runtime, removed } = makeRuntime(store);

  const result = await runtime.pruneRetiredTranslationCache();

  assert.equal(result.removed, 1);
  assert.deepEqual(removed, [[`${RETIRED}old`]]);
  assert.deepEqual(Object.keys(store).sort(), [`${OCR}page`, `${CURRENT}fresh`].sort());
});

test("清理是幂等的：一个生命周期只扫一次存储", async () => {
  const store = { [`${RETIRED}old`]: { timestamp: Date.now(), value: { translatedText: "游乐设施" } } };
  const { runtime, readCount } = makeRuntime(store);

  await Promise.all([runtime.pruneRetiredTranslationCache(), runtime.pruneRetiredTranslationCache()]);
  await runtime.pruneRetiredTranslationCache();

  assert.equal(readCount(), 1);
});

test("清理失败不抛出，也不挡住后续翻译", async () => {
  const { runtime } = makeRuntime({}, { failRead: true });

  const result = await runtime.pruneRetiredTranslationCache();

  assert.equal(result.ok, false);
  assert.match(result.error, /storage unavailable/u);
});

test("体检报告区分退役残留、当前代次与可疑短值", async () => {
  const store = {
    [`${RETIRED}old`]: { timestamp: Date.now(), value: { translatedText: "游乐设施" } },
    [`${CURRENT}good`]: { timestamp: Date.now(), value: { translatedText: "这是完整的一句译文。" } },
    [`${CURRENT}short`]: { timestamp: Date.now(), value: { translatedText: "游乐设施" } },
    [`${OCR}page`]: { timestamp: Date.now(), value: { items: [] } }
  };
  const { runtime } = makeRuntime(store);

  const report = await runtime.auditTranslationCache();

  assert.equal(report.ok, true);
  assert.equal(report.retiredRemaining, 1);
  assert.equal(report.canonicalTranslation, 2);
  assert.equal(report.ocr, 1);
  assert.deepEqual(report.suspects, [{ length: 4, translatedText: "游乐设施" }]);
});

test("canonical 查询入口会在命中之前触发退役清理", async () => {
  const store = { [`${RETIRED}old`]: { timestamp: Date.now(), value: { translatedText: "游乐设施" } } };
  const { runtime, removed } = makeRuntime(store);
  runtime.buildCanonicalTranslationFingerprint = ({ originalText }) => `fp:${originalText}`;
  runtime.getCacheMany = async () => new Map();
  installTranslationCacheLookup(runtime);

  await runtime.lookupCanonicalTranslationCache({ items: [{ id: "c1", original_text: "안녕" }], fingerprintArgs: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(removed, [[`${RETIRED}old`]]);
});

test("控制台助手真的挂到了 globalThis，而不是只定义在 installer 里", async () => {
  const { runtime } = makeRuntime({});
  delete globalThis.__mtCacheAudit;

  runtime.exposeTranslationCacheConsoleHelper();

  assert.equal(typeof globalThis.__mtCacheAudit, "function");
  assert.equal(typeof globalThis.__mtPruneCache, "function");
  delete globalThis.__mtCacheAudit;
  delete globalThis.__mtPruneCache;
});

test("bootstrap 会显式暴露 OCR 计时与缓存体检两个控制台入口", () => {
  const source = readFileSync(new URL("../extension/src/background/modules/bootstrap.js", import.meta.url), "utf8");
  assert.match(source, /runtime\.exposeOcrTimingsConsoleHelper\?\.\(\)/u);
  assert.match(source, /runtime\.exposeTranslationCacheConsoleHelper\?\.\(\)/u);
  assert.match(source, /runtime\.exposeTranslationDiagnosticsConsoleHelper\?\.\(\)/u);
});
