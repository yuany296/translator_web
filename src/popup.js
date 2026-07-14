const STORAGE_KEYS = {
  provider: "mt_provider",
  model: "mt_model",
  apiKey: "mt_api_key",
  baseUrl: "mt_base_url",
  baiduApiKey: "mt_baidu_api_key",
  baiduSecretKey: "mt_baidu_secret_key",
  localOcrBaseUrl: "mt_local_ocr_base_url",
  localOcrLang: "mt_local_ocr_lang",
  localOcrMode: "mt_local_ocr_mode",
  localOcrDetThresh: "mt_local_ocr_det_thresh",
  localOcrDetBoxThresh: "mt_local_ocr_det_box_thresh",
  localOcrDetUnclipRatio: "mt_local_ocr_det_unclip_ratio",
  localOcrDebug: "mt_local_ocr_debug",
  visionOcrApiKey: "mt_vision_ocr_api_key",
  visionOcrBaseUrl: "mt_vision_ocr_base_url",
  visionOcrModel: "mt_vision_ocr_model",
  visionOcrEnabled: "mt_vision_ocr_enabled",
  enabled: "mt_enabled",
  showBall: "mt_show_ball",
  captureMode: "mt_capture_mode",
  renderMode: "mt_render_mode",
  pretranslateMode: "mt_pretranslate_mode",
  ignoreSimplifiedChinese: "mt_ignore_simplified_zh",
  glossaryStorage: "mt_glossary_storage"
};

const DEFAULTS = {
  provider: "baidu_deepseek",
  modelByProvider: {
    baidu_deepseek: "deepseek-chat",
    local_paddle_deepseek: "deepseek-chat"
  },
  baseUrl: "",
  localOcrBaseUrl: "http://127.0.0.1:8765",
  localOcrLang: "auto",
  localOcrMode: "fast",
  localOcrDetThresh: 0.3,
  localOcrDetBoxThresh: 0.6,
  localOcrDetUnclipRatio: 1.2,
  localOcrDebug: false,
  visionOcrApiKey: "",
  visionOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionOcrModel: "qwen-vl-ocr-latest",
  visionOcrEnabled: false,
  captureMode: "direct",
  pretranslateMode: "manual",
  enabled: true
};

const CONTENT_SCRIPT_FILES = Object.freeze(["kakao-reconciler.js", "kakao-pipeline.js", "content.js"]);

const providerMeta = {
  baidu_deepseek: {
    apiKeyLabel: "Translation API Key",
    apiKeyPlaceholder: "sk-..."
  },
  local_paddle_deepseek: {
    apiKeyLabel: "Text Translation API Key",
    apiKeyPlaceholder: "sk-..."
  }
};

const providerSelect = document.getElementById("providerSelect");
const modelInput = document.getElementById("modelInput");
const apiKeyLabel = document.getElementById("apiKeyLabel");
const apiKeyInput = document.getElementById("apiKeyInput");
const baseUrlField = document.getElementById("baseUrlField");
const baseUrlInput = document.getElementById("baseUrlInput");
const baiduFields = document.getElementById("baiduFields");
const baiduApiKeyInput = document.getElementById("baiduApiKeyInput");
const baiduSecretKeyInput = document.getElementById("baiduSecretKeyInput");
const localOcrFields = document.getElementById("localOcrFields");
const localOcrBaseUrlInput = document.getElementById("localOcrBaseUrlInput");
const localOcrLangSelect = document.getElementById("localOcrLangSelect");
const localOcrDebugSwitch = document.getElementById("localOcrDebugSwitch");
const visionOcrEnabledSwitch = document.getElementById("visionOcrEnabledSwitch");
const visionOcrApiKeyInput = document.getElementById("visionOcrApiKeyInput");
const visionOcrBaseUrlInput = document.getElementById("visionOcrBaseUrlInput");
const visionOcrModelInput = document.getElementById("visionOcrModelInput");
const enabledSwitch = document.getElementById("enabledSwitch");
const showBallSwitch = document.getElementById("showBallSwitch");
const captureModeSelect = document.getElementById("captureModeSelect");
const renderModeSelect = document.getElementById("renderModeSelect");
const pretranslateModeSelect = document.getElementById("pretranslateModeSelect");
const pretranslateModeStatus = document.createElement("div");
pretranslateModeStatus.className = "mode-status";
pretranslateModeSelect.insertAdjacentElement("afterend", pretranslateModeStatus);
const ignoreZhSwitch = document.getElementById("ignoreZhSwitch");
const termDiscoverySwitch = document.getElementById("termDiscoverySwitch");
const glossaryBtn = document.getElementById("glossaryBtn");
const saveBtn = document.getElementById("saveBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const translateBtn = document.getElementById("translateBtn");
const statusText = document.getElementById("statusText");
const tabStatus = document.getElementById("tabStatus");
const cacheStats = document.getElementById("cacheStats");
const glossaryStorageSelect = document.getElementById("glossaryStorageSelect");
const glossaryStorageRow = document.getElementById("glossaryStorageRow");
const ocrServiceStatus = document.getElementById("ocrServiceStatus");
const termDiscoveryStatus = document.getElementById("termDiscoveryStatus");
let pageAutoTranslateEnabled = false;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadSettings();
  await refreshCacheStats();
  await refreshTabStatus();
  await refreshPageAutoTranslateStatus();
  await refreshTermDiscoveryStatus(true);
  await refreshOcrServiceStatus();
});

