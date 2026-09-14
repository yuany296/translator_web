import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "extension", "glossary.js"), "utf8");
const TARGET_LIBRARY_ID = "lib-haigu";

// 与 glossary_page.test.mjs 同一套 vm 假 DOM harness（confirm 可按用例注入）。
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

function createPage() {
  const elements = new Map();
  const documentListeners = new Map();
  const stored = {};
  let messageHandler = () => ({ ok: true });
  let confirmHandler = () => true;
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
    window: { confirm: (...args) => confirmHandler(...args) },
    confirm: (...args) => confirmHandler(...args),
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
    setConfirm(handler) {
      confirmHandler = handler;
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

// ── seed helpers ──

function makeEntry(id, source, overrides = {}) {
  return {
    id,
    source,
    target: `译-${source}`,
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    scope: "global",
    scopeKey: "",
    note: "",
    enabled: true,
    libraryId: "default",
    ...overrides
  };
}

function buildSeed(entries) {
  return {
    version: 4,
    revision: 1,
    updatedAt: Date.now(),
    libraries: [
      { id: "default", name: "默认术语库", enabled: true },
      { id: TARGET_LIBRARY_ID, name: "骸骨皇女", enabled: true }
    ],
    entries
  };
}

function bootWithSeed(entries) {
  const page = createPage();
  page.setMessageHandler(message =>
    message.type === "GET_TERM_DISCOVERY_STATE"
      ? { ok: true, enabled: false, pending: { version: 1, chapters: [] }, ignored: { version: 1, sources: [] }, pendingCount: 0, status: { state: "online", engine: "heuristic" }, sentenceLlmConfigured: false }
      : { ok: true });
  page.stored.mt_glossary_v2 = buildSeed(entries);
  return page.boot().then(() => page);
}

function rowByTermId(page, termId) {
  return page.elements.get("termRows").children.find(row => row.dataset.termId === termId) || null;
}

function selectCheckboxOf(row) {
  return row.children[0].children[0];
}

async function selectRows(page, termIds) {
  page.attachAll();
  for (const termId of termIds) {
    const checkbox = selectCheckboxOf(rowByTermId(page, termId));
    checkbox.checked = true;
    await page.elements.get("termRows").dispatch("change", { target: checkbox });
  }
}

function storedEntries(page) {
  return page.stored.mt_glossary_v2.entries;
}

function entryById(page, id) {
  return storedEntries(page).find(entry => entry.id === id);
}

// ── tests ──

test("row checkboxes drive the batch bar and the select-all header state", async () => {
  const page = await bootWithSeed([
    makeEntry("a", "성현"),
    makeEntry("b", "왕국"),
    makeEntry("c", "마법"),
    makeEntry("dup", "성현", { libraryId: TARGET_LIBRARY_ID, target: "另一译法" })
  ]);

  const bar = page.elements.get("batchActionBar");
  assert.equal(bar.classList.contains("hidden"), true, "未选中时批量栏隐藏");

  await selectRows(page, ["a", "b"]);
  assert.equal(bar.classList.contains("hidden"), false, "选中后批量栏出现");
  assert.equal(page.elements.get("batchSelectedCount").textContent, "已选 2 条");
  assert.equal(page.elements.get("selectAllTerms").checked, false, "未全选时表头框不勾选");

  await selectRows(page, ["c", "dup"]);
  assert.equal(page.elements.get("batchSelectedCount").textContent, "已选 4 条");
  assert.equal(page.elements.get("selectAllTerms").checked, true, "全部可见行选中后表头框勾选");

  // 取消一行：表头框回弹为未勾选
  const checkbox = selectCheckboxOf(rowByTermId(page, "a"));
  checkbox.checked = false;
  await page.elements.get("termRows").dispatch("change", { target: checkbox });
  assert.equal(page.elements.get("selectAllTerms").checked, false);
  assert.equal(page.elements.get("batchSelectedCount").textContent, "已选 3 条");

  // 取消选择按钮：清空并重渲染
  await page.elements.get("batchClearBtn").dispatch("click");
  await settle();
  assert.equal(bar.classList.contains("hidden"), true);
  assert.equal(page.elements.get("termRows").children
    .every(row => selectCheckboxOf(row).checked === false), true);
  assert.equal(storedEntries(page).length, 4, "取消选择不改动数据");
});

test("batch move: moves to the target library and reports skipped duplicates and capacity", async () => {
  // 目标库放 498 条占位 + 1 条与 a 完全同键的重复条目 → 容量只剩 1
  const fillers = Array.from({ length: 498 }, (_, index) =>
    makeEntry(`filler-${index}`, `용어${index}`, { libraryId: TARGET_LIBRARY_ID }));
  const page = await bootWithSeed([
    makeEntry("a", "성현"),
    makeEntry("b", "왕국"),
    makeEntry("c", "마법"),
    makeEntry("dup", "성현", { libraryId: TARGET_LIBRARY_ID, target: "另一译法" }),
    ...fillers
  ]);

  await selectRows(page, ["a", "b", "c"]);
  await page.elements.get("batchMoveBtn").dispatch("click");
  assert.equal(page.elements.get("batchMoveDialog").open, true, "点移动弹出目标库对话框");
  const options = page.elements.get("batchMoveTargetSelect").children
    .map(option => option.value);
  assert.deepEqual(options, ["default", TARGET_LIBRARY_ID], "所有库都可作为目标（含默认库）");

  page.elements.get("batchMoveTargetSelect").value = TARGET_LIBRARY_ID;
  await page.elements.get("batchMoveForm").dispatch("submit");
  await settle();

  assert.match(page.elements.get("statusText").textContent,
    /已移动 1 条到「骸骨皇女」，跳过 2 条（重复 1 \/ 容量 1）/u);
  assert.equal(entryById(page, "b").libraryId, TARGET_LIBRARY_ID, "b 移入目标库");
  assert.equal(entryById(page, "a").libraryId, "default", "重复条目留在原库");
  assert.equal(entryById(page, "c").libraryId, "default", "容量不足的条目留在原库");
  assert.equal(page.elements.get("batchMoveDialog").open, false, "移动后关闭对话框");
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), true,
    "操作完成后清空选择");
  assert.equal(page.elements.get("termRows").children
    .every(row => selectCheckboxOf(row).checked === false), true);
  // 持久化：storage 里的条目归属同步变化（498 占位 + 重复条目 + 移入的 b = 500）
  assert.equal(storedEntries(page).filter(entry => entry.libraryId === TARGET_LIBRARY_ID).length, 500);
});

