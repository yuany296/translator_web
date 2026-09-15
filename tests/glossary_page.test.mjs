import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "extension", "glossary.js"), "utf8");
const CHAPTER_URL = "https://page.kakao.com/content/69299983/viewer/69333586/";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach(name => this.values.add(name));
  }

  remove(...names) {
    names.forEach(name => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }

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
    this.selected = false;
    this.open = false;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  prepend(...nodes) {
    this.children.unshift(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  querySelectorAll(selector) {
    return descendants(this).filter(node => matches(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parent || null;
    }
    return null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {}

  click() {}

  async dispatch(type, extra = {}) {
    const event = {
      target: this,
      preventDefault() {},
      stopPropagation() {
        event.propagationStopped = true;
      },
      ...extra
    };
    let node = event.target;
    while (node && !event.propagationStopped) {
      for (const handler of node.listeners.get(type) || []) {
        await handler(event);
      }
      node = node.parent || null;
    }
  }
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function matches(node, selector) {
  const compound = /^([a-zA-Z]+)?((?:\.[\w-]+|\[[^\]]+\])*)$/u.exec(selector);
  if (!compound) {
    return false;
  }
  const [, tag, rest] = compound;
  if (tag && node.tagName !== tag.toUpperCase()) {
    return false;
  }
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/gu) || [];
  return parts.every(part => part.startsWith(".")
    ? node.classList.contains(part.slice(1)) || String(node.className || "").split(/\s+/u).includes(part.slice(1))
    : attributeMatches(node, part));
}

function attributeMatches(node, part) {
  const parsed = /^\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/u.exec(part);
  if (!parsed) {
    return false;
  }
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

/**
 * 建一个库并绑上网址：走真实界面路径——「新建术语库」→「直接新建」（自动叫「新术语库」并直接进入它），
 * 再在常显的库资料里改名、用「批量编辑」粘网址（这两处都是离开格子就自动保存）。
 * 名字和网址都改成常显表单里的直接编辑之后，已经不存在「填表新建一个库」那条路径了。
 */
async function createLibraryThroughUi(page, name, urls = []) {
  await page.elements.get("addLibraryBtn").dispatch("click");
  await page.elements.get("newLibraryBlankBtn").dispatch("click");
  await settle();
  page.elements.get("libraryNameInput").value = name;
  await page.elements.get("libraryNameInput").dispatch("blur");
  await settle();
  if (urls.length) {
    await page.elements.get("libraryUrlBulkBtn").dispatch("click");
    page.elements.get("libraryUrlsInput").value = urls.join("\n");
    await page.elements.get("libraryUrlListBtn").dispatch("click");
    await settle();
  }
  return page.stored.mt_glossary_v2.libraries.find(library => library.name === name);
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
    createElement(tag) {
      return new FakeElement(tag);
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    }
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
    fetch: async () => {
      throw new Error("local service offline");
    },
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
    setMessageHandler(handler) {
      messageHandler = handler;
    },
    async boot() {
      for (const handler of documentListeners.get("DOMContentLoaded") || []) {
        await handler({ target: document });
      }
      await settle();
      for (const element of elements.values()) {
        attachParent(element);
      }
    },
    attachAll() {
      for (const element of elements.values()) {
        attachParent(element);
      }
    }
  };
}

const discoveryState = {
  ok: true,
  enabled: true,
  pending: {
    version: 1,
    updatedAt: Date.now(),
    chapters: [{
      key: CHAPTER_URL,
      url: CHAPTER_URL,
      title: "第 12 话",
      candidates: [{
        source: "성현",
        kind: "person",
        score: 0.9,
        occurrences: 2,
        contexts: [{ evidenceId: "a", originalText: "성현이 말했다", translatedText: "成贤说道" }]
      }]
    }]
  },
  ignored: { version: 1, sources: [] },
  pendingCount: 1,
  status: { state: "online", engine: "heuristic" },
  sentenceLlmConfigured: false
};

test("glossary page boots with a default library and renders the library switch", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });

  await page.boot();

  const libraryList = page.elements.get("libraryList");
  attachParent(libraryList);
  const names = libraryList.querySelectorAll(".library-name").map(node => node.textContent);
  assert.deepEqual(names, ["全部术语", "默认术语库"]);
  assert.equal(libraryList.querySelectorAll(".library-switch").length, 2);
  assert.match(page.elements.get("pendingTabBtn").textContent, /待确认（1）/);
});

