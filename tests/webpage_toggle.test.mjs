import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { installWebpageTranslate } from "../extension/src/content/modules/webpage-translate.js";

function makeTextNode(currentValue, connected = true) {
  return {
    nodeValue: currentValue,
    isConnected: connected,
    parentElement: { tagName: "P" }
  };
}

function makeToggleHarness() {
  const visibilityCalls = [];
  let ballRefreshes = 0;
  const runtime = {
    state: { displayMode: "translated" },
    getTargetLanguage: () => "zh-CN",
    getConfiguredSourceLanguage: () => "auto",
    normalizeTranslationCacheUrl: () => "https://example.com/page",
    setWebpageTabVisibility: async visibility => {
      visibilityCalls.push(visibility);
      return { mode: "continuous", visibility };
    },
    setWebpageTabMode: async mode => ({ mode, visibility: "source" }),
    updateFloatingBallState: () => { ballRefreshes += 1; },
    getErrorMessage: error => String(error && error.message || error)
  };
  installWebpageTranslate(runtime);
  const state = runtime.getWebpageState();
  state.generation = 1;
  state.pageKey = "https://example.com/page";
  state.controller = { mode: "continuous", visibility: "translated" };
  state.session = null;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { runtime, state, visibilityCalls, ballRefreshes: () => ballRefreshes, flush };
}

function putEntry(state, node, originalText, translatedText) {
  state.nodeStore.set(node, {
    originalText, translatedText, renderKind: "replace",
    generation: state.generation, pageKey: state.pageKey
  });
}

test("restoreWebpageTranslation restores originals and flips ball state immediately", async () => {
  const harness = makeToggleHarness();
  const node = makeTextNode("译文");
  putEntry(harness.state, node, "원문", "译文");
  harness.state.showTranslation = true;
  const result = harness.runtime.restoreWebpageTranslation();
  assert.equal(result.ok, true);
  assert.equal(result.restored, 1);
  assert.equal(harness.state.showTranslation, false);
  assert.equal(node.nodeValue, "원문");
  assert.deepEqual(harness.visibilityCalls, ["source"]);
  assert.equal(harness.ballRefreshes(), 1);
  await harness.flush();
  assert.equal(harness.state.controller.visibility, "source");
  assert.equal(harness.ballRefreshes(), 2,
    "ball refreshes again after the background controller confirms the switch");
});

test("restore releases nodes the page modified itself", () => {
  const harness = makeToggleHarness();
  const node = makeTextNode("页面新内容");
  putEntry(harness.state, node, "원문", "译文");
  harness.state.showTranslation = true;
  const result = harness.runtime.restoreWebpageTranslation();
  assert.equal(result.restored, 0);
  assert.equal(harness.state.nodeStore.size, 0);
  assert.equal(node.nodeValue, "页面新内容");
});

test("showWebpageTranslations re-applies saved translations without re-translating", async () => {
  const harness = makeToggleHarness();
  const node = makeTextNode("원문");
  putEntry(harness.state, node, "원문", "译文");
  harness.state.showTranslation = false;
  const result = harness.runtime.showWebpageTranslations();
  assert.equal(result.shown, 1);
  assert.equal(harness.state.showTranslation, true);
  assert.equal(node.nodeValue, "译文");
  assert.deepEqual(harness.visibilityCalls, ["translated"]);
  await harness.flush();
  assert.equal(harness.state.controller.visibility, "translated");
  assert.equal(harness.ballRefreshes(), 2);
});

test("showWebpageTranslations leaves nodes already showing the translation untouched", () => {
  const harness = makeToggleHarness();
  const node = makeTextNode("译文");
  putEntry(harness.state, node, "원문", "译文");
  harness.state.showTranslation = false;
  const result = harness.runtime.showWebpageTranslations();
  assert.equal(result.shown, 0);
  assert.equal(node.nodeValue, "译文");
  assert.equal(harness.state.showTranslation, false);
});

test("webpage click toggles on the local display intent and ball state derives from it", () => {
  const controls = fs.readFileSync(
    new URL("../extension/src/content/modules/controls-triple.js", import.meta.url), "utf8"
  );
  assert.match(controls, /if \(state\.showTranslation === true\) \{/u,
    "click routing must use the synchronous display intent");
  assert.match(controls, /visibility: state\.showTranslation === true \? "translated" : "source"/u,
    "ball visibility must derive from the local intent without waiting for the background");
});
