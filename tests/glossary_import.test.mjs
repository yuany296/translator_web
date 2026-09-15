import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// 「导入术语 v2」端到端：加载真实构建产物 dist/extension/glossary.js，
// 用伪 DOM + 伪 chrome + 离线 fetch 驱动一次真实导入，断言去向与状态行。
// 用户拍板的规则：零弹窗；左侧选中库 → 全进该库；「显示全部」时 CSV 按文件名建库、
// JSON 保留自带归属；CSV 的 library（库名）列已废弃。
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

function createPage() {
  const elements = new Map();
  const documentListeners = new Map();
  const stored = {};
  let messageHandler = () => ({ ok: true });
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
      sendMessage: (message, callback) => callback(messageHandler(message))
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const list = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(list.map(key => [key, stored[key]])));
        },
        set: (value, callback) => {
          Object.assign(stored, JSON.parse(JSON.stringify(value)));
          callback();
        }
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
    fetch: async () => { throw new Error("local service offline"); },
    URL,
    URLSearchParams,
    Blob,
    FormData,
    AbortController,
    crypto: globalThis.crypto,
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(key, String(value)); }
    },
    location: { search: "?embedded=1", href: "chrome-extension://test/glossary.html?embedded=1", replace() {} },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: "glossary.js" });
  return {
    document,
    elements,
    stored,
    setMessageHandler(handler) { messageHandler = handler; },
    async boot() {
      for (const handler of documentListeners.get("DOMContentLoaded") || []) {
        await handler({ target: document });
      }
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

/** 预置本地已有数据（库列表 / 条目），用于「已选中某个库」「库数量到上限」等场景。 */
async function seededPage(libraries = [], entries = []) {
  const page = createPage();
  page.stored.mt_glossary_v2 = { version: 4, libraries, entries };
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  await page.boot();
  return page;
}

/** 模拟用户在左侧术语库列表里点某个库：点完 activeLibraryId 才有值，导入才会走「全部进该库」。 */
async function selectLibrary(page, libraryId) {
  const list = page.elements.get("libraryList");
  const row = list.querySelectorAll(`[data-library-id="${libraryId}"]`)[0];
  assert.ok(row, `左侧列表应有 ${libraryId} 这一行`);
  attachParent(row);
  row.parent = list;
  const button = row.querySelectorAll("button[data-action=\"focus-library\"]")[0];
  assert.ok(button, "库行上应有可点击的库名");
  await list.dispatch("click", { target: button });
  await settle();
}

const TWO_LIBRARIES = [
  { id: "lib-haigu", name: "骸骨皇女", enabled: true, urls: [] },
  { id: "lib-other", name: "另一本书", enabled: true, urls: [] }
];

test("点「导入文件」零弹窗，直接打开系统文件框", async () => {
  const page = await bootedPage();
  const fileInput = page.elements.get("fileInput");
  let opened = false;
  fileInput.click = () => { opened = true; };
  await page.elements.get("importBtn").dispatch("click");
  await settle();
  assert.equal(opened, true, "点击后应立即打开文件选择框");
  const html = fs.readFileSync(path.join(root, "extension", "public", "glossary.html"), "utf8");
  assert.doesNotMatch(html, /importTargetDialog/u, "术语库页不应再残留「导入目标」对话框");
});

test("CSV 按文件名建库，文件里的 library 列不再生效", async () => {
  const page = await bootedPage();
  const csv = "\uFEFFsource,target,note,enabled,scope,scope_key,scope_label,library\r\n"
    + "성현,成贤,,true,global,,,别的书\r\n"
    + "왕국,王国,,true,global,,,别的书\r\n";
  await page.importFile("骸骨皇女.csv", csv);

  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 2, "两条 CSV 术语都应写入");
  const novel = glossary.libraries.find(library => library.name === "骸骨皇女");
  assert.ok(novel, "应按文件名自动建库");
  assert.ok(glossary.entries.every(entry => entry.libraryId === novel.id),
    "条目应全部进文件名对应的库");
  assert.equal(glossary.libraries.some(library => library.name === "别的书"), false,
    "library 列已废弃：不应为它另外建库");

  assert.equal(page.status(), "已导入 2 条到「骸骨皇女」，合并后共 2 条");
  assert.doesNotMatch(page.status(), /加载失败|导入失败/u, "本地服务离线不能让已成功的导入显示失败");
});

test("CSV 文件名直接作为库名（plain.csv → 库「plain」）", async () => {
  const page = await bootedPage();
  await page.importFile("plain.csv", "source,target\r\n성현,成贤\r\n");
  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 1);
  const plain = glossary.libraries.find(library => library.name === "plain");
  assert.ok(plain, "文件名就是库名，不再进默认库");
  assert.equal(glossary.entries[0].libraryId, plain.id);
  assert.equal(page.status(), "已导入 1 条到「plain」，合并后共 1 条");
});

