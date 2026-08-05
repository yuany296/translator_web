import assert from "node:assert/strict";
import test from "node:test";

import { installWebpageSession, createPageSession, createSegment, getVisibleProgress } from "../extension/src/content/modules/webpage-session.js";
import { installWebpageScheduler } from "../extension/src/content/modules/webpage-scheduler.js";
import { installWebpageStartup } from "../extension/src/content/modules/webpage-startup.js";
import { installWebpageTranslate } from "../extension/src/content/modules/webpage-translate.js";

globalThis.location = { href: "https://example.com/page" };
globalThis.window = {
  innerHeight: 800, scrollY: 0, scrollX: 0,
  addEventListener() {}, removeEventListener() {},
  setTimeout, clearTimeout
};
globalThis.document = { visibilityState: "visible" };

function makeNode(name, top, connected = true) {
  const element = {
    tagName: "P",
    offsetParent: {},
    closest: () => null,
    getBoundingClientRect: () => ({ top, bottom: top + 40, left: 0, right: 200, width: 200, height: 40 })
  };
  return {
    name, isConnected: connected, nodeValue: `原文-${name}`,
    parentElement: element
  };
}

function makeEntry(node, id, pageKey = "https://example.com/page") {
  return {
    node, text: node.nodeValue, index: 0, id,
    legacyId: `legacy-${id}`, bindingKey: id, translationKey: `tk-${id}`,
    containerSignature: "sig", contextFingerprint: "ctx",
    sourceHash: `hash-${id}`, normalized: node.nodeValue,
    resolvedSourceLanguage: "ko", targetLanguage: "zh-CN", pageKey
  };
}

function makeRuntime() {
  // 测试间共享 window 状态，每个运行时重置滚动位置，避免顺序依赖
  globalThis.window.scrollY = 0;
  globalThis.window.scrollX = 0;
  const calls = { batches: [], applies: [], saves: [], offline: 0, retries: 0, refreshes: 0 };
  const webpage = {
    nodeStore: {
      activeNodes: new Set(), set() {}, get() {}, forEach() {}, prune() {},
      release() {}, clear() {}, size: 0
    },
    savedKeys: new Set(), showTranslation: true, working: false, generation: 1,
    taskId: "task-1", taskUrl: "https://example.com/page",
    pageKey: "https://example.com/page", cacheStatus: "none", session: null,
    pageFault: null, progressPanel: null, controller: { mode: "continuous", visibility: "translated" },
    progress: {}
  };
  const runtime = {
    state: { webpage },
    getWebpageState: () => webpage,
    getTargetLanguage: () => "zh-CN",
    getConfiguredSourceLanguage: () => "auto",
    normalizeTranslationCacheUrl: () => "https://example.com/page",
    getTranslationConfigFingerprint: async () => "fp",
    classifyTranslationCacheMatch: (record) => record ? "exact" : "missing",
    getWebpageEntryRecords: async entries => new Map(),
    migrateWebpageRecordToEntry: async () => null,
    updateWebpageProgress: () => {},
    refreshWebpageUi: () => { calls.refreshes += 1; },
    updateFloatingBallState: () => {},
    ensureTranslationServiceOnline: async ids => ({ ok: true, records: [] }),
    applyWebpageEntriesToSession: (session, generation, entries, translations) => {
      calls.applies.push({ session: session.pageKey, generation, ids: entries.map(e => e.id), size: translations.size });
      for (const entry of entries) {
        const segment = session.segments.get(entry.id);
        if (!segment || !translations.has(entry.text)) continue;
        segment.translatedText = String(translations.get(entry.text));
        segment.status.translation = "done";
        segment.status.rendering = "rendered";
      }
      return entries.length;
    },
    saveWebpageSegmentRecords: async (session, segments, translations) => {
      calls.saves.push({ session: session.pageKey, count: segments.length });
      return { ok: true, saved: segments.length };
    },
    translateWebpageBatchWithRetry: async (keys) => {
      calls.batches.push(keys);
      const translations = new Map(keys.map((key, index) => [key, `译文-${index}`]));
      return { ok: true, partial: false, translations, errors: [] };
    },
    collectWebpageTextNodes: () => [],
    enrichWebpageEntries: (entries) => entries.map(entry => makeEntry(entry.node, entry.id)),
    getErrorMessage: error => String(error && error.message || error)
  };
  runtime.calls = calls;
  runtime.cancelWebpageTranslationTask = state => {
    state.generation += 1;
    runtime.stopWebpageScheduler();
  };
  installWebpageSession(runtime);
  installWebpageScheduler(runtime);
  installWebpageStartup(runtime);
  return runtime;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("P0 viewport entries form the first API batch, capped at 8 items", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  // 视口内 10 段（超过 P0 批次上限 8）
  const nodes = [];
  for (let i = 0; i < 10; i += 1) nodes.push(makeEntry(makeNode(`v${i}`, 100 + i * 40), `v${i}`));
  runtime.collectWebpageTextNodes = () => nodes;
  const result = await runtime.startWebpageViewportTranslation({ session, generation: 1 });
  assert.ok(result.ok, "run completes without page fault");
  assert.equal(runtime.calls.batches.length >= 1, true);
  assert.equal(runtime.calls.batches[0].length, 8, "P0 批次上限 8 项/600 字符");
  // 剩余 P0 段继续由后续批次处理
  await waitUntil(() => runtime.calls.batches.flat().length >= 10);
});

