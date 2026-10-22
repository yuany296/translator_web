import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// 术语库页「列表页 → 库详情页」导航的行为契约：点库名才进入这个库，
// 库详情里的导入/导出/清空/待确认都只作用于这个库；「全部术语」才是总览。
// 与其它术语库测试同法：加载真实构建产物 dist/extension/glossary.js，用伪 DOM 驱动。
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

const downloads = [];

/** 捕获下载内容：导出走 Blob + URL.createObjectURL，这里把 Blob 收下来。 */
class CapturingURL extends URL {
  static createObjectURL(blob) {
    downloads.push(blob);
    return "blob:captured";
  }
  static revokeObjectURL() {}
}

function createPage(options = {}) {
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
    // 其余请求保持离线；DELETE 由 deleteFails 决定是否落库（「删除没到服务端」的报错见对应测试）。
    fetch: async (url, options = {}) => {
      if (String(options.method || "GET").toUpperCase() === "DELETE" && !options.deleteFails) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error("local service offline");
    },
    URL: CapturingURL,
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
    location: { search: options.search || "?embedded=1", href: `chrome-extension://test/glossary.html${options.search || "?embedded=1"}`, replace() {} },
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
    },
    visible(id) { return !elements.get(id).classList.contains("hidden"); },
    status() { return elements.get("statusText").textContent; }
  };
}

const KAKAO = "https://page.kakao.com/content/111/viewer/1";
const TWO_LIBRARIES = [
  { id: "default", name: "默认术语库", enabled: true, urls: [] },
  { id: "lib-haigu", name: "骸骨皇女", enabled: true, urls: ["https://page.kakao.com/content/111/"] }
];

/** 两个章节：KAKAO 那章的路由到「骸骨皇女」（绑定网址匹配），另一个没绑定 → 默认库。 */
function discoveryStateWithPending() {
  return {
    ok: true,
    enabled: true,
    pending: {
      version: 1,
      updatedAt: Date.now(),
      chapters: [
        {
          key: "kakao-1", url: KAKAO, title: "第一章", libraryId: "",
          candidates: [{ source: "성현", kind: "person", score: 0.9, occurrences: 3 }]
        },
        {
          key: "other-2", url: "https://novel.example.com/ch/2", title: "第二章", libraryId: "",
          candidates: [{ source: "왕국", kind: "proper_noun", score: 0.8, occurrences: 2 }]
        }
      ]
    },
    ignored: { version: 1, sources: [] },
    pendingCount: 2,
    status: { state: "online", engine: "heuristic" },
    sentenceLlmConfigured: false
  };
}

async function bootedPage({ libraries = TWO_LIBRARIES, entries = [], discovery = null, search = "", deleteFails = false } = {}) {
  const page = createPage({ ...(search ? { search } : {}), deleteFails });
  page.stored.mt_glossary_v2 = { version: 4, libraries, entries };
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE"
    ? (discovery || { ok: true, enabled: false, pending: { version: 1, chapters: [] }, ignored: { version: 1, sources: [] }, pendingCount: 0, status: { state: "disabled" }, sentenceLlmConfigured: false })
    : { ok: true });
  await page.boot();
  return page;
}

/** 模拟在列表页点某个库名：这才是「进入这个库」的动作。 */
async function openLibrary(page, libraryId) {
  const list = page.elements.get("libraryList");
  const row = list.querySelectorAll(`[data-library-id="${libraryId}"]`)[0];
  assert.ok(row, `列表里应有 ${libraryId} 这一行`);
  attachParent(row);
  row.parent = list;
  const name = row.querySelectorAll("button[data-action=\"focus-library\"]")[0];
  assert.ok(name, "库行上应有可点的库名");
  await list.dispatch("click", { target: name });
  await settle();
}

function termEntry(id, source, target, libraryId) {
  return { id, source, target, sourceLanguage: "ko", targetLanguage: "zh-CN", libraryId, scope: "global" };
}

