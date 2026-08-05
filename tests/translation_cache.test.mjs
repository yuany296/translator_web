import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import cacheCore from "../extension/src/shared/translation-cache.js";
import { installTranslationCacheClient } from "../extension/src/content/modules/translation-cache-client.js";

const root = path.resolve(import.meta.dirname, "..");

function makeClientRuntime() {
  const sent = [];
  const responses = {};
  const runtime = {
    state: {},
    sendRuntimeMessage: async message => {
      sent.push(message);
      if (typeof responses[message.type] === "function") return responses[message.type](message);
      if (responses[message.type] !== undefined) return responses[message.type];
      return { ok: false, error: "no mock" };
    },
    getErrorMessage: error => String(error && error.message || error),
    setResponse: (type, value) => {
      responses[type] = value;
    },
    getSent: () => sent
  };
  installTranslationCacheClient(runtime);
  return runtime;
}

test("cache source contains no literal NUL bytes", () => {
  const source = fs.readFileSync(path.join(root, "extension", "src", "shared", "translation-cache.js"), "utf8");
  let nul = 0;
  for (const ch of source) if (ch.charCodeAt(0) === 0) nul += 1;
  assert.equal(nul, 0);
  assert.match(source, /join\("\\u0000"\)/u);
});

test("normalizeSourceText is stable and whitespace-safe", () => {
  assert.equal(cacheCore.normalizeSourceText("  가\t나\n 다  "), "가 나\n 다");
  assert.equal(cacheCore.normalizeSourceText("a\r\nb"), "a\nb");
  assert.equal(cacheCore.normalizeSourceText("  "), "");
  assert.equal(cacheCore.normalizeSourceText("문장\n둘째 줄"), "문장\n둘째 줄");
});

test("computeSourceHash is deterministic across calls and sensitive to text", () => {
  const text = "성현이 들어왔다.";
  const hash = cacheCore.computeSourceHash(cacheCore.normalizeSourceText(text));
  assert.equal(cacheCore.computeSourceHash(cacheCore.normalizeSourceText(text)), hash);
  assert.notEqual(cacheCore.computeSourceHash(cacheCore.normalizeSourceText("성현이 나갔다.")), hash);
  assert.match(hash, /^[0-9a-f]{8}$/u);
});

test("novel record ids pin workId + chapterId + sourceHash only", () => {
  const first = cacheCore.buildNovelRecordId("65171279", "70081892", "aabbccdd");
  const again = cacheCore.buildNovelRecordId("65171279", "70081892", "aabbccdd");
  const otherChapter = cacheCore.buildNovelRecordId("65171279", "99999999", "aabbccdd");
  assert.equal(first, again);
  assert.notEqual(first, otherChapter);
});

test("webpage record ids ignore selectorHint and textIndex (stable across re-scans)", () => {
  const withHint = cacheCore.createRecordId({
    mode: "webpage", pageKey: "https://example.com/a", selectorHint: "p", textIndex: 3, sourceHash: "abc12345"
  });
  const withoutHint = cacheCore.createRecordId({
    mode: "webpage", pageKey: "https://example.com/a", selectorHint: "", textIndex: 0, sourceHash: "abc12345"
  });
  const otherPage = cacheCore.createRecordId({
    mode: "webpage", pageKey: "https://other.com/x", selectorHint: "p", textIndex: 3, sourceHash: "abc12345"
  });
  assert.equal(withHint, withoutHint);
  assert.notEqual(withHint, otherPage);
});

test("normalizeRecord keeps per-mode fields and version priority metadata", () => {
  const record = cacheCore.normalizeRecord({
    id: "novel-1",
    mode: "novel",
    workId: "w1",
    chapterId: "c1",
    paragraphIndex: 7,
    paragraphKey: "p-7",
    sourceText: "원문",
    normalizedSourceText: "원문",
    sourceHash: "aaaa1111",
    translatedText: "译文",
    versions: [
      { id: "v2", translatedText: "新译文", source: "api", createdAt: 200 },
      { id: "v1", translatedText: "旧译文", source: "api", createdAt: 100 }
    ],
    createdAt: 50,
    updatedAt: 200
  });
  assert.equal(record.mode, "novel");
  assert.equal(record.workId, "w1");
  assert.equal(record.chapterId, "c1");
  assert.equal(record.paragraphIndex, 7);
  assert.equal(record.paragraphKey, "p-7");
  assert.equal(record.versions.length, 2);
});

