import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// 小说记忆「按话编辑」（用户拍板方案 A）：记忆页按章节序列出快照，默认选中你正在读的那一话，
// 保存只写回选中的那一话——回顾前面时不会再把后面的记忆牵连进来。
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "extension", "glossary.js"), "utf8");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.className = "";
    this.value = "";
    this.textContent = "";
    this.checked = false;
    this.disabled = false;
    this.required = false;
    this.type = "";
    this.files = null;
    this.selected = false;
    this.open = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parent || null;
    }
    return null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  click() {}
  async dispatch(type, extra = {}) {
    const event = {
      target: this,
      preventDefault() {},
      stopPropagation() { event.propagationStopped = true; },
      ...extra
    };
    let node = event.target;
    while (node && !event.propagationStopped) {
      for (const handler of node.listeners.get(type) || []) await handler(event);
      node = node.parent || null;
    }
  }
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function matches(node, selector) {
  const compound = /^([a-zA-Z]+)?((?:\.[\w-]+|\[[^\]]+\])*)$/u.exec(selector);
  if (!compound) return false;
  const [, tag, rest] = compound;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/gu) || [];
  return parts.every(part => part.startsWith(".")
    ? node.classList.contains(part.slice(1)) || String(node.className || "").split(/\s+/u).includes(part.slice(1))
    : attributeMatches(node, part));
}

function attributeMatches(node, part) {
  const parsed = /^\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/u.exec(part);
  if (!parsed) return false;
  const key = parsed[1].replace(/^data-/u, "").replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
  const value = node.dataset[key];
  return parsed[2] === undefined ? value !== undefined : value === parsed[2];
}

function attachParent(node) {
  for (const child of node.children) {
    child.parent = node;
    attachParent(child);
  }
}

async function settle(ticks = 8) {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** 一个作品、三话快照：第 3 话 / 第 8 话 / 一话话号没认出来（序号 null，最后写入）。 */
function memoryStore() {
  return {
    version: 1,
    updatedAt: 1000,
    books: [{
      key: "kakao:111",
      seriesId: "111",
      title: "骸骨皇女",
      revision: 7,
      updatedAt: 900,
      checkpoints: [
        { chapterId: "c3", chapterTitle: "第3话 试炼", chapterOrder: 3, revision: 2, updatedAt: 300, memory: { summary: "第三章累积", characters: ["甲"] }, delta: { summary: "第三章新增", characters: ["甲", "乙"], honorifics: [{ source: "님", target: "大人" }] } },
        { chapterId: "c8", chapterTitle: "第8话 归来", chapterOrder: 8, revision: 1, updatedAt: 800, memory: { summary: "第八章累积" } },
        { chapterId: "cX", chapterTitle: "特别篇", chapterOrder: null, revision: 1, updatedAt: 900, memory: { summary: "话号没认出来" } }
      ]
    }]
  };
}

function createPage({ tabs = [], respond } = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const messages = [];
  // 记忆数据是在脚本安装（不是 DOMContentLoaded）时就请求的，所以初始桩必须在 createPage 前就位。
  let messageHandler = respond || (() => ({ ok: true }));
  const document = {
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement("div");
        element.id = id;
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: value => `chrome-extension://test/${value}`,
      sendMessage: (message, callback) => {
        messages.push(message);
        callback(messageHandler(message));
      }
    },
    tabs: {
      query: async () => tabs
    },
    storage: {
      local: {
        get: (keys, callback) => callback(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, undefined]))),
        set: (value, callback) => { if (callback) callback(); }
      },
      onChanged: { addListener() {} }
    }
  };
  const context = vm.createContext({
    chrome,
    document,
    window: { confirm: () => true },
    confirm: () => true,
    console,
    fetch: async () => { throw new Error("offline"); },
    URL,
    URLSearchParams,
    Blob,
    FormData,
    AbortController,
    crypto: globalThis.crypto,
    localStorage: { store: new Map(), getItem() { return null; }, setItem() {} },
    location: { search: "?embedded=1&view=memory", href: "chrome-extension://test/glossary.html?embedded=1&view=memory", replace() {} },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: "glossary.js" });
  return {
    elements,
    messages,
    setMessageHandler(handler) { messageHandler = handler; },
    async boot() {
      for (const handler of documentListeners.get("DOMContentLoaded") || []) {
        await handler({ target: document });
      }
      await settle(12);
    },
    optionLabels(id) {
      return elements.get(id).children.map(option => option.textContent);
    },
    status() { return elements.get("memoryStatusText").textContent; }
  };
}

async function bootedPage(options = {}) {
  const respond = message => message.type === "GET_NOVEL_MEMORY"
    ? { ok: true, store: memoryStore() }
    : { ok: true };
  const page = createPage({ ...options, respond });
  page.setMessageHandler(respond);
  await page.boot();
  return page;
}

const OPEN_CHAPTER_8 = [{ url: "https://page.kakao.com/content/111/viewer/c8", active: true }];

