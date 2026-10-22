import assert from "node:assert/strict";
import test from "node:test";

import { installGlossaryPendingTargets } from "../extension/src/glossary/modules/glossary-pending-targets.js";

// 模块在安装时会自己去找工具栏那颗按钮；单测里没有 DOM，给个空壳让它装得下去，
// 装完之后（install 会把引用写成 null）再用伪按钮覆盖。
globalThis.document = { getElementById: () => null };

function makeButton() {
  const listeners = [];
  return {
    textContent: "",
    title: "",
    disabled: false,
    listeners,
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    click() { listeners.forEach(item => item.handler({})); }
  };
}

function makeCard(chapterKey, source, target) {
  return {
    dataset: { chapterKey, source },
    querySelector(selector) {
      return selector === ".candidate-target" ? { value: target } : null;
    }
  };
}

function makeChapter(key, entries) {
  return {
    key,
    candidates: entries.map(([source, target]) => ({
      source,
      suggestedTargets: target ? [target] : []
    }))
  };
}

/** 伪 runtime：只实现补译名模块真正用到的那几个钩子。 */
function makeRuntime({ chapters = [], cards = [], responses = [], configured = true } = {}) {
  const button = makeButton();
  const sent = [];
  const statuses = [];
  const queue = [...responses];
  let stateLoads = 0;
  const runtime = {
    sentenceLlmConfigured: configured,
    pendingChapters: { querySelectorAll: () => cards },
    scopedPendingChapters: () => chapters,
    sendRuntimeMessage: async message => {
      sent.push(message);
      return queue.length > 0 ? queue.shift() : { ok: true, filledCount: 0, remaining: 0 };
    },
    withPendingTimeout: promise => promise,
    setPendingStatus: (text, isError) => statuses.push({ text, isError: Boolean(isError) }),
    getErrorMessage: error => String(error && error.message || error),
    loadTermDiscoveryState: async () => { stateLoads += 1; }
  };
  installGlossaryPendingTargets(runtime);
  runtime.aiFillTargetsBtn = button;
  return { runtime, button, sent, statuses, stateLoads: () => stateLoads };
}

test("按钮文案跟上还缺译名的条数，全部填满就禁用", () => {
  const { runtime, button } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""], ["루멘시티", ""], ["칼릭", "卡里克"]])]
  });
  runtime.renderFillButton();
  assert.equal(button.textContent, "AI 补全译名（2）");
  assert.equal(button.disabled, false);
  assert.match(button.title, /只补空的/);

  runtime.scopedPendingChapters = () => [makeChapter("c1", [["레이나", "蕾娜"]])];
  runtime.renderFillButton();
  assert.equal(button.textContent, "AI 补全译名");
  assert.equal(button.disabled, true);
  assert.equal(button.title, "所有候选都已有译名");
});

test("没配句子级提取服务时按钮禁用并指向设置页", () => {
  const { runtime, button } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""]])],
    configured: false
  });
  runtime.renderFillButton();
  assert.equal(button.disabled, true);
  assert.match(button.title, /设置页「翻译服务」/);
});

test("先落盘页面上已填的值，再按批补译名，累计到没有剩余", async () => {
  const { runtime, sent, statuses } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""], ["루멘시티", ""]])],
    cards: [makeCard("c1", "레이나", "蕾娜"), makeCard("c1", "루멘시티", "  ")],
    responses: [
      { ok: true },
      { ok: true, filledCount: 2, remaining: 3 },
      { ok: true, filledCount: 3, remaining: 0 }
    ]
  });
  await runtime.fillPendingTargets();
  assert.deepEqual(sent.map(message => message.type), [
    "SAVE_PENDING_TARGET_DRAFTS",
    "EXTRACT_TERM_TARGETS",
    "EXTRACT_TERM_TARGETS"
  ]);
  // 空值不进 drafts：只有蕾娜那条真的填了。
  assert.deepEqual(sent[0].drafts, [{ source: "레이나", target: "蕾娜" }]);
  assert.equal(statuses.at(-1).text, "已补 5 条译名，确认无误后点「加入所有已填写」");
  assert.equal(statuses.at(-1).isError, false);
});

test("一批一条都没补出来就停手，把剩余条数说出来", async () => {
  const { runtime, sent, statuses } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""]])],
    responses: [{ ok: true, filledCount: 0, remaining: 4 }]
  });
  await runtime.fillPendingTargets();
  assert.equal(sent.length, 1);
  assert.match(statuses.at(-1).text, /还有 4 条 AI 没给出译名/);
  assert.equal(statuses.at(-1).isError, true);
});

test("补译名只动被点的那一话", async () => {
  const { runtime, sent } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""]]), makeChapter("c2", [["칼릭", ""]])],
    responses: [{ ok: true, filledCount: 1, remaining: 0 }]
  });
  await runtime.fillChapterTargets("c2");
  assert.deepEqual(sent.map(message => message.chapterKey), ["c2"]);
});

test("后台报错时把原因说出来，并把按钮恢复可用", async () => {
  const { runtime, button, statuses, stateLoads } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""]])],
    responses: [{ ok: false, error: "未选择句子级术语提取配置" }]
  });
  await runtime.fillPendingTargets();
  assert.match(statuses.at(-1).text, /补译名失败：未选择句子级术语提取配置/);
  assert.equal(statuses.at(-1).isError, true);
  assert.equal(button.disabled, false);
  assert.equal(stateLoads(), 1);
});

test("没有可补的候选时直接给提示，不发请求", async () => {
  const { runtime, sent, statuses } = makeRuntime({ chapters: [] });
  await runtime.fillPendingTargets();
  assert.equal(sent.length, 0);
  assert.equal(statuses.at(-1).text, "没有需要补译名的候选");
});

test("点击按钮走同一条流程", async () => {
  const { runtime, button, sent } = makeRuntime({
    chapters: [makeChapter("c1", [["레이나", ""]])],
    responses: [{ ok: true, filledCount: 1, remaining: 0 }]
  });
  runtime.bindPendingTargetEvents();
  button.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.at(-1).type, "EXTRACT_TERM_TARGETS");
});
