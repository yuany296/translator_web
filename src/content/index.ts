import { loadSettings, saveSettings } from "../core/settings/settingsManager";
import type { ApiResponse, OCRTranslateResult } from "../core/types";
import { responseError, responseOk, sendRuntimeMessage, type PopupToContentMessage } from "../core/messaging/messages";
import { extractImagePayload } from "./canvasUtils";
import { renderEmbeddedResult, restoreEmbeddedImages } from "./embeddedRenderer";
import { scanMangaImages, type ScannedTarget } from "./imageScanner";
import { startMangaMutationObserver } from "./mutationObserver";
import { clearDebugBoxes, renderDebugBoxes, renderOverlayResult, setOverlayVisible } from "./overlayRenderer";

const state = {
  targets: [] as ScannedTarget[],
  overlayVisible: true,
  observerStop: null as null | (() => void)
};

void init();

async function init(): Promise<void> {
  state.targets = scanMangaImages();
  state.observerStop = startMangaMutationObserver(() => {
    void refreshDebugBoxes();
  });
  await refreshDebugBoxes();
}

chrome.runtime.onMessage.addListener((message: PopupToContentMessage, _sender, sendResponse) => {
  handleContentMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse(responseError(error)));
  return true;
});

async function handleContentMessage(message: PopupToContentMessage): Promise<ApiResponse> {
  switch (message.type) {
    case "SCAN_PAGE":
      return responseOk(await scanPage());
    case "TRANSLATE_PAGE":
      return responseOk(await translatePage());
    case "TOGGLE_OVERLAY":
      state.overlayVisible = message.visible;
      setOverlayVisible(message.visible);
      return responseOk({ visible: message.visible });
    case "PAUSE_TRANSLATION": {
      const settings = await loadSettings();
      await saveSettings({ ...settings, paused: message.paused });
      return responseOk({ paused: message.paused });
    }
    default:
      return responseError(`未知 content 消息：${(message as { type?: string }).type || ""}`);
  }
}

async function scanPage(): Promise<{ candidates: ScannedTarget["candidate"][] }> {
  state.targets = scanMangaImages();
  await refreshDebugBoxes();
  return { candidates: state.targets.map((target) => target.candidate) };
}

async function translatePage(): Promise<{
  candidates: ScannedTarget["candidate"][];
  translated: OCRTranslateResult[];
  errors: string[];
}> {
  const settings = await loadSettings();
  const scanResult = await scanPage();
  const translated: OCRTranslateResult[] = [];
  const errors: string[] = [];
  const visibleTargets = state.targets.filter((target) => target.candidate.visible).slice(0, 8);

  if (settings.renderMode === "overlay") {
    restoreEmbeddedImages();
  }

  for (const target of visibleTargets) {
    try {
      const payload = await extractImagePayload(target);
      const response = await sendRuntimeMessage<OCRTranslateResult>({
        type: "OCR_AND_TRANSLATE_IMAGE",
        payload
      });
      if (!response.ok || !response.data) {
        throw new Error(response.error || "OCR/翻译失败");
      }
      translated.push(response.data);
      if (settings.renderMode === "embedded") {
        try {
          await renderEmbeddedResult(target, response.data, settings);
        } catch {
          renderOverlayResult(target.candidate, response.data, settings);
        }
      } else {
        renderOverlayResult(target.candidate, response.data, settings);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error || "未知错误"));
    }
  }

  return {
    candidates: scanResult.candidates,
    translated,
    errors
  };
}

async function refreshDebugBoxes(): Promise<void> {
  const settings = await loadSettings();
  state.targets = scanMangaImages();
  if (settings.debugMode) {
    renderDebugBoxes(state.targets.map((target) => target.candidate));
  } else {
    clearDebugBoxes();
  }
}
