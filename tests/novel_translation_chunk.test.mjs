// novel-translation 逐段补救回归测试：整体请求失败重试过一次后，校验缺段仍必须触发逐段补翻。
// 复用 background.iife.js + backgroundTestHooks 的既有测试写法（与 background_runtime.part03 一致）。
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = {
  addListener() {}
};
const context = vm.createContext({
  chrome: {
    runtime: {
      onInstalled: listeners,
      onStartup: listeners,
      onMessage: listeners
    },
    tabs: {},
    storage: {
      local: {}
    }
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
function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.runtime.lastError = null;
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
function separatedConfiguration({ translationApiKey = "test-key" } = {}) {
  return {
    mt_ocr_config_v1: {
      provider: "local_paddle",
      baidu: { apiKey: "", secretKey: "" },
      localPaddle: { baseUrl: "http://127.0.0.1:8765" }
    },
    mt_translation_config_v1: {
      provider: "openai_compatible",
      apiKey: translationApiKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat"
    }
  };
}
test("novel chunk retry recovers a merged missing segment even after the request was retried", async () => {
  installMemoryStorage(separatedConfiguration({ translationApiKey: "test-key" }));
  let calls = 0;
  context.__backgroundTest.setBackgroundTestHooks({
    requestNovelChunk({ items }) {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      if (calls === 2) {
        // 整体重试仍模拟模型合并相邻段：只回 p1 的译文，p2 缺失。
        return { translations: [{ id: "p1", translated_text: "第一段的独立译文，先出现。" }] };
      }
      // 逐段补救：返回本次请求段落自己的译文。
      return { translations: [{ id: items[0].id, translated_text: "补齐后的独立译文。" }] };
    }
  });
  const response = await context.__backgroundTest.handleTranslateNovelChunk({
    scopeKey: "kakao:merge-regression",
    chapterId: "merged-missing",
    items: [
      { id: "p1", original_text: "첫째 문장입니다." },
      { id: "p2", original_text: "둘째 문장입니다." }
    ]
  });
  // 提示词版本必须随提示词语义变更 bump，旧缓存才不会掩盖新提示词行为。
  // v3 = 把对话引号规则写死到字符级并给正反例（v2 = 防合并规则）。
  // v4 = 删除跨话小说记忆，模型只返回 translations。
  assert.equal(context.__backgroundTest.NOVEL_TRANSLATION_PROMPT_VERSION, "kakao-novel-v4");
  assert.equal(response.partial, false);
  assert.equal(response.errors.length, 0);
  // vm 跨 realm 数组原型不同，不能直接 deepEqual：用 join 比较顺序。
  assert.equal(response.translations.map(row => row.id).join(","), "p1,p2");
  assert.equal(calls, 3);
  context.__backgroundTest.setBackgroundTestHooks(null);
});
