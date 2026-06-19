import type { ExtensionSettings, OCRTranslateResult } from "../core/types";
import { fitTextToBox } from "../core/layout/textFit";
import type { ScannedTarget } from "./imageScanner";

export async function renderEmbeddedResult(
  target: ScannedTarget,
  result: OCRTranslateResult,
  settings: ExtensionSettings
): Promise<void> {
  if (target.element instanceof HTMLImageElement) {
    await renderImage(target.element, result, settings);
    return;
  }
  if (target.element instanceof HTMLCanvasElement) {
    await renderCanvas(target.element, result, settings);
    return;
  }
  throw new Error("当前目标暂不支持嵌入式改图，已回退覆盖层");
}

export function restoreEmbeddedImages(): void {
  document.querySelectorAll<HTMLImageElement>("img[data-mit-original-src]").forEach((image) => {
    image.src = image.dataset.mitOriginalSrc || image.src;
    delete image.dataset.mitOriginalSrc;
  });
}

async function renderImage(image: HTMLImageElement, result: OCRTranslateResult, settings: ExtensionSettings): Promise<void> {
  if (!image.dataset.mitOriginalSrc) {
    image.dataset.mitOriginalSrc = image.currentSrc || image.src;
  }
  const output = await composeImage(result, settings);
  image.removeAttribute("srcset");
  image.src = output;
}

async function renderCanvas(canvas: HTMLCanvasElement, result: OCRTranslateResult, settings: ExtensionSettings): Promise<void> {
  const image = await loadImage(result.image.dataUrl);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context 不可用");
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawTranslations(context, canvas.width, canvas.height, result, settings);
}

async function composeImage(result: OCRTranslateResult, settings: ExtensionSettings): Promise<string> {
  const image = await loadImage(result.image.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || result.image.width;
  canvas.height = image.naturalHeight || result.image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context 不可用");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawTranslations(context, canvas.width, canvas.height, result, settings);
  return canvas.toDataURL("image/jpeg", 0.9);
}

function drawTranslations(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  result: OCRTranslateResult,
  settings: ExtensionSettings
): void {
  const scaleX = canvasWidth / Math.max(1, result.image.width);
  const scaleY = canvasHeight / Math.max(1, result.image.height);
  for (const unit of result.translations) {
    const x = unit.boundingBox.x * scaleX;
    const y = unit.boundingBox.y * scaleY;
    const width = unit.boundingBox.width * scaleX;
    const height = unit.boundingBox.height * scaleY;
    context.save();
    context.fillStyle = "rgba(255,255,255,0.86)";
    context.fillRect(x, y, width, height);
    const fit = fitTextToBox(unit.translatedText, {
      minFontSize: 8,
      maxFontSize: Math.max(10, settings.font.fontSize * 1.4),
      width,
      height
    });
    context.font = `600 ${fit.fontSize}px sans-serif`;
    context.fillStyle = settings.font.fontColor;
    context.textAlign = "center";
    context.textBaseline = "middle";
    fit.lines.forEach((line, index) => {
      const offset = (index - (fit.lines.length - 1) / 2) * fit.fontSize * 1.25;
      context.fillText(line, x + width / 2, y + height / 2 + offset, width * 0.92);
    });
    context.restore();
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = dataUrl;
  });
}
