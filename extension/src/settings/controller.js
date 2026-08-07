import { probeLocalServiceDocumentAccess } from "./local-service-access.js";

const byId = (id) => document.getElementById(id);
const value = (id) => byId(id).value.trim();
const checked = (id) => byId(id).checked;
const numberValue = (id) => Number(value(id));

const ROUTES = Object.freeze({
  general: ["常规", "常规设置", "配置日常翻译使用的默认行为。"],
  ocr: ["OCR", "OCR 设置", "配置识别服务、结果筛选和弱结果修复。"],
  translation: ["翻译服务", "翻译服务", "管理模型、密钥和本地正式译文库。"],
  reading: ["阅读与显示", "阅读与显示", "调整预翻译、渲染和页面辅助行为。"],
  glossary: ["术语库", "术语库", "管理正式术语、待确认候选和小说记忆。"],
  translations: ["译文库", "译文库", "检索、导入和维护 SQLite 正式译文。"],
  maintenance: ["维护与诊断", "维护与诊断", "检查本地服务并管理可安全清理的临时缓存。"]
});

const OCR_LANGUAGE_NAMES = Object.freeze({
  auto: "OCR 自动识别（日语 / 韩语）", ja: "OCR 日语模型", ko: "OCR 韩语模型",
  en: "OCR 英语模型", "zh-CN": "OCR 简体中文模型", "zh-TW": "OCR 繁体中文模型"
});

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.ok === false) reject(new Error(response.error || "操作失败"));
    else resolve(response || {});
  }));
}

function setStatus(id, message, error = false) {
  const node = byId(id);
  node.textContent = message;
  node.classList.toggle("error", error);
}

function displayMode() {
  return document.querySelector("input[name='displayMode']:checked")?.value || "translated";
}

function validateLanguagePair() {
  const source = value("sourceLanguage");
  if (source !== "auto" && source === value("targetLanguage")) {
    throw new Error("原文语言与目标语言不能相同（简体与繁体可以互译）");
  }
}

function showOcrProvider() {
  const local = value("ocrProvider") === "local_paddle";
  byId("localPaddleFields").classList.toggle("hidden", !local);
  byId("ocrModeField").classList.toggle("hidden", !local);
  byId("baiduFields").classList.toggle("hidden", local);
}

function updateOcrHint() {
  byId("ocrLanguageHint").textContent = OCR_LANGUAGE_NAMES[value("sourceLanguage")] || OCR_LANGUAGE_NAMES.auto;
}

