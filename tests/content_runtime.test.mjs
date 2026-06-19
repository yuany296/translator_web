import assert from "node:assert/strict";
import test from "node:test";

globalThis.location = { hostname: "page.kakao.com", pathname: "/content/1" };
globalThis.window = { scrollX: 0, scrollY: 0, innerHeight: 800 };

await import("../content.js");

const runtime = globalThis.__MANGA_TRANSLATOR_V3__;

test("stitched OCR keeps only boxes whose center belongs to the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [
        { x: 10, y: 5, w: 30, h: 8, original_text: "previous" },
        { x: 10, y: 20, w: 30, h: 20, original_text: "boundary" },
        { x: 10, y: 88, w: 30, h: 8, original_text: "next" }
      ]
    },
    { stitch: { ownerTop: 300, ownerHeight: 600, compositeHeight: 1200 } },
    { getBoundingClientRect: () => ({ left: 0, top: 100, width: 600, height: 600 }) },
    "owner-a"
  );

  assert.deepEqual(result.bubbles.map((bubble) => bubble.original_text), ["boundary"]);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  assert.ok(result.bubbles[0].y < 0);
});

test("global Kakao dedupe drops the same overlapping boundary text from a neighbor window", () => {
  const first = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 10, y: 48, w: 30, h: 12, original_text: "피크닉 세트." }] },
    { stitch: { ownerTop: 300, ownerHeight: 600, compositeHeight: 1200 } },
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-b"
  );
  const second = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 10, y: 23, w: 30, h: 12, original_text: "피크닉세트" }] },
    { stitch: { ownerTop: 300, ownerHeight: 600, compositeHeight: 1200 } },
    { getBoundingClientRect: () => ({ left: 0, top: 300, width: 600, height: 600 }) },
    "owner-c"
  );

  assert.equal(first.bubbles.length, 1);
  assert.equal(second.bubbles.length, 0);
});

test("pretranslation mode defaults to manual", () => {
  assert.equal(runtime.__test.normalizePretranslateMode("ahead"), "ahead");
  assert.equal(runtime.__test.normalizePretranslateMode("unexpected"), "manual");
});

test("stitched OCR remaps polygon points into the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: 10,
        y: 30,
        w: 20,
        h: 10,
        original_text: "rotated",
        polygon: [{ x: 10, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 40 }, { x: 10, y: 40 }]
      }]
    },
    { stitch: { ownerTop: 300, ownerHeight: 600, compositeHeight: 1200 } },
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-polygon"
  );

  assert.equal(result.bubbles.length, 1);
  assert.deepEqual(result.bubbles[0].polygon.map((point) => point.y), [10, 10, 30, 30]);
});

test("translation keeps the requested approximate source line count", () => {
  const formatted = runtime.__test.formatTranslationForOriginalLines("为什么没有把东西拿出来", 3);
  assert.equal(formatted.split("\n").length, 3);
  assert.equal(formatted.replace(/\n/g, ""), "为什么没有把东西拿出来");
  assert.equal(runtime.__test.normalizeBubbleRotation(95), -85);
});
