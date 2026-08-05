/**
 * Viewport-first startup for continuous webpage translation.
 *
 *   1. Quick discovery of the current viewport and the two adjacent screens,
 *      immediate cache query; hits render right away, misses enter P0/P1.
 *   2. An async TreeWalker keeps scanning the rest of the document in chunks
 *      (≤8ms or 200 nodes); every discovered chunk is handed to the scheduler
 *      immediately, never waiting for the whole page scan.
 *   3. Drain the queue; a service outage becomes one page-level fault
 *      (segments go "blocked", not per-item failures).
 */
import scanner from "./webpage-scanner.js";

export function installWebpageStartup(runtime) {
  function isStale(session, generation) {
    const webpage = runtime.getWebpageState();
    return session !== webpage.session || generation !== webpage.generation || webpage.taskUrl !== location.href;
  }

  async function drainWebpageQueue(session, generation) {
    while (true) {
      if (isStale(session, generation)) return false;
      if (runtime.getWebpageState().pageFault) return false;
      if (!runtime.isWebpageQueueBusy()) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async function backgroundScan(session, generation) {
    const state = runtime.webpageSchedulerState;
    if (state.backgroundScanning) return;
    state.backgroundScanning = true;
    state.scanCancelled = false;
    try {
      const walker = scanner.createWebpageScanWalker();
      if (!walker) return;
      const identityState = { containers: new Map(), globalOccurrences: new Map() };
      while (!state.scanCancelled) {
        if (isStale(session, generation)) return;
        const { done, entries } = scanner.takeNextWebpageTextChunk(walker, {
          maxNodes: 200, timeBudgetMs: 8
        });
        if (entries.length) {
          const enriched = runtime.enrichWebpageEntries(entries, session.pageKey, identityState);
          await runtime.enqueueWebpageSegments(session, enriched, "background", generation);
        }
        if (done) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      state.backgroundScanning = false;
    }
  }

  function progressState(session) {
    let done = 0;
    let total = 0;
    for (const segment of session.segments.values()) {
      total += 1;
      if (segment.status.translation === "done") done += 1;
    }
    return total > 0 && done >= total;
  }

  async function startWebpageViewportTranslation(options = {}) {
    const webpage = runtime.getWebpageState();
    const session = options.session || webpage.session;
    if (!session) return { ok: false, error: "no session" };
    const generation = session.generation;
    runtime.stopWebpageScheduler();
    runtime.webpageSchedulerState.stopped = false;
    webpage.working = true;
    try {
      // 1. 快速发现当前视口和上下两屏文本，立即查询缓存
      const scanned = runtime.collectWebpageTextNodes();
      const entries = runtime.enrichWebpageEntries(scanned, session.pageKey);
      const viewportEntries = [];
      const nearEntries = [];
      for (const entry of entries) {
        if (webpage.nodeStore.activeNodes.has(entry.node)) continue;
        const existing = session.segments.get(entry.id);
        if (existing) {
          // failed 段或节点已断开的段重新入队（force-update 重试失败段）；
          // 其余既有段重新挂新节点，内存译文由下方内存命中阶段复用
          if (existing.status.translation === "failed" || !existing.node?.isConnected) {
            viewportEntries.push(entry);
          } else if (!existing.node?.isConnected) {
            existing.node = entry.node;
          }
          continue;
        }
        const zone = runtime.computeWebpageSegmentZone(entry.node);
        if (zone === "viewport") viewportEntries.push(entry);
        else if (zone === "near") nearEntries.push(entry);
      }
      // 内存命中：返回旧页面时直接复用会话内译文，不调用翻译 API
      let memoryApplied = 0;
      for (const segment of session.segments.values()) {
        if (segment.status.translation !== "done" || !segment.translatedText) continue;
        if (segment.status.rendering === "rendered") continue;
        const node = segment.node;
        if (!node || !node.isConnected
          || String(node.nodeValue || "").trim() !== String(segment.sourceText || "").trim()) continue;
        const applied = runtime.applyWebpageEntriesToSession(session, generation,
          [{ node, text: segment.sourceText, id: segment.segmentKey, sourceHash: segment.sourceHash, pageKey: session.pageKey }],
          new Map([[segment.sourceText, segment.translatedText]]));
        if (applied) memoryApplied += 1;
      }
      // 服务在线检查 + SQLite 记录双读（离线记录为一次页面级故障）
      const service = await runtime.ensureTranslationServiceOnline(entries.map(entry => entry.id));
      if (isStale(session, generation)) return { ok: false, cancelled: true };
      if (!service.ok) {
        // 先入队再标记 blocked：段保持可重试状态，而不是消失
        const scheduler = runtime.webpageSchedulerState;
        scheduler.paused = true;
        try {
          await runtime.enqueueWebpageSegments(session, viewportEntries, "viewport", generation, options);
          await runtime.enqueueWebpageSegments(session, nearEntries, "near", generation, options);
        } finally {
          scheduler.paused = false;
        }
        runtime.markWebpageServiceOffline(service.error);
        return { ok: false, offline: true, blocked: session.segments.size };
      }
      const viewportResults = await runtime.enqueueWebpageSegments(
        session, viewportEntries, "viewport", generation, options
      );
      if (isStale(session, generation)) return { ok: false, cancelled: true };
      const nearResults = await runtime.enqueueWebpageSegments(session, nearEntries, "near", generation, options);
      if (isStale(session, generation)) return { ok: false, cancelled: true };
      // 2. 后台异步扫描剩余文档，每片发现的任务立即交给调度器
      const scanPromise = backgroundScan(session, generation);
      // 3. 等待队列排空或页面级故障
      const drained = await drainWebpageQueue(session, generation);
      await scanPromise;
      await drainWebpageQueue(session, generation);
      if (isStale(session, generation)) return { ok: false, cancelled: true };
      const progress = runtime.getVisibleWebpageProgress(session);
      const blocked = webpage.pageFault ? session.segments.size : 0;
      return {
        ok: blocked === 0 && progress.realFailed === 0,
        total: session.segments.size,
        applied: progress.viewportDone + progress.backgroundDone,
        viewportTotal: progress.viewportTotal,
        viewportDone: progress.viewportDone,
        backgroundTotal: progress.backgroundTotal,
        backgroundDone: progress.backgroundDone,
        pendingSave: progress.pendingSave,
        realFailed: progress.realFailed,
        blocked,
        cached: viewportResults.cached + nearResults.cached,
        offline: !!webpage.pageFault,
        drained: !!drained
      };
    } finally {
      if (!runtime.isWebpageQueueBusy()) {
        webpage.working = false;
        webpage.cacheStatus = session.segments.size
          ? (progressState(session) ? "cached" : "partial") : "none";
      }
      runtime.refreshWebpageUi?.();
      runtime.updateFloatingBallState?.();
    }
  }
  runtime.startWebpageViewportTranslation = startWebpageViewportTranslation;
}
