import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const contentSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "content.js"), "utf8");

globalThis.location = { hostname: "page.kakao.com", pathname: "/content/1" };
globalThis.window = { scrollX: 0, scrollY: 0, innerHeight: 800 };
globalThis.HTMLImageElement = class HTMLImageElement {};

await import("../content.js");

const runtime = globalThis.__MANGA_TRANSLATOR_V3__;

test("跨图窗口只接受同宽、对齐且紧邻的图片", () => {
  const owner = { left: 0, top: 1000, bottom: 2000, width: 760, height: 1000, sourceKey: "owner" };
  const previous = { left: 0, top: 0, bottom: 1000, width: 760, height: 1000, sourceKey: "previous" };
  const distant = { left: 0, top: 0, bottom: 800, width: 760, height: 800, sourceKey: "distant" };
  const narrow = { left: 120, top: 2000, bottom: 3000, width: 420, height: 1000, sourceKey: "narrow" };

  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, previous, "previous"), true);
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, distant, "previous"), false);
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, narrow, "next"), false);
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, { ...previous, sourceKey: "owner" }, "previous"), false);
});

test("跨图上下文根据显示比例动态计算并记录页面全局坐标", () => {
  globalThis.window.scrollX = 12;
  globalThis.window.scrollY = 500;
  const plan = runtime.__test.buildKakaoStitchWindowPlan({
    owner: { left: 20, top: 100, width: 760, height: 1000 },
    previous: { width: 760 },
    next: { width: 760 },
    canonicalWidth: 760,
    ownerHeight: 1000,
    previousHeight: 900,
    nextHeight: 1200
  });

  assert.equal(plan.previousSlice, 180);
  assert.equal(plan.nextSlice, 180);
  assert.deepEqual({ ...plan.ownerPageRect }, { left: 32, top: 600, width: 760, height: 1000 });
  globalThis.window.scrollX = 0;
  globalThis.window.scrollY = 0;
});

test("拼接结果为空或坐标异常时要求回退单图", () => {
  const payload = { stitch: { verified: true }, singleImagePayload: { dataUrl: "data:image/png;base64,A" } };
  assert.match(runtime.__test.shouldFallbackFromKakaoStitch(payload, { bubbles: [] }, { bubbles: [] }), /no owner text/);
  assert.match(
    runtime.__test.shouldFallbackFromKakaoStitch(
      payload,
      { bubbles: [{ x: 10, y: 10, w: 20, h: 10 }] },
      { bubbles: [{ x: 10, y: -60, w: 20, h: 10 }] }
    ),
    /implausible/
  );
  assert.equal(
    runtime.__test.shouldFallbackFromKakaoStitch(
      payload,
      { bubbles: [{ x: 10, y: 10, w: 20, h: 10 }] },
      { bubbles: [{ x: 10, y: 10, w: 20, h: 10 }] }
    ),
    ""
  );
});

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

test("跨图结果使用捕获时的页面全局坐标而不是滚动后的临时坐标", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 10, y: 30, w: 20, h: 10, original_text: "stable" }] },
    {
      stitch: {
        ownerTop: 300,
        ownerHeight: 600,
        compositeHeight: 1200,
        ownerPageRect: { left: 50, top: 2000, width: 600, height: 600 }
      }
    },
    { getBoundingClientRect: () => ({ left: 0, top: -900, width: 600, height: 600 }) },
    "owner-global"
  );

  assert.deepEqual(
    { ...result.bubbles[0].global_box },
    { left: 110, top: 2060, width: 120, height: 120 }
  );
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

test("global Kakao dedupe replaces an earlier partial sentence with the later complete sentence", () => {
  const first = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 20, y: 48, w: 35, h: 10, original_text: "아물론", translated_text: "啊当然" }] },
    {
      stitch: {
        ownerTop: 300,
        ownerHeight: 600,
        compositeHeight: 1200,
        ownerPageRect: { left: 0, top: 0, width: 600, height: 600 }
      }
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "partial-owner"
  );
  const second = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: 18, y: 23, w: 55, h: 18,
        original_text: "아물론이대로모든게끝나는건아닙니다",
        translated_text: "啊当然一切不会就这样结束"
      }]
    },
    {
      stitch: {
        ownerTop: 300,
        ownerHeight: 600,
        compositeHeight: 1200,
        ownerPageRect: { left: 0, top: 300, width: 600, height: 600 }
      }
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 300, width: 600, height: 600 }) },
    "complete-owner"
  );

  assert.equal(first.bubbles.length, 0);
  assert.equal(second.bubbles.length, 1);
  assert.equal(second.bubbles[0].translated_text, "啊当然一切不会就这样结束");
});

