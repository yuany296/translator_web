import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const onRemovedListeners = [];
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
    tabs: { onRemoved: { addListener(listener) { onRemovedListeners.push(listener); } } },
    storage: { session: {}, local: {} }
  },
  console,
  fetch,
  URL,
  AbortController,
  DOMException,
  atob,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});

function installSessionStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.storage.session.get = async keys => {
    if (keys === null) return { ...stored };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.map(key => [key, stored[key]]));
  };
  context.chrome.storage.session.set = async value => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
  };
  context.chrome.storage.session.remove = async keys => {
    (Array.isArray(keys) ? keys : [keys]).forEach(key => delete stored[key]);
  };
  return stored;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const sessionStorage = installSessionStorage();
const background = context.MtBackgroundModule.backgroundRuntime;
const senderFor = tabId => ({ tab: { id: tabId } });

test("unknown tab reports the default controller state", async () => {
  const result = await background.handleGetWebpageTabState({}, senderFor(101));
  assert.deepEqual(plain(result), {
    ok: true,
    state: { mode: "off", visibility: "source", currentPageKey: null, navigationGeneration: 0 }
  });
});

test("SET accepts mode and visibility only, per tab", async () => {
  const result = await background.handleSetWebpageTabState(
    { mode: "continuous", visibility: "translated" }, senderFor(102)
  );
  assert.equal(result.ok, true);
  assert.equal(result.state.mode, "continuous");
  assert.equal(result.state.visibility, "translated");
  assert.equal(result.state.navigationGeneration, 0);
  // 其他标签页不受影响
  const other = await background.handleGetWebpageTabState({}, senderFor(103));
  assert.equal(other.state.mode, "off");
  assert.equal(other.state.visibility, "source");
});

test("SET rejects invalid mode and visibility", async () => {
  const bad = await background.handleSetWebpageTabState({ mode: "always" }, senderFor(102));
  assert.equal(bad.ok, false);
  const badVisibility = await background.handleSetWebpageTabState({ visibility: "both" }, senderFor(102));
  assert.equal(badVisibility.ok, false);
  const unchanged = await background.handleGetWebpageTabState({}, senderFor(102));
  assert.equal(unchanged.state.mode, "continuous");
});

test("pageKey report updates currentPageKey and bumps navigationGeneration once", async () => {
  const first = await background.handleSetWebpageTabState(
    { pageKey: "https://example.com/a" }, senderFor(104)
  );
  assert.equal(first.ok, true);
  assert.equal(first.state.currentPageKey, "https://example.com/a");
  assert.equal(first.state.navigationGeneration, 1);
  // 同一 pageKey 不重复 bump
  const same = await background.handleSetWebpageTabState(
    { pageKey: "https://example.com/a" }, senderFor(104)
  );
  assert.equal(same.state.navigationGeneration, 1);
  const next = await background.handleSetWebpageTabState(
    { pageKey: "https://example.com/b" }, senderFor(104)
  );
  assert.equal(next.state.currentPageKey, "https://example.com/b");
  assert.equal(next.state.navigationGeneration, 2);
});

test("CLEAR resets the tab controller", async () => {
  await background.handleSetWebpageTabState(
    { mode: "continuous", visibility: "translated", pageKey: "https://example.com/a" }, senderFor(105)
  );
  const cleared = await background.handleClearWebpageTabState({}, senderFor(105));
  assert.equal(cleared.ok, true);
  const state = await background.handleGetWebpageTabState({}, senderFor(105));
  assert.deepEqual(plain(state.state), {
    mode: "off", visibility: "source", currentPageKey: null, navigationGeneration: 0
  });
});

test("controller state persists to chrome.storage.session", async () => {
  const key = "mt_webpage_tab_v1:106";
  await background.handleSetWebpageTabState(
    { mode: "continuous", visibility: "translated", pageKey: "https://example.com/c" }, senderFor(106)
  );
  assert.ok(sessionStorage[key], "session storage entry written");
  assert.equal(sessionStorage[key].mode, "continuous");
  assert.equal(sessionStorage[key].currentPageKey, "https://example.com/c");
  assert.equal(sessionStorage[key].navigationGeneration, 1);
});

test("tab close clears the controller through tabs.onRemoved", async () => {
  await background.handleSetWebpageTabState(
    { mode: "continuous", visibility: "translated" }, senderFor(107)
  );
  assert.equal((await background.handleGetWebpageTabState({}, senderFor(107))).state.mode, "continuous");
  assert.equal(onRemovedListeners.length >= 1, true);
  onRemovedListeners[onRemovedListeners.length - 1](107);
  await new Promise(resolve => setTimeout(resolve, 0));
  const after = await background.handleGetWebpageTabState({}, senderFor(107));
  assert.equal(after.state.mode, "off");
  assert.equal(sessionStorage["mt_webpage_tab_v1:107"], undefined);
});

test("message handlers are routed by runtime.handleMessage", async () => {
  const result = await background.handleMessage(
    { type: "SET_WEBPAGE_TAB_STATE", mode: "continuous", visibility: "translated" }, senderFor(108)
  );
  assert.equal(result.ok, true);
  assert.equal(result.state.mode, "continuous");
  const fetched = await background.handleMessage(
    { type: "GET_WEBPAGE_TAB_STATE" }, senderFor(108)
  );
  assert.equal(fetched.state.visibility, "translated");
  const cleared = await background.handleMessage(
    { type: "CLEAR_WEBPAGE_TAB_STATE" }, senderFor(108)
  );
  assert.equal(cleared.ok, true);
});
