import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TUNING,
  TUNING_KEY,
  TUNING_LIMITS,
  describeTuning,
  loadNovelTuning,
  normalizeTuning
} from "../extension/src/novel-mobile/novel-tuning.js";
import { installNovelBatch } from "../extension/src/novel-mobile/novel-batch.js";
import { installControlsUtils } from "../extension/src/content/modules/controls-utils.js";
import novelCore from "../extension/src/shared/novel.js";

// 并发与每块字数从写死常量变成用户可调（设置页 → 常规 → 翻译速度）。
// 这里盯三件事：脏数据一定收敛、内容脚本会读到用户设置、设置页的卡片能读能存。
test("默认值就是原来的常量（不改设置时行为不变）", () => {
  assert.deepEqual(DEFAULT_TUNING, { concurrency: 6, chunkChars: 1200, repairParagraphs: 3 });
  assert.deepEqual(normalizeTuning(undefined), DEFAULT_TUNING);
  assert.deepEqual(normalizeTuning({}), DEFAULT_TUNING);
});

test("脏数据收敛到边界内，不会让翻译跑飞", () => {
  assert.deepEqual(normalizeTuning({ concurrency: 99, chunkChars: 10, repairParagraphs: -5 }), {
    concurrency: TUNING_LIMITS.concurrency.max,
    chunkChars: TUNING_LIMITS.chunkChars.min,
    repairParagraphs: TUNING_LIMITS.repairParagraphs.min
  });
  assert.deepEqual(normalizeTuning({ concurrency: "0", chunkChars: "abc", repairParagraphs: null }), {
    concurrency: TUNING_LIMITS.concurrency.min,
    chunkChars: DEFAULT_TUNING.chunkChars,
    repairParagraphs: DEFAULT_TUNING.repairParagraphs
  });
  assert.deepEqual(normalizeTuning({ concurrency: 4.6, chunkChars: 900.2, repairParagraphs: 2.4 }), {
    concurrency: 5, chunkChars: 900, repairParagraphs: 2
  });
});

test("设置页的说明文案会按当前值算出块数与轮数", () => {
  assert.equal(describeTuning(DEFAULT_TUNING),
    "当前：并发 6 · 每块 1200 字（一屏约 3000 字 → 3 块，约 1 轮发完）");
  assert.equal(describeTuning({ concurrency: 2, chunkChars: 600 }),
    "当前：并发 2 · 每块 600 字（一屏约 3000 字 → 5 块，约 3 轮发完）");
});

test("读设置：有就用，没有/出错就用默认", async () => {
  const stored = await loadNovelTuning({ storageGet: async () => ({ [TUNING_KEY]: { concurrency: 8, chunkChars: 800 } }) });
  assert.deepEqual(stored, { concurrency: 8, chunkChars: 800, repairParagraphs: 3 });
  assert.deepEqual(await loadNovelTuning({ storageGet: async () => ({}) }), DEFAULT_TUNING);
  assert.deepEqual(await loadNovelTuning({ storageGet: async () => { throw new Error("storage down"); } }), DEFAULT_TUNING);
  assert.deepEqual(await loadNovelTuning({}), DEFAULT_TUNING);
});

// ── 内容脚本侧：用户设置真的会改变切块 ────────────────────────────────────
function makeHarness(storedTuning) {
  const requests = [];
  const paragraphs = Array.from({ length: 8 }, (_, index) => ({
    id: String(index), index, kind: "paragraph", original_text: "가".repeat(300),
    paragraphKey: `p${index}`, rawSourceHash: `raw-${index}`, normalizedSourceHash: `norm-${index}`,
    node: { dataset: {} }
  }));
  const state = { taskId: "t", translations: new Map(), pendingParagraphs: new Set(), progress: {} };
  const chapter = { scopeKey: "kakao:1", seriesId: "1", chapterId: "c1", paragraphs, surface: {} };
  const runtime = {
    novelCore,
    storageGet: async keys => ({ [TUNING_KEY]: storedTuning }),
    getConfiguredSourceLanguage: () => "auto",
    getTargetLanguage: () => "zh-CN",
    resolveSourceLanguage: () => "ko",
    normalizeTranslationCacheText: value => String(value || ""),
    buildNovelRecordKey: (chapterValue, item) => `key-${item.id}`,
    createTranslationOperation: (type, recordKey, payload) => ({ type, recordKey, payload }),
    commitTranslationOperation: async operation => ({
      ok: true, pending: false, record: { activeVersion: { translatedText: operation.payload.translatedText } }
    }),
    renderNovelTranslation: () => {},
    findKakaoNovelSurface: () => chapter.surface,
    novelSurfaceSignature: () => "sig",
    reapplyNovelTranslations: () => {},
    setNovelTextStatus: () => {},
    collectTextDiagnostics: () => {},
    getErrorMessage: error => String(error && error.message || error || ""),
    sendRuntimeMessage: async request => {
      requests.push(request.items.map(item => item.id));
      return {
        ok: true,
        translations: request.items.map(item => ({ id: item.id, translated_text: "他说了一句话。" })),
        errors: [], warnings: [], diagnostics: [{ status: "parsed" }]
      };
    }
  };
  installControlsUtils(runtime);
  installNovelBatch(runtime);
  return { runtime, state, chapter, requests, allItems: paragraphs };
}

async function run(harness) {
  await harness.runtime.runNovelProgressiveTranslation({
    chapter: harness.chapter, state: harness.state, allItems: harness.allItems,
    pending: harness.allItems, force: false, fingerprint: "fp"
  });
  return harness.requests;
}

test("并发与块大小按用户设置走：8 段 × 300 字，设 2 块 / 4 并发 = 每块 4 段", async () => {
  const requests = await run(makeHarness({ concurrency: 4, chunkChars: 1200 }));
  assert.deepEqual(requests.map(ids => ids.length), [4, 4]);
});

test("把每块字数调小 → 块数变多（这就是用户能自己换速度的那个旋钮）", async () => {
  const requests = await run(makeHarness({ concurrency: 4, chunkChars: 600 }));
  assert.deepEqual(requests.map(ids => ids.length), [2, 2, 2, 2]);
});

test("设置读不到时退回默认切法", async () => {
  const requests = await run(makeHarness(null));
  assert.deepEqual(requests.map(ids => ids.length), [4, 4], "默认 1200 字 → 两块各 4 段");
});
