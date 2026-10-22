import assert from "node:assert/strict";
import test from "node:test";

import batch, {
  applyFilledTargets,
  buildTermTargetsPrompt,
  normalizeBatchItems,
  parseTermTargets
} from "../extension/src/background/modules/term-target-batch.js";

const CHAPTER_KEY = "https://page.kakao.com/content/1/viewer/2/";

function makeStore(overrides = {}) {
  return {
    version: 1,
    updatedAt: 1000,
    chapters: [{
      key: CHAPTER_KEY,
      url: CHAPTER_KEY,
      title: "1화",
      updatedAt: 500,
      candidates: [
        { source: "레이나", kind: "PER", score: 0.95, occurrences: 3, suggestedTargets: [] },
        { source: "루멘시티", kind: "LOC", score: 0.96, occurrences: 2, suggestedTargets: ["鲁门城"] },
        { source: "백야 기사단", kind: "ORG", score: 0.94, occurrences: 1, suggestedTargets: [] }
      ],
      ...overrides
    }]
  };
}

test("normalizeBatchItems：去空、大小写去重、编号从 1 起", () => {
  const items = normalizeBatchItems([
    { source: "  레이나 " },
    { source: "레이나" },
    null,
    { source: "" },
    { source: "Calic" },
    { source: "CALIC" },
    { source: "백야 기사단", kind: "ORG" }
  ]);
  assert.deepEqual(items.map(item => item.source), ["레이나", "Calic", "백야 기사단"]);
  assert.deepEqual(items.map(item => item.id), [1, 2, 3]);
  assert.equal(items[2].kind, "ORG");
  assert.equal(items[0].kind, "proper_noun");
});

test("normalizeBatchItems：一次最多 20 个，例句最多 2 条且截断", () => {
  const many = Array.from({ length: 30 }, (unused, index) => ({ source: `용어${index}` }));
  assert.equal(normalizeBatchItems(many).length, 20);
  assert.equal(batch.MAX_ITEMS_PER_REQUEST, 20);

  const [item] = normalizeBatchItems([{
    source: "레이나",
    contexts: [{ originalText: "가".repeat(400) }, { originalText: "나".repeat(10) }, { originalText: "다" }]
  }]);
  assert.equal(item.contexts.length, 2);
  assert.equal(item.contexts[0].length, 160);
});

test("buildTermTargetsPrompt：带编号、原文与目标语言", () => {
  const items = normalizeBatchItems([
    { source: "레이나", kind: "PER", contexts: [{ originalText: "레이나는 웃었다." }] },
    { source: "루멘시티" }
  ]);
  const prompt = buildTermTargetsPrompt({ items, targetLanguage: "zh-CN" });
  assert.match(prompt, /共 2 个/);
  assert.match(prompt, /1\. 레이나（PER）｜例句：레이나는 웃었다\./);
  assert.match(prompt, /2\. 루멘시티（proper_noun）\n/);
  assert.match(prompt, /目标语言为 zh-CN/);
  assert.match(prompt, /"terms"/);
});

test("parseTermTargets：优先按 id 对齐，返回原文与译名", () => {
  const items = normalizeBatchItems([{ source: "레이나" }, { source: "루멘시티" }]);
  const filled = parseTermTargets({
    terms: [{ id: 1, source: "레이나", target: "蕾娜" }, { id: 2, target: "鲁门城" }]
  }, items);
  assert.deepEqual(filled, [
    { source: "레이나", sourceKey: "레이나", target: "蕾娜" },
    { source: "루멘시티", sourceKey: "루멘시티", target: "鲁门城" }
  ]);
});

test("parseTermTargets：id 缺失或错位时退回按原文对齐", () => {
  const items = normalizeBatchItems([{ source: "레이나" }, { source: "루멘시티" }]);
  const filled = parseTermTargets({
    terms: [{ source: " 루멘시티 ", target: "鲁门城" }, { id: 99, target: "蕾娜" }]
  }, items);
  // 第二条既有坏 id 又没写 source，对不上任何词，直接丢。
  assert.deepEqual(filled, [{ source: "루멘시티", sourceKey: "루멘시티", target: "鲁门城" }]);
});

