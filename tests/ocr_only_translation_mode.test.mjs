import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from "../extension/src/config/schema.js";
import { installOcrPipeline } from "../extension/src/background/modules/ocr-pipeline.js";
import { installStoreCanonical } from "../extension/src/canonical/page-store-factory/store-canonical.js";

const root = path.resolve(import.meta.dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

/**
 * 后台桩：ocrOnly 路径必须完全不碰模型，所以 loadSettings 与
 * requestCanonicalTextTranslations 都是计数器 —— 被调用一次就算失败。
 */
function makePipelineRuntime(overrides = {}) {
  const calls = { loadSettings: 0, translate: 0 };
  const runtime = {
    DEFAULT_TRANSLATION_BASE_URL: "https://example.invalid/v1",
    DEFAULT_TRANSLATION_MODEL: "test-model",
    CANONICAL_TRANSLATION_PROMPT_VERSION: "comic-v1",
    glossaryCore: { getFingerprint: () => "g4-test" },
    normalizeCanonicalRevision: value => Math.max(1, Number(value) || 1),
    normalizeTranslationSourceText: value => String(value || "").trim(),
    normalizeLanguageTag: (value, fallback) => String(value || fallback || ""),
    stableHash128: value => `h(${value})`,
    cleanDecorativeSymbols: value => String(value || ""),
    canonicalTranslationItemKey: item => `${item.id}:${item.revision}`,
    buildComicTranslationDescriptors: items => items.map(item => ({ id: item.id })),
    async loadSettings() {
      calls.loadSettings += 1;
      return { apiKey: "", translationConfig: { provider: "" }, glossary: null };
    },
    async requestCanonicalTextTranslations({ items }) {
      calls.translate += 1;
      return new Map(items.map(item => [
        `${item.id}:${item.revision}`,
        { translatedText: `译:${item.original_text}` }
      ]));
    },
    ...overrides
  };
  installOcrPipeline(runtime);
  return { runtime, calls };
}

const bilingualMessage = translationMode => ({
  mode: "comic",
  ...(translationMode ? { translationMode } : {}),
  sourceLanguage: "ja",
  targetLanguage: "zh-CN",
  items: [
    { id: "c1", revision: 1, original_text: "おはよう" },
    { id: "c2", revision: 1, original_text: "元気？" }
  ]
});

test("runtime config defaults to provider and accepts ocrOnly", () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.translationMode, "provider");
  assert.equal(normalizeRuntimeConfig({}).translationMode, "provider");
  assert.equal(normalizeRuntimeConfig({ translationMode: "ocrOnly" }).translationMode, "ocrOnly");
  assert.equal(normalizeRuntimeConfig({ translationMode: "nonsense" }).translationMode, "provider");
  // 与「显示什么」正交：双语不改变翻译模式，displayMode 也仍然是独立字段。
  const bilingual = normalizeRuntimeConfig({ displayMode: "bilingual" });
  assert.equal(bilingual.translationMode, "provider");
  assert.equal(bilingual.displayMode, "bilingual");
});

test("ocrOnly returns passthrough rows without touching the model", async () => {
  const { runtime, calls } = makePipelineRuntime();
  const response = await runtime.handleTranslateTextBlocks(bilingualMessage("ocrOnly"));
  assert.equal(response.ok, true);
  assert.equal(response.partial, false);
  assert.equal(response.translations.length, 2);
  assert.deepEqual(
    response.translations.map(row => row.translated_text),
    ["おはよう", "元気？"],
    "译文字段必须回填原文：渲染层靠非空译文才画气泡"
  );
  assert.deepEqual(
    response.translations.map(row => row.id),
    ["c1", "c2"]
  );
  for (const row of response.translations) {
    assert.match(row.translationFingerprint, /^passthrough_/u);
    assert.equal(row.cached, true);
  }
  assert.equal(calls.translate, 0, "ocrOnly 不得请求翻译模型");
  assert.equal(calls.loadSettings, 0, "ocrOnly 不得加载翻译服务配置");
  assert.equal(response.timing.translateMs, 0);
});

test("provider mode still reaches the translation model (ocrOnly must not change the default path)", async () => {
  const { runtime, calls } = makePipelineRuntime();
  const response = await runtime.handleTranslateTextBlocks(bilingualMessage(""));
  assert.equal(response.ok, true);
  assert.equal(calls.translate, 1, "默认路径仍然请求模型");
  assert.deepEqual(
    response.translations.map(row => row.translated_text),
    ["译:おはよう", "译:元気？"]
  );
});

test("ocrOnly is per request, not per item: a mixed caller cannot opt back in", async () => {
  const { runtime, calls } = makePipelineRuntime();
  // 同一批里即使有 non_translate=false 的条目，整体也必须直通。
  const response = await runtime.handleTranslateTextBlocks({
    mode: "comic",
    translationMode: "ocrOnly",
    items: [{ id: "c1", revision: 1, original_text: "テスト", non_translate: false }]
  });
  assert.equal(calls.translate, 0);
  assert.equal(response.translations[0].translated_text, "テスト");
});

/** 用最小 scope 驱动 store-canonical：只需要 dropTranslations 摸到的那几个容器。 */
function makeStore() {
  const scope = {
    result: {},
    canonicalSnapshots: new Map(),
    translationsByCanonicalRevision: new Map(),
    translationErrorsByCanonicalRevision: new Map(),
    pendingTranslationKeys: new Set(),
    pendingTranslationWaiters: new Map(),
    attemptedTranslationKeys: new Set(),
    edgeWaitStates: new Map(),
    projectionsByPage: new Map(),
    // dropTranslations 不应触碰这些（模式切换不需要重新 OCR）
    canonicalPagePhases: new Map(),
    pageHandles: new Map(),
    observations: new Map()
  };
  const runtime = {
    canonicalRevisionKey: (id, revision) => `${id}:${Number(revision) || 1}`,
    freezeCanonicalValue: value => value
  };
  installStoreCanonical(runtime, scope);
  return { store: scope.result, scope };
}

