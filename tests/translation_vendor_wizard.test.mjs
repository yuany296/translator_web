import assert from "node:assert/strict";
import test from "node:test";
import { installVendorUi } from "../extension/src/settings/vendor-ui.js";

/** 极简 DOM 桩:覆盖 vendor-ui 用到的 id 注册表、classList、dataset 与事件派发。
 *  dataset 与真实 DOM 一致是只读 getter,防止 Object.assign(node, { dataset }) 这类
 *  在真实页面抛错、在普通对象上却能通过的写法漏网。 */
class MiniElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    Object.defineProperty(this, "dataset", { get: () => this._dataset, configurable: true });
    this._dataset = {};
    this.style = {};
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.open = false;
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
    this.classes = classes;
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

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {
    this.focused = true;
  }

  dispatch(type, extra = {}) {
    const event = { target: this, type, ...extra };
    let node = this;
    while (node) {
      for (const handler of node.listeners.get(type) || []) handler(event);
      node = node.parent;
    }
  }

  closest(selector) {
    const wanted = selector.replace(/\[.*/, "");
    let node = this;
    while (node) {
      if (node.tagName === wanted.toUpperCase() && Object.keys(node.dataset).length) return node;
      node = node.parent;
    }
    return null;
  }

  get options() {
    return this.children;
  }
}

const IDS = [
  "vendorSelect", "vendorDialog", "vendorDialogTitle", "vendorStepProvider", "vendorStepForm",
  "vendorProviderList", "vendorName", "vendorProviderLabel", "vendorUrl", "vendorKey", "vendorKeyHint",
  "vendorModel", "vendorModelCustom", "vendorModelStatus", "vendorFetchModelsBtn", "vendorBackBtn",
  "vendorSubmitBtn", "vendorFormError", "vendorStatus",
  "vendorManagerDialog", "vendorManagerRows", "vendorManagerEmpty", "vendorManagerError",
  "vendorManagerNewBtn", "vendorManagerCloseBtn",
  "vendorManageBtn", "termServiceManageBtn", "sentenceServiceManageBtn",
  "vendorCurrentName", "vendorCurrentDetail", "vendorNewBtn", "vendorCancelBtn"
];

/** 管理表里某一行的按钮：删除/编辑/复制都只在这张表里出现。 */
function managerRowButton(nodes, name, action) {
  return nodes.vendorManagerRows.children
    .flatMap(row => row.children)
    .flatMap(cell => cell.children)
    .find(button => button.dataset.name === name && button.dataset.action === action);
}

/** 管理表里某条配置那一行。 */
function managerRow(nodes, name) {
  return nodes.vendorManagerRows.children
    .find(row => row.children[0].textContent === name);
}

function setup({ vendors = {}, active = "", usage = {} } = {}) {
  const nodes = Object.fromEntries(IDS.map(id => [id, new MiniElement(id.includes("Btn") ? "button" : "div")]));
  const state = { vendors: JSON.parse(JSON.stringify(vendors)), active, usage: JSON.parse(JSON.stringify(usage)) };
  const sent = [];
  globalThis.document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => new MiniElement(tag)
  };
  globalThis.window = { confirm: () => true };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        sent.push(message);
        callback(handle(message));
      }
    }
  };
  function handle(message) {
    switch (message.type) {
      case "GET_TRANSLATION_VENDORS":
        return { ok: true, names: Object.keys(state.vendors).sort(), active: state.active, entries: state.vendors, usage: state.usage };
      case "SAVE_TRANSLATION_VENDOR":
        // originalName 表示编辑并改名:后台摘掉旧条目并同步引用它的提取配置
        if (message.originalName && message.originalName !== message.name) {
          delete state.vendors[message.originalName];
        }
        state.vendors[message.name] = message.entry;
        state.active = message.name;
        return { ok: true, name: message.name };
      case "ACTIVATE_TRANSLATION_VENDOR":
        state.active = message.name;
        return { ok: true, name: message.name };
      case "DELETE_TRANSLATION_VENDOR":
        delete state.vendors[message.name];
        delete state.usage[message.name];
        if (state.active === message.name) {
          state.active = Object.keys(state.vendors).sort()[0] || "";
        }
        return { ok: true, state: { names: Object.keys(state.vendors).sort(), active: state.active, entries: state.vendors, usage: state.usage } };
      case "GET_LLM_MODELS":
        return { ok: true, models: ["model-a", "model-b"] };
      default:
        return { ok: false, error: `未预期的消息：${message.type}` };
    }
  }
  let reloads = 0;
  const ui = installVendorUi({ reloadConfiguration: async () => { reloads += 1; } });
  return { nodes, state, sent, ui, reloadCount: () => reloads };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("新建向导第一步列出服务商预设,选择后进入第二步并预填地址", async () => {
  const { nodes, ui } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  assert.equal(nodes.vendorStepProvider.classes.has("hidden"), false);
  assert.equal(nodes.vendorStepForm.classes.has("hidden"), true);
  assert.equal(nodes.vendorProviderLabel.value, "", "新建时服务商处默认为空,不预选任何服务商");
  assert.equal(nodes.vendorUrl.value, "");
  assert.equal(nodes.vendorModel.value, "");
  const deepseek = nodes.vendorProviderList.children.find(node => node.dataset.provider === "deepseek");
  assert.ok(deepseek, "服务商按钮来自 LLM_PROVIDERS");
  assert.deepEqual(
    nodes.vendorProviderList.children.map(node => node.dataset.provider),
    ["openai", "qwen", "glm", "deepseek", "kimi", "siliconflow", "volces", "custom", "ollama"],
    "第一步列出全部服务商预设"
  );
  deepseek.dispatch("click");
  assert.equal(nodes.vendorStepForm.classes.has("hidden"), false);
  assert.equal(nodes.vendorUrl.value, "https://api.deepseek.com", "预填服务商 Base URL");
  assert.equal(nodes.vendorModelCustom.value, "deepseek-chat", "预填默认模型到自定义输入");
  assert.equal(nodes.vendorModelCustom.hidden, false);
  assert.equal(nodes.vendorProviderLabel.value, "DeepSeek");
});

