import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from "../extension/src/config/schema.js";
import {
  NOVEL_SPEED_DEFAULTS, NOVEL_SPEED_LIMITS, clampNovelSpeed, describeNovelSpeed, resolveNovelSpeed
} from "../extension/src/shared/novel-speed.js";
import { installNovelStreamWorkflow } from "../extension/src/content/modules/novel-stream-workflow.js";
import { installNovelProgressiveWorkflow } from "../extension/src/content/modules/novel-progressive-workflow.js";
import { installControlsUtils } from "../extension/src/content/modules/controls-utils.js";
import novel from "../extension/src/shared/novel.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 桌面版小说速度参数：默认值必须与「改成可调之前写死的常量」逐个相等，
// 否则不动设置的老用户也会被改行为（这是这次改动的底线）。
test("默认值与改动前的写死常量一致", () => {
  assert.equal(NOVEL_SPEED_DEFAULTS.streamConcurrency, 3, "STREAM_BATCH_CONCURRENCY 原来是 3");
  assert.equal(NOVEL_SPEED_DEFAULTS.chunkChars, 1400, "CHUNK_TARGET_CHARS 原来是 1400");
  assert.equal(NOVEL_SPEED_DEFAULTS.repairConcurrency, 3, "REPAIR_CONCURRENCY 原来是 3");
  assert.equal(DEFAULT_RUNTIME_CONFIG.novelStreamConcurrency, 3);
  assert.equal(DEFAULT_RUNTIME_CONFIG.novelChunkChars, 1400);
  assert.equal(DEFAULT_RUNTIME_CONFIG.novelRepairConcurrency, 3);
  const config = normalizeRuntimeConfig({});
  assert.equal(config.novelStreamConcurrency, 3);
  assert.equal(config.novelChunkChars, 1400);
  assert.equal(config.novelRepairConcurrency, 3);
  // 旧配置（这次改动之前保存的）没有任何新字段，读出来必须还是老行为
  const legacy = normalizeRuntimeConfig({ novelStreamBatchSize: 50, displayMode: "translated" });
  assert.equal(legacy.novelChunkChars, 1400);
  assert.equal(novel.buildChunks([{ id: "a", original_text: "가".repeat(1400) }]).length, 1,
    "buildChunks 的兜底默认值同样来自 NOVEL_SPEED_DEFAULTS");
});

test("脏数据一律收敛：空值回默认，越界夹到边界，绝不被当成 0", () => {
  for (const key of Object.keys(NOVEL_SPEED_DEFAULTS)) {
    const fallback = NOVEL_SPEED_DEFAULTS[key];
    for (const empty of [null, undefined, "", "   "]) {
      assert.equal(clampNovelSpeed(key, empty), fallback, `${key} 的 ${JSON.stringify(empty)} 应该回默认值`);
    }
    assert.equal(clampNovelSpeed(key, "abc"), fallback, `${key} 的非数字字符串回默认值`);
    assert.equal(clampNovelSpeed(key, 0), NOVEL_SPEED_LIMITS[key].min, `${key} 的 0 夹到下限`);
    assert.equal(clampNovelSpeed(key, 1e6), NOVEL_SPEED_LIMITS[key].max, `${key} 的超大值夹到上限`);
  }
  // 数字字符串（设置页 <input> 拿到的就是字符串）必须能用
  assert.equal(clampNovelSpeed("chunkChars", "900"), 900);
  assert.equal(clampNovelSpeed("streamConcurrency", "6"), 6);
  assert.equal(normalizeRuntimeConfig({ novelChunkChars: "900" }).novelChunkChars, 900);
  assert.equal(normalizeRuntimeConfig({ novelChunkChars: 2000 }).novelChunkChars, 2000);
  assert.equal(normalizeRuntimeConfig({ novelStreamConcurrency: 99 }).novelStreamConcurrency, 8);
  assert.equal(normalizeRuntimeConfig({ novelRepairConcurrency: null }).novelRepairConcurrency, 3);
});

test("resolveNovelSpeed 从 runtime.state 取值，state 缺失不炸", () => {
  assert.deepEqual(resolveNovelSpeed(undefined), { ...NOVEL_SPEED_DEFAULTS });
  assert.deepEqual(resolveNovelSpeed({}), { ...NOVEL_SPEED_DEFAULTS });
  assert.deepEqual(resolveNovelSpeed({ novelStreamBatchSize: 120 }), { ...NOVEL_SPEED_DEFAULTS });
  assert.deepEqual(resolveNovelSpeed({
    novelStreamConcurrency: 5, novelChunkChars: 800, novelRepairConcurrency: 2
  }), { streamConcurrency: 5, chunkChars: 800, repairConcurrency: 2 });
  assert.deepEqual(resolveNovelSpeed({ novelChunkChars: "" }), { ...NOVEL_SPEED_DEFAULTS });
});

