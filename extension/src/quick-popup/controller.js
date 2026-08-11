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

const FAST_MODE = Object.freeze({ concurrency: 5, batchItems: 32, batchChars: 3200 });
const NORMAL_MODE = Object.freeze({ concurrency: 3, batchItems: 24, batchChars: 1600 });

function isFastMode(runtime) {
  return runtime.webpageConcurrency === FAST_MODE.concurrency
    && runtime.webpageBatchItems === FAST_MODE.batchItems
    && runtime.webpageBatchChars === FAST_MODE.batchChars;
}

function fill(configuration) {
  const { ocr, translation, runtime } = configuration;
  byId("runtimeEnabled").checked = runtime.enabled;
  byId("sourceLanguage").value = translation.sourceLanguage;
  byId("targetLanguage").value = translation.targetLanguage;
  document.querySelector(`input[name='displayMode'][value='${runtime.displayMode}']`).checked = true;
  byId("webpageFastMode").checked = isFastMode(runtime);
  byId("webpageConcurrency").value = String(runtime.webpageConcurrency);
  byId("webpageBatchItems").value = String(runtime.webpageBatchItems);
  byId("webpageBatchChars").value = String(runtime.webpageBatchChars);
  byId("ocrDebug").checked = ocr.localPaddle.debug === true;
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
    displayMode: displayMode(),
    webpageConcurrency: Number(byId("webpageConcurrency").value),
    webpageBatchItems: Number(byId("webpageBatchItems").value),
    webpageBatchChars: Number(byId("webpageBatchChars").value)
  });
}

function saveOcr() {
  return queueSave("ocr", {
    ...configuration.ocr,
    localPaddle: {
      ...configuration.ocr.localPaddle,
      debug: byId("ocrDebug").checked
    }
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
byId("webpageFastMode").addEventListener("change", () => {
  const fast = byId("webpageFastMode").checked;
  const mode = fast ? FAST_MODE : NORMAL_MODE;
  byId("webpageConcurrency").value = String(mode.concurrency);
  byId("webpageBatchItems").value = String(mode.batchItems);
  byId("webpageBatchChars").value = String(mode.batchChars);
  void saveRuntime();
});
["webpageConcurrency", "webpageBatchItems", "webpageBatchChars"].forEach(id => {
  byId(id).addEventListener("change", () => {
    byId("webpageFastMode").checked = isFastMode({
      webpageConcurrency: Number(byId("webpageConcurrency").value),
      webpageBatchItems: Number(byId("webpageBatchItems").value),
      webpageBatchChars: Number(byId("webpageBatchChars").value)
    });
    void saveRuntime();
  });
});
byId("ocrDebug").addEventListener("change", () => void saveOcr());
byId("translateBtn").addEventListener("click", () => void translateVisible().catch(error => setStatus(error.message, true)));
byId("manageChapterBtn").addEventListener("click", () => void (async () => {
  const btn = byId("manageChapterBtn");
  btn.disabled = true;
  try {
    const tab = await activeTab();
    const probe = await chrome.tabs.sendMessage(tab.id, { type: "PING_CONTENT_SCRIPT" }).catch(() => null);
    if (!probe?.ok) throw new Error("当前标签页不可用，无法判断是否为可管理章节");
    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "GET_NOVEL_CHAPTER_SNAPSHOT" });
    if (!snapshot?.ok) throw new Error(snapshot?.error || "当前页面不是可管理的小说章节");
    await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
      throw new Error(`侧栏无法打开：${error?.message || error}`);
    });
    setStatus(`已打开侧栏：${snapshot.chapter.chapterTitle || ""}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    btn.disabled = false;
  }
})());
byId("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
void load().catch(error => setStatus(error.message, true));
