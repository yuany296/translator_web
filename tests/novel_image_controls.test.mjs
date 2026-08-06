import assert from "node:assert/strict";
import test from "node:test";
import { installNovelImagePanel } from "../extension/src/content/modules/novel-image-panel.js";
import { installNovelImageWorkflow } from "../extension/src/content/modules/novel-image-workflow.js";

function makeElement(overrides = {}) {
  return {
    dataset: {},
    tagName: "IMG",
    querySelectorAll: () => [],
    ...overrides
  };
}

function makeImagePanelHarness({ spyReapply = true } = {}) {
  const restored = [];
  const reapplied = [];
  const imgEmbedded = makeElement({ dataset: { mtEmbeddedActive: "true" } });
  const imgPlain = makeElement();
  const surface = {
    content: { querySelectorAll: selector => selector === "img" ? [imgEmbedded, imgPlain] : [] }
  };
  const runtime = {
    state: { displayMode: "translated" },
    getNovelState: () => ({ showTranslation: true, imageResults: new Map() }),
    isNovelContentImage: () => true,
    restoreEmbeddedForTarget: target => {
      restored.push(target);
    }
  };
  installNovelImagePanel(runtime);
  if (spyReapply) {
    runtime.reapplyNovelEmbeddedImages = () => {
      reapplied.push(1);
      return 1;
    };
  }
  return { runtime, restored, reapplied, imgEmbedded, imgPlain, surface };
}

test("restoring original restores every embedded novel image", () => {
  const harness = makeImagePanelHarness();
  harness.runtime.syncNovelImageVisibility(false, harness.surface);
  assert.deepEqual(harness.restored, [harness.imgEmbedded]);
  assert.equal(harness.reapplied.length, 0);
});

test("showing translation re-applies embedded images", () => {
  const harness = makeImagePanelHarness();
  harness.runtime.syncNovelImageVisibility(true, harness.surface);
  assert.equal(harness.restored.length, 0);
  assert.deepEqual(harness.reapplied, [1]);
});

test("reapply skips while the page shows the original", () => {
  const harness = makeImagePanelHarness({ spyReapply: false });
  harness.runtime.getNovelState = () => ({
    showTranslation: false,
    imageResults: new Map([["k", { embeddedDataUrl: "data:image/png;base64,AA==" }]])
  });
  assert.equal(harness.runtime.reapplyNovelEmbeddedImages(harness.surface), 0);
});

function makeWorkflowHarness() {
  const embeddedTarget = makeElement({ dataset: { mtEmbeddedActive: "true" } });
  const chapter = {
    surface: {
      content: { querySelectorAll: selector => selector === "img" ? [embeddedTarget] : [] }
    }
  };
  const state = {
    surface: chapter.surface,
    chapterKey: "book:chapter",
    textStatus: "complete",
    imageStatus: "partial",
    imageJobs: new Map([[embeddedTarget, { status: "failed" }]]),
    imageResults: new Map([["k", { status: "failed" }]]),
    imageAutoResumeCount: 0,
    lastImageResumeAt: 0,
    progress: {},
    imageContexts: new Map()
  };
  const calls = [];
  const restored = [];
  const runtime = {
    getNovelState: () => state,
    reconcileKakaoNovelReader: () => chapter.surface,
    extractKakaoNovelChapter: () => chapter,
    resetNovelForChapter: () => {},
    isNovelContentImage: () => true,
    restoreEmbeddedForTarget: target => {
      restored.push(target);
    }
  };
  installNovelImageWorkflow(runtime);
  runtime.translateNovelImages = async (_chapter, retry, force) => {
    calls.push({ retry, force });
  };
  return { runtime, state, calls, restored, chapter, embeddedTarget };
}

test("force image retry restores embedded images and clears jobs before reprocessing", async () => {
  const harness = makeWorkflowHarness();
  const result = await harness.runtime.retryNovelImages(true);
  assert.equal(result, undefined, "spy returns undefined");
  assert.deepEqual(harness.restored, [harness.embeddedTarget]);
  assert.equal(harness.state.imageJobs.size, 0);
  assert.equal(harness.state.imageResults.size, 0);
  assert.deepEqual(harness.calls, [{ retry: true, force: true }]);
});

test("plain image retry keeps jobs and results intact", async () => {
  const harness = makeWorkflowHarness();
  await harness.runtime.retryNovelImages(false);
  assert.equal(harness.restored.length, 0);
  assert.equal(harness.state.imageJobs.size, 1);
  assert.equal(harness.state.imageResults.size, 1);
  assert.deepEqual(harness.calls, [{ retry: true, force: false }]);
});

test("image retry skips while an image phase is working", async () => {
  const harness = makeWorkflowHarness();
  harness.state.imageStatus = "working";
  const result = await harness.runtime.retryNovelImages(true);
  assert.equal(result.reused, true);
  assert.equal(harness.calls.length, 0);
});
