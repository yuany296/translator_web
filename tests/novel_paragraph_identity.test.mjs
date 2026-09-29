import assert from "node:assert/strict";
import test from "node:test";
import { installNovelReader } from "../extension/src/content/modules/novel-reader.js";
import { installNovelRenderer } from "../extension/src/content/modules/novel-renderer.js";

// ---------- 最小假 DOM:够 novel-reader / novel-renderer 跑通 ----------

function textNode(value) {
  return { nodeType: 3, childNodes: [], parentElement: null, textContent: String(value) };
}

function hasClass(node, name) {
  return String(node.className || "").split(/\s+/u).includes(name);
}

function createElement(tagName, attrs = {}) {
  return {
    tagName: String(tagName || "").toUpperCase(),
    nodeType: 1,
    childNodes: [],
    parentElement: null,
    style: {},
    dataset: {},
    className: "",
    classList: { toggle() {}, add() {}, remove() {} },
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
    get firstChild() {
      return this.childNodes[0] || null;
    },
    get textContent() {
      const own = this._ownText === undefined ? "" : String(this._ownText);
      return own + this.childNodes.map(child => child.textContent).join("");
    },
    set textContent(value) {
      this._ownText = String(value);
      this.childNodes.forEach(child => {
        child.parentElement = null;
      });
      this.childNodes = [];
    },
    querySelector(selector) {
      const wanted = String(selector || "").replace(":scope > ", "");
      if (!wanted.startsWith(".")) return null;
      return this.childNodes.find(child => hasClass(child, wanted.slice(1))) || null;
    },
    querySelectorAll() {
      return [];
    },
    getRootNode() {
      return this._root || { nodeType: 11, appendChild() {} };
    }
  };
}

/** 造一个段落节点:<p data-p-id="N">原文</p> */
function createParagraph(pid, text) {
  const node = createElement("p", { "data-p-id": String(pid) });
  node.appendChild(textNode(text));
  return node;
}

/** 造一屏(单个 EPUB 文档)的影子根。 */
function createSurface(paragraphs) {
  const root = {
    nodeType: 11,
    appendChild() {},
    querySelectorAll(selector) {
      const raw = String(selector || "");
      const exact = raw.match(/^\[data-p-id="(.*)"\]$/u);
      if (exact) {
        return paragraphs.filter(node => node.getAttribute("data-p-id") === exact[1]);
      }
      if (raw === "[data-p-id]") return paragraphs.slice();
      return [];
    }
  };
  paragraphs.forEach(node => {
    node._root = root;
  });
  return { root, content: root, paragraphs };
}

// ---------- 运行时接线 ----------

function installRuntime() {
  const runtime = { state: {} };
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

function withFakeDocument(run) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => createElement(tagName), title: previousDocument.title };
  try {
    return run();
  } finally {
    globalThis.document = previousDocument;
  }
}

// novel-reader 走真实的 location / document.title 取章节信息
globalThis.location = { href: "https://page.kakao.com/content/69863606/viewer/69863607/" };
globalThis.document = { createElement: tagName => createElement(tagName), title: "작품 1화" };

function extractChapter(runtime, surface, chapterId) {
  runtime.novelCore = {
    parseKakaoNovelLocation: () => ({
      scopeKey: "series:1", seriesId: "series", chapterId, chapterTitle: "작품 1화"
    })
  };
  return runtime.extractNovelChapter(surface);
}

const PAGE_A_TEXT = [
  "내가 죽인 최애와 데뷔합니다 (연재)",
  "본문 첫 번째 문장입니다.",
  "본문 두 번째 문장입니다."
];

// 版权页:data-p-id 与第一屏完全相同,但内容毫无关系
const CREDIT_TEXT = [
  "지은이 │ 유쓰",
  "마케팅 │ 한재혁",
  "ⓒ유쓰2026"
];

function buildPages() {
  return {
    pageA: createSurface(PAGE_A_TEXT.map((text, index) => createParagraph(index, text))),
    pageB: createSurface(CREDIT_TEXT.map((text, index) => createParagraph(index, text)))
  };
}

// ---------- 用例 ----------

