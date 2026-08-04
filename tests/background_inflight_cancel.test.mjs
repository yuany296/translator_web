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
  DOMException,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});

function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.storage.local.get = (keys, callback) => {
    if (keys === null) {
      callback({ ...stored });
      return;
    }
    const list = Array.isArray(keys) ? keys : [keys];
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

function separatedConfiguration({ translationApiKey = "translation-key" } = {}) {
  return {
    mt_ocr_config_v1: { provider: "local_paddle", baidu: {}, localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_translation_config_v1: {
      provider: "openai_compatible",
      apiKey: translationApiKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat"
    }
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const SHARED_ITEMS = [{ id: "shared-1", revision: 1, original_text: "공유 문장" }];

function stubFetch(background) {
  const state = { fetchCount: 0, signalHolder: null, resolvers: [] };
  background.sendOpenAICompatibleTranslationRequest = async (endpoint, apiKey, body, timeout, opts) => {
    state.fetchCount += 1;
    state.signalHolder = opts && opts.signal;
    if (state.signalHolder && state.signalHolder.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise(resolve => {
      state.resolvers.push(resolve);
    });
    if (state.signalHolder && state.signalHolder.aborted) throw new DOMException("aborted", "AbortError");
    return JSON.stringify({ translations: [{ id: "canonical-request-0", translated_text: "译文" }] });
  };
  state.releaseAll = () => {
    for (const resolve of state.resolvers.splice(0)) resolve();
  };
  return state;
}

test("two tasks sharing one request: canceling the first leaves the second intact", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  const fetch = stubFetch(background);
  const pA = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-A", items: SHARED_ITEMS });
  const pB = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-B", items: SHARED_ITEMS });
  await tick();
  await tick();
  assert.equal(fetch.fetchCount, 1, "两个任务必须共享同一个底层请求");
  await background.handleCancelTranslationTask({ taskId: "task-A" });
  await tick();
  assert.equal(fetch.signalHolder.aborted, false, "B 仍在订阅，共享请求不能被 abort");
  fetch.releaseAll();
  const [ra, rb] = await Promise.all([pA, pB]);
  assert.equal(rb.ok, true, "未取消的任务收到译文");
  assert.equal(rb.translations.length, 1);
  assert.equal(rb.translations[0].translated_text, "译文");
  assert.equal(rb.cancelled, undefined);
  assert.equal(ra.cancelled, undefined, "共享请求成功完成，已取消任务也不产生普通错误");
  assert.equal(background.inflightTranslationByFingerprint.size, 0, "完成后 in-flight map 清理");
});

test("shared request is aborted only when every subscriber cancels", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  const fetch = stubFetch(background);
  const pC = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-C", items: SHARED_ITEMS });
  const pD = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-D", items: SHARED_ITEMS });
  await tick();
  await tick();
  assert.equal(fetch.fetchCount, 1);
  await background.handleCancelTranslationTask({ taskId: "task-C" });
  await tick();
  assert.equal(fetch.signalHolder.aborted, false);
  await background.handleCancelTranslationTask({ taskId: "task-D" });
  await tick();
  assert.equal(fetch.signalHolder.aborted, true, "最后一个订阅者取消后底层请求才被 abort");
  fetch.releaseAll();
  const [rc, rd] = await Promise.all([pC, pD]);
  assert.equal(rc.cancelled, true, "被取消任务返回 cancelled 而非普通错误");
  assert.equal(rd.cancelled, true);
  assert.equal(background.inflightTranslationByFingerprint.size, 0);
});

test("unrelated fingerprints do not share a request", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  const fetch = stubFetch(background);
  const pE = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-E", items: [{ id: "e1", revision: 1, original_text: "문장 하나" }] });
  const pF = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-F", items: [{ id: "f1", revision: 1, original_text: "완전 다른 문장" }] });
  await tick();
  await tick();
  assert.equal(fetch.fetchCount, 2, "不同原文各自独立请求");
  fetch.releaseAll();
  await Promise.all([pE, pF]);
});

test("completed request cleans subscribers and controller bindings", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  const fetch = stubFetch(background);
  const pG = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-G", items: SHARED_ITEMS });
  const pH = background.handleTranslateTextBlocks({ sourceLanguage: "ko", targetLanguage: "zh-CN", mode: "comic", taskId: "task-H", items: SHARED_ITEMS });
  await tick();
  await tick();
  fetch.releaseAll();
  await Promise.all([pG, pH]);
  assert.equal(background.inflightTranslationByFingerprint.size, 0);
  // 取消已完成任务不应影响任何东西（幂等）
  const after = await background.handleCancelTranslationTask({ taskId: "task-G" });
  assert.equal(after.cancelled, 0);
});
