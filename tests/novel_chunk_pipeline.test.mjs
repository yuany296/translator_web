import assert from "node:assert/strict";
import test from "node:test";
import { installNovelWorkflow } from "../extension/src/content/modules/novel-workflow.js";
import { installNovelProgressiveWorkflow } from "../extension/src/content/modules/novel-progressive-workflow.js";
import { installControlsUtils } from "../extension/src/content/modules/controls-utils.js";
import novel from "../extension/src/shared/novel.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    index,
    kind: index === 0 ? "title" : "paragraph",
    original_text: `문장 ${index} 의 내용이 계속해서 이어집니다. `,
    paragraphKey: `pk${index}`,
    rawSourceHash: `raw-${index}`,
    normalizedSourceHash: `norm-${index}`,
    node: { querySelector: () => null, dataset: {} }
  }));
}

function makeHarness(options = {}) {
  const {
    chunkDelayMs = 40,
    commitDelayMs = 100,
    failCommits = false,
    failFirstChunk = false,
    partialChunks = false
  } = options;
  const requests = [];
  const commits = [];
  let failedFirstChunk = false;
  let activeRepairs = 0;
  let maxRepairs = 0;
  let activeChunks = 0;
  let maxChunks = 0;
  const paragraphItems = makeItems(60);
  const chapter = {
    scopeKey: "book",
    seriesId: "series",
    chapterId: "c1",
    chapterTitle: "第1话",
    chapterOrder: 1,
    surface: { root: { isConnected: true } },
    paragraphs: paragraphItems
  };
  const state = {
    taskId: "",
    chapterKey: "",
    translations: new Map(),
    memoryDeltas: [],
    textDiagnostics: [],
    cacheSavedIds: new Set(),
    pendingParagraphs: new Set(),
    streamState: "idle",
    cacheStatus: "none",
    lastTextErrors: [],
    imageJobs: new Map(),
    imageContexts: new Map(),
    translationSnapshots: new Map(),
    textStatus: "idle",
    imageStatus: "idle",
    showTranslation: false,
    serviceOnline: false,
    progress: {
      textDone: 0, textTotal: 0, imageDone: 0, imageTotal: 0,
      textPhase: "", imagePhase: "", textDiagnostic: "", textWarning: "",
      textDiagnosticDetails: null
    }
  };
  const runtime = {
    state: { invalidated: false },
    getNovelState: () => state,
    reconcileKakaoNovelReader: () => chapter.surface,
    extractKakaoNovelChapter: () => chapter,
    getConfiguredSourceLanguage: () => "auto",
    getTargetLanguage: () => "zh-CN",
    resolveSourceLanguage: () => "ko",
    normalizeTranslationCacheText: value => String(value || ""),
    computeTranslationCacheHash: value => `hash:${String(value || "")}`,
    buildNovelCacheRecordId: () => "record-key",
    ensureTranslationServiceOnline: async () => ({ ok: true, records: [] }),
    getTranslationConfigFingerprint: () => "fp",
    attemptNovelTranslationStream: async () => ({ supported: false, completed: 0 }),
    getErrorMessage: error => error && error.message ? error.message : String(error),
    novelCore: {
      buildChunks: items => novel.buildChunks(items, 60)
    },
    novelMemoryCore: {
      mergeMemory: (base, delta) => ({ ...(base || {}), ...(delta || {}) })
    },
    createTranslationOperation: (type, recordKey, payload) => ({ type, recordKey, payload }),
    commitTranslationOperation: async operation => {
      const entry = { itemId: operation.payload.segmentKey, at: Date.now(), endAt: 0 };
      commits.push(entry);
      await delay(commitDelayMs);
      entry.endAt = Date.now();
      if (failCommits) throw new Error("commit failed");
      return {
        record: { activeVersion: { translatedText: operation.payload.translatedText } },
        pending: false
      };
    },
    renderNovelTranslation: () => {},
    setNovelTextStatus: () => {},
    setNovelTranslationVisibility: () => {},
    reportStatus: () => {},
    translateNovelImages: async () => {},
    scheduleNovelTermDiscovery: () => {},
    sendRuntimeMessage: async message => {
      if (message.type === "GET_NOVEL_MEMORY") return { ok: true, context: { revision: 0, memory: {} } };
      if (message.type === "CANCEL_TRANSLATION_TASK") return { ok: true, cancelled: 0 };
      if (message.type === "SAVE_NOVEL_MEMORY") return { ok: true };
      if (message.type !== "TRANSLATE_NOVEL_CHUNK") throw new Error(`unexpected message ${message.type}`);
      const single = message.items.length === 1;
      requests.push({
        at: Date.now(),
        single,
        itemIds: message.items.map(item => item.id),
        memory: message.memory,
        previousTranslation: message.previousTranslation
      });
      if (single) {
        activeRepairs += 1;
        maxRepairs = Math.max(maxRepairs, activeRepairs);
      } else {
        activeChunks += 1;
        maxChunks = Math.max(maxChunks, activeChunks);
      }
      await delay(chunkDelayMs);
      if (single) activeRepairs -= 1;
      else activeChunks -= 1;
      if (!single && failFirstChunk && !failedFirstChunk) {
        failedFirstChunk = true;
        return { ok: false, error: "chunk boom" };
      }
      const rows = message.items.map((item, index) => {
        if (!single && partialChunks && index === message.items.length - 1) return null;
        return { id: item.id, translated_text: `T(${item.id})` };
      }).filter(Boolean);
      return {
        ok: true,
        translations: rows,
        errors: [],
        warnings: [],
        memory_delta: { from: message.items[0].id }
      };
    }
  };
  installControlsUtils(runtime);
  installNovelProgressiveWorkflow(runtime);
  installNovelWorkflow(runtime);
  return {
    runtime,
    state,
    chapter,
    requests,
    commits,
    counters: () => ({ maxRepairs, maxChunks })
  };
}

