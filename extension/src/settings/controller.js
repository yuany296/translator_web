import { probeLocalServiceDocumentAccess } from "./local-service-access.js";
import { installVendorUi } from "./vendor-ui.js";
import { installServiceSelection } from "./service-selection.js";
import { describeNovelSpeed } from "../shared/novel-speed.js";
import { WEBPAGE_SPEED_PRESETS, describeWebpageSpeed, isWebpageFastMode } from "../shared/webpage-speed.js";

const byId = (id) => document.getElementById(id);
const value = (id) => byId(id).value.trim();
const checked = (id) => byId(id).checked;
const numberValue = (id) => Number(value(id));

const ROUTES = Object.freeze({
  general: ["常规", "常规设置", "配置日常翻译使用的默认行为。"],
  ocr: ["OCR", "OCR 设置", "配置识别服务、结果筛选和弱结果修复。"],
  translation: ["翻译服务", "翻译服务", "管理三个 AI 服务共用的配置库、提取开关和本地正式译文库。"],
  reading: ["阅读与显示", "阅读与显示", "调整预翻译、渲染和页面辅助行为。"],
  glossary: ["术语库", "术语库", "管理正式术语、待确认候选与各库的导入导出。"],
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
}function showOcrProvider() {
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
  byId("comicOcrOnly").checked = runtime.translationMode === "ocrOnly";
  byId("sourceLanguage").value = translation.sourceLanguage;
  byId("targetLanguage").value = translation.targetLanguage;
  document.querySelector(`input[name='displayMode'][value='${runtime.displayMode}']`).checked = true;
  [
    ["ocrProvider", ocr.provider], ["ocrBaseUrl", ocr.localPaddle.baseUrl], ["ocrMode", ocr.localPaddle.mode], ["detThresh", ocr.localPaddle.detThresh],
    ["detBoxThresh", ocr.localPaddle.detBoxThresh], ["detUnclipRatio", ocr.localPaddle.detUnclipRatio], ["baiduAk", ocr.baidu.apiKey], ["baiduSk", ocr.baidu.secretKey],
    ["confidenceThreshold", ocr.tuning.confidenceThreshold], ["minBoxArea", ocr.tuning.minBoxArea], ["maxBoxArea", ocr.tuning.maxBoxArea], ["minBoxWidth", ocr.tuning.minBoxWidth],
    ["minBoxHeight", ocr.tuning.minBoxHeight], ["maxAspectRatio", ocr.tuning.maxAspectRatio], ["mergeLineGap", ocr.tuning.mergeLineGap], ["visionKey", ocr.visionRepair.apiKey],
    ["visionUrl", ocr.visionRepair.baseUrl], ["visionModel", ocr.visionRepair.model]
  ].forEach(([id, v]) => { byId(id).value = v; });
  [
    ["ocrDebug", ocr.localPaddle.debug], ["novelImageMergeLines", ocr.tuning.novelImageMergeLines], ["visionEnabled", ocr.visionRepair.enabled],
    ["showBall", runtime.showBall], ["ignoreSimplifiedChinese", runtime.ignoreSimplifiedChinese]
  ].forEach(([id, v]) => { byId(id).checked = v === true; });
  [
    ["pretranslateMode", runtime.pretranslateMode], ["pretranslateAheadCount", runtime.pretranslateAheadCount], ["captureMode", runtime.captureMode], ["renderMode", runtime.renderMode], ["floatingSide", runtime.floatingSide],
    ["overwriteFontScale", runtime.overwriteFontScale], ["overwriteCoverPadding", runtime.overwriteCoverPadding], ["novelStreamBatchSize", runtime.novelStreamBatchSize],
    ["novelStreamConcurrency", runtime.novelStreamConcurrency], ["novelChunkChars", runtime.novelChunkChars],
    ["novelRepairConcurrency", runtime.novelRepairConcurrency],
    ["webpageConcurrency", runtime.webpageConcurrency], ["webpageBatchItems", runtime.webpageBatchItems],
    ["webpageBatchChars", runtime.webpageBatchChars],
    ["debugOverlayMode", runtime.debugOverlayMode], ["overwritePreviewMode", runtime.overwritePreviewMode]
  ].forEach(([id, v]) => { byId(id).value = v; });
  // 勾选状态按刚回填的三个输入框推出来（isWebpageFastMode 认的是 concurrency/batchItems/batchChars）
  syncWebpageFastMode();
  updateNovelSpeedHint();
  updateWebpageSpeedHint();
  showOcrProvider();
  updateOcrHint();
}

/** 「当前会怎么跑」：让用户不用试就知道并发 × 每批段数是一轮的上限。 */
function updateNovelSpeedHint() {
  byId("novelSpeedHint").textContent = describeNovelSpeed({
    streamConcurrency: numberValue("novelStreamConcurrency"),
    streamBatchSize: numberValue("novelStreamBatchSize"),
    chunkChars: numberValue("novelChunkChars"),
    repairConcurrency: numberValue("novelRepairConcurrency")
  });
}

/** 网页翻译速度卡：三格与「快速模式」勾选互相照镜子，提示行实时算出一批大概多大。 */
function readWebpageSpeedInputs() {
  return {
    concurrency: numberValue("webpageConcurrency"),
    batchItems: numberValue("webpageBatchItems"),
    batchChars: numberValue("webpageBatchChars")
  };
}

function updateWebpageSpeedHint() {
  byId("webpageSpeedHint").textContent = describeWebpageSpeed(readWebpageSpeedInputs());
}

/** 一键填档：只改输入框，落盘仍由「保存阅读设置」负责（与小说卡同一套模型）。 */
function applyWebpageSpeedPreset(fast) {
  const preset = fast ? WEBPAGE_SPEED_PRESETS.fast : WEBPAGE_SPEED_PRESETS.normal;
  byId("webpageConcurrency").value = String(preset.concurrency);
  byId("webpageBatchItems").value = String(preset.batchItems);
  byId("webpageBatchChars").value = String(preset.batchChars);
  updateWebpageSpeedHint();
}

/** 用户手改任意一格，勾选状态要跟着掉，否则「快速模式」会说谎。 */
function syncWebpageFastMode() {
  byId("webpageFastMode").checked = isWebpageFastMode(readWebpageSpeedInputs());
}

let configuration = null;

/** 三处 AI 服务的「用哪条配置 + 开关」都在这个模块里（controller 有 400 行门禁）。 */
const serviceSelection = installServiceSelection({
  byId, checked, send, saveSection, setStatus,
  getConfiguration: () => configuration,
  requestCreate: prefix => vendorUi?.openWizard("create", { onSaved: name => serviceSelection.assign(prefix, name) })
});

/** 思考模式不再是这里的一行：它是配置档案条目的字段，随「新建/编辑配置」向导一起填。 */

async function saveSection(section, nextValue) {
  const response = await send({ type: "SAVE_CONFIGURATION", section, value: nextValue });
  configuration[section] = response.value;
  return response.value;
}

async function saveGeneral() {
  validateLanguagePair();
  setStatus("generalStatus", "保存中…");
  await saveSection("translation", { ...configuration.translation, sourceLanguage: value("sourceLanguage"), targetLanguage: value("targetLanguage") });
  await saveSection("runtime", { ...configuration.runtime, enabled: checked("runtimeEnabled"), displayMode: displayMode(), translationMode: checked("comicOcrOnly") ? "ocrOnly" : "provider" });
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
    },    visionRepair: {
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

async function saveReading() {
  setStatus("readingStatus", "保存中…");
  await saveSection("runtime", {
    ...configuration.runtime,
    pretranslateMode: value("pretranslateMode"), pretranslateAheadCount: numberValue("pretranslateAheadCount"), captureMode: value("captureMode"), renderMode: value("renderMode"),
    showBall: checked("showBall"), ignoreSimplifiedChinese: checked("ignoreSimplifiedChinese"),
    floatingSide: value("floatingSide"), overwriteFontScale: numberValue("overwriteFontScale"), overwriteCoverPadding: numberValue("overwriteCoverPadding"),
    novelStreamBatchSize: numberValue("novelStreamBatchSize"), debugOverlayMode: value("debugOverlayMode"), overwritePreviewMode: value("overwritePreviewMode"),
    novelStreamConcurrency: numberValue("novelStreamConcurrency"), novelChunkChars: numberValue("novelChunkChars"),
    novelRepairConcurrency: numberValue("novelRepairConcurrency"),
    webpageConcurrency: numberValue("webpageConcurrency"), webpageBatchItems: numberValue("webpageBatchItems"),
    webpageBatchChars: numberValue("webpageBatchChars")
  });
  fill(configuration);
  setStatus("readingStatus", "已保存");
}

async function testConnection(section, statusOverride = "") {
  const statusId = statusOverride || (section === "ocr" ? "ocrStatus" : "translationStatus");
  if (section === "ocr") {
    await saveOcr();
    if (configuration.ocr.provider === "local_paddle") {
      setStatus(statusId, "正在确认 Chrome 本机访问权限…");
      await probeLocalServiceDocumentAccess(configuration.ocr.localPaddle.baseUrl);
    }
  }
  // 翻译配置没有独立表单:直接测试当前激活的命名配置(或未启用时的翻译配置)
  setStatus(statusId, "正在测试连接…");
  const response = await send({ type: section === "ocr" ? "TEST_OCR_CONFIGURATION" : "TEST_TRANSLATION_CONFIGURATION" });
  setStatus(statusId, response.ok ? "连接正常" : response.error || "连接失败", !response.ok);
}

async function checkService(statusId = "serviceStatus") {
  setStatus(statusId, "正在确认 Chrome 本机访问权限…");
  await probeLocalServiceDocumentAccess(configuration.ocr.localPaddle.baseUrl);
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
    const baseUrl = configuration?.ocr?.localPaddle?.baseUrl || "http://127.0.0.1:8765";
    const resp = await fetch(`${baseUrl}/translations/dedupe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    sqlite = resp.ok ? await resp.json() : { removed: 0, total: 0, error: `HTTP ${resp.status}` };
  } catch (error) {
    sqlite = { removed: 0, total: 0, error: error.message };
  }
  setStatus("dedupeStatus", `扩展缓存合并 ${response.removed || 0} 条；SQLite 清理 ${sqlite.removed || 0}/${sqlite.total || 0} 条${sqlite.error ? `（SQLite 失败：${sqlite.error}）` : ""}`);
  await loadCacheStats();
}

function activateRoute(route) {
  // 旧书签可能还指向已合并进「翻译服务」的术语提取页
  const requested = route === "termExtraction" ? "translation" : route;
  const active = ROUTES[requested] ? requested : "general";
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
// 速度参数是改完下一次翻译才生效，所以输入时就实时算出「一轮能翻多少段」，不用等保存
["novelStreamConcurrency", "novelStreamBatchSize", "novelChunkChars", "novelRepairConcurrency"]
  .forEach(id => byId(id).addEventListener("input", updateNovelSpeedHint));
// 网页翻译速度同理：边输边算「一批多大」，手改任意一格就让「快速模式」勾选跟着掉
["webpageConcurrency", "webpageBatchItems", "webpageBatchChars"].forEach(id => {
  byId(id).addEventListener("input", () => {
    updateWebpageSpeedHint();
    syncWebpageFastMode();
  });
});
byId("webpageFastMode").addEventListener("change", () => applyWebpageSpeedPreset(byId("webpageFastMode").checked));
byId("saveGeneralBtn").addEventListener("click", () => void run(saveGeneral, "generalStatus"));
byId("saveOcrBtn").addEventListener("click", () => void run(saveOcr, "ocrStatus"));
byId("testOcrBtn").addEventListener("click", () => void run(() => testConnection("ocr"), "ocrStatus"));
byId("testTranslationBtn").addEventListener("click", () => void run(() => testConnection("translation"), "translationStatus"));
byId("saveReadingBtn").addEventListener("click", () => void run(saveReading, "readingStatus"));
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
  if (vendorUi) await vendorUi.refresh().catch(error => setStatus("settingsStatus", error.message, true));
  // 配置库增删改之后三行服务的选择要跟着刷新
  await serviceSelection.refresh().catch(error => setStatus("serviceSelectionStatus", error.message, true));
}
// 只安装一次：load 会在档案切换/保存后被重复调用
const vendorUi = installVendorUi({ reloadConfiguration: load });
void load().catch(error => setStatus("settingsStatus", error.message, true));