function bindEvents() {
  providerSelect.addEventListener("change", onProviderChanged);
  pretranslateModeSelect.addEventListener("change", () => {
    updatePretranslateModeStatus();
    updatePageAutoTranslateButton();
  });
  termDiscoverySwitch.addEventListener("change", updateTermDiscoveryEnabled);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      (changes.mt_glossary_pending_v1 || changes.mt_term_discovery_enabled)
    ) {
      refreshTermDiscoveryStatus(false).catch(() => undefined);
    }
  });

  glossaryBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  saveBtn.addEventListener("click", async () => {
    await saveSettings();
  });

  clearCacheBtn.addEventListener("click", async () => {
    await clearCache();
  });

  translateBtn.addEventListener("click", async () => {
    await handleTranslateButtonClick();
  });
}

function onProviderChanged() {
  const provider = normalizeProvider(providerSelect.value);
  applyProviderUi(provider);

  if (!modelInput.value.trim()) {
    modelInput.value = DEFAULTS.modelByProvider[provider] || "";
  }

  if ((provider === "baidu_deepseek" || provider === "local_paddle_deepseek") && !baseUrlInput.value.trim()) {
    baseUrlInput.value = "https://api.deepseek.com";
  }
  if (provider === "local_paddle_deepseek" && !localOcrBaseUrlInput.value.trim()) {
    localOcrBaseUrlInput.value = DEFAULTS.localOcrBaseUrl;
  }
  if (provider === "local_paddle_deepseek") {
    if (!visionOcrBaseUrlInput.value.trim()) {
      visionOcrBaseUrlInput.value = DEFAULTS.visionOcrBaseUrl;
    }
    if (!visionOcrModelInput.value.trim()) {
      visionOcrModelInput.value = DEFAULTS.visionOcrModel;
    }
  }
  refreshOcrServiceStatus().catch(() => {});
}

function updatePretranslateModeStatus() {
  const mode = normalizePretranslateMode(pretranslateModeSelect.value);
  if (mode === "continuous") {
    pretranslateModeStatus.textContent = "\u5df2\u5f00\u542f\uff1a\u4ece\u5f53\u524d\u4f4d\u7f6e\u8fde\u7eed\u5904\u7406\u5230\u672c\u7ae0\u672b\u5c3e";
    return;
  }
  pretranslateModeStatus.textContent = normalizePretranslateMode(pretranslateModeSelect.value) === "ahead"
    ? "已开启：自动处理当前位置及后续 6 张图片"
    : "手动模式：仅在点击翻译时处理图片";
}