test("pickActiveVersion honors manual > pinned > latest api", () => {
  const apiLatest = cacheCore.normalizeRecord({
    id: "r", mode: "novel", sourceText: "s", sourceHash: "h",
    versions: [
      { id: "a", translatedText: "A", source: "api", createdAt: 300 },
      { id: "b", translatedText: "B", source: "api", createdAt: 200 }
    ]
  });
  assert.equal(cacheCore.pickActiveVersion(apiLatest).translatedText, "A");

  const pinned = cacheCore.normalizeRecord({
    id: "r", mode: "novel", sourceText: "s", sourceHash: "h",
    versions: [
      { id: "a", translatedText: "A", source: "api", createdAt: 400, pinned: true },
      { id: "b", translatedText: "B", source: "api", createdAt: 300 }
    ]
  });
  assert.equal(cacheCore.pickActiveVersion(pinned).translatedText, "A");

  const manual = cacheCore.normalizeRecord({
    id: "r", mode: "novel", sourceText: "s", sourceHash: "h",
    versions: [
      { id: "a", translatedText: "A", source: "api", createdAt: 400, pinned: true },
      { id: "m", translatedText: "手改", source: "manual", createdAt: 100, manual: true }
    ]
  });
  assert.equal(cacheCore.pickActiveVersion(manual).translatedText, "手改");
});

test("client builds records with version stacking and keeps previous versions", () => {
  const runtime = makeClientRuntime();
  const first = runtime.buildTranslationCacheRecord("novel", {
    workId: "w1", chapterId: "c1", sourceText: "원문", normalizedSourceText: "원문", sourceHash: "abc12345"
  }, "第一版");
  assert.equal(first.mode, "novel");
  assert.equal(first.versions.length, 1);
  const second = runtime.buildTranslationCacheRecord("novel", {
    workId: "w1", chapterId: "c1", sourceText: "원문", normalizedSourceText: "원문", sourceHash: "abc12345"
  }, "第二版", first.versions);
  assert.equal(second.versions.length, 2);
  assert.equal(second.translatedText, "第二版");
  assert.ok(second.versions.some(v => v.translatedText === "第一版"), "old version is retained");
});

test("client retranslateCacheRecord keeps at least the previous AI version", () => {
  const runtime = makeClientRuntime();
  const base = runtime.buildTranslationCacheRecord("webpage", {
    pageKey: "https://x", sourceText: "hello", normalizedSourceText: "hello", sourceHash: "h1"
  }, "第一版");
  const retranslated = runtime.retranslateCacheRecord(base, "第二版");
  assert.equal(retranslated.translatedText, "第二版");
  assert.ok(retranslated.versions.some(v => v.translatedText === "第一版"));
  assert.equal(retranslated.versions[0].translatedText, "第二版");
});

test("client batch get merges memory cache and background responses", async () => {
  const runtime = makeClientRuntime();
  const stored = {
    "id-1": cacheCore.normalizeRecord({
      id: "id-1", mode: "webpage", pageKey: "https://x", sourceText: "s1", sourceHash: "h1",
      translatedText: "译文一", translationSource: "api",
      versions: [{ id: "v", translatedText: "译文一", source: "api", createdAt: 1 }]
    })
  };
  runtime.setResponse("GET_TRANSLATION_CACHE_BATCH", { ok: true, records: stored });
  const records = await runtime.getTranslationCacheRecords(["id-1", "id-2"]);
  assert.equal(records.get("id-1").translatedText, "译文一");
  assert.equal(records.size, 1);
  // memory cache serves the second call without a message
  const before = runtime.getSent().length;
  await runtime.getTranslationCacheRecords(["id-1"]);
  assert.equal(runtime.getSent().length, before);
});

test("webpage fallback cache lookup uses one batched background message", async () => {
  const runtime = makeClientRuntime();
  const entry = {
    id: "new-id", legacyId: "legacy-id", sourceHash: "hash-1", translationKey: "tk-1",
    pageKey: "https://example.com/a", text: "안녕", normalized: "안녕"
  };
  runtime.setResponse("GET_TRANSLATION_CACHE_BATCH", { ok: true, records: {} });
  runtime.setResponse("GET_WEBPAGE_TRANSLATION_CACHE_FALLBACKS", {
    ok: true, bySourceHash: {}, byTranslationKey: {
      "tk-1": [{ id: "old", sourceText: "안녕", normalizedSourceText: "안녕", translatedText: "你好" }]
    }
  });
  const records = await runtime.getWebpageEntryRecords([entry]);
  assert.equal(records.get(entry).translatedText, "你好");
  assert.equal(runtime.getSent().filter(message =>
    message.type === "GET_WEBPAGE_TRANSLATION_CACHE_FALLBACKS").length, 1);
  assert.equal(runtime.getSent().some(message =>
    message.type === "GET_TRANSLATION_CACHE_BY_TRANSLATION_KEY"), false);
});

