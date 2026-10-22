import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("settings center owns advanced configuration and data management", () => {
  const html = read("extension", "public", "settings.html");
  const source = read("extension", "src", "settings", "controller.js");
  for (const route of ["general", "ocr", "translation", "reading", "glossary", "translations", "maintenance"]) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(html, new RegExp(`data-panel="${route}"`));
  }
  assert.match(html, /glossary\.html\?embedded=1/);
  assert.match(html, /translations\.html\?embedded=1/);
  assert.match(source, /TEST_OCR_CONFIGURATION/);
  assert.match(source, /TEST_TRANSLATION_CONFIGURATION/);
  assert.match(source, /GET_TRANSLATION_SERVICE_STATUS/);
  assert.match(source, /probeLocalServiceDocumentAccess/);
  assert.doesNotMatch(source, /PAIR_LOCAL_SERVICE/);
  assert.doesNotMatch(source, /配对码|pairingCode|pairServiceBtn/);
  assert.match(source, /GET_CACHE_STATS/);
  assert.match(source, /CLEAR_CACHE/);
  assert.doesNotMatch(html, /id="ocrLang"/);
  assert.match(html, /id="checkServiceBtn"/);
});

test("translation panel owns the merged provider profile card (选择服务商 → 填 Key/Model → 命名 → 保存)", () => {
  const html = read("extension", "public", "settings.html");
  const wizard = read("extension", "src", "settings", "vendor-ui.js");
  const store = read("extension", "src", "config", "store.js");
  // 档案与配置编辑合并为同一张卡片,不再提供表单直接编辑的第二个入口
  const translationPanel = html.match(/data-panel="translation"[\s\S]*?<\/section>/)[0];
  assert.match(translationPanel, /id="vendorSelect"/);
  assert.match(translationPanel, /id="testTranslationBtn"/);
  assert.doesNotMatch(translationPanel, /id="translationProvider"/);
  assert.doesNotMatch(translationPanel, /id="saveTranslationBtn"/);
  assert.doesNotMatch(translationPanel, /服务商配置/);
  // 两步向导的 DOM 锚点；配置档案的编辑/删除只在「管理配置档案」弹窗里，卡片上不再摆删除按钮
  for (const id of [
    "vendorNewBtn", "vendorManageBtn", "termServiceManageBtn", "sentenceServiceManageBtn",
    "vendorManagerDialog", "vendorManagerRows", "vendorManagerNewBtn", "vendorManagerCloseBtn",
    "vendorDialog",
    "vendorStepProvider", "vendorStepForm", "vendorProviderList", "vendorName",
    "vendorProviderLabel", "vendorUrl", "vendorKey", "vendorModel", "vendorFetchModelsBtn",
    "vendorBackBtn", "vendorSubmitBtn", "vendorFormError"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(translationPanel, /id="vendorDeleteBtn"/,
    "服务卡片里不能出现「删除」——删除语义只在管理配置档案弹窗里");
  assert.doesNotMatch(translationPanel, /id="vendorEditBtn"/);
  // 删除确认文案必须写明「只删这一套配置，翻译功能不受影响」
  assert.match(wizard, /翻译功能和其他配置都不受影响/);
  assert.match(wizard, /vendorManagerRows/);
  // 向导驱动:先选服务商(预设 Base URL/默认模型),再命名保存
  assert.doesNotMatch(wizard, /厂商/);
  assert.match(wizard, /选择服务商/);
  assert.match(wizard, /LLM_PROVIDERS/);
  assert.match(wizard, /SAVE_TRANSLATION_VENDOR/);
  assert.match(wizard, /ACTIVATE_TRANSLATION_VENDOR/);
  assert.match(wizard, /DELETE_TRANSLATION_VENDOR/);
  assert.match(wizard, /GET_LLM_MODELS/);
  assert.match(wizard, /请填写配置名称/);
  assert.match(wizard, /配置名称已存在/);
  assert.match(store, /getTranslationVendors/);
  assert.match(store, /entries: state\.vendors/);
});

test("术语提取并入翻译服务页：一套配置库 + 三个服务各自选择 + 两个开关", () => {
  const html = read("extension", "public", "settings.html");
  const source = read("extension", "src", "settings", "controller.js");
  const selection = read("extension", "src", "settings", "service-selection.js");
  const translationPanel = html.match(/data-panel="translation"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(html, /data-route="termExtraction"/u);
  assert.doesNotMatch(html, /data-panel="termExtraction"/u);
  assert.match(translationPanel, /id="termServiceSelect"/u);
  assert.match(translationPanel, /id="sentenceServiceSelect"/u);
  assert.match(translationPanel, /id="termDiscoveryEnabled"/u);
  assert.match(translationPanel, /id="sentenceExtractionEnabled"/u);
  assert.equal((html.match(/id="termDiscoveryEnabled"/gu) || []).length, 1,
    "阅读与显示里的重复开关已挪走");
  assert.doesNotMatch(html, /id="followTranslation"|id="termProvider"|id="saveTermExtractionBtn"/u);
  assert.match(source, /installServiceSelection/u);
  assert.match(source, /serviceSelection\.refresh/u);
  assert.match(selection, /termExtraction/u);
  assert.match(selection, /sentenceExtraction/u);
  assert.match(selection, /GET_TRANSLATION_VENDORS/u);
  assert.doesNotMatch(source, /installLlmExtractionFollow/u, "旧的跟随模块已删除");
});

test("legacy data pages route into their management-center sections", () => {
  assert.match(read("extension", "src", "glossary", "index.js"), /settings\.html#glossary/);
  assert.match(read("extension", "src", "translations", "index.js"), /settings\.html#translations/);
});

test("quick popup contains only high-frequency controls", () => {
  const manifest = JSON.parse(read("extension", "public", "manifest.json"));
  const html = read("extension", "public", manifest.action.default_popup);
  assert.match(html, /id="runtimeEnabled"/);
  assert.match(html, /id="sourceLanguage"/);
  assert.match(html, /id="targetLanguage"/);
  assert.match(html, /name="displayMode"/);
  assert.match(html, /id="translateBtn"/);
  assert.match(html, /id="settingsBtn"/);
  assert.doesNotMatch(html, /API Key|Provider|配对码|id="clearCacheBtn"|id="glossaryBtn"|id="translationLibraryBtn"/);
  assert.equal(fs.existsSync(path.join(root, "extension", "public", "popup.html")), false, "legacy popup.html must stay deleted");
  const lifecycle = read("extension", "src", "content", "modules", "lifecycle-bubble.js");
  const embedded = read("extension", "src", "content", "modules", "renderer-embed.js");
  assert.match(lifecycle, /state\.displayMode === "bilingual"/);
  assert.match(embedded, /state\.displayMode === "bilingual"/);
});
