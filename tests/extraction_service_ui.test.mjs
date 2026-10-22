import assert from "node:assert/strict";
import test from "node:test";

import { installServiceSelection } from "../extension/src/settings/service-selection.js";

/** 与 translation_vendor_wizard.test.mjs 同款的极简 DOM 桩。 */
class MiniElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    Object.defineProperty(this, "dataset", { get: () => this._dataset, configurable: true });
    this._dataset = {};
    this.value = "";
    this.textContent = "";
    this.checked = false;
    this.disabled = false;
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  prepend(node) {
    node.parent = this;
    this.children.unshift(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) || []) handler({ target: this, type });
  }

  get options() {
    return this.children;
  }
}

const IDS = [
  "termServiceSelect", "termServiceName", "termServiceDetail", "termServiceNewBtn",
  "sentenceServiceSelect", "sentenceServiceName", "sentenceServiceDetail", "sentenceServiceNewBtn",
  "termDiscoveryEnabled", "sentenceExtractionEnabled", "serviceSelectionStatus",
  "termEngineAuto", "termEngineLocal", "termEngineAi", "termEngineHint"
];

const VENDORS = {
  DeepSeek: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k1" },
  "本地 Ollama": { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: "" }
};

function makeConfiguration() {
  return {
    translation: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k1", sourceLanguage: "auto", targetLanguage: "zh-CN" },
    termExtraction: { provider: "", baseUrl: "", model: "qwen2.5:7b", apiKey: "", vendor: "", followTranslation: true },
    sentenceExtraction: { provider: "", baseUrl: "", model: "qwen2.5:7b", apiKey: "", vendor: "", followTranslation: true },
    // 配置库条目要和下面 GET_TRANSLATION_VENDORS 返回的一致：引擎判定（resolveExtractionConfig）
    // 读的是 configuration.llmVendors，真实环境里 GET_CONFIGURATION 就带着它。
    llmVendors: { vendors: VENDORS },
    runtime: { termDiscoveryEnabled: true, sentenceExtractionEnabled: true }
  };
}

function setup({ vendors = VENDORS, configuration = makeConfiguration() } = {}) {
  const nodes = Object.fromEntries(IDS.map(id => [id, new MiniElement(id.endsWith("Btn") ? "button" : "div")]));
  nodes.termDiscoveryEnabled.checked = true;
  nodes.sentenceExtractionEnabled.checked = true;
  globalThis.document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => new MiniElement(tag)
  };
  const saved = [];
  const created = [];
  const statuses = [];
  const warm = [];
  const state = { configuration };
  const body = {
    byId: id => globalThis.document.getElementById(id),
    checked: id => body.byId(id).checked,
    send: async message => {
      if (message.type !== "GET_TRANSLATION_VENDORS") throw new Error(`未预期的消息：${message.type}`);
      return { ok: true, names: Object.keys(vendors).sort(), active: "DeepSeek", entries: vendors };
    },
    saveSection: async (section, value) => {
      saved.push({ section, value });
      state.configuration = { ...state.configuration, [section]: value };
      return value;
    },
    setStatus: (id, message, error = false) => statuses.push({ id, message, error }),
    getConfiguration: () => state.configuration,
    requestCreate: prefix => created.push(prefix),
    warmUp: () => warm.push(Date.now())
  };
  const ui = installServiceSelection(body);
  return { nodes, saved, created, statuses, state, ui, body, warm };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("下拉只列配置库条目，没选过的显示提示", async () => {
  const { nodes, ui } = setup();
  await ui.refresh();
  assert.deepEqual(nodes.termServiceSelect.children.map(node => node.value), ["DeepSeek", "本地 Ollama"]);
  assert.deepEqual(nodes.sentenceServiceSelect.children.map(node => node.value), ["DeepSeek", "本地 Ollama"]);
  assert.equal(nodes.termServiceSelect.value, "", "没选过就是空");
  assert.equal(nodes.termServiceName.textContent, "未选择配置");
  assert.doesNotMatch(nodes.termServiceDetail.textContent, /跟随/u, "不再提供「跟随翻译服务」这类选项");
  assert.equal(nodes.termDiscoveryEnabled.checked, true);
  assert.equal(nodes.sentenceExtractionEnabled.checked, true);
});

