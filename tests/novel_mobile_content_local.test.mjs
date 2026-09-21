import assert from "node:assert/strict";
import test from "node:test";
import { applyContentLocal } from "../extension/src/novel-mobile/content-local.js";

// 手机版章节流程测试：重点是「不再向本地服务要许可」这件事，
// 以及 reader-api 立即取值那两处必须跟着覆盖。
function makeParagraph(id, text) {
  return { id, index: Number(id), kind: "paragraph", original_text: text, node: { id } };
}

function makeHarness(paragraphs = [makeParagraph("0", "첫 문단"), makeParagraph("1", "둘째 문단")]) {
  const state = {
    taskId: "",
    chapterKey: "",
    translations: new Map(),
    pendingParagraphs: new Set(),
    progress: { textDone: 0, textTotal: 0, textPhase: "" },
    textStatus: "idle",
    showTranslation: false,
    serviceOnline: false
  };
  const calls = {
    progressive: [], visibility: [], statuses: [], termDiscovery: [], stream: 0, service: 0, reapply: 0,
    reapplySurfaces: [], continued: []
  };
  let signature = "sig-1";
  const surface = { root: {} };
  const chapter = {
    scopeKey: "kakao:1", seriesId: "1", chapterId: "c1", chapterTitle: "1화", chapterOrder: 1,
    paragraphs, surface, images: []
  };
  const runtime = {
    state: {},
    getNovelState: () => state,
    reconcileKakaoNovelReader: () => surface,
    findKakaoNovelSurface: () => surface,
    novelSurfaceSignature: () => signature,
    extractKakaoNovelChapter: () => chapter,
    resetNovelForChapter: (value, target) => {
      const key = `${value.scopeKey}:${value.chapterId}`;
      if (target.chapterKey === key) return;
      target.chapterKey = key;
      target.translations.clear();
      target.textStatus = "idle";
      target.showTranslation = false;
      target.taskId = "";
    },
    applyCachedNovelTranslations: async () => ({ hit: 0, total: 0 }),
    getTranslationConfigFingerprint: async () => "fp",
    setNovelTranslationVisibility: value => calls.visibility.push(value),
    setNovelTextStatus: (status, progress) => calls.statuses.push({ status, progress: { ...progress } }),
    publishTextDiagnostics: () => {},
    reapplyNovelTranslations: value => { calls.reapply += 1; calls.reapplySurfaces.push(value); },
    scheduleNovelTermDiscovery: value => calls.termDiscovery.push(value),
    resolveSourceLanguage: text => (/[\uac00-\ud7af]/u.test(String(text)) ? "ko" : "zh-CN"),
    getTargetLanguage: () => "zh-CN",
    getErrorMessage: error => String(error && error.message || error || ""),
    cancelNovelTranslationStream: () => {},
    sendRuntimeMessage: async () => ({ ok: true }),
    runNovelTranslationStream: () => { calls.stream += 1; return Promise.reject(new Error("不该走流式")); }
  };
  runtime.api = {
    translateNovelChapter: () => "desktop",
    retryNovelImages: () => "desktop"
  };
  applyContentLocal(runtime);
  // 覆盖之后再装桩：applyContentLocal 会把 runNovelProgressiveTranslation 换成并发小批版
  // （那个版本单独在 novel_mobile_batch.test.mjs 里测），这里只关心章节流程的编排。
  runtime.runNovelProgressiveTranslation = async ({ state: target, pending }) => {
    calls.progressive.push(pending.map(item => item.id));
    pending.forEach(item => target.translations.set(item.id, `译:${item.original_text}`));
    target.progress.textDone = target.translations.size;
    return { errors: [], warnings: [] };
  };
  // 覆盖之后再装上「离线」探针：如果章节流程还是先问本地服务，就会在这里现形。
  runtime.ensureTranslationServiceOnline = async () => {
    calls.service += 1;
    return { ok: false, status: "offline", error: "本地服务未启动，当前仅显示已缓存译文" };
  };
  // 翻屏续翻包一层记录：既保留真实实现（补齐用例要用），又能看到「流程自己触发的续翻」
  const realContinue = runtime.continueNovelTranslationForCurrentScreen;
  runtime.continueNovelTranslationForCurrentScreen = async value => {
    calls.continued.push(value);
    return realContinue(value);
  };
  return {
    runtime, state, chapter, surface, calls,
    setSignature: value => { signature = value; }
  };
}