test("启动停在术语库列表页，点库名才进入这个库", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  assert.equal(page.visible("libraryListView"), true, "启动应停在列表页");
  assert.equal(page.visible("libraryDetailView"), false, "列表页时详情页应隐藏");

  await openLibrary(page, "lib-haigu");
  assert.equal(page.visible("libraryListView"), false, "进入库后列表页应让位");
  assert.equal(page.visible("libraryDetailView"), true);
  assert.equal(page.elements.get("detailTitle").textContent, "骸骨皇女");
  // 设计稿定稿：标题行只留「返回 + 库名 + 删除这个库」，条件行（条数/启用/绑定）整行删掉
  assert.equal(page.elements.has("detailSubtitle"), false, "详情页不再有副标题行");
  assert.equal(page.visible("librarySettings"), true,
    "库资料常显：进库就能改，没有「编辑资料」那一步");
  assert.equal(page.elements.get("libraryNameInput").value, "骸骨皇女", "常显表单填的是当前库");
  assert.equal(page.elements.has("editLibraryBtn"), false,
    "「编辑资料」按钮已撤掉：没有任何模块再去取这个 id");
  assert.equal(page.elements.has("detailEnabledWrap"), false,
    "标题行不再有「参与翻译」开关（只有列表页那一个）");
  const glossaryHtml = fs.readFileSync(path.join(root, "extension", "public", "glossary.html"), "utf8");
  assert.doesNotMatch(glossaryHtml, /id="editLibraryBtn"|id="detailEnabledWrap"|id="libraryEnabledInput"/u,
    "页面上也不该再留着这些元素");
  assert.equal(page.elements.get("addBtn").classList.contains("hidden"), false,
    "具体库的页面里才有「新增术语」");
  assert.equal(page.elements.get("libraryDeleteBtn").classList.contains("hidden"), false);
  assert.equal(page.elements.get("tableContainer").classList.contains("single-library"), true,
    "单库视图应藏掉恒定的「术语库」列");
  assert.equal(page.elements.get("clearBtn").textContent, "清空本库");
});

test("库资料常显：换库重新填一遍，总览页藏起来", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  const settings = page.elements.get("librarySettings");
  assert.equal(settings.classList.contains("hidden"), false, "进库就看得见");
  assert.equal(page.elements.get("libraryIdInput").value, "lib-haigu", "填的是当前库");
  assert.equal(page.elements.get("libraryUrlsInput").value, "https://page.kakao.com/content/111",
    "绑定网址也一起填好（已规范化：末尾斜杠不保留）");
  assert.equal(page.elements.get("libraryUrlList").children.length, 1, "网址按一条条列出来");

  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "");
  assert.equal(settings.classList.contains("hidden"), true, "「全部术语」总览没有某一个库可设置");
});

test("网址归属测试是按钮 + 弹窗，粘章节网址试出归不归本库", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  const dialog = page.elements.get("libraryTestDialog");
  assert.equal(dialog.open, false, "平时是关着的——不在页面上多占一段");

  await page.elements.get("libraryTestBtn").dispatch("click");
  assert.equal(dialog.open, true, "点按钮才开弹窗");
  const testInput = page.elements.get("libraryTestInput");
  testInput.value = "https://page.kakao.com/content/111/viewer/222";
  await testInput.dispatch("input");
  assert.equal(page.elements.get("libraryTestResult").dataset.match, "hit", "命中本库绑定的总览页");
  assert.match(page.elements.get("libraryTestResult").textContent, /会命中/u);

  testInput.value = "https://other.example.com/ch/1";
  await testInput.dispatch("input");
  assert.equal(page.elements.get("libraryTestResult").dataset.match, "miss", "不属于本库要说不命中");
  await page.elements.get("libraryTestCloseBtn").dispatch("click");
  assert.equal(dialog.open, false);
});

