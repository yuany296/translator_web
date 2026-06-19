import type {
  ApiResponse,
  ExtensionSettings,
  ImageCandidate,
  MangaImagePayload,
  OCRTranslateResult
} from "../types";

export type PopupToContentMessage =
  | { type: "SCAN_PAGE" }
  | { type: "TRANSLATE_PAGE" }
  | { type: "TOGGLE_OVERLAY"; visible: boolean }
  | { type: "PAUSE_TRANSLATION"; paused: boolean };

export type ContentToBackgroundMessage =
  | { type: "OCR_AND_TRANSLATE_IMAGE"; payload: MangaImagePayload }
  | { type: "FETCH_IMAGE_DATA_URL"; url: string };

export type PopupToBackgroundMessage =
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings }
  | { type: "CLEAR_CACHE" }
  | { type: "GET_CACHE_STATS" }
  | { type: "PING_BACKGROUND" };

export type RuntimeMessage = PopupToContentMessage | ContentToBackgroundMessage | PopupToBackgroundMessage;

export interface ScanPageResult {
  candidates: ImageCandidate[];
}

export interface TranslatePageResult {
  candidates: ImageCandidate[];
  translated: OCRTranslateResult[];
  errors: string[];
}

export function responseOk<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function responseError(error: unknown): ApiResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error || "Unknown error")
  };
}

export function sendRuntimeMessage<T>(message: RuntimeMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}