test("本地服务离线时章节照翻：不咨询服务、不走流式、直接渐进直连 LLM", async () => {
  const harness = makeHarness();
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.translated, 2);
  assert.equal(harness.calls.service, 0, "手机版不该再问本地服务在不在");
  assert.equal(harness.calls.stream, 0, "手机版不走流式接口");
  assert.deepEqual(harness.calls.progressive, [["0", "1"]]);
  assert.deepEqual([...harness.state.translations.values()], ["译:첫 문단", "译:둘째 문단"]);
  assert.equal(harness.state.textStatus, "complete");
  assert.equal(harness.state.serviceOnline, true);
  assert.deepEqual(harness.calls.visibility, [true]);
  assert.equal(harness.calls.termDiscovery.length, 1, "翻完要排一次术语发现");
});

test("缓存已全覆盖时不发翻译请求，直接显示译文", async () => {
  const harness = makeHarness();
  harness.runtime.applyCachedNovelTranslations = async (chapter, state) => {
    chapter.paragraphs.forEach(item => state.translations.set(item.id, `缓存:${item.original_text}`));
    return { hit: chapter.paragraphs.length, total: chapter.paragraphs.length };
  };
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.completed, true);
  assert.equal(result.showTranslation, true);
  assert.equal(harness.calls.progressive.length, 0);
  assert.equal(harness.state.textStatus, "complete");
});

test("本屏已有全部译文时，再次点击只是译文↔原文切换", async () => {
  const first = makeHarness();
  await first.runtime.translateNovelChapter();
  const toggled = await first.runtime.translateNovelChapter();
  assert.equal(toggled.toggled, true);
  assert.equal(toggled.showTranslation, false);
  // 一次来自收尾重贴（revealTranslations），一次来自切换本身
  assert.equal(first.calls.reapply, 2);
  assert.deepEqual(first.calls.visibility.slice(-1), [false]);
  assert.equal(first.calls.progressive.length, 1, "切换不该重新翻译");
});

test("强制重译会清空已有译文并重新请求", async () => {
  const harness = makeHarness();
  await harness.runtime.translateNovelChapter();
  const forced = await harness.runtime.translateNovelChapter({ force: true });
  assert.equal(forced.completed, true);
  assert.equal(harness.calls.progressive.length, 2);
});

test("译文任务进行中重复点击不再起第二条任务", async () => {
  const harness = makeHarness();
  harness.state.textStatus = "working";
  harness.state.chapterKey = "kakao:1:c1";
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.reused, true);
  assert.equal(harness.calls.progressive.length, 0);
});

test("翻屏补翻：只补当前屏缺的段落，且不咨询本地服务", async () => {
  const harness = makeHarness();
  await harness.runtime.translateNovelChapter();
  harness.calls.progressive.length = 0;
  harness.state.translations.delete("1");
  const result = await harness.runtime.continueNovelTranslationForCurrentScreen(harness.surface);
  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls.progressive, [["1"]]);
  assert.equal(harness.calls.service, 0);
});

test("还没翻过的页面翻屏路过时什么都不做", async () => {
  const harness = makeHarness();
  const result = await harness.runtime.continueNovelTranslationForCurrentScreen(harness.surface);
  assert.equal(result.skipped, true);
  assert.equal(harness.calls.progressive.length, 0);
});