test("background scan discoveries enter the queue immediately (P2)", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [makeEntry(makeNode("v1", 100), "v1")];
  const result = await runtime.startWebpageViewportTranslation({ session, generation: 1 });
  assert.ok(result.ok);
  assert.deepEqual(runtime.calls.batches[0], ["原文-v1"], "第一个 API 批次只能包含 P0（当前可视区）");
  // 模拟后台 TreeWalker 片段：每片发现的任务立即交给调度器
  await runtime.enqueueWebpageSegments(session,
    [makeEntry(makeNode("b1", 9000), "b1"), makeEntry(makeNode("b2", 10000), "b2")],
    "background", 1);
  await waitUntil(() => runtime.calls.batches.flat().includes("原文-b1"));
  await waitUntil(() => runtime.calls.batches.flat().includes("原文-b2"));
});

test("background TreeWalker enriches every raw node before deduplication", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [];
  runtime.enrichWebpageEntries = entries => entries.map(entry => makeEntry(entry.node, entry.node.name));
  const nodes = [makeNode("chunk-a", 5000), makeNode("chunk-b", 5100)];
  let cursor = 0;
  globalThis.document.body = {};
  globalThis.document.createTreeWalker = () => ({ nextNode: () => nodes[cursor++] || null });
  try {
    const result = await runtime.startWebpageViewportTranslation({ session, generation: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual([...session.segments.keys()].sort(), ["chunk-a", "chunk-b"]);
    assert.equal(runtime.calls.batches.flat().includes("原文-chunk-a"), true);
    assert.equal(runtime.calls.batches.flat().includes("原文-chunk-b"), true);
  } finally {
    delete globalThis.document.body;
    delete globalThis.document.createTreeWalker;
  }
});

test("streaming enrichment preserves occurrence identity across chunks", () => {
  const runtime = {
    state: {}, normalizeTranslationCacheText: text => text,
    computeTranslationCacheHash: text => `hash-${text}`,
    buildWebpageContainerSignature: () => "same-container",
    buildWebpageBindingKey: ({ localIndex }) => `binding-${localIndex}`,
    buildWebpageNeighborContext: () => ({}),
    buildWebpageContextFingerprint: () => "context",
    resolveSourceLanguage: () => "ko", getTargetLanguage: () => "zh-CN",
    buildWebpageTranslationKey: () => "translation-key",
    buildWebpageRecordIdFromBinding: ({ bindingKey }) => `record-${bindingKey}`,
    buildWebpageCacheRecordId: (_pageKey, segmentKey) => `legacy-${segmentKey}`,
    normalizeTranslationCacheUrl: () => "https://example.com/page"
  };
  installWebpageTranslate(runtime);
  const identityState = { containers: new Map(), globalOccurrences: new Map() };
  const first = runtime.enrichWebpageEntries([
    { node: makeNode("repeat-a", 100), text: "重复原文", index: 0 }
  ], "https://example.com/page", identityState)[0];
  const second = runtime.enrichWebpageEntries([
    { node: makeNode("repeat-b", 200), text: "重复原文", index: 0 }
  ], "https://example.com/page", identityState)[0];
  assert.equal(first.localIndex, 0);
  assert.equal(second.localIndex, 1);
  assert.notEqual(first.id, second.id);
});

test("cache hits remain visible in PageSession progress", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  const entry = makeEntry(makeNode("cached", 100), "cached");
  runtime.getWebpageEntryRecords = async entries => new Map(entries.map(item => [item, {
    id: item.id, translatedText: "缓存译文"
  }]));
  const result = await runtime.enqueueWebpageSegments(session, [entry], "viewport", 1);
  const segment = session.segments.get("cached");
  assert.equal(result.cached, 1);
  assert.equal(result.enqueued, 0);
  assert.equal(segment.status.translation, "done");
  assert.equal(segment.status.rendering, "rendered");
  assert.equal(segment.status.persistence, "saved");
  assert.deepEqual(runtime.getVisibleWebpageProgress(session), {
    viewportTotal: 1, viewportDone: 1, backgroundTotal: 0,
    backgroundDone: 0, pendingSave: 0, realFailed: 0, unchangedCount: 0
  });
});