function fill(configuration) {
  const { ocr, translation, runtime } = configuration;
  byId("runtimeEnabled").checked = runtime.enabled;
  byId("sourceLanguage").value = translation.sourceLanguage;
  byId("targetLanguage").value = translation.targetLanguage;
  document.querySelector(`input[name='displayMode'][value='${runtime.displayMode}']`).checked = true;
  byId("ocrProvider").value = ocr.provider;
  byId("ocrBaseUrl").value = ocr.localPaddle.baseUrl;
  byId("ocrMode").value = ocr.localPaddle.mode;
  byId("ocrDebug").checked = ocr.localPaddle.debug;
  byId("detThresh").value = ocr.localPaddle.detThresh;
  byId("detBoxThresh").value = ocr.localPaddle.detBoxThresh;
  byId("detUnclipRatio").value = ocr.localPaddle.detUnclipRatio;
  byId("baiduAk").value = ocr.baidu.apiKey;
  byId("baiduSk").value = ocr.baidu.secretKey;
  byId("confidenceThreshold").value = ocr.tuning.confidenceThreshold;
  byId("minBoxArea").value = ocr.tuning.minBoxArea;
  byId("maxBoxArea").value = ocr.tuning.maxBoxArea;
  byId("minBoxWidth").value = ocr.tuning.minBoxWidth;
  byId("minBoxHeight").value = ocr.tuning.minBoxHeight;
  byId("maxAspectRatio").value = ocr.tuning.maxAspectRatio;
  byId("mergeLineGap").value = ocr.tuning.mergeLineGap;
  byId("novelImageMergeLines").checked = ocr.tuning.novelImageMergeLines === true;
  byId("visionEnabled").checked = ocr.visionRepair.enabled;
  byId("visionKey").value = ocr.visionRepair.apiKey;
  byId("visionUrl").value = ocr.visionRepair.baseUrl;
  byId("visionModel").value = ocr.visionRepair.model;
  byId("translationModel").value = translation.model;
  byId("translationKey").value = translation.apiKey;
  byId("translationUrl").value = translation.baseUrl;
  byId("pretranslateMode").value = runtime.pretranslateMode;
  byId("captureMode").value = runtime.captureMode;
  byId("renderMode").value = runtime.renderMode;
  byId("showBall").checked = runtime.showBall;
  byId("termDiscoveryEnabled").checked = runtime.termDiscoveryEnabled;
  byId("ignoreSimplifiedChinese").checked = runtime.ignoreSimplifiedChinese;
  byId("floatingSide").value = runtime.floatingSide;
  byId("overwriteFontScale").value = runtime.overwriteFontScale;
  byId("overwriteCoverPadding").value = runtime.overwriteCoverPadding;
  byId("novelStreamBatchSize").value = runtime.novelStreamBatchSize;
  byId("debugOverlayMode").value = runtime.debugOverlayMode;
  byId("overwritePreviewMode").value = runtime.overwritePreviewMode;
  showOcrProvider();
  updateOcrHint();
}

let configuration = null;

async function saveSection(section, nextValue) {
  const response = await send({ type: "SAVE_CONFIGURATION", section, value: nextValue });
  configuration[section] = response.value;
  return response.value;
}

async function saveGeneral() {
  validateLanguagePair();
  setStatus("generalStatus", "保存中…");
  await saveSection("translation", {
    ...configuration.translation,
    sourceLanguage: value("sourceLanguage"), targetLanguage: value("targetLanguage")
  });
  await saveSection("runtime", {
    ...configuration.runtime, enabled: checked("runtimeEnabled"), displayMode: displayMode()
  });
  setStatus("generalStatus", "已保存");
}

function collectOcr() {
  return {
    ...configuration.ocr,
    provider: value("ocrProvider"),
    baidu: { apiKey: value("baiduAk"), secretKey: value("baiduSk") },
    localPaddle: {
      ...configuration.ocr.localPaddle,
      baseUrl: value("ocrBaseUrl"), mode: value("ocrMode"), debug: checked("ocrDebug"),
      detThresh: numberValue("detThresh"), detBoxThresh: numberValue("detBoxThresh"),
      detUnclipRatio: numberValue("detUnclipRatio")
    },
    tuning: {
      confidenceThreshold: numberValue("confidenceThreshold"), minBoxArea: numberValue("minBoxArea"),
      maxBoxArea: numberValue("maxBoxArea"), minBoxWidth: numberValue("minBoxWidth"),
      minBoxHeight: numberValue("minBoxHeight"), maxAspectRatio: numberValue("maxAspectRatio"),
      mergeLineGap: numberValue("mergeLineGap"), novelImageMergeLines: checked("novelImageMergeLines")
    },
    visionRepair: {
      enabled: checked("visionEnabled"), apiKey: value("visionKey"),
      baseUrl: value("visionUrl"), model: value("visionModel")
    }
  };
}

async function saveOcr() {
  setStatus("ocrStatus", "保存中…");
  await saveSection("ocr", collectOcr());
  setStatus("ocrStatus", "已保存");
}

async function saveTranslation() {
  setStatus("translationStatus", "保存中…");
  await saveSection("translation", {
    ...configuration.translation, model: value("translationModel"),
    apiKey: value("translationKey"), baseUrl: value("translationUrl")
  });
  setStatus("translationStatus", "已保存");
}

