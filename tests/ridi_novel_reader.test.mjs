import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installNovelReader } from "../extension/src/content/modules/novel-reader.js";
import { installNovelRenderer } from "../extension/src/content/modules/novel-renderer.js";
import { installReaderState } from "../extension/src/content/modules/reader-state.js";
import novelCore from "../extension/src/shared/novel.js";
import {
  isKakaoReaderHost, isNovelReaderHost, isRidiReaderHost
} from "../extension/src/shared/novel-hosts.js";
import { resolveSiteHint } from "../extension/src/readers/site-hints.js";

const root = path.resolve(import.meta.dirname, "..");

/**
 * RIDI 小说适配器（novel-ridi-reader.js）的行为契约。
 *
 * 页面形状取自真机取证（ridibooks.com/books/{话id}/view）：
 *   #viewer_contents > div > div._container_* > div.css-*[._isScrollMode_*] > div.css-* > h2/p…
 * 段落自身**没有任何标识**，身份由适配器盖章，所以这里的假 DOM 只需要支撑
 * 「按标签收集 + 按属性盖章 + 按属性回查」这三件事。
 */

// ---------- 最小假 DOM ----------

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.parentNode = null;
  }

  get textContent() {
    return this.nodeValue;
  }
}

class FakeElement {
  constructor(tag, { id = "", text = "" } = {}) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.isConnected = true;
    this.parentElement = null;
    this.textContent = text;
    this.classList = {
      toggle() {},
      add() {},
      remove() {},
      contains: () => false
    };
  }

  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  set textContent(value) {
    this.childNodes = [];
    const text = String(value ?? "");
    if (!text) return;
    const node = new FakeText(text);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  get textContent() {
    return this.childNodes.map(child => child.textContent).join("");
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.detach(child);
    child.parentNode = this;
    if (child.nodeType === 1) child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  detach(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.detach(child);
    const index = this.childNodes.indexOf(reference);
    child.parentNode = this;
    if (child.nodeType === 1) child.parentElement = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.detach(this);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  getRootNode() {
    if (!this.root) this.root = new FakeElement("div");
    return this.root;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 };
  }

  /** 只支持本测试用到的几种形状：`#id`、`tag`、`[attr]`、`[attr="v"]`、`tag[attr*="v"]`。 */
  matchesSimple(selector) {
    let rest = String(selector).trim();
    if (rest.startsWith(".")) {
      return String(this.className || "").split(/\s+/u).includes(rest.slice(1));
    }
    if (rest.startsWith("#")) {
      const [id, ...tail] = rest.slice(1).split("[");
      if (this.id !== id) return false;
      rest = tail.length ? `[${tail.join("[")}` : "";
      if (!rest) return true;
    } else if (rest.startsWith("[")) {
      // 只有属性条件
    } else {
      const index = rest.indexOf("[");
      const tag = index < 0 ? rest : rest.slice(0, index);
      if (this.tagName !== tag.toUpperCase()) return false;
      rest = index < 0 ? "" : rest.slice(index);
      if (!rest) return true;
    }
    const body = rest.slice(1, -1);
    const match = body.match(/^([\w-]+)(?:(\*?=)"?([^"]*)"?)?$/u);
    if (!match) return false;
    const [, name, operator, value] = match;
    if (!this.attributes.has(name)) return false;
    if (!operator) return true;
    const actual = String(this.getAttribute(name) || "");
    return operator === "*=" ? actual.includes(value) : actual === value;
  }

  querySelectorAll(selector) {
    const list = selector.split(",").map(part => part.trim());
    const found = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (list.some(one => child.matchesSimple(one))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    if (selector.startsWith(":scope > ")) {
      const one = selector.slice(9);
      return this.childNodes.find(node => node.nodeType === 1 && node.matchesSimple(one)) || null;
    }
    return this.querySelectorAll(selector)[0] || null;
  }
}

// ---------- 页面装配 ----------

function buildRidiPage({ paragraphs = [], seriesId = "8480770", title = "미궁이 된 회사에서 죽어 나가는 법", ogTitle = "미궁이 된 회사에서 죽어 나가는 법 가정의 달 문답표" } = {}) {
  const viewer = new FakeElement("div", { id: "viewer" });
  // 作品标题链接：作品级 id 只能从这里读出来（URL 里只有这一话的 id）
  const seriesLink = new FakeElement("a", { text: title });
  seriesLink.setAttribute("href", `https://ridibooks.com/library/books/${seriesId}/`);
  viewer.appendChild(seriesLink);
  const contents = new FakeElement("div", { id: "viewer_contents" });
  const outer = new FakeElement("div");
  const container = new FakeElement("div");
  const scroll = new FakeElement("div");
  const body = new FakeElement("div");
  // 真实页面上正文里还夹着 RIDI 的零宽水印
  const marks = "\u2060\u2063\u2060";
  paragraphs.forEach(({ tag = "P", text = "" }) => {
    const node = new FakeElement(tag, { text: text ? `${marks}${text}` : "" });
    body.appendChild(node);
  });
  scroll.appendChild(body);
  container.appendChild(scroll);
  outer.appendChild(container);
  contents.appendChild(outer);
  viewer.appendChild(contents);
  const meta = new FakeElement("meta");
  meta.setAttribute("property", "og:title");
  meta.setAttribute("content", ogTitle);
  viewer.appendChild(meta);
  return { viewer, contents, container: body, body };
}

function withFakeDocument(page, run) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousObserver = globalThis.MutationObserver;
  const elements = page ? [page.viewer] : [];
  const search = node => {
    const found = [];
    const walk = list => list.forEach(item => {
      if (item.nodeType !== 1) return;
      found.push(item);
      walk(item.childNodes);
    });
    walk([node]);
    return found;
  };
  const all = () => elements.flatMap(search);
  globalThis.document = {
    title: "미궁이 된 회사에서 죽어 나가는 법 가정의 달 문답표 - 리디",
    createElement: tag => new FakeElement(String(tag).toLowerCase()),
    querySelector: selector => {
      const text = String(selector);
      if (text.startsWith("#") && text.includes(" ")) {
        const [rootSelector, ...rest] = text.split(" ");
        const root = all().find(node => node.matchesSimple(rootSelector)) || null;
        return root ? root.querySelector(rest.join(" ")) : null;
      }
      return all().find(node => node.matchesSimple(text)) || null;
    },
    querySelectorAll: selector => elements.flatMap(node => node.querySelectorAll(selector))
  };
  globalThis.MutationObserver = class {
    observe() {}

    disconnect() {}
  };
  globalThis.location = { href: "https://ridibooks.com/books/6224000125/view?referrer=x", hostname: "ridibooks.com" };
  try {
    return run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.MutationObserver = previousObserver;
  }
}

function makeRuntime(overrides = {}) {
  const runtime = {
    state: { invalidated: false, displayMode: "translated" },
    IS_RIDI_READER: true,
    updateFloatingBallState: () => {},
    normalizeTranslationCacheText: text => String(text || "").normalize("NFC").replace(/\s+/gu, " ").trim(),
    computeTranslationCacheHash: text => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < String(text).length; index += 1) {
        hash ^= String(text).charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    },
    getNovelImageResultKey: (target, index) => `img-${index}`,
    isMangaTranslatorOverlayTarget: () => false,
    novelCore,
    ...overrides
  };
  installNovelReader(runtime);
  installNovelRenderer(runtime);
  return runtime;
}

