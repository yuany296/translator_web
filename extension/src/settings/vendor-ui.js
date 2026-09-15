import llmProviders from "../shared/llm-providers.js";

/**
 * 翻译「配置档案」面板与新建/编辑向导,对齐 Android 客户端配置页:
 * 新建配置 → 第一步选择服务商 → 第二步填 Base URL / API Key / Model → 命名 → 保存(即激活)。
 * 新建时服务商处默认为空(不预选任何服务商),面板顶部的下拉切换已保存的命名配置,
 * 编辑跳过选择服务商步骤,删除后回落到剩余配置。
 */
const byId = id => document.getElementById(id);

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.ok === false) reject(new Error(response.error || "操作失败"));
    else resolve(response || {});
  }));
}

const makeOption = (value, label) =>
  Object.assign(document.createElement("option"), { value, textContent: label });

const PROVIDER_TITLES = { create: "新建配置", edit: "编辑配置" };
const STEP_TITLES = ["选择服务商", "填写信息"];
/** 「谁在用」列：三个服务共用一个配置库，删之前先看清会影响谁 */
const USAGE_LABELS = { translation: "翻译", termExtraction: "整章提取", sentenceExtraction: "句子提取" };

export function installVendorUi({ reloadConfiguration }) {
  const state = {
    names: [], entries: {}, active: "", usage: {},
    mode: "create", step: 0, providerId: "", saved: null, editName: ""
  };

  const select = byId("vendorSelect");
  const dialog = byId("vendorDialog");
  const stepProvider = byId("vendorStepProvider");
  const stepForm = byId("vendorStepForm");
  const providerList = byId("vendorProviderList");
  const nameInput = byId("vendorName");
  const providerLabel = byId("vendorProviderLabel");
  const urlInput = byId("vendorUrl");
  const keyInput = byId("vendorKey");
  const keyHint = byId("vendorKeyHint");
  const modelInput = byId("vendorModel");
  const modelCustom = byId("vendorModelCustom");
  const modelStatus = byId("vendorModelStatus");
  const fetchModelsBtn = byId("vendorFetchModelsBtn");
  const backBtn = byId("vendorBackBtn");
  const submitBtn = byId("vendorSubmitBtn");
  const errorText = byId("vendorFormError");

  function setStatus(message, error = false) {
    const el = byId("vendorStatus");
    el.textContent = message;
    el.classList.toggle("error", error);
  }

  function preset() {
    return llmProviders.getProvider(state.providerId);
  }

  /** 当前 Model 值:优先下拉选中项,否则自定义输入 */
  function selectModelValue() {
    return modelInput.value.trim() || modelCustom.value.trim();
  }

  /** 填充 Model 下拉:全量模型 + 「自定义模型…」;列表为空时保留已填模型到自定义输入 */
  function applyModelList(models, savedModel) {
    const names = [...new Set((Array.isArray(models) ? models : [])
      .map(name => String(name || "").trim())
      .filter(Boolean))];
    modelInput.replaceChildren(
      ...names.map(name => makeOption(name, name)),
      makeOption("", "自定义模型…")
    );
    const desired = savedModel && names.includes(savedModel) ? savedModel : (names.length ? names[0] : "");
    modelInput.value = desired;
    modelCustom.hidden = Boolean(desired);
    modelCustom.value = desired ? "" : savedModel || "";
    return names;
  }

  /** 校验向导输入:命名必填,密钥仅在 preset.needsKey 时必填(免密钥服务商可留空),新建不允许重名 */
  function validateForm() {
    if (!nameInput.value.trim()) return "请填写配置名称";
    if (state.mode === "create" && state.names.includes(nameInput.value.trim())) return "配置名称已存在，请换一个名称";
    if (!urlInput.value.trim()) return "请填写 Base URL";
    if (preset()?.needsKey && !keyInput.value.trim()) return "请填写 API Key";
    if (!selectModelValue()) return "请填写 Model（可点“获取模型列表”选择）";
    return "";
  }

  function renderPanel() {
    select.replaceChildren(
      ...(state.names.length
        ? state.names.map(name => makeOption(name, name))
        : [makeOption("", "暂无配置，请先新建")])
    );
    select.value = state.active;
    select.disabled = state.names.length === 0;
    const entry = state.entries[state.active];
    byId("vendorCurrentName").textContent = state.active ? `当前配置：${state.active}` : "未启用命名配置";
    byId("vendorCurrentDetail").textContent = entry
      ? `${llmProviders.providerLabel(entry.provider)} · ${entry.model || "未指定模型"}`
      : "点击「新建配置」创建第一套配置";
    renderManager();
  }

  function makeRowButton(label, action, name) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.dataset.name = name;
    button.textContent = label;
    return button;
  }

  /**
   * 「管理配置档案」表：编辑 / 复制 / 删除都只在这一张表里出现，
   * 服务卡片上不再并排摆「删除」——免得看着像在删整个翻译功能。
   */
  function renderManager() {
    const rows = state.names.map(name => {
      const entry = state.entries[name] || {};
      const tr = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.className = "vendor-manager-name";
      nameCell.textContent = name;
      const detailCell = document.createElement("td");
      detailCell.textContent = `${llmProviders.providerLabel(entry.provider)} · ${entry.model || "未指定模型"}`;
      const usageCell = document.createElement("td");
      const used = state.usage[name] || [];
      if (!used.length) {
        const idle = document.createElement("span");
        idle.className = "vendor-usage-tag idle";
        idle.textContent = "没人用";
        usageCell.append(idle);
      } else {
        for (const kind of used) {
          const tag = document.createElement("span");
          tag.className = "vendor-usage-tag";
          tag.textContent = USAGE_LABELS[kind] || kind;
          usageCell.append(tag);
        }
      }
      const actionCell = document.createElement("td");
      actionCell.className = "vendor-manager-actions";
      const remove = makeRowButton("删除", "delete", name);
      remove.classList.add("danger");
      actionCell.append(makeRowButton("编辑", "edit", name), makeRowButton("复制", "copy", name), remove);
      tr.append(nameCell, detailCell, usageCell, actionCell);
      return tr;
    });
    byId("vendorManagerRows").replaceChildren(...rows);
    byId("vendorManagerEmpty").classList.toggle("hidden", state.names.length > 0);
  }

  function setManagerError(message) {
    byId("vendorManagerError").textContent = String(message || "");
  }

  function openManager() {
    setManagerError("");
    renderManager();
    byId("vendorManagerDialog").showModal();
  }

  /** 「X 副本」「X 副本 2」…… 复制配置时不撞名。 */
  function nextCopyName(name) {
    const base = `${name} 副本`;
    if (!state.names.includes(base)) return base;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base} ${index}`;
      if (!state.names.includes(candidate)) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  /** 删除一套配置：确认文案必须先说清「只删这套配置，翻译功能不受影响」，再点名会影响谁。 */
  async function removeVendor(name) {
    const used = (state.usage[name] || []).map(kind => USAGE_LABELS[kind] || kind);
    const impact = used.length
      ? `它现在被「${used.join("」「")}」用着：删完那里会变成「未选择配置」，在重新选一套之前不工作。`
      : "现在没有任何服务在用它。";
    const confirmed = window.confirm(`删除配置档案「${name}」？\n只删这一套 API 配置（地址 / 密钥 / 模型），翻译功能和其他配置都不受影响。\n${impact}`);
    if (!confirmed) return;
    await run(async () => {
      const result = await send({ type: "DELETE_TRANSLATION_VENDOR", name });
      state.names = result.state.names;
      state.entries = result.state.entries || state.entries;
      state.active = result.state.active;
      if (result.state.usage) state.usage = result.state.usage;
      setStatus(`已删除配置「${name}」（翻译功能不受影响）`);
      await Promise.all([refresh(), reloadConfiguration()]);
    });
  }

  function renderWizard() {
    byId("vendorDialogTitle").textContent =
      `${PROVIDER_TITLES[state.mode]} · ${STEP_TITLES[state.step]}`;
    stepProvider.classList.toggle("hidden", state.step !== 0);
    stepForm.classList.toggle("hidden", state.step !== 1);
    backBtn.classList.toggle("hidden", !(state.step === 1 && state.mode === "create"));
    submitBtn.textContent = state.mode === "edit" ? "保存" : "创建配置";
    errorText.textContent = "";
  }

  function renderProviderButtons() {
    providerList.replaceChildren(...llmProviders.LLM_PROVIDERS.map(provider => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.provider = provider.id;
      const label = document.createElement("span");
      label.textContent = provider.label;
      const detail = document.createElement("small");
      detail.textContent = provider.baseUrl || "需自行填写服务地址";
      button.append(label, detail);
      return button;
    }));
  }

  function applyProviderToForm(providerId, saved = {}) {
    state.providerId = providerId;
    const item = llmProviders.getProvider(providerId);
    providerLabel.value = item ? item.label : providerId;
    urlInput.value = saved.baseUrl || item?.baseUrl || "";
    keyInput.value = saved.apiKey || "";
    applyModelList([], saved.model || item?.defaultModel || "");
    // 免密钥服务商(自定义/Ollama)只表示"不强制",不代表"不能填"。
    const hint = llmProviders.keyFieldHint(providerId);
    keyInput.disabled = false;
    keyInput.placeholder = hint.placeholder;
    keyHint.textContent = hint.hint;
    modelStatus.textContent = "";
  }

  /** options.onSaved(name): 建好/保存后的回调，提取行借它把新配置直接指派给自己。
   *  options.name: 编辑表里指定的那一条（不再只能是当前激活项）；options.copyFrom: 以某条为蓝本复制一份。 */
  function openWizard(mode, options = {}) {
    state.saved = typeof options.onSaved === "function" ? options.onSaved : null;
    state.mode = mode;
    state.step = mode === "edit" || options.copyFrom ? 1 : 0;
    if (mode === "edit") {
      const name = options.name || state.active;
      state.editName = name;
      const entry = state.entries[name] || {};
      nameInput.value = name;
      applyProviderToForm(entry.provider || llmProviders.inferProviderId(entry.baseUrl), entry);
    } else if (options.copyFrom) {
      state.editName = "";
      const entry = state.entries[options.copyFrom] || {};
      nameInput.value = nextCopyName(options.copyFrom);
      applyProviderToForm(entry.provider || llmProviders.inferProviderId(entry.baseUrl), entry);
    } else {
      state.editName = "";
      nameInput.value = "";
      urlInput.value = "";
      keyInput.value = "";
      modelInput.value = "";
      modelCustom.value = "";
      modelCustom.hidden = true;
      state.providerId = "";
      providerLabel.value = "";
      keyInput.disabled = false;
      keyHint.textContent = "";
      modelStatus.textContent = "";
    }
    renderWizard();
    dialog.showModal();
  }

  async function loadModels() {
    const baseUrl = urlInput.value.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      modelStatus.textContent = "请先填写 Base URL";
      return;
    }
    fetchModelsBtn.disabled = true;
    modelStatus.textContent = "正在获取模型列表…";
    try {
      const response = await send({ type: "GET_LLM_MODELS", baseUrl, apiKey: keyInput.value.trim() });
      // 全量模型进下拉,已填模型不在列表时保留在自定义输入里
      const names = applyModelList(response.models, selectModelValue());
      modelStatus.textContent = names.length ? `已获取 ${names.length} 个模型` : "该服务未返回模型列表，请手动输入";
    } catch (error) {
      modelStatus.textContent = `获取失败：${error.message}`;
    } finally {
      fetchModelsBtn.disabled = false;
    }
  }

  async function refresh() {
    const result = await send({ type: "GET_TRANSLATION_VENDORS" });
    state.names = result.names || [];
    state.entries = result.entries || {};
    state.active = result.active || "";
    state.usage = result.usage || {};
    renderPanel();
  }

  async function run(action) {
    try {
      await action();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  providerList.addEventListener("click", event => {
    const button = event.target.closest("button[data-provider]");
    if (!button) return;
    applyProviderToForm(button.dataset.provider);
    state.step = 1;
    renderWizard();
  });

  backBtn.addEventListener("click", () => {
    state.step = 0;
    renderWizard();
  });

  byId("vendorCancelBtn").addEventListener("click", () => dialog.close());
  fetchModelsBtn.addEventListener("click", () => void run(loadModels));
  modelInput.addEventListener("change", () => {
    const custom = modelInput.value === "";
    modelCustom.hidden = !custom;
    if (custom) modelCustom.focus();
  });
  byId("vendorNewBtn").addEventListener("click", () => {
    setStatus("");
    openWizard("create");
  });
  // 「管理配置档案…」三张服务卡片上都有：改 / 删都进这一个弹窗，卡片里不再出现「删除」。
  for (const id of ["vendorManageBtn", "termServiceManageBtn", "sentenceServiceManageBtn"]) {
    byId(id).addEventListener("click", openManager);
  }
  byId("vendorManagerCloseBtn").addEventListener("click", () => byId("vendorManagerDialog").close());
  byId("vendorManagerNewBtn").addEventListener("click", () => {
    setStatus("");
    openWizard("create");
  });
  byId("vendorManagerRows").addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const name = button.dataset.name;
    if (action === "edit") {
      setStatus("");
      openWizard("edit", { name });
      return;
    }
    if (action === "copy") {
      setStatus("");
      openWizard("create", { copyFrom: name });
      return;
    }
    if (action === "delete") {
      void removeVendor(name);
    }
  });

  select.addEventListener("change", () => run(async () => {
    if (!select.value) return;
    await send({ type: "ACTIVATE_TRANSLATION_VENDOR", name: select.value });
    setStatus(`已切换到「${select.value}」`);
    await Promise.all([refresh(), reloadConfiguration()]);
  }));

  submitBtn.addEventListener("click", () => {
    const problem = validateForm();
    if (problem) {
      errorText.textContent = problem;
      return;
    }
    const name = nameInput.value.trim();
    const original = state.mode === "edit" ? (state.editName || state.active) : "";
    errorText.textContent = "";
    run(async () => {
      const entry = {
        provider: state.providerId,
        baseUrl: urlInput.value.trim(),
        model: selectModelValue(),
        apiKey: keyInput.value.trim()
      };
      // 编辑时改名交给 originalName:后台会同步引用旧名的提取配置,不用先存新名再删旧名
      await send({ type: "SAVE_TRANSLATION_VENDOR", name, entry, originalName: original });
      dialog.close();
      setStatus(`已保存配置「${name}」并启用`);
      const onSaved = state.saved;
      state.saved = null;
      if (onSaved) onSaved(name);
      await Promise.all([refresh(), reloadConfiguration()]);
    });
  });

  renderProviderButtons();
  return { refresh, openWizard };
}
