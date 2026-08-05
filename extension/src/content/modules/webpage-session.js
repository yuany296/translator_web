/**
 * Per-route page sessions for continuous webpage translation.
 *
 * Every SPA route (and every full navigation of the tab) creates a PageSession
 * keyed by the normalized pageKey. Only the most recent sessions are kept in
 * memory (LRU, default 8); eviction releases DOM and queue references but
 * never deletes translation cache — returning to an old route rehydrates from
 * IndexedDB / SQLite instead of restarting from scratch.
 *
 * A segment is one translatable text node with its three independent state
 * axes (translation / rendering / persistence), so a disconnected node or a
 * failed save is never mistaken for a translation failure:
 *
 *   segment.status.translation: "pending" | "inflight" | "done" | "failed" | "blocked"
 *   segment.status.rendering:   "pending" | "rendered" | "restored" | "skipped"
 *   segment.status.persistence: "none" | "saved" | "pending-save" | "failed"
 *
 * A binding is a node that already carries a translation result. Route
 * switches migrate still-connected bindings whose text is unchanged (either
 * the original text or the extension's own translation) into the new session,
 * so shared UI like the Kakao top navigation keeps its Chinese rendering.
 * Disconnected bindings are released; page-rewritten nodes are released and
 * get rediscovered as new original text by the next scan.
 */

const DEFAULT_MAX_SESSIONS = 8;
export { DEFAULT_MAX_SESSIONS };

export function installWebpageSession(runtime) {
  const registry = createPageSessionRegistry({ maxSessions: runtime.WEBPAGE_MAX_SESSIONS || DEFAULT_MAX_SESSIONS });
  runtime.webpageSessionRegistry = registry;

  runtime.getOrCreateWebpageSession = (pageKey, generation) => registry.getOrCreate(pageKey, generation);
  runtime.getWebpageSession = pageKey => registry.get(pageKey);
  runtime.getWebpageSessions = () => registry.list();
  runtime.releaseWebpageSession = pageKey => registry.forget(pageKey);

  runtime.adoptConnectedBindings = (previousSession, nextSession) =>
    adoptConnectedBindings(previousSession, nextSession, {
      isConnected: node => !!(node && node.isConnected),
      readValue: node => node && node.nodeValue
    });
  runtime.getVisibleWebpageProgress = session => getVisibleProgress(session);
}

export function createPageSession(pageKey, generation) {
  return {
    pageKey: String(pageKey || ""),
    generation: Math.max(0, Number(generation) || 0),
    segments: new Map(),
    bindings: new Map(),
    createdAt: Date.now(),
    activatedAt: null,
    active: false,
    viewportBlocked: false
  };
}

export function createSegment(entry, priority = 2) {
  const now = Date.now();
  return {
    segmentKey: entry.segmentKey,
    bindingKey: entry.bindingKey,
    translationKey: entry.translationKey || "",
    node: entry.node,
    sourceText: String(entry.text || ""),
    normalized: String(entry.normalized || entry.text || ""),
    sourceHash: String(entry.sourceHash || ""),
    resolvedSourceLanguage: String(entry.resolvedSourceLanguage || "auto"),
    priority: Math.max(0, Math.min(3, Number(priority) || 0)),
    zone: "background",
    status: {
      translation: "pending",
      rendering: "pending",
      persistence: "none"
    },
    translatedText: "",
    errors: [],
    createdAt: now,
    updatedAt: now
  };
}

export function createPageSessionRegistry(options = {}) {
  const maxSessions = Math.max(1, Number(options.maxSessions) || DEFAULT_MAX_SESSIONS);
  const sessions = new Map();

  function get(pageKey) {
    return sessions.get(String(pageKey || "")) || null;
  }

  function list() {
    return [...sessions.values()];
  }

  function getOrCreate(pageKey, generation) {
    const key = String(pageKey || "");
    let session = sessions.get(key);
    if (session) {
      // 同一 pageKey 的新 generation 视为同一路由的新会话
      session.generation = Math.max(0, Number(generation) || 0);
      return session;
    }
    session = createPageSession(key, generation);
    sessions.set(key, session);
    evictIfNeeded();
    return session;
  }

  function evictIfNeeded() {
    while (sessions.size > maxSessions) {
      // 非活动会话按最近使用淘汰（最旧优先，同刻创建保持插入顺序）；活动会话保留
      const candidates = [...sessions.values()].filter(session => !session.active)
        .sort((a, b) => (a.activatedAt || a.createdAt) - (b.activatedAt || b.createdAt));
      const victim = candidates[0];
      if (!victim) break;
      sessions.delete(victim.pageKey);
      releaseSession(victim);
    }
  }

  function forget(pageKey) {
    const session = sessions.get(String(pageKey || ""));
    if (!session) return null;
    sessions.delete(session.pageKey);
    releaseSession(session);
    return session;
  }

  function releaseSession(session) {
    // 淘汰只释放 DOM 与队列引用，译文缓存（IndexedDB / SQLite）不受影响
    session.segments.clear();
    session.bindings.clear();
    session.node = null;
  }

  function deactivateAll() {
    for (const session of sessions.values()) {
      session.active = false;
      session.activatedAt = null;
    }
  }

  return { get, list, getOrCreate, forget, deactivateAll, releaseSession };
}

