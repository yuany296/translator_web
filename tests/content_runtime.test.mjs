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