async function loadSettings() {
  try {
    const data = await storageGet([
      STORAGE_KEYS.provider,
      STORAGE_KEYS.model,
      STORAGE_KEYS.apiKey,
      STORAGE_KEYS.baseUrl,
      STORAGE_KEYS.baiduApiKey,
      STORAGE_KEYS.baiduSecretKey,
      STORAGE_KEYS.localOcrBaseUrl,
      STORAGE_KEYS.localOcrLang,
      STORAGE_KEYS.localOcrDebug,
      STORAGE_KEYS.visionOcrApiKey,
      STORAGE_KEYS.visionOcrBaseUrl,
      STORAGE_KEYS.visionOcrModel,
      STORAGE_KEYS.visionOcrEnabled,
      STORAGE_KEYS.enabled,
      STORAGE_KEYS.showBall,
      STORAGE_KEYS.captureMode,
      STORAGE_KEYS.renderMode,
      STORAGE_KEYS.pretranslateMode,
      STORAGE_KEYS.ignoreSimplifiedChinese,
      STORAGE_KEYS.glossaryStorage
    ]);

    const storedProvider = String(data[STORAGE_KEYS.provider] || "").trim().toLowerCase();
    const provider = normalizeProvider(storedProvider);
    const model = String(data[STORAGE_KEYS.model] || "").trim();

    providerSelect.value = provider;
    modelInput.value = (storedProvider === provider ? model : "") || DEFAULTS.modelByProvider[provider];
    apiKeyInput.value = String(data[STORAGE_KEYS.apiKey] || "");
    baseUrlInput.value = sanitizeBaseUrl(data[STORAGE_KEYS.baseUrl] || "");
    baiduApiKeyInput.value = String(data[STORAGE_KEYS.baiduApiKey] || "");
    baiduSecretKeyInput.value = String(data[STORAGE_KEYS.baiduSecretKey] || "");
    localOcrBaseUrlInput.value = sanitizeLocalOcrBaseUrl(data[STORAGE_KEYS.localOcrBaseUrl] || DEFAULTS.localOcrBaseUrl);
    localOcrLangSelect.value = normalizeLocalOcrLang(data[STORAGE_KEYS.localOcrLang]);
    localOcrDebugSwitch.checked = data[STORAGE_KEYS.localOcrDebug] === true;
    visionOcrEnabledSwitch.checked = data[STORAGE_KEYS.visionOcrEnabled] === true;
    visionOcrApiKeyInput.value = String(data[STORAGE_KEYS.visionOcrApiKey] || "");
    visionOcrBaseUrlInput.value = sanitizeBaseUrl(data[STORAGE_KEYS.visionOcrBaseUrl] || DEFAULTS.visionOcrBaseUrl);
    visionOcrModelInput.value = String(data[STORAGE_KEYS.visionOcrModel] || DEFAULTS.visionOcrModel);
    enabledSwitch.checked = data[STORAGE_KEYS.enabled] !== false;
    showBallSwitch.checked = data[STORAGE_KEYS.showBall] !== false;
    captureModeSelect.value = normalizeCaptureMode(data[STORAGE_KEYS.captureMode]);
    renderModeSelect.value = normalizeRenderMode(data[STORAGE_KEYS.renderMode]);
    pretranslateModeSelect.value = normalizePretranslateMode(data[STORAGE_KEYS.pretranslateMode]);
    updatePretranslateModeStatus();
    ignoreZhSwitch.checked = data[STORAGE_KEYS.ignoreSimplifiedChinese] === true;
    glossaryStorageSelect.value = data[STORAGE_KEYS.glossaryStorage] === "server" ? "server" : "local";
    glossaryStorageRow.style.display = provider === "local_paddle_deepseek" ? "flex" : "none";

    applyProviderUi(provider);
  } catch (error) {
    setStatus(`读取配置失败：${getErrorMessage(error)}`, true);
  }
}

async function saveSettings() {
  const provider = normalizeProvider(providerSelect.value);
  const model = String(modelInput.value || "").trim() || DEFAULTS.modelByProvider[provider];
  const apiKey = String(apiKeyInput.value || "").trim();
  const baseUrl = sanitizeBaseUrl(baseUrlInput.value);
  const baiduApiKey = String(baiduApiKeyInput.value || "").trim();
  const baiduSecretKey = String(baiduSecretKeyInput.value || "").trim();
  const localOcrBaseUrl = sanitizeLocalOcrBaseUrl(localOcrBaseUrlInput.value || DEFAULTS.localOcrBaseUrl);
  const localOcrLang = normalizeLocalOcrLang(localOcrLangSelect.value);
  const localOcrDebug = localOcrDebugSwitch.checked;
  const visionOcrEnabled = visionOcrEnabledSwitch.checked;
  const visionOcrApiKey = String(visionOcrApiKeyInput.value || "").trim();
  const visionOcrBaseUrl = sanitizeBaseUrl(visionOcrBaseUrlInput.value || DEFAULTS.visionOcrBaseUrl);
  const visionOcrModel = String(visionOcrModelInput.value || "").trim() || DEFAULTS.visionOcrModel;
  const enabled = enabledSwitch.checked;
  const showBall = showBallSwitch.checked;
  const captureMode = normalizeCaptureMode(captureModeSelect.value);
  const renderMode = normalizeRenderMode(renderModeSelect.value);
  const pretranslateMode = normalizePretranslateMode(pretranslateModeSelect.value);
  const ignoreSimplifiedChinese = ignoreZhSwitch.checked;

  if (!apiKey) {
    setStatus(
      provider === "baidu_deepseek" || provider === "local_paddle_deepseek"
        ? "请先填写翻译接口 API Key"
        : "请先填写 API Key",
      true
    );
    return;
  }

  if (provider === "baidu_deepseek" && (!baiduApiKey || !baiduSecretKey)) {
    setStatus("baidu_deepseek 模式必须填写百度 OCR AK/SK", true);
    return;
  }

  if (provider === "local_paddle_deepseek" && !localOcrBaseUrl) {
    setStatus("local_paddle_deepseek 模式必须填写本地 OCR 服务地址", true);
    return;
  }

  if (provider === "local_paddle_deepseek" && visionOcrEnabled && (!visionOcrApiKey || !visionOcrBaseUrl || !visionOcrModel)) {
    setStatus("Vision OCR enabled: please fill Vision OCR API Key, Base URL, and Model", true);
    return;
  }

  try {
    await storageSet({
      [STORAGE_KEYS.provider]: provider,
      [STORAGE_KEYS.model]: model,
      [STORAGE_KEYS.apiKey]: apiKey,
      [STORAGE_KEYS.baseUrl]:
        (provider === "baidu_deepseek" || provider === "local_paddle_deepseek") && !baseUrl
          ? "https://api.deepseek.com"
          : baseUrl,
      [STORAGE_KEYS.baiduApiKey]: baiduApiKey,
      [STORAGE_KEYS.baiduSecretKey]: baiduSecretKey,
      [STORAGE_KEYS.localOcrBaseUrl]: localOcrBaseUrl,
      [STORAGE_KEYS.localOcrLang]: localOcrLang,
      [STORAGE_KEYS.localOcrMode]: DEFAULTS.localOcrMode,
      [STORAGE_KEYS.localOcrDetThresh]: DEFAULTS.localOcrDetThresh,
      [STORAGE_KEYS.localOcrDetBoxThresh]: DEFAULTS.localOcrDetBoxThresh,
      [STORAGE_KEYS.localOcrDetUnclipRatio]: DEFAULTS.localOcrDetUnclipRatio,
      [STORAGE_KEYS.localOcrDebug]: localOcrDebug,
      [STORAGE_KEYS.visionOcrEnabled]: visionOcrEnabled,
      [STORAGE_KEYS.visionOcrApiKey]: visionOcrApiKey,
      [STORAGE_KEYS.visionOcrBaseUrl]: visionOcrBaseUrl || DEFAULTS.visionOcrBaseUrl,
      [STORAGE_KEYS.visionOcrModel]: visionOcrModel,
      [STORAGE_KEYS.enabled]: enabled,
      [STORAGE_KEYS.showBall]: showBall,
      [STORAGE_KEYS.captureMode]: captureMode,
      [STORAGE_KEYS.renderMode]: renderMode,
      [STORAGE_KEYS.pretranslateMode]: pretranslateMode,
      [STORAGE_KEYS.ignoreSimplifiedChinese]: ignoreSimplifiedChinese,
      [STORAGE_KEYS.glossaryStorage]: glossaryStorageSelect.value
    });

    setStatus("配置已保存", false);
    await refreshTabStatus();
  } catch (error) {
    setStatus(`保存失败：${getErrorMessage(error)}`, true);
  }
}