test("未通过校验时不发送保存消息,并给出中文提示", async () => {
  const { nodes, ui, sent } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorSubmitBtn.dispatch("click");
  assert.equal(nodes.vendorFormError.textContent, "请填写配置名称");
  assert.equal(sent.filter(message => message.type === "SAVE_TRANSLATION_VENDOR").length, 0);
  nodes.vendorName.value = "我的 DeepSeek";
  nodes.vendorSubmitBtn.dispatch("click");
  assert.equal(nodes.vendorFormError.textContent, "请填写 Base URL");
});

test("命名后保存:提交厂商四要素并激活该配置", async () => {
  const { nodes, ui, state, sent } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "openai").dispatch("click");
  nodes.vendorName.value = "OpenAI 主力";
  nodes.vendorKey.value = "sk-test";
  nodes.vendorSubmitBtn.dispatch("click");
  await settle();
  const saved = sent.find(message => message.type === "SAVE_TRANSLATION_VENDOR");
  assert.deepEqual(saved.entry, {
    provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-test"
  });
  assert.equal(state.active, "OpenAI 主力", "保存即激活");
  assert.equal(nodes.vendorCurrentName.textContent, "当前配置：OpenAI 主力");
  assert.equal(nodes.vendorStatus.textContent, "已保存配置「OpenAI 主力」并启用");
});

test("新建时重名被拒绝", async () => {
  const { nodes, ui } = setup({
    vendors: { 已有: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "m", apiKey: "k" } },
    active: "已有"
  });
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorProviderList.children[0].dispatch("click");
  nodes.vendorName.value = "已有";
  nodes.vendorSubmitBtn.dispatch("click");
  assert.equal(nodes.vendorFormError.textContent, "配置名称已存在，请换一个名称");
});

