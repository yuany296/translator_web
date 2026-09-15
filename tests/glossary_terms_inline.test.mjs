import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// 术语编辑的最终形态（用户拍板）：表格里直接改，没有「编辑」弹窗；
// 「新增术语」只收原文/译文/备注三样，落进当前所在的库；「术语范围」从界面彻底去掉。
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "extension", "glossary.js"), "utf8");
const html = fs.readFileSync(path.join(root, "extension", "public", "glossary.html"), "utf8");

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
      key: undefined,
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
      attachParent(elements.get("termRows"));
    },
    attachAll() {
      for (const element of elements.values()) attachParent(element);
    },
    status() { return elements.get("statusText").textContent; }
  };
}

const LIBRARIES = [
  { id: "default", name: "默认术语库", enabled: true, urls: [] },
  { id: "lib-haigu", name: "骸骨皇女", enabled: true, urls: ["https://page.kakao.com/content/111/"] }
];

function entry(id, source, target, extra = {}) {
  return {
    id, source, target, sourceLanguage: "ko", targetLanguage: "zh-CN",
    libraryId: "lib-haigu", scope: "global", enabled: true, note: "", ...extra
  };
}

async function bootedPage(entries) {
  const page = createPage();
  page.stored.mt_glossary_v2 = { version: 4, libraries: LIBRARIES, entries };
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE"
    ? { ok: true, enabled: false, pending: { version: 1, chapters: [] }, ignored: { version: 1, sources: [] }, pendingCount: 0, status: { state: "x" }, sentenceLlmConfigured: false }
    : { ok: true });
  await page.boot();
  // 进入骸骨皇女：新增术语按「当前库」归属
  const list = page.elements.get("libraryList");
  const row = list.querySelectorAll("[data-library-id=\"lib-haigu\"]")[0];
  attachParent(row);
  row.parent = list;
  await list.dispatch("click", { target: row.querySelector(".library-name") });
  await settle();
  page.attachAll();
  return page;
}

function rowByTermId(page, termId) {
  return page.elements.get("termRows").children.find(row => row.dataset.termId === termId) || null;
}

function cellInput(page, termId, field) {
  const row = rowByTermId(page, termId);
  return row.querySelectorAll("input.cell-input").find(input => input.dataset.field === field) || null;
}

function storedEntry(page, id) {
  return page.stored.mt_glossary_v2.entries.find(item => item.id === id);
}

test("表格行里不再有「编辑」按钮：三格直接可改，操作列只剩删除", async () => {
  const page = await bootedPage([entry("t1", "성현", "晟玄", { note: "人名" })]);
  const row = rowByTermId(page, "t1");
  assert.equal(row.querySelectorAll("button[data-action=\"edit\"]").length, 0, "不应再有编辑按钮");
  assert.equal(row.querySelectorAll("button[data-action=\"delete\"]").length, 1);
  assert.deepEqual(
    row.querySelectorAll("input.cell-input").map(input => input.dataset.field),
    ["source", "target", "note"]
  );
  assert.equal(cellInput(page, "t1", "source").value, "성현");
  assert.equal(cellInput(page, "t1", "target").value, "晟玄");
  assert.equal(cellInput(page, "t1", "note").value, "人名");
});

test("改译文后离开格子（change）就落库", async () => {
  const page = await bootedPage([entry("t1", "성현", "晟玄")]);
  const input = cellInput(page, "t1", "target");
  input.value = "晟玄（新）";
  await page.elements.get("termRows").dispatch("change", { target: input });
  await settle();

  assert.equal(storedEntry(page, "t1").target, "晟玄（新）");
  assert.equal(storedEntry(page, "t1").id, "t1", "改内容不改 id");
  assert.equal(page.status(), "已更新“성현”");
});

test("改备注也走同一条路；没有改动就不写库", async () => {
  const page = await bootedPage([entry("t1", "성현", "晟玄")]);
  const note = cellInput(page, "t1", "note");
  note.value = "魔族王子";
  await page.elements.get("termRows").dispatch("change", { target: note });
  await settle();
  assert.equal(storedEntry(page, "t1").note, "魔族王子");

  const revision = page.stored.mt_glossary_v2.revision;
  const same = cellInput(page, "t1", "note");
  same.value = "魔族王子";
  await page.elements.get("termRows").dispatch("change", { target: same });
  await settle();
  assert.equal(page.stored.mt_glossary_v2.revision, revision, "值没变就不该写库");
});

