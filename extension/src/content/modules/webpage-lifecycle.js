import { installHistoryRouteObserver } from "./route-observer.js";

const DOM_QUIET_MS = 150;
const DOM_SETTLE_MAX_MS = 1200;

export function installWebpageLifecycle(runtime) {
  async function analyzeWebpageCacheStatus() {
    const state = runtime.getWebpageState();
    if (state.working || state.cacheAnalysisPending) return { skipped: true };
    const pageKey = runtime.normalizeTranslationCacheUrl();
    if (state.cacheCheckedKey === pageKey) return { skipped: true };
    state.cacheAnalysisPending = true;
    try {
      const entries = runtime.enrichWebpageEntries(runtime.collectWebpageTextNodes(), pageKey);
      const records = await runtime.getTranslationCacheRecords(entries.map(entry => entry.id));
      const fingerprint = await runtime.getTranslationConfigFingerprint("webpage");
      let hit = 0;
      entries.forEach(entry => {
        if (runtime.classifyTranslationCacheMatch(records.get(entry.id), fingerprint) !== "missing") hit += 1;
      });
      state.cacheCheckedKey = pageKey;
      state.cacheStatus = !entries.length ? "none" : hit >= entries.length ? "cached" : hit ? "partial" : "none";
      state.cacheBadgeUntil = state.cacheStatus === "cached" ? Date.now() + 3500 : 0;
      runtime.updateFloatingBallState?.();
      return { total: entries.length, hit };
    } finally {
      state.cacheAnalysisPending = false;
    }
  }
  runtime.analyzeWebpageCacheStatus = analyzeWebpageCacheStatus;

  /**
   * Wait for the route's DOM to settle: mutation-quiet for 150ms, capped at
   * 1200ms, then two animation frames before the new session activates.
   */
  function waitForWebpageDomSettle(env = null) {
    const win = env || globalThis;
    return new Promise(resolve => {
      let settled = false;
      let debounce = 0;
      let maxTimer = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        if (debounce) win.clearTimeout(debounce);
        if (maxTimer) win.clearTimeout(maxTimer);
        try {
          observer.disconnect();
        } catch {
          // observer may not have been created
        }
        const doubleFrame = () => win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
        if (typeof win.requestAnimationFrame === "function") {
          doubleFrame();
        } else {
          win.setTimeout(resolve, 0);
        }
      };
      const doc = win.document;
      let observer = null;
      if (doc && doc.documentElement && typeof win.MutationObserver === "function") {
        observer = new win.MutationObserver(() => {
          win.clearTimeout(debounce);
          debounce = win.setTimeout(done, DOM_QUIET_MS);
        });
        observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
      }
      debounce = win.setTimeout(done, DOM_QUIET_MS);
      maxTimer = win.setTimeout(done, DOM_SETTLE_MAX_MS);
    });
  }
  runtime.waitForWebpageDomSettle = waitForWebpageDomSettle;

  /**
   * SPA route / pageshow / full-navigation handler.
   * URL 变化后立即增加 generation 并取消未发送任务，但不整页恢复、不清空
   * 节点绑定；等待 DOM 安静并经过两个动画帧后激活新会话，再把仍连接的
   * 节点绑定迁移进新会话（Kakao 顶部导航保持中文）。已断开节点直接释放；
   * 被网页改写的节点释放后作为新原文重新发现。
   */
  async function onRouteChange(event = {}) {
    const state = runtime.getWebpageState();
    const controller = state.controller || {};
    const wasActive = state.active === true || controller.mode === "continuous";
    const previousUrl = String(event.previousUrl || state.pageKey || location.href);
    const nextUrl = String(event.nextUrl || location.href);
    const reason = String(event.reason || "fallback");

    // pageshow（bfcache 恢复）且 URL 未变：重新激活当前会话并重算可视区
    if (reason === "pageshow" && nextUrl === previousUrl) {
      if (wasActive) {
        runtime.reprioritizeWebpageViewport?.();
        void runtime.translateWebpage({ onlyNew: true }).catch(() => {});
      }
      return;
    }

    const oldSession = state.session || null;
    const pageKey = runtime.normalizeTranslationCacheUrl();
    // 1. 立即取消未发送任务并中止当前翻译请求，只递增 generation
    runtime.cancelWebpageTranslationTask?.(state);
    // 2. 等待路由 DOM 安静（150ms 静默，最长 1200ms）+ 两个动画帧
    await runtime.waitForWebpageDomSettle();

    // 3. 激活新会话（同一 pageKey 复用既有会话与内存中的译文）
    const generation = state.generation;
    const session = runtime.getOrCreateWebpageSession(pageKey, generation);
    session.active = true;
    state.session = session;
    state.pageKey = pageKey;
    state.cacheCheckedKey = "";
    state.cacheStatus = "none";
    state.cacheBadgeUntil = 0;

    // 4. 迁移仍连接的节点绑定
    if (oldSession && oldSession !== session) {
      oldSession.active = false;
      runtime.adoptConnectedBindings(oldSession, session);
    }

    // 5. 向后台报告路由（currentPageKey / navigationGeneration）
    void runtime.reportWebpagePageKey(pageKey).then(updated => {
      if (updated) {
        state.controller = updated;
        runtime.updateFloatingBallState?.();
      }
    }).catch(() => {});

    // 6. 持续模式或此前激活过：自动翻译新页面可视区；否则只做缓存预分析
    if (wasActive) {
      runtime.activateWebpageObserver?.();
      void runtime.translateWebpage({ onlyNew: true }).catch(() => {});
    } else {
      void runtime.analyzeWebpageCacheStatus();
    }
  }
  runtime.onWebpageRouteChange = onRouteChange;
  runtime.uninstallWebpageRouteObserver = installHistoryRouteObserver(onRouteChange, null);
}
