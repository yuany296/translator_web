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
      sendMessage: (message, callback) => {
        const result = messageHandler(message);
        // 返回 undefined 表示「后台不回话」：回调永不触发，用来复现页面端的静默等待。
        if (result !== undefined) callback(result);
      }
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
    // 页面端「后台多久不回话就算超时」的测试钩子：默认 20 秒，用例里收短。
    __MT_PENDING_ACTION_TIMEOUT_MS: options.pendingActionTimeoutMs,
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
  assert.equal(page.elements.has("countText"), false, "「共 N 条，启用 N 条」说明行已按设计稿删除");

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
  assert.equal(page.elements.get("termRows").children.length, 1);
  assert.equal(page.elements.get("termRows").children[0].dataset.libraryId, "default");
});

test("清理「其它库已有」时服务端没删掉就报术语删除失败，不假装清干净了", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : { ok: true });
  // 默认库与「骸骨皇女」各有一条同样的术语：按钮可清，但本地服务不可用（fetch 一律抛错）。
  page.stored.mt_glossary_v2 = {
    version: 4,
    revision: 1,
    updatedAt: Date.now(),
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [] },
      { id: "novel", name: "骸骨皇女", enabled: true, urls: [] }
    ],
    entries: [
      { id: "t1", source: "성현", target: "晟玄", libraryId: "novel" },
      { id: "t2", source: "성현", target: "晟玄", libraryId: "default" }
    ]
  };
  await page.boot();
  page.attachAll();
  const row = page.elements.get("libraryList").querySelectorAll(".library-row")
    .find(item => item.dataset.libraryId === "default");
  await page.elements.get("libraryList").dispatch("click", { target: row.querySelector(".library-name") });
  await settle();
  assert.match(page.elements.get("libraryDedupeBtn").textContent, /（1 条）/u);

  await page.elements.get("libraryDedupeBtn").dispatch("click");
  await settle();

  const libraryStatus = page.elements.get("libraryStatusText");
  assert.match(libraryStatus.textContent, /术语删除失败/u);
  assert.match(libraryStatus.textContent, /刷新后会重新出现/u);
  assert.equal(libraryStatus.dataset.error, "true");
  assert.match(page.elements.get("statusText").textContent, /术语删除失败/u,
    "术语表上方的状态栏也不能停在「已从默认术语库删除」");
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

// 事故回归：后台串行队列被整章术语提取占着时，页面端曾经一直静默等下去，
// 「确认加入」看上去完全没反应（没有提示、没有变化）。现在要先给「正在…」，
// 超时后明确说清是后台没回话。
test("a pending action gives feedback right away and times out loudly", async () => {
  const page = createPage({ pendingActionTimeoutMs: 30 });
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE" ? discoveryState : undefined);
  await page.boot();

  await page.elements.get("pendingTabBtn").dispatch("click");
  await settle();
  page.attachAll();

  const card = page.elements.get("pendingChapters").querySelectorAll(".candidate-card")[0];
  assert.ok(card, "待确认列表里应该有一张候选卡");
  card.querySelector(".candidate-target").value = "成贤";
  card.querySelector(".candidate-target").dataset.userEdited = "true";
  const confirmBtn = card.querySelector("button[data-action='confirm']");
  const clicking = card.dispatch("click", { target: confirmBtn });

  // 后台还没回话，提示就应该已经在了
  await settle(1);
  assert.match(page.elements.get("pendingStatusText").textContent, /正在加入/u);
  assert.equal(page.elements.get("pendingStatusSummary").classList.contains("hidden"), false);

  await clicking;
  await settle();
  assert.match(page.elements.get("pendingStatusText").textContent, /后台没有响应/u);
  assert.match(page.elements.get("pendingStatusText").textContent, /稍后重试/u);
  assert.equal(page.elements.get("pendingStatusText").dataset.error, "true");
});

// 术语没收集到时，那句「术语提取器：在线」是没用的：页面必须把最近一次失败的原因说出来。
test("待确认页会说清最近一次自动提取怎么了", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE"
    ? {
      ...discoveryState,
      status: { state: "online", engine: "ollama" },
      lastDiscovery: { at: Date.now(), outcome: "failed", reason: "offline", error: "401 Unauthorized" }
    }
    : { ok: true });
  await page.boot();
  await page.elements.get("pendingTabBtn").dispatch("click");
  await settle();

  const status = page.elements.get("extractorStatus");
  assert.match(status.textContent, /在线/u);
  assert.match(status.textContent, /上次提取失败/u);
  assert.match(status.textContent, /401 Unauthorized/u);
  assert.match(status.title, /401 Unauthorized/u);
});

test("提取到的东西全被去重时，页面说的是「都不是新候选」而不是没反应", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE"
    ? {
      ...discoveryState,
      lastDiscovery: { at: Date.now(), outcome: "added", reason: "no_new_candidates", returned: 4, added: 0 }
    }
    : { ok: true });
  await page.boot();
  await page.elements.get("pendingTabBtn").dispatch("click");
  await settle();

  const status = page.elements.get("extractorStatus");
  assert.match(status.textContent, /返回 4 条，都不是新候选/u);
});

test("提取卡住时页面显示「正在提取（已 N 分钟）」，一眼分辨是卡住而不是没触发", async () => {
  const page = createPage();
  page.setMessageHandler(message => message.type === "GET_TERM_DISCOVERY_STATE"
    ? {
      ...discoveryState,
      lastDiscovery: { outcome: "running", startedAt: Date.now() - 3 * 60 * 1000, budgetMs: 450000 }
    }
    : { ok: true });
  await page.boot();
  await page.elements.get("pendingTabBtn").dispatch("click");
  await settle();

  const status = page.elements.get("extractorStatus");
  assert.match(status.textContent, /正在提取（已 3 分钟/u);
  assert.match(status.textContent, /预算最多约 8 分钟/u);
});
