/**
 * SPA route observer.
 *
 * A content script runs in the isolated world: wrapping `history.pushState`
 * there never sees main-world framework calls (each world owns its own
 * history object), while `popstate`/`hashchange` DO cross worlds. To catch
 * main-world pushState/replaceState, a tiny bridge script is injected into
 * the MAIN world; it wraps the real history methods and dispatches a
 * CustomEvent that the isolated content script listens for. Only routing is
 * bridged — no translation logic ever runs in the main world.
 *
 * URL comparison deduplicates identical navigations and also acts as a
 * fallback: any event (bridge / popstate / hashchange) only notifies when
 * location.href actually changed.
 */

const HISTORY_METHODS = ["pushState", "replaceState"];
const WRAP_MARK = Symbol("mt-route-observer");
const BRIDGE_EVENT = "mt-route-change";

export function buildMainWorldBridgeSource() {
  // 与 extension/public/assets/route-bridge.js 保持一致（外部文件方式注入主世界）
  return `(function () {
  try { document.documentElement.dataset.mtBridgeExec = "yes"; } catch (e) {}
  if (window.__mtRouteBridgeInstalled) return;
  window.__mtRouteBridgeInstalled = true;
  var METHODS = ["pushState", "replaceState"];
  for (var i = 0; i < METHODS.length; i += 1) {
    var method = METHODS[i];
    var original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function () {
      var result = original.apply(this, arguments);
      try {
        window.dispatchEvent(new CustomEvent("${BRIDGE_EVENT}"));
      } catch (e) {}
      return result;
    };
  }
})();`;
}

export function injectMainWorldRouteBridge(doc = null, urlResolver = null) {
  // 注入结果写到 documentElement 的 dataset（跨 world 可见，便于诊断）
  const mark = code => {
    try {
      if (doc && doc.documentElement) doc.documentElement.dataset.mtBridge = code;
    } catch {
      // 标记失败不影响注入
    }
    return code === "ok";
  };
  if (!doc || typeof doc.createElement !== "function") return mark("no-doc");
  try {
    // Chrome 中 content script 用 textContent 创建的内联 script 不会执行，
    // 必须用外部文件（chrome.runtime.getURL + web_accessible_resources）注入主世界。
    const resolver = urlResolver || (typeof globalThis.chrome?.runtime?.getURL === "function"
      ? globalThis.chrome.runtime.getURL.bind(globalThis.chrome.runtime)
      : null);
    if (!resolver) return mark("no-resolver");
    const script = doc.createElement("script");
    script.src = resolver("assets/route-bridge.js");
    script.setAttribute("data-mt-route-bridge", "true");
    const host = doc.documentElement || doc.head || doc.body;
    if (!host) return mark("no-host");
    host.appendChild(script);
    script.remove();
    return mark("ok");
  } catch (error) {
    return mark(`err:${String(error && error.message || error).slice(0, 60)}`);
  }
}

export function installHistoryRouteObserver(onRouteChange, env = null) {
  const win = env || globalThis;
  const historyObj = win.history;
  const addEventListener = typeof win.addEventListener === "function" ? win.addEventListener.bind(win) : null;
  const removeEventListener = typeof win.removeEventListener === "function" ? win.removeEventListener.bind(win) : null;
  if (!historyObj || !addEventListener || typeof onRouteChange !== "function") {
    return () => {};
  }
  const wrappedOriginals = new Map();
  let lastUrl = typeof win.location?.href === "string" ? win.location.href : "";
  let installed = false;

  // 回调携带路由事件对象 { previousUrl, nextUrl, reason }；reason 覆盖
  // pushState / replaceState / popstate / hashchange / pageshow。
  // pageshow（bfcache 恢复）即使 URL 不变也通知，便于会话重新激活。
  const notifyIfChanged = reason => {
    const url = typeof win.location?.href === "string" ? win.location.href : "";
    const previousUrl = lastUrl;
    if (url === lastUrl) {
      if (reason !== "pageshow") return;
      onRouteChange({ previousUrl, nextUrl: url, reason });
      return;
    }
    lastUrl = url;
    onRouteChange({ previousUrl, nextUrl: url, reason });
  };

  const onPopState = () => notifyIfChanged("popstate");
  const onHashChange = () => notifyIfChanged("hashchange");
  const onBridgeEvent = () => notifyIfChanged("bridge");
  const onPageshow = event => {
    if (event && event.persisted === true) notifyIfChanged("pageshow");
  };

  function install() {
    if (installed) return;
    installed = true;
    addEventListener("popstate", onPopState);
    addEventListener("hashchange", onHashChange);
    addEventListener(BRIDGE_EVENT, onBridgeEvent);
    if (typeof addEventListener === "function") {
      win.addEventListener("pageshow", onPageshow);
    }
    injectMainWorldRouteBridge(win.document || null);
    for (const method of HISTORY_METHODS) {
      const original = historyObj[method];
      if (typeof original !== "function" || original[WRAP_MARK]) continue;
      const wrapped = function wrappedHistoryMethod(...args) {
        const result = original.apply(this, args);
        notifyIfChanged(method);
        return result;
      };
      try {
        Object.defineProperty(wrapped, WRAP_MARK, { value: true });
      } catch {
        // non-extensible function object: the plain wrapper still works
      }
      wrappedOriginals.set(method, original);
      historyObj[method] = wrapped;
    }
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    if (removeEventListener) {
      removeEventListener("popstate", onPopState);
      removeEventListener("hashchange", onHashChange);
      removeEventListener(BRIDGE_EVENT, onBridgeEvent);
      removeEventListener("pageshow", onPageshow);
    }
    for (const method of HISTORY_METHODS) {
      const original = wrappedOriginals.get(method);
      const current = historyObj[method];
      // only restore when the current method is still our wrapper
      if (original && typeof current === "function" && current[WRAP_MARK]) {
        historyObj[method] = original;
      }
    }
    wrappedOriginals.clear();
  }

  install();
  return uninstall;
}