async function clearCache() {
  try {
    const response = await sendRuntimeMessage({ type: "CLEAR_CACHE" });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "清空失败");
    }

    setStatus(`缓存已清空：${response.removed || 0} 条`, false);
    await refreshCacheStats();
  } catch (error) {
    setStatus(`清空缓存失败：${getErrorMessage(error)}`, true);
  }
}

async function handleTranslateButtonClick() {
  if (shouldTranslateButtonUsePageAuto()) {
    await togglePageAutoTranslate();
    return;
  }

  await translateCurrentViewport();
}

async function translateCurrentViewport() {
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      throw new Error("当前标签页不可用");
    }

    setStatus("正在翻译当前视口...", false);
    await ensureContentInjected(tab.id);

    const response = await runManualTranslateAllFrames(tab.id);

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "当前视口翻译失败");
    }

    const visibleCount = Number(response.visibleCount || 0);
    const successCount = Number(response.successCount || 0);
    const failCount = Number(response.failCount || 0);
    const firstError = Array.isArray(response.errors) ? response.errors[0] : "";

    if (visibleCount === 0) {
      setStatus("当前视口没有可翻译的漫画图片/画布", true);
    } else if (failCount === 0) {
      setStatus(`当前视口翻译完成：${successCount}/${visibleCount}`, false);
    } else if (successCount > 0) {
      setStatus(`当前视口部分成功 ${successCount}/${visibleCount}，失败 ${failCount}`, true);
    } else {
      const suffix = firstError ? `，首个错误：${firstError}` : "";
      setStatus(`当前视口全部失败：${failCount}/${visibleCount}${suffix}`, true);
    }

    await refreshCacheStats();
    await refreshTabStatus(tab.id);
  } catch (error) {
    setStatus(`执行失败：${getErrorMessage(error)}`, true);
  }
}

async function togglePageAutoTranslate() {
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      throw new Error("当前标签页不可用");
    }

    setStatus(pageAutoTranslateEnabled ? "正在停止本页自动翻译..." : "正在开启本页自动翻译...", false);
    await ensureContentInjected(tab.id);

    const response = await runTogglePageAutoTranslateAllFrames(tab.id, !pageAutoTranslateEnabled);

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "本页自动翻译切换失败");
    }

    pageAutoTranslateEnabled = response.enabled === true;
    updatePageAutoTranslateButton();

    const visibleCount = Number(response.visibleCount || 0);
    const successCount = Number(response.successCount || 0);
    const failCount = Number(response.failCount || 0);
    const queuedCount = Number(response.queuedCount || 0);
    const runningCount = Number(response.runningCount || 0);
    const firstError = Array.isArray(response.errors) ? response.errors[0] : "";

    if (!pageAutoTranslateEnabled) {
      setStatus("已停止本页自动翻译，已有译文会保留", false);
    } else if (successCount === 0 && failCount === 0 && (queuedCount > 0 || runningCount > 0)) {
      const pendingCount = queuedCount + runningCount;
      const targetCount = visibleCount || pendingCount;
      setStatus(`本页自动翻译已开启：当前视口已入队 ${targetCount} 张，继续滚动会预先翻译`, false);
    } else if (visibleCount === 0) {
      setStatus("当前视口没有可翻译的漫画图片/画布", true);
    } else if (failCount === 0) {
      setStatus(`本页自动翻译已开启：当前视口 ${successCount}/${visibleCount}，继续滚动会自动翻译`, false);
    } else if (successCount > 0) {
      setStatus(`本页自动翻译已开启：当前视口部分成功 ${successCount}/${visibleCount}，失败 ${failCount}`, true);
    } else {
      const suffix = firstError ? `，首个错误：${firstError}` : "";
      setStatus(`本页自动翻译已开启，但当前视口全部失败：${failCount}/${visibleCount}${suffix}`, true);
    }

    await refreshCacheStats();
    await refreshTabStatus(tab.id);
  } catch (error) {
    setStatus(`执行失败：${getErrorMessage(error)}`, true);
  }
}