test("列表页卡片的开关才是「是否参与翻译」的唯一入口，改完立即生效", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  const list = page.elements.get("libraryList");
  const row = list.querySelectorAll("[data-library-id=\"lib-haigu\"]")[0];
  attachParent(row);
  row.parent = list;
  const swatch = row.querySelectorAll(".library-switch")[0];
  assert.equal(swatch.checked, true);

  swatch.checked = false;
  await list.dispatch("change", { target: swatch });
  await settle();
  const library = page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu");
  assert.equal(library.enabled, false, "开关直接改库定义");
  assert.match(page.elements.get("libraryStatusText").textContent, /已停用/u);

  // 进库看：启用状态只在列表页开关上（详情页副标题已按设计稿删除），且不再有第二个开关
  await openLibrary(page, "lib-haigu");
  const listRow = page.elements.get("libraryList").querySelectorAll("[data-library-id=\"lib-haigu\"]")[0];
  assert.equal(listRow.querySelectorAll(".library-switch")[0].checked, false, "停用状态回到列表页开关上");
  assert.equal(page.elements.has("detailEnabledWrap"), false, "详情页不该有第二个开关");
});

test("点「全部术语」进入总览：标题、库设置与「术语库」列都在", async () => {
  const page = await bootedPage({
    entries: [termEntry("t1", "성현", "晟玄", "lib-haigu"), termEntry("t2", "왕국", "王国", "default")]
  });
  await openLibrary(page, "");
  assert.equal(page.elements.get("detailTitle").textContent, "全部术语");
  assert.equal(page.elements.has("detailSubtitle"), false, "总览页同样没有副标题行");
  assert.equal(page.elements.get("librarySettings").classList.contains("hidden"), true,
    "总览没有「这一个库」可设置");
  assert.equal(page.elements.get("tableContainer").classList.contains("single-library"), false);
  assert.equal(page.elements.get("clearBtn").textContent, "清空全部");
  assert.equal(page.elements.get("addBtn").classList.contains("hidden"), true,
    "总览页不放「新增术语」——它不知道该进哪个库");
});

test("删除入口在库标题行：具体库能看到，总览与默认术语库看不到（并说明理由）", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });

  await openLibrary(page, "lib-haigu");
  assert.equal(page.elements.get("libraryDeleteBtn").classList.contains("hidden"), false,
    "进具体库后应一眼看到「删除这个库」");
  assert.match(page.elements.get("libraryDeleteBtn").title, /一起删除/u,
    "删库会连带删掉库里的术语，标题说明必须说实话");

  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "default");
  assert.equal(page.elements.get("libraryDeleteBtn").classList.contains("hidden"), true,
    "默认术语库不给删除按钮，免得点了没反应");
  assert.match(page.elements.get("libraryDedupeHint").textContent, /默认术语库不能删除/u,
    "要在页面上写清为什么不能删");

  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "");
  assert.equal(page.elements.get("libraryDeleteBtn").classList.contains("hidden"), true,
    "总览页没有「这一个库」可删");
});

test("列表卡片上没有编辑/删除按钮：编辑一个库只有库设置这一条路径", async () => {
  const page = await bootedPage();
  const row = page.elements.get("libraryList").querySelectorAll("[data-library-id=\"lib-haigu\"]")[0];
  assert.ok(row);
  assert.equal(row.querySelectorAll("button[data-action=\"edit-library\"]").length, 0, "列表行不应再有「编辑」");
  assert.equal(row.querySelectorAll("button[data-action=\"delete-library\"]").length, 0, "列表行不应再有「删除」");
  // 设计稿定稿：卡片 = 开关 + 库名 + 条数，说明行已删
  assert.equal(row.querySelectorAll(".library-subtitle").length, 0, "卡片不再带说明行");
  assert.equal(row.querySelectorAll(".library-count")[0].textContent, "0 条术语");
});

test("库资料里改名：离开格子自动保存，标题跟着变", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  assert.equal(page.elements.get("libraryIdInput").value, "lib-haigu", "资料里必须是当前这个库");
  assert.equal(page.elements.get("libraryNameInput").value, "骸骨皇女");
  assert.equal(page.elements.get("libraryDeleteBtn").disabled, false);

  page.elements.get("libraryNameInput").value = "骸骨皇女（新版）";
  await page.elements.get("libraryNameInput").dispatch("blur");
  await settle();

  const library = page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu");
  assert.equal(library.name, "骸骨皇女（新版）");
  assert.equal(page.elements.get("detailTitle").textContent, "骸骨皇女（新版）", "改完名字详情页标题要跟着变");
  assert.equal(page.elements.get("libraryNameError").classList.contains("hidden"), true, "成功时不报错");
});

