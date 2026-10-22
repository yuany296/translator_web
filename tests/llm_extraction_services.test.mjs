import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  normalizeSentenceExtractionConfig, normalizeTermExtractionConfig,
  normalizeRuntimeConfig, normalizeTranslationConfig
} from "../extension/src/config/schema.js";
import { resolveExtractionConfig } from "../extension/src/config/store.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const TRANSLATION = normalizeTranslationConfig({
  provider: "deepseek",
  apiKey: "sk-translation",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat"
});

function configurationWith(sections, translation = TRANSLATION) {
  return { translation, llmVendors: { vendors: sections.vendors || {}, active: sections.active || "" }, ...sections.configuration };
}

test("提取小节默认没有选定配置，两个开关默认打开", () => {
  assert.equal(normalizeTermExtractionConfig({}).vendor, "");
  assert.equal(normalizeSentenceExtractionConfig({}).vendor, "");
  assert.equal(normalizeTermExtractionConfig({ vendor: "DeepSeek 日常" }).vendor, "DeepSeek 日常");
  assert.equal(normalizeSentenceExtractionConfig({ vendor: "本地 Ollama" }).vendor, "本地 Ollama");
  assert.equal(normalizeRuntimeConfig({}).sentenceExtractionEnabled, true);
  assert.equal(normalizeRuntimeConfig({ sentenceExtractionEnabled: false }).sentenceExtractionEnabled, false);
});

