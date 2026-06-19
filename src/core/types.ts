export type OCRProviderType = "baidu" | "local" | "custom" | string;
export type TranslatorProviderType = "openai-compatible" | "custom-http" | string;
export type RenderMode = "overlay" | "embedded";
export type TextDisplayMode = "translation" | "source" | "bilingual";
export type SourceLanguage = "auto" | "ja" | "ko" | "zh" | "en";
export type TargetLanguage = "zh-CN" | "en" | "ja" | "ko";
export type ReadingDirection = "horizontal" | "vertical" | "mixed";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OCRImageData {
  dataUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  targetKey: string;
}

export interface OCRRecognizeOptions {
  sourceLanguage: SourceLanguage;
  baiduApiKey?: string;
  baiduSecretKey?: string;
  localOcrBaseUrl?: string;
  localOcrLanguage?: string;
  customOcrUrl?: string;
  customOcrHeaders?: string;
  customOcrBodyTemplate?: string;
}

export interface OCRResult {
  text: string;
  boundingBox: BoundingBox;
  confidence: number;
  lineId?: string;
  blockId?: string;
  raw?: unknown;
}

export interface MergedTextBlock {
  id: string;
  sourceText: string;
  boundingBox: BoundingBox;
  items: OCRResult[];
  direction: ReadingDirection;
}

export interface TranslateOptions {
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  customTranslateUrl?: string;
  customTranslateHeaders?: string;
  customTranslateBodyTemplate?: string;
}

export interface TranslationUnit {
  blockId: string;
  sourceText: string;
  translatedText: string;
  sourceBoundingBox: BoundingBox;
  boundingBox: BoundingBox;
}

export interface FontSettings {
  fontSize: number;
  fontColor: string;
  strokeColor: string;
  strokeWidth: number;
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface ExtensionSettings {
  enabled: boolean;
  paused: boolean;
  ocrProvider: "baidu" | "local" | "custom";
  translatorProvider: "openai-compatible" | "custom-http";
  baiduApiKey: string;
  baiduSecretKey: string;
  localOcrBaseUrl: string;
  localOcrLanguage: string;
  customOcrUrl: string;
  customOcrHeaders: string;
  customOcrBodyTemplate: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  customTranslateUrl: string;
  customTranslateHeaders: string;
  customTranslateBodyTemplate: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  renderMode: RenderMode;
  textDisplayMode: TextDisplayMode;
  font: FontSettings;
  debugMode: boolean;
}

export interface ImageCandidate {
  id: string;
  kind: "img" | "canvas" | "background";
  sourceUrl: string;
  targetKey: string;
  rect: BoundingBox;
  naturalWidth: number;
  naturalHeight: number;
  visible: boolean;
}

export interface MangaImagePayload extends OCRImageData {
  candidate: ImageCandidate;
}

export interface OCRTranslateResult {
  image: OCRImageData;
  ocrResults: OCRResult[];
  blocks: MergedTextBlock[];
  translations: TranslationUnit[];
  cached: boolean;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