/**
 * Migrate still-connected bindings from the previous session into the next
 * one. Pure classification over the two binding maps; returns counts.
 *   - connected + text still equals originalText or translatedText → adopt
 *   - disconnected → release
 *   - page rewrote the text → release (rediscovered as new source later)
 */
export function adoptConnectedBindings(previousSession, nextSession, options = {}) {
  const result = { adopted: 0, released: 0, pageModified: 0, rendered: 0 };
  if (!previousSession || !nextSession || previousSession === nextSession) return result;
  const isConnected = typeof options.isConnected === "function"
    ? options.isConnected : node => !!(node && node.isConnected);
  const readValue = typeof options.readValue === "function"
    ? options.readValue : node => node && node.nodeValue;
  const adopt = typeof options.onAdopt === "function" ? options.onAdopt : null;
  const render = typeof options.onRender === "function" ? options.onRender : null;

  for (const [node, binding] of [...previousSession.bindings.entries()]) {
    if (!binding || binding.generation !== previousSession.generation) {
      previousSession.bindings.delete(node);
      result.released += 1;
      continue;
    }
    if (!isConnected(node)) {
      previousSession.bindings.delete(node);
      result.released += 1;
      continue;
    }
    const currentValue = readValue(node);
    if (currentValue === binding.translatedText) {
      // 译文仍挂载：直接迁移并保持已渲染状态（例如 Kakao 顶部导航保持中文）
      nextSession.bindings.set(node, { ...binding, generation: nextSession.generation, pageKey: nextSession.pageKey });
      previousSession.bindings.delete(node);
      result.adopted += 1;
      result.rendered += 1;
      if (render) render(node, binding);
      continue;
    }
    if (currentValue === binding.originalText) {
      // 原文未被网页改写：迁移绑定，译文可在缓存命中或 API 返回后立即复用
      nextSession.bindings.set(node, { ...binding, generation: nextSession.generation, pageKey: nextSession.pageKey });
      previousSession.bindings.delete(node);
      result.adopted += 1;
      if (adopt) adopt(node, binding);
      continue;
    }
    // 网页自行改写了节点：释放绑定，作为新原文重新发现
    previousSession.bindings.delete(node);
    result.pageModified += 1;
  }
  return result;
}

/**
 * Visible progress of a session for the floating ball / progress panel.
 * Segments carry a zone ("viewport" | "near" | "background") updated by the
 * scheduler on scroll. Persistence and translation failure are reported on
 * separate axes so a pending save never looks like a translation failure.
 */
export function getVisibleProgress(session) {
  if (!session) return { viewportTotal: 0, viewportDone: 0, backgroundTotal: 0, backgroundDone: 0, pendingSave: 0, realFailed: 0, unchangedCount: 0 };
  let viewportTotal = 0;
  let viewportDone = 0;
  let backgroundTotal = 0;
  let backgroundDone = 0;
  let pendingSave = 0;
  let realFailed = 0;
  let unchangedCount = 0;
  for (const segment of session.segments.values()) {
    const done = segment.status.translation === "done";
    const inViewport = segment.zone === "viewport";
    if (inViewport) {
      viewportTotal += 1;
      if (done) viewportDone += 1;
    } else {
      backgroundTotal += 1;
      if (done) backgroundDone += 1;
    }
    if (done && segment.unchanged === true) unchangedCount += 1;
    if (segment.status.persistence === "pending-save" || segment.status.persistence === "failed") {
      pendingSave += 1;
    }
    if (segment.status.translation === "failed") realFailed += 1;
  }
  return { viewportTotal, viewportDone, backgroundTotal, backgroundDone, pendingSave, realFailed, unchangedCount };
}

export default Object.freeze({
  DEFAULT_MAX_SESSIONS,
  createPageSession,
  createSegment,
  createPageSessionRegistry,
  adoptConnectedBindings,
  getVisibleProgress
});