test("reader-api 立即取值的那两个函数必须一起换掉（否则 __MANGA_TRANSLATOR_V3__ 还是桌面实现）", () => {
  const harness = makeHarness();
  assert.equal(harness.runtime.api.translateNovelChapter, harness.runtime.translateNovelChapter);
  assert.equal(harness.runtime.api.retryNovelImages, harness.runtime.retryNovelImages);
});

test("收尾一定按当前 surface 重贴：这是「翻译完成但页面没替换」的修复点", async () => {
  const harness = makeHarness();
  await harness.runtime.translateNovelChapter();
  assert.ok(harness.calls.reapply >= 1);
  assert.equal(harness.calls.reapplySurfaces.at(-1), harness.surface, "必须贴到当前 surface，而不是提取时那个");
});

test("翻译期间翻屏：新一屏会被接着翻（否则那屏一个字都没有）", async () => {
  const harness = makeHarness();
  harness.runtime.runNovelProgressiveTranslation = async ({ state: target, pending }) => {
    pending.forEach(item => target.translations.set(item.id, `译:${item.original_text}`));
    harness.setSignature("sig-2"); // 翻译途中用户翻了屏
    return { errors: [], warnings: [] };
  };
  await harness.runtime.translateNovelChapter();
  assert.equal(harness.calls.continued.length, 1, "翻屏后应自动接着翻新屏");
  assert.equal(harness.calls.continued[0], harness.surface);
});

test("同一段同时留下块级与逐段失败时只报一条（不把 2 段失败显示成 4 段）", async () => {
  const harness = makeHarness();
  harness.runtime.runNovelProgressiveTranslation = async () => ({
    errors: [
      { id: "0", error: "chunk failed" },
      { id: "1", error: "chunk failed" },
      { id: "0", error: "repair_failed" },
      { id: "1", error: "repair_failed" }
    ],
    warnings: []
  });
  const published = [];
  harness.runtime.publishTextDiagnostics = (state, errors) => published.push(errors);
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.ok, false);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].map(error => error.id).sort(), ["0", "1"]);
  assert.equal(published[0].find(error => error.id === "0").error, "repair_failed", "按 id 去重，保留最后一条");
});

test("正文插图翻译被关闭（手机版没有 OCR 服务）", async () => {
  const harness = makeHarness();
  assert.deepEqual(await harness.runtime.translateNovelImages(harness.chapter), { ok: true, total: 0 });
  assert.deepEqual(await harness.runtime.retryNovelImages(), { ok: true, total: 0 });
  harness.runtime.resumeNovelImagesIfIdle();
});

test("悬浮球只留小说球，并在小说菜单里去掉图片与章节管理两项", () => {
  const hidden = [];
  const boundWith = [];
  const harness = makeHarness();
  harness.runtime.state = { floatingComicBall: { hidden: false }, floatingWebpageBall: { hidden: false } };
  harness.runtime.createFloatingBall = () => "created";
  harness.runtime.bindBallContextMenu = (ball, getContext) => {
    boundWith.push({ ball: ball.id, items: getContext().map(item => item.id) });
    return "bound";
  };
  applyContentLocal(harness.runtime);
  assert.equal(harness.runtime.createFloatingBall(), "created");
  assert.deepEqual(hidden, []);
  assert.equal(harness.runtime.state.floatingComicBall.hidden, true);
  assert.equal(harness.runtime.state.floatingWebpageBall.hidden, true);

  const ball = id => ({ id, classList: { contains: name => name === `mt-floating-${id}` } });
  const menu = () => [
    { id: "translate-chapter" }, { id: "retranslate-images" }, { id: "manage-chapter" }, { id: "restore-original" }
  ];
  assert.equal(harness.runtime.bindBallContextMenu(ball("comic"), menu), undefined, "漫画球不绑菜单");
  assert.equal(harness.runtime.bindBallContextMenu(ball("webpage"), menu), undefined, "网页球不绑菜单");
  harness.runtime.bindBallContextMenu(ball("novel"), menu);
  assert.deepEqual(boundWith, [{ ball: "novel", items: ["translate-chapter", "restore-original"] }]);
});