test("scroll promotes an unsent P2 segment to P0 before it is sent", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  // 暂停 API：第一批只含 P0，far 保持未发送（必须在入队前替换 stub）
  const blockers = [];
  runtime.translateWebpageBatchWithRetry = async (keys) => {
    runtime.calls.batches.push(keys);
    await new Promise(resolve => blockers.push(resolve));
    return { ok: true, partial: false, translations: new Map(), errors: [] };
  };
  // 9 个视口段占满两路（P0 批次上限 8）+ 一个远处段（P2）
  const viewportEntries = [];
  for (let i = 0; i < 9; i += 1) viewportEntries.push(makeEntry(makeNode(`v${i}`, 100 + i * 40), `v${i}`));
  await runtime.enqueueWebpageSegments(session, viewportEntries, "viewport", 1);
  await runtime.enqueueWebpageSegments(session, [makeEntry(makeNode("far", 5000), "far")], "background", 1);
  try {
    await waitUntil(() => runtime.calls.batches.length >= 2);
    assert.equal(runtime.calls.batches.flat().includes("原文-far"), false, "far 未发送");
    const far = session.segments.get("far");
    assert.equal(far.priority, 2);
    // 滚动到 far 所在位置：未发送的 P2 应升为 P0
    globalThis.window.scrollY = 4600;
    far.node.parentElement.getBoundingClientRect = () => ({ top: 400, bottom: 440, left: 0, right: 200, width: 200, height: 40 });
    assert.equal(runtime.reprioritizeWebpageViewport(), 1);
    assert.equal(far.priority, 0);
    assert.equal(far.zone, "viewport");
  } finally {
    // 释放第一批后，升过级的 far 成为下一个批次
    while (blockers.length) blockers.splice(0).forEach(resolve => resolve());
  }
  await waitUntil(() => runtime.calls.batches.flat().includes("原文-far"));
});