test("library profile edits save on blur and store a normalized bound URL", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  await page.boot();

  const created = await createLibraryThroughUi(page, "骸骨皇女", [CHAPTER_URL, "not a url"]);
  assert.ok(created, "新库建出来了");

  const libraries = page.stored.mt_glossary_v2.libraries;
  assert.equal(libraries.length, 2);
  assert.equal(libraries[0].id, "default");
  assert.equal(libraries[1].name, "骸骨皇女");
  assert.notEqual(libraries[1].id, "default");
  assert.deepEqual(libraries[1].urls, ["https://page.kakao.com/content/69299983/viewer/69333586"],
    "粘一整列，认不出来的那行丢掉");
  assert.equal(libraries[1].enabled, true);
  // 本地库在服务不可用时也要给出明确提示
  assert.match(page.elements.get("libraryStatusText").textContent, /服务端未同步/);
  assert.match(page.elements.get("libraryStatusText").textContent, /已更新术语库「骸骨皇女」/u);
  // 新建后侧栏立刻能看到这个库
  page.attachAll();
  const names = page.elements.get("libraryList").querySelectorAll(".library-name").map(node => node.textContent);
  assert.deepEqual(names, ["全部术语", "默认术语库", "骸骨皇女"]);
});

test("the pending chapter lists its auto-matched library and can be reassigned", async () => {
  const page = createPage();
  const messages = [];
  page.setMessageHandler(message => {
    messages.push(message);
    return message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true };
  });
  await page.boot();

  // 建一个绑定总览页的库，章节页应当自动归入它
  const created = await createLibraryThroughUi(page, "骸骨皇女", ["https://page.kakao.com/content/69299983/"]);
  const libraryId = created.id;

  await page.elements.get("pendingTabBtn").dispatch("click");
  await settle();
  page.attachAll();

  const pendingChapters = page.elements.get("pendingChapters");
  const control = pendingChapters.querySelector(".chapter-library");
  assert.ok(control, "章节应显示术语库控件");
  const hint = control.querySelector(".chapter-library-hint");
  const select = control.querySelector(".chapter-library-select");
  assert.match(hint.textContent, /骸骨皇女/u);
  assert.match(hint.textContent, /网址匹配/u);
  assert.equal(select.value, libraryId);
  assert.deepEqual(select.children.map(option => [option.value, option.textContent]),
    [["", "自动（按网址匹配）"], ["default", "默认术语库"], [libraryId, "骸骨皇女"]]);

  // 手动改指默认库
  select.value = "default";
  await select.dispatch("change");
  await settle();
  assert.ok(messages.some(message => message.type === "SET_PENDING_CHAPTER_LIBRARY" &&
    message.chapterKey === CHAPTER_URL && message.libraryId === "default"));
  assert.match(page.elements.get("pendingStatusText").textContent, /默认术语库/u);
  page.attachAll();
  assert.match(page.elements.get("pendingChapters").querySelector(".chapter-library-hint").textContent, /已手动指定/u);

  // 改回"自动"，提示恢复成网址匹配
  const refreshed = page.elements.get("pendingChapters").querySelector(".chapter-library-select");
  refreshed.value = "";
  await refreshed.dispatch("change");
  await settle();
  assert.ok(messages.some(message => message.type === "SET_PENDING_CHAPTER_LIBRARY" &&
    message.chapterKey === CHAPTER_URL && message.libraryId === ""));
  assert.match(page.elements.get("pendingStatusText").textContent, /自动匹配/u);
  page.attachAll();
  assert.match(page.elements.get("pendingChapters").querySelector(".chapter-library-hint").textContent, /网址匹配/u);
});

