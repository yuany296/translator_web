import type { OCRImageData, OCRRecognizeOptions, OCRProviderType, OCRResult } from "../types";

export interface OCRProvider {
  name: string;
  type: OCRProviderType;
  recognize(imageData: OCRImageData, options?: OCRRecognizeOptions): Promise<OCRResult[]>;
}

export function normalizeOcrText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
