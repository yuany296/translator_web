import assert from "node:assert/strict";
import test from "node:test";
import { installNovelReader } from "../extension/src/content/modules/novel-reader.js";
import { installNovelRenderer } from "../extension/src/content/modules/novel-renderer.js";

// ---------- 最小假 DOM:够 novel-reader / novel-renderer 跑通 ----------

function textNode(value) {
  return {
    nodeType: 3,
    childNodes: [],
    parentElement: null,
    nodeValue: String(value),
    get textContent() { return this.nodeValue; },
    set textContent(next) { this.nodeValue = String(next); }
  };
}

function hasClass(node, name) {
  return String(node.className || "").split(/\s+/u).includes(name);
}

/** 深度优先收集「自身即匹配」的后代元素,顺序与浏览器 querySelectorAll 一致。 */
function collectMatches(nodes, predicate, found = []) {
  for (const node of nodes || []) {
    if (node?.nodeType !== 1) continue;
    if (predicate(node)) found.push(node);
    collectMatches(node.childNodes, predicate, found);
  }
  return found;
}

function matchSelector(nodes, selector) {
  const raw = String(selector || "");
  const exact = raw.match(/^\[data-p-id="(.*)"\]$/u);
  if (exact) {
    return collectMatches(nodes, node => node.getAttribute("data-p-id") === exact[1]);
  }
  if (raw === "[data-p-id]") return collectMatches(nodes, node => node.hasAttribute("data-p-id"));
  return [];
}

function createElement(tagName, attrs = {}) {
  const element = {
    tagName: String(tagName || "").toUpperCase(),
    nodeType: 1,
    childNodes: [],
    parentElement: null,
    hidden: false,
    style: {},
    dataset: {},
    className: "",
    classList: {
      toggle(name, force) {
        const names = String(this._owner.className || "").split(/\s+/u).filter(Boolean);
        const has = names.includes(name);
        const next = force === undefined ? !has : !!force;
        if (next && !has) names.push(name);
        if (!next && has) names.splice(names.indexOf(name), 1);
        this._owner.className = names.join(" ");
      }
    },
    _attrs: { ...attrs },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name);
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this._attrs[name];
    },
    appendChild(child) {
      if (child.parentElement) {
        const index = child.parentElement.childNodes.indexOf(child);
        if (index >= 0) child.parentElement.childNodes.splice(index, 1);
      }
      this.childNodes.push(child);
      child.parentElement = this;
      return child;
    },
    insertBefore(child, anchor) {
      if (child.parentElement) {
        const previous = child.parentElement.childNodes.indexOf(child);
        if (previous >= 0) child.parentElement.childNodes.splice(previous, 1);
      }
      const index = anchor ? this.childNodes.indexOf(anchor) : -1;
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
      child.parentElement = this;
      return child;
    },
    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.childNodes.indexOf(this);
      if (index >= 0) this.parentElement.childNodes.splice(index, 1);
      this.parentElement = null;
    },
    cloneNode(deep = false) {
      const clone = createElement(this.tagName, { ...this._attrs });
      clone.className = this.className;
      clone._owner = clone;
      if (deep) this.childNodes.forEach(child => clone.appendChild(child.cloneNode?.(true) || child));
      return clone;
    },
    get firstChild() {
      return this.childNodes[0] || null;
    },
    get textContent() {
      const own = this._ownText === undefined ? "" : String(this._ownText);
      return own + this.childNodes.map(child => child.textContent).join("");
    },
    set textContent(value) {
      this._ownText = String(value);
      this.childNodes.forEach(child => { child.parentElement = null; });
      this.childNodes = [];
    },
    querySelector(selector) {
      const wanted = String(selector || "").replace(":scope > ", "");
      if (!wanted.startsWith(".")) return null;
      return this.childNodes.find(child => child.nodeType === 1 && hasClass(child, wanted.slice(1))) || null;
    },
    querySelectorAll(selector) {
      return matchSelector(this.childNodes, selector);
    },
    getRootNode() {
      return this._root || { nodeType: 11, appendChild() {} };
    }
  };
  element._owner = element;
  element.classList._owner = element;
  return element;
}

