import assert from "node:assert/strict";
import test from "node:test";

import {
  createPageSession, createSegment, createPageSessionRegistry,
  adoptConnectedBindings, getVisibleProgress, DEFAULT_MAX_SESSIONS
} from "../extension/src/content/modules/webpage-session.js";

function makeNode(name, connected = true) {
  return { name, isConnected: connected, nodeValue: "" };
}

test("createPageSession holds pageKey and generation", () => {
  const session = createPageSession("https://example.com/a", 3);
  assert.equal(session.pageKey, "https://example.com/a");
  assert.equal(session.generation, 3);
  assert.equal(session.active, false);
  assert.ok(session.segments instanceof Map);
  assert.ok(session.bindings instanceof Map);
});

test("registry getOrCreate reuses the same pageKey session and updates generation", () => {
  const registry = createPageSessionRegistry();
  const first = registry.getOrCreate("https://example.com/a", 1);
  const again = registry.getOrCreate("https://example.com/a", 2);
  assert.equal(again, first);
  assert.equal(again.generation, 2);
  assert.equal(registry.list().length, 1);
});

test("registry evicts least-recently-used inactive sessions beyond the cap", () => {
  const registry = createPageSessionRegistry({ maxSessions: 2 });
  const a = registry.getOrCreate("a", 1);
  const b = registry.getOrCreate("b", 1);
  a.active = true;
  a.activatedAt = Date.now();
  const c = registry.getOrCreate("c", 1);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get("b"), null, "inactive LRU session evicted first");
  assert.ok(registry.get("a"), "active session survives eviction");
  assert.ok(registry.get("c"));
  // 淘汰只释放引用，不删缓存：段与绑定 Map 清空
  assert.equal(b.segments.size, 0);
  assert.equal(b.bindings.size, 0);
  // 回到被淘汰的页面会创建新会话（从 IndexedDB 重新水合）
  const back = registry.getOrCreate("b", 2);
  assert.notEqual(back, b);
});

test("registry default cap is 8", () => {
  assert.equal(DEFAULT_MAX_SESSIONS, 8);
  const registry = createPageSessionRegistry();
  for (let i = 0; i < 12; i += 1) registry.getOrCreate(`page-${i}`, 1);
  assert.equal(registry.list().length, 8);
});

test("createSegment carries the three independent state axes", () => {
  const segment = createSegment({ segmentKey: "k", node: makeNode("n"), text: "안녕", normalized: "안녕", sourceHash: "h" }, 0);
  assert.equal(segment.priority, 0);
  assert.deepEqual(segment.status, { translation: "pending", rendering: "pending", persistence: "none" });
});

test("adoptConnectedBindings keeps translated nav nodes (Kakao top bar stays Chinese)", () => {
  const navNode = makeNode("nav");
  navNode.nodeValue = "中文导航";
  const prev = createPageSession("a", 1);
  const next = createPageSession("b", 2);
  prev.bindings.set(navNode, {
    originalText: "한국어 메뉴", translatedText: "中文导航",
    generation: 1, pageKey: "a", segmentKey: "k1"
  });
  const result = adoptConnectedBindings(prev, next);
  assert.deepEqual(result, { adopted: 1, released: 0, pageModified: 0, rendered: 1 });
  assert.equal(prev.bindings.size, 0);
  assert.equal(next.bindings.size, 1);
  const moved = next.bindings.get(navNode);
  assert.equal(moved.generation, 2);
  assert.equal(moved.pageKey, "b");
});

test("adoptConnectedBindings moves original-text bindings without re-render", () => {
  const node = makeNode("content");
  node.nodeValue = "한국어 본문";
  const prev = createPageSession("a", 1);
  const next = createPageSession("b", 2);
  prev.bindings.set(node, {
    originalText: "한국어 본문", translatedText: "中文正文",
    generation: 1, pageKey: "a", segmentKey: "k2"
  });
  const adopted = [];
  const result = adoptConnectedBindings(prev, next, {
    onAdopt: (n, binding) => adopted.push(binding.translatedText)
  });
  assert.equal(result.adopted, 1);
  assert.equal(result.rendered, 0);
  assert.deepEqual(adopted, ["中文正文"]);
});

test("adoptConnectedBindings releases disconnected nodes", () => {
  const node = makeNode("gone", false);
  const prev = createPageSession("a", 1);
  const next = createPageSession("b", 2);
  prev.bindings.set(node, { originalText: "x", translatedText: "y", generation: 1, pageKey: "a", segmentKey: "k3" });
  const result = adoptConnectedBindings(prev, next);
  assert.deepEqual(result, { adopted: 0, released: 1, pageModified: 0, rendered: 0 });
  assert.equal(prev.bindings.size, 0);
  assert.equal(next.bindings.size, 0);
});

test("adoptConnectedBindings releases page-rewritten nodes for rediscovery", () => {
  const node = makeNode("rewritten");
  node.nodeValue = "网页自己改写的文本";
  const prev = createPageSession("a", 1);
  const next = createPageSession("b", 2);
  prev.bindings.set(node, { originalText: "원문", translatedText: "译文", generation: 1, pageKey: "a", segmentKey: "k4" });
  const result = adoptConnectedBindings(prev, next);
  assert.deepEqual(result, { adopted: 0, released: 0, pageModified: 1, rendered: 0 });
  assert.equal(prev.bindings.size, 0);
});

test("adoptConnectedBindings skips bindings from a stale generation", () => {
  const node = makeNode("stale");
  node.nodeValue = "원문";
  const prev = createPageSession("a", 3);
  const next = createPageSession("b", 4);
  prev.bindings.set(node, { originalText: "원문", translatedText: "译文", generation: 2, pageKey: "a", segmentKey: "k5" });
  const result = adoptConnectedBindings(prev, next);
  assert.equal(result.released, 1);
  assert.equal(result.adopted, 0);
});

test("getVisibleProgress reports viewport/background/persistence axes separately", () => {
  const session = createPageSession("p", 1);
  const v1 = createSegment({ segmentKey: "v1", node: makeNode("v1"), text: "a", normalized: "a", sourceHash: "h" }, 0);
  v1.zone = "viewport";
  v1.status.translation = "done";
  v1.status.rendering = "rendered";
  v1.status.persistence = "saved";
  const v2 = createSegment({ segmentKey: "v2", node: makeNode("v2"), text: "b", normalized: "b", sourceHash: "h" }, 0);
  v2.zone = "viewport";
  v2.status.translation = "done";
  v2.status.persistence = "pending-save";
  const b1 = createSegment({ segmentKey: "b1", node: makeNode("b1"), text: "c", normalized: "c", sourceHash: "h" }, 2);
  b1.zone = "background";
  b1.status.translation = "failed";
  const b2 = createSegment({ segmentKey: "b2", node: makeNode("b2"), text: "d", normalized: "d", sourceHash: "h" }, 2);
  b2.zone = "background";
  b2.status.translation = "done";
  for (const segment of [v1, v2, b1, b2]) session.segments.set(segment.segmentKey, segment);
  assert.deepEqual(getVisibleProgress(session), {
    viewportTotal: 2, viewportDone: 2, backgroundTotal: 2, backgroundDone: 1,
    pendingSave: 1, realFailed: 1, unchangedCount: 0
  });
  assert.deepEqual(getVisibleProgress(null), {
    viewportTotal: 0, viewportDone: 0, backgroundTotal: 0, backgroundDone: 0,
    pendingSave: 0, realFailed: 0, unchangedCount: 0
  });
});