const SAMPLE = [
  { tag: "H2", text: "가정의 달 문답표" },
  { tag: "P", text: "" },
  { tag: "P", text: "1. 어린 시절 가장 큰 사고를 친 적이 있나요?" },
  { tag: "P", text: "“초등학교 1학년 때 집에 안 들어갔습니다.”" }
];

// ---------- 用例 ----------

test("parseRidiNovelLocation：话 id 作章节身份、作品 id 作作用域", () => {
  const location = novelCore.parseRidiNovelLocation(
    "https://ridibooks.com/books/6224000125/view?referrer=https%3A%2F%2Fridibooks.com%2Flibrary%2Fbooks%2F8480770%2F",
    "미궁이 된 회사에서 죽어 나가는 법 가정의 달 문답표 - 리디",
    "8480770"
  );
  assert.equal(location.chapterId, "6224000125");
  assert.equal(location.seriesId, "8480770");
  assert.equal(location.scopeKey, "ridi:8480770");
  assert.equal(location.chapterTitle, "미궁이 된 회사에서 죽어 나가는 법 가정의 달 문답표");
});

test("parseRidiNovelLocation：读不到作品 id 时退回话 id，非阅读页返回 null", () => {
  const fallback = novelCore.parseRidiNovelLocation("https://ridibooks.com/books/6305000008/view", "제목");
  assert.equal(fallback.seriesId, "6305000008");
  assert.equal(fallback.scopeKey, "ridi:6305000008");
  assert.equal(novelCore.parseRidiNovelLocation("https://ridibooks.com/books/6305000008", "제목"), null);
  assert.equal(novelCore.parseRidiNovelLocation("https://ridibooks.com/library/books/1/", "제목"), null);
});

test("findNovelSurface：RIDI 漫画页（有 #viewer、没有 #viewer_contents）不认成小说", () => {
  const comic = new FakeElement("div", { id: "viewer" });
  withFakeDocument({ viewer: comic, contents: null }, () => {
    const runtime = makeRuntime();
    assert.equal(runtime.findKakaoNovelSurface(), null);
    assert.equal(runtime.findNovelSurface(), null);
  });
});

