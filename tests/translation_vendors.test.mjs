import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  applyVendorEntry, normalizeVendorEntry, normalizeVendorsState, overlayVendorEntry
} from "../extension/src/config/vendors.js";

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

function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.runtime.lastError = null;
  context.chrome.storage.local.get = (keys, callback) => {
    if (keys === null) return callback({ ...stored });
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

const hostArray = value => [...value];

// ── 纯函数 ──

test("normalizeVendorEntry 只保留服务商字段与思考模式并归一化", () => {
  const entry = normalizeVendorEntry({ provider: "deepseek", baseUrl: "https://api.deepseek.com/", model: "deepseek-chat", apiKey: "k", sourceLanguage: "ja" });
  assert.deepEqual(Object.keys(entry).sort(), ["apiKey", "baseUrl", "model", "provider", "thinkingMode"]);
  assert.equal(entry.baseUrl, "https://api.deepseek.com", "去掉尾部斜杠");
  assert.equal(entry.model, "deepseek-chat");
  // 思考模式属于「这一套配置」：换服务商就得跟着换，所以它进条目；语言不属于，仍然留在翻译小节
  assert.equal(entry.thinkingMode, "auto", "老条目没有这个字段 → 跟随模型默认");
  assert.equal(normalizeVendorEntry({ provider: "deepseek", thinkingMode: "off" }).thinkingMode, "off");
  assert.equal(normalizeVendorEntry({ provider: "deepseek", thinkingMode: "胡说" }).thinkingMode, "auto");
});

test("思考模式随配置档案下发：翻译与两个提取服务都拿到同一份", () => {
  const entry = { provider: "custom", baseUrl: "https://relay.test", model: "m", apiKey: "k", thinkingMode: "off" };
  assert.equal(applyVendorEntry({}, entry).thinkingMode, "off");
  // 提取小节走 overlayVendorEntry：vendor/followTranslation 保留，思考模式跟着条目走
  const section = overlayVendorEntry({ vendor: "甲", followTranslation: false, thinkingMode: "on" }, entry);
  assert.equal(section.thinkingMode, "off");
  assert.equal(section.vendor, "甲");
  assert.equal(section.followTranslation, false);
  // 反过来也必须成立：条目说跟随默认时，不能把小节自己留的旧值带出去
  const inherited = overlayVendorEntry({ vendor: "甲" }, { ...entry, thinkingMode: "auto" });
  assert.equal(inherited.thinkingMode, "auto");
});

test("normalizeVendorsState 过滤无效条目并剔除失效指针", () => {
  const state = normalizeVendorsState({
    vendors: { 甲: { provider: "deepseek", model: "m1" }, "": { provider: "openai" }, 乙: null },
    active: "不存在的配置"
  });
  assert.deepEqual(Object.keys(state.vendors), ["甲"]);
  assert.equal(state.active, "");
});

test("applyVendorEntry 覆盖服务商字段并保留语言", () => {
  const translation = applyVendorEntry(
    { sourceLanguage: "ja", targetLanguage: "zh-CN", model: "old" },
    { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "new-key" }
  );
  assert.equal(translation.sourceLanguage, "ja");
  assert.equal(translation.targetLanguage, "zh-CN");
  assert.equal(translation.model, "gpt-4o-mini");
  assert.equal(translation.provider, "openai");
  assert.equal(translation.apiKey, "new-key");
});

test("applyVendorEntry 对自身服务商槽位有最终决定权", () => {
  // 同一服务商的旧槽位不能压过条目里新填的密钥/地址/模型
  const updated = applyVendorEntry(
    {
      provider: "deepseek", apiKey: "old-key", baseUrl: "https://api.deepseek.com", model: "old-model",
      apiKeys: { deepseek: "old-key", qwen: "qwen-key" },
      baseUrls: { deepseek: "https://api.deepseek.com" },
      models: { deepseek: "old-model" }
    },
    { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "new-key" }
  );
  assert.equal(updated.apiKey, "new-key");
  assert.equal(updated.model, "deepseek-chat");
  assert.equal(updated.apiKeys.deepseek, "new-key");
  assert.equal(updated.apiKeys.qwen, "qwen-key", "其他服务商的槽位不受影响");
  // 免密钥本地服务商:条目允许空密钥,解析结果就是空密钥
  const local = applyVendorEntry(
    { provider: "deepseek", apiKey: "old-key", apiKeys: { deepseek: "old-key" } },
    { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "translategemma:12b", apiKey: "" }
  );
  assert.equal(local.provider, "ollama");
  assert.equal(local.apiKey, "");
  assert.equal(local.apiKeys.ollama, "");
  assert.equal(local.apiKeys.deepseek, "old-key");
});

// ── 集成:消息层 ──

test("未保存厂商配置时保持旧行为", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  const state = await background.handleMessage({ type: "GET_TRANSLATION_VENDORS" }, {});
  assert.equal(state.ok, true);
  assert.deepEqual(hostArray(state.names), []);
  assert.equal(state.active, "");
  assert.deepEqual(Object.keys(state.entries || {}), [], "无条目时 entries 为空对象");
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "deepseek-chat");
});

