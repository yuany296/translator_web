/**
 * Viewport-priority scheduler for continuous webpage translation.
 * Startup scans viewport + adjacent screens with immediate cache query, then
 * TreeWalker chunks (≤8ms/200 nodes); three lanes drain, one works P2/P3
 * while viewport work remains, all lanes fall to P2/P3 on pure-background
 * long pages. Scroll re-prioritizes unsent segments. Batch caps: P0 8/600,
 * P1 16/1200, background 32/2400. Segment state has three axes
 * (translation/rendering/persistence); outage = one page-level fault,
 * segments go "blocked".
 */
import { createSegment } from "./webpage-session.js";
import { isUsableWebpageTranslation } from "./webpage-batches.js";

const LANES = 3, NEAR_SCREENS = 2, RETRY_BLOCKED_MS = 30_000, SCROLL_REPRIORITIZE_DEBOUNCE_MS = 120;
const BATCH_LIMITS = Object.freeze({
  0: { maxItems: 8, maxChars: 600 }, 1: { maxItems: 16, maxChars: 1200 },
  2: { maxItems: 32, maxChars: 2400 }, 3: { maxItems: 32, maxChars: 2400 }
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
    const segment = webpage.session?.segments.get(entry.id);
    return webpage.nodeStore.activeNodes.has(entry.node)
      || segment !== undefined && segment.node?.isConnected !== false && segment.status.translation !== "failed";
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
      const usable = record && isUsableWebpageTranslation(record.translatedText);
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
      // 未发送段全部入队（含后台 P2），composeBatch 按 tier 取批，P0/P1 优先
      insertSorted(segment);
      results.enqueued += 1;
    }
    if (results.enqueued) runtime.refreshWebpageUi?.();
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
    // 队列中仍有视口/近屏段（含 in-flight）时后台只占一路，保持视口优先；
    // 纯后台长页允许后台占满所有 lane。
    const hasViewportWork = state.queue.some(segment => segment.priority <= 1);
    const lowPriorityLimit = hasViewportWork ? 1 : LANES;
    while (state.activeBatches < LANES) {
      const batch = composeBatch();
      if (!batch) break;
      if (batch.tier >= 2 && state.lowPriorityBatches >= lowPriorityLimit) break;
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
      runtime.refreshWebpageUi?.();
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
      for (const segment of segments) {
        const translated = result.translations.get(segment.sourceText);
        if (!translated) {
          // 部分响应：缺失项已由重试一次覆盖，仍缺失才计为真实翻译失败
          segment.status.translation = "failed";
          segment.errors = result.errors || [{ error: "翻译失败" }];
        } else if (!stale) {
          segment.status.translation = "done";
          segment.translatedText = String(translated);
        }
      }
    } else if (result?.cancelled) {
      for (const segment of segments) {
        if (segment.status.translation === "inflight") segment.status.translation = "pending";
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
    for (const segment of segments) {
      if (session === webpage.session && segment.status.translation === "inflight") segment.status.translation = "pending";
      if (session === webpage.session && segment.status.translation === "pending") insertSorted(segment);
    }
    runtime.refreshWebpageUi?.();
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
    scheduleBlockedRetry();
    runtime.refreshWebpageUi?.();
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
    runtime.refreshWebpageUi?.();
    return retried;
  }
  runtime.retryWebpageTranslation = retryWebpageTranslation;

  function requeueWebpageSegment(segmentKey) {
    const segment = runtime.getWebpageState().session?.segments.get(segmentKey);
    if (!segment || !["failed", "done"].includes(segment.status.translation)) return;
    segment.status.translation = "pending";
    segment.errors = [];
    removeFromQueue(segment);
    insertSorted(segment);
    tryStartBatches();
    runtime.refreshWebpageUi?.();
  }
  runtime.requeueWebpageSegment = requeueWebpageSegment;

  function requeueWebpageSegments(statuses) {
    const session = runtime.getWebpageState().session;
    if (!session) return 0;
    let requeued = 0;
    for (const segment of session.segments.values()) {
      if (statuses.includes(segment.status.translation)) {
        requeueWebpageSegment(segment.segmentKey);
        requeued += 1;
      }
    }
    return requeued;
  }
  runtime.requeueWebpageSegments = requeueWebpageSegments;

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
