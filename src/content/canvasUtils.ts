import type { MangaImagePayload } from "../core/types";
import { sendRuntimeMessage } from "../core/messaging/messages";
import type { ScannedTarget } from "./imageScanner";

const IMAGE_JPEG_QUALITY = 0.86;

export async function extractImagePayload(target: ScannedTarget): Promise<MangaImagePayload> {
  const { element, candidate } = target;
  let dataUrl = "";
  let width = candidate.naturalWidth;
  let height = candidate.naturalHeight;

  if (element instanceof HTMLImageElement) {
    if (!element.complete) {
      throw new Error("图片尚未加载完成");
    }
    if (candidate.sourceUrl.startsWith("data:")) {
      dataUrl = candidate.sourceUrl;
    } else if (/^https?:\/\//i.test(candidate.sourceUrl)) {
      const response = await sendRuntimeMessage<{ dataUrl: string }>({
        type: "FETCH_IMAGE_DATA_URL",
        url: candidate.sourceUrl
      });
      if (!response.ok || !response.data?.dataUrl) {
        throw new Error(response.error || "后台抓取图片失败");
      }
      dataUrl = response.data.dataUrl;
    } else {
      dataUrl = imageToDataUrl(element);
    }
    width = element.naturalWidth || width;
    height = element.naturalHeight || height;
  } else if (element instanceof HTMLCanvasElement) {
    dataUrl = element.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
    width = element.width || width;
    height = element.height || height;
  } else {
    dataUrl = await backgroundElementToDataUrl(element, candidate.sourceUrl);
  }

  return {
    dataUrl,
    sourceUrl: candidate.sourceUrl,
    width,
    height,
    targetKey: candidate.targetKey,
    candidate
  };
}

function imageToDataUrl(image: HTMLImageElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context 不可用");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
}

async function backgroundElementToDataUrl(element: HTMLElement, sourceUrl: string): Promise<string> {
  if (!sourceUrl) {
    throw new Error("背景图地址不可用");
  }
  if (/^https?:\/\//i.test(sourceUrl)) {
    const response = await sendRuntimeMessage<{ dataUrl: string }>({ type: "FETCH_IMAGE_DATA_URL", url: sourceUrl });
    if (!response.ok || !response.data?.dataUrl) {
      throw new Error(response.error || "后台抓取背景图失败");
    }
    return response.data.dataUrl;
  }

  const rect = element.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context 不可用");
  }
  const image = await loadImage(sourceUrl);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
}

function loadImage(sourceUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = sourceUrl;
  });
}
