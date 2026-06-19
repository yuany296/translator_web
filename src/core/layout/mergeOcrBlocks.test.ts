import { describe, expect, it } from "vitest";
import { mergeOcrBlocks } from "./mergeOcrBlocks";
import type { OCRResult } from "../types";

describe("mergeOcrBlocks", () => {
  it("merges close manga dialogue lines before translation", () => {
    const items: OCRResult[] = [
      { text: "hello", confidence: 0.9, boundingBox: { x: 20, y: 10, width: 40, height: 12 } },
      { text: "there", confidence: 0.9, boundingBox: { x: 22, y: 25, width: 44, height: 12 } },
      { text: "far", confidence: 0.9, boundingBox: { x: 200, y: 200, width: 30, height: 12 } }
    ];

    const blocks = mergeOcrBlocks(items);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].sourceText).toContain("hello");
    expect(blocks[0].sourceText).toContain("there");
  });

  it("keeps connected large lettering in one text block", () => {
    const items: OCRResult[] = [
      { text: "쿵", confidence: 0.95, boundingBox: { x: 120, y: 80, width: 80, height: 48 } },
      { text: "!", confidence: 0.92, boundingBox: { x: 205, y: 92, width: 18, height: 45 } },
      { text: "쾅", confidence: 0.9, boundingBox: { x: 134, y: 150, width: 90, height: 52 } },
      { text: "hello", confidence: 0.9, boundingBox: { x: 30, y: 360, width: 60, height: 18 } }
    ];

    const blocks = mergeOcrBlocks(items);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].items).toHaveLength(3);
    expect(blocks[0].boundingBox).toEqual({ x: 120, y: 80, width: 104, height: 122 });
  });

  it("does not merge distant speech bubbles", () => {
    const items: OCRResult[] = [
      { text: "left", confidence: 0.9, boundingBox: { x: 20, y: 20, width: 50, height: 16 } },
      { text: "bubble", confidence: 0.9, boundingBox: { x: 22, y: 44, width: 56, height: 16 } },
      { text: "right", confidence: 0.9, boundingBox: { x: 260, y: 22, width: 52, height: 16 } },
      { text: "bubble", confidence: 0.9, boundingBox: { x: 262, y: 46, width: 56, height: 16 } }
    ];

    const blocks = mergeOcrBlocks(items);

    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.items.length)).toEqual([2, 2]);
  });
});
