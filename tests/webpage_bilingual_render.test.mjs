import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWebpageTranslation, cleanupWebpageEntry, updateWebpageProgress
} from "../extension/src/content/modules/webpage-renderer.js";
import { createWebpageNodeStateStore } from "../extension/src/content/modules/webpage-node-state.js";
import { createPageSession, createSegment } from "../extension/src/content/modules/webpage-session.js";

// ---- Fake DOM ----

class FakeClassList {
  constructor() { this.set = new Set(); }
  toggle(name, force) {
    const shouldHave = force === undefined ? !this.set.has(name) : Boolean(force);
    if (shouldHave) this.set.add(name); else this.set.delete(name);
    return shouldHave;
  }
}

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = null;
    this.isConnected = true;
  }

  get nextSibling() {
    const siblings = this.parentElement?.childNodes || [];
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.childNodes = [];
    this.children = this.childNodes;
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.isConnected = true;
    this.parentElement = null;
    this.hidden = false;
    this.style = {};
    this.classList = new FakeClassList();
    this.attributes = {};
  }

  // 只有 <a> 算交互元素：safeBilingualContainer 因此拒绝「段落里含链接」的容器
  matches() { return this.tagName === "A"; }

  querySelector(selector) {
    void selector;
    return this.childNodes.find(node => node.nodeType === 1 && node.tagName === "A") || null;
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  insertBefore(child, reference) {
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index >= 0) this.childNodes.splice(index, 0, child);
    else this.childNodes.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  setAttribute(name, value) { this.attributes[name] = value; }

  remove() {
    const siblings = this.parentElement?.childNodes;
    if (siblings) {
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
    this.parentElement = null;
    this.isConnected = false;
  }
}

globalThis.Node = { TEXT_NODE: 3 };
globalThis.document = {
  createElement: tagName => new FakeElement(tagName),
  // 旧的 hover 提示会把提示元素挂到 documentElement 上；双语模式必须不再碰它
  get documentElement() { throw new Error("双语模式不应再创建 hover 提示元素"); }
};

function paragraph(tagName = "P", text = "원문") {
  const container = new FakeElement(tagName);
  const node = new FakeText(text);
  container.appendChild(node);
  return { container, node };
}

function makeState(displayMode = "bilingual") {
  return { displayMode, nodeStore: createWebpageNodeStateStore(), tooltip: null };
}

const meta = { sourceHash: "hash", generation: 1, pageKey: "https://example.com/page" };

function translationsIn(parent) {
  return parent.childNodes.filter(node => node.nodeType === 1
    && String(node.className).includes("mt-webpage-bilingual-translation"));
}

function textOf(element) {
  const own = typeof element.textContent === "string" ? element.textContent : "";
  return [own, ...(element.childNodes || []).map(textOf)].filter(Boolean).join(" ");
}

// ---- 用例 ----

test("块级段落：译文另起一行插在原文之后（容器内）", () => {
  const state = makeState();
  const { container, node } = paragraph("P", "안녕하세요");
  const runtime = { state };
  assert.equal(applyWebpageTranslation(runtime, state, { node, text: "안녕하세요" }, "你好", meta), true);
  const [translation] = translationsIn(container);
  assert.ok(translation, "译文必须真的出现在 DOM 里，而不是等到悬停");
  assert.equal(translation.className, "mt-webpage-bilingual-translation mt-webpage-bilingual-block");
  assert.equal(translation.textContent, "你好");
  assert.equal(container.childNodes.indexOf(translation), container.childNodes.indexOf(node) + 1,
    "译文紧跟原文字节点");
  assert.equal(node.nodeValue, "안녕하세요", "双语模式不改写原文");
  assert.equal(state.nodeStore.get(node).renderKind, "block");
});

test("内联上下文（div/span 里的文字）：译文行内紧跟原文出现", () => {
  const state = makeState();
  const wrapper = new FakeElement("DIV");
  const node = new FakeText("로그인");
  wrapper.appendChild(node);
  const runtime = { state };
  applyWebpageTranslation(runtime, state, { node, text: "로그인" }, "登录", meta);
  const [translation] = translationsIn(wrapper);
  assert.ok(translation, "非块级容器也必须直接显示译文（此前退化成悬停提示）");
  assert.equal(translation.className, "mt-webpage-bilingual-translation mt-webpage-bilingual-inline");
  assert.equal(wrapper.childNodes.indexOf(translation), wrapper.childNodes.indexOf(node) + 1);
  assert.equal(state.nodeStore.get(node).renderKind, "inline");
});

test("段落里含链接（交互元素）时走行内路径，不插块级元素", () => {
  const state = makeState();
  const container = new FakeElement("P");
  const node = new FakeText("자세히 보기");
  container.appendChild(node);
  container.appendChild(new FakeElement("A"));
  applyWebpageTranslation({ state }, state, { node, text: "자세히 보기" }, "查看详情", meta);
  const [translation] = translationsIn(container);
  assert.equal(translation.className, "mt-webpage-bilingual-translation mt-webpage-bilingual-inline");
});

test("重复渲染幂等：同一条译文不会插第二份", () => {
  const state = makeState();
  const { container, node } = paragraph("P", "원문");
  const entry = { node, text: "원문" };
  applyWebpageTranslation({ state }, state, entry, "译文", meta);
  applyWebpageTranslation({ state }, state, entry, "译文", meta);
  assert.equal(translationsIn(container).length, 1);
});

test("译文变化时替换旧元素，而不是叠加", () => {
  const state = makeState();
  const { container, node } = paragraph("P", "원문");
  const entry = { node, text: "원문" };
  applyWebpageTranslation({ state }, state, entry, "旧译文", meta);
  applyWebpageTranslation({ state }, state, entry, "新译文", meta);
  const list = translationsIn(container);
  assert.equal(list.length, 1);
  assert.equal(list[0].textContent, "新译文");
  assert.equal(state.nodeStore.get(node).insertedNode, list[0]);
});

test("恢复原文只移除译文元素，不动原文字节点", () => {
  const state = makeState();
  const { container, node } = paragraph("P", "원문");
  applyWebpageTranslation({ state }, state, { node, text: "원문" }, "译文", meta);
  const entry = state.nodeStore.get(node);
  assert.equal(cleanupWebpageEntry(node, entry, () => true), true);
  assert.equal(translationsIn(container).length, 0);
  assert.equal(container.childNodes.includes(node), true);
  assert.equal(node.nodeValue, "원문");
});

test("仅译文模式仍然直接改写文本节点", () => {
  const state = makeState("translated");
  const { container, node } = paragraph("P", "원문");
  applyWebpageTranslation({ state }, state, { node, text: "원문" }, "译文", meta);
  assert.equal(node.nodeValue, "译文");
  assert.equal(translationsIn(container).length, 0);
  assert.equal(state.nodeStore.get(node).renderKind, "replace");
});

test("进度面板写出首个失败原因，用户不必悬停红图标", () => {
  const state = makeState();
  const wrap = new FakeElement("DIV");
  const session = createPageSession("https://example.com/page", 1);
  const node = new FakeText("원문");
  const segment = createSegment({ segmentKey: "s1", node, text: "원문" }, 0);
  segment.status.translation = "failed";
  segment.errors = [{ error: "Translation request timed out after 30000ms" }];
  session.segments.set("s1", segment);
  state.session = session;
  state.floatingBallWrap = wrap;
  const runtime = {
    state,
    getVisibleWebpageProgress: () => ({
      viewportTotal: 1, viewportDone: 0, backgroundTotal: 0, backgroundDone: 0,
      pendingSave: 0, realFailed: 1, unchangedCount: 0
    }),
    isWebpageQueueBusy: () => false
  };
  updateWebpageProgress(runtime, state);
  const panel = state.progressPanel;
  assert.ok(panel, "失败时必须显示进度面板");
  assert.equal(panel.hidden, false);
  assert.match(textOf(panel), /失败 1/u);
  assert.match(textOf(panel), /Translation request timed out/u);
});