test("编辑跳过选厂商步骤并回填条目,改名保存后删除旧条目", async () => {
  const { nodes, ui, state, sent } = setup({
    vendors: { 旧名: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k1" } },
    active: "旧名"
  });
  await ui.refresh();
  // 编辑入口在「管理配置档案」表里（服务卡片上不再摆「编辑/删除」）
  nodes.vendorManageBtn.dispatch("click");
  managerRowButton(nodes, "旧名", "edit").dispatch("click");
  assert.equal(nodes.vendorStepForm.classes.has("hidden"), false, "编辑直达第二步");
  assert.equal(nodes.vendorStepProvider.classes.has("hidden"), true);
  assert.equal(nodes.vendorBackBtn.classes.has("hidden"), true, "编辑态不提供返回选厂商");
  assert.equal(nodes.vendorSubmitBtn.textContent, "保存");
  assert.equal(nodes.vendorName.value, "旧名");
  assert.equal(nodes.vendorKey.value, "k1", "回填已保存密钥");
  assert.equal(nodes.vendorModelCustom.value, "deepseek-chat");
  nodes.vendorName.value = "新名";
  nodes.vendorModel.value = "deepseek-reasoner";
  nodes.vendorSubmitBtn.dispatch("click");
  await settle();
  assert.deepEqual(Object.keys(state.vendors), ["新名"]);
  assert.equal(state.active, "新名");
  const renameMessage = sent.find(message => message.type === "SAVE_TRANSLATION_VENDOR");
  assert.equal(renameMessage.originalName, "旧名", "改名走 originalName，后台据此同步提取配置的引用");
  assert.ok(!sent.some(message => message.type === "DELETE_TRANSLATION_VENDOR"),
    "改名不再靠「先存新名再删旧名」，否则会打断提取配置的引用");
});

test("向导建好配置后回调 onSaved，供提取行直接指派", async () => {
  const { nodes, ui } = setup();
  const named = [];
  ui.openWizard("create", { onSaved: name => named.push(name) });
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "deepseek").dispatch("click");
  nodes.vendorName.value = "DeepSeek 日常";
  nodes.vendorKey.value = "sk-test";
  nodes.vendorSubmitBtn.dispatch("click");
  await settle();
  assert.deepEqual(named, ["DeepSeek 日常"]);
  // 回调只生效一次：再开一次向导不会复用上一次的回调
  const again = [];
  ui.openWizard("create", { onSaved: name => again.push(name) });
  nodes.vendorCancelBtn.dispatch("click");
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "ollama").dispatch("click");
  nodes.vendorName.value = "本地 Ollama";
  nodes.vendorModel.value = "qwen2.5:7b";
  nodes.vendorSubmitBtn.dispatch("click");
  await settle();
  assert.deepEqual(named, ["DeepSeek 日常"]);
  assert.deepEqual(again, ["本地 Ollama"]);
});

test("下拉切换配置触发激活并重新拉取配置", async () => {
  const { nodes, ui, state, reloadCount } = setup({
    vendors: {
      A: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "m-a", apiKey: "k" },
      B: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "m-b", apiKey: "k" }
    },
    active: "A"
  });
  await ui.refresh();
  assert.deepEqual(nodes.vendorSelect.children.map(node => node.value), ["A", "B"]);
  nodes.vendorSelect.value = "B";
  nodes.vendorSelect.dispatch("change");
  await settle();
  assert.equal(state.active, "B");
  assert.equal(reloadCount(), 1);
});

test("删除全部配置后回落为未启用命名配置", async () => {
  const { nodes, ui, state, reloadCount } = setup({
    vendors: { 唯一: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "m", apiKey: "k" } },
    active: "唯一"
  });
  await ui.refresh();
  // 删除只在「管理配置档案」弹窗里：卡片上不再有「删除」，免得看着像删掉整个翻译功能
  nodes.vendorManageBtn.dispatch("click");
  assert.equal(nodes.vendorManagerDialog.open, true, "点「管理配置档案…」开弹窗");
  managerRowButton(nodes, "唯一", "delete").dispatch("click");
  await settle();
  assert.deepEqual(state.vendors, {});
  assert.equal(nodes.vendorCurrentName.textContent, "未启用命名配置");
  assert.equal(nodes.vendorCurrentDetail.textContent, "点击「新建配置」创建第一套配置");
  assert.equal(nodes.vendorSelect.children[0].textContent, "暂无配置，请先新建");
  assert.equal(reloadCount(), 1);
  assert.match(nodes.vendorStatus.textContent, /翻译功能不受影响/u);
});

test("管理配置档案：列出「谁在用」，编辑指定那一条、复制不撞名", async () => {
  const { nodes, ui, state } = setup({
    vendors: {
      "日常": { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "k" },
      "备用": { provider: "kimi", baseUrl: "https://api.moonshot.cn", model: "moonshot-v1-8k", apiKey: "k2" }
    },
    active: "日常",
    usage: { "日常": ["translation", "termExtraction"] }
  });
  await ui.refresh();
  nodes.vendorManageBtn.dispatch("click");

  const rows = nodes.vendorManagerRows.children;
  assert.equal(rows.length, 2, "两条配置各一行");
  const usageText = managerRow(nodes, "日常").children[2].children.map(tag => tag.textContent).join("/");
  assert.equal(usageText, "翻译/整章提取", "谁在用要列出来");
  assert.equal(managerRow(nodes, "备用").children[2].children[0].textContent, "没人用");

  // 编辑指定的那一条（不是当前激活的「日常」）
  managerRowButton(nodes, "备用", "edit").dispatch("click");
  assert.equal(nodes.vendorDialog.open, true);
  assert.equal(nodes.vendorName.value, "备用");
  assert.equal(nodes.vendorUrl.value, "https://api.moonshot.cn");
  nodes.vendorCancelBtn.dispatch("click");

  // 复制：直接进第二步，名字自动带「副本」
  managerRowButton(nodes, "日常", "copy").dispatch("click");
  assert.equal(nodes.vendorStepForm.classes.has("hidden"), false, "复制直接进填写那一步");
  assert.equal(nodes.vendorName.value, "日常 副本");
  assert.equal(nodes.vendorUrl.value, "https://api.deepseek.com", "地址抄过来");
  assert.equal(nodes.vendorKey.value, "k", "密钥也抄过来，不用重新填");
  assert.equal(nodes.vendorModelCustom.value, "deepseek-chat", "模型抄过来（落在自定义输入里）");
  assert.equal(state.vendors["日常 副本"], undefined, "还没保存，不能先落库");
});