test("GET_TRANSLATION_VENDORS 返回 entries 供编辑回填", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "回填档",
    entry: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "secret" }
  }, {});
  const state = await background.handleMessage({ type: "GET_TRANSLATION_VENDORS" }, {});
  assert.deepEqual(hostArray(state.names), ["回填档"]);
  assert.equal(state.entries["回填档"].provider, "deepseek");
  assert.equal(state.entries["回填档"].baseUrl, "https://api.deepseek.com");
  assert.equal(state.entries["回填档"].model, "deepseek-chat");
  assert.equal(state.entries["回填档"].apiKey, "secret");
});

test("SAVE_TRANSLATION_VENDOR 保存命名配置并激活,legacy 同步生效", async () => {
  const background = context.__backgroundTest;
  const storage = installMemoryStorage(separatedConfiguration());
  const saved = await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR",
    name: "DeepSeek 日常",
    entry: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "new-key" }
  }, {});
  assert.equal(saved.ok, true);
  assert.equal(saved.name, "DeepSeek 日常");
  let state = await background.handleMessage({ type: "GET_TRANSLATION_VENDORS" }, {});
  assert.deepEqual(hostArray(state.names), ["DeepSeek 日常"]);
  assert.equal(state.active, "DeepSeek 日常");
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "deepseek-chat");
  assert.equal(configuration.configuration.translation.apiKey, "new-key");
  assert.equal(storage.mt_translation_config_v1.apiKey, "new-key", "legacy 翻译键同步");
});

test("ACTIVATE_TRANSLATION_VENDOR 切换配置立即生效", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "A 档",
    entry: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "model-a", apiKey: "key-a" }
  }, {});
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "B 档",
    entry: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "model-b", apiKey: "key-b" }
  }, {});
  let configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "model-b");
  assert.equal(configuration.configuration.translation.provider, "openai");
  await background.handleMessage({ type: "ACTIVATE_TRANSLATION_VENDOR", name: "A 档" }, {});
  configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "model-a");
  assert.equal(configuration.configuration.translation.provider, "deepseek");
});

test("RENAME_TRANSLATION_VENDOR 同步激活指针", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "旧名",
    entry: { provider: "deepseek", model: "m1" }
  }, {});
  const renamed = await background.handleMessage({ type: "RENAME_TRANSLATION_VENDOR", oldName: "旧名", newName: "新名" }, {});
  assert.equal(renamed.ok, true);
  const state = await background.handleMessage({ type: "GET_TRANSLATION_VENDORS" }, {});
  assert.deepEqual(hostArray(state.names), ["新名"]);
  assert.equal(state.active, "新名");
});

test("DELETE_TRANSLATION_VENDOR 删除激活条目后切到剩余配置", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "A 档",
    entry: { provider: "deepseek", model: "model-a" }
  }, {});
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "B 档",
    entry: { provider: "openai", model: "model-b" }
  }, {});
  const deleted = await background.handleMessage({ type: "DELETE_TRANSLATION_VENDOR", name: "B 档" }, {});
  assert.equal(deleted.ok, true);
  assert.equal(deleted.state.active, "A 档");
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "model-a");
});