test("batch move: skips everything with an explicit all-skipped notice", async () => {
  const page = await bootWithSeed([
    makeEntry("a", "성현"),
    makeEntry("dup", "성현", { libraryId: TARGET_LIBRARY_ID, target: "另一译法" })
  ]);

  await selectRows(page, ["a"]);
  await page.elements.get("batchMoveBtn").dispatch("click");
  page.elements.get("batchMoveTargetSelect").value = TARGET_LIBRARY_ID;
  await page.elements.get("batchMoveForm").dispatch("submit");
  await settle();

  assert.match(page.elements.get("statusText").textContent,
    /没有术语移动到「骸骨皇女」，跳过 1 条（重复 1）/u);
  assert.equal(entryById(page, "a").libraryId, "default");
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), true);
});

test("batch delete: deletes after confirm and keeps data when cancelled", async () => {
  const page = await bootWithSeed([
    makeEntry("a", "성현"),
    makeEntry("b", "왕국"),
    makeEntry("c", "마법")
  ]);

  await selectRows(page, ["a", "b"]);
  page.setConfirm(() => false);
  await page.elements.get("batchDeleteBtn").dispatch("click");
  await settle();
  assert.equal(storedEntries(page).length, 3, "取消确认时不删除");
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), false);

  page.setConfirm(() => true);
  await page.elements.get("batchDeleteBtn").dispatch("click");
  await settle();
  assert.deepEqual(storedEntries(page).map(entry => entry.id), ["c"]);
  assert.match(page.elements.get("statusText").textContent, /已删除 2 条术语/u);
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), true);
});

test("select-all only covers visible rows, selection survives filtering, and tab switch clears it", async () => {
  const page = await bootWithSeed([
    makeEntry("a", "성현"),
    makeEntry("b", "왕국의 왕"),
    makeEntry("c", "마법")
  ]);

  // 搜索过滤后只剩 b 可见
  page.elements.get("searchInput").value = "왕국";
  await page.elements.get("searchInput").dispatch("input");
  await settle();
  page.attachAll();
  assert.deepEqual(page.elements.get("termRows").children.map(row => row.dataset.termId), ["b"]);

  page.elements.get("selectAllTerms").checked = true;
  await page.elements.get("selectAllTerms").dispatch("change");
  assert.equal(page.elements.get("batchSelectedCount").textContent, "已选 1 条",
    "全选只作用于可见行");

  // 清空搜索：选中集合按 id 保留
  page.elements.get("searchInput").value = "";
  await page.elements.get("searchInput").dispatch("input");
  await settle();
  page.attachAll();
  assert.equal(page.elements.get("batchSelectedCount").textContent, "已选 1 条");
  assert.equal(selectCheckboxOf(rowByTermId(page, "b")).checked, true);
  assert.equal(selectCheckboxOf(rowByTermId(page, "a")).checked, false);

  // 批量操作后选择清空
  page.setConfirm(() => true);
  await page.elements.get("batchDeleteBtn").dispatch("click");
  await settle();
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), true);
  assert.deepEqual(storedEntries(page).map(entry => entry.id), ["a", "c"]);

  // 切到「待确认」tab：清空选择并隐藏批量栏
  await selectRows(page, ["a"]);
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), false);
  await page.elements.get("pendingTabBtn").dispatch("click");
  await settle();
  assert.equal(page.elements.get("batchActionBar").classList.contains("hidden"), true);
  assert.equal(page.elements.get("batchSelectedCount").textContent, "已选 0 条");
  await page.elements.get("officialTabBtn").dispatch("click");
  await settle();
  page.attachAll();
  assert.equal(selectCheckboxOf(rowByTermId(page, "c")).checked, false);
});
