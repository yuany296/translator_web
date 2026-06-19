import type { ExtensionSettings, OCRImageData, OCRRecognizeOptions, OCRResult } from "../core/types";
import { BaiduOCRProvider } from "../core/ocr/baiduProvider";
import { CustomOCRProvider } from "../core/ocr/customProvider";
import { LocalOCRProvider } from "../core/ocr/localProvider";
import { baiduTokenProvider } from "./baiduOcr";

const providers = {
  baidu: new BaiduOCRProvider(baiduTokenProvider),
  local: new LocalOCRProvider(),
  custom: new CustomOCRProvider()
};

export async function recognizeBySettings(imageData: OCRImageData, settings: ExtensionSettings): Promise<OCRResult[]> {
  const provider = providers[settings.ocrProvider];
  if (!provider) {
    throw new Error(`不支持的 OCR Provider：${settings.ocrProvider}`);
  }
  const options: OCRRecognizeOptions = {
    sourceLanguage: settings.sourceLanguage,
    baiduApiKey: settings.baiduApiKey,
    baiduSecretKey: settings.baiduSecretKey,
    localOcrBaseUrl: settings.localOcrBaseUrl,
    localOcrLanguage: settings.localOcrLanguage,
    customOcrUrl: settings.customOcrUrl,
    customOcrHeaders: settings.customOcrHeaders,
    customOcrBodyTemplate: settings.customOcrBodyTemplate
  };
  return provider.recognize(imageData, options);
}
