import assert from "node:assert/strict";
import test from "node:test";
import { installNovelEmphasisAlign } from "../extension/src/content/modules/novel-emphasis-align.js";

/**
 * 「让模型排版」的内容侧调度：只问含行内格式的段落、每段只问一次、失败不冒泡。
 *
 * 真机一整屏 137 段里通常只有个位数是混排，所以这一段的关键是**别乱发请求**：
 * reconcile 每 80ms 就会触发一次「本屏已翻完」的出口，没有记账就会反复重发。
 */

function makeHarness(overrides = {}) {
  const paragraphs = [
    { id: "p1", node: { name: "p1" } },
    { id: "p2", node: { name: "p2" } },
    { id: "p3", node: { name: "p3" } }
  ];
  const state = {
    showTranslation: true,
    translations: new Map([["p1", "第一段译文"], ["p2", "第二段译文"], ["p3", "第三段译文"]]),
    emphasisMarks: new Map(),
    emphasisAligned: new Map()
  };
  const requests = [];
  const rendered = [];
  const runtime = {
    state: {},
    getNovelState: () => state,
    getConfiguredSourceLanguage: () => "auto",
    getTargetLanguage: () => "zh-CN",
    describeNovelEmphasis: node => (node.name === "p2" ? { marked: "강조 ⟦구간⟧ 있음", count: 1 } : null),
    renderNovelTranslation: (node, text, show, id) => rendered.push({ id, marked: state.emphasisMarks.get(id) || "" }),
    sendRuntimeMessage: async request => {
      requests.push(request);
      return { ok: true, alignments: [{ id: "p2", marked_translation: "第二⟦段⟧译文" }] };
    },
    ...overrides
  };
  installNovelEmphasisAlign(runtime);
  return { runtime, state, paragraphs, requests, rendered, chapter: { paragraphs } };
}

test("只对含行内格式的段落发一次请求，并把标记存下来重贴那一段", async () => {
  const harness = makeHarness();
  const result = await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.equal(result.aligned, 1);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].type, "ALIGN_NOVEL_EMPHASIS");
  assert.deepEqual(harness.requests[0].items, [
    { id: "p2", source: "강조 ⟦구간⟧ 있음", translation: "第二段译文" }
  ], "只带含强调的段落，且输入是标记过的原文 + 已有译文");
  assert.equal(harness.state.emphasisMarks.get("p2"), "第二⟦段⟧译文");
  assert.deepEqual(harness.rendered, [{ id: "p2", marked: "第二⟦段⟧译文" }],
    "只重贴拿到标记的那一段");
});

test("同一段译文不会被反复问：reconcile 再触发也只是记过账", async () => {
  const harness = makeHarness();
  await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.equal(harness.requests.length, 1, "每 80ms 的出口不能变成每 80ms 一次模型请求");
});

test("请求失败不冒泡，也不会一直重试", async () => {
  const harness = makeHarness({ sendRuntimeMessage: async () => { throw new Error("API 超时"); } });
  const result = await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.equal(result.aligned, 0);
  assert.equal(harness.state.emphasisMarks.size, 0);
  assert.deepEqual(harness.rendered, []);
  await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.equal(harness.state.emphasisAligned.size, 1, "失败也要记账，避免无限重发");
});

test("译文换过（强制重译 / 侧栏改译）后才允许重新对齐", async () => {
  const harness = makeHarness();
  await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  harness.state.translations.set("p2", "改过的译文");
  harness.runtime.resetNovelEmphasis?.(harness.state);
  // 换章/换屏时会清空记账，于是这一段会重新问一次
  harness.state.emphasisMarks.clear();
  harness.state.emphasisAligned.clear();
  harness.runtime.describeNovelEmphasis = () => ({ marked: "강조 ⟦구간⟧ 있음", count: 1 });
  const result = await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.equal(result.aligned, 1, "测试桩只回 p2 的标记");
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].items.length, 3, "这次三个段落都有行内格式，都会重新问一遍");
  assert.equal(harness.requests[1].items.find(item => item.id === "p2").translation, "改过的译文",
    "重新对齐时带的是新译文");
});

test("原文模式下只存标记、不动页面（用户要看的还是原文）", async () => {
  const harness = makeHarness();
  harness.state.showTranslation = false;
  const result = await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.equal(result.aligned, 1);
  assert.equal(harness.state.emphasisMarks.get("p2"), "第二⟦段⟧译文");
  assert.deepEqual(harness.rendered, [], "原文模式不该把译文贴回来");
});

test("没有混杂格式的屏完全不发请求", async () => {
  const harness = makeHarness({ describeNovelEmphasis: () => null });
  const result = await harness.runtime.alignNovelEmphasisForScreen(harness.chapter, harness.state);
  assert.deepEqual(result, { aligned: 0 });
  assert.equal(harness.requests.length, 0);
});
