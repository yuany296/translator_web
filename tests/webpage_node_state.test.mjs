import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebpageNodeStateStore,
  pruneDisconnectedNodes,
  isNodeModifiedByPage,
  shouldApplyTranslation,
  shouldRestoreNode
} from "../extension/src/content/modules/webpage-node-state.js";

function makeTextNode(value) {
  return { nodeValue: value, isConnected: true };
}

test("node state lives in a WeakMap and a managed-node Set", () => {
  const store = createWebpageNodeStateStore();
  const nodeA = makeTextNode("hello");
  const nodeB = makeTextNode("world");
  store.set(nodeA, { originalText: "hello", translatedText: "你好" });
  store.set(nodeB, { originalText: "world", translatedText: "世界" });
  assert.equal(store.size, 2);
  assert.equal(store.get(nodeA).translatedText, "你好");
  const seen = [];
  store.forEach((node, entry) => seen.push([node.nodeValue, entry.translatedText]));
  assert.deepEqual(seen.sort(), [["hello", "你好"], ["world", "世界"]]);
  store.release(nodeA);
  assert.equal(store.size, 1);
  assert.equal(store.get(nodeA), undefined);
  store.clear();
  assert.equal(store.size, 0);
});

test("sibling text nodes under one parent are tracked independently", () => {
  const store = createWebpageNodeStateStore();
  // 同一个父元素下两个 Text 节点互不影响
  const first = makeTextNode("Open");
  const second = makeTextNode("Save");
  store.set(first, { originalText: "Open", translatedText: "打开" });
  store.set(second, { originalText: "Save", translatedText: "保存" });
  assert.equal(store.get(first).translatedText, "打开");
  assert.equal(store.get(second).translatedText, "保存");
  store.release(first);
  assert.equal(store.size, 1);
  assert.equal(store.get(second).translatedText, "保存");
});

test("shouldApplyTranslation requires every guard to pass", () => {
  const base = {
    isConnected: true,
    currentValue: "원문",
    sourceText: "원문",
    generation: 7,
    currentGeneration: 7,
    pageKey: "https://a.example",
    currentPageKey: "https://a.example",
    wantsTranslation: true
  };
  assert.equal(shouldApplyTranslation(base), true);
  assert.equal(shouldApplyTranslation({ ...base, isConnected: false }), false);
  assert.equal(shouldApplyTranslation({ ...base, currentValue: "页面自己更新了" }), false);
  assert.equal(shouldApplyTranslation({ ...base, generation: 7, currentGeneration: 8 }), false);
  assert.equal(shouldApplyTranslation({ ...base, pageKey: "https://old.example", currentPageKey: "https://new.example" }), false);
  assert.equal(shouldApplyTranslation({ ...base, wantsTranslation: false }), false);
});

test("shouldRestoreNode only restores text that the plugin itself wrote", () => {
  const translated = "打开";
  assert.equal(shouldRestoreNode({ isConnected: true, currentValue: translated, translatedText: translated }), true);
  assert.equal(shouldRestoreNode({ isConnected: true, currentValue: "网页更新后的新文本", translatedText: translated }), false);
  assert.equal(shouldRestoreNode({ isConnected: false, currentValue: translated, translatedText: translated }), false);
});

test("pruneDisconnectedNodes removes disconnected nodes and keeps connected ones", () => {
  const store = createWebpageNodeStateStore();
  const connected = { nodeValue: "a", isConnected: true };
  const disconnected = { nodeValue: "b", isConnected: false };
  store.set(connected, { originalText: "a", translatedText: "译" });
  store.set(disconnected, { originalText: "b", translatedText: "译" });
  assert.equal(store.size, 2);
  const pruned = store.prune();
  assert.equal(pruned, 1);
  assert.equal(store.size, 1);
  assert.equal(store.get(connected).originalText, "a");
  assert.equal(store.get(disconnected), undefined);
});

test("prune is idempotent", () => {
  const store = createWebpageNodeStateStore();
  store.set({ nodeValue: "x", isConnected: false }, { originalText: "x", translatedText: "译" });
  assert.equal(store.prune(), 1);
  assert.equal(store.prune(), 0);
});

test("a thousand removed nodes leave the managed set at a sane size", () => {
  const store = createWebpageNodeStateStore();
  for (let index = 0; index < 1000; index += 1) {
    store.set({ nodeValue: `n${index}`, isConnected: index < 10 }, { originalText: `n${index}`, translatedText: "译" });
  }
  assert.equal(store.size, 1000);
  const pruned = store.prune();
  assert.equal(pruned, 990);
  assert.equal(store.size, 10);
});

test("the same node is never added twice", () => {
  const store = createWebpageNodeStateStore();
  const node = { nodeValue: "s", isConnected: true };
  store.set(node, { originalText: "s", translatedText: "译1" });
  store.set(node, { originalText: "s", translatedText: "译2" });
  assert.equal(store.size, 1);
  assert.equal(store.get(node).translatedText, "译2");
});

test("isNodeModifiedByPage detects page-written content that is neither original nor translation", () => {
  const entry = { originalText: "A", translatedText: "B" };
  assert.equal(isNodeModifiedByPage(entry, "A"), false);
  assert.equal(isNodeModifiedByPage(entry, "B"), false);
  assert.equal(isNodeModifiedByPage(entry, "C"), true, "页面自行改写的文本被识别");
  assert.equal(isNodeModifiedByPage(null, "C"), false);
});

test("pruneDisconnectedNodes works on plain sets without a store", () => {
  const nodes = new Set();
  const states = new WeakMap();
  const alive = { nodeValue: "a", isConnected: true };
  const dead = { nodeValue: "b", isConnected: false };
  nodes.add(alive);
  nodes.add(dead);
  states.set(alive, {});
  states.set(dead, {});
  assert.equal(pruneDisconnectedNodes(nodes, states), 1);
  assert.deepEqual([...nodes], [alive]);
});