async function refreshPageAutoTranslateStatus() {
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      pageAutoTranslateEnabled = false;
      updatePageAutoTranslateButton();
      return;
    }

    const response = await runGetPageAutoTranslateStatusAllFrames(tab.id);
    pageAutoTranslateEnabled = !!(response && response.ok && response.enabled);
    updatePageAutoTranslateButton();
  } catch {
    pageAutoTranslateEnabled = false;
    updatePageAutoTranslateButton();
  }
}

function updatePageAutoTranslateButton() {
  if (pageAutoTranslateEnabled) {
    translateBtn.textContent = "关闭本页自动翻译";
  } else if (shouldTranslateButtonUsePageAuto()) {
    translateBtn.textContent = "开启本页自动翻译";
  } else {
    translateBtn.textContent = "翻译当前视口";
  }
  translateBtn.dataset.autoTranslateEnabled = pageAutoTranslateEnabled ? "true" : "false";
}

function shouldTranslateButtonUsePageAuto() {
  return pageAutoTranslateEnabled || normalizePretranslateMode(pretranslateModeSelect.value) !== "manual";
}

async function runTogglePageAutoTranslateAllFrames(tabId, enabled) {
  try {
    const frameResults = await executePageAutoTranslateInAllFrames(tabId, enabled);
    const merged = mergePageAutoFrameResults(frameResults);
    if (hasUsablePageAutoFrameResult(merged)) {
      return { ok: true, ...merged };
    }
  } catch (error) {
    if (!isRecoverableTabMessageError(error)) {
      throw error;
    }
  }

  let response;
  try {
    response = await sendMessageToTab(tabId, { type: "TOGGLE_PAGE_AUTO_TRANSLATE", enabled });
  } catch (error) {
    if (!isRecoverableTabMessageError(error)) {
      throw error;
    }

    await ensureContentInjected(tabId);
    response = await sendMessageToTab(tabId, { type: "TOGGLE_PAGE_AUTO_TRANSLATE", enabled });
  }

  if (!response || !response.ok) {
    return { ok: false, error: response && response.error ? response.error : "page auto translate toggle failed" };
  }

  return {
    ok: true,
    frameCount: 1,
    enabled: response.enabled === true,
    visibleCount: Number(response.visibleCount || 0),
    successCount: Number(response.successCount || 0),
    failCount: Number(response.failCount || 0),
    errors: Array.isArray(response.errors) ? response.errors.filter(Boolean) : []
  };
}

function executePageAutoTranslateInAllFrames(tabId, enabled) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        func: async (nextEnabled) => {
          const api = globalThis.__MANGA_TRANSLATOR_V3__;
          if (!api || typeof api.togglePageAutoTranslate !== "function" || api.invalidated) {
            return { ok: false, skipped: true, reason: "content-not-ready" };
          }

          try {
            const result = await api.togglePageAutoTranslate(nextEnabled);
            return { ok: true, result };
          } catch (error) {
            return {
              ok: false,
              error: error && error.message ? error.message : String(error || "page auto translate failed")
            };
          }
        },
        args: [enabled === true]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "executeScript failed"));
          return;
        }

        resolve(Array.isArray(results) ? results : []);
      }
    );
  });
}

async function runGetPageAutoTranslateStatusAllFrames(tabId) {
  try {
    const frameResults = await executeGetPageAutoTranslateStatusInAllFrames(tabId);
    const merged = mergePageAutoFrameResults(frameResults);
    if (merged.frameCount > 0) {
      return { ok: true, ...merged };
    }
  } catch (error) {
    if (!isRecoverableTabMessageError(error)) {
      throw error;
    }
  }

  const response = await sendMessageToTab(tabId, { type: "GET_PAGE_AUTO_TRANSLATE_STATUS" });
  if (!response || !response.ok) {
    return { ok: false, error: response && response.error ? response.error : "page auto status failed" };
  }

  return {
    ok: true,
    frameCount: 1,
    enabled: response.enabled === true,
    queuedCount: Number(response.queuedCount || 0),
    runningCount: Number(response.runningCount || 0)
  };
}