test("deleting a library moves its terms back to the default library", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  await page.boot();

  // 先把一个条目放进新库，再删库
  const created = await createLibraryThroughUi(page, "骸骨皇女", ["https://page.kakao.com/content/69299983/"]);
  const libraryId = created.id;

  // 新增术语只在库的页面里出现：先进这个库，弹窗里只填原文/译文，归属就是当前库
  page.attachAll();
  const targetRow = page.elements.get("libraryList").querySelectorAll(".library-row")
    .find(row => row.dataset.libraryId === libraryId);
  await page.elements.get("libraryList").dispatch("click", { target: targetRow.querySelector(".library-name") });
  await settle();

  await page.elements.get("addBtn").dispatch("click");
  page.elements.get("sourceInput").value = "왕국";
  page.elements.get("targetInput").value = "王国";
  await page.elements.get("termForm").dispatch("submit");
  await settle();
  assert.equal(page.stored.mt_glossary_v2.entries[0].libraryId, libraryId);

  // 先切到该库（表格只剩这一条），再删除它：筛选会自动回到"全部术语"，条目仍在
  page.attachAll();
  const novelRow = page.elements.get("libraryList").querySelectorAll(".library-row")
    .find(row => row.dataset.libraryId === libraryId);
  await page.elements.get("libraryList").dispatch("click", { target: novelRow.querySelector(".library-name") });
  await settle();
  assert.equal(page.elements.get("countText").textContent, "「骸骨皇女」共 1 条，启用 1 条");

  // 删除入口只在库设置里（列表行不再有编辑/删除按钮）：进入这个库后打开库设置删掉它
  await page.elements.get("libraryDeleteBtn").dispatch("click");
  await settle();

  const stored = page.stored.mt_glossary_v2;
  assert.deepEqual(stored.libraries.map(library => library.id), ["default"]);
  assert.equal(stored.entries[0].libraryId, "default");
  assert.notEqual(stored.entries[0].id, "term-new", "移动后的条目应换新 id，避免服务端主键冲突");
  assert.match(page.elements.get("statusText").textContent, /已删除「骸骨皇女」/u);
  page.attachAll();
  assert.deepEqual(
    page.elements.get("libraryList").querySelectorAll(".library-name").map(node => node.textContent),
    ["全部术语", "默认术语库"]
  );
  // 删除当前正在查看的库后，表格要回到"全部术语"并继续显示被转移的条目
  assert.equal(page.elements.get("countText").textContent, "「全部术语」共 1 条，启用 1 条");
  assert.equal(page.elements.get("termRows").children.length, 1);
  assert.equal(page.elements.get("termRows").children[0].dataset.libraryId, "default");
});

test("turning a library switch off stops it from capturing new terms", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  await page.boot();

  await createLibraryThroughUi(page, "骸骨皇女", ["https://page.kakao.com/content/69299983/"]);
  page.attachAll();

  const rows = page.elements.get("libraryList").querySelectorAll(".library-row");
  const novelRow = rows.find(row => row.dataset.libraryId === page.stored.mt_glossary_v2.libraries[1].id);
  const toggle = novelRow.querySelector(".library-switch");
  assert.equal(toggle.checked, true);

  toggle.checked = false;
  await novelRow.dispatch("change", { target: toggle });
  await settle();

  assert.equal(page.stored.mt_glossary_v2.libraries[1].enabled, false);
  assert.match(page.elements.get("libraryStatusText").textContent, /已停用/u);

  // 回「全部术语」看候选卡上的提示：关掉的库不该再把这一章吸进去（绑定网址只对启用的库生效）
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  page.attachAll();
  const allRow = page.elements.get("libraryList").querySelectorAll(".library-row")
    .find(row => row.dataset.libraryId === "");
  await page.elements.get("libraryList").dispatch("click", { target: allRow.querySelector(".library-name") });
  await settle();
  page.attachAll();
  const hint = page.elements.get("pendingChapters").querySelector(".chapter-library-hint");
  assert.ok(hint, "总览下应看得到这一章的候选控件");
  assert.match(hint.textContent, /网址未匹配绑定/u);
  assert.doesNotMatch(hint.textContent, /骸骨皇女/u);
});