test("webpage fallback reuses the same source text across pages (no duplicate storage)", async () => {
  const runtime = makeClientRuntime();
  const entry = {
    id: "new-id", legacyId: "legacy-id", sourceHash: "hash-1", translationKey: "tk-different",
    pageKey: "https://example.com/b", text: "나우원", normalized: "나우원"
  };
  runtime.setResponse("GET_TRANSLATION_CACHE_BATCH", { ok: true, records: {} });
  runtime.setResponse("GET_WEBPAGE_TRANSLATION_CACHE_FALLBACKS", {
    ok: true,
    bySourceHash: {
      "hash-1": [{ id: "old-a", pageKey: "https://example.com/a", sourceText: "나우원", normalizedSourceText: "나우원", translatedText: "罗宇元" }]
    },
    byTranslationKey: {}
  });
  const records = await runtime.getWebpageEntryRecords([entry]);
  assert.equal(records.get(entry).translatedText, "罗宇元", "跨页同原文哈希复用，避免重复翻译重复存储");
});

test("config fingerprint: stable for identical configs, sensitive to model/prompt/glossary", () => {
  const base = { provider: "openai", model: "deepseek-chat", targetLanguage: "zh-CN", promptVersion: "webpage-zh-cn-v1", glossaryVersion: "g1" };
  const first = cacheCore.buildTranslationConfigFingerprint(base);
  assert.equal(cacheCore.buildTranslationConfigFingerprint(base), first);
  assert.notEqual(cacheCore.buildTranslationConfigFingerprint({ ...base, model: "gpt-4o" }), first);
  assert.notEqual(cacheCore.buildTranslationConfigFingerprint({ ...base, promptVersion: "canonical-zh-cn-v1" }), first);
  assert.notEqual(cacheCore.buildTranslationConfigFingerprint({ ...base, glossaryVersion: "g2" }), first);
  // 缺省字段有稳定默认值
  assert.equal(cacheCore.buildTranslationConfigFingerprint({}), cacheCore.buildTranslationConfigFingerprint({}));
});

test("config fingerprint never includes secrets", () => {
  const withKey = cacheCore.buildTranslationConfigFingerprint({ model: "m", apiKey: "sk-secret-123" });
  const withoutKey = cacheCore.buildTranslationConfigFingerprint({ model: "m" });
  assert.equal(withKey, withoutKey);
  assert.doesNotMatch(withKey, /sk-secret/u);
});

test("classifyCacheMatch distinguishes exact, stale-config and missing", () => {
  const fingerprint = cacheCore.buildTranslationConfigFingerprint({ model: "m1" });
  const exactRecord = cacheCore.normalizeRecord({
    id: "r", mode: "webpage", sourceText: "s", sourceHash: "h", translatedText: "译",
    translationConfigFingerprint: fingerprint,
    versions: [{ id: "v", translatedText: "译", source: "api", createdAt: 1 }]
  });
  assert.equal(cacheCore.classifyCacheMatch(exactRecord, fingerprint), "exact");
  const staleRecord = cacheCore.normalizeRecord({
    id: "r2", mode: "webpage", sourceText: "s", sourceHash: "h", translatedText: "旧译",
    translationConfigFingerprint: cacheCore.buildTranslationConfigFingerprint({ model: "old-model" }),
    versions: [{ id: "v", translatedText: "旧译", source: "api", createdAt: 1 }]
  });
  assert.equal(cacheCore.classifyCacheMatch(staleRecord, fingerprint), "stale-config");
  assert.equal(cacheCore.classifyCacheMatch(null, fingerprint), "missing");
  const emptyRecord = cacheCore.normalizeRecord({
    id: "r3", mode: "webpage", sourceText: "s", sourceHash: "h", translatedText: "",
    versions: [{ id: "v", translatedText: "", source: "api", createdAt: 1 }]
  });
  assert.equal(cacheCore.classifyCacheMatch(emptyRecord, fingerprint), "missing");
});

test("legacy records without a fingerprint are stale-config, not deleted or missing", () => {
  const fingerprint = cacheCore.buildTranslationConfigFingerprint({ model: "m1" });
  const legacy = cacheCore.normalizeRecord({
    id: "legacy", mode: "novel", workId: "w", chapterId: "c", sourceText: "s", sourceHash: "h",
    translatedText: "旧译文",
    versions: [{ id: "v", translatedText: "旧译文", source: "api", createdAt: 1 }]
  });
  assert.equal(legacy.translationConfigFingerprint, "", "missing fingerprint defaults to empty");
  assert.equal(cacheCore.classifyCacheMatch(legacy, fingerprint), "stale-config");
  // 无 fingerprint 查询（旧链路）时命中视为 exact，可直接使用
  assert.equal(cacheCore.classifyCacheMatch(legacy, ""), "exact");
});

