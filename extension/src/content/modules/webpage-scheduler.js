/**
 * Viewport-priority scheduler for continuous webpage translation.
 *
 * Startup flow:
 *   1. Quickly discover viewport + one screen above/below, query cache
 *      immediately; hits render right away, misses enter P0/P1.
 *   2. An async TreeWalker keeps scanning the rest of the document in chunks
 *      (≤8ms or 200 nodes); every discovered chunk is handed to the queue
 *      immediately, never waiting for the whole page scan.
 *   3. Two concurrent lanes drain the queue; at most one lane may work on
 *      P2/P3 so the other lane stays free for P0/P1.
 *
 * Priorities: P0 viewport, P1 the two adjacent screens, P2 other discovered
 * content, P3 far dynamically-added content. Scroll re-prioritizes segments
 * that have not been sent yet. Batch caps: P0 8 items / 600 chars, P1
 * 12 / 900, background 24 / 1600.
 *
 * Segment state lives on three independent axes (translation / rendering /
 * persistence) so a disconnected node or a failed save never counts as a
 * translation failure. A service outage is one page-level fault: segments
 * become "blocked" (not per-item failures) and are retried every 30s while
 * the page is visible, or immediately on user action / next route.
 */
import { createSegment } from "./webpage-session.js";
import { isUsableWebpageTranslation } from "./webpage-batches.js";

const LANES = 2;
const NEAR_SCREENS = 2;
const RETRY_BLOCKED_MS = 30_000;
const SCROLL_REPRIORITIZE_DEBOUNCE_MS = 120;
const BATCH_LIMITS = Object.freeze({
  0: { maxItems: 8, maxChars: 600 },
  1: { maxItems: 12, maxChars: 900 },
  2: { maxItems: 24, maxChars: 1600 },
  3: { maxItems: 24, maxChars: 1600 }
});

const ZONE_PRIORITY = Object.freeze({ viewport: 0, near: 1, background: 2, dynamic: 3 });

