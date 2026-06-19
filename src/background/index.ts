import {
  buildTranslationCacheKey,
  clearTranslationCache,
  getCachedTranslation,
  getCacheStats,
  setCachedTranslation
} from "../core/cache/cacheManager";
import { mergeOcrBlocks } from "../core/layout/mergeOcrBlocks";
import type { ApiResponse, MangaImagePayload, OCRImageData, OCRTranslateResult } from "../core/types";
import { ensureDefaultSettings, loadSettings, saveSettings } from "../core/settings/settingsManager";
import { responseError, responseOk, type RuntimeMessage } from "../core/messaging/messages";
import { recognizeBySettings } from "./ocrRouter";
import { translateBlocksBySettings } from "./translatorRouter";

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultSettings();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse(responseError(error)));
  return true;
});

async function handleMessage(message: RuntimeMessage): Promise<ApiResponse> {
  switch (message.type) {
    case "PING_BACKGROUND":
      return responseOk({ ready: true });
    case "GET_SETTINGS":
      return responseOk(await loadSettings());
    case "SAVE_SETTINGS":
      return responseOk(await saveSettings(message.settings));
    case "CLEAR_CACHE":
      return responseOk(await clearTranslationCache());
    case "GET_CACHE_STATS":
      return responseOk(await getCacheStats());
    case "FETCH_IMAGE_DATA_URL":
      return responseOk(await fetchImageAsDataUrl(message.url));
    case "OCR_AND_TRANSLATE_IMAGE":
      return responseOk(await ocrAndTranslateImage(message.payload));
    default:
      return responseError(`未知消息：${(message as { type?: string }).type || ""}`);
  }
}

async function ocrAndTranslateImage(payload: MangaImagePayload): Promise<OCRTranslateResult> {
  const settings = await loadSettings();
  if (settings.paused || !settings.enabled) {
    throw new Error("翻译已暂停或未启用");
  }

  const image: OCRImageData = {
    dataUrl: payload.dataUrl,
    sourceUrl: payload.sourceUrl,
    width: payload.width,
    height: payload.height,
    targetKey: payload.targetKey
  };
  const cacheKey = buildTranslationCacheKey({
    sourceUrl: image.sourceUrl || image.targetKey,
    width: image.width,
    height: image.height,
    ocrProvider: settings.ocrProvider,
    translatorProvider: settings.translatorProvider,
    targetLanguage: settings.targetLanguage,
    model: settings.openaiModel
  });
  const cached = await getCachedTranslation(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const ocrResults = await recognizeBySettings(image, settings);
  const blocks = mergeOcrBlocks(ocrResults);
  const translations = await translateBlocksBySettings(blocks, settings, { width: image.width, height: image.height });
  const result: OCRTranslateResult = {
    image,
    ocrResults,
    blocks,
    translations,
    cached: false
  };
  await setCachedTranslation(cacheKey, result);
  return result;
}

async function fetchImageAsDataUrl(url: string): Promise<{ dataUrl: string; sourceUrl: string }> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`图片读取失败：${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, sourceUrl: url };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Blob 转换失败"));
    reader.readAsDataURL(blob);
  });
}
