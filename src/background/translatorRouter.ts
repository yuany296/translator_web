import type { BoundingBox, ExtensionSettings, MergedTextBlock, TranslationUnit, TranslateOptions } from "../core/types";
import { CustomHttpTranslatorProvider } from "../core/translate/customHttpProvider";
import { OpenAICompatibleProvider } from "../core/translate/openaiCompatibleProvider";

const providers = {
  "openai-compatible": new OpenAICompatibleProvider(),
  "custom-http": new CustomHttpTranslatorProvider()
};

export async function translateBlocksBySettings(
  blocks: MergedTextBlock[],
  settings: ExtensionSettings,
  imageSize?: { width: number; height: number }
): Promise<TranslationUnit[]> {
  const provider = providers[settings.translatorProvider];
  if (!provider) {
    throw new Error(`不支持的翻译 Provider：${settings.translatorProvider}`);
  }
  const options: TranslateOptions = {
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    apiKey: settings.openaiApiKey,
    baseUrl: settings.openaiBaseUrl,
    model: settings.openaiModel,
    customTranslateUrl: settings.customTranslateUrl,
    customTranslateHeaders: settings.customTranslateHeaders,
    customTranslateBodyTemplate: settings.customTranslateBodyTemplate
  };
  const translated = await provider.translateBatch(
    blocks.map((block) => block.sourceText),
    options
  );
  return buildTranslationUnits(blocks, translated, imageSize);
}

export function buildTranslationUnits(
  blocks: MergedTextBlock[],
  translated: string[],
  imageSize?: { width: number; height: number }
): TranslationUnit[] {
  const overlayBoxes = resolveOverlayBoxes(blocks, imageSize);
  return blocks.map((block, index) => ({
    blockId: block.id,
    sourceText: block.sourceText,
    translatedText: translated[index] || block.sourceText,
    sourceBoundingBox: block.boundingBox,
    boundingBox: overlayBoxes[index] || block.boundingBox
  }));
}

function resolveOverlayBoxes(blocks: MergedTextBlock[], imageSize?: { width: number; height: number }): BoundingBox[] {
  const imageWidth = Math.max(1, Number(imageSize?.width || 0));
  const imageHeight = Math.max(1, Number(imageSize?.height || 0));
  const hasImageBounds = Boolean(imageSize?.width && imageSize.height);
  const sourceBoxes = blocks.map((block) => block.boundingBox);
  const paddedBoxes = sourceBoxes.map((box) => expandBox(box, hasImageBounds ? { width: imageWidth, height: imageHeight } : undefined));

  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (let index = 0; index < paddedBoxes.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < paddedBoxes.length; nextIndex += 1) {
        if (overlapRatio(paddedBoxes[index], paddedBoxes[nextIndex]) <= 0.08) {
          continue;
        }
        paddedBoxes[index] = shrinkTowardSource(paddedBoxes[index], sourceBoxes[index], 0.72);
        paddedBoxes[nextIndex] = shrinkTowardSource(paddedBoxes[nextIndex], sourceBoxes[nextIndex], 0.72);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return paddedBoxes.map((box) => (hasImageBounds ? clampBox(box, imageWidth, imageHeight) : box));
}

function expandBox(box: BoundingBox, imageSize?: { width: number; height: number }): BoundingBox {
  const longSide = Math.max(box.width, box.height);
  const shortSide = Math.max(1, Math.min(box.width, box.height));
  const isLargeLettering = longSide / shortSide > 2.4 || box.width * box.height > shortSide * shortSide * 8;
  const padX = clampNumber(box.width * (isLargeLettering ? 0.18 : 0.12), 4, 36);
  const padY = clampNumber(box.height * (isLargeLettering ? 0.22 : 0.16), 4, 40);
  const expanded = {
    x: box.x - padX,
    y: box.y - padY,
    width: box.width + padX * 2,
    height: box.height + padY * 2
  };
  return imageSize ? clampBox(expanded, imageSize.width, imageSize.height) : expanded;
}

function shrinkTowardSource(box: BoundingBox, source: BoundingBox, ratio: number): BoundingBox {
  const nextX = source.x + (box.x - source.x) * ratio;
  const nextY = source.y + (box.y - source.y) * ratio;
  const nextRight = source.x + source.width + (box.x + box.width - source.x - source.width) * ratio;
  const nextBottom = source.y + source.height + (box.y + box.height - source.y - source.height) * ratio;
  return {
    x: nextX,
    y: nextY,
    width: Math.max(source.width, nextRight - nextX),
    height: Math.max(source.height, nextBottom - nextY)
  };
}

function overlapRatio(left: BoundingBox, right: BoundingBox): number {
  const x = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const y = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const overlap = x * y;
  if (overlap <= 0) {
    return 0;
  }
  return overlap / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
}

function clampBox(box: BoundingBox, imageWidth: number, imageHeight: number): BoundingBox {
  const x = clampNumber(box.x, 0, imageWidth);
  const y = clampNumber(box.y, 0, imageHeight);
  const right = clampNumber(box.x + box.width, x + 1, imageWidth);
  const bottom = clampNumber(box.y + box.height, y + 1, imageHeight);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
