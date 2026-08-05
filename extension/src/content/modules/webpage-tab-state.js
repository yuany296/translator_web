/**
 * Content-side access to the background TabTranslationController.
 *
 * The controller (mode / visibility / currentPageKey / navigationGeneration)
 * is owned by the background and scoped to the sender's tab; the content
 * script reads it at init, reports intent (mode / visibility) and route
 * changes (pageKey), and lets the background clean up on tab close.
 *
 *   mode       - "off" | "continuous": continuous mode survives refreshes,
 *                plain link navigations and SPA routes; it ends when the
 *                tab closes.
 *   visibility - "source" | "translated": display-only. Showing the source
 *                never stops background translation and never deletes cache.
 */

export function installWebpageTabState(runtime) {
  function normalizeController(value) {
    const state = value && typeof value === "object" ? value : {};
    return {
      mode: state.mode === "continuous" ? "continuous" : "off",
      visibility: state.visibility === "translated" ? "translated" : "source",
      currentPageKey: typeof state.currentPageKey === "string" ? state.currentPageKey : null,
      navigationGeneration: Number.isFinite(Number(state.navigationGeneration))
        ? Math.max(0, Number(state.navigationGeneration)) : 0
    };
  }
  runtime.normalizeWebpageTabController = normalizeController;

  async function readWebpageTabController() {
    try {
      const response = await runtime.sendRuntimeMessage({ type: "GET_WEBPAGE_TAB_STATE" });
      return normalizeController(response && response.state);
    } catch {
      return { mode: "off", visibility: "source", currentPageKey: null, navigationGeneration: 0 };
    }
  }
  runtime.readWebpageTabController = readWebpageTabController;

  async function setWebpageTabMode(mode) {
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "SET_WEBPAGE_TAB_STATE", mode: mode === "continuous" ? "continuous" : "off"
      });
      return normalizeController(response && response.state);
    } catch {
      return null;
    }
  }
  runtime.setWebpageTabMode = setWebpageTabMode;

  async function setWebpageTabVisibility(visibility) {
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "SET_WEBPAGE_TAB_STATE", visibility: visibility === "translated" ? "translated" : "source"
      });
      return normalizeController(response && response.state);
    } catch {
      return null;
    }
  }
  runtime.setWebpageTabVisibility = setWebpageTabVisibility;

  async function reportWebpagePageKey(pageKey) {
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "SET_WEBPAGE_TAB_STATE", pageKey: String(pageKey || "")
      });
      return normalizeController(response && response.state);
    } catch {
      return null;
    }
  }
  runtime.reportWebpagePageKey = reportWebpagePageKey;

  async function clearWebpageTabState() {
    try {
      await runtime.sendRuntimeMessage({ type: "CLEAR_WEBPAGE_TAB_STATE" });
    } catch {
      // 清理失败不影响页面内状态
    }
  }
  runtime.clearWebpageTabState = clearWebpageTabState;

  function isTopLevelDocument() {
    try {
      return typeof window.top !== "object" || window.top === window;
    } catch {
      return false;
    }
  }
  runtime.isWebpageTopLevelDocument = isTopLevelDocument;

  /**
   * Content-init hook: read the tab controller and resume continuous mode.
   * Webpage translation runs in the top-level document only, so child frames
   * never create a webpage tab controller.
   */
  async function initializeWebpageTabSession() {
    if (!isTopLevelDocument()) return { skipped: true, reason: "child-frame" };
    const state = runtime.getWebpageState();
    const controller = await runtime.readWebpageTabController();
    state.controller = controller;
    const pageKey = runtime.normalizeTranslationCacheUrl();
    state.pageKey = pageKey;
    void runtime.reportWebpagePageKey(pageKey).then(updated => {
      if (updated) {
        state.controller = updated;
        runtime.updateFloatingBallState?.();
      }
    }).catch(() => {});
    // 不再自动恢复持续翻译：用户未点击翻译就不进入翻译状态。
    // 持久化的 controller 仅用于悬浮球状态展示，翻译由用户点击触发。
    runtime.updateFloatingBallState?.();
    return { skipped: true, reason: "no-auto-resume" };
  }
  runtime.initializeWebpageTabSession = initializeWebpageTabSession;
}