test("normalizeRecord keeps contextFingerprint for webpage records", () => {
  const record = cacheCore.normalizeRecord({
    id: "w1", mode: "webpage", pageKey: "https://x", sourceText: "s", sourceHash: "h",
    translatedText: "译", contextFingerprint: "ctx-abc",
    versions: [{ id: "v", translatedText: "译", source: "api", createdAt: 1 }]
  });
  assert.equal(record.contextFingerprint, "ctx-abc");
  assert.equal(record.translationConfigFingerprint, "");
});

test("buildContextFingerprint is reserved for future context-sensitive caching", () => {
  assert.equal(cacheCore.buildContextFingerprint({}), undefined);
  assert.equal(cacheCore.buildContextFingerprint({ previousText: "" }), undefined);
  const withContext = cacheCore.buildContextFingerprint({ previousText: "上文", nextText: "下文", semanticRegion: "list-item" });
  assert.equal(typeof withContext, "string");
  assert.equal(cacheCore.buildContextFingerprint({ previousText: "上文", nextText: "下文", semanticRegion: "list-item" }), withContext);
  assert.notEqual(cacheCore.buildContextFingerprint({ previousText: "其他" }), withContext);
});

test("versions carry their own config fingerprint; classify uses the active version", () => {
  const fpOld = cacheCore.buildTranslationConfigFingerprint({ model: "old-model" });
  const fpNew = cacheCore.buildTranslationConfigFingerprint({ model: "new-model" });
  const record = cacheCore.normalizeRecord({
    id: "r", mode: "webpage", pageKey: "https://x", sourceText: "s", sourceHash: "h",
    translatedText: "新译", translationConfigFingerprint: fpNew,
    versions: [
      { id: "v-new", translatedText: "新译", source: "api", createdAt: 300, translationConfigFingerprint: fpNew },
      { id: "v-old", translatedText: "旧译", source: "api", createdAt: 200, translationConfigFingerprint: fpOld }
    ]
  });
  assert.equal(record.versions[0].translationConfigFingerprint, fpNew);
  assert.equal(record.versions[1].translationConfigFingerprint, fpOld);
  assert.equal(cacheCore.classifyCacheMatch(record, fpNew), "exact");
  assert.equal(cacheCore.classifyCacheMatch(record, fpOld), "stale-config", "恢复旧版本后按旧版本指纹分类");
});

test("restoring an older version returns that version's fingerprint", () => {
  const fpOld = cacheCore.buildTranslationConfigFingerprint({ model: "m-old" });
  const fpNew = cacheCore.buildTranslationConfigFingerprint({ model: "m-new" });
  const record = cacheCore.normalizeRecord({
    id: "r", mode: "novel", workId: "w", chapterId: "c", sourceText: "s", sourceHash: "h",
    translatedText: "新译",
    versions: [
      { id: "v1", translatedText: "新译", source: "api", createdAt: 300, translationConfigFingerprint: fpNew },
      { id: "v0", translatedText: "旧译", source: "api", createdAt: 100, translationConfigFingerprint: fpOld }
    ]
  });
  // 恢复旧版本 = 把旧版本置为活动版本（手动/pinned 语义由上层决定）；这里验证活动版本指纹
  const manualRestore = cacheCore.normalizeRecord({
    id: "r", mode: "novel", workId: "w", chapterId: "c", sourceText: "s", sourceHash: "h",
    versions: [
      { id: "v0", translatedText: "旧译", source: "api", createdAt: 100, translationConfigFingerprint: fpOld, pinned: true },
      { id: "v1", translatedText: "新译", source: "api", createdAt: 300, translationConfigFingerprint: fpNew }
    ]
  });
  const active = cacheCore.pickActiveVersion(manualRestore);
  assert.equal(active.id, "v0");
  assert.equal(active.translationConfigFingerprint, fpOld, "恢复旧版后能取到该版本自身的指纹");
});