test("dropTranslations re-opens claims so switching back to provider re-translates", () => {
  const { store, scope } = makeStore();
  const item = { id: "c1", revision: 2, original_text: "おはよう" };
  scope.canonicalSnapshots.set("c1", { id: "c1", revision: 2 });
  scope.projectionsByPage.set("page-1", [{ translated_text: "旧" }]);

  assert.deepEqual(store.claimTranslations([item]), [item]);
  assert.equal(store.settleTranslation(item, { translated_text: "早上好" }), true);
  assert.equal(store.getTranslation("c1", 2).translated_text, "早上好");
  // 已结算 + 已尝试 => 再 claim 不会再请求（这是正常缓存行为）
  assert.deepEqual(store.claimTranslations([item]), []);

  store.dropTranslations();
  assert.equal(store.getTranslation("c1", 2), null);
  assert.equal(scope.projectionsByPage.size, 0, "projection 里烘进了译文，必须一起清");
  assert.deepEqual(
    store.claimTranslations([item]),
    [item],
    "清理后必须能重新认领，否则切回 provider 会永远复用直通值"
  );
});

test("nothing else in the store is dropped (no re-OCR needed on a mode switch)", () => {
  const { store, scope } = makeStore();
  scope.canonicalSnapshots.set("c1", { id: "c1", revision: 1 });
  scope.pageHandles.set("page-1", { pageId: "page-1" });
  scope.observations.set("o1", { id: "o1" });
  store.dropTranslations();
  assert.equal(scope.canonicalSnapshots.size, 1);
  assert.equal(scope.pageHandles.size, 1);
  assert.equal(scope.observations.size, 1);
});

test("comic requests carry the effective translation mode; webpage is untouched", () => {
  const expected = /translationMode: runtime\.getEffectiveTranslationMode\?\.\(\) \|\| "provider"/u;
  assert.match(read("extension/src/content/modules/recognition-seam.js"), expected);
  assert.match(read("extension/src/content/modules/recognition-stitch.js"), expected);
  assert.doesNotMatch(read("extension/src/content/modules/webpage-translate.js"), /translationMode/u);
  assert.doesNotMatch(read("extension/src/background/modules/novel-translation.js"), /translationMode/u);
});

test("a mode switch invalidates settled translations instead of reusing them", () => {
  assert.match(
    read("extension/src/content/configure.js"),
    /if \(translationModeChanged\) runtime\.invalidateComicTranslations\?\.\(\);/u
  );
  const platformRuntime = read("extension/src/content/modules/platform-runtime.js");
  assert.match(platformRuntime, /runtime\.state\.kakaoStore\?\.dropTranslations\?\.\(\);/u);
  // 清掉「已翻译」标记，否则 reader-observers 不会重新入队
  assert.match(platformRuntime, /delete target\.dataset\.mtLastTranslatedKey;/u);
});

test("effective mode prefers the per-page override over the global default", () => {
  const configure = read("extension/src/content/configure.js");
  assert.match(configure, /runtime\.getEffectiveTranslationMode = \(\) => runtime\.state\.translationModeOverride/u);
  assert.match(configure, /runtime\.isOcrOnlyTranslation = \(\) => runtime\.getEffectiveTranslationMode\(\) === "ocrOnly"/u);
  assert.match(configure, /if \(translationModeChanged\) runtime\.state\.translationModeOverride = null;/u);
});

test("ocrOnly keeps the DOM overlay and skips term discovery", () => {
  // embedded/canvas 把文字画进像素，浏览器翻译看不到 —— 必须强制 overlay
  assert.match(
    read("extension/src/content/modules/scene-dispatch.js"),
    /if \(runtime\.isOcrOnlyTranslation\?\.\(\) === true\) return false;/u
  );
  // 术语发现的输入会退化成「原文对原文」
  assert.match(
    read("extension/src/content/modules/renderer-overlay.js"),
    /if \(runtime\.isOcrOnlyTranslation\?\.\(\) === true\) return null;/u
  );
});

test("comic floating menu offers the per-page ocr-only toggle", () => {
  const states = read("extension/src/content/modules/floating-states.js");
  assert.match(states, /id: ocrOnly \? "ocr-only-off" : "ocr-only-on"/u);
  assert.match(states, /仅识别不翻译（本页）/u);
  assert.match(states, /恢复模型翻译（本页）/u);
  assert.match(states, /translationMode: ctx\.translationMode === "ocrOnly" \? "ocrOnly" : "provider"/u);
  const triple = read("extension/src/content/modules/controls-triple.js");
  assert.match(triple, /return runtime\.handleComicTranslationModeMenu\?\.\(id\);/u);
  const platformRuntime = read("extension/src/content/modules/platform-runtime.js");
  assert.match(platformRuntime, /if \(id !== "ocr-only-on" && id !== "ocr-only-off"\) return undefined;/u);
  assert.match(platformRuntime, /return toggleComicTranslationMode\(id === "ocr-only-on"\);/u);
});

test("settings page exposes the global switch and persists it", () => {
  assert.match(read("extension/public/settings.html"), /id="comicOcrOnly"/u);
  const controller = read("extension/src/settings/controller.js");
  assert.match(controller, /byId\("comicOcrOnly"\)\.checked = runtime\.translationMode === "ocrOnly";/u);
  assert.match(controller, /translationMode: checked\("comicOcrOnly"\) \? "ocrOnly" : "provider"/u);
});