test("库为空时给占位项并禁用下拉", async () => {
  const { nodes, ui, created } = setup({ vendors: {} });
  await ui.refresh();
  assert.deepEqual(nodes.termServiceSelect.children.map(node => node.value), [""]);
  assert.equal(nodes.termServiceSelect.children[0].textContent, "暂无配置，请先新建");
  assert.equal(nodes.termServiceSelect.disabled, true);
  assert.equal(nodes.termServiceDetail.textContent, "先在上面的「翻译服务」里点「新建配置」");
  nodes.termServiceNewBtn.dispatch("click");
  assert.deepEqual(created, ["term"]);
  assert.deepEqual(nodes.termServiceSelect.children.map(node => node.value), [""]);
});

test("选定配置后立即保存引用，不保存服务商字段", async () => {
  const { nodes, saved, ui, statuses } = setup();
  await ui.refresh();
  nodes.sentenceServiceSelect.value = "本地 Ollama";
  nodes.sentenceServiceSelect.dispatch("change");
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].section, "sentenceExtraction");
  assert.equal(saved[0].value.vendor, "本地 Ollama");
  assert.equal(saved[0].value.followTranslation, false);
  assert.equal(saved[0].value.baseUrl, "", "小节里不再自己存地址 (共用配置库)");
  assert.equal(nodes.sentenceServiceName.textContent, "正在使用配置「本地 Ollama」");
  assert.equal(nodes.sentenceServiceDetail.textContent, "Ollama（本地） · qwen2.5:7b");
  assert.match(statuses.at(-1).message, /句子级术语提取使用/u);
});

test("两个开关各自保存 runtime，并刷新状态文案", async () => {
  const { nodes, saved, ui } = setup({
    configuration: { ...makeConfiguration(), sentenceExtraction: { vendor: "DeepSeek" } }
  });
  await ui.refresh();
  nodes.sentenceExtractionEnabled.checked = false;
  nodes.sentenceExtractionEnabled.dispatch("change");
  await settle();
  assert.equal(saved[0].section, "runtime");
  assert.equal(saved[0].value.sentenceExtractionEnabled, false);
  assert.equal(saved[0].value.termDiscoveryEnabled, true, "另一个开关保持原值");
  assert.match(nodes.sentenceServiceDetail.textContent, /（已关闭）$/u);

  nodes.termDiscoveryEnabled.checked = false;
  nodes.termDiscoveryEnabled.dispatch("change");
  await settle();
  assert.equal(saved[1].value.termDiscoveryEnabled, false);
});

test("向导建好配置后把它指派给对应的一行", async () => {
  const { nodes, saved, ui, statuses } = setup();
  await ui.refresh();
  await ui.assign("term", "DeepSeek");
  assert.equal(saved[0].section, "termExtraction");
  assert.equal(saved[0].value.vendor, "DeepSeek");
  assert.equal(nodes.termServiceSelect.value, "DeepSeek", "指派后下拉回显新选择");
  assert.match(statuses.at(-1).message, /整章术语提取使用「DeepSeek」/u);
});

/** 没有任何可用 AI 配置的存档：termExtraction 不再跟随翻译，翻译自己也是空的。 */
function makeNoAiConfiguration() {
  return {
    ...makeConfiguration(),
    translation: { provider: "", baseUrl: "", model: "", apiKey: "" },
    termExtraction: { vendor: "", followTranslation: false }
  };
}

test("引擎三档默认是「自动」，提示行按当前配置说清会走哪边", async () => {
  const { nodes, ui } = setup();
  await ui.refresh();
  assert.equal(nodes.termEngineAuto.checked, true, "老存档没有 engine 字段，落到自动");
  assert.equal(nodes.termEngineLocal.checked, false);
  assert.match(nodes.termEngineHint.textContent, /^自动：使用/u);
});

test("自动档在没有可用 AI 配置时说清改用本地模型", async () => {
  const { nodes, ui } = setup({ configuration: makeNoAiConfiguration() });
  await ui.refresh();
  assert.equal(nodes.termEngineAuto.checked, true);
  assert.match(nodes.termEngineHint.textContent, /改用本地模型/u);
});