function executeGetPageAutoTranslateStatusInAllFrames(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        func: () => {
          const api = globalThis.__MANGA_TRANSLATOR_V3__;
          if (!api || typeof api.getPageAutoTranslateStatus !== "function" || api.invalidated) {
            return { ok: false, skipped: true, reason: "content-not-ready" };
          }

          try {
            return { ok: true, result: api.getPageAutoTranslateStatus() };
          } catch (error) {
            return {
              ok: false,
              error: error && error.message ? error.message : String(error || "page auto status failed")
            };
          }
        }
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "executeScript failed"));
          return;
        }

        resolve(Array.isArray(results) ? results : []);
      }
    );
  });
}

function mergePageAutoFrameResults(frameResults) {
  let frameCount = 0;
  let skippedCount = 0;
  let enabled = false;
  let visibleCount = 0;
  let successCount = 0;
  let failCount = 0;
  let queuedCount = 0;
  let runningCount = 0;
  const errors = [];

  for (const item of Array.isArray(frameResults) ? frameResults : []) {
    const payload = item && item.result ? item.result : null;
    if (!payload) {
      continue;
    }
    if (payload.skipped) {
      skippedCount += 1;
      continue;
    }

    frameCount += 1;
    if (!payload.ok) {
      if (payload.error) {
        errors.push(payload.error);
      }
      continue;
    }

    const result = payload.result && typeof payload.result === "object" ? payload.result : {};
    enabled = enabled || result.enabled === true;
    visibleCount += Number(result.visibleCount || 0);
    successCount += Number(result.successCount || 0);
    failCount += Number(result.failCount || 0);
    queuedCount += Number(result.queuedCount || 0);
    runningCount += Number(result.runningCount || 0);

    if (Array.isArray(result.errors)) {
      errors.push(...result.errors.filter(Boolean));
    }
  }

  return {
    frameCount,
    skippedCount,
    enabled,
    visibleCount,
    successCount,
    failCount,
    queuedCount,
    runningCount,
    errors: [...new Set(errors)].slice(0, 3)
  };
}

function hasUsablePageAutoFrameResult(merged) {
  if (!merged || merged.frameCount <= 0) {
    return false;
  }
  if (
    Number(merged.visibleCount || 0) > 0 ||
    Number(merged.successCount || 0) > 0 ||
    Number(merged.failCount || 0) > 0 ||
    Number(merged.queuedCount || 0) > 0 ||
    Number(merged.runningCount || 0) > 0
  ) {
    return true;
  }
  return Number(merged.skippedCount || 0) === 0;
}

async function runManualTranslateAllFrames(tabId) {
  try {
    const frameResults = await executeManualTranslateInAllFrames(tabId);
    const merged = mergeManualFrameResults(frameResults);
    if (hasUsableManualFrameResult(merged)) {
      return { ok: true, ...merged };
    }
  } catch (error) {
    if (!isRecoverableTabMessageError(error)) {
      throw error;
    }
  }

  let response;
  try {
    response = await sendMessageToTab(tabId, { type: "MANUAL_TRANSLATE_VISIBLE" });
  } catch (error) {
    if (!isRecoverableTabMessageError(error)) {
      throw error;
    }

    await ensureContentInjected(tabId);
    response = await sendMessageToTab(tabId, { type: "MANUAL_TRANSLATE_VISIBLE" });
  }

  if (!response || !response.ok) {
    return { ok: false, error: response && response.error ? response.error : "manual translate failed" };
  }

  return {
    ok: true,
    frameCount: 1,
    visibleCount: Number(response.visibleCount || 0),
    successCount: Number(response.successCount || 0),
    failCount: Number(response.failCount || 0),
    errors: Array.isArray(response.errors) ? response.errors.filter(Boolean) : []
  };
}

function executeManualTranslateInAllFrames(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        func: async () => {
          const api = globalThis.__MANGA_TRANSLATOR_V3__;
          if (!api || typeof api.manualTranslateVisible !== "function" || api.invalidated) {
            return { ok: false, skipped: true, reason: "content-not-ready" };
          }

          try {
            const result = await api.manualTranslateVisible();
            return { ok: true, result };
          } catch (error) {
            return {
              ok: false,
              error: error && error.message ? error.message : String(error || "manual translate failed")
            };
          }
        }
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "executeScript failed"));
          return;
        }

        resolve(Array.isArray(results) ? results : []);
      }
    );
  });
}