test("describeNovelSpeed 把「一轮最多翻多少段」算给用户看", () => {
  const text = describeNovelSpeed({
    streamConcurrency: 3, streamBatchSize: 50, chunkChars: 1400, repairConcurrency: 3
  });
  assert.match(text, /流式并发 3 × 每批 50 段（一轮最多 150 段）/u);
  assert.match(text, /渐进每块 1400 字/u);
  assert.match(text, /补翻并发 3/u);
  assert.match(describeNovelSpeed({ streamConcurrency: 99, streamBatchSize: "abc" }), /并发 8 × 每批 50 段/u);
  assert.doesNotMatch(describeNovelSpeed({}), /NaN|undefined/u);
});

test("设置页与控制器都接上了这三个参数", () => {
  const html = read("extension", "public", "settings.html");
  const controller = read("extension", "src", "settings", "controller.js");
  assert.match(html, /id="novelStreamConcurrency" type="number" min="1" max="8"/u);
  assert.match(html, /id="novelChunkChars" type="number" min="400" max="4000"/u);
  assert.match(html, /id="novelRepairConcurrency" type="number" min="1" max="8"/u);
  assert.match(html, /id="novelSpeedHint"/u);
  // 读进来要回填、保存要写回、输入时要实时更新那句提示
  ["novelStreamConcurrency", "novelChunkChars", "novelRepairConcurrency"].forEach(id => {
    assert.match(controller, new RegExp(`${id}: numberValue\\("${id}"\\)`, "u"), `${id} 保存时要写回`);
    assert.match(controller, new RegExp(`\\["${id}", runtime\\.${id}\\]`, "u"), `${id} 打开设置页要回填`);
  });
  assert.match(controller, /updateNovelSpeedHint/u);
  assert.match(controller, /describeNovelSpeed/u);
});

// —— 流式通道：并发数是真的并发 ──────────────────────────────────────────────
function createStreamHarness() {
  const runtime = {
    state: {},
    runNovelTranslationStream: async () => ({ completed: 0, failed: 0, protocolErrors: 0 }),
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
  const chapter = { scopeKey: "book", seriesId: "series", chapterId: "c1", chapterTitle: "第1话", paragraphs: [] };
  const state = {
    taskId: "task", chapterKey: "book:c1", streamState: "idle",
    progress: { textDone: 0, textTotal: 0, textPhase: "" },
    translations: new Map(), pendingParagraphs: new Set(), translationSnapshots: new Map()
  };
  return { runtime, chapter, state };
}

function makeParagraphs(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index), index, kind: "paragraph", paragraphKey: `p${index}`,
    original_text: `문장 ${index}`,
    rawSourceHash: `raw-${index}`, normalizedSourceHash: `norm-${index}`
  }));
}

async function measureStreamLanes(concurrency) {
  const harness = createStreamHarness();
  harness.runtime.state = concurrency === undefined ? {} : { novelStreamConcurrency: concurrency };
  let inFlight = 0;
  let maxInFlight = 0;
  let batches = 0;
  harness.runtime.runNovelTranslationStream = async request => {
    batches += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(10);
    inFlight -= 1;
    return { completed: request.items.length, failed: 0, protocolErrors: 0 };
  };
  const result = await harness.runtime.attemptNovelTranslationStream(
    harness.chapter, harness.state, makeParagraphs(600), "fp", {}
  );
  return { maxInFlight, batches, result };
}

test("流式并发按设置跑：默认 3 条车道", async () => {
  const { maxInFlight, batches } = await measureStreamLanes(undefined);
  assert.equal(batches, 12, "600 段 ÷ 每批 50 段");
  assert.equal(maxInFlight, 3);
});

test("流式并发可以调到 1（串行）也可以调高", async () => {
  assert.equal((await measureStreamLanes(1)).maxInFlight, 1);
  assert.equal((await measureStreamLanes(6)).maxInFlight, 6);
  assert.equal((await measureStreamLanes(99)).maxInFlight, 8, "越界值按上限 8 收敛");
  assert.equal((await measureStreamLanes(0)).maxInFlight, 1, "0 收敛到下限 1，不是不发请求");
});