test("自动保存不会把「已停用」的库悄悄改回启用", async () => {
  const page = await bootedPage({
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [] },
      { id: "lib-haigu", name: "骸骨皇女", enabled: false, urls: [] }
    ],
    entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")]
  });
  await openLibrary(page, "lib-haigu");
  page.elements.get("libraryNameInput").value = "骸骨皇女（改名）";
  await page.elements.get("libraryNameInput").dispatch("blur");
  await settle();

  const library = page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu");
  assert.equal(library.name, "骸骨皇女（改名）");
  assert.equal(library.enabled, false, "开关在列表页，改名不能顺手把它启用");
});

test("改名撞车：行内红字报错，输入内容保留", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  page.elements.get("libraryNameInput").value = "默认术语库";
  await page.elements.get("libraryNameInput").dispatch("blur");
  await settle();

  assert.equal(page.elements.get("libraryNameError").classList.contains("hidden"), false, "要报错");
  assert.match(page.elements.get("libraryNameError").textContent, /已经有一个叫/u);
  assert.equal(page.elements.get("libraryNameInput").value, "默认术语库", "用户输入不能被吞掉");
  assert.equal(page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu").name,
    "骸骨皇女", "没存进去");
});

test("绑定网址一条条加/删，都是改完就存", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  // 应用名单为空 = 全站生效：哪怕绑定网址没进名单，也不算「只收集不生效」
  assert.equal(page.elements.get("libraryUrlDiffHint").classList.contains("hidden"), true,
    "应用名单为空时不该出现「只收集不生效」的黄条");

  await page.elements.get("libraryUrlAddBtn").dispatch("click");
  const inputs = page.elements.get("libraryUrlList").querySelectorAll("input[data-action='edit-url']");
  assert.equal(inputs.length, 2, "多出一个空行");
  inputs[1].value = "https://page.kakao.com/content/999/";
  await inputs[1].dispatch("change");
  await settle();
  assert.deepEqual(
    page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu").urls,
    ["https://page.kakao.com/content/111", "https://page.kakao.com/content/999"],
    "新网址规范化后存下来"
  );
  assert.equal(page.elements.get("libraryUrlDiffHint").classList.contains("hidden"), true,
    "加了绑定网址但应用名单仍为空：黄条依旧不出现");

  const removeBtn = page.elements.get("libraryUrlList")
    .querySelectorAll("button[data-action='remove-url']")[0];
  await removeBtn.dispatch("click");
  await settle();
  assert.deepEqual(
    page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu").urls,
    ["https://page.kakao.com/content/999"],
    "删一条只剩另一条"
  );
});

test("批量编辑：切文本框粘一整列，回到列表就落库", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  await page.elements.get("libraryUrlBulkBtn").dispatch("click");
  assert.equal(page.elements.get("libraryUrlBulk").classList.contains("hidden"), false, "文本框露面");
  assert.equal(page.elements.get("libraryUrlList").classList.contains("hidden"), true, "列表让位");
  assert.match(page.elements.get("libraryUrlsInput").value, /content\/111/u, "先把现有网址带进来");

  page.elements.get("libraryUrlsInput").value = "https://a.example.com/book/\nhttps://b.example.com/book/";
  await page.elements.get("libraryUrlListBtn").dispatch("click");
  await settle();

  assert.deepEqual(
    page.stored.mt_glossary_v2.libraries.find(item => item.id === "lib-haigu").urls,
    ["https://a.example.com/book", "https://b.example.com/book"],
    "整列粘进去，规范化后落库"
  );
  assert.equal(page.elements.get("libraryUrlList").classList.contains("hidden"), false, "回到列表");
});

test("返回按钮回到列表页", async () => {
  const page = await bootedPage();
  await openLibrary(page, "lib-haigu");
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  assert.equal(page.visible("libraryListView"), true);
  assert.equal(page.visible("libraryDetailView"), false);
});

