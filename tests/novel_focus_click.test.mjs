import assert from "node:assert/strict";
import test from "node:test";
import { installNovelFocusClick } from "../extension/src/content/modules/novel-focus-click.js";

function makeNode({ pid = null, children = [] } = {}) {
  return {
    nodeType: 1,
    tagName: "P",
    children,
    getAttribute: name => (name === "data-p-id" ? pid : null)
  };
}

function setup({ isKakao = true, showTranslation = true, translatedIds = [], paragraphId = "52#1" } = {}) {
  const paragraphNode = makeNode({ pid: "52" });
  const surface = { root: {} };
  const sent = [];
  const documentListeners = new Map();
  const runtime = {
    IS_KAKAOPAGE_READER: isKakao,
    getNovelState: () => ({
      showTranslation,
      surface,
      translations: new Map(translatedIds.map(id => [id, "译文"]))
    }),
    findKakaoNovelSurface: () => surface,
    findParagraphIdForNode: (targetSurface, node) => (node === paragraphNode ? paragraphId : null),
    sendRuntimeMessage: message => {
      sent.push(message);
      return Promise.resolve({ ok: true });
    }
  };
  globalThis.document = {
    addEventListener: (type, handler) => {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    removeEventListener() {}
  };
  globalThis.window = { getSelection: () => ({ isCollapsed: true }) };
  installNovelFocusClick(runtime);
  const clickHandlers = documentListeners.get("click") || [];
  const pointerHandlers = documentListeners.get("pointerdown") || [];
  const fireClick = event => clickHandlers.forEach(handler => handler(event));
  const firePointerDown = event => pointerHandlers.forEach(handler => handler(event));
  return { runtime, sent, paragraphNode, surface, fireClick, firePointerDown, clickHandlers, pointerHandlers };
}

function clickEvent(overrides = {}) {
  const paragraphNode = overrides.__paragraphNode;
  const path = Array.isArray(overrides.__path) ? overrides.__path : [makeNode({ pid: null }), paragraphNode];
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 10,
    clientY: 10,
    composedPath: () => path,
    ...overrides
  };
}

test("Kakao 小说页才会挂载监听", () => {
  const { clickHandlers, pointerHandlers } = setup({ isKakao: false });
  assert.equal(clickHandlers.length, 0);
  assert.equal(pointerHandlers.length, 0);
});

test("显示译文 + 段落有译文 → 发送 OPEN_NOVEL_SIDEPANEL 并带 itemId", () => {
  const { sent, paragraphNode, fireClick } = setup({ translatedIds: ["52#1"] });
  fireClick(clickEvent({ __paragraphNode: paragraphNode }));
  assert.deepEqual(sent, [{ type: "OPEN_NOVEL_SIDEPANEL", itemId: "52#1" }]);
});

test("护栏 1：处于显示原文状态时不触发", () => {
  const { sent, paragraphNode, fireClick } = setup({ showTranslation: false, translatedIds: ["52#1"] });
  fireClick(clickEvent({ __paragraphNode: paragraphNode }));
  assert.deepEqual(sent, []);
});

test("护栏 2：该段落没有译文时不触发（也不弹提示）", () => {
  const { sent, paragraphNode, fireClick } = setup({ translatedIds: [] });
  fireClick(clickEvent({ __paragraphNode: paragraphNode }));
  assert.deepEqual(sent, []);
});

test("护栏 3：右键不触发", () => {
  const { sent, paragraphNode, fireClick } = setup({ translatedIds: ["52#1"] });
  fireClick(clickEvent({ __paragraphNode: paragraphNode, button: 2 }));
  assert.deepEqual(sent, []);
});

test("护栏 3：带 Ctrl 修饰键不触发", () => {
  const { sent, paragraphNode, fireClick } = setup({ translatedIds: ["52#1"] });
  fireClick(clickEvent({ __paragraphNode: paragraphNode, ctrlKey: true }));
  assert.deepEqual(sent, []);
});

test("护栏 4：存在文本选区时不触发", () => {
  const { sent, paragraphNode, fireClick } = setup({ translatedIds: ["52#1"] });
  globalThis.window.getSelection = () => ({ isCollapsed: false });
  fireClick(clickEvent({ __paragraphNode: paragraphNode }));
  assert.deepEqual(sent, []);
});

test("护栏 5：按下到松开位移超过 6px（划选/拖动）不触发", () => {
  const { sent, paragraphNode, fireClick, firePointerDown } = setup({ translatedIds: ["52#1"] });
  firePointerDown({ button: 0, clientX: 0, clientY: 0 });
  fireClick(clickEvent({ __paragraphNode: paragraphNode, clientX: 30, clientY: 0 }));
  assert.deepEqual(sent, []);
});

test("护栏 5：位移在 6px 内的轻微手抖仍触发", () => {
  const { sent, paragraphNode, fireClick, firePointerDown } = setup({ translatedIds: ["52#1"] });
  firePointerDown({ button: 0, clientX: 0, clientY: 0 });
  fireClick(clickEvent({ __paragraphNode: paragraphNode, clientX: 4, clientY: 3 }));
  assert.equal(sent.length, 1);
});

test("护栏 6：没点在段落上（无 data-p-id）不触发", () => {
  const { sent, fireClick } = setup({ translatedIds: ["52#1"] });
  fireClick(clickEvent({ __path: [makeNode({ pid: null })] }));
  assert.deepEqual(sent, []);
});

test("解析不到段落 id（正向映射落空）不发送消息", () => {
  const { sent, fireClick } = setup({ translatedIds: ["52#1"] });
  const stranger = makeNode({ pid: "99" });
  fireClick(clickEvent({ __path: [stranger] }));
  assert.deepEqual(sent, []);
});
