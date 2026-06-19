import type { OCRProvider } from "./OCRProvider";
import { normalizeOcrText } from "./OCRProvider";
import type { BoundingBox, OCRImageData, OCRRecognizeOptions, OCRResult } from "../types";

interface LocalOcrItem {
  text?: string;
  words?: string;
  score?: number;
  confidence?: number;
  box?: Partial<Record<"left" | "top" | "width" | "height" | "x" | "y" | "w" | "h", number>>;
  location?: LocalOcrItem["box"];
  boundingBox?: LocalOcrItem["box"];
}

export class LocalOCRProvider implements OCRProvider {
  name = "Local OCR Service";
  type = "local";

  async recognize(imageData: OCRImageData, options?: OCRRecognizeOptions): Promise<OCRResult[]> {
    const baseUrl = sanitizeBaseUrl(options?.localOcrBaseUrl || "http://127.0.0.1:8765");
    const response = await fetch(`${baseUrl}/ocr`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        image: imageData.dataUrl,
        lang: options?.localOcrLanguage || options?.sourceLanguage || "auto"
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`本地 OCR 请求失败：${payload.detail || payload.error || response.statusText}`);
    }

    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.results)
        ? payload.results
        : [];

    return (items as LocalOcrItem[])
      .map((item, index) => toOCRResult(item, index))
      .filter((item): item is OCRResult => Boolean(item));
  }
}

function toOCRResult(item: LocalOcrItem, index: number): OCRResult | null {
  const text = normalizeOcrText(item.text || item.words);
  const box = normalizeBox(item.box || item.location || item.boundingBox);
  if (!text || !box) {
    return null;
  }
  return {
    text,
    boundingBox: box,
    confidence: Number(item.score || item.confidence || 0),
    lineId: `local-line-${index}`,
    raw: item
  };
}

function normalizeBox(value: LocalOcrItem["box"]): BoundingBox | null {
  if (!value) {
    return null;
  }
  const x = Number(value.left ?? value.x);
  const y = Number(value.top ?? value.y);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function sanitizeBaseUrl(value: string): string {
  return String(value || "").replace(/\/+$/, "");
}