async function saveReading() {
  setStatus("readingStatus", "保存中…");
  await saveSection("runtime", {
    ...configuration.runtime,
    pretranslateMode: value("pretranslateMode"), captureMode: value("captureMode"),
    renderMode: value("renderMode"), showBall: checked("showBall"),
    termDiscoveryEnabled: checked("termDiscoveryEnabled"),
    ignoreSimplifiedChinese: checked("ignoreSimplifiedChinese"), floatingSide: value("floatingSide"),
    overwriteFontScale: numberValue("overwriteFontScale"),
    overwriteCoverPadding: numberValue("overwriteCoverPadding"),
    novelStreamBatchSize: numberValue("novelStreamBatchSize"),
    debugOverlayMode: value("debugOverlayMode"), overwritePreviewMode: value("overwritePreviewMode")
  });
  setStatus("readingStatus", "已保存");
}

async function testConnection(section, statusOverride = "") {
  if (section === "ocr") await saveOcr(); else await saveTranslation();
  const statusId = statusOverride || (section === "ocr" ? "ocrStatus" : "translationStatus");
  if (section === "ocr" && configuration.ocr.provider === "local_paddle") {
    setStatus(statusId, "正在确认 Chrome 本机访问权限…");
    await probeLocalServiceDocumentAccess(configuration.ocr.localPaddle.baseUrl);
  }
  setStatus(statusId, "正在测试连接…");
  const response = await send({ type: section === "ocr" ? "TEST_OCR_CONFIGURATION" : "TEST_TRANSLATION_CONFIGURATION" });
  setStatus(statusId, response.ok ? "连接正常" : response.error || "连接失败", !response.ok);
}

async function pairService() {
  setStatus("serviceStatus", "正在确认 Chrome 本机访问权限…");
  await probeLocalServiceDocumentAccess(configuration.ocr.localPaddle.baseUrl);
  setStatus("serviceStatus", "正在配对…");
  const response = await send({ type: "PAIR_LOCAL_SERVICE", pairingCode: value("pairingCode") });
  if (response.verified !== true) throw new Error("配对完成，但本地服务认证状态未确认");
  byId("pairingCode").value = "";
  setStatus("serviceStatus", "本地正式译文库已配对 · 认证正常");
}

async function checkService(statusId = "serviceStatus") {
  setStatus(statusId, "正在确认 Chrome 本机访问权限…");
  await probeLocalServiceDocumentAccess(configuration.ocr.localPaddle.baseUrl);
  setStatus(statusId, "正在检查译文库…");
  const response = await send({ type: "GET_TRANSLATION_SERVICE_STATUS" });
  setStatus(statusId, `译文库在线 · revision ${response.changeSeq || 0}`);
}

async function loadCacheStats() {
  const response = await send({ type: "GET_CACHE_STATS" });
  const stats = response.stats || {};
  byId("cacheSummary").textContent = `${stats.totalCount || 0} 条 · 约 ${stats.approxKB || 0} KB · ${stats.staleCount || 0} 条已过期`;
}

async function clearCache() {
  if (!confirm("确定清除 OCR 与翻译临时缓存吗？术语库和 SQLite 正式译文不会被删除。")) return;
  const response = await send({ type: "CLEAR_CACHE" });
  setStatus("cacheStatus", `已清除 ${response.removed || 0} 条临时缓存`);
  await loadCacheStats();
}

