import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// QA 补充：术语库导入的边界行为（同名库去重、悬空 libraryId、非法/空文件、离线不误报成功、失败不破坏已有数据）。
// 与 glossary_import.test.mjs 同法：加载真实构建产物 dist/extension/glossary.js，用伪 DOM + 伪 chrome + 离线 fetch 驱动。
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
    this.children = []; this.dataset = {}; this.style = {}; this.attributes = {};
    this.listeners = new Map(); this.classList = new FakeClassList(); this.className = "";
    this.value = ""; this.textContent = ""; this.checked = false; this.disabled = false;
    this.required = false; this.type = ""; this.files = null; this.selected = false; this.open = false;
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
    while (node) { if (matches(node, selector)) return node; node = node.parent || null; }
    return null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  click() {}
  async dispatch(type, extra = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() { event.propagationStopped = true; }, ...extra };
    let node = event.target;
    while (node && !event.propagationStopped) {
      for (const handler of node.listeners.get(type) || []) await handler(event);
      node = node.parent || null;
    }
  }
}

function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

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

function attachParent(node) { for (const child of node.children) { child.parent = node; attachParent(child); } }

async function settle(ticks = 8) {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

function createPage() {
  const elements = new Map();
  const documentListeners = new Map();
  const stored = {};
  let messageHandler = () => ({ ok: true });
  const document = {
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
    getElementById(id) {
      if (!elements.has(id)) { const element = new FakeElement("div"); element.id = id; elements.set(id, element); }
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
      sendMessage: (message, callback) => callback(messageHandler(message))
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const list = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(list.map(key => [key, stored[key]])));
        },
        set: (value, callback) => { Object.assign(stored, JSON.parse(JSON.stringify(value))); callback(); }
      },
      onChanged: { addListener() {} }
    }
  };
  const context = vm.createContext({
    chrome, document, window: { confirm: () => true }, confirm: () => true, console,
    fetch: async () => { throw new Error("local service offline"); },
    URL, URLSearchParams, Blob, FormData, AbortController, crypto: globalThis.crypto,
    localStorage: { store: new Map(), getItem(key) { return this.store.has(key) ? this.store.get(key) : null; }, setItem(key, value) { this.store.set(key, String(value)); } },
    location: { search: "?embedded=1", href: "chrome-extension://test/glossary.html?embedded=1", replace() {} },
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: "glossary.js" });
  return {
    document, elements, stored,
    setMessageHandler(handler) { messageHandler = handler; },
    async boot() {
      for (const handler of documentListeners.get("DOMContentLoaded") || []) await handler({ target: document });
      await settle();
      attachParent(elements.get("fileInput"));
    },
    async importFile(name, content) {
      const input = elements.get("fileInput");
      input.files = [{ name, size: content.length, text: async () => content }];
      await input.dispatch("change");
      await settle();
    },
    status() { return elements.get("statusText").textContent; }
  };
}

const discoveryState = {
  ok: true, enabled: true,
  pending: { version: 1, updatedAt: Date.now(), chapters: [] },
  ignored: { version: 1, sources: [] },
  pendingCount: 0,
  status: { state: "online", engine: "heuristic" },
  sentenceLlmConfigured: false
};

async function bootedPage() {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  await page.boot();
  return page;
}

/** 预置本地已有数据，用于「库数量已到上限」这类需要既有状态的场景。 */
async function seededPage(libraries = []) {
  const page = createPage();
  page.stored.mt_glossary_v2 = { version: 4, libraries, entries: [] };
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  await page.boot();
  return page;
}

