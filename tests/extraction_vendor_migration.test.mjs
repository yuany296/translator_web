import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTRACTION_SECTIONS, migrateExtractionVendors, normalizeVendorsState
} from "../extension/src/config/vendors.js";
import { createConfigurationStore, resolveExtractionConfig } from "../extension/src/config/store.js";
import {
  normalizeSentenceExtractionConfig, normalizeTermExtractionConfig
} from "../extension/src/config/schema.js";

const TERM_KEY = "mt_term_extraction_config_v1";
const SENTENCE_KEY = "mt_sentence_extraction_config_v1";
const VENDORS_KEY = "mt_translation_vendors_v1";
const TRANSLATION_KEY = "mt_translation_config_v1";

const glossaryCore = {
  STORAGE_KEY: "mt_glossary_v1",
  LEGACY_STORAGE_KEY: "mt_glossary_legacy_v1",
  normalizeGlossary: value => value || { libraries: [], entries: [], revision: 0 },
  getFingerprint: () => "g4-test"
};

function memoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  let writes = 0;
  return {
    stored,
    writeCount: () => writes,
    storageGet: async keys => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])
    ),
    storageSet: async value => {
      writes += 1;
      Object.assign(stored, JSON.parse(JSON.stringify(value)));
    }
  };
}

function makeStore(initial) {
  const storage = memoryStorage(initial);
  const store = createConfigurationStore({
    storageGet: storage.storageGet,
    storageSet: storage.storageSet,
    glossaryCore
  });
  return { store, storage };
}

const TRANSLATION = {
  provider: "deepseek", apiKey: "sk-live", baseUrl: "https://api.deepseek.com", model: "deepseek-chat"
};

const LEGACY_OLLAMA = {
  followTranslation: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen2.5:7b", apiKey: ""
};

// ── 纯函数:migrateExtractionVendors ──

function migrate(sections, state, translation = TRANSLATION) {
  return migrateExtractionVendors({
    sections: {
      termExtraction: normalizeTermExtractionConfig(sections.termExtraction || {}),
      sentenceExtraction: normalizeSentenceExtractionConfig(sections.sentenceExtraction || {})
    },
    state: normalizeVendorsState(state),
    translation,
    translationConfigured: Boolean(translation.apiKey)
  });
}

test("库空且翻译服务配好了：播种「默认配置」并把还在跟随的小节指过去", () => {
  const result = migrate({ termExtraction: {}, sentenceExtraction: {} }, {});
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.state.vendors), ["默认配置"]);
  assert.equal(result.state.active, "默认配置");
  assert.equal(result.state.vendors["默认配置"].apiKey, "sk-live");
  assert.equal(result.sections.termExtraction.vendor, "默认配置");
  assert.equal(result.sections.sentenceExtraction.vendor, "默认配置");
  assert.equal(result.sections.termExtraction.followTranslation, false);
});