test("at most one lane works on P2/P3; the other lane stays free for P0/P1", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  // 挂起所有批次，检查并发上限（必须在入队前替换 stub）
  const releaseAll = [];
  let inflight = 0;
  let maxInflight = 0;
  let maxLowPriority = 0;
  let lowInflight = 0;
  runtime.translateWebpageBatchWithRetry = async (keys) => {
    inflight += 1;
    const snapshot = runtime.getWebpageSchedulerSnapshot();
    lowInflight += snapshot.lowPriorityBatches;
    maxInflight = Math.max(maxInflight, inflight);
    maxLowPriority = Math.max(maxLowPriority, lowInflight);
    await new Promise(resolve => releaseAll.push(resolve));
    inflight -= 1;
    return { ok: true, partial: false, translations: new Map(keys.map(k => [k, "译"])), errors: [] };
  };
  await runtime.enqueueWebpageSegments(session, [makeEntry(makeNode("v1", 100), "v1")], "viewport", 1);
  const entries = [];
  for (let i = 0; i < 30; i += 1) entries.push(makeEntry(makeNode(`bg-${i}`, 5000 + i * 40), `bg-${i}`));
  await runtime.enqueueWebpageSegments(session, entries, "background", 1);
  try {
    await waitUntil(() => releaseAll.length >= 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(maxInflight <= 2, true, `最多两路并发，实际 ${maxInflight}`);
    assert.equal(maxLowPriority <= 1, true, `最多一路执行 P2/P3，实际 ${maxLowPriority}`);
  } finally {
    // 批次会在释放后继续启动下一批，循环释放直到队列清空
    while (releaseAll.length) {
      releaseAll.splice(0).forEach(resolve => resolve());
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  // 全部段最终处理完成
  await waitUntil(() => session.segments.size > 0
    && [...session.segments.values()].every(segment => segment.status.translation === "done"));
});

test("service offline is one page-level fault; segments block, retry unblocks", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [makeEntry(makeNode("v1", 100), "v1")];
  runtime.ensureTranslationServiceOnline = async () => ({ ok: false, status: "offline", error: "本地服务未启动" });
  const result = await runtime.startWebpageViewportTranslation({ session, generation: 1 });
  assert.equal(result.offline, true);
  assert.equal(result.blocked, 1);
  const state = runtime.getWebpageState();
  assert.equal(state.pageFault !== null, true);
  assert.equal(state.pageFault.error, "本地服务未启动");
  const segment = session.segments.get("v1");
  assert.equal(segment.status.translation, "blocked", "离线段落进入 blocked 而非逐项失败");
  assert.equal(runtime.calls.batches.length, 0, "离线时不调用翻译 API");
  // 恢复后重试只重新入队 blocked 段
  runtime.ensureTranslationServiceOnline = async () => ({ ok: true, records: [] });
  const retried = runtime.retryWebpageTranslation();
  assert.equal(retried, 1);
  await waitUntil(() => runtime.calls.batches.length >= 1);
  // 清理 30 秒重试定时器，避免拖住测试进程
  runtime.stopWebpageScheduler();
});

test("partial batch retries missing items once; final missing counts as real failure", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [makeEntry(makeNode("v1", 100), "v1")];
  const keys = [];
  runtime.translateWebpageBatchWithRetry = async (batch) => {
    keys.push(batch);
    // 第一次缺 "原文-v1"，重试仍缺 → 真实失败
    return { ok: true, partial: true, translations: new Map(), errors: [{ error: "漏项" }] };
  };
  await runtime.startWebpageViewportTranslation({ session, generation: 1 });
  assert.equal(runtime.calls.batches.length, 0, "translateWebpageBatchWithRetry 内部已重试");
  const progress = runtime.getVisibleWebpageProgress(session);
  assert.equal(progress.realFailed, 1);
  const segment = session.segments.get("v1");
  assert.equal(segment.status.translation, "failed");
});

test("late responses from a stale session save to cache but never render", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [makeEntry(makeNode("v1", 100), "v1")];
  const release = [];
  runtime.translateWebpageBatchWithRetry = async (keys) => {
    await new Promise(resolve => release.push(resolve));
    return { ok: true, partial: false, translations: new Map(keys.map(k => [k, "迟到译文"])), errors: [] };
  };
  const run = runtime.startWebpageViewportTranslation({ session, generation: 1 });
  await waitUntil(() => release.length >= 1);
  // 路由切换：generation 递增、新会话激活（旧响应成为迟到响应）
  runtime.cancelWebpageTranslationTask?.(runtime.getWebpageState());
  const nextSession = runtime.getOrCreateWebpageSession("https://example.com/other", runtime.getWebpageState().generation);
  nextSession.active = true;
  runtime.getWebpageState().session = nextSession;
  release.forEach(resolve => resolve());
  await run;
  assert.equal(runtime.calls.applies.length, 0, "旧响应禁止渲染到新会话");
  await waitUntil(() => runtime.calls.saves.length >= 1, 2000);
  assert.equal(runtime.calls.saves.length >= 1, true, "旧响应允许进入缓存");
});