test("切到「本地模型」立刻落盘，提示行说明不发 AI 请求", async () => {
  const { nodes, saved, ui, statuses } = setup();
  await ui.refresh();
  nodes.termEngineLocal.checked = true;
  nodes.termEngineLocal.dispatch("change");
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].section, "termExtraction");
  assert.equal(saved[0].value.engine, "local");
  assert.equal(nodes.termEngineHint.textContent, "已选「本地模型」：不会发送 AI 请求");
  assert.match(statuses.at(-1).message, /已改为「本地模型」/u);
});

test("选「AI 配置」但没配好时提示会跳过，不偷偷回退到本地", async () => {
  const { nodes, saved, ui } = setup({ configuration: makeNoAiConfiguration() });
  await ui.refresh();
  nodes.termEngineAi.checked = true;
  nodes.termEngineAi.dispatch("change");
  await settle();
  assert.equal(saved[0].value.engine, "ai");
  assert.match(nodes.termEngineHint.textContent, /提取会跳过/u);
});

test("走本地模型时顺手预热，走 AI 时不预热", async () => {
  const local = setup({ configuration: makeNoAiConfiguration() });
  await local.ui.refresh();
  assert.equal(local.warm.length, 1, "打开设置页就发一次预热（冷启动几十秒，等到提取就超时了）");

  const ai = setup();
  await ai.ui.refresh();
  assert.equal(ai.warm.length, 0, "走 AI 不需要本地模型");

  // 从「自动走 AI」切到「本地模型」也要补一次。
  ai.nodes.termEngineLocal.checked = true;
  ai.nodes.termEngineLocal.dispatch("change");
  await settle();
  assert.equal(ai.warm.length, 1);
});

// 「（已关闭）」不只由开关决定：整章引擎切到「本地模型」时，这条 AI 配置就是闲置的。
test("选本地模型时配置行标「已关闭」", async () => {
  const configuration = {
    ...makeConfiguration(),
    termExtraction: { vendor: "DeepSeek", followTranslation: false, engine: "local" }
  };
  const { nodes, ui } = setup({ configuration });
  await ui.refresh();
  assert.equal(nodes.termServiceName.textContent, "正在使用配置「DeepSeek」");
  assert.match(nodes.termServiceDetail.textContent, /（已关闭）$/u);
});

test("自动档且 AI 配置可用时不标已关闭", async () => {
  const configuration = {
    ...makeConfiguration(),
    termExtraction: { vendor: "DeepSeek", followTranslation: false }
  };
  const { nodes, ui } = setup({ configuration });
  await ui.refresh();
  assert.doesNotMatch(nodes.termServiceDetail.textContent, /（已关闭）/u);
});

test("没选配置时只说「未选择配置」，不加已关闭后缀", async () => {
  const configuration = {
    ...makeConfiguration(),
    termExtraction: { vendor: "", followTranslation: false, engine: "local" }
  };
  const { nodes, ui } = setup({ configuration });
  await ui.refresh();
  assert.equal(nodes.termServiceName.textContent, "未选择配置");
  assert.doesNotMatch(nodes.termServiceDetail.textContent, /（已关闭）/u);
});

test("切到本地模型后该行立刻标已关闭，切回 AI 又恢复", async () => {
  const configuration = {
    ...makeConfiguration(),
    termExtraction: { vendor: "DeepSeek", followTranslation: false }
  };
  const { nodes, ui } = setup({ configuration });
  await ui.refresh();
  assert.doesNotMatch(nodes.termServiceDetail.textContent, /（已关闭）/u);

  nodes.termEngineLocal.checked = true;
  nodes.termEngineLocal.dispatch("change");
  await settle();
  assert.match(nodes.termServiceDetail.textContent, /（已关闭）$/u);

  nodes.termEngineAi.checked = true;
  nodes.termEngineAi.dispatch("change");
  await settle();
  assert.doesNotMatch(nodes.termServiceDetail.textContent, /（已关闭）/u);
});
