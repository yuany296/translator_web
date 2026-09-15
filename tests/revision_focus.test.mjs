import assert from "node:assert/strict";
import test from "node:test";
import { installRevisionFocus } from "../extension/src/sidepanel/modules/revision-focus.js";

function makeCard(itemId) {
  const classes = new Set();
  return {
    dataset: { itemId },
    hidden: false,
    scrollCalls: 0,
    get className() {
      return [...classes].join(" ");
    },
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name)
    },
    scrollIntoView() {
      this.scrollCalls += 1;
    }
  };
}

function makeBody(cards) {
  const listeners = new Map();
  return {
    children: cards,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach(handler => handler(event));
    },
    querySelector(selector) {
      const match = /data-item-id="([^"]+)"/u.exec(selector || "");
      return match ? cards.find(card => card.dataset.itemId === match[1]) || null : null;
    }
  };
}

function setup({ managedTabId = 11, cards = [makeCard("52#0"), makeCard("52#1")], sessionRecord = null } = {}) {
  const statusEl = { textContent: "" };
  const searchInput = { value: "" };
  let firstRenderResolve = null;
  const whenFirstRender = new Promise(resolve => { firstRenderResolve = resolve; });
  let collapseOnly = false;
  let filterCalls = 0;
  const bodyEl = makeBody(cards);
  const panel = {
    bodyEl,
    statusEl,
    searchInput,
    collapseBtn: { textContent: "仅显示有译文" },
    applyFilter: () => { filterCalls += 1; },
    setCollapseOnly: value => { collapseOnly = value === true; },
    getCollapseOnly: () => collapseOnly,
    whenFirstRender,
    getManagedTabId: () => managedTabId,
    setManagedTabId: () => {},
    requestRefresh: () => {}
  };
  const session = new Map();
  if (sessionRecord) session.set("mt_manage_focus", sessionRecord);
  const messageListeners = [];
  let connectedPort = null;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: handler => messageListeners.push(handler) },
      connect: options => {
        assert.equal(options.name, "mt-manage-panel");
        connectedPort = { posted: [], postMessage: value => connectedPort.posted.push(value) };
        return connectedPort;
      },
      sendMessage() {}
    },
    storage: {
      session: {
        get: async key => (session.has(key) ? { [key]: session.get(key) } : {}),
        remove: async key => { session.delete(key); }
      }
    },
    windows: { getCurrent: async () => ({ id: 7 }) }
  };
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: id => clearTimeout(id),
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false })
  };
  const controller = installRevisionFocus(panel);
  const flush = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  };
  return {
    panel, controller, bodyEl, statusEl, searchInput, cards, messageListeners,
    getSession: () => session,
    filterCalls: () => filterCalls,
    resolveFirstRender: () => firstRenderResolve(),
    flush,
    broadcast: (message, sender = {}) => messageListeners.forEach(handler => handler(message, sender))
  };
}

test("广播定位：等首帧渲染完成后滚动居中并高亮", async () => {
  const context = setup();
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" });
  await context.flush();
  const card = context.cards[1];
  assert.equal(card.classList.contains("mt-focus"), false, "首帧未完成前不得滚动/高亮");
  context.resolveFirstRender();
  await context.flush();
  assert.equal(card.scrollCalls, 1, "应滚动到可视区");
  assert.equal(card.classList.contains("mt-focus"), true);
});

test("重复触发同一段只保留一个高亮并重置计时", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  const card = context.cards[1];
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" });
  await context.flush();
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" });
  await context.flush();
  const highlighted = context.cards.filter(item => item.classList.contains("mt-focus"));
  assert.deepEqual(highlighted, [card], "始终只有一个高亮元素");
});

test("目标卡片被筛选隐藏时先清筛选再定位", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  context.cards[0].hidden = true;
  context.searchInput.value = "某个搜索词";
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#0" });
  await context.flush();
  assert.equal(context.searchInput.value, "", "应清空搜索框");
  assert.equal(context.filterCalls() >= 1, true, "应重新应用筛选");
  assert.equal(context.statusEl.textContent, "已清除筛选以显示该段落");
  assert.equal(context.cards[0].classList.contains("mt-focus"), true);
});

test("卡片本来就可见时不动用户当前的搜索词", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  context.searchInput.value = "保留我";
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" });
  await context.flush();
  assert.equal(context.searchInput.value, "保留我");
  assert.equal(context.statusEl.textContent, "");
});

test("面板管理的是另一个标签页时不静默切换", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 99, itemId: "52#1" });
  await context.flush();
  assert.equal(context.cards[1].classList.contains("mt-focus"), false);
  assert.equal(context.statusEl.textContent, "当前面板管理的是另一个标签页的章节");
});

test("来自 content script（带 sender.tab）的消息被丢弃", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" }, { tab: { id: 11 } });
  await context.flush();
  assert.equal(context.cards[1].classList.contains("mt-focus"), false);
});

test("点击面板任意位置立即撤销高亮", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" });
  await context.flush();
  const card = context.cards[1];
  assert.equal(card.classList.contains("mt-focus"), true);
  context.bodyEl.dispatch("click");
  assert.equal(card.classList.contains("mt-focus"), false);
});

test("storage.session 焦点记录：消费后清除且带 TTL", async () => {
  const context = setup({ sessionRecord: { tabId: 11, itemId: "52#0", at: Date.now() } });
  context.resolveFirstRender();
  await context.flush();
  assert.equal(context.getSession().has("mt_manage_focus"), false, "消费后应清除");
  assert.equal(context.cards[0].classList.contains("mt-focus"), true);
});

test("storage.session 焦点记录超过 TTL 则忽略", async () => {
  const context = setup({ sessionRecord: { tabId: 11, itemId: "52#0", at: Date.now() - 61000 } });
  context.resolveFirstRender();
  await context.flush();
  assert.equal(context.getSession().has("mt_manage_focus"), false);
  assert.equal(context.cards[0].classList.contains("mt-focus"), false);
});

test("高亮 3 秒后自动移除", async () => {
  const context = setup();
  context.resolveFirstRender();
  await context.flush();
  context.broadcast({ type: "FOCUS_NOVEL_REVISION_ITEM", tabId: 11, itemId: "52#1" });
  await context.flush();
  const card = context.cards[1];
  assert.equal(card.classList.contains("mt-focus"), true);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(card.classList.contains("mt-focus"), false, "3 秒后应自动移除高亮");
});