test("returning to an old page reuses its in-memory session without an API call", async () => {
  const runtime = makeRuntime();
  const first = runtime.getOrCreateWebpageSession("https://example.com/a", 1);
  first.active = true;
  const second = runtime.getOrCreateWebpageSession("https://example.com/b", 2);
  second.active = true;
  // 返回旧页：getOrCreate 返回同一会话实例
  const back = runtime.getOrCreateWebpageSession("https://example.com/a", 3);
  assert.equal(back, first);
  assert.equal(back.generation, 3);
  // 旧会话的段仍在内存中，重新激活后由调度器直接渲染，不调用 API
  const node = makeNode("k1", 100);
  node.nodeValue = "原文";
  const segment = makeSegment(back, "k1");
  segment.node = node;
  segment.status.translation = "done";
  segment.translatedText = "已缓存译文";
  back.segments.set("k1", segment);
  runtime.collectWebpageTextNodes = () => [{ node, id: "k1", text: "原文", index: 0 }];
  runtime.getWebpageEntryRecords = async entries => {
    // 缓存命中路径：返回记录，随后渲染
    return new Map(entries.map(entry => [entry, { id: entry.id, translatedText: "已缓存译文", versions: [{ translatedText: "已缓存译文", createdAt: 1 }] }]));
  };
  const before = runtime.calls.batches.length;
  runtime.getWebpageState().session = back;
  await runtime.startWebpageViewportTranslation({ session: back, generation: 3 });
  assert.equal(runtime.calls.batches.length, before, "缓存命中不调用翻译 API");
  assert.equal(runtime.calls.applies.length >= 1, true, "缓存命中立即渲染");
});

function makeSegment(session, key) {
  return {
    segmentKey: key, bindingKey: key, translationKey: key, node: makeNode(key, 100),
    sourceText: "原文", normalized: "原文", sourceHash: "h", resolvedSourceLanguage: "ko",
    priority: 0, zone: "viewport",
    status: { translation: "pending", rendering: "pending", persistence: "none" },
    translatedText: "", errors: [], createdAt: Date.now(), updatedAt: Date.now()
  };
}

test("cancelled batch requeues inflight segments for the current session", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [makeEntry(makeNode("v1", 100), "v1")];
  let batchNo = 0;
  runtime.translateWebpageBatchWithRetry = async (keys) => {
    batchNo += 1;
    if (batchNo === 1) return { ok: false, cancelled: true, translations: new Map(), errors: [] };
    return { ok: true, partial: false, translations: new Map(keys.map(k => [k, "正式译文"])), errors: [] };
  };
  const run = runtime.startWebpageViewportTranslation({ session, generation: 1 });
  await waitUntil(() => batchNo >= 2, 2000);
  await run;
  assert.equal(batchNo >= 2, true, "取消后段重新入队并再次翻译");
  assert.equal(session.segments.get("v1").status.translation, "done");
  assert.equal(runtime.calls.applies.length, 1, "第二次响应正常渲染");
});

test("stale response requeues inflight segments instead of leaving them stuck", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  runtime.collectWebpageTextNodes = () => [makeEntry(makeNode("v1", 100), "v1")];
  let batchNo = 0;
  runtime.translateWebpageBatchWithRetry = async (keys) => {
    batchNo += 1;
    if (batchNo === 1) {
      // 批次 1 在途时 taskUrl 过期（模拟 translateWebpage 失败被吞的遗留场景）
      runtime.getWebpageState().taskUrl = "https://example.com/other";
      return { ok: true, partial: false, translations: new Map(keys.map(k => [k, "过期译文"])), errors: [] };
    }
    runtime.getWebpageState().taskUrl = "https://example.com/page";
    return { ok: true, partial: false, translations: new Map(keys.map(k => [k, "正式译文"])), errors: [] };
  };
  const run = runtime.startWebpageViewportTranslation({ session, generation: 1 });
  await waitUntil(() => batchNo >= 2, 2000);
  await run;
  assert.equal(batchNo >= 2, true, "过期响应后段重新入队并再次翻译");
  assert.equal(session.segments.get("v1").status.translation, "done");
  assert.equal(runtime.calls.applies.length, 1, "恢复后的响应正常渲染");
});

test("requeueWebpageSegments resets failed and done segments for retranslation", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  const failed = makeSegment(session, "f1");
  failed.status.translation = "failed";
  failed.errors = [{ error: "翻译失败" }];
  session.segments.set("f1", failed);
  const done = makeSegment(session, "d1");
  done.status.translation = "done";
  done.translatedText = "旧译文";
  session.segments.set("d1", done);
  // 只重试失败的
  runtime.requeueWebpageSegments(["failed"]);
  assert.equal(["pending", "inflight"].includes(failed.status.translation), true, "failed 段重新入队并开始翻译");
  assert.equal(done.status.translation, "done", "done 段不受重试失败影响");
  await waitUntil(() => runtime.calls.batches.flat().includes("原文"));
  // 全部重新翻译：done 也回 pending 并重新请求
  runtime.requeueWebpageSegments(["done", "failed"]);
  assert.equal(done.status.translation, "pending");
  await waitUntil(() => done.status.translation === "done" && done.translatedText !== "旧译文");
});