// —— 渐进通道：每块字数是真的传下去、补翻并发是真的并行 ──────────────────────
function createProgressiveHarness({ chunkChars, repairConcurrency, partial = true, count = 60 } = {}) {
  const seenChunkChars = [];
  const items = makeParagraphs(count).map((item, index) => ({
    ...item,
    original_text: `문장 ${index} 의 내용이 계속해서 이어집니다. `,
    node: { dataset: {} }
  }));
  const chapter = {
    scopeKey: "book", seriesId: "series", chapterId: "c1", chapterTitle: "第1话", chapterOrder: 1,
    surface: { root: { isConnected: true } }, paragraphs: items
  };
  const state = {
    taskId: "task", chapterKey: "book:c1", translations: new Map(),
    pendingParagraphs: new Set(), translationSnapshots: new Map(),
    progress: { textDone: 0, textTotal: 0, textPhase: "" }
  };
  let activeRepairs = 0;
  let maxRepairs = 0;
  const requests = [];
  const runtime = {
    state: { novelChunkChars: chunkChars, novelRepairConcurrency: repairConcurrency },
    novelCore: {
      buildChunks: (pending, chars) => {
        seenChunkChars.push(chars);
        return novel.buildChunks(pending, chars);
      }
    },
    buildNovelRecordKey: (chapterValue, item) => `record-${item.id}`,
    createTranslationOperation: (type, recordKey, payload) => ({ type, recordKey, payload }),
    commitTranslationOperation: async operation => ({
      record: { activeVersion: { translatedText: operation.payload.translatedText } }, pending: false
    }),
    renderNovelTranslation: () => {},
    setNovelTextStatus: () => {},
    collectTextDiagnostics: () => {},
    getConfiguredSourceLanguage: () => "auto",
    getTargetLanguage: () => "zh-CN",
    resolveSourceLanguage: () => "ko",
    normalizeTranslationCacheText: value => String(value || ""),
    getErrorMessage: error => error && error.message ? error.message : String(error),
    sendRuntimeMessage: async message => {
      const single = message.items.length === 1;
      requests.push({ size: message.items.length, ids: message.items.map(item => item.id) });
      if (single) {
        activeRepairs += 1;
        maxRepairs = Math.max(maxRepairs, activeRepairs);
        await delay(20);
        activeRepairs -= 1;
      } else {
        await delay(5);
      }
      const rows = message.items
        .map((item, index) => (!single && partial && index === message.items.length - 1
          ? null : { id: item.id, translated_text: `T(${item.id})` }))
        .filter(Boolean);
      return { ok: true, translations: rows, errors: [], warnings: [] };
    }
  };
  installControlsUtils(runtime);
  installNovelProgressiveWorkflow(runtime);
  return {
    runtime, chapter, state, items, requests, seenChunkChars,
    counters: () => ({ maxRepairs })
  };
}

async function runProgressive(options) {
  const harness = createProgressiveHarness(options);
  const result = await harness.runtime.runNovelProgressiveTranslation({
    chapter: harness.chapter, state: harness.state, allItems: harness.items,
    pending: harness.items, force: false, fingerprint: "fp"
  });
  return { harness, result };
}

test("渐进通道按设置的字数切块（值真的传给了 buildChunks）", async () => {
  const small = await runProgressive({ chunkChars: 400, repairConcurrency: 3, partial: false });
  const big = await runProgressive({ chunkChars: 4000, repairConcurrency: 3, partial: false });
  assert.deepEqual(small.harness.seenChunkChars, [400]);
  assert.deepEqual(big.harness.seenChunkChars, [4000]);
  assert.ok(
    small.harness.requests.filter(request => request.size > 1).length
      > big.harness.requests.filter(request => request.size > 1).length,
    "每块字数越小，块数越多"
  );
  assert.equal(
    big.harness.requests.filter(request => request.size > 1).length,
    novel.buildChunks(big.harness.items, 4000).length
  );
});

test("渐进通道的兜底默认值仍是 1400 字（不配置就与改动前一致）", async () => {
  const { harness } = await runProgressive({ chunkChars: undefined, repairConcurrency: undefined, partial: false });
  assert.deepEqual(harness.seenChunkChars, [1400]);
  assert.equal(
    harness.requests.filter(request => request.size > 1).length,
    novel.buildChunks(harness.items, 1400).length
  );
});

test("补翻并发按设置跑（漏译逐段补齐）", async () => {
  // 200 段 × 400 字/块 → 十几块，每块丢最后一段 → 十几段待补，足够喂满任意并发上限
  const options = { chunkChars: 400, count: 200 };
  const serial = await runProgressive({ ...options, repairConcurrency: 1 });
  const parallel = await runProgressive({ ...options, repairConcurrency: 4 });
  const fallback = await runProgressive({ ...options, repairConcurrency: undefined });
  const repairCount = harness => harness.requests.filter(request => request.size === 1).length;
  assert.ok(repairCount(serial.harness) >= 4, "待补段数要足够多，否则并发上限测不出来");
  assert.equal(serial.harness.counters().maxRepairs, 1);
  assert.equal(parallel.harness.counters().maxRepairs, 4);
  assert.equal(fallback.harness.counters().maxRepairs, 3, "默认仍是 3");
  assert.equal(parallel.result.errors.length, 0);
});
