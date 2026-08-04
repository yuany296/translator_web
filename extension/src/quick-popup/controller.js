const byId = (id) => document.getElementById(id);
const value = (id) => byId(id).value;

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.ok === false) reject(new Error(response.error || "操作失败"));
    else resolve(response || {});
  }));
}

function setStatus(message, error = false) {
  const node = byId("globalStatus");
  node.textContent = message;
  node.classList.toggle("error", error);
}

function setSaveIndicator(message, error = false) {
  const node = byId("saveIndicator");
  node.textContent = message;
  node.classList.toggle("error", error);
}

function displayMode() {
  return document.querySelector("input[name='displayMode']:checked")?.value || "translated";
}

function fill(configuration) {
  const { translation, runtime } = configuration;
  byId("runtimeEnabled").checked = runtime.enabled;
  byId("sourceLanguage").value = translation.sourceLanguage;
  byId("targetLanguage").value = translation.targetLanguage;
  document.querySelector(`input[name='displayMode'][value='${runtime.displayMode}']`).checked = true;
}

function validatePair() {
  const source = value("sourceLanguage");
  const target = value("targetLanguage");
  if (source !== "auto" && source === target) throw new Error("原文语言与目标语言不能相同");
}

let configuration = null;
let saveSequence = Promise.resolve();
let saveRevision = 0;

function queueSave(section, nextValue) {
  const revision = ++saveRevision;
  configuration[section] = nextValue;
  setSaveIndicator("保存中…");
  saveSequence = saveSequence.then(async () => {
    const response = await send({ type: "SAVE_CONFIGURATION", section, value: nextValue });
    configuration[section] = response.value;
    if (revision === saveRevision) setSaveIndicator("已保存");
  }).catch(error => {
    if (revision === saveRevision) setSaveIndicator("保存失败", true);
    setStatus(error.message, true);
  });
  return saveSequence;
}

function saveLanguages() {
  try {
    validatePair();
    setStatus("");
    return queueSave("translation", {
      ...configuration.translation,
      sourceLanguage: value("sourceLanguage"), targetLanguage: value("targetLanguage")
    });
  } catch (error) {
    setSaveIndicator("未保存", true);
    setStatus(error.message, true);
    return Promise.resolve();
  }
}

function saveRuntime() {
  return queueSave("runtime", {
    ...configuration.runtime,
    enabled: byId("runtimeEnabled").checked,
    displayMode: displayMode()
  });
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("找不到当前标签页");
  return tabs[0];
}

async function translateVisible() {
  const button = byId("translateBtn");
  button.disabled = true;
  setStatus("正在识别并翻译当前可视区…");
  try {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_TRANSLATE_VISIBLE" });
    if (!response?.ok) throw new Error(response?.error || "翻译失败");
    setStatus(`翻译完成：${response.successCount || 0} 个目标`);
  } finally {
    button.disabled = false;
  }
}

async function loadTabStatus() {
  const tab = await activeTab();
  const response = await send({ type: "GET_TAB_STATUS", tabId: tab.id });
  if (response.status?.message && response.status.level !== "info") {
    setStatus(response.status.message, response.status.level === "error");
  }
}

async function load() {
  const response = await send({ type: "GET_CONFIGURATION" });
  configuration = response.configuration;
  fill(configuration);
  await loadTabStatus().catch(() => undefined);
}

byId("runtimeEnabled").addEventListener("change", () => void saveRuntime());
byId("sourceLanguage").addEventListener("change", () => void saveLanguages());
byId("targetLanguage").addEventListener("change", () => void saveLanguages());
document.querySelectorAll("input[name='displayMode']").forEach(node => {
  node.addEventListener("change", () => void saveRuntime());
});
byId("translateBtn").addEventListener("click", () => void translateVisible().catch(error => setStatus(error.message, true)));
byId("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
void load().catch(error => setStatus(error.message, true));