test("failed segments re-enqueue on rescan (force-update retries them)", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  const node = makeNode("v1", 100);
  const segment = makeSegment(session, "v1");
  segment.node = node;
  segment.status.translation = "failed";
  segment.errors = [{ error: "翻译失败" }];
  session.segments.set("v1", segment);
  // force-update 重新扫描：failed 段应重新入队并翻译成功
  runtime.collectWebpageTextNodes = () => [{ node, id: "v1", text: "原文-v1", index: 0 }];
  runtime.getWebpageEntryRecords = async () => new Map();
  const run = runtime.startWebpageViewportTranslation({ session, generation: 1 });
  await waitUntil(() => session.segments.get("v1")?.status.translation === "done");
  await run;
  assert.equal(session.segments.get("v1").status.translation, "done", "failed 段重新入队并翻译成功");
});

test("状态迁移统一经 refreshWebpageUi 刷新（enqueue / settle / offline / retry）", async () => {
  const runtime = makeRuntime();
  const session = runtime.getOrCreateWebpageSession("https://example.com/page", 1);
  runtime.getWebpageState().session = session;
  const entry = makeEntry(makeNode("v0", 100), "v0");
  await runtime.enqueueWebpageSegments(session, [entry], "viewport", 1);
  assert.equal(runtime.calls.refreshes >= 1, true, "enqueue 触发刷新");
  await waitUntil(() => session.segments.get("v0")?.status.translation === "done");
  assert.equal(runtime.calls.refreshes >= 2, true, "settle 触发刷新");
  const afterSettle = runtime.calls.refreshes;
  runtime.markWebpageServiceOffline(new Error("离线"));
  assert.equal(runtime.calls.refreshes > afterSettle, true, "offline 触发刷新");
  runtime.retryWebpageTranslation();
  assert.equal(runtime.calls.refreshes > afterSettle, true, "retry 触发刷新");
});

test("unchanged: 译文与原文相同的段标记 unchanged，计入完成不计入失败", () => {
  const webpage = {
    session: null, showTranslation: true, generation: 1, pageKey: "p1",
    nodeStore: { set() {}, get() {} }
  };
  const runtime = {
    state: { webpage },
    getWebpageState: () => webpage,
    normalizeWebpageText: text => String(text || "").trim(),
    updateFloatingBallState: () => {}
  };
  installWebpageTranslate(runtime);
  const session = createPageSession("p1", 1);
  webpage.session = session;
  // 글개미 → 글개미（模型保留专名原文）→ unchanged
  const node1 = { nodeValue: "글개미", isConnected: true, parentElement: {} };
  const seg1 = createSegment({ segmentKey: "s1", bindingKey: "b1", translationKey: "t1", node: node1, text: "글개미", normalized: "글개미", sourceHash: "h1" });
  session.segments.set("s1", seg1);
  // 김성현 → 金圣显（正常翻译）→ translated
  const node2 = { nodeValue: "김성현", isConnected: true, parentElement: {} };
  const seg2 = createSegment({ segmentKey: "s2", bindingKey: "b2", translationKey: "t2", node: node2, text: "김성현", normalized: "김성현", sourceHash: "h2" });
  session.segments.set("s2", seg2);
  runtime.applyWebpageEntriesToSession(session, 1, [
    { node: node1, text: "글개미", id: "s1", sourceHash: "h1", pageKey: "p1" },
    { node: node2, text: "김성현", id: "s2", sourceHash: "h2", pageKey: "p1" }
  ], new Map([["글개미", "글개미"], ["김성현", "金圣显"]]));
  assert.equal(seg1.status.translation, "done", "原文保留视为完成");
  assert.equal(seg1.unchanged, true);
  assert.equal(seg2.status.translation, "done");
  assert.equal(seg2.unchanged, false, "译文不同为 translated");
  const progress = getVisibleProgress(session);
  assert.equal(progress.unchangedCount, 1);
  assert.equal(progress.realFailed, 0);
});