test("parseTermTargets：只问一个词时容忍模型省略 id 与 source", () => {
  const items = normalizeBatchItems([{ source: "레이나" }]);
  assert.deepEqual(parseTermTargets({ terms: [{ target: "蕾娜" }] }, items), [
    { source: "레이나", sourceKey: "레이나", target: "蕾娜" }
  ]);
  // 但两个词时不能瞎认第一条。
  const two = normalizeBatchItems([{ source: "레이나" }, { source: "루멘시티" }]);
  assert.deepEqual(parseTermTargets({ terms: [{ target: "蕾娜" }] }, two), []);
});

test("parseTermTargets：空译名与「把原文抄回来」都不算译名", () => {
  const items = normalizeBatchItems([{ source: "레이나" }, { source: "루멘시티" }]);
  const filled = parseTermTargets({
    terms: [
      { id: 1, target: "  " },
      { id: 2, target: "루멘시티" },
      { id: 1, target: "蕾娜" }
    ]
  }, items);
  assert.deepEqual(filled, [{ source: "레이나", sourceKey: "레이나", target: "蕾娜" }]);
});

test("parseTermTargets：同一词只留第一次出现，并容忍 ```json 包裹与裸数组", () => {
  const items = normalizeBatchItems([{ source: "레이나" }]);
  const fenced = parseTermTargets("```json\n{\"terms\":[{\"id\":1,\"target\":\"蕾娜\"},{\"id\":1,\"target\":\"蕾依娜\"}]}\n```", items);
  assert.deepEqual(fenced.map(item => item.target), ["蕾娜"]);
  assert.deepEqual(parseTermTargets("[{\"id\":1,\"target\":\"蕾娜\"}]", items).map(item => item.target), ["蕾娜"]);
  assert.deepEqual(parseTermTargets("不是 json", items), []);
});

test("applyFilledTargets：只补空的，已填的原样保留", () => {
  const applied = applyFilledTargets(makeStore(), {
    chapterKey: CHAPTER_KEY,
    now: 2000,
    entries: [
      { source: "레이나", target: "蕾娜" },
      { source: "루멘시티", target: "我要覆盖" },
      { source: "백야 기사단", target: "白夜骑士团" },
      { source: "없는말", target: "不存在" }
    ]
  });
  const candidates = applied.store.chapters[0].candidates;
  assert.deepEqual(candidates.map(item => item.suggestedTargets), [["蕾娜"], ["鲁门城"], ["白夜骑士团"]]);
  // 派生字段跟着 suggestedTargets 走：单值才算 suggestedTarget。
  assert.equal(candidates[0].suggestedTarget, "蕾娜");
  assert.equal(candidates[0].ambiguous, false);
  assert.equal(applied.filled.length, 2);
  assert.equal(applied.skippedExisting, 1);
  assert.equal(applied.missing, 1);
});

test("applyFilledTargets：不动章节 updatedAt，只动 store.updatedAt", () => {
  const applied = applyFilledTargets(makeStore(), {
    chapterKey: CHAPTER_KEY,
    now: 2000,
    entries: [{ source: "레이나", target: "蕾娜" }]
  });
  assert.equal(applied.store.updatedAt, 2000);
  assert.equal(applied.store.chapters[0].updatedAt, 500);
});

test("applyFilledTargets：译名等于原文算 empty，不写盘", () => {
  const applied = applyFilledTargets(makeStore(), {
    chapterKey: CHAPTER_KEY,
    now: 2000,
    entries: [{ source: "레이나", target: "레이나" }, { source: "백야 기사단", target: "  " }]
  });
  assert.equal(applied.filled.length, 0);
  assert.equal(applied.empty, 2);
  // 没变化时返回的就是归一化后的原存档，store.updatedAt 不该被推进。
  assert.equal(applied.store.updatedAt, 1000);
  assert.deepEqual(applied.store.chapters[0].candidates[0].suggestedTargets, []);
});

test("applyFilledTargets：章节不存在或没有译名时安全返回", () => {
  const missingChapter = applyFilledTargets(makeStore(), {
    chapterKey: "https://page.kakao.com/content/9/viewer/9/",
    now: 2000,
    entries: [{ source: "레이나", target: "蕾娜" }]
  });
  assert.equal(missingChapter.filled.length, 0);
  assert.equal(missingChapter.store.updatedAt, 1000);

  const noEntries = applyFilledTargets(makeStore(), { chapterKey: CHAPTER_KEY, now: 2000, entries: [] });
  assert.equal(noEntries.filled.length, 0);
  assert.equal(noEntries.store.updatedAt, 1000);
});
