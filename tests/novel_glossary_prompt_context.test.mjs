// 桌面版回归：术语前言必须拿到完整上下文（pageUrl + 语言对）。
//
// 用户实测：同一个术语库，应用网址为空（全站生效）时术语照用；点了「一键加入应用」
// 之后一大批术语被模型忽略、人名开始自己发挥。根因是 novel-translation.js 构造术语前言时
// 只传了 `{ scopeKey }`，而 shared/glossary.js 用 pageUrl 判定库的生效范围 ——
// 应用网址非空 + pageUrl 缺失 ⇒ 判为「本页不生效」⇒ 整库术语不进提示词。
//
// 这里用真实请求体（stub 掉 fetch）证明：提示词里到底有没有那几条术语。
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});

const PAGE = "https://page.kakao.com/content/69299983/viewer/11111111";
const OTHER = "https://page.kakao.com/content/11111111/viewer/1";
const ITEMS = [{ id: "p1", original_text: "레오나르도가 말했다." }];

function installMemoryStorage(applyUrls) {
  const stored = {
    mt_ocr_config_v1: {
      provider: "local_paddle",
      baidu: { apiKey: "", secretKey: "" },
      localPaddle: { baseUrl: "http://127.0.0.1:8765" }
    },
    mt_translation_config_v1: {
      provider: "openai_compatible",
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat"
    },
    mt_glossary_v2: {
      version: 4,
      libraries: [{ id: "lib-1", name: "骸骨皇女", enabled: true, urls: [], applyUrls }],
      entries: [{ id: "t1", source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
    }
  };
  context.chrome.runtime.lastError = null;
  context.chrome.storage.local.get = (keys, callback) => {
    const list = keys === null ? Object.keys(stored) : Array.isArray(keys) ? keys : [keys];
    callback(Object.fromEntries(list.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  context.chrome.storage.local.remove = (keys, callback) => {
    (Array.isArray(keys) ? keys : [keys]).forEach(key => delete stored[key]);
    callback();
  };
  return stored;
}

/** 捕获真实请求体（不走 test hook，否则提示词构造会被整段跳过）。 */
function capturePrompt() {
  const captured = { body: null };
  context.fetch = async (url, init) => {
    captured.body = JSON.parse(init.body);
    captured.url = String(url);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        id: "chatcmpl-test",
        model: "deepseek-chat",
        choices: [{
          message: { content: JSON.stringify({ translations: [{ id: "p1", translated_text: "莱昂纳多说道。" }] }) },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
      })
    };
  };
  return captured;
}

async function runChunk(applyUrls, pageUrl) {
  installMemoryStorage(applyUrls);
  const captured = capturePrompt();
  const response = await context.__backgroundTest.handleTranslateNovelChunk({
    scopeKey: "kakao:69299983",
    chapterId: "c1",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    items: ITEMS
  }, { tab: { url: pageUrl } });
  return { response, request: captured.body, prompt: captured.body.messages[1].content };
}

test("应用网址为空（全站生效）：术语进提示词", async () => {
  const { prompt } = await runChunk([], PAGE);
  assert.match(prompt, /"source":"레오나르도","target":"莱昂纳多"/u);
});

test("应用网址命中本页：术语必须照样进提示词（这就是修掉的那个 bug）", async () => {
  const { prompt, response } = await runChunk(["https://page.kakao.com/content/69299983/*"], PAGE);
  assert.match(prompt, /"source":"레오나르도","target":"莱昂纳多"/u,
    "命中应用网址的术语库，其术语必须出现在提示词里");
  assert.equal(response.ok, true);
  assert.equal(response.translations.length, 1);
});

test("应用网址不命中本页：术语仍然不注入（补上下文不等于无脑放行）", async () => {
  const { prompt } = await runChunk(["https://page.kakao.com/content/69299983/*"], OTHER);
  // 注意：不能拿原文韩文去判 —— Input 那一行本来就带着原文，永远能匹配到；
  // 要看的是**译名**有没有被注入。
  assert.equal(prompt.includes("莱昂纳多"), false);
});

test("提示词版本已 bump：旧缓存不会掩盖新的术语注入行为", async () => {
  assert.equal(context.__backgroundTest.NOVEL_TRANSLATION_PROMPT_VERSION, "kakao-novel-v5");
});

test("system 提示词钉住字形：目标是简体就不许输出繁体", async () => {
  const { request } = await runChunk([], PAGE);
  const system = request.messages[0].content;
  // 手机版靠这个开头识别「这条请求是小说翻译」，措辞不能改
  assert.ok(system.startsWith("You are a web-novel literary translator"));
  assert.match(system, /If the target is zh-CN, use Simplified Chinese characters/u);
  assert.match(system, /never Traditional characters \(繁體字\)/u);
  assert.match(system, /If the target is zh-TW, use Traditional characters only/u);
});

test("带术语时提示词要求逐条交代（用上 or 说明语境），并给出 terms 的 schema", async () => {
  const { prompt } = await runChunk([], PAGE);
  assert.match(prompt, /account for it in that item's `terms` object/u);
  assert.match(prompt, /Never leave a matching row unaccounted for/u);
  assert.match(prompt, /"terms":\{"used":\["…"\],"skipped":\[\{"source":"…","reason":"…"\}\]\}/u,
    "schema 要写清 used / skipped 两个字段");
  // 没有术语时不夹带这套规则：普通段落不该被它拖长或干扰
  const plain = await runChunk(["https://page.kakao.com/content/69299983/*"], OTHER);
  assert.equal(plain.prompt.includes("account for it in that item's `terms` object"), false,
    "应用网址不命中 → 没有术语 → 也不该出现术语交代规则");
});