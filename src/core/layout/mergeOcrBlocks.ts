import type { BoundingBox, MergedTextBlock, OCRResult, ReadingDirection } from "../types";
import { detectReadingDirection, sortByReadingOrder } from "./readingOrder";

export interface MergeOptions {
  maxBlocks?: number;
}

export function mergeOcrBlocks(items: OCRResult[], options: MergeOptions = {}): MergedTextBlock[] {
  const sorted = sortByReadingOrder(
    items.filter((item) => item.text.trim() && item.boundingBox.width > 0 && item.boundingBox.height > 0)
  );
  const groups: OCRResult[][] = sorted.map((item) => [item]);
  let changed = true;

  while (changed) {
    changed = false;
    for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
        if (!shouldMergeGroups(groups[leftIndex], groups[rightIndex])) {
          continue;
        }
        groups[leftIndex] = [...groups[leftIndex], ...groups[rightIndex]];
        groups.splice(rightIndex, 1);
        changed = true;
        rightIndex -= 1;
      }
    }
  }

  return groups
    .map((group, index) => buildBlock(group, index))
    .sort((left, right) => sortByReadingOrder([left, right])[0] === left ? -1 : 1)
    .slice(0, options.maxBlocks || 300);
}

function shouldMergeGroups(left: OCRResult[], right: OCRResult[]): boolean {
  return shouldMergeGroupsByBox(left, right);
}

function shouldMergeGroupsByBox(left: OCRResult[], right: OCRResult[]): boolean {
  const groupBox = unionBoxes(left.map((entry) => entry.boundingBox));
  const itemBox = unionBoxes(right.map((entry) => entry.boundingBox));
  const combined = [...left, ...right];
  const averageHeight =
    combined.reduce((sum, entry) => sum + entry.boundingBox.height, 0) / Math.max(1, combined.length);
  const averageWidth =
    combined.reduce((sum, entry) => sum + entry.boundingBox.width, 0) / Math.max(1, combined.length);
  const groupCenterX = groupBox.x + groupBox.width / 2;
  const itemCenterX = itemBox.x + itemBox.width / 2;
  const groupCenterY = groupBox.y + groupBox.height / 2;
  const itemCenterY = itemBox.y + itemBox.height / 2;
  const verticalGap = itemBox.y - (groupBox.y + groupBox.height);
  const reverseVerticalGap = groupBox.y - (itemBox.y + itemBox.height);
  const nearestVerticalGap = Math.max(0, verticalGap, reverseVerticalGap);
  const horizontalGap =
    itemBox.x > groupBox.x + groupBox.width
      ? itemBox.x - (groupBox.x + groupBox.width)
      : groupBox.x > itemBox.x + itemBox.width
        ? groupBox.x - (itemBox.x + itemBox.width)
        : 0;
  const overlapX =
    Math.min(groupBox.x + groupBox.width, itemBox.x + itemBox.width) - Math.max(groupBox.x, itemBox.x);
  const overlapY =
    Math.min(groupBox.y + groupBox.height, itemBox.y + itemBox.height) - Math.max(groupBox.y, itemBox.y);
  const xOverlapRatio = overlapX > 0 ? overlapX / Math.max(1, Math.min(groupBox.width, itemBox.width)) : 0;
  const yOverlapRatio = overlapY > 0 ? overlapY / Math.max(1, Math.min(groupBox.height, itemBox.height)) : 0;

  const sameLine = yOverlapRatio >= 0.36 && horizontalGap <= averageHeight * 2.8;
  const nextLine =
    nearestVerticalGap <= averageHeight * 1.65 &&
    (xOverlapRatio >= 0.16 ||
      Math.abs(itemBox.x - groupBox.x) <= averageHeight * 2.8 ||
      Math.abs(itemCenterX - groupCenterX) <= Math.max(averageWidth, averageHeight * 2.2));
  const stackedEffectText =
    nearestVerticalGap <= averageHeight * 2.25 &&
    horizontalGap <= averageHeight * 1.35 &&
    Math.abs(itemCenterX - groupCenterX) <= Math.max(groupBox.width, itemBox.width) * 0.72;
  const verticalText =
    combined.some((entry) => detectReadingDirection(entry) === "vertical") &&
    horizontalGap <= Math.max(averageHeight * 2.1, averageWidth * 1.2) &&
    (yOverlapRatio >= 0.18 || Math.abs(itemCenterY - groupCenterY) <= Math.max(groupBox.height, itemBox.height) * 0.8);
  const combinedBox = unionBoxes(combined.map((entry) => entry.boundingBox));
  const tooSparse =
    combinedBox.width > Math.max(groupBox.width, itemBox.width) + averageHeight * 8 &&
    combinedBox.height > Math.max(groupBox.height, itemBox.height) + averageHeight * 5;

  return !tooSparse && (sameLine || nextLine || stackedEffectText || verticalText);
}

function buildBlock(group: OCRResult[], index: number): MergedTextBlock {
  const sorted = sortByReadingOrder(group);
  const boundingBox = unionBoxes(sorted.map((item) => item.boundingBox));
  const direction = summarizeDirection(sorted);
  const separator = direction === "vertical" ? "" : "\n";
  const id = `block-${index}`;
  return {
    id,
    sourceText: sorted.map((item) => item.text).join(separator).trim(),
    boundingBox,
    items: sorted.map((item) => ({ ...item, blockId: id })),
    direction
  };
}

function summarizeDirection(items: OCRResult[]): ReadingDirection {
  const directions = items.map(detectReadingDirection);
  if (directions.every((direction) => direction === "vertical")) {
    return "vertical";
  }
  if (directions.every((direction) => direction === "horizontal")) {
    return "horizontal";
  }
  return "mixed";
}

function unionBoxes(boxes: BoundingBox[]): BoundingBox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}