test("Esc 还原格子内容，不写库", async () => {
  const page = await bootedPage([entry("t1", "성현", "晟玄")]);
  const input = cellInput(page, "t1", "target");
  input.value = "乱改的";
  await page.elements.get("termRows").dispatch("keydown", { target: input, key: "Escape" });
  await settle();
  assert.equal(input.value, "晟玄", "Esc 要把格子还原成库里的值");
  assert.equal(storedEntry(page, "t1").target, "晟玄");
});

test("原文清空被拒：报错并把格子还原", async () => {
  const page = await bootedPage([entry("t1", "성현", "晟玄")]);
  const input = cellInput(page, "t1", "source");
  input.value = "";
  await page.elements.get("termRows").dispatch("change", { target: input });
  await settle();
  assert.match(page.status(), /原文术语和固定译文不能为空/u);
  assert.equal(input.value, "성현");
  assert.equal(storedEntry(page, "t1").source, "성현");
});

test("同库里重复原文被拦下：报错并还原，不产生第二条", async () => {
  const page = await bootedPage([entry("t1", "성현", "晟玄"), entry("t2", "왕국", "王国")]);
  const input = cellInput(page, "t2", "source");
  input.value = "성현";
  await page.elements.get("termRows").dispatch("change", { target: input });
  await settle();
  assert.match(page.status(), /已有原文术语/u);
  assert.equal(input.value, "왕국");
  assert.equal(storedEntry(page, "t2").source, "왕국");
  assert.equal(page.stored.mt_glossary_v2.entries.length, 2);
});

test("界面上已经没有「术语范围」：旧的本库范围条目靠角标交代，原文照样能改", async () => {
  const page = await bootedPage([
    entry("t1", "성현", "晟玄", { scope: "work", scopeKey: "kakao:111", scopeLabel: "骸骨皇女" })
  ]);
  const row = rowByTermId(page, "t1");
  assert.equal(row.querySelectorAll(".scope-badge").length, 1, "本书范围的条目要有「本书」角标");
  assert.equal(row.querySelectorAll(".scope-badge")[0].textContent, "本书");

  const input = cellInput(page, "t1", "target");
  input.value = "晟玄2";
  await page.elements.get("termRows").dispatch("change", { target: input });
  await settle();
  const updated = storedEntry(page, "t1");
  assert.equal(updated.target, "晟玄2");
  assert.equal(updated.scope, "work", "改写不能顺手把旧的范围信息抹掉");
  assert.equal(updated.scopeKey, "kakao:111");
});

test("「新增术语」弹窗只剩原文/译文/备注三格，落进当前库、默认启用、全局生效", async () => {
  assert.doesNotMatch(html, /id="scopeInput"|id="seriesScopeFields"|id="scopeKeyInput"|id="libraryInput"|id="termIdInput"/u,
    "弹窗里不该再有范围/所属库/隐藏 id 这些字段");
  assert.match(html, /id="dialogHint"/u);

  const page = await bootedPage([entry("t1", "성현", "晟玄")]);
  await page.elements.get("addBtn").dispatch("click");
  await settle();
  assert.equal(page.elements.get("termDialog").open, true);
  assert.match(page.elements.get("dialogHint").textContent, /骸骨皇女/u, "要说清会加进哪个库");

  page.elements.get("sourceInput").value = "왕국";
  page.elements.get("targetInput").value = "王国";
  page.elements.get("noteInput").value = "国家";
  await page.elements.get("termForm").dispatch("submit");
  await settle();

  const added = page.stored.mt_glossary_v2.entries.find(item => item.source === "왕국");
  assert.ok(added, "新术语应落库");
  assert.equal(added.libraryId, "lib-haigu", "归属＝当前所在的库");
  assert.equal(added.enabled, true, "新增默认启用");
  assert.equal(added.scope, "global", "范围从界面去掉后，新增一律全局");
  assert.equal(added.note, "国家");
  assert.equal(page.status(), "已新增“왕국”");
});

test("同一本书范围里的旧术语不会被新术语的重复检查误伤", async () => {
  // 同原文、但旧的按本书生效：新增的全局术语是另一条键，应当允许并存
  const page = await bootedPage([
    entry("t1", "성현", "晟玄", { scope: "work", scopeKey: "kakao:111", scopeLabel: "骸骨皇女" })
  ]);
  await page.elements.get("addBtn").dispatch("click");
  await settle();
  page.elements.get("sourceInput").value = "성현";
  page.elements.get("targetInput").value = "晟玄";
  await page.elements.get("termForm").dispatch("submit");
  await settle();
  assert.equal(page.stored.mt_glossary_v2.entries.length, 2);
  assert.equal(page.stored.mt_glossary_v2.entries[0].scope, "global");
});