test("整行都可以点进去（开关除外）", async () => {
  const page = await bootedPage();
  const list = page.elements.get("libraryList");
  const row = list.querySelectorAll("[data-library-id=\"lib-haigu\"]")[0];
  attachParent(row);
  row.parent = list;
  await list.dispatch("click", { target: row });
  await settle();
  assert.equal(page.visible("libraryDetailView"), true, "点行的空白处也应进入这个库");
  assert.equal(page.elements.get("detailTitle").textContent, "骸骨皇女");

  // 开关是例外：点它只切换启用状态，不该跳走
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  const swatch = row.querySelectorAll(".library-switch")[0];
  await list.dispatch("click", { target: swatch });
  await settle();
  assert.equal(page.visible("libraryListView"), true, "点开关不应进入详情页");
});

test("浏览器里 children 是 HTMLCollection（没有 .map）时，点进库依然要成功", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  // 真实浏览器的 termRows.children 是 HTMLCollection：有 length/item，没有 map/filter，
  // 也不能用 [...] 展开。之前批量操作模块直接 .map 会抛 TypeError，把「进入术语库」的跳转打断。
  const termRows = page.elements.get("termRows");
  termRows.replaceChildren = (...nodes) => {
    const collection = { length: nodes.length, item: index => nodes[index] || null };
    nodes.forEach((node, index) => { collection[index] = node; });
    termRows.children = collection;
  };
  await openLibrary(page, "lib-haigu");
  assert.equal(page.visible("libraryDetailView"), true, "渲染抛错不能挡住进入库详情页");
  assert.equal(page.elements.get("detailTitle").textContent, "骸骨皇女");
});

test("导出 CSV 不再带库名列，单库导出只含这个库", async () => {
  const page = await bootedPage({
    entries: [termEntry("t1", "성현", "晟玄", "lib-haigu"), termEntry("t2", "왕국", "王国", "default")]
  });
  downloads.length = 0;
  await openLibrary(page, "lib-haigu");
  const dialog = page.elements.get("exportDialog");
  assert.equal(dialog.open, false, "导出不再直接落文件：先在弹窗里选格式");
  await page.elements.get("exportBtn").dispatch("click");
  assert.equal(dialog.open, true, "点「导出…」开弹窗");
  await page.elements.get("exportCsvConfirm").dispatch("click");
  await settle();
  assert.equal(dialog.open, false, "选完格式关掉");

  const csv = (await downloads[0].text()).replace(/^\uFEFF/u, "");
  const header = csv.split("\r\n")[0];
  assert.equal(header, "source,target,source_language,target_language,note,enabled");
  assert.doesNotMatch(csv, /library|scope/u, "库名与范围相关列都已去掉");
  assert.match(csv, /성현/u);
  assert.doesNotMatch(csv, /왕국/u, "单库导出不该含别的库条目");
});

test("默认术语库可以一键清掉「其它库已有」的重复术语", async () => {
  const page = await bootedPage({
    entries: [
      termEntry("t1", "성현", "晟玄", "lib-haigu"),
      termEntry("t2", "성현", "晟玄", "default"),
      termEntry("t3", "왕국", "王国", "default")
    ]
  });
  await openLibrary(page, "default");
  const button = page.elements.get("libraryDedupeBtn");
  assert.equal(button.classList.contains("hidden"), false, "默认库里才出现这个按钮");
  assert.match(button.textContent, /（1 条）/u, "按钮上写清有几条");

  await button.dispatch("click");
  await settle();
  assert.deepEqual(
    page.stored.mt_glossary_v2.entries.map(entry => `${entry.source}@${entry.libraryId}`),
    ["성현@lib-haigu", "왕국@default"],
    "只删默认库里重复的那一条"
  );
  assert.match(page.elements.get("libraryStatusText").textContent, /已从默认术语库删除 1 条/u);
});

test("非默认库里没有这个清理按钮", async () => {
  const page = await bootedPage({ entries: [termEntry("t1", "성현", "晟玄", "lib-haigu")] });
  await openLibrary(page, "lib-haigu");
  assert.equal(page.elements.get("libraryDedupeBtn").classList.contains("hidden"), true);
});