function mergeManualFrameResults(frameResults) {
  let frameCount = 0;
  let skippedCount = 0;
  let visibleCount = 0;
  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const item of Array.isArray(frameResults) ? frameResults : []) {
    const payload = item && item.result ? item.result : null;
    if (!payload) {
      continue;
    }
    if (payload.skipped) {
      skippedCount += 1;
      continue;
    }

    frameCount += 1;
    if (!payload.ok) {
      if (payload.error) {
        errors.push(payload.error);
      }
      continue;
    }

    const result = payload.result && typeof payload.result === "object" ? payload.result : {};
    visibleCount += Number(result.visibleCount || 0);
    successCount += Number(result.successCount || 0);
    failCount += Number(result.failCount || 0);

    if (Array.isArray(result.errors)) {
      errors.push(...result.errors.filter(Boolean));
    }
  }

  return {
    frameCount,
    skippedCount,
    visibleCount,
    successCount,
    failCount,
    errors: [...new Set(errors)].slice(0, 3)
  };
}

function hasUsableManualFrameResult(merged) {
  if (!merged || merged.frameCount <= 0) {
    return false;
  }
  if (
    Number(merged.visibleCount || 0) > 0 ||
    Number(merged.successCount || 0) > 0 ||
    Number(merged.failCount || 0) > 0
  ) {
    return true;
  }
  return Number(merged.skippedCount || 0) === 0;
}

async function ensureContentInjected(tabId) {
  await insertCss(tabId, "styles.css");
  await executeScriptFiles(tabId, CONTENT_SCRIPT_FILES);
}

async function updateTermDiscoveryEnabled() {
  termDiscoverySwitch.disabled = true;
  try {
    const response = await sendRuntimeMessage({
      type: "SET_TERM_DISCOVERY_ENABLED",
      enabled: termDiscoverySwitch.checked,
      probe: termDiscoverySwitch.checked
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error || "更新术语发现开关失败");
    }
    renderTermDiscoveryStatus(response);
  } catch (error) {
    termDiscoverySwitch.checked = !termDiscoverySwitch.checked;
    setStatus(`术语发现设置失败：${getErrorMessage(error)}`, true);
  } finally {
    termDiscoverySwitch.disabled = false;
  }
}

async function refreshTermDiscoveryStatus(probe = false) {
  try {
    const response = await sendRuntimeMessage({ type: "GET_TERM_DISCOVERY_STATUS", probe });
    if (!response || !response.ok) {
      throw new Error(response && response.error || "读取术语发现状态失败");
    }
    renderTermDiscoveryStatus(response);
  } catch (error) {
    termDiscoveryStatus.textContent = `术语发现：状态读取失败（${getErrorMessage(error)}）`;
  }
}

function renderTermDiscoveryStatus(response) {
  const enabled = response && response.enabled !== false;
  const pendingCount = Math.max(0, Number(response && response.pendingCount) || 0);
  const stateValue = String(response && response.status && response.status.state || "unknown");
  termDiscoverySwitch.checked = enabled;
  glossaryBtn.textContent = pendingCount > 0
    ? `管理全局术语库（${pendingCount} 条待确认）`
    : "管理全局术语库";
  if (!enabled || stateValue === "disabled") {
    termDiscoveryStatus.textContent = `术语发现：已关闭，${pendingCount} 条待确认`;
  } else if (stateValue === "online") {
    termDiscoveryStatus.textContent = `术语发现：Kiwi 在线，${pendingCount} 条待确认`;
  } else if (stateValue === "offline") {
    termDiscoveryStatus.textContent = `术语发现：提取器离线，${pendingCount} 条待确认`;
  } else {
    termDiscoveryStatus.textContent = `术语发现：等待本地服务，${pendingCount} 条待确认`;
  }
}

// ── OCR Service Status ───────────────────────────────────────────

async function refreshOcrServiceStatus() {
  const provider = normalizeProvider(providerSelect.value);
  if (provider !== "local_paddle_deepseek") {
    ocrServiceStatus.style.display = "none";
    return;
  }
  ocrServiceStatus.style.display = "block";
  try {
    const response = await sendRuntimeMessage({ type: "PING_LOCAL_OCR" });
    const isRunning = response && response.ok === true;
    ocrServiceStatus.textContent = isRunning
      ? "✅ OCR 服务：运行中"
      : "⏳ OCR 服务：离线，请运行 start_local_ocr_gpu.bat";
  } catch {
    ocrServiceStatus.textContent = "⏳ OCR 服务：离线，请运行 start_local_ocr_gpu.bat";
  }
}

async function refreshCacheStats() {
  try {
    const response = await sendRuntimeMessage({ type: "GET_CACHE_STATS" });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "读取失败");
    }

    const stats = response.stats || {};
    cacheStats.textContent =
      `缓存状态：有效 ${stats.aliveCount || 0} 条，过期 ${stats.staleCount || 0} 条，` +
      `总计 ${stats.totalCount || 0} 条，约 ${stats.approxKB || 0} KB`;
  } catch (error) {
    cacheStats.textContent = `缓存状态：读取失败（${getErrorMessage(error)}）`;
  }
}

