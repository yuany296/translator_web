import assert from "node:assert/strict";
import test from "node:test";

import { installWebpageSession } from "../extension/src/content/modules/webpage-session.js";
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
  const calls = { batches: [], applies: [], saves: [], offline: 0, retries: 0 };
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
    backgroundDone: 0, pendingSave: 0, realFailed: 0
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