test("Kakao page-level dedupe also removes a single-image fragment covered by a stitched sentence", () => {
  const complete = runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 18, y: -10, w: 56, h: 20,
        block_id: "complete-cross-page",
        original_text: "아,물론 이대로모든게 끝나는 건 아닙니다!",
        translated_text: "啊，当然，事情不会就这样结束！"
      }],
      debug: {
        finalBubbles: [{ blockId: "complete-cross-page" }],
        items: [{ blockId: "complete-cross-page" }]
      }
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 1000, width: 600, height: 1000 }) },
    "complete-page-level"
  );
  const fragment = runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 32, y: 90, w: 25, h: 7,
        block_id: "fragment-single-image",
        original_text: "아물론",
        translated_text: "啊当然"
      }],
      debug: {
        finalBubbles: [{ blockId: "fragment-single-image" }],
        items: [{ blockId: "fragment-single-image" }]
      }
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 1000 }) },
    "fragment-page-level"
  );

  assert.equal(complete.bubbles.length, 1);
  assert.equal(fragment.bubbles.length, 0);
  assert.deepEqual(fragment.debug.finalBubbles, []);
  assert.deepEqual(fragment.debug.items, []);
});

test("pretranslation mode defaults to manual", () => {
  assert.equal(runtime.__test.normalizePretranslateMode("ahead"), "ahead");
  assert.equal(runtime.__test.normalizePretranslateMode("continuous"), "continuous");
  assert.equal(runtime.__test.isAutomaticPretranslateMode("ahead"), true);
  assert.equal(runtime.__test.isAutomaticPretranslateMode("continuous"), true);
  assert.equal(runtime.__test.normalizePretranslateMode("unexpected"), "manual");
});

test("pretranslation requires explicit activation in the current page", () => {
  assert.equal(
    runtime.__test.shouldSchedulePagePretranslation({
      enabled: true,
      pageEnabled: false,
      mode: "continuous",
      invalidated: false
    }),
    false
  );
  assert.equal(
    runtime.__test.shouldSchedulePagePretranslation({
      enabled: true,
      pageEnabled: true,
      mode: "continuous",
      invalidated: false
    }),
    true
  );
});

test("page translation toggle does not persist activation globally", () => {
  assert.equal(/storageSet\(\{\s*mt_pretranslate_mode\s*:/.test(contentSource), false);
});

test("overlay movement updates position without triggering text layout", () => {
  assert.deepEqual(
    { ...runtime.__test.compareOverlayViewportRects(
      { left: 10, top: 20, width: 600, height: 900 },
      { left: 10, top: -80, width: 600, height: 900 }
    ) },
    { positionChanged: true, sizeChanged: false }
  );
});

test("overlay resize triggers text layout", () => {
  assert.deepEqual(
    { ...runtime.__test.compareOverlayViewportRects(
      { left: 10, top: 20, width: 600, height: 900 },
      { left: 10, top: 20, width: 720, height: 1080 }
    ) },
    { positionChanged: false, sizeChanged: true }
  );
});

test("ahead translation keeps relaxed filtering through execution", () => {
  assert.deepEqual(
    { ...runtime.__test.buildAheadTranslationOptions("viewport") },
    { manual: true, relaxed: true, allowOffscreen: true, reason: "ahead-viewport" }
  );
});

test("Kakao ahead geometry accepts a valid image outside the viewport", () => {
  const image = new globalThis.HTMLImageElement();
  image.naturalWidth = 760;
  image.naturalHeight = 1000;
  const rect = {
    left: 0,
    right: 760,
    top: 5000,
    bottom: 6000,
    width: 760,
    height: 1000
  };

  assert.equal(runtime.__test.passesKakaopageTargetGeometry(image, rect, true, true, true), true);
});

test("Kakao strip screenshot waits until a useful target area is visible", () => {
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect(null), false);
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect({ width: 760, height: 179 }), false);
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect({ width: 179, height: 800 }), false);
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect({ width: 180, height: 180 }), true);
  assert.equal(contentSource.includes("Kakao target looks like a small lazy-loaded strip, skip OCR"), false);
  assert.match(contentSource, /isScreenshotTargetNotVisibleError\(reason\)[\s\S]*scheduleAutoTranslateRetry\(target\)/);
});