test("记忆页按话列出快照，默认选中你正在读的那一话", async () => {
  const page = await bootedPage({ tabs: OPEN_CHAPTER_8 });
  const labels = page.optionLabels("memoryChapterSelect");
  assert.equal(labels.length, 3, "每一话一条快照");
  assert.match(labels[0], /第 3 话/u);
  assert.match(labels[0], /修订 2/u);
  assert.match(labels[2], /话号未识别/u, "序号没认出来的要写清楚");
  assert.equal(page.elements.get("memoryChapterSelect").value, "c8", "默认对齐正在读的第 8 话");
  assert.match(page.elements.get("memoryJsonInput").value, /第八章累积/u);
  assert.match(page.elements.get("memoryMetaText").textContent, /第 8 话/u);
});

test("浏览器里没开着这本书时，默认退回序号最大的那一话（不是话号未识别那条）", async () => {
  const page = await bootedPage({ tabs: [] });
  assert.equal(page.elements.get("memoryChapterSelect").value, "c8");
  const other = await bootedPage({ tabs: [{ url: "https://page.kakao.com/content/999/viewer/c1", active: true }] });
  assert.equal(other.elements.get("memoryChapterSelect").value, "c8", "别的作品的话号不能套过来");
});

test("换一话就换编辑对象；保存只写回选中的那一话", async () => {
  const page = await bootedPage({ tabs: OPEN_CHAPTER_8 });
  const select = page.elements.get("memoryChapterSelect");
  select.value = "c3";
  await select.dispatch("change");
  assert.match(page.elements.get("memoryJsonInput").value, /第三章累积/u, "切到第 3 话要换成它的快照");

  const edited = JSON.parse(page.elements.get("memoryJsonInput").value);
  edited.summary = "第 3 话手动补的人名";
  page.elements.get("memoryJsonInput").value = JSON.stringify(edited);
  await page.elements.get("memorySaveBtn").dispatch("click");
  await settle();

  const saved = page.messages.filter(message => message.type === "SAVE_NOVEL_MEMORY").at(-1);
  assert.ok(saved, "应发出保存请求");
  assert.equal(saved.chapterId, "c3", "只写回选中的第 3 话");
  assert.equal(saved.chapterOrder, 3);
  assert.equal(saved.memory.summary, "第 3 话手动补的人名");
  assert.match(page.status(), /已保存 第 3 话/u);
});

test("「本话新增」单独显示：能看出这一话学了什么，旧数据也说明白", async () => {
  const page = await bootedPage({ tabs: OPEN_CHAPTER_8 });
  const select = page.elements.get("memoryChapterSelect");

  select.value = "c3";
  await select.dispatch("change");
  const deltaLine = page.elements.get("memoryDeltaText").textContent;
  assert.match(deltaLine, /角色 甲、乙/u, "要列出这一话新增的角色");
  assert.match(deltaLine, /称呼 1 条/u);
  assert.match(deltaLine, /剧情摘要/u);

  select.value = "c8";
  await select.dispatch("change");
  assert.match(page.elements.get("memoryDeltaText").textContent, /旧版存的累计记忆/u,
    "旧数据没有单独记录本话新增，要说清楚而不是显示空白");
});

test("可以只清掉选中这一话，也可以一次清空全部记忆", async () => {
  const page = await bootedPage({ tabs: OPEN_CHAPTER_8 });
  const select = page.elements.get("memoryChapterSelect");
  select.value = "c3";
  await select.dispatch("change");
  assert.equal(page.elements.get("memoryDeleteChapterBtn").disabled, false);

  await page.elements.get("memoryDeleteChapterBtn").dispatch("click");
  await settle();
  const deleted = page.messages.filter(message => message.type === "DELETE_NOVEL_MEMORY_CHAPTER").at(-1);
  assert.ok(deleted, "应发出「删这一话」请求");
  assert.equal(deleted.chapterId, "c3", "只删选中的那一话");
  assert.equal(deleted.scopeKey, "kakao:111");
  assert.match(page.status(), /已清掉第 3 话的记忆/u);

  await page.elements.get("memoryClearAllBtn").dispatch("click");
  await settle();
  const cleared = page.messages.filter(message => message.type === "CLEAR_NOVEL_MEMORY").at(-1);
  assert.ok(cleared, "应发出「清空全部」请求");
  assert.equal(cleared.scopeKey, undefined, "不带 scopeKey ＝ 清空所有作品");
  assert.match(page.status(), /已清空全部小说记忆/u);
});

test("没有记忆时给出空状态，不炸", async () => {
  const page = createPage({ tabs: [] });
  page.setMessageHandler(message => message.type === "GET_NOVEL_MEMORY" ? { ok: true, store: { version: 1, books: [] } } : { ok: true });
  await page.boot();
  assert.equal(page.elements.get("memoryJsonInput").value, "");
  assert.equal(page.elements.get("memorySaveBtn").disabled, true);
  assert.equal(page.elements.get("memoryMetaText").textContent, "暂无小说记忆");
});