test("库空且翻译服务没配好：不动小节，旧存档继续按跟随解析", () => {
  const result = migrate({ termExtraction: {} }, {}, { provider: "deepseek", apiKey: "", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
  assert.equal(result.changed, false);
  assert.deepEqual(Object.keys(result.state.vendors), []);
  assert.equal(result.sections.termExtraction.vendor, "");
  assert.equal(result.sections.termExtraction.followTranslation, true);
});

test("旧版单独填过的提取配置：注册成命名配置、清掉旧地址密钥、值不丢", () => {
  const result = migrate({ termExtraction: LEGACY_OLLAMA, sentenceExtraction: LEGACY_OLLAMA }, {});
  assert.equal(result.changed, true);
  // 两块填的是同一份配置 → 只注册一条，两块都指向它
  assert.deepEqual(Object.keys(result.state.vendors).sort(), ["Ollama（本地） · 术语提取", "默认配置"]);
  const term = result.sections.termExtraction;
  assert.equal(term.vendor, "Ollama（本地） · 术语提取");
  assert.equal(term.baseUrl, "", "旧地址搬进配置库后不再留在小节里");
  assert.equal(term.apiKey, "");
  assert.equal(term.provider, "", "旧的 provider 也要清，否则归一化会把预设地址填回来");
  assert.equal(term.followTranslation, false);
  assert.equal(result.sections.sentenceExtraction.vendor, "Ollama（本地） · 术语提取", "同值配置复用同一条");
  assert.equal(result.state.vendors["Ollama（本地） · 术语提取"].baseUrl, "http://127.0.0.1:11434/v1");
  // 有效配置仍与迁移前一致
  const effective = resolveExtractionConfig(
    { translation: TRANSLATION, termExtraction: term, llmVendors: { vendors: result.state.vendors } },
    "termExtraction"
  );
  assert.equal(effective.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(effective.model, "qwen2.5:7b");
});

test("迁移可重复执行：已经迁移过的数据不再产生改动", () => {
  const first = migrate({ termExtraction: LEGACY_OLLAMA }, {});
  const second = migrateExtractionVendors({
    sections: first.sections,
    state: first.state,
    translation: TRANSLATION,
    translationConfigured: true
  });
  assert.equal(second.changed, false);
  assert.deepEqual(Object.keys(second.state.vendors).sort(), ["Ollama（本地） · 术语提取", "默认配置"]);
});

test("库里已有完全相同的条目时复用，不新增重复配置", () => {
  const existing = normalizeVendorsState({
    vendors: { "我的本地档": { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: "" } },
    active: "我的本地档"
  });
  const result = migrate({ termExtraction: LEGACY_OLLAMA }, existing);
  assert.deepEqual(Object.keys(result.state.vendors), ["我的本地档"]);
  assert.equal(result.sections.termExtraction.vendor, "我的本地档");
});

test("名称撞车时自动加序号，不覆盖已有配置", () => {
  const existing = normalizeVendorsState({
    vendors: { "Ollama（本地） · 术语提取": { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "k" } },
    active: "Ollama（本地） · 术语提取"
  });
  const result = migrate({ termExtraction: LEGACY_OLLAMA }, existing);
  assert.equal(result.sections.termExtraction.vendor, "Ollama（本地） · 术语提取 2");
  assert.equal(result.state.vendors["Ollama（本地） · 术语提取"].provider, "openai", "原有配置没被覆盖");
  assert.equal(result.state.vendors["Ollama（本地） · 术语提取 2"].provider, "ollama");
});

test("指向已不存在条目的小节按「没选过」处理，回到库里的激活配置", () => {
  const state = normalizeVendorsState({
    vendors: { 甲: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "m", apiKey: "k" } },
    active: "甲"
  });
  const result = migrate({ termExtraction: { vendor: "已经不在了" } }, state);
  assert.equal(result.sections.termExtraction.vendor, "甲");
  assert.equal(result.changed, true);
});

test("两块配置不同时各注册一条，命名带各自的用途后缀", () => {
  assert.equal(EXTRACTION_SECTIONS.termExtraction, "术语提取");
  assert.equal(EXTRACTION_SECTIONS.sentenceExtraction, "句子提取");
  const result = migrate({
    termExtraction: LEGACY_OLLAMA,
    sentenceExtraction: {
      followTranslation: false, provider: "openai",
      baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "k"
    }
  }, {});
  assert.deepEqual(Object.keys(result.state.vendors).sort(),
    ["Ollama（本地） · 术语提取", "OpenAI · 句子提取", "默认配置"]);
  assert.equal(result.sections.sentenceExtraction.vendor, "OpenAI · 句子提取");
});

// ── 集成:配置存储 ──

test("load() 落盘迁移结果、暴露 llmVendors，并且只写一次", async () => {
  const { store, storage } = makeStore({
    [TRANSLATION_KEY]: TRANSLATION,
    [TERM_KEY]: LEGACY_OLLAMA,
    [SENTENCE_KEY]: { followTranslation: true }
  });
  const configuration = await store.load();
  assert.equal(storage.stored[TERM_KEY].vendor, "Ollama（本地） · 术语提取");
  assert.equal(storage.stored[TERM_KEY].baseUrl, "");
  assert.equal(storage.stored[SENTENCE_KEY].vendor, "默认配置", "播种的默认配置被跟随的小节采纳");
  assert.equal(storage.stored[VENDORS_KEY].active, "默认配置");
  assert.deepEqual(Object.keys(configuration.llmVendors.vendors).sort(), ["Ollama（本地） · 术语提取", "默认配置"]);
  assert.equal(configuration.termExtraction.vendor, "Ollama（本地） · 术语提取", "存的是引用，不是解析后的值");
  assert.equal(storage.writeCount(), 1, "一次 load 只写一次");

  const before = storage.writeCount();
  const second = await store.load();
  assert.equal(storage.writeCount(), before, "迁移已幂等，第二次 load 不写盘");
  assert.deepEqual(Object.keys(second.llmVendors.vendors).sort(), ["Ollama（本地） · 术语提取", "默认配置"]);
});

test("保存配置时，还没选过配置的提取小节自动用上它；已选定的不动", async () => {
  const { store, storage } = makeStore({
    [TRANSLATION_KEY]: TRANSLATION,
    [TERM_KEY]: { followTranslation: false, vendor: "老档" },
    [SENTENCE_KEY]: {}
  });
  await store.saveTranslationVendor("新档", { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "k1" });
  assert.equal(storage.stored[TERM_KEY].vendor, "老档", "已选定的引用不动");
  assert.equal(storage.stored[SENTENCE_KEY].vendor, "新档", "没选过的自动采纳");
});

test("改名同步引用旧名的提取小节", async () => {
  const { store, storage } = makeStore({
    [TRANSLATION_KEY]: TRANSLATION,
    [VENDORS_KEY]: {
      vendors: { 老档: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k" } },
      active: "老档"
    },
    [TERM_KEY]: { followTranslation: false, vendor: "老档" },
    [SENTENCE_KEY]: { followTranslation: false, vendor: "老档" }
  });
  await store.saveTranslationVendor(
    "新档",
    { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k2" },
    "老档"
  );
  assert.equal(storage.stored[TERM_KEY].vendor, "新档");
  assert.equal(storage.stored[SENTENCE_KEY].vendor, "新档");
  assert.deepEqual(Object.keys(storage.stored[VENDORS_KEY].vendors), ["新档"]);
  assert.equal(storage.stored[VENDORS_KEY].active, "新档");
});

test("删除被引用的配置时重指到剩余配置，全删光才清空", async () => {
  const { store, storage } = makeStore({
    [TRANSLATION_KEY]: TRANSLATION,
    [VENDORS_KEY]: {
      vendors: {
        甲: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "m", apiKey: "k" },
        乙: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "g", apiKey: "k" }
      },
      active: "甲"
    },
    [TERM_KEY]: { followTranslation: false, vendor: "乙" }
  });
  await store.deleteTranslationVendor("乙");
  assert.equal(storage.stored[TERM_KEY].vendor, "甲", "重指到剩余的激活配置");

  await store.deleteTranslationVendor("甲");
  assert.equal(storage.stored[TERM_KEY].vendor, "", "一条都不剩就清空，提取随之不可用");
  const configuration = await store.load();
  assert.equal(resolveExtractionConfig(configuration, "termExtraction").baseUrl, "");
});