test("ahead window refills after completed images when the reader scrolls forward", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    index,
    done: index < 7,
    getBoundingClientRect: () => ({
      bottom: (index + 1) * 100
    })
  }));

  const pending = runtime.__test.selectPendingAheadCandidates(
    candidates,
    35,
    (candidate) => !candidate.done,
    6
  );
  assert.deepEqual(
    pending.map((candidate) => candidate.index),
    [7, 8, 9, 10, 11]
  );
});

test("a new content runtime takes ownership and removes stale extension UI", () => {
  assert.match(contentSource, /claimRuntimeOwnership\(\);[\s\S]*await loadLocalSettings\(\)/);
  assert.match(contentSource, /\.mt-overlay-layer, \.mt-floating-ball-wrap, \.mt-measure-probe/);
  assert.match(contentSource, /if \(!isCurrentRuntimeOwner\(\)\)\s*\{\s*destroy\(\)/);
  assert.match(contentSource, /delete target\.dataset\.mtLastTranslatedKey/);
  assert.match(contentSource, /delete target\.dataset\.mtNoTextKey/);
});

test("OCR capture and rendering are isolated from extension-owned overlays", () => {
  assert.match(contentSource, /withOverlayLayerHidden[\s\S]*overlayLayer\.style\.visibility = "hidden"/);
  assert.match(contentSource, /node\.closest\("\[data-manga-translator-overlay\]"\)/);
  assert.match(contentSource, /mutationInsideOverlay[\s\S]*continue/);
  assert.match(contentSource, /oldOverlay\.root\.remove\(\)/);
  assert.match(contentSource, /source image changed during OCR/);
});

test("debug overlay exposes raw, deduped, duplicate, and block boxes", () => {
  assert.match(contentSource, /name: "raw", items: debug\.rawItems/);
  assert.match(contentSource, /name: "duplicate", items: debug\.duplicateItems/);
  assert.match(contentSource, /name: "deduped", items: debug\.dedupedItems/);
  assert.match(contentSource, /name: "block", items: debug\.finalBubbles/);
  assert.match(contentSource, /node\.dataset\.blockId/);
});

test("ahead window contains the current image and the next six images", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    index,
    getBoundingClientRect: () => ({
      bottom: (index - 2) * 100
    })
  }));

  const pending = runtime.__test.selectPendingAheadCandidates(
    candidates,
    35,
    () => true,
    6
  );
  assert.deepEqual(
    pending.map((candidate) => candidate.index),
    [3, 4, 5, 6, 7, 8, 9]
  );
});

test("continuous window contains every pending image from the current position", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    index,
    done: index === 5,
    getBoundingClientRect: () => ({
      bottom: (index - 2) * 100
    })
  }));

  const pending = runtime.__test.selectPendingContinuousCandidates(
    candidates,
    35,
    (candidate) => !candidate.done
  );
  assert.deepEqual(
    pending.map((candidate) => candidate.index),
    [3, 4, 6, 7, 8, 9, 10, 11]
  );
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
  assert.deepEqual(
    { ...result.bubbles[0].cleaned_source_box },
    { x: 10, y: 30, w: 20, h: 10 }
  );
});

test("stitched OCR remaps the solid fill box into the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: 10, y: 30, w: 20, h: 10,
        fill_box: { x: 8, y: 28, w: 24, h: 14 },
        original_text: "source",
        translated_text: "translated",
        bg_type: "solid"
      }]
    },
    { stitch: { ownerTop: 200, ownerHeight: 400, compositeHeight: 800 } },
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "fill-box-remap"
  );

  assert.equal(result.bubbles[0].fill_box.x, 8);
  assert.ok(Math.abs(result.bubbles[0].fill_box.y - 6) < 1e-9);
  assert.equal(result.bubbles[0].fill_box.w, 24);
  assert.ok(Math.abs(result.bubbles[0].fill_box.h - 28) < 1e-9);
});