test("选定配置库条目后，服务商/地址/模型/密钥都取那一条", () => {
  const configuration = configurationWith({
    vendors: {
      "本地 Ollama": { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: "" }
    },
    configuration: {
      termExtraction: normalizeTermExtractionConfig({ vendor: "本地 Ollama", followTranslation: false }),
      sentenceExtraction: normalizeSentenceExtractionConfig({ vendor: "本地 Ollama", followTranslation: false })
    }
  });
  const term = resolveExtractionConfig(configuration, "termExtraction");
  assert.equal(term.provider, "ollama");
  assert.equal(term.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(term.model, "qwen2.5:7b");
  assert.equal(term.apiKey, "");
  assert.equal(term.vendor, "本地 Ollama", "vendor 字段保留，供设置页回显");
  const sentence = resolveExtractionConfig(configuration, "sentenceExtraction");
  assert.equal(sentence.baseUrl, "http://127.0.0.1:11434/v1");
});

test("指向已不存在的配置时回退到本节自有字段，不抛错", () => {
  const configuration = configurationWith({
    configuration: {
      termExtraction: normalizeTermExtractionConfig({
        vendor: "已被删掉的配置", followTranslation: false,
        provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b"
      })
    }
  });
  const effective = resolveExtractionConfig(configuration, "termExtraction");
  assert.equal(effective.baseUrl, "http://127.0.0.1:11434/v1");
});

test("没有选定配置且不再跟随翻译服务时，提取就没有可用 AI 服务", () => {
  const configuration = configurationWith({
    configuration: { termExtraction: normalizeTermExtractionConfig({ followTranslation: false }) }
  });
  assert.equal(resolveExtractionConfig(configuration, "termExtraction").baseUrl, "");
});

test("旧存档仍在跟随翻译服务：翻译配置好用就直接用那一套", () => {
  const configuration = configurationWith({
    configuration: {
      termExtraction: normalizeTermExtractionConfig({ model: "qwen2.5:7b" }),
      sentenceExtraction: normalizeSentenceExtractionConfig({})
    }
  });
  const effective = resolveExtractionConfig(configuration, "termExtraction");
  assert.equal(effective.provider, "deepseek");
  assert.equal(effective.baseUrl, "https://api.deepseek.com");
  assert.equal(effective.model, "deepseek-chat");
  assert.equal(effective.apiKey, "sk-translation");
  assert.equal(resolveExtractionConfig(configuration, "sentenceExtraction").apiKey, "sk-translation");
});

test("翻译服务没配好时跟随不生效，退回本节存的值（没配则不可用）", () => {
  const unconfigured = makeTranslation();
  const configuration = configurationWith({
    configuration: { termExtraction: normalizeTermExtractionConfig({}) }
  }, unconfigured);
  assert.equal(resolveExtractionConfig(configuration, "termExtraction").baseUrl, "",
    "保持空值 → 整章提取走本地模型（没有句子模式了）");

  const withOwn = configurationWith({
    configuration: {
      termExtraction: normalizeTermExtractionConfig({ baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" })
    }
  }, unconfigured);
  const effective = resolveExtractionConfig(withOwn, "termExtraction");
  assert.equal(effective.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(effective.model, "qwen2.5:7b");
});

test("免密钥服务商（Ollama/自定义）配了地址就算配好，旧存档跟随仍然生效", () => {
  const configuration = configurationWith({
    configuration: { termExtraction: normalizeTermExtractionConfig({}) }
  }, normalizeTranslationConfig({
    provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: ""
  }));
  const effective = resolveExtractionConfig(configuration, "termExtraction");
  assert.equal(effective.provider, "ollama");
  assert.equal(effective.baseUrl, "http://127.0.0.1:11434/v1");
});

function makeTranslation() {
  const translation = normalizeTranslationConfig({ provider: "custom", apiKey: "", model: "qwen2.5:7b" });
  assert.equal(translation.baseUrl, "https://api.deepseek.com", "归一化会带出内置默认地址");
  return translation;
}

test("设置页把两处提取并进「翻译服务」，各有一个配置档案下拉和开关", () => {
  const html = read("extension", "public", "settings.html");
  const translationPanel = html.match(/data-panel="translation"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(html, /data-route="termExtraction"/u, "术语提取导航已合并");
  assert.doesNotMatch(html, /data-panel="termExtraction"/u, "术语提取面板已合并");
  assert.doesNotMatch(html, /id="followTranslation"/u, "不再有「跟随翻译服务」开关");
  assert.match(translationPanel, /id="termServiceSelect"/u);
  assert.match(translationPanel, /id="sentenceServiceSelect"/u);
  assert.match(translationPanel, /id="termDiscoveryEnabled"/u, "整章提取开关在提取卡片上");
  assert.match(translationPanel, /id="sentenceExtractionEnabled"/u);
  assert.equal((html.match(/id="termDiscoveryEnabled"/gu) || []).length, 1,
    "同一个开关只能有一个控件（同页重复 id 会互相打架）");
  assert.doesNotMatch(translationPanel, /id="termProvider"|id="sentenceProvider"|id="saveTermExtractionBtn"/u);
});

test("设置页与后台都走「有效配置」和两个开关", () => {
  const controller = read("extension", "src", "settings", "controller.js");
  const selection = read("extension", "src", "settings", "service-selection.js");
  const messages = read("extension", "src", "background", "modules", "term-discovery-messages.js");
  const contextExtract = read("extension", "src", "background", "modules", "term-context-extract.js");

  assert.match(controller, /installServiceSelection/u);
  assert.match(controller, /serviceSelection\.refresh/u);
  assert.match(selection, /SAVE_CONFIGURATION/u);
  assert.match(selection, /vendor/u);
  assert.match(messages, /resolveExtractionConfig/u, "整章术语提取要走有效配置");
  assert.match(messages, /sentenceExtractionEnabled/u, "句子级提取受开关约束");
  assert.doesNotMatch(messages, /configuration\.termExtraction\.baseUrl/u, "不该再直接读原始配置");
  assert.match(contextExtract, /resolveSentenceService/u, "句子级提取也要走有效配置");
  assert.match(contextExtract, /sentenceExtractionEnabled/u);
  assert.doesNotMatch(contextExtract, /术语提取」中配置/u, "文案指向合并后的页面");
});