test("findNovelSurface：段落不足两段不认，够两段就盖章锚点", () => {
  const single = buildRidiPage({ paragraphs: [{ text: "한 문장만." }] });
  withFakeDocument(single, () => {
    const runtime = makeRuntime();
    assert.equal(runtime.findNovelSurface(), null);
  });
  const page = buildRidiPage({ paragraphs: SAMPLE });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const surface = runtime.findNovelSurface();
    assert.ok(surface, "应当识别出 RIDI 小说正文");
    assert.equal(surface.kind, "ridi");
    assert.equal(surface.anchorAttribute, "data-mt-novel-pid");
    assert.equal(surface.paragraphs.length, 3, "空段落不计入");
    // 锚点写在段落节点上，值是内容哈希（不是序号）
    assert.match(surface.paragraphs[0].getAttribute("data-mt-novel-pid"), /^c[0-9a-f]{8}$/u);
    assert.equal(surface.seriesId, "8480770");
    assert.equal(surface.seriesTitle, "미궁이 된 회사에서 죽어 나가는 법");
    assert.equal(surface.chapterTitle, "미궁이 된 회사에서 죽어 나가는 법 가정의 달 문답표");
  });
});

test("findNovelSurface：同一份正文被渲染两遍时只取块数最多的那一条分支", () => {
  const page = buildRidiPage({ paragraphs: SAMPLE });
  const duplicate = new FakeElement("div");
  const duplicateBody = new FakeElement("div");
  duplicateBody.appendChild(new FakeElement("p", { text: "복제본 한 문장." }));
  duplicate.appendChild(duplicateBody);
  page.contents.appendChild(duplicate);
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const surface = runtime.findNovelSurface();
    assert.equal(surface.paragraphs.length, 3, "不该把副本段落或空段落一起抽进来");
    assert.equal(surface.container, page.container);
  });
});

test("extractNovelChapter：段落身份按内容寻址、标题与正文分型、水印被清掉", () => {
  const page = buildRidiPage({ paragraphs: SAMPLE });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const chapter = runtime.extractNovelChapter();
    assert.equal(chapter.seriesId, "8480770");
    assert.equal(chapter.chapterId, "6224000125");
    assert.equal(chapter.scopeKey, "ridi:8480770");
    assert.equal(chapter.paragraphs.length, 3);
    assert.equal(chapter.paragraphs[0].kind, "title");
    assert.equal(chapter.paragraphs[1].kind, "paragraph");
    // 零宽水印（U+2060/U+2063）不得进入提示词与缓存
    assert.equal(chapter.paragraphs[0].original_text, "가정의 달 문답표");
    assert.doesNotMatch(chapter.paragraphs[2].original_text, /[\u2060\u2063]/u);
    chapter.paragraphs.forEach(item => {
      assert.match(item.id, /^c[0-9a-f]{8}@[0-9a-f]{8}$/u, "标记段落 id 必须是内容寻址的");
      assert.equal(item.domAnchor, item.pid);
    });
  });
});

test("extractNovelChapter：内容相同的两段靠 #序号 区分，重新抽取结果一致", () => {
  const repeated = "같은 문장입니다.";
  const page = buildRidiPage({ paragraphs: [{ text: repeated }, { text: repeated }, { text: "다른 문장." }] });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const first = runtime.extractNovelChapter();
    const second = runtime.extractNovelChapter();
    assert.equal(first.paragraphs[0].id, second.paragraphs[0].id, "重复抽取必须得到同一身份");
    assert.notEqual(first.paragraphs[0].id, first.paragraphs[1].id);
    assert.match(first.paragraphs[1].id, /#1@/u, "第二段同文要用出现序号区分");
    assert.equal(first.paragraphs[0].pid, first.paragraphs[1].pid);
    assert.notEqual(first.paragraphs[0].paragraphKey, first.paragraphs[1].paragraphKey);
  });
});

test("extractNovelChapter：段间空行（<p><br></p>）不算段落，但章节内容一段不漏", () => {
  const page = buildRidiPage({ paragraphs: [
    { text: "첫 문장입니다." }, { text: "" }, { text: "" }, { text: "둘째 문장입니다." }
  ] });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const chapter = runtime.extractNovelChapter();
    assert.equal(chapter.paragraphs.length, 2, "空段落不能计入章节段落数（否则缓存覆盖率永远到不了完整）");
    assert.deepEqual(chapter.paragraphs.map(item => item.original_text), ["첫 문장입니다.", "둘째 문장입니다."]);
    // 空段落也不盖章：它们不参与签名、进度与回填
    assert.equal(page.body.children[1].hasAttribute("data-mt-novel-pid"), false);
    assert.equal(page.body.children[3].hasAttribute("data-mt-novel-pid"), true);
  });
});