function createSurface(topLevel) {
  const root = {
    nodeType: 11,
    appendChild() {},
    querySelectorAll(selector) {
      return matchSelector(topLevel, selector);
    },
    querySelector(selector) {
      return matchSelector(topLevel, selector)[0] || null;
    }
  };
  const bind = node => {
    if (node?.nodeType !== 1) return;
    node._root = root;
    node._owner = node;
    node.classList._owner = node;
    node.childNodes.forEach(bind);
  };
  topLevel.forEach(bind);
  return { root, content: root, topLevel };
}

/** KakaoPage 论坛/评论块的形态:容器与内层段落同号,且相隔两层。 */
function createNestedBox() {
  const box01 = createElement("div", { "data-p-id": "162" });
  box01.className = "box01";
  const box02 = createElement("div", { "data-p-id": "162" });
  box02.className = "box02";
  const title = createElement("p", { "data-p-id": "162" });
  title.className = "box_txt";
  const titleRun = createElement("span", { "data-p-id": "162" });
  titleRun.className = "txt_b";
  titleRun.appendChild(textNode("[뉴 르네즈 차민석 원래 미로 연생이었다는 거 트루?]"));
  title.appendChild(titleRun);
  const line2 = createElement("p", { "data-p-id": "162" });
  line2.className = "box_txt";
  line2.appendChild(textNode("- ㅇㅇ 미로 연생이었대"));
  const line3 = createElement("p", { "data-p-id": "162" });
  line3.className = "box_txt";
  line3.appendChild(textNode("- 미로 데뷔조 아니었을까?"));
  box02.appendChild(title);
  box02.appendChild(line2);
  box02.appendChild(line3);
  box01.appendChild(box02);
  return { box01, box02, title, titleRun, line2, line3 };
}

// ---------- 运行时接线 ----------