test("manual versions stay highest priority and classify as exact regardless of config", () => {
  const fpNew = cacheCore.buildTranslationConfigFingerprint({ model: "m-new" });
  const record = cacheCore.normalizeRecord({
    id: "r", mode: "webpage", pageKey: "https://x", sourceText: "s", sourceHash: "h",
    translatedText: "手改",
    versions: [
      { id: "v-api", translatedText: "AI 译", source: "api", createdAt: 400, translationConfigFingerprint: fpNew },
      { id: "v-manual", translatedText: "手改", source: "manual", createdAt: 100, manual: true }
    ]
  });
  assert.equal(cacheCore.pickActiveVersion(record).id, "v-manual");
  assert.equal(cacheCore.classifyCacheMatch(record, cacheCore.buildTranslationConfigFingerprint({ model: "other" })), "exact");
});

test("force retranslate adds a new version without mutating old fingerprints", () => {
  const runtime = makeClientRuntime();
  const fpOld = cacheCore.buildTranslationConfigFingerprint({ model: "m-old" });
  const fpNew = cacheCore.buildTranslationConfigFingerprint({ model: "m-new" });
  const first = runtime.buildTranslationCacheRecord("novel", {
    workId: "w1", chapterId: "c1", sourceText: "원문", normalizedSourceText: "원문", sourceHash: "h1", translationConfigFingerprint: fpOld
  }, "第一版", [], { fingerprint: fpOld });
  const forced = runtime.retranslateCacheRecord(first, "第二版", { fingerprint: fpNew });
  assert.equal(forced.translatedText, "第二版");
  assert.equal(forced.versions[0].translationConfigFingerprint, fpNew, "新版本带新指纹");
  assert.equal(forced.versions[1].translationConfigFingerprint, fpOld, "旧版本指纹不被篡改");
  assert.equal(forced.translationConfigFingerprint, fpNew, "顶层指纹跟随活动版本");
});

test("legacy versions without fingerprint classify as stale-config", () => {
  const fp = cacheCore.buildTranslationConfigFingerprint({ model: "m" });
  const legacy = cacheCore.normalizeRecord({
    id: "r", mode: "novel", workId: "w", chapterId: "c", sourceText: "s", sourceHash: "h",
    translatedText: "旧译文",
    versions: [{ id: "v", translatedText: "旧译文", source: "api", createdAt: 1 }]
  });
  assert.equal(legacy.versions[0].translationConfigFingerprint, "");
  assert.equal(cacheCore.classifyCacheMatch(legacy, fp), "stale-config");
  assert.equal(cacheCore.classifyCacheMatch(legacy, ""), "exact");
});

test("version trimming keeps manual and pinned versions", () => {
  const runtime = makeClientRuntime();
  const base = { mode: "novel", workId: "w", chapterId: "c", sourceText: "s", normalizedSourceText: "s", sourceHash: "h" };
  let record = null;
  for (let index = 0; index < 7; index += 1) {
    const options = index === 3 ? { manual: true } : index === 5 ? { pinned: true } : {};
    record = runtime.buildTranslationCacheRecord("novel", base, `v${index}`, record ? record.versions : [], options);
  }
  assert.ok(record.versions.length <= 5);
  assert.ok(record.versions.some(v => v.manual), "手动版在裁剪后保留");
  assert.ok(record.versions.some(v => v.pinned), "pinned 版在裁剪后保留");
  assert.equal(record.versions[0].translatedText, "v6", "最新版本保留");
  assert.equal(runtime.trimTranslationCacheVersions([{ translatedText: "a", createdAt: 1 }, { translatedText: "b", createdAt: 2 }], 5).length, 2);
});

test("background wiring: cache store is installed and messages are routed", () => {
  const indexSource = fs.readFileSync(
    path.join(root, "extension", "src", "background", "modules", "index.js"), "utf8"
  );
  const messagesSource = fs.readFileSync(
    path.join(root, "extension", "src", "background", "modules", "messages.js"), "utf8"
  );
  const functions = indexSource.match(/functions: Object\.freeze\(\[([\s\S]*?)\]\)/u)[1];
  assert.match(functions, /installTranslationCacheStore/u, "store must be in backgroundPhases.functions");
  assert.match(messagesSource, /GET_TRANSLATION_CACHE/u);
  assert.match(messagesSource, /runtime\.handleTranslationCacheMessage\(message\)/u);
});

test("content wiring: translation cache client is installed in content phases", () => {
  const contentIndex = fs.readFileSync(
    path.join(root, "extension", "src", "content", "modules", "index.js"), "utf8"
  );
  assert.match(contentIndex, /installTranslationCacheClient/u);
  assert.match(contentIndex, /installWebpageTranslate/u);
  assert.match(contentIndex, /installNovelCache/u);
  assert.match(contentIndex, /installControlsTriple/u);
  assert.doesNotMatch(contentIndex, /installControlsDual/u);
});
