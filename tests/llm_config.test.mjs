import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TERM_EXTRACTION_CONFIG,
  normalizeTermExtractionConfig,
  normalizeSentenceExtractionConfig,
  normalizeTranslationConfig
} from "../extension/src/config/schema.js";
import llmProviders from "../extension/src/shared/llm-providers.js";

test("llm provider presets cover the Android app vendor list plus local ollama", () => {
  assert.deepEqual(llmProviders.LLM_PROVIDERS.map(provider => provider.id),
    ["openai", "qwen", "glm", "deepseek", "kimi", "siliconflow", "volces", "custom", "ollama"]);
  assert.equal(llmProviders.getProvider("ollama").needsKey, false);
  assert.equal(llmProviders.getProvider("openai").needsKey, true);
  assert.equal(llmProviders.getProvider("deepseek").defaultModel, "deepseek-chat");
  assert.equal(llmProviders.getProvider("qwen").baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(llmProviders.getProvider("glm").baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(llmProviders.getProvider("kimi").baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(llmProviders.getProvider("siliconflow").baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(llmProviders.getProvider("volces").baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(llmProviders.inferProviderId("http://127.0.0.1:11434/v1"), "ollama");
  assert.equal(llmProviders.inferProviderId("https://api.deepseek.com"), "deepseek");
  assert.equal(llmProviders.inferProviderId("https://api.openai.com/v1"), "openai");
  assert.equal(llmProviders.inferProviderId("https://dashscope.aliyuncs.com/compatible-mode/v1"), "qwen");
  assert.equal(llmProviders.inferProviderId("https://open.bigmodel.cn/api/paas/v4"), "glm");
  assert.equal(llmProviders.inferProviderId("https://api.moonshot.cn/v1"), "kimi");
  assert.equal(llmProviders.inferProviderId("https://api.siliconflow.cn/v1"), "siliconflow");
  assert.equal(llmProviders.inferProviderId("https://ark.cn-beijing.volces.com/api/v3"), "volces");
  assert.equal(llmProviders.inferProviderId("https://my-proxy.example.com/v1"), "custom");
});

test("term extraction config defaults to empty provider (sentence mode)", () => {
  const config = normalizeTermExtractionConfig({});
  assert.equal(config.provider, "");
  assert.equal(config.baseUrl, "");
  assert.equal(config.model, DEFAULT_TERM_EXTRACTION_CONFIG.model);
  assert.equal(config.apiKey, "");
});

test("term extraction config infers provider from base URL", () => {
  const config = normalizeTermExtractionConfig({ baseUrl: "http://127.0.0.1:11434/v1" });
  assert.equal(config.provider, "ollama");
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
});

test("term extraction config fills preset URL when only provider is chosen", () => {
  const config = normalizeTermExtractionConfig({ provider: "deepseek", model: "deepseek-chat" });
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.equal(config.model, "deepseek-chat");
});

test("custom provider keeps the caller-supplied base URL", () => {
  const config = normalizeTermExtractionConfig({
    provider: "custom", baseUrl: "https://my-proxy.example.com/v1", model: "qwen"
  });
  assert.equal(config.provider, "custom");
  assert.equal(config.baseUrl, "https://my-proxy.example.com/v1");
});

test("sentence extraction config mirrors the term extraction schema", () => {
  const config = normalizeSentenceExtractionConfig({ provider: "ollama" });
  assert.equal(config.provider, "ollama");
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
  const empty = normalizeSentenceExtractionConfig({});
  assert.equal(empty.provider, "");
  assert.equal(empty.baseUrl, "");
});

test("legacy translation config infers its provider from base URL", () => {
  const legacy = normalizeTranslationConfig({
    baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k",
    sourceLanguage: "ko", targetLanguage: "zh-CN"
  });
  assert.equal(legacy.provider, "deepseek");
  assert.equal(legacy.baseUrl, "https://api.deepseek.com");
  const ollama = normalizeTranslationConfig({
    baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b",
    sourceLanguage: "ko", targetLanguage: "zh-CN"
  });
  assert.equal(ollama.provider, "ollama");
  const custom = normalizeTranslationConfig({
    baseUrl: "https://my-proxy.example.com/v1", model: "qwen",
    sourceLanguage: "ko", targetLanguage: "zh-CN"
  });
  assert.equal(custom.provider, "custom");
});

test("explicit translation provider wins over base URL inference", () => {
  const config = normalizeTranslationConfig({
    provider: "openai", baseUrl: "https://api.deepseek.com", model: "gpt-4o-mini",
    apiKey: "k", sourceLanguage: "ko", targetLanguage: "zh-CN"
  });
  assert.equal(config.provider, "openai");
});

test("api keys are stored per provider and the active key is selected", () => {
  const config = normalizeTranslationConfig({
    provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat",
    apiKeys: { openai: "sk-openai", deepseek: "sk-deepseek" },
    sourceLanguage: "ko", targetLanguage: "zh-CN"
  });
  assert.equal(config.apiKey, "sk-deepseek");
  assert.equal(config.apiKeys.openai, "sk-openai");
  assert.equal(config.apiKeys.deepseek, "sk-deepseek");
});

test("legacy apiKey migrates into the inferred provider slot", () => {
  const config = normalizeTranslationConfig({
    baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "legacy-key",
    sourceLanguage: "ko", targetLanguage: "zh-CN"
  });
  assert.equal(config.apiKey, "legacy-key");
  assert.equal(config.apiKeys.deepseek, "legacy-key");
});

test("term extraction api keys are per provider too", () => {
  const config = normalizeTermExtractionConfig({
    provider: "ollama",
    apiKeys: { ollama: "", openai: "sk-openai" }
  });
  assert.equal(config.apiKeys.openai, "sk-openai");
  assert.equal(config.apiKey, "");
});

test("keyRequired only asks for a key on providers that need one", () => {
  // 免密钥本地服务必须放行，否则 Ollama/本地兼容服务永远无法翻译
  assert.equal(llmProviders.keyRequired("ollama"), false);
  assert.equal(llmProviders.keyRequired("custom"), false);
  assert.equal(llmProviders.keyRequired("deepseek"), true);
  assert.equal(llmProviders.keyRequired("qwen"), true);
  assert.equal(llmProviders.keyRequired("volces"), true);
  // 未知/空 id 与 providers/translation.js 的 validate() 语义一致：不强制密钥
  assert.equal(llmProviders.keyRequired(""), false);
  assert.equal(llmProviders.keyRequired(undefined), false);
});