test("保存翻译配置时同步当前激活条目", async () => {
  const background = context.__backgroundTest;
  const storage = installMemoryStorage(separatedConfiguration());
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "工作档",
    entry: { provider: "deepseek", model: "m1" }
  }, {});
  await background.handleMessage({
    type: "SAVE_CONFIGURATION",
    section: "translation",
    value: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "m2", apiKey: "edited-key" }
  }, {});
  const state = await background.handleMessage({ type: "GET_TRANSLATION_VENDORS" }, {});
  assert.equal(state.active, "工作档");
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "m2");
  assert.equal(configuration.configuration.translation.apiKey, "edited-key");
  assert.equal(storage.mt_translation_config_v1.model, "m2");
});

test("删除全部命名配置后恢复首次保存前的翻译配置", async () => {
  const background = context.__backgroundTest;
  const storage = installMemoryStorage(separatedConfiguration());
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "临时档",
    entry: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "other-model", apiKey: "other-key" }
  }, {});
  assert.equal(storage.mt_translation_config_v1.apiKey, "other-key", "激活条目覆盖 legacy");
  const deleted = await background.handleMessage({ type: "DELETE_TRANSLATION_VENDOR", name: "临时档" }, {});
  assert.equal(deleted.ok, true);
  assert.deepEqual(hostArray(deleted.state.names), []);
  assert.equal(deleted.state.active, "");
  // 恢复为首次保存前(separatedConfiguration)的配置
  assert.equal(storage.mt_translation_config_v1.model, "deepseek-chat");
  assert.equal(storage.mt_translation_config_v1.apiKey, "translation-key");
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.model, "deepseek-chat");
});

test("同一服务商重新填写密钥时新密钥生效", async () => {
  const background = context.__backgroundTest;
  const storage = installMemoryStorage(separatedConfiguration());
  const entry = { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "日常档", entry: { ...entry, apiKey: "old-key" }
  }, {});
  assert.equal(storage.mt_translation_config_v1.apiKey, "old-key");
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "日常档", entry: { ...entry, apiKey: "new-key" }
  }, {});
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.apiKey, "new-key");
  assert.equal(configuration.configuration.translation.apiKeys.deepseek, "new-key");
  assert.equal(storage.mt_translation_config_v1.apiKey, "new-key");
});

test("免密钥本地服务商档案可以真正发起翻译", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration({ translationApiKey: "" }));
  const saved = await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "本地 Ollama",
    entry: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "translategemma:12b", apiKey: "" }
  }, {});
  assert.equal(saved.ok, true);
  const configuration = await background.handleMessage({ type: "GET_CONFIGURATION" }, {});
  assert.equal(configuration.configuration.translation.provider, "ollama");
  assert.equal(configuration.configuration.translation.apiKey, "");
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({ items }) =>
      items.map(item => ({ id: item.id, translated_text: `译:${item.original_text}` }))
  });
  try {
    const response = await background.handleTranslateTextBlocks({
      mode: "webpage", sourceLanguage: "ko", targetLanguage: "zh-CN",
      items: [{ id: "webpage-0", original_text: "본문 바로가기" }]
    });
    assert.equal(response.ok, true);
    assert.equal(response.errors.length, 0);
    assert.deepEqual(hostArray(response.translations).map(row => row.translated_text), ["译:본문 바로가기"]);
  } finally {
    background.setBackgroundTestHooks(null);
  }
});

test("需要密钥的服务商缺 Key 时给出可定位的中文提示", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration({ translationApiKey: "" }));
  await background.handleMessage({
    type: "SAVE_TRANSLATION_VENDOR", name: "DeepSeek 空档",
    entry: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" }
  }, {});
  const response = await background.handleTranslateTextBlocks({
    mode: "webpage", sourceLanguage: "ko", targetLanguage: "zh-CN",
    items: [{ id: "webpage-0", original_text: "본문 바로가기" }]
  });
  assert.equal(response.ok, false);
  assert.match(response.errors[0].error, /翻译 API Key 未配置/u);
  assert.match(response.errors[0].error, /DeepSeek/u);
});
