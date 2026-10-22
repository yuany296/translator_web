import assert from "node:assert/strict";
import test from "node:test";

import { installNovelTermDiscovery } from "../extension/src/content/modules/novel-term-discovery.js";

globalThis.location = { href: "https://page.kakao.com/content/1/viewer/2" };
globalThis.document = { title: "제 3 화" };

function makeChapter(count = 2) {
  return {
    scopeKey: "kakao:1",
    chapterId: "2",
    seriesTitle: "달의 끝에서",
    paragraphs: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      paragraphKey: `hash-p${index}`,
      original_text: `원문 ${index}`
    }))
  };
}

function setup({ chapter = makeChapter(), translations = new Map([["p0", "译文 0"]]) } = {}) {
  const sent = [];
  const feedback = [];
  const responses = [];
  const runtime = {
    state: { invalidated: false, termDiscoverySentKeys: new Set() },
    getNovelState: () => ({ translations }),
    extractNovelChapter: () => chapter,
    hashSourceIdentity: value => value,
    sendRuntimeMessage: async message => {
      sent.push(message);
      return responses.shift() || { ok: true, added: 1, returned: 1 };
    },
    showFloatingBallFeedback: (text, tone) => feedback.push({ text, tone })
  };
  installNovelTermDiscovery(runtime);
  return { runtime, sent, feedback, responses };
}

test("手动提取带上 force，且不被「同一批块只发一次」拦住", async () => {
  const { runtime, sent } = setup();
  runtime.scheduleNovelTermDiscovery(makeChapter());
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].force, undefined, "自动那条路不带 force");

  await runtime.extractNovelChapterTerms();
  assert.equal(sent.length, 2, "同一章再点一次仍然要发出去");
  assert.equal(sent[1].force, true);
  assert.equal(sent[1].type, "DISCOVER_TERMS");
  assert.equal(sent[1].blocks.length, 1);
});

test("没有已译段落时不发请求，只给一句提示", async () => {
  const { runtime, sent, feedback } = setup({ translations: new Map() });
  const result = await runtime.extractNovelChapterTerms();
  assert.equal(sent.length, 0);
  assert.equal(result.reason, "no_translated_paragraphs");
  assert.match(feedback[0].text, /还没有已翻译的段落/u);
});

test("成功时把加入的条数说出来", async () => {
  const { runtime, feedback } = setup();
  await runtime.extractNovelChapterTerms();
  assert.match(feedback.at(-1).text, /已加入 1 条候选术语/u);
});

test("被跳过时把原因翻成人话（提取器离线 / AI 配置没配好）", async () => {
  const offline = setup();
  offline.responses.push({ ok: true, skipped: true, reason: "offline" });
  await offline.runtime.extractNovelChapterTerms();
  assert.match(offline.feedback.at(-1).text, /本地服务没响应/u);

  const unconfigured = setup();
  unconfigured.responses.push({ ok: true, skipped: true, reason: "engine_unconfigured" });
  await unconfigured.runtime.extractNovelChapterTerms();
  assert.match(unconfigured.feedback.at(-1).text, /没有可用配置/u);
});

test("后台没反应时给失败提示，不抛出去", async () => {
  const { runtime, feedback } = setup();
  runtime.sendRuntimeMessage = async () => {
    throw new Error("Extension context invalidated");
  };
  const result = await runtime.extractNovelChapterTerms();
  assert.equal(result.reason, "request_failed");
  assert.equal(feedback.at(-1).tone, "error");
});