async function dedupeTranslations() {
  if (!confirm("按同一原文+译文合并重复记录：扩展缓存与 SQLite 正式译文库都会清理，每组保留最新一条。")) return;
  const response = await send({ type: "CLEAR_DUPLICATE_TRANSLATIONS" });
  let sqlite = { removed: 0, total: 0 };
  try {
    const stored = await chrome.storage.local.get("mt_local_service_auth_v1");
    const auth = stored.mt_local_service_auth_v1 || {};
    const baseUrl = configuration?.ocr?.localPaddle?.baseUrl || "http://127.0.0.1:8765";
    const resp = await fetch(`${baseUrl}/translations/dedupe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${String(auth.token || "")}`,
        ...(String(auth.origin || "") ? { "X-Manga-Translator-Origin": String(auth.origin) } : {})
      },
      body: "{}"
    });
    sqlite = resp.ok ? await resp.json() : { removed: 0, total: 0, error: `HTTP ${resp.status}` };
  } catch (error) {
    sqlite = { removed: 0, total: 0, error: error.message };
  }
  const suffix = sqlite.error ? `（SQLite 失败：${sqlite.error}）` : "";
  setStatus("dedupeStatus", `扩展缓存合并 ${response.removed || 0} 条；SQLite 清理 ${sqlite.removed || 0}/${sqlite.total || 0} 条${suffix}`);
  await loadCacheStats();
}

function activateRoute(route) {
  const active = ROUTES[route] ? route : "general";
  document.querySelectorAll("[data-route]").forEach(node => node.classList.toggle("active", node.dataset.route === active));
  document.querySelectorAll("[data-panel]").forEach(node => node.classList.toggle("hidden", node.dataset.panel !== active));
  const [crumb, title, subtitle] = ROUTES[active];
  byId("routeCrumb").textContent = crumb;
  byId("routeTitle").textContent = title;
  byId("routeSubtitle").textContent = subtitle;
  const frame = document.querySelector(`[data-panel='${active}'] iframe`);
  if (frame && !frame.getAttribute("src")) frame.setAttribute("src", frame.dataset.src);
}

function run(action, statusId = "settingsStatus") {
  return action().catch(error => setStatus(statusId, error.message, true));
}

document.querySelectorAll("[data-route]").forEach(node => node.addEventListener("click", () => {
  location.hash = node.dataset.route;
}));
window.addEventListener("hashchange", () => activateRoute(location.hash.slice(1)));
byId("ocrProvider").addEventListener("change", showOcrProvider);
byId("sourceLanguage").addEventListener("change", updateOcrHint);
byId("saveGeneralBtn").addEventListener("click", () => void run(saveGeneral, "generalStatus"));
byId("saveOcrBtn").addEventListener("click", () => void run(saveOcr, "ocrStatus"));
byId("testOcrBtn").addEventListener("click", () => void run(() => testConnection("ocr"), "ocrStatus"));
byId("saveTranslationBtn").addEventListener("click", () => void run(saveTranslation, "translationStatus"));
byId("testTranslationBtn").addEventListener("click", () => void run(() => testConnection("translation"), "translationStatus"));
byId("saveReadingBtn").addEventListener("click", () => void run(saveReading, "readingStatus"));
byId("pairServiceBtn").addEventListener("click", () => void run(pairService, "serviceStatus"));
byId("checkServiceBtn").addEventListener("click", () => void run(() => checkService(), "serviceStatus"));
byId("probeOcrBtn").addEventListener("click", () => void run(
  () => testConnection("ocr", "maintenanceServiceStatus"), "maintenanceServiceStatus"
));
byId("probeTranslationStoreBtn").addEventListener("click", () => void run(() => checkService("maintenanceServiceStatus"), "maintenanceServiceStatus"));
byId("clearCacheBtn").addEventListener("click", () => void run(clearCache, "cacheStatus"));
byId("dedupeBtn").addEventListener("click", () => void run(dedupeTranslations, "dedupeStatus"));

async function load() {
  const response = await send({ type: "GET_CONFIGURATION" });
  configuration = response.configuration;
  fill(configuration);
  activateRoute(location.hash.slice(1));
  await loadCacheStats().catch(error => setStatus("cacheStatus", error.message, true));
}

void load().catch(error => setStatus("settingsStatus", error.message, true));