test("总览页「新建术语库」给两条路（直接新建 / 导入文件），导入格式说明搬到这个弹窗里", async () => {
  const html = fs.readFileSync(path.join(root, "extension", "public", "glossary.html"), "utf8");
  const dialogStart = html.indexOf('id="newLibraryDialog"');
  assert.notEqual(dialogStart, -1, "要有「新建术语库」选择弹窗");
  const dialogHtml = html.slice(dialogStart, html.indexOf("</dialog>", dialogStart));
  assert.match(dialogHtml, /class="import-format"/u, "格式说明在弹窗里");
  assert.match(dialogHtml, /id="newLibraryBlankBtn"/u);
  assert.match(dialogHtml, /id="newLibraryImportBtn"/u);
  const listHtml = html.slice(html.indexOf('id="libraryListView"'), html.indexOf('id="libraryDetailView"'));
  assert.doesNotMatch(listHtml, /import-format/u, "列表页不再挂着格式说明");

  const page = await bootedPage();
  const dialog = page.elements.get("newLibraryDialog");
  await page.elements.get("addLibraryBtn").dispatch("click");
  assert.equal(dialog.open, true, "点「新建术语库」应先问一句");

  // 直接新建：建一个空库并进入它
  await page.elements.get("newLibraryBlankBtn").dispatch("click");
  await settle();
  assert.equal(dialog.open, false, "选完就关弹窗");
  assert.ok(page.stored.mt_glossary_v2.libraries.some(library => library.name === "新术语库"),
    "直接新建应建出空库");
  assert.equal(page.visible("libraryDetailView"), true, "建完直接进入这个库");
});

test("总览页选「导入文件」：清掉当前选中的库，按文件名建库", async () => {
  const page = await bootedPage();
  // 先进入「骸骨皇女」，让 activeLibraryId 有值（模拟「刚从某个库退出来」）
  await openLibrary(page, "lib-haigu");
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();

  let opened = false;
  page.elements.get("fileInput").click = () => { opened = true; };
  await page.elements.get("addLibraryBtn").dispatch("click");
  await page.elements.get("newLibraryImportBtn").dispatch("click");
  await settle();
  assert.equal(opened, true, "应直接打开系统文件框");
  assert.match(page.elements.get("libraryStatusText").textContent, /选好文件就直接落库/u);

  const csv = "原文,译文\r\n성현,晟玄\r\n";
  const fileInput = page.elements.get("fileInput");
  fileInput.files = [{ name: "新书.csv", size: csv.length, text: async () => csv }];
  await fileInput.dispatch("change");
  await settle();
  const glossary = page.stored.mt_glossary_v2;
  const novel = glossary.libraries.find(library => library.name === "新书");
  assert.ok(novel, "按文件名建库");
  assert.equal(glossary.entries[0].libraryId, novel.id, "不该落进刚才进过的「骸骨皇女」");
  assert.match(page.elements.get("libraryStatusText").textContent, /已导入 1 条到「新书」/u,
    "导入结果要写在列表页看得见的状态行上");
});

test("搜索词按库各记各的：换库不串，切回来还在", async () => {
  const page = await bootedPage({
    entries: [termEntry("t1", "성현", "晟玄", "lib-haigu"), termEntry("t2", "왕국", "王国", "default")]
  });
  await openLibrary(page, "lib-haigu");
  const search = page.elements.get("searchInput");
  search.value = "성현";
  await search.dispatch("input");
  assert.equal(page.elements.get("termRows").children.length, 1, "搜索后只剩匹配的那条");
  assert.match(search.placeholder, /在「骸骨皇女」中搜索/u, "搜索框要写清在哪个库里搜");

  // 换到另一个库：框里不该还留着上一个库的词，否则这个库看着像空的
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "default");
  assert.equal(search.value, "", "换库后是这个库自己那份（还没搜过就是空）");
  assert.equal(page.elements.get("termRows").children.length, 1, "这个库的术语要全都在");
  assert.match(search.placeholder, /在「默认术语库」中搜索/u);

  search.value = "王国";
  await search.dispatch("input");
  assert.equal(page.elements.get("termRows").children.length, 1, "这个库里匹配「王国」的只有一条");

  // 切回去：上个库自己的词还在
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "lib-haigu");
  assert.equal(search.value, "성현", "切回来还记得这个库自己的搜索词");

  // 「全部术语」总览也有自己独立的一份，不会捡到某个库的词
  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "");
  assert.equal(search.value, "", "总览的搜索词跟具体库互不影响");
  assert.equal(page.elements.get("termRows").children.length, 2, "总览看全部");
  assert.match(search.placeholder, /在全部术语中搜索/u);
});

