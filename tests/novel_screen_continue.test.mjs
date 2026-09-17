import assert from "node:assert/strict";
import test from "node:test";
import { installNovelReader } from "../extension/src/content/modules/novel-reader.js";
import { installNovelWorkflow } from "../extension/src/content/modules/novel-workflow.js";

// ---------- 屏内容签名 ----------

function makeParagraph(pid, rawText, wrappedSourceText) {
  return {
    tagName: "P",
    _attrs: { "data-p-id": String(pid) },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    querySelector(selector) {
      if (selector !== ":scope > .mt-novel-source") return null;
      if (wrappedSourceText === undefined) return null;
      return { textContent: wrappedSourceText };
    },
    get textContent() {
      return rawText;
    }
  };
}

function makeSignatureRuntime() {
  const runtime = { state: {}, updateFloatingBallState: () => {} };
  runtime.normalizeTranslationCacheText = value => String(value || "").replace(/\s+/gu, " ").trim();
  runtime.computeTranslationCacheHash = value => {
    let hash = 5381;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  installNovelReader(runtime);
  return runtime;
}

function surfaceOf(paragraphs) {
  return {
    root: {
      querySelectorAll(selector) {
        return String(selector) === "[data-p-id]" ? paragraphs.slice() : [];
      }
    }
  };
}

test("同一 shadow 宿主里换内容也会被识别成「换屏」", () => {
  const runtime = makeSignatureRuntime();
  const root = { querySelectorAll: () => [] };
  // 同一个 root 对象,内容不同 —— 正是 KakaoPage 翻页的形态
  const pageA = [makeParagraph(0, "내가 죽인 최애와 데뷔합니다 (연재)")];
  const pageB = [makeParagraph(0, "지은이 │ 유쓰")];
  root.querySelectorAll = selector => (String(selector) === "[data-p-id]" ? pageA : []);
  const surfaceA = { root };
  const signatureA = runtime.novelSurfaceSignature(surfaceA);
  root.querySelectorAll = selector => (String(selector) === "[data-p-id]" ? pageB : []);
  const signatureB = runtime.novelSurfaceSignature(surfaceA);

  assert.ok(signatureA);
  assert.notEqual(signatureA, signatureB, "同号但不同内容的屏必须得到不同签名");
  assert.equal(signatureB, runtime.novelSurfaceSignature(surfaceOf(pageB)),
    "签名只取决于内容,与 root 是哪个对象无关");
});

test("渲染插入译文包裹不会改变签名(不会自激重译)", () => {
  const runtime = makeSignatureRuntime();
  const before = runtime.novelSurfaceSignature(surfaceOf([makeParagraph(2, "지은이 │ 유쓰")]));
  // 渲染后原文被移进 .mt-novel-source,节点文本里多了译文
  const after = runtime.novelSurfaceSignature(surfaceOf([
    makeParagraph(2, "지은이 │ 유쓰优斯", "지은이 │ 유쓰")
  ]));
  assert.equal(after, before);
});

test("空屏签名为空字符串", () => {
  const runtime = makeSignatureRuntime();
  assert.equal(runtime.novelSurfaceSignature(null), "");
  assert.equal(runtime.novelSurfaceSignature(surfaceOf([])), "");
});

// ---------- 翻屏后补翻 ----------

function makeScreenHarness(overrides = {}) {
  const state = {
    chapterKey: "book:c1",
    textStatus: "complete",
    showTranslation: true,
    translations: new Map(),
    taskId: "",
    textDiagnostics: [],
    cacheSavedIds: new Set(),
    pendingParagraphs: new Set(),
    streamState: "idle",
    cacheStatus: "none",
    lastTextErrors: [],
    imageJobs: new Map(),
    imageContexts: new Map(),
    progress: {},
    ...overrides.state
  };
  const surface = { root: { isConnected: true } };
  const chapter = {
    scopeKey: "book",
    seriesId: "series",
    chapterId: "c1",
    chapterTitle: "第1话",
    chapterOrder: 1,
    surface,
    paragraphs: [
      { id: "0@aaaa0001", paragraphKey: "pk0", original_text: "지은이 │ 유쓰", node: { dataset: {} } },
      { id: "3@aaaa0002", paragraphKey: "pk3", original_text: "마케팅 │ 한재혁", node: { dataset: {} } }
    ]
  };
  const toggles = [];
  let extractCalls = 0;
  const runtime = {
    getNovelState: () => state,
    reconcileKakaoNovelReader: () => surface,
    extractKakaoNovelChapter: () => {
      extractCalls += 1;
      return chapter;
    },
    reapplyNovelTranslations: () => {},
    reapplyNovelEmbeddedImages: () => {},
    resumeNovelImagesIfIdle: () => {},
    setNovelTranslationVisibility: value => toggles.push(value),
    setNovelTextStatus: () => {},
    updateFloatingBallState: () => {},
    resolveSourceLanguage: () => "ko",
    getTargetLanguage: () => "zh-CN",
    normalizeTranslationCacheText: value => String(value || "").trim(),
    computeTranslationCacheHash: value => `h(${String(value || "")})`,
    buildNovelCacheRecordId: (workId, chapterId, sourceHash, paragraphKey) =>
      `id-${chapterId}-${sourceHash}-${paragraphKey}`,
    // 服务离线:让翻译路径立刻停下,便于断言它确实走到了「要翻译」这一步
    ensureTranslationServiceOnline: async () => ({ ok: false, error: "本地服务未启动，当前仅显示已缓存译文" })
  };
  installNovelWorkflow(runtime);
  return { runtime, state, chapter, surface, toggles, extracts: () => extractCalls };
}

test("本屏还有未译段落时,点击不再只是切换显示,而是真的去翻译", async () => {
  const harness = makeScreenHarness();
  // 章节级状态是「完成」,但本屏(版权页)两段都还没有译文
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.toggled, undefined, "缺译文时不能只切换显示");
  assert.equal(result.offline, true, "应当走完缓存检查并尝试翻译");
  assert.equal(harness.toggles.length, 0, "不应翻转显示意图");
  assert.equal(harness.state.textStatus, "partial");
});

