import assert from "node:assert/strict";
import test from "node:test";
import { installNovelCache } from "../extension/src/content/modules/novel-cache.js";
import { installTranslationUtils } from "../extension/src/background/modules/translation-utils.js";

function makeHarness(records = new Map([
  ["id-pk1", { translatedText: "译文一" }],
  ["id-pk2", { translatedText: "译文二" }]
])) {
  const rendered = [];
  const state = {
    translations: new Map(),
    showTranslation: false,
    cacheSavedIds: new Set()
  };
  const chapter = {
    scopeKey: "book",
    seriesId: "series",
    chapterId: "c1",
    paragraphs: [
      { id: "p1", paragraphKey: "pk1", original_text: "문장1", node: { dataset: {} } },
      { id: "p2", paragraphKey: "pk2", original_text: "문장2", node: { dataset: {} } },
      { id: "p3", paragraphKey: "pk3", original_text: "문장3", node: { dataset: {} } }
    ]
  };
  const runtime = {
    normalizeTranslationCacheText: value => String(value || ""),
    computeTranslationCacheHash: value => `hash:${value}`,
    buildNovelCacheRecordId: (workId, chapterId, sourceHash, paragraphKey) =>
      `id-${paragraphKey}`,
    resolveSourceLanguage: () => "ko",
    getTargetLanguage: () => "zh-CN",
    getTranslationCacheRecords: async ids => {
      const out = new Map();
      for (const id of ids) {
        if (records.has(id)) out.set(id, records.get(id));
      }
      return out;
    },
    getTranslationConfigFingerprint: async () => "fp",
    classifyTranslationCacheMatch: record =>
      record && String(record.translatedText || "").trim() ? "exact" : "missing",
    renderNovelTranslation: (node, text, show) => {
      rendered.push({ node, text, show });
    }
  };
  installTranslationUtils(runtime);
  installNovelCache(runtime);
  return { runtime, state, chapter, rendered };
}

test("cached novel translations render immediately visible on the first click", async () => {
  const harness = makeHarness();
  const result = await harness.runtime.applyCachedNovelTranslations(
    harness.chapter, harness.state
  );
  assert.equal(result.hit, 2);
  assert.equal(result.total, 3);
  assert.equal(harness.state.translations.get("p1"), "译文一");
  assert.equal(harness.state.translations.get("p2"), "译文二");
  assert.equal(harness.state.translations.has("p3"), false);
  assert.equal(harness.rendered.length, 2);
  assert.ok(harness.rendered.every(entry => entry.show === true),
    "every cached hit must render with the visible intent even before any stream result");
  // 翻转全局意图由 renderNovelTranslation(见 novel_renderer 测试)负责,
  // 缓存模块只需以可见意图调用渲染即可。
  assert.equal(harness.state.showTranslation, false,
    "cache module itself does not touch the show intent");
});

test("cache apply without hits leaves the show intent untouched", async () => {
  const harness = makeHarness(new Map());
  const result = await harness.runtime.applyCachedNovelTranslations(
    harness.chapter, harness.state
  );
  assert.equal(result.hit, 0);
  assert.equal(harness.rendered.length, 0);
  assert.equal(harness.state.showTranslation, false);
  assert.equal(harness.state.translations.size, 0);
});

test("cached novel translations are patched in place when quotes were dropped", async () => {
  const records = new Map([
    ["id-pk1", { translatedText: "但是，要吐的话就痛快吐出来，知道了吗？" }]
  ]);
  const harness = makeHarness(records);
  const chapter = {
    scopeKey: "book",
    seriesId: "series",
    chapterId: "c1",
    paragraphs: [{
      id: "p1",
      paragraphKey: "pk1",
      original_text: "“근데 토할 때 그만 토껴, 알겠지?”",
      node: { dataset: {} }
    }]
  };
  const result = await harness.runtime.applyCachedNovelTranslations(chapter, harness.state);
  assert.equal(result.hit, 1);
  assert.equal(harness.state.translations.get("p1"), "“但是，要吐的话就痛快吐出来，知道了吗？”");
  assert.equal(harness.rendered[0].text, "“但是，要吐的话就痛快吐出来，知道了吗？”");
  // 已带引号的旧译文保持原样,不双重包裹
  const withQuotes = makeHarness(new Map([
    ["id-pk1", { translatedText: "“这本来就是对的。”" }]
  ]));
  await withQuotes.runtime.applyCachedNovelTranslations(chapter, withQuotes.state);
  assert.equal(withQuotes.state.translations.get("p1"), "“这本来就是对的。”");
});