test("本地服务商无需 API Key 也可保存", async () => {
  const { nodes, ui, sent } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "ollama").dispatch("click");
  assert.equal(nodes.vendorKey.disabled, false, "Ollama 密钥输入可编辑：反代鉴权的本地服务同样需要填 Key");
  assert.match(nodes.vendorKeyHint.textContent, /可留空/u);
  nodes.vendorName.value = "本地 Ollama";
  nodes.vendorModel.value = "qwen2.5:7b";
  nodes.vendorSubmitBtn.dispatch("click");
  await settle();
  const saved = sent.find(message => message.type === "SAVE_TRANSLATION_VENDOR");
  assert.equal(saved.entry.apiKey, "");
  assert.equal(saved.entry.provider, "ollama");
});

test("自定义 OpenAI 兼容服务可填写并保存 API Key", async () => {
  const { nodes, ui, sent } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "custom").dispatch("click");
  assert.equal(nodes.vendorKey.disabled, false, "自定义服务商不得禁用密钥输入");
  assert.match(nodes.vendorKeyHint.textContent, /可留空/u);
  nodes.vendorName.value = "自建网关";
  nodes.vendorUrl.value = "http://192.168.1.10:3000/v1";
  nodes.vendorKey.value = "sk-self-hosted";
  nodes.vendorModel.value = "qwen2.5:7b";
  nodes.vendorSubmitBtn.dispatch("click");
  await settle();
  const saved = sent.find(message => message.type === "SAVE_TRANSLATION_VENDOR");
  assert.equal(saved.entry.provider, "custom");
  assert.equal(saved.entry.apiKey, "sk-self-hosted");
});

test("获取模型列表全量填充下拉候选,默认选中第一个模型", async () => {
  const { nodes, ui } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "openai").dispatch("click");
  nodes.vendorFetchModelsBtn.dispatch("click");
  await settle();
  assert.deepEqual(
    nodes.vendorModel.children.map(node => node.value),
    ["model-a", "model-b", ""],
    "全量模型进下拉,末项为自定义模型…"
  );
  assert.equal(nodes.vendorModel.value, "model-a", "默认选中第一个模型");
  assert.equal(nodes.vendorModelCustom.hidden, true);
  assert.equal(nodes.vendorModelStatus.textContent, "已获取 2 个模型");
});

test("获取模型返回空列表时保留已填模型到自定义输入", async () => {
  const { nodes, ui, sent } = setup();
  await ui.refresh();
  nodes.vendorNewBtn.dispatch("click");
  nodes.vendorProviderList.children.find(node => node.dataset.provider === "ollama").dispatch("click");
  nodes.vendorModelCustom.value = "my-rare-model";
  // 该服务不返回模型列表
  const originalSend = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (message, callback) => {
    sent.push(message);
    if (message.type === "GET_LLM_MODELS") return callback({ ok: true, models: [] });
    return originalSend(message, callback);
  };
  nodes.vendorFetchModelsBtn.dispatch("click");
  await settle();
  globalThis.chrome.runtime.sendMessage = originalSend;
  assert.ok(sent.some(message => message.type === "GET_LLM_MODELS"), "发起了模型列表请求");
  assert.equal(nodes.vendorModel.value, "", "空列表时不选中任何模型");
  assert.equal(nodes.vendorModelCustom.hidden, false);
  assert.equal(nodes.vendorModelCustom.value, "my-rare-model", "已填模型保留");
  // 下拉选「自定义模型…」时切回自定义输入
  nodes.vendorModel.value = "";
  nodes.vendorModel.dispatch("change");
  assert.equal(nodes.vendorModelCustom.hidden, false);
});