test("补翻入口在本屏缺段落时不再被提前挡掉", async () => {
  const harness = makeScreenHarness();
  const result = await harness.runtime.translateNovelChapter({ missingOnly: true });
  assert.equal(result.reused, undefined, "本屏有缺段时补翻必须真的执行");
  assert.equal(result.offline, true);
});

test("本屏已全有译文时,补翻仍按「无需重做」返回", async () => {
  const harness = makeScreenHarness();
  harness.state.translations.set("0@aaaa0001", "作者 │ 优斯");
  harness.state.translations.set("3@aaaa0002", "营销 │ 韩在赫");
  const result = await harness.runtime.translateNovelChapter({ missingOnly: true });
  assert.equal(result.reused, true);
  assert.equal(result.completed, true);
});

test("本屏已全有译文时,普通点击仍是译文↔原文切换", async () => {
  const harness = makeScreenHarness();
  harness.state.translations.set("0@aaaa0001", "作者 │ 优斯");
  harness.state.translations.set("3@aaaa0002", "营销 │ 韩在赫");
  const hidden = await harness.runtime.translateNovelChapter();
  assert.equal(hidden.toggled, true);
  assert.equal(hidden.showTranslation, false);
  assert.deepEqual(harness.toggles, [false]);
});

test("surfaceChanged 为 false 时不启动补翻,为 true 才启动", () => {
  const harness = makeScreenHarness();
  harness.runtime.onNovelSurfaceChanged(harness.surface, "shadow-mutation", false);
  assert.equal(harness.extracts(), 0, "内容没变时不应提取/补翻");
  harness.runtime.onNovelSurfaceChanged(harness.surface, "shadow-mutation", true);
  assert.equal(harness.extracts(), 1, "内容变化时应启动补翻");
});

test("补翻会为缺译文的屏真的发起翻译", async () => {
  const harness = makeScreenHarness();
  const result = await harness.runtime.continueNovelTranslationForCurrentScreen(harness.surface);
  // 本屏两段都缺译文,且服务离线 ⇒ 必须真的尝试翻译,而不是当作已完成
  assert.equal(result.offline, true);
  assert.equal(result.reused, undefined);
});

test("用户尚未开启本章翻译时,翻屏不会偷偷发翻译请求", async () => {
  const harness = makeScreenHarness({ state: { textStatus: "idle" } });
  const result = await harness.runtime.continueNovelTranslationForCurrentScreen(harness.surface);
  assert.equal(result.skipped, true);
  assert.equal(harness.extracts(), 0, "未开启翻译时连提取都不应发生");
});
