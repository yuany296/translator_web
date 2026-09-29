import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installDiagnosticsOverlay } from "../extension/src/content/modules/diagnostics-overlay.js";

function fakeNode(overrides = {}) {
  return {
    dataset: {},
    style: {},
    isConnected: true,
    tagName: "DIV",
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
    ...overrides
  };
}

function bubble(canonicalId, translated) {
  const node = fakeNode();
  node.dataset.canonicalId = canonicalId;
  node.dataset.translated = translated;
  node.dataset.projectionRole = "text_primary";
  node.dataset.blockId = `block-${canonicalId}`;
  return node;
}

function overlayState(targetId, bubbles, options = {}) {
  const root = fakeNode();
  root.style.display = options.display || "";
  return {
    targetId,
    targetKey: `key-${targetId}`,
    target: fakeNode({ tagName: "IMG" }),
    bubbleNodes: bubbles,
    bubbleCount: bubbles.length,
    displayRect: null,
    imageMeta: null,
    root
  };
}

function makeHarness(overlays, surfaces) {
  const runtime = {
    state: { overlaysById: new Map(overlays.map(state => [state.targetId, state])) },
    getOverlayDisplayRect: () => ({ left: 10, top: 20, width: 300, height: 600 })
  };
  globalThis.document = {
    querySelectorAll: selector => (selector === ".mt-cross-page-overlay" ? surfaces : [])
  };
  globalThis.location = { href: "https://page.kakao.com/content/1/viewer/2/" };
  installDiagnosticsOverlay(runtime);
  return runtime;
}

function seamSurface(canonicalId, translated) {
  const textNode = bubble(canonicalId, translated);
  const overlay = fakeNode();
  overlay.dataset.canonicalId = canonicalId;
  overlay.dataset.seamRenderKey = `seam-${canonicalId}`;
  overlay.querySelector = () => textNode;
  return overlay;
}

test("残留壳：被隐藏且已由接缝面覆盖的 root 会被标出来", () => {
  const canonical = "canonical_2bede0c8914cf1";
  const runtime = makeHarness([
    overlayState("target-hidden", [bubble(canonical, "游乐设施")], { display: "none" }),
    overlayState("target-visible", [bubble(canonical, "听说游乐设施指南里包含这个主题公园的相关内容。")])
  ], [seamSurface(canonical, "听说游乐设施指南里包含这个主题公园的相关内容。")]);

  const report = runtime.reportOverlayGeometry();

  assert.equal(report.summary.roots, 2);
  assert.equal(report.summary.huskRoots, 1);
  assert.equal(report.summary.seamSurfaces, 1);
  const husk = report.roots.find(root => root.targetId === "target-hidden");
  assert.equal(husk.husk, true);
  assert.equal(husk.coveredBySeam, true);
  assert.equal(husk.bubbles[0].translated, "游乐设施");
  // displayRect 来自 target（没带 payload displayRect）时也要能读出来
  assert.equal(husk.displayRectSource, "target");
  assert.deepEqual(husk.displayRect, { left: 10, top: 20, width: 300, height: 600 });
});

test("同一 canonical 出现两个不同译文时报告冲突（壳复活旧值的证据）", () => {
  const canonical = "canonical_2bede0c8914cf1";
  const runtime = makeHarness([
    overlayState("target-hidden", [bubble(canonical, "游乐设施")], { display: "none" }),
    overlayState("target-visible", [bubble(canonical, "听说游乐设施指南里包含这个主题公园的相关内容。")])
  ], []);

  const report = runtime.reportOverlayGeometry();

  assert.equal(report.summary.conflicts, 1);
  const conflict = report.conflicts[0];
  assert.equal(conflict.canonicalId, canonical);
  assert.deepEqual(conflict.entries.map(entry => entry.translated).sort(), [
    "听说游乐设施指南里包含这个主题公园的相关内容。", "游乐设施"
  ]);
});

test("可见且未被接缝接管的 root 不算残留壳", () => {
  const runtime = makeHarness([
    overlayState("target-visible", [bubble("canonical_a", "甲")])
  ], []);

  const report = runtime.reportOverlayGeometry();

  assert.equal(report.summary.huskRoots, 0);
  assert.equal(report.summary.conflicts, 0);
  assert.equal(report.roots[0].husk, false);
});

test("控制台助手挂到 window 上并返回同一份报告", () => {
  const runtime = makeHarness([overlayState("target-visible", [bubble("canonical_a", "甲")])], []);
  globalThis.window = {};

  runtime.exposeOverlayGeometryConsoleHelper();
  const report = globalThis.window.__mtOverlayGeometryReport();

  assert.equal(typeof globalThis.window.__mtOverlayGeometryReport, "function");
  assert.equal(report.summary.roots, 1);
  delete globalThis.window.__mtOverlayGeometryReport;
});

// 接缝三重 OCR（上片/下片/composite）只留一份 primary，其余 standby 必须在渲染前被滤掉，
// 否则同一段文字会画出两遍。这条契约是本轮「隐藏 root」结论的代码依据。
test("内容侧渲染前会滤掉 standby 投影", () => {
  const source = readFileSync(new URL("../extension/src/content/configure.js", import.meta.url), "utf8");
  assert.match(source, /return projection\.active !== false && role !== "standby" && role !== "text_standby";/u);
});