export function installWebpageScheduler(runtime) {
  const state = {
    queue: [],
    activeBatches: 0,
    lowPriorityBatches: 0,
    backgroundScanning: false,
    scanCancelled: false,
    blockedRetryTimer: 0,
    scrollTimer: 0,
    stopped: false,
    paused: false
  };
  runtime.webpageSchedulerState = state;

  // getBoundingClientRect 返回视口相对坐标，视口矩形用同一坐标系（0, innerHeight）
  function getViewportRect() {
    return { top: 0, bottom: window.innerHeight || 0 };
  }
  runtime.getWebpageViewportRect = getViewportRect;

  function computeSegmentZone(node) {
    const parent = node && (node.parentElement || node);
    let rect = null;
    try {
      rect = parent.getBoundingClientRect();
    } catch {
      rect = null;
    }
    if (!rect) return "background";
    const vh = window.innerHeight || 1;
    const viewport = getViewportRect();
    if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) return "viewport";
    const nearTop = viewport.top - NEAR_SCREENS * vh;
    const nearBottom = viewport.bottom + NEAR_SCREENS * vh;
    if (rect.bottom >= nearTop && rect.top <= nearBottom) return "near";
    return "background";
  }
  runtime.computeWebpageSegmentZone = computeSegmentZone;

  function compareSegments(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  function insertSorted(segment) {
    const queue = state.queue;
    let low = 0;
    let high = queue.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (compareSegments(queue[mid], segment) <= 0) low = mid + 1;
      else high = mid;
    }
    queue.splice(low, 0, segment);
  }

  function removeFromQueue(segment) {
    const index = state.queue.indexOf(segment);
    if (index >= 0) state.queue.splice(index, 1);
  }

  function isEntryBound(entry) {
    const webpage = runtime.getWebpageState();
    return webpage.nodeStore.activeNodes.has(entry.node) || webpage.session?.segments.has(entry.id);
  }

  /**
   * Cache-check and enqueue a batch of discovered entries for a session.
   * Cache hits render immediately (new bindingKey id first; legacy id hits
   * lazily migrate to the new key preserving all versions); misses enter the
   * queue with the zone's priority.
   */
  async function enqueueWebpageSegments(session, entries, zone, generation, options = {}) {
    const results = { enqueued: 0, cached: 0, applied: 0, skipped: 0 };
    if (!session || !Array.isArray(entries) || !entries.length) return results;
    const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
    const fingerprint = await runtime.getTranslationConfigFingerprint("webpage");
    const recordMap = await runtime.getWebpageEntryRecords?.(entries) || new Map();
    for (const entry of entries) {
      if (isEntryBound(entry)) {
        results.skipped += 1;
        continue;
      }
      if (entry.resolvedSourceLanguage !== "auto" && entry.resolvedSourceLanguage === targetLanguage) {
        results.skipped += 1;
        continue;
      }
      const record = recordMap.get(entry);
      const usable = record && isUsableWebpageTranslation(
        entry.text, record.translatedText, targetLanguage
      );
      const match = usable ? runtime.classifyTranslationCacheMatch(record, fingerprint) : "missing";
      const segment = createSegment({
        ...entry,
        segmentKey: entry.id,
        bindingKey: entry.bindingKey,
        translationKey: entry.translationKey,
        node: entry.node
      }, ZONE_PRIORITY[zone] ?? 2);
      segment.zone = zone;
      if (options.dynamic === true) segment.priority = 3;
      session.segments.set(entry.id, segment);
      if (match !== "missing") {
        segment.status.persistence = "saved";
        const cached = new Map([[entry.text, String(record.translatedText)]]);
        const applied = runtime.applyWebpageEntriesToSession(session, generation, [entry], cached);
        results.cached += 1;
        results.applied += applied;
        if (applied && record.id !== entry.id) {
          void runtime.migrateWebpageRecordToEntry(record, entry).catch(() => {});
        }
        continue;
      }
      // 所有未发送段进入队列（后台扫描的 P2 也立即交给调度器），
      // composeBatch 按 tier 取批，P0/P1 始终优先
      insertSorted(segment);
      results.enqueued += 1;
    }
    if (results.enqueued) runtime.updateWebpageProgress?.(runtime, runtime.getWebpageState());
    tryStartBatches();
    return results;
  }
  runtime.enqueueWebpageSegments = enqueueWebpageSegments;

  /** Scroll / resize re-prioritizes segments that have not been sent yet. */
  function reprioritizeWebpageViewport() {
    const session = runtime.getWebpageState().session;
    if (!session) return 0;
    let changed = 0;
    for (const segment of session.segments.values()) {
      if (segment.status.translation !== "pending") continue;
      const zone = computeSegmentZone(segment.node);
      const priority = ZONE_PRIORITY[zone] ?? 2;
      if (priority !== segment.priority || zone !== segment.zone) {
        segment.priority = priority;
        segment.zone = zone;
        changed += 1;
      }
    }
    if (changed) state.queue.sort(compareSegments);
    return changed;
  }
  runtime.reprioritizeWebpageViewport = reprioritizeWebpageViewport;

  function scheduleScrollReprioritize() {
    if (state.scrollTimer) return;
    state.scrollTimer = window.setTimeout(() => {
      state.scrollTimer = 0;
      if (runtime.reprioritizeWebpageViewport()) tryStartBatches();
    }, SCROLL_REPRIORITIZE_DEBOUNCE_MS);
  }
  runtime.scheduleWebpageScrollReprioritize = scheduleScrollReprioritize;

  function composeBatch() {
    for (let tier = 0; tier <= 3; tier += 1) {
      const candidates = state.queue.filter(segment => segment.status.translation === "pending" && segment.priority === tier);
      if (!candidates.length) continue;
      const limits = BATCH_LIMITS[tier];
      const segments = [];
      let chars = 0;
      for (const segment of candidates) {
        if (segments.length >= limits.maxItems || chars + segment.sourceText.length > limits.maxChars) break;
        segments.push(segment);
        chars += segment.sourceText.length;
      }
      return { tier, segments };
    }
    return null;
  }

  function tryStartBatches() {
    if (state.stopped || state.paused) return;
    while (state.activeBatches < LANES) {
      const batch = composeBatch();
      if (!batch) break;
      // 最多允许一路执行 P2/P3，另一路为 P0/P1 保留
      if (batch.tier >= 2 && state.lowPriorityBatches >= 1) break;
      void runBatch(batch);
    }
  }

  async function runBatch(batch) {
    state.activeBatches += 1;
    if (batch.tier >= 2) state.lowPriorityBatches += 1;
    const session = runtime.getWebpageState().session;
    batch.segments.forEach(segment => {
      segment.status.translation = "inflight";
    });
    const keys = batch.segments.map(segment => segment.sourceText);
    try {
      const result = await runtime.translateWebpageBatchWithRetry(keys, {
        force: false, taskId: runtime.getWebpageState().taskId || ""
      });
      await settleBatch(session, batch.segments, result);
    } catch (error) {
      const failed = { error: runtime.getErrorMessage(error) };
      for (const segment of batch.segments) {
        segment.status.translation = "failed";
        segment.errors = [failed];
        removeFromQueue(segment);
      }
      runtime.updateWebpageProgress?.(runtime, runtime.getWebpageState());
    } finally {
      state.activeBatches -= 1;
      if (batch.tier >= 2) state.lowPriorityBatches -= 1;
      tryStartBatches();
    }
  }

  async function settleBatch(session, segments, result) {
    const webpage = runtime.getWebpageState();
    const stale = !session || session !== webpage.session || session.generation !== webpage.generation
      || webpage.taskUrl !== location.href;
    // 旧响应允许进入缓存，但禁止渲染到新会话
    if (result?.ok && !result.cancelled) {
      const applied = stale ? 0
        : runtime.applyWebpageEntriesToSession(session, session.generation, segments.map(segment => ({
          node: segment.node, text: segment.sourceText, id: segment.segmentKey
        })), result.translations);
      await runtime.saveWebpageSegmentRecords(session, segments, result.translations, { force: false });
      if (!stale) {
        for (const segment of segments) {
          const translated = result.translations.get(segment.sourceText);
          segment.status.translation = translated ? "done" : "failed";
          if (translated) segment.translatedText = String(translated);
        }
      }
      // 部分响应：缺失项已由重试一次覆盖，仍缺失才计为真实翻译失败
      for (const segment of segments) {
        if (!result.translations.has(segment.sourceText)) {
          segment.status.translation = "failed";
          segment.errors = result.errors || [{ error: "翻译失败" }];
        }
      }
    } else if (result?.cancelled) {
      // 取消：回到 pending 等待新会话重新调度
      for (const segment of segments) {
        if (segment.status.translation === "inflight") {
          segment.status.translation = "pending";
          removeFromQueue(segment);
          insertSorted(segment);
        }
      }
    } else {
      const failed = { error: String(result?.errors?.[0]?.error || result?.error || "翻译失败") };
      for (const segment of segments) {
        segment.status.translation = "failed";
        segment.errors = [failed];
      }
    }
    // 已结算的段离开队列，避免 isWebpageQueueBusy 永远为真
    for (const segment of segments) removeFromQueue(segment);
    runtime.updateWebpageProgress?.(runtime, webpage);
  }

  // ---------- offline / blocked ----------

  function markWebpageServiceOffline(error) {
    const webpage = runtime.getWebpageState();
    webpage.pageFault = { error: String(error || "本地服务未启动，当前仅显示已缓存译文"), at: Date.now() };
    const session = webpage.session;
    if (session) {
      for (const segment of session.segments.values()) {
        if (segment.status.translation === "pending" || segment.status.translation === "inflight") {
          segment.status.translation = "blocked";
        }
      }
    }
    // 页面级故障：不逐项报失败；持续模式下页面可见时每 30 秒重试
    scheduleBlockedRetry();
    runtime.updateWebpageProgress?.(runtime, webpage);
    return webpage.pageFault;
  }
  runtime.markWebpageServiceOffline = markWebpageServiceOffline;

  function scheduleBlockedRetry() {
    if (state.blockedRetryTimer) window.clearTimeout(state.blockedRetryTimer);
    state.blockedRetryTimer = window.setTimeout(() => {
      state.blockedRetryTimer = 0;
      if (document.visibilityState !== "visible") {
        scheduleBlockedRetry();
        return;
      }
      // 重试前先确认服务恢复，仍离线则继续保持 blocked 并安排下一次重试
      void Promise.resolve(runtime.ensureTranslationServiceOnline?.())
        .then(service => {
          if (service?.ok === true) runtime.retryWebpageTranslation?.();
          else scheduleBlockedRetry();
        })
        .catch(() => scheduleBlockedRetry());
    }, RETRY_BLOCKED_MS);
  }

  function retryWebpageTranslation() {
    const webpage = runtime.getWebpageState();
    webpage.pageFault = null;
    const session = webpage.session;
    if (!session) return 0;
    let retried = 0;
    for (const segment of session.segments.values()) {
      if (segment.status.translation === "blocked") {
        segment.status.translation = "pending";
        segment.errors = [];
        insertSorted(segment);
        retried += 1;
      }
    }
    if (retried) tryStartBatches();
    runtime.updateWebpageProgress?.(runtime, webpage);
    return retried;
  }
  runtime.retryWebpageTranslation = retryWebpageTranslation;

  function stopWebpageScheduler() {
    state.stopped = true;
    if (state.blockedRetryTimer) window.clearTimeout(state.blockedRetryTimer);
    state.blockedRetryTimer = 0;
    if (state.scrollTimer) window.clearTimeout(state.scrollTimer);
    state.scrollTimer = 0;
    state.scanCancelled = true;
    state.queue.length = 0;
  }
  runtime.stopWebpageScheduler = stopWebpageScheduler;

  function startWebpageScheduler() {
    state.stopped = false;
    tryStartBatches();
  }
  runtime.startWebpageScheduler = startWebpageScheduler;

  function isWebpageQueueBusy() {
    return state.activeBatches > 0 || state.queue.length > 0 || state.backgroundScanning;
  }
  runtime.isWebpageQueueBusy = isWebpageQueueBusy;

  function getWebpageSchedulerSnapshot() {
    return {
      queued: state.queue.length,
      activeBatches: state.activeBatches,
      lowPriorityBatches: state.lowPriorityBatches,
      backgroundScanning: state.backgroundScanning
    };
  }
  runtime.getWebpageSchedulerSnapshot = getWebpageSchedulerSnapshot;
  try {
    window.addEventListener("scroll", scheduleScrollReprioritize, { passive: true });
    window.addEventListener("resize", scheduleScrollReprioritize, { passive: true });
  } catch {
    // 测试或无 window 环境跳过
  }
  runtime.disposeWebpageScheduler = () => {
    stopWebpageScheduler();
    try {
      window.removeEventListener("scroll", scheduleScrollReprioritize);
      window.removeEventListener("resize", scheduleScrollReprioritize);
    } catch {
      // 忽略
    }
  };
}