test("段落 id 把源文哈希并入身份,翻页后同号段落不会再撞号", () => {
  const runtime = installRuntime();
  const { pageA, pageB } = buildPages();
  const chapterA = extractChapter(runtime, pageA, "c1");
  const chapterB = extractChapter(runtime, pageB, "c1");

  assert.equal(chapterA.paragraphs.length, 3);
  assert.equal(chapterB.paragraphs.length, 3);
  chapterA.paragraphs.forEach((item, index) => {
    assert.match(item.id, /@[0-9a-f]{8}$/u, "段落 id 必须携带源文哈希");
    assert.notEqual(item.id, chapterB.paragraphs[index].id,
      "同一 data-p-id 在不同屏上必须解析成不同段落身份");
  });
  // 原始 data-p-id 仍保留在 domAnchor 里,定位与恢复逻辑不受影响
  assert.deepEqual(chapterB.paragraphs.map(item => item.domAnchor), ["0", "1", "2"]);
});

test("重刷译文时源文对不上的段落必须拒收,版权页不得被写上开头的句子", () => {
  withFakeDocument(() => {
    const runtime = installRuntime();
    const { pageA, pageB } = buildPages();
    const chapterA = extractChapter(runtime, pageA, "c1");

    // A 屏翻译完成:state.translations 的键来自 A 屏(带 A 屏源文哈希)
    const state = runtime.getNovelState();
    state.translations.set(chapterA.paragraphs[0].id, "第一话");
    state.translations.set(chapterA.paragraphs[1].id, "第一个正文句子的译文");
    state.showTranslation = true;
    runtime.state.displayMode = "translation";

    // 翻到 B 屏(版权页),B 屏的 data-p-id 与 A 屏相同
    const before = pageB.paragraphs.map(node => node.textContent);
    runtime.reapplyNovelTranslations(pageB);

    assert.deepEqual(pageB.paragraphs.map(node => node.textContent), before,
      "版权页不得被写上作品开头的句子");
    pageB.paragraphs.forEach(node => {
      assert.equal(node.dataset.mtNovelTranslated, undefined, "错配段落不应被标记为已翻译");
      assert.equal(node.querySelector(":scope > .mt-novel-translation"), null,
        "错配段落不得留下译文节点");
    });

    // 翻回 A 屏,译文应正常出现
    runtime.reapplyNovelTranslations(pageA);
    assert.equal(pageA.paragraphs[0].querySelector(":scope > .mt-novel-translation").textContent, "第一话");
    assert.equal(pageA.paragraphs[1].querySelector(":scope > .mt-novel-translation").textContent,
      "第一个正文句子的译文");
  });
});

test("已画上的错配译文会被清掉,原文完整还原", () => {
  withFakeDocument(() => {
    const runtime = installRuntime();
    const { pageB } = buildPages();
    const node = pageB.paragraphs[0];
    // 模拟旧版本留下的残影:版权段落上挂着作品开头的译文
    runtime.renderNovelTranslation(node, "第一话", true);
    assert.equal(node.querySelector(":scope > .mt-novel-translation").textContent, "第一话");

    const state = runtime.getNovelState();
    state.translations.set("0@deadbeef", "第一话");
    state.showTranslation = true;
    runtime.state.displayMode = "translation";
    runtime.reapplyNovelTranslations(pageB);

    assert.equal(node.querySelector(":scope > .mt-novel-translation"), null,
      "源文对不上的译文必须被移除");
    assert.equal(node.textContent, "지은이 │ 유쓰", "原文必须完整还原");
  });
});

test("splitNovelParagraphId 兼容旧格式且能取回源文哈希", () => {
  const runtime = installRuntime();
  assert.deepEqual(runtime.splitNovelParagraphId("52"), { pid: "52", ordinal: 0, sourceHash: "" });
  assert.deepEqual(runtime.splitNovelParagraphId("52#3"), { pid: "52", ordinal: 3, sourceHash: "" });
  assert.deepEqual(runtime.splitNovelParagraphId("52#3@ab12cd34"),
    { pid: "52", ordinal: 3, sourceHash: "ab12cd34" });
});
