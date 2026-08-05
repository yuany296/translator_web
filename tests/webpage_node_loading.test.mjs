import assert from "node:assert/strict";
import test from "node:test";

import { installWebpageNodeLoading } from "../extension/src/content/modules/webpage-node-loading.js";
import { createPageSession, createSegment } from "../extension/src/content/modules/webpage-session.js";

// ---- Fake DOM ----

class FakeClassList {
  constructor() {
    this.set = new Set();
  }

  toggle(name, force) {
    const has = this.set.has(name);
    const shouldHave = force === undefined ? !has : Boolean(force);
    if (shouldHave) this.set.add(name);
    else this.set.delete(name);
    return shouldHave;
  }

  contains(name) {
    return this.set.has(name);
  }

  add(name) {
    this.set.add(name);
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.dataset = {};
    this.title = "";
    this.style = {};
    this.textContent = "";
    this.children = [];
    this.classList = new FakeClassList();
    this.parentNode = null;
    this.isConnected = true;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child, ref) {
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentNode = this;
    return child;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  addEventListener() {}

  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentNode = null;
    }
  }
}

let computedPosition = "static";
globalThis.document = { createElement: tag => new FakeElement(tag) };
globalThis.getComputedStyle = () => ({ position: computedPosition });

function makeTextNode(parent, name = "text", connected = true) {
  return { nodeValue: `原文-${name}`, parentElement: parent, isConnected: connected };
}

let segmentCounter = 0;

function makeSegment(node, status, error = "") {
  segmentCounter += 1;
  const segment = createSegment({
    segmentKey: `seg-${segmentCounter}`,
    bindingKey: "bk",
    translationKey: "tk",
    node,
    text: node.nodeValue,
    normalized: node.nodeValue,
    sourceHash: "hash"
  });
  segment.status.translation = status;
  if (error) segment.errors = [{ error }];
  return segment;
}

function makeRuntime(session = null) {
  const webpage = { session, showTranslation: true };
  const runtime = {
    state: { webpage, floatingBallWrap: null },
    getWebpageState: () => webpage
  };
  installWebpageNodeLoading(runtime);
  return { runtime, webpage };
}

// ---- 用例 ----

test("pending 段在文本节点后创建 inline spinner 图标", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "pending"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 1);
  const icon = parent.children[0];
  assert.equal(icon.className, "mt-webpage-node-loading");
  assert.equal(icon.dataset.mangaTranslatorOverlay, "true");
  assert.equal(icon.children.length, 2);
  assert.equal(icon.children[0].className, "mt-webpage-node-loading-spinner");
  assert.equal(parent.style.position, undefined, "inline 图标不需要定位覆盖");
});

test("inflight 图标保持，reconcile 幂等", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "inflight"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 1);
});

test("done 后图标移除", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "pending"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  session.segments.get("s1").status.translation = "done";
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 0);
});

test("failed 显示红叉与 title 错误信息", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "failed", "API 请求失败"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  const icon = parent.children[0];
  assert.ok(icon.classList.contains("mt-failed"));
  assert.equal(icon.children[1].textContent, "↻");
  assert.equal(icon.title, "API 请求失败");
});

test("blocked 不显示图标", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "blocked"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 0);
  assert.equal(parent.style.position, undefined);
});

test("同一父元素多个文本节点各自 inline 图标，清除其一不影响另一", () => {
  const parent = new FakeElement("P");
  const nodeA = makeTextNode(parent, "A");
  const nodeB = makeTextNode(parent, "B");
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(nodeA, "pending"));
  session.segments.set("s2", makeSegment(nodeB, "pending"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 2);
  session.segments.get("s1").status.translation = "done";
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 1);
});

test("父元素已有定位上下文则不被改动，清除后也不复原", () => {
  computedPosition = "relative";
  try {
    const parent = new FakeElement("P");
    parent.style.position = "relative";
    const node = makeTextNode(parent);
    const session = createPageSession("p1", 1);
    session.segments.set("s1", makeSegment(node, "pending"));
    const { runtime } = makeRuntime(session);
    runtime.syncWebpageNodeLoading();
    assert.equal(parent.children.length, 1);
    session.segments.get("s1").status.translation = "done";
    runtime.syncWebpageNodeLoading();
    assert.equal(parent.style.position, "relative");
  } finally {
    computedPosition = "static";
  }
});

test("断开节点不建图标；已有图标后断开则下次 sync 移除", () => {
  const parent = new FakeElement("P");
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(makeTextNode(parent, "A", false), "pending"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 0);
  const nodeB = makeTextNode(parent, "B", true);
  session.segments.set("s2", makeSegment(nodeB, "pending"));
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 1);
  nodeB.isConnected = false;
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 0);
});

test("sweep 清除陈旧图标（会话切换后旧段无图标）", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "pending"));
  const { runtime, webpage } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 1);
  webpage.session = createPageSession("p2", 2);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 0);
});

test("clearAllWebpageNodeLoading 移除全部（含页面已手动移除元素路径）", () => {
  const parent = new FakeElement("P");
  const nodeA = makeTextNode(parent, "A");
  const nodeB = makeTextNode(parent, "B");
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(nodeA, "pending"));
  session.segments.set("s2", makeSegment(nodeB, "pending"));
  const { runtime } = makeRuntime(session);
  runtime.syncWebpageNodeLoading();
  assert.equal(parent.children.length, 2);
  // 模拟页面自行移除了第一个图标
  parent.children[0].remove();
  runtime.clearAllWebpageNodeLoading();
  assert.equal(parent.children.length, 0);
});

test("无 session 时 sync / clearAll / refresh 安全 no-op", () => {
  const { runtime } = makeRuntime(null);
  assert.doesNotThrow(() => runtime.syncWebpageNodeLoading());
  assert.doesNotThrow(() => runtime.clearAllWebpageNodeLoading());
  assert.doesNotThrow(() => runtime.refreshWebpageUi());
});

test("refreshWebpageUi 同步图标", () => {
  const parent = new FakeElement("P");
  const node = makeTextNode(parent);
  const session = createPageSession("p1", 1);
  session.segments.set("s1", makeSegment(node, "pending"));
  const { runtime } = makeRuntime(session);
  runtime.refreshWebpageUi();
  assert.equal(parent.children.length, 1);
});