test("progressive chunks run as a window-2 pipeline with ordered context", async () => {
  const harness = makeHarness();
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.translated, 60);
  const chunkRequests = harness.requests.filter(request => !request.single);
  const repairRequests = harness.requests.filter(request => request.single);
  const expectedChunks = novel.buildChunks(harness.chapter.paragraphs, 60);
  assert.equal(chunkRequests.length, expectedChunks.length);
  assert.equal(repairRequests.length, 0);
  assert.deepEqual(
    chunkRequests.map(request => request.itemIds),
    expectedChunks.map(chunk => chunk.map(item => item.id))
  );
  // 上下文按 chunk 顺序推进:后一 chunk 能看到前一 chunk 的真实译文。
  for (let index = 1; index < chunkRequests.length; index += 1) {
    const previousChunkLastId = expectedChunks[index - 1].at(-1).id;
    assert.match(chunkRequests[index].previousTranslation, new RegExp(`T\\(${previousChunkLastId}\\)`));
  }
  // memory_delta 依序并入:chunk i 的请求带 chunk i-1 的记忆。
  assert.deepEqual(chunkRequests[1].memory, { from: expectedChunks[0][0].id });
  assert.deepEqual(chunkRequests[2].memory, { from: expectedChunks[1][0].id });
  assert.deepEqual(
    harness.state.memoryDeltas.map(delta => delta.from),
    expectedChunks.map(chunk => chunk[0].id)
  );
});

test("the next chunk request overlaps the previous chunk commit phase", async () => {
  const harness = makeHarness();
  await harness.runtime.translateNovelChapter();
  const chunkRequests = harness.requests.filter(request => !request.single);
  const firstCommitEnd = harness.commits[0].endAt;
  assert.ok(
    chunkRequests[1].at < firstCommitEnd,
    `chunk 1 request (at ${chunkRequests[1].at}) should start before chunk 0 commits finish (at ${firstCommitEnd})`
  );
  assert.ok(harness.counters().maxChunks <= 2, "window-2 keeps at most 2 chunks in flight");
});

test("partial chunk responses fall back to the repair loop at repair concurrency", async () => {
  const harness = makeHarness({ partialChunks: true });
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.translated, 60);
  const expectedChunks = novel.buildChunks(harness.chapter.paragraphs, 60);
  const chunkRequests = harness.requests.filter(request => !request.single);
  const repairRequests = harness.requests.filter(request => request.single);
  assert.equal(chunkRequests.length, expectedChunks.length);
  assert.equal(repairRequests.length, expectedChunks.length);
  assert.ok(repairRequests.every(request => request.itemIds.length === 1));
  assert.equal(harness.counters().maxRepairs, 3, "repair loop runs up to 3 lanes");
  assert.equal(harness.counters().maxChunks, 1);
});

test("a failed chunk stops the pipeline and lets the repair loop finish the chapter", async () => {
  const harness = makeHarness({ failFirstChunk: true });
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.translated, 60);
  const chunkRequests = harness.requests.filter(request => !request.single);
  const repairRequests = harness.requests.filter(request => request.single);
  assert.equal(chunkRequests.length, 1, "no further chunk requests after the first failure");
  assert.equal(repairRequests.length, 60, "every paragraph is repaired individually");
  assert.equal(harness.counters().maxRepairs, 3);
  assert.deepEqual(
    harness.state.memoryDeltas.map(delta => delta.from),
    harness.chapter.paragraphs.map(item => item.id)
  );
});

test("a commit failure aborts the chapter instead of silently dropping translations", async () => {
  const harness = makeHarness({ failCommits: true });
  const result = await harness.runtime.translateNovelChapter();
  assert.equal(result.ok, false);
  assert.equal(result.error, "commit failed");
  assert.equal(harness.state.textStatus, "partial");
});