test("solid background covers both the original fill and translated text boxes", () => {
  assert.deepEqual(
    { ...runtime.__test.buildSolidBackgroundBox(
      { x: 20, y: 20, w: 30, h: 20 },
      { x: 10, y: 15, w: 25, h: 12 }
    ) },
    { x: 10, y: 15, w: 40, h: 25 }
  );
  assert.deepEqual(
    { ...runtime.__test.buildSolidBackgroundBox(
      { x: 20, y: 20, w: 30, h: 20 },
      null
    ) },
    { x: 20, y: 20, w: 30, h: 20 }
  );
});

test("stitched solid background can extend upward into the previous page", () => {
  assert.deepEqual(
    { ...runtime.__test.buildSolidBackgroundBox(
      { x: 20, y: -12, w: 50, h: 28 },
      { x: 18, y: -15, w: 54, h: 32 },
      true
    ) },
    { x: 18, y: -15, w: 54, h: 32 }
  );
});

test("overlay visibility includes stitched content crossing into the previous page", () => {
  const rect = runtime.__test.getOverlayVisibilityRect(
    {
      bubbleNodes: [{
        dataset: { stitchOverflow: "true", yPercent: "-30", hPercent: "20" }
      }]
    },
    { left: 0, right: 600, top: 900, bottom: 1500, width: 600, height: 600 }
  );

  assert.deepEqual(rect, {
    left: 0,
    right: 600,
    top: 720,
    bottom: 1500,
    width: 600,
    height: 780
  });
});

test("cleaned image patch aligns the source OCR box inside an overlay bubble", () => {
  assert.deepEqual(
    { ...runtime.__test.getCleanedPatchStyle({ x: 40, y: 25, w: 20, h: 10 }) },
    { sizeX: "500%", sizeY: "1000%", positionX: "50%", positionY: "27.77777777777778%" }
  );
});

test("stitched OCR remaps the full visual region polygon", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: 10,
        y: 30,
        w: 20,
        h: 10,
        original_text: "panel",
        region_polygon: [
          { x: 5, y: 25 }, { x: 35, y: 25 }, { x: 35, y: 45 }, { x: 5, y: 45 }
        ]
      }]
    },
    { stitch: { ownerTop: 300, ownerHeight: 600, compositeHeight: 1200 } },
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-region"
  );

  assert.deepEqual(result.bubbles[0].region_polygon.map((point) => point.y), [0, 0, 40, 40]);
});

test("solid background clip is expressed relative to the translated box", () => {
  const clip = runtime.__test.buildRegionClipPath(
    [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 60 }, { x: 10, y: 60 }],
    20,
    30,
    10,
    20
  );
  assert.equal(clip, "polygon(-100.00% -50.00%, 200.00% -50.00%, 200.00% 150.00%, -100.00% 150.00%)");
});

test("translation keeps the requested approximate source line count", () => {
  const formatted = runtime.__test.formatTranslationForOriginalLines("为什么没有把东西拿出来", 3);
  assert.equal(formatted.split("\n").length, 3);
  assert.equal(formatted.replace(/\n/g, ""), "为什么没有把东西拿出来");
  assert.equal(runtime.__test.normalizeBubbleRotation(95), -85);
});

test("transparent backgrounds default to black text with a white outline", () => {
  const outline = runtime.__test.getBubbleRenderColors({}, "none");
  assert.deepEqual({ ...outline }, { textColor: "#000000", strokeColor: "#ffffff" });

  const solid = runtime.__test.getBubbleRenderColors({}, "solid");
  assert.deepEqual({ ...solid }, { textColor: "#111827", strokeColor: "#ffffff" });

  const custom = runtime.__test.getBubbleRenderColors({ text_color: "#123456", stroke_color: "#abcdef" }, "none");
  assert.deepEqual({ ...custom }, { textColor: "#123456", strokeColor: "#abcdef" });
});

test("complex-background outline uses the strengthened dynamic width", () => {
  assert.equal(runtime.__test.getDynamicStrokeWidth(20), 1.8);
  assert.equal(runtime.__test.getDynamicStrokeWidth(40), 3.4);
  assert.equal(runtime.__test.getDynamicStrokeWidth(80), 4.2);
});
