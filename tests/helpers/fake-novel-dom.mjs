/**
 * 小说版式相关测试共用的一小块假 DOM（够 novel-renderer / novel-inline-format 跑通）。
 *
 * 不是 .test.mjs，所以不会被测试运行器当成测试文件（见 scripts/run-node-tests.mjs）。
 * 只实现渲染器实际用到的那点接口：childNodes / appendChild / insertBefore / remove /
 * textContent / className / dataset / querySelector(All) 的少数选择器。
 */
export class FakeNode {
  constructor(nodeType, tagName = "", value = "") {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.nodeValue = value;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.classList = { toggle() {}, contains: () => false };
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  detach(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
  }

  appendChild(child) {
    if (child.nodeType === 11) {
      [...child.childNodes].forEach(node => this.appendChild(node));
      return child;
    }
    if (child.parentNode) child.parentNode.detach(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.detach(child);
    if (child.nodeType === 11) return child;
    const index = this.childNodes.indexOf(reference);
    child.parentNode = this;
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

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() {
    return this.getAttribute("class") || "";
  }

  set className(value) {
    this.setAttribute("class", value);
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map(child => child.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [];
    const text = String(value ?? "");
    if (!text) return;
    const node = new FakeNode(3, "", text);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  getRootNode() {
    if (!this.root) this.root = new FakeNode(11);
    return this.root;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const wanted = selector.startsWith(":scope > ") ? selector.slice(9) : selector;
    const matches = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (wanted.startsWith("[data-p-id=")) {
          if (child.getAttribute("data-p-id") === wanted.slice(12, -2)) matches.push(child);
        } else if (wanted.startsWith("[data-mt-novel-translated")) {
          if (child.dataset.mtNovelTranslated === "true") matches.push(child);
        } else if (wanted.startsWith(".") && child.className.split(/\s+/u).includes(wanted.slice(1))) {
          matches.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return matches;
  }
}

export function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: tag => new FakeNode(1, String(tag).toUpperCase()),
    createTextNode: text => new FakeNode(3, "", String(text)),
    createDocumentFragment: () => new FakeNode(11),
    querySelectorAll: () => []
  };
  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
  }
}

export function element(tag, className = "") {
  const node = new FakeNode(1, tag);
  if (className) node.className = className;
  return node;
}

export function text(value) {
  return new FakeNode(3, "", value);
}

/** 蓝框里那种混排段落:正文 + 一段加粗强调 + 正文。 */
export function makeMixedParagraph() {
  const paragraph = element("P", "box_txt");
  paragraph.setAttribute("data-p-id", "20");
  const strong = element("STRONG");
  strong.setAttribute("data-p-id", "20");
  strong.appendChild(text("‘돌아가는 자’에 대한"));
  paragraph.appendChild(text("본 보고에는 "));
  paragraph.appendChild(strong);
  paragraph.appendChild(text(" 포함되어 있습니다."));
  return paragraph;
}

export function makeRuntime(state, extra = {}) {
  return {
    state: { displayMode: "translated" },
    getNovelState: () => state,
    findKakaoNovelSurface: () => state.surface || null,
    isNovelParagraphLeaf: node => /^(?:P|DIV|H[1-6])$/u.test(String(node?.tagName || "")),
    ...extra
  };
}

export function descendants(node, tagName) {
  const found = [];
  const walk = current => {
    for (const child of current.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.tagName === tagName) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}
