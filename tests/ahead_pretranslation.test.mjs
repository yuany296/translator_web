import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installScheduler } from "../extension/src/content/modules/scheduler.js";
import { installReaderObservers } from "../extension/src/content/modules/reader-observers.js";
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from "../extension/src/config/schema.js";

const readerStateSource = readFileSync(
  new URL("../extension/src/content/modules/reader-state.js", import.meta.url), "utf8"
);

function makeSchedulerRuntime(overrides = {}) {
  const runtime = {
    state: {
      queue: [],
      runningJobs: 0,
      runningAheadJobs: 0,
      pretranslateAheadCount: undefined,
      ...(overrides.state || {})
    },
    PRETRANSLATE_AHEAD_COUNT: 6,
    MAX_PARALLEL_TRANSLATIONS: 6,
    VISIBLE_TRANSLATION_RESERVED_SLOTS: 3,
    isAheadTranslationOptions: options => String(options && options.reason || "").startsWith("ahead-"),
    isAutomaticPretranslateMode: value => value === "ahead" || value === "continuous",
    ...overrides
  };
  installScheduler(runtime);
  installReaderObservers(runtime);
  return runtime;
}

function aheadItem() {
  return { options: { reason: "ahead-viewport" }, target: {} };
}

function visibleItem() {
  return { options: { reason: "page-auto" }, target: {} };
}

// 本地 OCR 服务曾经是一把全局锁串行执行，于是 Kakao 把领先并发压到 1（保留 5 个槽位）。
// 锁已经不存在，领先并发必须放开，否则「领先 6 张」只是排队 6 张、同时只跑 1 张。
test("Kakao 的可见保留槽位为 3（领先并发 = 3），不再是 5", () => {
  assert.match(readerStateSource, /const VISIBLE_TRANSLATION_RESERVED_SLOTS = runtime\.IS_KAKAOPAGE_READER \? 3 : 0;/u);
  assert.doesNotMatch(readerStateSource, /VISIBLE_TRANSLATION_RESERVED_SLOTS = runtime\.IS_KAKAOPAGE_READER \? runtime\.MAX_PARALLEL_TRANSLATIONS - 1/u);

  const runtime = makeSchedulerRuntime();
  const startable = count => runtime.canStartQueuedTranslation(aheadItem(), {
    runningJobs: count,
    runningAheadJobs: count,
    maxParallel: runtime.MAX_PARALLEL_TRANSLATIONS,
    reservedSlots: runtime.VISIBLE_TRANSLATION_RESERVED_SLOTS
  });

  assert.equal(startable(2), true, "领先并发应允许第 3 个在途任务");
  assert.equal(startable(3), false, "领先并发上限为 3，不再允许第 4 个");
  assert.equal(runtime.canStartQueuedTranslation(visibleItem(), {
    runningJobs: 6, runningAheadJobs: 3, maxParallel: 6, reservedSlots: 3
  }), false, "总并发仍然受 MAX_PARALLEL_TRANSLATIONS 限制");
});

test("领先张数是配置项，默认 6 并夹在 1..12", () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.pretranslateAheadCount, 6);
  assert.equal(normalizeRuntimeConfig({}).pretranslateAheadCount, 6);
  assert.equal(normalizeRuntimeConfig({ pretranslateAheadCount: 10 }).pretranslateAheadCount, 10);
  assert.equal(normalizeRuntimeConfig({ pretranslateAheadCount: 0 }).pretranslateAheadCount, 1);
  assert.equal(normalizeRuntimeConfig({ pretranslateAheadCount: 99 }).pretranslateAheadCount, 12);
  assert.equal(normalizeRuntimeConfig({ pretranslateAheadCount: "abc" }).pretranslateAheadCount, 6);
});

test("领先候选按配置的张数截取", () => {
  const runtime = makeSchedulerRuntime({ state: { pretranslateAheadCount: 2 } });
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    getBoundingClientRect: () => ({ top: index * 500, bottom: index * 500 + 400 })
  }));

  const selected = runtime.selectPendingAheadCandidates(candidates, 0, () => true);

  assert.equal(selected.length, 3, "配置 2 时取 2+1 张（含当前视口锚点那张）");
});

test("已经滚到视口上方的领先排队任务会被丢掉", () => {
  const above = { options: { reason: "ahead-viewport" }, target: { getBoundingClientRect: () => ({ top: -900, bottom: -500 }) } };
  const below = { options: { reason: "ahead-viewport" }, target: { getBoundingClientRect: () => ({ top: 900, bottom: 1700 }) } };
  const visible = { options: { reason: "page-auto" }, target: { getBoundingClientRect: () => ({ top: -100, bottom: 100 }) } };
  const queuedTargets = new Set([above.target, below.target, visible.target]);
  const runtime = makeSchedulerRuntime({ state: { queue: [above, below, visible], queuedTargets } });

  assert.equal(runtime.pruneStaleAheadTranslations(), 1);
  assert.deepEqual(runtime.state.queue, [below, visible]);
  assert.equal(queuedTargets.has(above.target), false);
  assert.equal(queuedTargets.has(below.target), true);
  assert.equal(runtime.pruneStaleAheadTranslations(), 0);
});

test("可见页在排队等槽位时不再派发新的领先任务", () => {
  const runtime = makeSchedulerRuntime({ state: { queue: [visibleItem()], runningJobs: 6 } });
  assert.equal(runtime.visibleQueueOutnumbersFreeSlots(), true);
  assert.equal(runtime.shouldSchedulePagePretranslation({
    enabled: true, pageEnabled: true, mode: "ahead", invalidated: false
  }), false);

  // 槽位够用时照常派发（刚点开自动翻译时可见任务也在队列里，不能因此卡住领先预翻译）。
  runtime.state.runningJobs = 0;
  assert.equal(runtime.visibleQueueOutnumbersFreeSlots(), false);
  assert.equal(runtime.shouldSchedulePagePretranslation({
    enabled: true, pageEnabled: true, mode: "ahead", invalidated: false
  }), true);

  // 只有领先任务在队列里时不受影响。
  runtime.state.queue = [aheadItem()];
  runtime.state.runningJobs = 6;
  assert.equal(runtime.visibleQueueOutnumbersFreeSlots(), false);
});