test("CSV 中文表头（原文,译文,备注）不再被当成一条术语", async () => {
  const page = await bootedPage();
  await page.importFile("骸骨皇女.csv", "原文,译文,备注\r\n성현,晟玄,人名\r\n왕국,王国,\r\n");
  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 2, "表头行不应入库");
  assert.deepEqual(glossary.entries.map(entry => entry.source), ["성현", "왕국"]);
  assert.equal(glossary.entries[0].target, "晟玄");
  assert.equal(glossary.entries[0].note, "人名");
});

test("文件名推导：剥掉尾部语言码与复制副本后缀", async () => {
  const cases = [
    ["terms_ko.csv", "terms"],
    ["骸骨皇女 (1).csv", "骸骨皇女"],
    ["骸骨皇女 - 副本.csv", "骸骨皇女"]
  ];
  for (const [fileName, expected] of cases) {
    const page = await bootedPage();
    await page.importFile(fileName, "原文,译文\r\n성현,晟玄\r\n");
    const names = page.stored.mt_glossary_v2.libraries.map(library => library.name);
    assert.ok(names.includes(expected), `${fileName} 应进库「${expected}」，实际是 ${names.join("、")}`);
  }
});

test("JSON 里库 id 与本机不同但库名相同时，按库名归并而不是掉进默认库", async () => {
  const page = await seededPage([{ id: "library-local", name: "骸骨皇女", enabled: true, urls: [] }]);
  await page.importFile("backup.json", JSON.stringify({
    version: 4,
    libraries: [{ id: "novel", name: "骸骨皇女", enabled: true, urls: [] }],
    entries: [{ id: "e1", source: "성현", target: "晟玄", libraryId: "novel", scope: "global" }]
  }));
  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.libraries.length, 2, "同名库不该再建一个");
  assert.equal(glossary.entries.length, 1);
  assert.equal(glossary.entries[0].libraryId, "library-local", "条目要归并到本机的同名库");
});

test("JSON 保留自带的术语库定义与条目归属", async () => {
  const page = await bootedPage();
  const payload = {
    version: 4,
    libraries: [{ id: "novel", name: "骸骨皇女", enabled: true, urls: [] }],
    entries: [{ id: "term-novel-1", source: "성현", target: "晟玄", libraryId: "novel", scope: "global" }]
  };
  await page.importFile("backup.json", JSON.stringify(payload));

  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 1);
  const novel = glossary.libraries.find(library => library.name === "骸骨皇女");
  assert.ok(novel, "JSON 自带的库定义应并入现有库");
  assert.equal(novel.id, "novel");
  assert.equal(glossary.entries[0].libraryId, "novel");
  assert.equal(glossary.entries[0].target, "晟玄");
  assert.equal(glossary.libraries.some(library => library.name === "backup"), false,
    "JSON 按自带归属，不应按文件名建库");
  assert.match(page.status(), /已导入 1 条/u);
  assert.match(page.status(), /合并后共 1 条/u);
});

test("左侧选中某个库时，导入全部进该库且不为文件名/库名列建库", async () => {
  const page = await seededPage(TWO_LIBRARIES);
  await selectLibrary(page, "lib-haigu");
  const csv = "source,target,library\r\n성현,成贤,别的书\r\n왕국,王国,别的书\r\n";
  await page.importFile("无所谓的名字.csv", csv);

  const glossary = page.stored.mt_glossary_v2;
  assert.equal(glossary.entries.length, 2);
  assert.ok(glossary.entries.every(entry => entry.libraryId === "lib-haigu"),
    "选中的库优先级最高，全部条目都应归到该库");
  const names = glossary.libraries.map(library => library.name);
  assert.equal(names.includes("别的书"), false, "不应为文件里的库名建库");
  assert.equal(names.includes("无所谓的名字"), false, "选中库时不再按文件名建库");
  assert.equal(page.status(), "已导入 2 条到「骸骨皇女」，合并后共 2 条");
});

test("SQLite(.db) 导入离线时给出明确的失败提示且不误报成功", async () => {
  const page = await bootedPage();
  await page.importFile("glossary.db", "SQLite format 3\u0000");
  assert.match(page.status(), /数据库导入失败/u);
  assert.doesNotMatch(page.status(), /已导入/u);
});
