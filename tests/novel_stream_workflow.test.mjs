import assert from "node:assert/strict";
import test from "node:test";
import { installNovelStreamWorkflow } from "../extension/src/content/modules/novel-stream-workflow.js";

function createWorkflowHarness({ nextResult = { completed: 0, failed: 0, protocolErrors: 0 } } = {}) {
  const batchSizes = [];
  let result = nextResult;
  const runtime = {
    runNovelTranslationStream: async request => {
      batchSizes.push(request.items.length);
      return result;
    },
    setResult(value) { result = value; },
    buildNovelRecordKey: () => "record-key",
    getConfiguredSourceLanguage: () => "auto",
    getTargetLanguage: () => "zh-CN",
    resolveSourceLanguage: () => "ko",
    normalizeTranslationCacheText: value => String(value || ""),
    getErrorMessage: error => error && error.message ? error.message : String(error),
    renderNovelTranslation: () => {},
    setNovelTextStatus: () => {}
  };
  installNovelStreamWorkflow(runtime);
  const chapter = {
    scopeKey: "book", seriesId: "series", chapterId: "chapter", chapterTitle: "title",
    paragraphs: []
  };
  const state = {
    taskId: "novel-task",
    chapterKey: "book:chapter",
    streamState: "idle",
    progress: { textDone: 0, textTotal: 0, textPhase: "" },
    translations: new Map(),
    pendingParagraphs: new Set(),
    translationSnapshots: new Map()
  };
  return { runtime, chapter, state, batchSizes };
}

function makeItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    index,
    kind: "text",
    paragraphKey: `p${index}`,
    original_text: `text ${index}`,
    rawSourceHash: `raw-${index}`,
    normalizedSourceHash: `norm-${index}`
  }));
}

test("stream request batches items beyond the server 200-item limit", async () => {
  const harness = createWorkflowHarness({
    nextResult: { completed: 150, failed: 0, protocolErrors: 0 }
  });
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeItems(350), "fp", {}
  );
  assert.deepEqual(harness.batchSizes, [50, 50, 50, 50, 50, 50, 50]);
  assert.equal(result.supported, true);
  assert.equal(result.completed, 1050);
  assert.equal(result.failed, 0);
  assert.equal(result.result.total, 350);
  assert.equal(harness.state.streamState, "completed");
});

test("a chapter under the batch limit still uses a single stream request", async () => {
  const harness = createWorkflowHarness({
    nextResult: { completed: 20, failed: 0, protocolErrors: 0 }
  });
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeItems(20), "fp", {}
  );
  assert.deepEqual(harness.batchSizes, [20]);
  assert.equal(result.completed, 20);
  assert.equal(harness.state.streamState, "completed");
});

test("runtime.state.novelStreamBatchSize overrides the default batch limit", async () => {
  const harness = createWorkflowHarness({
    nextResult: { completed: 150, failed: 0, protocolErrors: 0 }
  });
  harness.runtime.state = { novelStreamBatchSize: 100 };
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeItems(350), "fp", {}
  );
  assert.deepEqual(harness.batchSizes, [100, 100, 100, 50]);
  assert.equal(result.completed, 600);
  assert.equal(result.result.total, 350);
  assert.equal(harness.state.streamState, "completed");
});

test("a failed first batch falls back to progressive batches", async () => {
  const harness = createWorkflowHarness();
  const error = new Error("stream unavailable");
  harness.runtime.runNovelTranslationStream = async () => {
    throw error;
  };
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeItems(120), "fp", {}
  );
  assert.equal(result.supported, false);
  assert.equal(result.error, "stream unavailable");
  assert.equal(harness.state.streamState, "unsupported");
});

test("a later batch failure keeps earlier progress and enters paragraph recovery", async () => {
  const harness = createWorkflowHarness();
  let calls = 0;
  harness.runtime.runNovelTranslationStream = async request => {
    calls += 1;
    harness.batchSizes.push(request.items.length);
    if (calls === 1) return { completed: 150, failed: 0, protocolErrors: 0 };
    throw new Error("network dropped");
  };
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeItems(200), "fp", {}
  );
  assert.equal(harness.batchSizes.length, 2);
  assert.equal(result.supported, true);
  assert.equal(result.completed, 150);
  assert.equal(result.failed, 50);
  assert.equal(harness.state.streamState, "paragraph-recovery");
});

test("aggregated per-batch failures drive paragraph recovery", async () => {
  const harness = createWorkflowHarness({
    nextResult: { completed: 120, failed: 30, protocolErrors: 1 }
  });
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeItems(300), "fp", {}
  );
  assert.equal(result.completed, 720);
  assert.equal(result.failed, 180);
  assert.equal(result.protocolErrors, 6);
  assert.equal(harness.state.streamState, "paragraph-recovery");
});