test("渲染回填：findNovelParagraphNode 能按盖章锚点找回段落并贴上译文", () => {
  const page = buildRidiPage({ paragraphs: SAMPLE });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const surface = runtime.findNovelSurface();
    const chapter = runtime.extractNovelChapter(surface);
    const target = chapter.paragraphs[2];
    assert.equal(runtime.findNovelParagraphNode(surface, target.id), target.node);

    runtime.renderNovelTranslation(target.node, "1. 小时候闯过的最大祸是什么？", true, target.id);
    const translation = target.node.querySelector(":scope > .mt-novel-translation");
    assert.equal(translation.textContent, "1. 小时候闯过的最大祸是什么？");
    assert.equal(target.node.querySelector(":scope > .mt-novel-source").hidden, true, "显示译文时原文要收起");
    // 原文仍能从包裹里取回（抽取与回填共用同一出口）
    assert.equal(runtime.getOriginalNovelParagraphText(target.node), target.original_text);
  });
});

test("渲染回填：同样的内容重贴两次不重写 DOM（否则 reconcile 会自我激发）", () => {
  const page = buildRidiPage({ paragraphs: SAMPLE });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const surface = runtime.findNovelSurface();
    const chapter = runtime.extractNovelChapter(surface);
    const target = chapter.paragraphs[2];
    runtime.renderNovelTranslation(target.node, "译文", true, target.id);
    const translation = target.node.querySelector(":scope > .mt-novel-translation");
    const before = translation.childNodes.length;
    runtime.renderNovelTranslation(target.node, "译文", true, target.id);
    assert.equal(translation.childNodes.length, before, "同内容重贴不该清空再写");
    // 内容变了就必须重写
    runtime.renderNovelTranslation(target.node, "改过的译文", true, target.id);
    assert.equal(translation.textContent, "改过的译文");
  });
});

test("reconcile：写入 state.surface 并记录翻页签名；换话时清空导航状态", () => {
  const page = buildRidiPage({ paragraphs: SAMPLE });
  withFakeDocument(page, () => {
    const runtime = makeRuntime();
    const state = runtime.getNovelState();
    const surface = runtime.reconcileNovelReader();
    assert.equal(state.surface, surface);
    assert.ok(state.surfaceSignature.includes("\u0001"), "签名必须由「锚点值 + 源文哈希」组成");

    state.chapterKey = "ridi:8480770:6224000125";
    state.translations.set("c0000000@c0000000", "旧话译文");
    globalThis.location.href = "https://ridibooks.com/books/6224000999/view";
    runtime.reconcileNovelReader();
    assert.equal(state.translations.size, 0, "换话必须清空上一话的译文与任务状态");
    assert.equal(state.chapterKey, "");
  });
});

test("同一家站点只有一个域名判据：分片长条提示与小说判据共用 RIDI 正则", () => {
  const siteHints = fs.readFileSync(
    path.join(root, "extension", "src", "readers", "site-hints.js"), "utf8"
  );
  assert.match(siteHints, /import \{ RIDI_HOST_RE \} from "\.\.\/shared\/novel-hosts\.js"/u,
    "site-hints 必须复用 shared/novel-hosts.js 的正则，不能再写一份 ridibooks.com");
  assert.doesNotMatch(siteHints, /ridibooks\\\.com/u);
  assert.equal(isRidiReaderHost("ridibooks.com"), true);
  assert.equal(isRidiReaderHost("www.ridibooks.com"), true);
  assert.equal(isRidiReaderHost("ridibooks.com.evil.test"), false);
  assert.equal(isKakaoReaderHost("page.kakao.com"), true);
  assert.equal(isKakaoReaderHost("page.kakaocdn.net"), true);
  assert.equal(isNovelReaderHost("ridibooks.com"), true);
  assert.equal(isNovelReaderHost("page.kakao.com"), true);
  assert.equal(isNovelReaderHost("example.com"), false);
  assert.equal(resolveSiteHint({ hostname: "ridibooks.com" }).tiledStrip, true,
    "RIDI 漫画侧的分片长条能力不能被小说接入改掉");
});

test("reader-state：RIDI 页面上同时立起「小说站」与「RIDI 站」两个标志", () => {
  const previousLocation = globalThis.location;
  globalThis.location = { hostname: "ridibooks.com", pathname: "/books/6224000125/view" };
  try {
    const runtime = {
      KP: { KAKAO_OVERLAP_SAMPLE_WIDTH: 1, KAKAO_THIN_STRIP_MIN_HEIGHT: 1 },
      IS_STRIP_TILE_READER: true
    };
    installReaderState(runtime);
    assert.equal(runtime.IS_RIDI_READER, true);
    assert.equal(runtime.IS_NOVEL_READER, true);
    assert.equal(runtime.IS_KAKAOPAGE_READER, false);
  } finally {
    globalThis.location = previousLocation;
  }
});
