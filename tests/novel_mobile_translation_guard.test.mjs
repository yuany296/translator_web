import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  LANGUAGE_PURITY_RULE,
  NOVEL_SYSTEM_MARKER,
  installTranslationGuardLocal,
  isNovelTranslationBody,
  targetLanguageOf,
  withLanguagePurityRule
} from "../extension/src/novel-mobile/translation-guard-local.js";

// 手机版在请求出口补的「整段都必须是目标语言」规则。
// 它靠 system 提示词里的一句话识别「这是小说翻译」，所以下面有一条测试盯着那句话还在不在：
// 上游一旦改写措辞，规则会静默失效（代码不报错、译文又开始夹原文），必须在这里挡住。
function novelBody(extra = {}) {
  return {
    model: "deepseek-chat",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a web-novel literary translator and continuity editor. Return strict JSON only." },
      { role: "user", content: "Input: []" }
    ],
    ...extra
  };
}

function mangaBody() {
  return {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "You translate manga speech bubbles. Return strict JSON only." },
      { role: "user", content: "Input: []" }
    ]
  };
}

test("上游的小说 system 提示词还在（识别标记失效会让这条规则静默消失）", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "extension", "src", "background", "modules", "novel-translation.js"),
    "utf8"
  );
  assert.ok(source.includes(NOVEL_SYSTEM_MARKER), `novel-translation.js 里找不到「${NOVEL_SYSTEM_MARKER}」`);
});

test("小说请求会被追加语言规则：禁止照抄原文、禁止原样返回", () => {
  const body = withLanguagePurityRule(novelBody());
  const system = body.messages[0].content;
  assert.ok(system.includes(LANGUAGE_PURITY_RULE));
  assert.match(system, /Never leave source-language spelling/u);
  assert.match(system, /never return an input unchanged/u);
  assert.match(system, /transliterate it into the target language/u);
  assert.ok(system.startsWith("You are a web-novel literary translator"), "原提示词必须保留在前面（前缀缓存）");
  assert.equal(body.messages[1].content, "Input: []", "user 消息不动");
});

test("从提示词里读出目标语言，并补上字形约束（简体不许漂成繁体）", () => {
  // 提示词模板是 `... into zh-CN.` —— 只给代码时模型偶尔会输出繁体，这里必须说清字形
  const simplified = withLanguagePurityRule(novelBody({
    messages: [
      { role: "system", content: "You are a web-novel literary translator and continuity editor. Return strict JSON only." },
      { role: "user", content: "Translate this web-novel passage from auto-detected source language into zh-CN.\nInput: []" }
    ]
  }));
  assert.equal(targetLanguageOf(simplified), "zh-CN");
  assert.match(simplified.messages[0].content, /Simplified Chinese \(简体中文\)/u);
  assert.match(simplified.messages[0].content, /never Traditional characters \(繁體字\)/u);
  const traditional = withLanguagePurityRule(novelBody({
    messages: [
      { role: "system", content: "You are a web-novel literary translator and continuity editor. Return strict JSON only." },
      { role: "user", content: "Translate this web-novel passage from auto-detected source language into zh-TW.\nInput: []" }
    ]
  }));
  assert.equal(targetLanguageOf(traditional), "zh-TW");
  assert.match(traditional.messages[0].content, /Traditional Chinese \(繁體中文\)/u);
  assert.match(traditional.messages[0].content, /never Simplified characters \(简体字\)/u);
});

test("只补过通用规则的老请求再补一次：字形约束插在它前面且保持幂等", () => {
  const body = novelBody({
    messages: [
      { role: "system", content: `You are a web-novel literary translator. ${LANGUAGE_PURITY_RULE}` },
      { role: "user", content: "into zh-CN.\nInput: []" }
    ]
  });
  withLanguagePurityRule(body);
  const once = body.messages[0].content;
  assert.match(once, /Simplified Chinese \(简体中文\)/u);
  assert.equal(once.split(LANGUAGE_PURITY_RULE).length - 1, 1, "通用规则只能出现一次");
  withLanguagePurityRule(body);
  assert.equal(body.messages[0].content, once);
});

test("追加是幂等的：同一请求被重试两次也只多一句", () => {
  const body = novelBody();
  withLanguagePurityRule(body);
  const once = body.messages[0].content;
  withLanguagePurityRule(body);
  assert.equal(body.messages[0].content, once);
  assert.equal(once.split(LANGUAGE_PURITY_RULE).length - 1, 1);
});

test("漫画/网页等其它请求体原样放行", () => {
  assert.equal(isNovelTranslationBody(mangaBody()), false);
  const body = mangaBody();
  const before = body.messages[0].content;
  assert.equal(withLanguagePurityRule(body).messages[0].content, before);
  assert.equal(isNovelTranslationBody(null), false);
  assert.equal(isNovelTranslationBody({}), false);
  assert.equal(isNovelTranslationBody({ messages: "nope" }), false);
});

test("出口包装只改小说请求，参数与返回值原样透传", async () => {
  const seen = [];
  const runtime = {
    sendOpenAICompatibleTranslationRequest: async (endpoint, apiKey, body, timeoutMs, options) => {
      seen.push({ endpoint, apiKey, body, timeoutMs, options });
      return { content: "{}" };
    }
  };
  installTranslationGuardLocal(runtime);
  const options = { includeResponseMeta: true, signal: null };
  const novel = await runtime.sendOpenAICompatibleTranslationRequest("https://api/x", "k", novelBody(), 90_000, options);
  assert.deepEqual(novel, { content: "{}" });
  assert.equal(seen[0].endpoint, "https://api/x");
  assert.equal(seen[0].timeoutMs, 90_000);
  assert.equal(seen[0].options, options);
  assert.ok(seen[0].body.messages[0].content.includes(LANGUAGE_PURITY_RULE));
  await runtime.sendOpenAICompatibleTranslationRequest("https://api/x", "k", mangaBody(), 90_000, options);
  assert.equal(seen[1].body.messages[0].content.includes(LANGUAGE_PURITY_RULE), false);
});

test("缺少发送函数时安装器不报错（页面被单独加载也不会炸）", () => {
  assert.deepEqual(installTranslationGuardLocal({}), {});
  assert.equal(installTranslationGuardLocal(null), null);
});