test("同一文件名重复导入 → 库复用、重复条目覆盖", async () => {
  const page = await bootedPage();
  await page.importFile("骸骨皇女.csv", "原文,译文\r\n성현,成贤\r\n왕국,王国\r\n");
  let glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 2);
  const named = glossary.libraries.filter(library => library.name === "骸骨皇女");
  assert.equal(named.length, 1, "按文件名只建一个库");
  const libraryId = named[0].id;
  const originalId = glossary.entries.find(entry => entry.source === "성현").id;

  await page.importFile("骸骨皇女.csv", "原文,译文\r\n성현,晟玄\r\n하늘,天空\r\n");
  glossary = page.stored.mt_glossary_v2;
  const again = glossary.libraries.filter(library => library.name === "骸骨皇女");
  assert.equal(again.length, 1, `同名库只应有一个，实际 ${again.length} 个`);
  assert.equal(again[0].id, libraryId, "重复导入应复用同一个库，不能新建第二个");
  assert.equal(glossary.entries.length, 3, "성현 覆盖、왕국 保留、하늘 新增");
  const bySource = new Map(glossary.entries.map(entry => [entry.source, entry]));
  assert.equal(bySource.get("성현").target, "晟玄", "重复条目按『库+范围+原文』覆盖");
  assert.equal(bySource.get("성현").id, originalId, "覆盖时保留原条目 id");
  assert.equal(bySource.get("왕국").target, "王国", "未提及的旧条目应保留");
  assert.ok(glossary.entries.every(entry => entry.libraryId === libraryId));
  assert.match(page.status(), /已导入 2 条到「骸骨皇女」，合并后共 3 条/u);
});

test("术语库数量到上限（50 个）时显式报错，不静默丢库", async () => {
  const libraries = Array.from({ length: 50 }, (_, index) => ({
    id: `lib-${index + 1}`, name: `库${index + 1}`, enabled: true, urls: []
  }));
  const page = await seededPage(libraries);
  await page.importFile("新书.csv", "原文,译文\r\n성현,晟玄\r\n");
  assert.match(page.status(), /导入失败/u);
  assert.match(page.status(), /术语库最多 50 个/u);
  assert.equal(page.elements.get("statusText").dataset.error, "true");
  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.libraries.length, 50, "报错时不应新建第 51 个库，也不应丢掉已有库");
  assert.equal(glossary.entries.length, 0, "报错时不应写入条目");
});

test("JSON 条目 libraryId 指向不存在的库时回落默认库，不产生孤儿", async () => {
  const page = await bootedPage();
  const payload = {
    version: 4,
    libraries: [{ id: "novel", name: "骸骨皇女", enabled: true, urls: [] }],
    entries: [{ id: "orphan", source: "고아", target: "孤儿", libraryId: "ghost-library", scope: "global" }]
  };
  await page.importFile("orphan.json", JSON.stringify(payload));
  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 1);
  const ids = new Set(glossary.libraries.map(library => library.id));
  assert.ok(ids.has(glossary.entries[0].libraryId), "条目 libraryId 必须指向一个真实存在的库");
  assert.equal(glossary.entries[0].libraryId, "default");
  assert.ok(!ids.has("ghost-library"), "不应凭空建出 ghost-library");
});

test("不支持的扩展名给出明确错误且不写入数据", async () => {
  const page = await bootedPage();
  await page.importFile("glossary.txt", "whatever");
  assert.match(page.status(), /不支持的文件格式/);
  assert.equal(page.stored.mt_glossary_v2, undefined, "非法扩展名不应写入术语数据");
});

test("空文件 / 非法 JSON 给出明确失败，且不破坏已有数据", async () => {
  const page = await bootedPage();
  await page.importFile("ok.json", JSON.stringify({
    version: 4, libraries: [{ id: "default", name: "默认", enabled: true, urls: [] }],
    entries: [{ id: "e1", source: "성현", target: "晟玄", libraryId: "default", scope: "global" }]
  }));
  const before = JSON.parse(JSON.stringify(page.stored.mt_glossary_v2));
  assert.equal(before.entries.length, 1);

  await page.importFile("empty.csv", "");
  assert.match(page.status(), /导入失败/);
  await page.importFile("broken.json", "{ not valid json");
  assert.match(page.status(), /导入失败/);

  const after = page.stored.mt_glossary_v2;
  assert.deepEqual(after.entries.map(entry => entry.source), before.entries.map(entry => entry.source),
    "失败的导入不得删除或改写已有条目");
  assert.equal(after.entries.length, 1);
});

test("本地服务离线时『已导入 N 条』不被『加载失败/导入失败』覆盖", async () => {
  const page = await bootedPage();
  await page.importFile("plain.csv", "source,target\r\n성현,成贤\r\n");
  const status = page.status();
  assert.match(status, /已导入 1 条/);
  assert.doesNotMatch(status, /加载失败|导入失败/);
});
