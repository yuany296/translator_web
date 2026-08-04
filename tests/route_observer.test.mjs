import assert from "node:assert/strict";
import test from "node:test";
import {
  installHistoryRouteObserver,
  buildMainWorldBridgeSource,
  injectMainWorldRouteBridge
} from "../extension/src/content/modules/route-observer.js";

function makeFakeEnv() {
  const listeners = new Map();
  const location = { href: "https://a.example/start" };
  const originalPush = function pushState(state, title, url) {
    location.href = url;
    return "push-result";
  };
  const originalReplace = function replaceState(state, title, url) {
    location.href = url;
    return "replace-result";
  };
  const env = {
    history: { pushState: originalPush, replaceState: originalReplace },
    location,
    listeners,
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter(item => item !== fn));
    }
  };
  return { env, listeners, originalPush, originalReplace, location };
}

function fire(env, type) {
  const list = env.listeners.get(type) || [];
  for (const fn of list) fn();
}

test("pushState and replaceState trigger the route observer and keep the original result", () => {
  const { env, originalPush, originalReplace, location } = makeFakeEnv();
  let calls = 0;
  const uninstall = installHistoryRouteObserver(() => { calls += 1; }, env);
  assert.equal(env.history.pushState("s", "t", "https://a.example/next"), "push-result");
  assert.equal(calls, 1);
  assert.equal(location.href, "https://a.example/next");
  assert.equal(env.history.replaceState("s", "t", "https://a.example/final"), "replace-result");
  assert.equal(calls, 2);
  assert.equal(location.href, "https://a.example/final");
  uninstall();
  assert.equal(env.history.pushState, originalPush);
  assert.equal(env.history.replaceState, originalReplace);
});

test("popstate and hashchange events trigger the observer", () => {
  const { env, location } = makeFakeEnv();
  let calls = 0;
  const uninstall = installHistoryRouteObserver(() => { calls += 1; }, env);
  location.href = "https://a.example/pop";
  fire(env, "popstate");
  assert.equal(calls, 1);
  location.href = "https://a.example/#section";
  fire(env, "hashchange");
  assert.equal(calls, 2);
  uninstall();
  location.href = "https://a.example/after-uninstall";
  fire(env, "popstate");
  assert.equal(calls, 2, "listeners must be removed on uninstall");
});

test("same-URL navigation does not fire duplicate route changes", () => {
  const { env, location } = makeFakeEnv();
  let calls = 0;
  const uninstall = installHistoryRouteObserver(() => { calls += 1; }, env);
  env.history.pushState("s", "t", "https://a.example/start");
  assert.equal(calls, 0, "pushing the same URL is not a route change");
  env.history.pushState("s", "t", "https://a.example/start");
  assert.equal(calls, 0);
  env.history.pushState("s", "t", "https://a.example/other");
  assert.equal(calls, 1);
  uninstall();
});

test("double installation does not double-wrap history methods", () => {
  const { env, originalPush } = makeFakeEnv();
  let firstCalls = 0;
  let secondCalls = 0;
  const first = installHistoryRouteObserver(() => { firstCalls += 1; }, env);
  const second = installHistoryRouteObserver(() => { secondCalls += 1; }, env);
  assert.notEqual(env.history.pushState, originalPush, "history is wrapped");
  env.history.pushState("s", "t", "https://a.example/once");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0, "second observer does not re-wrap the already-wrapped method");
  first();
  second();
  assert.equal(env.history.pushState, originalPush, "uninstall restores the original method");
});

test("uninstall is idempotent and safe without window listeners", () => {
  const { env } = makeFakeEnv();
  let calls = 0;
  const uninstall = installHistoryRouteObserver(() => { calls += 1; }, env);
  uninstall();
  uninstall();
  env.history.pushState("s", "t", "https://a.example/x");
  assert.equal(calls, 0);
});

test("observer without event support degrades to a no-op uninstaller", () => {
  const env = { history: { pushState() {}, replaceState() {} }, location: { href: "https://a.example" } };
  const uninstall = installHistoryRouteObserver(() => {}, env);
  assert.equal(typeof uninstall, "function");
  uninstall();
});

test("the main-world bridge source wraps real history methods and dispatches an event", () => {
  const source = buildMainWorldBridgeSource();
  assert.match(source, /pushState/);
  assert.match(source, /replaceState/);
  assert.match(source, /history\[method\] = function/u);
  assert.match(source, /dispatchEvent\(new CustomEvent\("mt-route-change"\)\)/u);
  assert.match(source, /window\.__mtRouteBridgeInstalled/u);
  assert.doesNotMatch(source, /chrome\./u, "桥脚本不依赖扩展 API");
  // 作为脚本执行时不抛错（纯主世界代码）
  const sandbox = {};
  new Function("window", "history", source)(sandbox, {
    pushState() { return "ok"; },
    replaceState() { return "ok"; }
  });
  assert.equal(sandbox.__mtRouteBridgeInstalled, true);
});

