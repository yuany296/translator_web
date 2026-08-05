import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const contentRoot = path.resolve(import.meta.dirname, "..", "extension", "src", "content");
const contentSource = [fs.readFileSync(path.join(contentRoot, "configure.js"), "utf8"), ...fs.readdirSync(path.join(contentRoot, "modules"), {
  withFileTypes: true
}).filter(entry => entry.isFile() && entry.name.endsWith(".js")).sort((a, b) => a.name.localeCompare(b.name)).map(entry => fs.readFileSync(path.join(contentRoot, "modules", entry.name), "utf8"))].join("\n");
globalThis.location = {
  hostname: "page.kakao.com",
  pathname: "/content/1",
  search: "?episode=7",
  href: "https://page.kakao.com/content/1?episode=7#page-2",
  origin: "https://page.kakao.com"
};
globalThis.window = {
  scrollX: 0,
  scrollY: 0,
  innerWidth: 1200,
  innerHeight: 800
};
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.getComputedStyle = element => element && element.__style || {
  overflowX: "visible",
  overflowY: "visible"
};
await import("../extension/src/content/index.js");
const runtime = globalThis.__MANGA_TRANSLATOR_V3__;

class FakeStyle {
  setProperty(name, value) { this[name] = value; }
  removeProperty(name) { delete this[name]; }
  getPropertyValue(name) { return this[name] || ""; }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = new FakeStyle();
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.isConnected = false;
    this.classList = {
      _set: new Set(),
      add(...names) { names.forEach(name => this._set.add(name)); },
      remove(...names) { names.forEach(name => this._set.delete(name)); },
      contains(name) { return this._set.has(name) || this.className.split(/\s+/u).includes(name); },
      toggle(name, enabled) {
        if (enabled === undefined) enabled = !this.contains(name);
        if (enabled) this._set.add(name); else this._set.delete(name);
        return enabled;
      }
    };
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  replaceChildren() { this.children = []; }
  addEventListener() {}
}

const documentMock = {
  createElement: () => new FakeElement(),
  documentElement: new FakeElement()
};

test("translation text lives in an inner mt-bubble-content node forced to center", () => {
  const originalDocument = globalThis.document;
  globalThis.document = documentMock;
  try {
    const node = runtime.__test.createBubbleNode({
      x: 10,
      y: 20,
      w: 30,
      h: 12,
      original_text: "한국어 두 줄",
      translated_text: "一二三四五六七八",
      source_line_count: 2,
      alignment: "left"
    }, 0);
    // 外层只负责定位，不承载直接文字。
    assert.equal(node.textContent, "");
    assert.equal(node.style.left, "25%");
    assert.equal(node.style.top, "26%");
    assert.match(node.style["--mt-base-transform"], /translate\(-50%, -50%\)/);
    // 内层是直接承载中文的节点。
    assert.equal(node.children.length, 1);
    const content = node.children[0];
    assert.equal(content.className, "mt-bubble-content");
    assert.equal(content.textContent, "一二三四\n五六七八");
    // 气泡专用兜底：内层强制 100% 宽、居中、保留换行。
    assert.equal(content.style.width, "100%");
    assert.equal(content.style.textAlign, "center");
    assert.equal(content.style.whiteSpace, "pre-line");
    // OCR 推断的 left 只保留为调试数据，不再写入任何 text-align。
    assert.equal(node.dataset.alignment, "left");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("measure probe mirrors the inner text layer so fitting uses the same line layout", () => {
  const originalDocument = globalThis.document;
  globalThis.document = documentMock;
  try {
    const node = runtime.__test.createBubbleNode({
      x: 0,
      y: 0,
      w: 50,
      h: 20,
      original_text: "원문",
      translated_text: "一二三四五六七八",
      source_line_count: 2
    }, 0);
    const probe = runtime.__test.prepareBubbleMeasureProbe(node, 100, 40, "一二三四五六七八", 12);
    assert.equal(probe.children.length, 1);
    assert.equal(probe.children[0].className, "mt-bubble-content");
    assert.equal(probe.children[0].textContent, "一二三四五六七八");
    assert.equal(probe.classList.contains("mt-measure-probe"), true);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("no content module writes left/right text-align into overlay bubble text nodes", () => {
  assert.doesNotMatch(contentSource, /style\.textAlign\s*=\s*["'](left|right)["']/);
  assert.doesNotMatch(contentSource, /\.textAlign\s*=\s*["'](left|right)["']/);
  assert.doesNotMatch(contentSource, /alignSelf\s*[:=]/);
  assert.doesNotMatch(contentSource, /mt-align-(left|right)\s*\{/);
});
