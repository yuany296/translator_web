import assert from "node:assert/strict";
import test from "node:test";
import { TUNING_KEY } from "../extension/src/novel-mobile/novel-tuning.js";
import {
  TUNING_CARD_ID,
  applyTuningToInputs,
  installTuningPanel,
  readTuningInputs
} from "../extension/src/novel-mobile/tuning-panel.js";

// 设置页的「翻译速度」卡片：手机版独有（运行时注入，不改公共 settings.html）。
// 用最小 DOM 桩验证「读设置 → 填进输入框」「点保存 → 收敛后写回 storage」。
function makeElement(tagName = "div") {
  const node = {
    tagName, children: [], dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    textContent: "", value: "", className: "", type: "",
    append(...items) { node.children.push(...items); },
    before(item) { inserted.push(item); },
    setAttribute() {},
    addEventListener(type, handler) { node.handlers = { ...node.handlers, [type]: handler }; }
  };
  return node;
}
const inserted = [];

function makeDoc() {
  const panel = makeElement("section");
  const actions = makeElement("div");
  const nodes = { [TUNING_CARD_ID]: null };
  const doc = {
    documentElement: { classList: { add() {} } },
    head: { appendChild() {} },
    createElement: tag => makeElement(tag),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
    querySelector: selector => {
      if (selector === '[data-panel="general"]') return panel;
      if (selector === '[data-panel="general"] .panel-actions') return actions;
      if (selector === "link[data-mt-novel-mobile]") return { href: "" };
      return null;
    },
    querySelectorAll: () => [],
    getElementById: id => (id === TUNING_CARD_ID ? nodes[id] : null)
  };
  const setCard = card => { nodes[TUNING_CARD_ID] = card; };
  return { doc, panel, actions, setCard };
}

function makeStorage(initial = {}) {
  const stored = { ...initial };
  return {
    stored,
    get(keys, callback) {
      callback(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])));
    },
    set(value, callback) {
      Object.assign(stored, JSON.parse(JSON.stringify(value)));
      callback();
    }
  };
}

test("卡片注入到「常规」面板，输入框显示存好的值", async () => {
  const { doc, setCard } = makeDoc();
  const storage = makeStorage({ [TUNING_KEY]: { concurrency: 8, chunkChars: 800, repairParagraphs: 1 } });
  const ui = installTuningPanel(doc, storage);
  assert.ok(ui, "应当返回注入结果");
  setCard(ui.card);
  assert.equal(inserted.at(-1), ui.card, "卡片插在「保存常规设置」那一行之前");
  assert.equal(ui.card.id, TUNING_CARD_ID);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.inputs.concurrency.value, "8");
  assert.equal(ui.inputs.chunkChars.value, "800");
  assert.equal(ui.inputs.repairParagraphs.value, "1");
  assert.match(ui.hint.textContent, /当前：并发 8 · 每块 800 字/u);
});

test("点保存：把输入收敛到合法范围后写进 storage", async () => {
  const { doc, setCard } = makeDoc();
  const storage = makeStorage({});
  const ui = installTuningPanel(doc, storage);
  setCard(ui.card);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.inputs.concurrency.value, "6", "没有设置时填默认值");
  ui.inputs.concurrency.value = "99";
  ui.inputs.chunkChars.value = "10";
  ui.save.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(storage.stored[TUNING_KEY], { concurrency: 10, chunkChars: 400, repairParagraphs: 3 });
  assert.equal(ui.inputs.concurrency.value, "10", "输入框会被写成收敛后的值");
  assert.match(ui.status.textContent, /已保存（并发 10 · 每块 400 字）/u);
});

test("恢复默认：写回内置默认值", async () => {
  const { doc, setCard } = makeDoc();
  const storage = makeStorage({ [TUNING_KEY]: { concurrency: 2, chunkChars: 500, repairParagraphs: 0 } });
  const ui = installTuningPanel(doc, storage);
  setCard(ui.card);
  await new Promise(resolve => setImmediate(resolve));
  ui.reset.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(storage.stored[TUNING_KEY], { concurrency: 6, chunkChars: 1200, repairParagraphs: 3 });
});

test("重复注入 / 没有常规面板时安静跳过；没有 storage 也不炸", () => {
  const { doc, setCard } = makeDoc();
  const storage = makeStorage({});
  const ui = installTuningPanel(doc, storage);
  setCard(ui.card);
  assert.equal(installTuningPanel(doc, storage), null, "已经有卡片就不再插一份");
  const empty = { querySelector: () => null, getElementById: () => null, createElement: () => makeElement() };
  assert.equal(installTuningPanel(empty, storage), null);
  assert.equal(installTuningPanel(doc, null), null);
});

test("读/写输入框的纯函数：收敛规则与设置模块一致", () => {
  const inputs = { concurrency: { value: "3" }, chunkChars: { value: "700" }, repairParagraphs: { value: "5" } };
  assert.deepEqual(readTuningInputs(inputs), { concurrency: 3, chunkChars: 700, repairParagraphs: 5 });
  assert.deepEqual(applyTuningToInputs(inputs, { concurrency: 12, chunkChars: 1, repairParagraphs: 99 }), {
    concurrency: 10, chunkChars: 400, repairParagraphs: 8
  });
  assert.deepEqual(inputs, {
    concurrency: { value: "10" }, chunkChars: { value: "400" }, repairParagraphs: { value: "8" }
  });
});
