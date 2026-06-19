import type { OCRProvider } from "./OCRProvider";
import { normalizeOcrText } from "./OCRProvider";
import type { BoundingBox, OCRImageData, OCRRecognizeOptions, OCRResult } from "../types";

const BAIDU_OCR_ENDPOINT = "https://aip.baidubce.com/rest/2.0/ocr/v1/general";

export interface BaiduTokenProvider {
  getAccessToken(apiKey: string, secretKey: string): Promise<string>;
}

interface BaiduWordItem {
  words?: string;
  location?: {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
  };
  probability?: {
    average?: number;
  };
}

export class BaiduOCRProvider implements OCRProvider {
  name = "Baidu OCR";
  type = "baidu";

  constructor(private readonly tokenProvider: BaiduTokenProvider) {}

  async recognize(imageData: OCRImageData, options?: OCRRecognizeOptions): Promise<OCRResult[]> {
    if (!options?.baiduApiKey || !options.baiduSecretKey) {
      throw new Error("百度 OCR API Key / Secret Key 未配置");
    }

    const token = await this.tokenProvider.getAccessToken(options.baiduApiKey, options.baiduSecretKey);
    const body = new URLSearchParams();
    body.set("image", stripDataUrlPrefix(imageData.dataUrl));
    body.set("detect_direction", "true");
    body.set("paragraph", "true");
    body.set("probability", "true");

    const response = await fetch(`${BAIDU_OCR_ENDPOINT}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const payload = await response.json();
    if (!response.ok || payload.error_code) {
      throw new Error(`百度 OCR 请求失败：${payload.error_msg || response.statusText}`);
    }

    const words = Array.isArray(payload.words_result) ? (payload.words_result as BaiduWordItem[]) : [];
    return words
      .map((item, index) => toOCRResult(item, index))
      .filter((item): item is OCRResult => Boolean(item));
  }
}

function toOCRResult(item: BaiduWordItem, index: number): OCRResult | null {
  const text = normalizeOcrText(item.words);
  const box = item.location ? normalizeBox(item.location) : null;
  if (!text || !box) {
    return null;
  }
  return {
    text,
    boundingBox: box,
    confidence: Number(item.probability?.average || 0),
    lineId: `baidu-line-${index}`,
    raw: item
  };
}

function normalizeBox(location: NonNullable<BaiduWordItem["location"]>): BoundingBox | null {
  const x = Number(location.left);
  const y = Number(location.top);
  const width = Number(location.width);
  const height = Number(location.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function stripDataUrlPrefix(dataUrl: string): string {
  const marker = "base64,";
  const index = dataUrl.indexOf(marker);
  return index >= 0 ? dataUrl.slice(index + marker.length) : dataUrl;
}
