import type { ApiResponse, ExtensionSettings } from "../core/types";
import { sendRuntimeMessage, type PopupToContentMessage } from "../core/messaging/messages";

export async function getSettings(): Promise<ExtensionSettings> {
  const response = await sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  if (!response.ok || !response.data) {
    throw new Error(response.error || "读取设置失败");
  }
  return response.data;
}

export async function persistSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const response = await sendRuntimeMessage<ExtensionSettings>({ type: "SAVE_SETTINGS", settings });
  if (!response.ok || !response.data) {
    throw new Error(response.error || "保存设置失败");
  }
  return response.data;
}

export async function sendToActiveTab<T>(message: PopupToContentMessage): Promise<ApiResponse<T>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("当前标签页不可用");
  }
  return chrome.tabs.sendMessage(tab.id, message) as Promise<ApiResponse<T>>;
}
