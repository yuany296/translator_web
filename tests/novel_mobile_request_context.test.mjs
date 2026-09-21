import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import {
  forgetRequestContexts,
  rememberRequestContext,
  requestContextFor,
  withRequestContext
} from "../extension/src/novel-mobile/request-context.js";
import { buildGlossaryJudgementPrompt } from "../extension/src/novel-mobile/glossary-judgement.js";

// 用户实测的关键差异：应用网址为空（全站生效）时术语照用；点了「一键加入应用」之后
// 一大批术语被模型忽略、人名开始自己发挥。
// 根因：novel-translation.js 构造术语前言时只传 `{ scopeKey }`，没有 pageUrl，
// 而 shared/glossary.js 用 pageUrl 判定库的生效范围 —— 应用网址非空 + 没有 pageUrl
// 会被判成「本页不生效」，整库术语都进不了提示词。
const SCOPE = "kakao:69299983";
const PAGE = "https://page.kakao.com/content/69299983/viewer/11111111";
const ITEMS = [{ id: "p1", original_text: "레오나르도가 말했다." }];
const PROMPT_CONTEXT = { scopeKey: SCOPE };

function glossaryWithApplyUrls(applyUrls) {
  return glossaryCore.normalizeGlossary({
    libraries: [{ id: "lib-1", name: "骸骨皇女", enabled: true, urls: [], applyUrls }],
    entries: [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  });
}

function promptFor(glossary, context = PROMPT_CONTEXT) {
  return buildGlossaryJudgementPrompt(glossaryCore, glossary, ITEMS, context);
}

test("复现：应用网址非空 + 调用方只给 scopeKey ⇒ 术语整库丢掉", () => {
  forgetRequestContexts();
  // 全站生效（应用网址为空）：术语在提示词里
  assert.match(promptFor(glossaryWithApplyUrls([])), /莱昂纳多/u);
  // 点过「一键加入应用」之后：同一个库、同一页，术语却不见了 —— 模型只能自己发挥
  assert.equal(promptFor(glossaryWithApplyUrls([PAGE])), "",
    "这就是「加入应用之后术语被忽略」的根因");
});

test("记住本次请求的页面之后，术语回到提示词里（与校验器、统计用同一套上下文）", () => {
  forgetRequestContexts();
  rememberRequestContext(SCOPE, { pageUrl: PAGE, sourceLanguage: "auto", targetLanguage: "zh-CN" });
  const prompt = promptFor(glossaryWithApplyUrls([PAGE]));
  assert.match(prompt, /莱昂纳多/u, "补上 pageUrl 后应按页面范围正常注入");
  assert.match(prompt, /"source":"레오나르도"/u);
});

test("页面不在应用范围内时仍然不注入（补上下文不等于无脑放行）", () => {
  forgetRequestContexts();
  rememberRequestContext(SCOPE, { pageUrl: "https://page.kakao.com/content/11111111/viewer/1" });
  assert.equal(promptFor(glossaryWithApplyUrls([PAGE])), "");
});

test("记下来的上下文只补空缺，不覆盖调用方显式传入的值", () => {
  forgetRequestContexts();
  rememberRequestContext(SCOPE, { pageUrl: PAGE, sourceLanguage: "auto", targetLanguage: "zh-CN" });
  assert.equal(withRequestContext({ scopeKey: SCOPE, pageUrl: "https://example.com/" }).pageUrl,
    "https://example.com/");
  assert.equal(withRequestContext({ scopeKey: SCOPE }).pageUrl, PAGE);
  assert.equal(withRequestContext({ scopeKey: SCOPE }).targetLanguage, "zh-CN");
  assert.deepEqual(withRequestContext({ scopeKey: "别的作品" }), { scopeKey: "别的作品" },
    "没有记录就原样返回（对象引用不变）");
  assert.equal(withRequestContext(null), null);
  assert.deepEqual(requestContextFor(SCOPE), { pageUrl: PAGE, sourceLanguage: "auto", targetLanguage: "zh-CN" });
});

test("同一部作品只留最新一条，且最多记 20 部（不长期挂着无上限的作品表）", () => {
  forgetRequestContexts();
  rememberRequestContext("work-a", { pageUrl: "https://a/1" });
  rememberRequestContext("work-a", { pageUrl: "https://a/2" });
  assert.equal(requestContextFor("work-a").pageUrl, "https://a/2");
  for (let index = 0; index < 25; index += 1) {
    rememberRequestContext(`work-${index}`, { pageUrl: `https://x/${index}` });
  }
  assert.equal(requestContextFor("work-a"), null, "最早的应该被淘汰");
  assert.equal(requestContextFor("work-24").pageUrl, "https://x/24", "最新的要留着");
  assert.equal(rememberRequestContext("", { pageUrl: "https://y/" }), null, "没有 scopeKey 就不记");
});

test("安装器处理请求时先记上下文：提示词拿到页面，统计才与之一致", async () => {
  forgetRequestContexts();
  const { installTermUsageLocal } = await import("../extension/src/novel-mobile/term-usage-local.js");
  const glossary = glossaryWithApplyUrls([PAGE]);
  const runtime = {
    glossaryCore,
    getErrorMessage: error => String(error && error.message || error || ""),
    loadConfiguration: async () => ({ translation: { sourceLanguage: "auto", targetLanguage: "zh-CN" }, glossary }),
    // 模仿真正的处理器：它内部会用 buildPrompt(glossary, items, { scopeKey }) 构造术语前言
    handleTranslateNovelChunk: async (message = {}) => ({
      ok: true,
      prompt: buildGlossaryJudgementPrompt(glossaryCore, glossary, message.items, { scopeKey: message.scopeKey }),
      translations: [{ id: "p1", translated_text: "莱昂纳多说道。" }]
    })
  };
  installTermUsageLocal(runtime);
  const message = {
    scopeKey: SCOPE, pageUrl: PAGE, items: ITEMS,
    sourceLanguage: "auto", targetLanguage: "zh-CN"
  };
  const result = await runtime.handleTranslateNovelChunk(message, { tab: { url: PAGE } });
  assert.match(result.prompt, /莱昂纳多/u, "处理器内部的提示词也必须能看到这个库的术语");
  assert.equal(result.termUsage.injected, 1);
  assert.equal(result.termUsage.used, 1, "提示词里有了，模型才用得上");
  assert.deepEqual(result.termUsage.unused, []);
});