test("看着某个库的搜索结果时删掉这个库，搜索词一起清掉", async () => {
  const page = await bootedPage({
    entries: [termEntry("t1", "성현", "晟玄", "lib-haigu"), termEntry("t2", "왕국", "王国", "default")]
  });
  await openLibrary(page, "lib-haigu");
  const search = page.elements.get("searchInput");
  search.value = "성현";
  await search.dispatch("input");

  await page.elements.get("libraryDeleteBtn").dispatch("click");
  await settle();
  assert.equal(page.visible("libraryListView"), true, "删完回到列表页");
  assert.equal(page.elements.get("searchInput").value, "", "别留着这个库的搜索词");
});

test("列表页每行显示这个库的待确认条数", async () => {
  const page = await bootedPage({ discovery: discoveryStateWithPending() });
  const rows = page.elements.get("libraryList").querySelectorAll(".library-row");
  const badges = new Map(rows.map(row => [
    row.dataset.libraryId,
    row.querySelectorAll(".library-pending").map(node => node.textContent).join("")
  ]));
  assert.equal(badges.get("lib-haigu"), "1 条待确认", "绑定网址匹配到的章节算这个库的候选");
  assert.equal(badges.get("default"), "1 条待确认", "没绑定网址的章节落到默认库");
  assert.equal(badges.get(""), "2 条待确认", "总览行是全部候选合计");
});

test("库详情里的待确认只看路由到这个库的章节", async () => {
  const page = await bootedPage({ discovery: discoveryStateWithPending() });
  await openLibrary(page, "lib-haigu");
  assert.match(page.elements.get("pendingTabBtn").textContent, /待确认（1）/u);
  assert.equal(page.elements.get("pendingChapters").children.length, 1, "只渲染本库那一章");

  await page.elements.get("backToListBtn").dispatch("click");
  await settle();
  await openLibrary(page, "");
  assert.match(page.elements.get("pendingTabBtn").textContent, /待确认（2）/u);
  assert.equal(page.elements.get("pendingChapters").children.length, 2, "总览才看全部章节");
});

test("库详情里「清空本库」只清这个库，别的库条目保留", async () => {
  const page = await bootedPage({
    entries: [
      termEntry("t1", "성현", "晟玄", "lib-haigu"),
      termEntry("t2", "왕국", "王国", "default"),
      termEntry("t3", "하늘", "天空", "default")
    ]
  });
  await openLibrary(page, "lib-haigu");
  await page.elements.get("clearBtn").dispatch("click");
  await settle();

  const glossary = page.stored.mt_glossary_v2;
  assert.deepEqual(glossary.entries.map(entry => entry.source), ["왕국", "하늘"], "默认库的条目必须留着");
  assert.equal(glossary.libraries.length, 2, "库定义保留");
  assert.equal(page.status(), "已清空「骸骨皇女」的 1 条术语");
});

test("库详情里导出 JSON 只含这个库的条目与定义", async () => {
  const page = await bootedPage({
    entries: [termEntry("t1", "성현", "晟玄", "lib-haigu"), termEntry("t2", "왕국", "王国", "default")]
  });
  downloads.length = 0;
  await openLibrary(page, "lib-haigu");
  await page.elements.get("exportBtn").dispatch("click");
  await page.elements.get("exportJsonConfirm").dispatch("click");
  await settle();

  assert.equal(downloads.length, 1, "应产生一次下载");
  const payload = JSON.parse(await downloads[0].text());
  assert.deepEqual(payload.libraries.map(library => library.name), ["骸骨皇女"]);
  assert.deepEqual(payload.entries.map(entry => entry.source), ["성현"], "别的库的条目不能混进来");
  assert.equal(payload.version, 4, "仍是可导回的备份格式");
});