function installRuntime() {
  const runtime = { state: { displayMode: "translation" } };
  runtime.normalizeTranslationCacheText = value => String(value || "").replace(/\s+/gu, " ").trim();
  runtime.computeTranslationCacheHash = value => {
    let hash = 5381;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  runtime.getOriginalNovelParagraphText = node => {
    const source = node?.querySelector?.(":scope > .mt-novel-source");
    return String(source ? source.textContent : node?.textContent || "");
  };
  installNovelReader(runtime);
  installNovelRenderer(runtime);
  return runtime;
}

globalThis.location = { href: "https://page.kakao.com/content/69863606/viewer/69863607/" };
globalThis.document = {
  createElement: tagName => createElement(tagName),
  createTextNode: value => textNode(value),
  title: "작품 1화"
};

function extractChapter(runtime, surface) {
  runtime.novelCore = {
    parseKakaoNovelLocation: () => ({
      scopeKey: "series:1", seriesId: "series", chapterId: "c1", chapterTitle: "작품 1화"
    })
  };
  return runtime.extractKakaoNovelChapter(surface);
}

// ---------- 用例 ----------

test("带嵌套段落的容器不算段落:整块不再被当成一段送翻译", () => {
  const runtime = installRuntime();
  const box = createNestedBox();
  const blank = createElement("p", { "data-p-id": "7" });
  blank.className = "txt";
  blank.appendChild(createElement("br", { "data-p-id": "7" }));
  const surface = createSurface([box.box01, blank]);

  const chapter = extractChapter(runtime, surface);

  assert.deepEqual(chapter.paragraphs.map(item => item.pid), ["7", "162", "162", "162"],
    "只有内层 p.box_txt 是段落,box01/box02 必须被排除");
  assert.deepEqual(chapter.paragraphs.map(item => item.node),
    [blank, box.title, box.line2, box.line3]);
  assert.deepEqual(chapter.paragraphs.slice(1).map(item => item.original_text),
    ["[뉴 르네즈 차민석 원래 미로 연생이었다는 거 트루?]", "- ㅇㅇ 미로 연생이었대", "- 미로 데뷔조 아니었을까?"],
    "每段的原文只能是它自己那一行,不能是整块拼接文本");
  assert.ok(chapter.paragraphs.every(item => item.node !== box.box01 && item.node !== box.box02));
});

test("空行段落的 <br data-p-id> 不构成容器判据,段落不得被误删", () => {
  const runtime = installRuntime();
  const blank = createElement("p", { "data-p-id": "0" });
  blank.className = "txt";
  blank.appendChild(createElement("br", { "data-p-id": "0" }));
  const surface = createSurface([blank]);

  assert.equal(runtime.isNovelParagraphLeaf(blank), true,
    "<br> 是空元素,不能把宿主段落判成容器");
  const chapter = extractChapter(runtime, surface);
  assert.equal(chapter.paragraphs.length, 1);
  assert.equal(chapter.paragraphs[0].original_text, "");
});

test("序号解析与提取同口径:容器不占第 0 段,reapply 不会错位清译文", () => {
  const runtime = installRuntime();
  const box = createNestedBox();
  const surface = createSurface([box.box01]);

  assert.equal(runtime.findNovelParagraphNode(surface, "162"), box.title);
  assert.equal(runtime.findNovelParagraphNode(surface, "162#1"), box.line2);
  assert.equal(runtime.findNovelParagraphNode(surface, "162#2"), box.line3);
  assert.equal(runtime.findNovelParagraphNode(surface, "162#3"), null);
});

test("渲染内层段落不再吞掉容器:白底内框与兄弟段落结构保持原样", () => {
  const runtime = installRuntime();
  const box = createNestedBox();
  const surface = createSurface([box.box01]);
  const chapter = extractChapter(runtime, surface);
  const [title, line2] = chapter.paragraphs;

  assert.equal(runtime.renderNovelTranslation(title.node, "[New Renez 车敏锡 原本是Miro练习生这件事,是真的吗?]", true), true);

  assert.equal(box.box01.dataset.mtNovelTranslated, undefined, "容器不得被标记为已翻译");
  assert.equal(box.box01.querySelector(":scope > .mt-novel-source"), null,
    "容器不得被套上隐藏原文的包裹(否则内层盒子会一起消失)");
  assert.equal(box.box01.querySelector(":scope > .mt-novel-translation"), null);
  assert.equal(box.box02.parentElement, box.box01, "内层盒子必须留在原位");
  assert.equal(box.title.parentElement, box.box02);
  assert.equal(line2.node.dataset.mtNovelTranslated, undefined, "未翻译的兄弟段落不得被动到");
  assert.equal(box.title.querySelector(":scope > .mt-novel-translation").textContent,
    "[New Renez 车敏锡 原本是Miro练习生这件事,是真的吗?]");
});

test("整段只有一个行内包裹时译文沿用该包裹(标题行加粗得以保留)", () => {
  const runtime = installRuntime();
  const box = createNestedBox();
  const surface = createSurface([box.box01]);
  const [title] = extractChapter(runtime, surface).paragraphs;

  runtime.renderNovelTranslation(title.node, "标题行译文", true);
  const translation = title.node.querySelector(":scope > .mt-novel-translation");
  const mirror = translation.childNodes[0];
  assert.equal(mirror.tagName, "SPAN");
  assert.equal(mirror.className, "txt_b", "译文必须沿用原文的行内 class 才能保持加粗");
  assert.equal(mirror.textContent, "标题行译文");
  assert.equal(mirror.getAttribute("data-p-id"), null, "镜像壳不能再是 data-p-id 候选");

  // 重复渲染(侧栏改译/reapply)不得层层叠加镜像
  runtime.renderNovelTranslation(title.node, "改后的译文", true);
  assert.equal(translation.childNodes.length, 1);
  assert.equal(translation.textContent, "改后的译文");
});

test("混排行内格式的段落按片段占比复刻行内样式", () => {
  const runtime = installRuntime();
  const node = createElement("p", { "data-p-id": "9" });
  node.className = "txt";
  node.appendChild(textNode("앞 "));
  const emphasis = createElement("em");
  emphasis.appendChild(textNode("강조"));
  node.appendChild(emphasis);
  node.appendChild(textNode(" 뒤"));
  const surface = createSurface([node]);

  runtime.renderNovelTranslation(node, "混合格式译文", true);
  const translation = node.querySelector(":scope > .mt-novel-translation");
  // 原文三段等长 ⇒ 译文按同样比例切开:普通 / 强调 / 普通
  assert.equal(translation.textContent, "混合格式译文", "镜像不能丢字多字");
  assert.equal(translation.childNodes.length, 3);
  assert.equal(translation.childNodes[0].nodeType, 3);
  assert.equal(translation.childNodes[1].tagName, "EM", "原文的强调段要复刻到译文上");
  assert.equal(translation.childNodes[1].textContent, "格式");
  assert.equal(translation.childNodes[1].getAttribute("data-p-id"), null,
    "镜像壳不能带 data-p-id,否则会被当成段落");
  assert.equal(translation.childNodes[2].nodeType, 3);
  assert.equal(surface.root.querySelectorAll("[data-p-id]").length, 1);
});
