import assert from "node:assert/strict";
import test from "node:test";

import { installWebpageTabState } from "../extension/src/content/modules/webpage-tab-state.js";
import { installWebpageSession } from "../extension/src/content/modules/webpage-session.js";

function installRuntime({ topFrame = true, controller = null } = {}) {
  const windowObj = { top: null, innerHeight: 800, scrollY: 0 };
  const otherWindow = { top: null };
  windowObj.top = topFrame ? windowObj : otherWindow;
  globalThis.window = windowObj;
  globalThis.location = { href: "https://example.com/page" };

  const sent = [];
  const calls = { translate: 0, reported: [] };
  const current = {
    mode: controller?.mode || "off",
    visibility: controller?.visibility || "source",
    currentPageKey: controller?.currentPageKey || null,
    navigationGeneration: controller?.navigationGeneration || 0
  };
  const webpage = {
    nodeStore: {
      activeNodes: new Set(), set() {}, get() {}, forEach() {}, prune() {},
      release() {}, clear() {}, size: 0
    },
    savedKeys: new Set(), showTranslation: false, working: false, generation: 0,
    taskId: "", taskUrl: "", pageKey: "https://example.com/page", cacheStatus: "none",
    cacheCheckedKey: "", cacheAnalysisPending: false, cacheBadgeUntil: 0,
    partialFailure: false, errorMessage: "", progressPanel: null, active: false,
    progressHideTimer: 0, controller: null, session: null, pageFault: null,
    progress: {}
  };
  const runtime = {
    state: { webpage },
    getWebpageState: () => webpage,
    sendRuntimeMessage: async message => {
      sent.push(message);
      if (message.type === "GET_WEBPAGE_TAB_STATE") return { ok: true, state: { ...current } };
      if (message.type === "SET_WEBPAGE_TAB_STATE") {
        if (message.mode !== undefined) current.mode = message.mode;
        if (message.visibility !== undefined) current.visibility = message.visibility;
        if (typeof message.pageKey === "string" && message.pageKey !== current.currentPageKey) {
          current.currentPageKey = message.pageKey;
          current.navigationGeneration += 1;
        }
        return { ok: true, state: { ...current } };
      }
      return { ok: true };
    },
    normalizeTranslationCacheUrl: () => "https://example.com/page",
    reportWebpagePageKey: async pageKey => {
      calls.reported.push(pageKey);
      current.currentPageKey = pageKey;
      current.navigationGeneration += 1;
      return { ...current };
    },
    updateFloatingBallState: () => {},
    translateWebpage: async () => { calls.translate += 1; return { ok: true }; }
  };
  installWebpageSession(runtime);
  installWebpageTabState(runtime);
  return { runtime, sent, calls, webpage };
}

test("normalizeWebpageTabController defaults invalid input", () => {
  const { runtime } = installRuntime();
  assert.deepEqual(runtime.normalizeWebpageTabController(null), {
    mode: "off", visibility: "source", currentPageKey: null, navigationGeneration: 0
  });
  assert.deepEqual(runtime.normalizeWebpageTabController({ mode: "always", visibility: "both" }), {
    mode: "off", visibility: "source", currentPageKey: null, navigationGeneration: 0
  });
});

test("child frames never create a webpage tab controller", async () => {
  const { runtime, sent, calls } = installRuntime({ topFrame: false, controller: { mode: "continuous" } });
  const result = await runtime.initializeWebpageTabSession();
  assert.deepEqual(result, { skipped: true, reason: "child-frame" });
  assert.equal(sent.length, 0, "子 frame 不发送控制器消息");
  assert.equal(calls.translate, 0);
});

test("init with mode off reads the controller but does not translate", async () => {
  const { runtime, sent, calls, webpage } = installRuntime({ controller: { mode: "off", visibility: "source" } });
  const result = await runtime.initializeWebpageTabSession();
  assert.deepEqual(result, { skipped: true, reason: "mode-off" });
  assert.equal(sent.some(message => message.type === "GET_WEBPAGE_TAB_STATE"), true);
  assert.equal(webpage.controller.mode, "off");
  assert.equal(calls.translate, 0);
});

test("init with continuous mode resumes: session created, pageKey reported, viewport translated", async () => {
  const { runtime, sent, calls, webpage } = installRuntime({
    controller: { mode: "continuous", visibility: "translated", currentPageKey: "https://example.com/old", navigationGeneration: 3 }
  });
  const result = await runtime.initializeWebpageTabSession();
  assert.deepEqual(result, { resumed: true, mode: "continuous", visibility: "translated" });
  assert.ok(webpage.session, "持续模式自动创建当前页面会话");
  assert.equal(webpage.session.active, true);
  assert.equal(webpage.session.generation, 3, "会话使用控制器的 navigationGeneration");
  await new Promise(resolve => setTimeout(resolve, 0));
  const report = sent.find(message => message.type === "SET_WEBPAGE_TAB_STATE" && message.pageKey);
  assert.equal(report?.pageKey, "https://example.com/page", "向后台报告路由 pageKey");
  assert.equal(calls.translate, 1, "自动翻译可视区");
});

test("init with continuous + source visibility resumes background translation without rendering", async () => {
  const { runtime, calls, webpage } = installRuntime({
    controller: { mode: "continuous", visibility: "source", navigationGeneration: 1 }
  });
  const result = await runtime.initializeWebpageTabSession();
  assert.equal(result.resumed, true);
  assert.equal(result.visibility, "source");
  assert.equal(calls.translate, 1, "显示原文期间后台仍翻译");
  assert.equal(webpage.showTranslation, false);
});

test("read/set/clear tab state round-trip through the background messages", async () => {
  const { runtime } = installRuntime({ controller: { mode: "continuous", visibility: "translated" } });
  const read = await runtime.readWebpageTabController();
  assert.equal(read.mode, "continuous");
  assert.equal(read.visibility, "translated");
  const setMode = await runtime.setWebpageTabMode("off");
  assert.equal(setMode.mode, "off");
  const setVisibility = await runtime.setWebpageTabVisibility("source");
  assert.equal(setVisibility.visibility, "source");
  const cleared = await runtime.clearWebpageTabState();
  assert.equal(cleared, undefined);
});

test("isWebpageTopLevelDocument distinguishes top frame from child frame", () => {
  const { runtime } = installRuntime({ topFrame: true });
  assert.equal(runtime.isWebpageTopLevelDocument(), true);
  const child = installRuntime({ topFrame: false });
  assert.equal(child.runtime.isWebpageTopLevelDocument(), false);
});
