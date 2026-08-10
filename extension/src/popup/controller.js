const byId = (id) => document.getElementById(id);
const value = (id) => byId(id).value.trim();
const checked = (id) => byId(id).checked;

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response || {});
  }));
}

function setStatus(section, message, error = false) {
  const node = byId(`${section}Status`);
  node.textContent = message;
  node.classList.toggle("error", error);
}

function showOcrProvider() {
  const local = value("ocrProvider") === "local_paddle";
  byId("localPaddleFields").classList.toggle("hidden", !local);
  byId("baiduFields").classList.toggle("hidden", local);
}

function updatePretranslateModeStatus() {
  const mode = value("pretranslateMode");
  const messages = {
    manual: "手动模式：仅在点击翻译时处理当前可视区域",
    ahead: "已开启：自动处理当前位置及后续 6 张图片",
    continuous: "已开启：从当前位置连续处理到本章末尾"
  };
  byId("pretranslateModeStatus").textContent = messages[mode] || messages.manual;
}

function fill(configuration) {
  const { ocr, translation, runtime } = configuration;
  byId("ocrProvider").value = ocr.provider;
  byId("ocrBaseUrl").value = ocr.localPaddle.baseUrl;
  byId("ocrLang").value = ocr.localPaddle.lang;
  byId("ocrMode").value = ocr.localPaddle.mode;
  byId("ocrDebug").checked = ocr.localPaddle.debug;
  byId("visionEnabled").checked = ocr.visionRepair.enabled;
  byId("visionKey").value = ocr.visionRepair.apiKey;
  byId("visionUrl").value = ocr.visionRepair.baseUrl;
  byId("visionModel").value = ocr.visionRepair.model;
  byId("baiduAk").value = ocr.baidu.apiKey;
  byId("baiduSk").value = ocr.baidu.secretKey;
  byId("translationModel").value = translation.model;
  byId("translationKey").value = translation.apiKey;
  byId("translationUrl").value = translation.baseUrl;
  byId("sourceLanguage").value = translation.sourceLanguage;
  byId("targetLanguage").value = translation.targetLanguage;
  byId("captureMode").value = runtime.captureMode;
  byId("renderMode").value = runtime.renderMode;
  byId("pretranslateMode").value = runtime.pretranslateMode;
  byId("webpageDisplayMode").value = runtime.webpageDisplayMode;
  byId("novelDisplayMode").value = runtime.novelDisplayMode;
  byId("runtimeEnabled").checked = runtime.enabled;
  byId("showBall").checked = runtime.showBall;
  byId("termDiscoveryEnabled").checked = runtime.termDiscoveryEnabled;
  showOcrProvider();
  updatePretranslateModeStatus();
}

function collect(section, current) {
  if (section === "ocr") return {
    ...current.ocr,
    provider: value("ocrProvider"),
    baidu: { apiKey: value("baiduAk"), secretKey: value("baiduSk") },
    localPaddle: {
      ...current.ocr.localPaddle, baseUrl: value("ocrBaseUrl"), lang: value("ocrLang"),
      mode: value("ocrMode"), debug: checked("ocrDebug")
    },
    visionRepair: {
      enabled: checked("visionEnabled"), apiKey: value("visionKey"),
      baseUrl: value("visionUrl"), model: value("visionModel")
    }
  };
  if (section === "translation") return {
    provider: "openai_compatible", model: value("translationModel"),
    apiKey: value("translationKey"), baseUrl: value("translationUrl"),
    sourceLanguage: value("sourceLanguage"), targetLanguage: value("targetLanguage")
  };
  return {
    ...current.runtime, enabled: checked("runtimeEnabled"), showBall: checked("showBall"),
    termDiscoveryEnabled: checked("termDiscoveryEnabled"),
    captureMode: value("captureMode"), renderMode: value("renderMode"),
    pretranslateMode: value("pretranslateMode"),
    webpageDisplayMode: value("webpageDisplayMode"), novelDisplayMode: value("novelDisplayMode")
  };
}

let configuration;
async function load() {
  const response = await send({ type: "GET_CONFIGURATION" });
  if (!response.ok) throw new Error(response.error || "读取配置失败");
  configuration = response.configuration;
  fill(configuration);
}

async function save(section) {
  setStatus(section, "保存中…");
  const response = await send({ type: "SAVE_CONFIGURATION", section, value: collect(section, configuration) });
  if (!response.ok) throw new Error(response.error || "保存失败");
  configuration[section] = response.value;
  setStatus(section, "已保存；其他模块缓存不受影响");
}

async function testConnection(section) {
  await save(section);
  setStatus(section, "连接测试中…");
  const type = section === "ocr" ? "TEST_OCR_CONFIGURATION" : "TEST_TRANSLATION_CONFIGURATION";
  const response = await send({ type });
  setStatus(section, response.ok ? "连接正常" : response.error || "连接失败", !response.ok);
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("找不到当前标签页");
  return tabs[0];
}

document.addEventListener("click", async (event) => {
  const saveSection = event.target.dataset.save;
  const testSection = event.target.dataset.test;
  try {
    if (saveSection) await save(saveSection);
    if (testSection) await testConnection(testSection);
    if (event.target.id === "clearCacheBtn") {
      await send({ type: "CLEAR_CACHE" });
      setStatus("global", "OCR 与翻译缓存已清除");
    }
    if (event.target.id === "glossaryBtn") chrome.runtime.openOptionsPage();
    if (event.target.id === "translationLibraryBtn") {
      void chrome.tabs.create({ url: chrome.runtime.getURL("translations.html") });
    }
    if (event.target.id === "checkLocalServiceBtn") {
      const response = await send({ type: "GET_TRANSLATION_SERVICE_STATUS" });
      setStatus("localService", response.ok
        ? `译文库在线 · revision ${response.changeSeq || 0}`
        : response.error || "译文库离线", !response.ok);
    }
    if (event.target.id === "translateBtn") {
      const tab = await activeTab();
      const response = await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_TRANSLATE_VISIBLE" });
      setStatus("global", response?.ok ? `完成：${response.successCount || 0} 个区域` : response?.error || "翻译失败", !response?.ok);
    }
  } catch (error) {
    setStatus(saveSection || testSection || "global", error.message, true);
  }
});

byId("ocrProvider").addEventListener("change", showOcrProvider);
byId("pretranslateMode").addEventListener("change", updatePretranslateModeStatus);
load().catch((error) => setStatus("global", error.message, true));
