import type { OCRResult, ReadingDirection } from "../types";

export function detectReadingDirection(item: OCRResult): ReadingDirection {
  const { width, height } = item.boundingBox;
  if (height > width * 1.8) {
    return "vertical";
  }
  if (width > height * 1.8) {
    return "horizontal";
  }
  return "mixed";
}

export function sortByReadingOrder<T extends { boundingBox: { x: number; y: number; width: number; height: number } }>(
  items: T[]
): T[] {
  return [...items].sort((left, right) => {
    const leftCenterY = left.boundingBox.y + left.boundingBox.height / 2;
    const rightCenterY = right.boundingBox.y + right.boundingBox.height / 2;
    const averageHeight = Math.max(1, (left.boundingBox.height + right.boundingBox.height) / 2);
    if (Math.abs(leftCenterY - rightCenterY) > averageHeight * 0.7) {
      return leftCenterY - rightCenterY;
    }
    return left.boundingBox.x - right.boundingBox.x;
  });
}
