import type { OCRProvider } from "./OCRProvider";
import { normalizeOcrText } from "./OCRProvider";
import type { BoundingBox, OCRImageData, OCRRecognizeOptions, OCRResult } from "../types";

export class CustomOCRProvider implements OCRProvider {
  name = "Custom OCR HTTP";
  type = "custom";

  async recognize(imageData: OCRImageData, options?: OCRRecognizeOptions): Promise<OCRResult[]> {
    if (!options?.customOcrUrl) {
      throw new Error("自定义 OCR 接口地址未配置");
    }
    const headers = parseHeaders(options.customOcrHeaders);
    const body = renderTemplate(options.customOcrBodyTemplate || "{\"image\":\"{{image}}\"}", {
      image: imageData.dataUrl,
      sourceUrl: imageData.sourceUrl,
      width: String(imageData.width),
      height: String(imageData.height)
    });
    const response = await fetch(options.customOcrUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`自定义 OCR 请求失败：${payload.error || response.statusText}`);
    }
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.results)
        ? payload.results
        : Array.isArray(payload.ocr)
          ? payload.ocr
          : [];
    return items
      .map((item: unknown, index: number) => normalizeCustomItem(item, index))
      .filter((item: OCRResult | null): item is OCRResult => Boolean(item));
  }
}

function normalizeCustomItem(value: unknown, index: number): OCRResult | null {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const box = normalizeBox((item.boundingBox || item.box || item.location || item.bbox) as Record<string, unknown>);
  const text = normalizeOcrText(item.text || item.words);
  if (!text || !box) {
    return null;
  }
  return {
    text,
    boundingBox: box,
    confidence: Number(item.confidence || item.score || 0),
    lineId: `custom-line-${index}`,
    raw: value
  };
}

function normalizeBox(value: Record<string, unknown> | undefined): BoundingBox | null {
  if (!value) {
    return null;
  }
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function parseHeaders(value?: string): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]));
  } catch {
    return {};
  }
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, escapeJsonString(value)),
    template
  );
}

function escapeJsonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
