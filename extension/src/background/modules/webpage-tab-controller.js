/**
 * Per-tab webpage continuous-translation controller.
 *
 * One controller per tab, keyed by sender.tab.id:
 *   { mode, visibility, currentPageKey, navigationGeneration, updatedAt }
 *
 *   mode             - "off" | "continuous" (webpage translation keeps
 *                      running for the current tab across refreshes, plain
 *                      link navigations and SPA routes; it ends when the
 *                      tab closes).
 *   visibility       - "source" | "translated" (display-only switch; it
 *                      never stops background translation and never deletes
 *                      cache).
 *   currentPageKey   - last route the content script reported.
 *   navigationGeneration - bumped whenever currentPageKey changes; stale
 *                      responses from an old session may still enter the
 *                      cache but must never render into the new session.
 *
 * State lives in background memory and chrome.storage.session (survives
 * service-worker restarts, is cleared when the tab closes or the browser
 * session ends). The content script reads it at init via GET_WEBPAGE_TAB_STATE
 * and reports intent via SET_WEBPAGE_TAB_STATE, which only accepts
 * { mode, visibility } — pageKey is an internal route report used to track
 * currentPageKey / navigationGeneration.
 */

const SESSION_KEY_PREFIX = "mt_webpage_tab_v1:";
const VALID_MODES = Object.freeze(["off", "continuous"]);
const VALID_VISIBILITY = Object.freeze(["source", "translated"]);

export function installWebpageTabController(runtime) {
  const controllers = new Map();
  runtime.webpageTabControllers = controllers;

  function createWebpageTabController() {
    return { mode: "off", visibility: "source", currentPageKey: null, navigationGeneration: 0, updatedAt: 0 };
  }

  function normalizeWebpageTabController(value) {
    const fresh = createWebpageTabController();
    if (!value || typeof value !== "object") return fresh;
    return {
      mode: VALID_MODES.includes(value.mode) ? value.mode : fresh.mode,
      visibility: VALID_VISIBILITY.includes(value.visibility) ? value.visibility : fresh.visibility,
      currentPageKey: typeof value.currentPageKey === "string" && value.currentPageKey
        ? value.currentPageKey : fresh.currentPageKey,
      navigationGeneration: Number.isFinite(Number(value.navigationGeneration))
        ? Math.max(0, Number(value.navigationGeneration)) : fresh.navigationGeneration,
      updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0
    };
  }
  runtime.normalizeWebpageTabController = normalizeWebpageTabController;

  async function sessionGet(keys) {
    try {
      if (!globalThis.chrome?.storage?.session?.get) return {};
      return await globalThis.chrome.storage.session.get(keys);
    } catch {
      return {};
    }
  }

  async function sessionSet(value) {
    try {
      if (!globalThis.chrome?.storage?.session?.set) return false;
      await globalThis.chrome.storage.session.set(value);
      return true;
    } catch {
      return false;
    }
  }

  async function sessionRemove(keys) {
    try {
      if (!globalThis.chrome?.storage?.session?.remove) return false;
      await globalThis.chrome.storage.session.remove(keys);
      return true;
    } catch {
      return false;
    }
  }

  function sessionKey(tabId) {
    return `${SESSION_KEY_PREFIX}${tabId}`;
  }

  async function getWebpageTabState(tabId) {
    if (controllers.has(tabId)) return controllers.get(tabId);
    const stored = await sessionGet([sessionKey(tabId)]);
    const controller = normalizeWebpageTabController(stored && stored[sessionKey(tabId)]);
    controllers.set(tabId, controller);
    return controller;
  }
  runtime.getWebpageTabState = getWebpageTabState;

  async function setWebpageTabState(tabId, patch = {}) {
    const current = await getWebpageTabState(tabId);
    const next = normalizeWebpageTabController({ ...current, ...patch, updatedAt: Date.now() });
    controllers.set(tabId, next);
    await sessionSet({ [sessionKey(tabId)]: next });
    return next;
  }
  runtime.setWebpageTabState = setWebpageTabState;

  async function clearWebpageTabState(tabId) {
    controllers.delete(tabId);
    await sessionRemove([sessionKey(tabId)]);
  }
  runtime.clearWebpageTabState = clearWebpageTabState;

  function getSenderTabId(sender, message = {}) {
    if (sender && sender.tab && typeof sender.tab.id === "number") return sender.tab.id;
    // popup / extension pages have no sender.tab — an explicit message.tabId
    // is only honored there (same pattern as platform-cache.js)
    return Number.isFinite(Number(message.tabId)) ? Number(message.tabId) : null;
  }

  function snapshot(state) {
    return {
      mode: state.mode,
      visibility: state.visibility,
      currentPageKey: state.currentPageKey,
      navigationGeneration: state.navigationGeneration
    };
  }

  async function handleGetWebpageTabState(message, sender) {
    const tabId = getSenderTabId(sender, message);
    if (tabId == null) return { ok: false, error: "unknown tab" };
    const state = await getWebpageTabState(tabId);
    return { ok: true, state: snapshot(state) };
  }
  runtime.handleGetWebpageTabState = handleGetWebpageTabState;

  async function handleSetWebpageTabState(message = {}, sender = {}) {
    const tabId = getSenderTabId(sender, message);
    if (tabId == null) return { ok: false, error: "unknown tab" };
    const patch = {};
    if (message && "mode" in message) {
      if (!VALID_MODES.includes(message.mode)) return { ok: false, error: "invalid mode" };
      patch.mode = message.mode;
    }
    if (message && "visibility" in message) {
      if (!VALID_VISIBILITY.includes(message.visibility)) return { ok: false, error: "invalid visibility" };
      patch.visibility = message.visibility;
    }
    if (message && typeof message.pageKey === "string") {
      const current = await getWebpageTabState(tabId);
      if (message.pageKey !== current.currentPageKey) {
        patch.currentPageKey = message.pageKey;
        patch.navigationGeneration = current.navigationGeneration + 1;
      }
    }
    // 空 patch（例如重复报告同一 pageKey）返回当前状态，内容脚本始终能取回状态
    if (!Object.keys(patch).length) {
      const state = await getWebpageTabState(tabId);
      return { ok: true, state: snapshot(state) };
    }
    const state = await setWebpageTabState(tabId, patch);
    return { ok: true, state: snapshot(state) };
  }
  runtime.handleSetWebpageTabState = handleSetWebpageTabState;

  async function handleClearWebpageTabState(message, sender) {
    const tabId = getSenderTabId(sender, message);
    if (tabId == null) return { ok: false, error: "unknown tab" };
    await clearWebpageTabState(tabId);
    return { ok: true };
  }
  runtime.handleClearWebpageTabState = handleClearWebpageTabState;

  // 标签页关闭即结束该页的持续翻译（content script 无法自行发送清理）
  try {
    if (globalThis.chrome?.tabs?.onRemoved?.addListener) {
      globalThis.chrome.tabs.onRemoved.addListener(tabId => void clearWebpageTabState(tabId));
    }
  } catch {
    // 测试或无 tabs 环境跳过
  }
}
