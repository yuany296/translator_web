import { describe, expect, it } from "vitest";
import type { MergedTextBlock } from "../core/types";
import { buildTranslationUnits } from "./translatorRouter";

describe("buildTranslationUnits", () => {
  it("uses expanded overlay boxes while preserving source block boxes", () => {
    const blocks: MergedTextBlock[] = [
      {
        id: "block-0",
        sourceText: "안녕",
        boundingBox: { x: 50, y: 40, width: 80, height: 30 },
        items: [],
        direction: "horizontal"
      }
    ];

    const [unit] = buildTranslationUnits(blocks, ["你好"], { width: 200, height: 160 });

    expect(unit.sourceBoundingBox).toEqual(blocks[0].boundingBox);
    expect(unit.boundingBox.x).toBeLessThan(blocks[0].boundingBox.x);
    expect(unit.boundingBox.y).toBeLessThan(blocks[0].boundingBox.y);
    expect(unit.boundingBox.width).toBeGreaterThan(blocks[0].boundingBox.width);
    expect(unit.boundingBox.height).toBeGreaterThan(blocks[0].boundingBox.height);
  });

  it("shrinks padding when neighboring overlay boxes overlap too much", () => {
    const blocks: MergedTextBlock[] = [
      {
        id: "block-0",
        sourceText: "one",
        boundingBox: { x: 20, y: 20, width: 60, height: 30 },
        items: [],
        direction: "horizontal"
      },
      {
        id: "block-1",
        sourceText: "two",
        boundingBox: { x: 78, y: 22, width: 60, height: 30 },
        items: [],
        direction: "horizontal"
      }
    ];

    const units = buildTranslationUnits(blocks, ["一", "二"], { width: 200, height: 120 });

    expect(units[0].boundingBox.x + units[0].boundingBox.width).toBeLessThanOrEqual(88);
    expect(units[1].boundingBox.x).toBeGreaterThanOrEqual(70);
  });
});