test("bridge CustomEvent triggers the observer with URL deduplication", () => {
  const { env, location } = makeFakeEnv();
  let calls = 0;
  const uninstall = installHistoryRouteObserver(() => { calls += 1; }, env);
  location.href = "https://a.example/spa";
  fire(env, "mt-route-change");
  assert.equal(calls, 1);
  fire(env, "mt-route-change");
  assert.equal(calls, 1, "同 URL 的桥事件去重");
  location.href = "https://a.example/spa2";
  fire(env, "mt-route-change");
  assert.equal(calls, 2);
  uninstall();
  location.href = "https://a.example/spa3";
  fire(env, "mt-route-change");
  assert.equal(calls, 2, "卸载后桥事件不再触发");
});

test("injectMainWorldRouteBridge tolerates missing document", () => {
  assert.equal(injectMainWorldRouteBridge(null), false);
  assert.equal(injectMainWorldRouteBridge({}), false);
});

test("injectMainWorldRouteBridge uses an external file via urlResolver", () => {
  const appended = [];
  const fakeScript = {
    src: "",
    setAttribute(name, value) {
      this[name] = value;
    },
    remove() {
      this.removed = true;
    }
  };
  const fakeDoc = {
    documentElement: {
      dataset: {},
      appendChild(node) {
        appended.push(node);
      }
    },
    createElement() {
      return fakeScript;
    }
  };
  const ok = injectMainWorldRouteBridge(fakeDoc, () => "chrome-extension://abc/assets/route-bridge.js");
  assert.equal(ok, true);
  assert.equal(fakeDoc.documentElement.dataset.mtBridge, "ok");
  assert.equal(fakeScript.src, "chrome-extension://abc/assets/route-bridge.js");
  assert.equal(appended.length, 1);
  assert.equal(appended[0]["data-mt-route-bridge"], "true");
  assert.equal(fakeScript.removed, true);
});

test("injectMainWorldRouteBridge fails cleanly without a resolver", () => {
  const fakeDoc = {
    documentElement: { dataset: {}, appendChild() {} },
    createElement() {
      return {};
    }
  };
  assert.equal(injectMainWorldRouteBridge(fakeDoc, null), false);
  assert.equal(fakeDoc.documentElement.dataset.mtBridge, "no-resolver");
});

test("route callback receives { previousUrl, nextUrl, reason } for pushState", () => {
  const { env, location } = makeFakeEnv();
  let event = null;
  const uninstall = installHistoryRouteObserver(evt => { event = evt; }, env);
  env.history.pushState("s", "t", "https://a.example/next");
  assert.deepEqual(event, {
    previousUrl: "https://a.example/start", nextUrl: "https://a.example/next", reason: "pushState"
  });
  env.history.replaceState("s", "t", "https://a.example/final");
  assert.deepEqual(event, {
    previousUrl: "https://a.example/next", nextUrl: "https://a.example/final", reason: "replaceState"
  });
  assert.equal(location.href, "https://a.example/final");
  uninstall();
});

test("popstate and hashchange events carry their own reason", () => {
  const { env, location } = makeFakeEnv();
  const events = [];
  const uninstall = installHistoryRouteObserver(evt => { events.push(evt); }, env);
  location.href = "https://a.example/pop";
  fire(env, "popstate");
  location.href = "https://a.example/hash#x";
  fire(env, "hashchange");
  assert.deepEqual(events.map(e => e.reason), ["popstate", "hashchange"]);
  uninstall();
});

test("pageshow with persisted=true notifies even when the URL is unchanged", () => {
  const { env, listeners } = makeFakeEnv();
  const events = [];
  const uninstall = installHistoryRouteObserver(evt => { events.push(evt); }, env);
  const pageshow = listeners.get("pageshow");
  assert.ok(pageshow && pageshow.length >= 1, "pageshow listener registered");
  // bfcache 恢复：URL 未变但必须通知会话重新激活
  pageshow[pageshow.length - 1]({ persisted: true });
  assert.deepEqual(events, [{
    previousUrl: "https://a.example/start", nextUrl: "https://a.example/start", reason: "pageshow"
  }]);
  // 初次加载（persisted=false）不通知
  pageshow[pageshow.length - 1]({ persisted: false });
  assert.equal(events.length, 1);
  uninstall();
});

test("bridge events carry the bridge reason", () => {
  const { env, listeners, location } = makeFakeEnv();
  const events = [];
  const uninstall = installHistoryRouteObserver(evt => { events.push(evt); }, env);
  location.href = "https://a.example/bridged";
  fire(env, "mt-route-change");
  assert.deepEqual(events[0], {
    previousUrl: "https://a.example/start", nextUrl: "https://a.example/bridged", reason: "bridge"
  });
  uninstall();
});

test("uninstall removes the pageshow listener", () => {
  const { env, listeners } = makeFakeEnv();
  const uninstall = installHistoryRouteObserver(() => {}, env);
  uninstall();
  assert.equal((listeners.get("pageshow") || []).length, 0);
});
