import type { ExtensionSettings } from "../types";

export const SETTINGS_STORAGE_KEY = "mangaTranslator.settings.v1";

export const defaultSettings: ExtensionSettings = {
  enabled: true,
  paused: false,
  ocrProvider: "baidu",
  translatorProvider: "openai-compatible",
  baiduApiKey: "",
  baiduSecretKey: "",
  localOcrBaseUrl: "http://127.0.0.1:8765",
  localOcrLanguage: "auto",
  customOcrUrl: "",
  customOcrHeaders: "{}",
  customOcrBodyTemplate: "{\"image\":\"{{image}}\"}",
  openaiBaseUrl: "https://api.deepseek.com",
  openaiApiKey: "",
  openaiModel: "deepseek-chat",
  customTranslateUrl: "",
  customTranslateHeaders: "{}",
  customTranslateBodyTemplate: "{\"texts\":{{textsJson}},\"targetLanguage\":\"{{targetLanguage}}\"}",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  renderMode: "overlay",
  textDisplayMode: "translation",
  font: {
    fontSize: 16,
    fontColor: "#111827",
    strokeColor: "#ffffff",
    strokeWidth: 2,
    backgroundColor: "#ffffff",
    backgroundOpacity: 0.78
  },
  debugMode: false
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(data[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}

export async function ensureDefaultSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  if (data[SETTINGS_STORAGE_KEY]) {
    return normalizeSettings(data[SETTINGS_STORAGE_KEY]);
  }
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: defaultSettings });
  return defaultSettings;
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  const raw = value && typeof value === "object" ? (value as Partial<ExtensionSettings>) : {};
  return {
    ...defaultSettings,
    ...raw,
    font: {
      ...defaultSettings.font,
      ...(raw.font || {})
    },
    ocrProvider: normalizeChoice(raw.ocrProvider, ["baidu", "local", "custom"], defaultSettings.ocrProvider),
    translatorProvider: normalizeChoice(
      raw.translatorProvider,
      ["openai-compatible", "custom-http"],
      defaultSettings.translatorProvider
    ),
    sourceLanguage: normalizeChoice(raw.sourceLanguage, ["auto", "ja", "ko", "zh", "en"], "auto"),
    targetLanguage: normalizeChoice(raw.targetLanguage, ["zh-CN", "en", "ja", "ko"], "zh-CN"),
    renderMode: normalizeChoice(raw.renderMode, ["overlay", "embedded"], "overlay"),
    textDisplayMode: normalizeChoice(raw.textDisplayMode, ["translation", "source", "bilingual"], "translation")
  };
}

function normalizeChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}