async function refreshTabStatus(tabId) {
  try {
    let id = tabId;
    if (!id) {
      const tab = await getActiveTab();
      id = tab && tab.id ? tab.id : null;
    }

    if (!id) {
      tabStatus.textContent = "页面状态：未找到活动标签页";
      return;
    }

    const response = await sendRuntimeMessage({
      type: "GET_TAB_STATUS",
      tabId: id
    });

    if (!response || !response.ok || !response.status) {
      tabStatus.textContent = "页面状态：暂无记录";
      return;
    }

    const status = response.status;
    const dt = new Date(Number(status.timestamp || Date.now()));
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const ss = String(dt.getSeconds()).padStart(2, "0");

    const level = String(status.level || "info").toLowerCase() === "error" ? "错误" : "信息";
    const message = String(status.message || "-");
    const details = status.details && typeof status.details === "object" ? status.details : {};
    const summaryParts = [];
    if (Number.isFinite(Number(details.successCount)) && Number.isFinite(Number(details.visibleCount))) {
      summaryParts.push(`${details.successCount}/${details.visibleCount}`);
    }
    if (details.firstError) {
      summaryParts.push(`首错: ${details.firstError}`);
    }
    const summary = summaryParts.length > 0 ? ` (${summaryParts.join("，")})` : "";
    tabStatus.textContent = `页面状态：${level} ${hh}:${mm}:${ss} - ${message}${summary}`;
  } catch (error) {
    tabStatus.textContent = `页面状态：读取失败（${getErrorMessage(error)}）`;
  }
}

function applyProviderUi(provider) {
  const meta = providerMeta[provider] || providerMeta.baidu_deepseek;
  apiKeyLabel.textContent = meta.apiKeyLabel;
  apiKeyInput.placeholder = meta.apiKeyPlaceholder;
  baseUrlField.classList.remove("hidden");
  baiduFields.classList.toggle("hidden", provider !== "baidu_deepseek");
  localOcrFields.classList.toggle("hidden", provider !== "local_paddle_deepseek");
  if (glossaryStorageRow) {
    glossaryStorageRow.style.display = provider === "local_paddle_deepseek" ? "flex" : "none";
  }

  baseUrlInput.placeholder = "https://api.deepseek.com or any OpenAI-compatible base URL";
}

function normalizeProvider(provider) {
  const safe = String(provider || "").trim().toLowerCase();
  if (
    safe === "baidu_deepseek" ||
    safe === "local_paddle_deepseek"
  ) {
    return safe;
  }

  return DEFAULTS.provider;
}

function normalizeLocalOcrLang(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "japan" || safe === "korean") {
    return safe;
  }
  return DEFAULTS.localOcrLang;
}

function normalizeLocalOcrMode(value) {
  const safe = String(value || "").trim().toLowerCase();
  return safe === "fast" ? "fast" : DEFAULTS.localOcrMode;
}

function normalizeLocalOcrNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRenderMode(value) {
  const safe = String(value || "").trim().toLowerCase();
  return safe === "embedded" ? "embedded" : "overlay";
}

function normalizePretranslateMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "ahead" || mode === "continuous") {
    return mode;
  }
  return "manual";
}

function normalizeCaptureMode(value) {
  const safe = String(value || "").trim().toLowerCase();
  return safe === "screenshot" ? "screenshot" : DEFAULTS.captureMode;
}

function sanitizeBaseUrl(value) {
  let normalized = String(value || "").trim().replace(/\/+$/, "");
  normalized = normalized.replace(/\/chat\/completions$/i, "");
  normalized = normalized.replace(/\/responses$/i, "");
  return normalized;
}

function sanitizeLocalOcrBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  return /^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`;
}

function setStatus(message, isError) {
  statusText.textContent = String(message || "");
  statusText.style.color = isError ? "#b91c1c" : "#065f46";
}

function isRecoverableTabMessageError(error) {
  const text = getErrorMessage(error).toLowerCase();
  return (
    text.includes("receiving end does not exist") ||
    text.includes("could not establish connection") ||
    text.includes("message port closed") ||
    text.includes("extension context invalidated") ||
    text.includes("cannot access contents of")
  );
}

function getErrorMessage(error) {
  if (!error) {
    return "未知错误";
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }

  return String(error);
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response || null);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response || null);
    });
  });
}

function executeScriptFiles(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files: [...files]
      },
      () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "executeScript failed";
          if (isSafeInjectError(message)) {
            resolve();
            return;
          }

          reject(new Error(message));
          return;
        }

        resolve();
      }
    );
  });
}

function insertCss(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.insertCSS(
      {
        target: { tabId, allFrames: true },
        files: [file]
      },
      () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "insertCSS failed";
          if (isSafeInjectError(message)) {
            resolve();
            return;
          }

          reject(new Error(message));
          return;
        }

        resolve();
      }
    );
  });
}

function isSafeInjectError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("cannot access contents of") || text.includes("the extensions gallery cannot be scripted");
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result || {});
      }
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}
