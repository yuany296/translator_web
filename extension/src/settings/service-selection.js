import llmProviders from "../shared/llm-providers.js";

/**
 * 「翻译服务」页里的三处 AI 服务选择（controller 有 400 行门禁，这块单独成模块）。
 *
 * 翻译、整章术语提取、句子级术语提取共用同一套命名配置库（settings/vendor-ui.js 管理），
 * 这里只负责两个提取行的「用哪一条配置」与两个开关：
 * - 下拉只列配置库条目，不提供「跟随翻译服务 / 不使用 AI」——开不开由开关决定；
 * - 选完立刻保存（SAVE_CONFIGURATION），没有独立保存按钮；
 * - 没选配置、或开关关掉时，后台不会发起提取（整章退回本地内置句子模式）。
 */
const ROWS = Object.freeze({
  term: Object.freeze({
    label: "整章术语提取", section: "termExtraction", switchId: "termDiscoveryEnabled",
    select: "termServiceSelect", name: "termServiceName", detail: "termServiceDetail",
    create: "termServiceNewBtn", emptyDetail: "还没选配置：翻译后不会用 AI 提取术语"
  }),
  sentence: Object.freeze({
    label: "句子级术语提取", section: "sentenceExtraction", switchId: "sentenceExtractionEnabled",
    select: "sentenceServiceSelect", name: "sentenceServiceName", detail: "sentenceServiceDetail",
    create: "sentenceServiceNewBtn", emptyDetail: "还没选配置：候选卡不显示「AI 提取」"
  })
});

const makeOption = (value, label) =>
  Object.assign(document.createElement("option"), { value, textContent: label });

export function installServiceSelection(deps) {
  const { byId, checked, send, saveSection, setStatus, getConfiguration, requestCreate } = deps;
  const state = { names: [], entries: {}, active: "" };

  function setRowStatus(message, error = false) {
    setStatus("serviceSelectionStatus", message, error);
  }

  /** 下拉只放配置库条目;库为空时给一个占位项（与翻译卡的空态一致）。 */
  function fillSelect(row, vendor) {
    const select = byId(row.select);
    select.replaceChildren(...state.names.map(name => makeOption(name, name)));
    if (state.names.length === 0) select.prepend(makeOption("", "暂无配置，请先新建"));
    select.value = state.names.includes(vendor) ? vendor : "";
    select.disabled = state.names.length === 0;
    select.dataset.before = select.value;
  }

  function renderRow(row, section) {
    const enabled = checked(row.switchId);
    const vendor = section.vendor && state.entries[section.vendor] ? section.vendor : "";
    const title = byId(row.name);
    const detail = byId(row.detail);
    if (!vendor) {
      title.textContent = "未选择配置";
      detail.textContent = state.names.length === 0
        ? "先在上面的「翻译服务」里点「新建配置」"
        : row.emptyDetail;
      return;
    }
    const entry = state.entries[vendor];
    const provider = llmProviders.providerLabel(entry.provider);
    title.textContent = `正在使用配置「${vendor}」`;
    detail.textContent = `${provider} · ${entry.model || "未指定模型"}${enabled ? "" : "（已关闭）"}`;
  }

  function renderAll() {
    const configuration = getConfiguration() || {};
    const runtime = configuration.runtime || {};
    for (const row of Object.values(ROWS)) {
      byId(row.switchId).checked = runtime[row.switchId] !== false;
      fillSelect(row, (configuration[row.section] || {}).vendor);
      renderRow(row, configuration[row.section] || {});
    }
  }

  async function refresh() {
    const result = await send({ type: "GET_TRANSLATION_VENDORS" });
    state.names = result.names || [];
    state.entries = result.entries || {};
    state.active = result.active || "";
    renderAll();
  }

  async function saveRow(row) {
    const configuration = getConfiguration() || {};
    const section = configuration[row.section] || {};
    const select = byId(row.select);
    const vendor = select.value || "";
    if (vendor === (section.vendor || "")) return;
    setRowStatus("保存中…");
    try {
      const saved = await saveSection(row.section, { ...section, followTranslation: false, vendor });
      setRowStatus(vendor ? `已让${row.label}使用「${vendor}」` : `已清空${row.label}的配置`);
      renderRow(row, saved);
    } catch (error) {
      select.value = section.vendor || "";
      setRowStatus(error.message, true);
    }
  }

  async function saveSwitch(row) {
    const configuration = getConfiguration() || {};
    if (!configuration.runtime) return;
    const enabled = checked(row.switchId);
    setRowStatus("保存中…");
    try {
      const saved = await saveSection("runtime", { ...configuration.runtime, [row.switchId]: enabled });
      const on = saved[row.switchId] !== false;
      byId(row.switchId).checked = on;
      setRowStatus(`${row.label}已${on ? "开启" : "关闭"}`);
      renderRow(row, configuration[row.section] || {});
    } catch (error) {
      byId(row.switchId).checked = !enabled;
      setRowStatus(error.message, true);
    }
  }

  /** 向导里刚建好的配置直接指派给这一行（三个服务共用一套配置）。 */
  async function assign(prefix, vendor) {
    const row = ROWS[prefix];
    if (!row) return;
    const section = (getConfiguration() || {})[row.section] || {};
    await saveSection(row.section, { ...section, followTranslation: false, vendor });
    await refresh();
    setRowStatus(`已让${row.label}使用「${vendor}」`);
  }

  for (const [prefix, row] of Object.entries(ROWS)) {
    byId(row.select).addEventListener("change", () => void saveRow(row));
    byId(row.create).addEventListener("click", () => {
      setRowStatus("");
      requestCreate?.(prefix);
    });
  }
  byId("termDiscoveryEnabled").addEventListener("change", () => void saveSwitch(ROWS.term));
  byId("sentenceExtractionEnabled").addEventListener("change", () => void saveSwitch(ROWS.sentence));

  return Object.freeze({ refresh, assign });
}
