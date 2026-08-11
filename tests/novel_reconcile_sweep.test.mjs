import assert from "node:assert/strict";
import test from "node:test";
import { installNovelReader } from "../extension/src/content/modules/novel-reader.js";
import { installNovelWorkflow } from "../extension/src/content/modules/novel-workflow.js";

function makeNovelReaderHarness(overrides = {}) {
  const runtime = {
    state: { invalidated: false },
    IS_KAKAOPAGE_READER: true,
    updateFloatingBallState: () => {},
    ...overrides
  };
  installNovelReader(runtime);
  const state = runtime.getNovelState();
  let reconcileCalls = 0;
  runtime.reconcileKakaoNovelReader = () => {
    reconcileCalls += 1;
    return state.surface;
  };
  return { runtime, state, reconcileCalls: () => reconcileCalls };
}

test("stale sweep re-reconciles when the surface root was replaced by zoom", () => {
  const harness = makeNovelReaderHarness();
  harness.state.surface = { root: { isConnected: false } };
  harness.state.chapterKey = "book:chapter";
  harness.runtime.reconcileKakaoNovelIfStale();
  assert.equal(harness.reconcileCalls(), 1);
});

test("stale sweep is a no-op while the surface root stays connected", () => {
  const harness = makeNovelReaderHarness();
  harness.state.surface = { root: { isConnected: true } };
  harness.state.chapterKey = "book:chapter";
  harness.runtime.reconcileKakaoNovelIfStale();
  assert.equal(harness.reconcileCalls(), 0);
});

test("stale sweep re-reconciles when a translated chapter lost its surface", () => {
  const harness = makeNovelReaderHarness();
  harness.state.surface = null;
  harness.state.chapterKey = "book:chapter";
  harness.runtime.reconcileKakaoNovelIfStale();
  assert.equal(harness.reconcileCalls(), 1);
});

test("stale sweep skips untranslated pages and invalidated contexts", () => {
  const harness = makeNovelReaderHarness();
  harness.runtime.reconcileKakaoNovelIfStale();
  assert.equal(harness.reconcileCalls(), 0);
  harness.state.chapterKey = "book:chapter";
  harness.state.surface = { root: { isConnected: false } };
  harness.runtime.state.invalidated = true;
  harness.runtime.reconcileKakaoNovelIfStale();
  assert.equal(harness.reconcileCalls(), 0);
  harness.runtime.state.invalidated = false;
  harness.runtime.IS_KAKAOPAGE_READER = false;
  harness.runtime.reconcileKakaoNovelIfStale();
  assert.equal(harness.reconcileCalls(), 0);
});

function makeWorkflowToggleHarness() {
  const state = {
    chapterKey: "book:c1",
    textStatus: "complete",
    showTranslation: true,
    translations: new Map([["p1", "译文"]]),
    taskId: "",
    memoryDeltas: [],
    textDiagnostics: [],
    cacheSavedIds: new Set(),
    pendingParagraphs: new Set(),
    streamState: "idle",
    cacheStatus: "none",
    lastTextErrors: [],
    imageJobs: new Map(),
    imageContexts: new Map(),
    progress: {}
  };
  const chapter = {
    scopeKey: "book",
    seriesId: "series",
    chapterId: "c1",
    chapterTitle: "第1话",
    chapterOrder: 1,
    surface: { root: { isConnected: true } },
    paragraphs: []
  };
  const visibility = [];
  const runtime = {
    getNovelState: () => state,
    reconcileKakaoNovelReader: () => chapter.surface,
    extractKakaoNovelChapter: () => chapter,
    reapplyNovelTranslations: () => {},
    setNovelTranslationVisibility: value => {
      visibility.push(value);
    },
    updateFloatingBallState: () => {}
  };
  installNovelWorkflow(runtime);
  return { runtime, state, visibility };
}

test("complete chapter toggles between translation and original on every click", async () => {
  const harness = makeWorkflowToggleHarness();
  const hidden = await harness.runtime.translateNovelChapter();
  assert.equal(hidden.toggled, true);
  assert.equal(hidden.showTranslation, false);
  assert.deepEqual(harness.visibility, [false]);
  const shown = await harness.runtime.translateNovelChapter();
  assert.equal(shown.toggled, true);
  assert.equal(shown.showTranslation, true);
  assert.deepEqual(harness.visibility, [false, true]);
});

test("restored-original click returns to translation again (round trip)", async () => {
  const harness = makeWorkflowToggleHarness();
  await harness.runtime.translateNovelChapter();
  await harness.runtime.translateNovelChapter();
  await harness.runtime.translateNovelChapter();
  assert.equal(harness.state.showTranslation, false);
  assert.deepEqual(harness.visibility, [false, true, false]);
});
