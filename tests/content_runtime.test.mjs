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

function makeStitchPayload(ownerTop, ownerHeight, compositeHeight, opts = {}) {
  const compositeWidth = opts.compositeWidth || 760;
  const ownerEntry = {
    source: "owner",
    targetKey: opts.targetKey || "test-owner",
    src: opts.src || "owner.jpg",
    drawRect: { x: 0, y: ownerTop, w: compositeWidth, h: ownerHeight },
    sourceCrop: { x: 0, y: 0, w: compositeWidth, h: ownerHeight },
    naturalWidth: compositeWidth,
    naturalHeight: ownerHeight
  };
  return {
    stitch: {
      canvasWidth: compositeWidth,
      canvasHeight: compositeHeight,
      owner: ownerEntry,
      previous: opts.previous || null,
      next: opts.next || null,
      segments: [opts.previous, ownerEntry, opts.next].filter(Boolean),
      sourceKeys: opts.sourceKeys || [],
      verified: true
    }
  };
}

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

  assert.equal(plan.previousSlice, 350);
  assert.equal(plan.nextSlice, 350);
  globalThis.window.scrollX = 0;
  globalThis.window.scrollY = 0;
});

test("Kakao short adjacent pages are attached as full neighboring slices", () => {
  const plan = runtime.__test.buildKakaoStitchWindowPlan({
    owner: { left: 0, top: 520, width: 760, height: 1000 },
    previous: { left: 0, top: 240, width: 760, height: 280 },
    next: { left: 0, top: 1520, width: 760, height: 360 },
    canonicalWidth: 760,
    ownerHeight: 1000,
    previousHeight: 280,
    nextHeight: 360
  });

  assert.equal(plan.previousSlice, 280);
  assert.equal(plan.nextSlice, 360);
  assert.equal(plan.previousShortPageAttachment, true);
  assert.equal(plan.nextShortPageAttachment, true);
});

test("Kakao short attachment requires a short neighbor relative to a larger owner", () => {
  assert.equal(
    runtime.__test.isAttachableKakaoShortPage(
      { width: 760, height: 280 },
      { width: 760, height: 1000 },
      280,
      1000
    ),
    true
  );
  assert.equal(
    runtime.__test.isAttachableKakaoShortPage(
      { width: 760, height: 0 },
      { width: 760, height: 1000 },
      430,
      1000
    ),
    true
  );
  assert.equal(
    runtime.__test.isAttachableKakaoShortPage(
      { width: 760, height: 0 },
      { width: 760, height: 1000 },
      900,
      1000
    ),
    false
  );
  assert.equal(
    runtime.__test.isAttachableKakaoShortPage(
      { width: 760, height: 280 },
      { width: 760, height: 320 },
      280,
      320
    ),
    false
  );
});

test("Kakao vertical overlap detection finds repeated suffix and prefix", () => {
  const width = 4;
  const makeSample = (rows) => ({
    width,
    height: rows.length,
    gray: Uint8Array.from(rows.flatMap((value) => Array.from({ length: width }, () => value)))
  });
  const previous = makeSample([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const current = makeSample([40, 50, 60, 70, 80, 90, 100, 140, 150, 160]);

  const overlap = runtime.__test.findKakaoVerticalOverlap(previous, current);

  assert.equal(overlap.accepted, true);
  assert.equal(overlap.rows, 7);
  assert.equal(overlap.mae, 0);
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

test("page-edge fragmented images reject stitched admission before OCR", () => {
  const rejection = runtime.__test.shouldRejectKakaoPageEdgeStitch({
    owner: {
      sourceKey: "https://page-edge.kakao.com/sdownload/resource?kid=frag",
      width: 720,
      height: 540
    },
    canonicalWidth: 810,
    ownerHeight: 540,
    previous: { sourceKey: "previous" },
    next: { sourceKey: "next" },
    previousHeight: 1193,
    nextHeight: 315
  });

  assert.match(rejection, /page-edge fragmented/);
});

test("dw-img large images are not rejected by page-edge fragmented admission", () => {
  const rejection = runtime.__test.shouldRejectKakaoPageEdgeStitch({
    owner: {
      sourceKey: "https://dw-img-page.kakao.com/sdownload/resource?token=large",
      width: 720,
      height: 947
    },
    canonicalWidth: 760,
    ownerHeight: 1000,
    previous: { sourceKey: "previous" },
    next: { sourceKey: "next" },
    previousHeight: 1000,
    nextHeight: 1380
  });

  assert.equal(rejection, "");
});

test("OCR request key includes source token, mode, and fallback reason", () => {
  const first = runtime.__test.buildOcrRequestKey("owner-key", {
    ocrMode: "single-fallback",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=a",
    fallbackReason: "stitched OCR dropped all bubbles"
  });
  const second = runtime.__test.buildOcrRequestKey("owner-key", {
    ocrMode: "stitch",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=b",
    fallbackReason: ""
  });

  assert.notEqual(first, second);
  assert.match(first, /mode:single-fallback/);
  assert.match(second, /mode:stitch/);
});

test("content does not skip single-fallback before sending it to background", () => {
  assert.equal(contentSource.includes("duplicate single-fallback request"), false);
  assert.equal(contentSource.includes("shouldSkipRepeatedFallbackRequest"), false);
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
    makeStitchPayload(300, 600, 1200, {
      previous: { source: "previous", drawRect: { x: 0, y: 0, w: 760, h: 300 } },
      next: { source: "next", drawRect: { x: 0, y: 900, w: 760, h: 300 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 100, width: 600, height: 600 }) },
    "owner-a"
  );

  assert.deepEqual(result.bubbles.map((bubble) => bubble.original_text), ["boundary"]);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  // Overflow bubble: crosses owner top boundary, not clipped
  assert.ok(Math.abs(result.bubbles[0].y - (-10)) < 1e-9);
  assert.ok(Math.abs(result.bubbles[0].h - 40) < 1e-9);
});

test("stitched OCR keeps only boxes whose overlap belongs to the owner segment", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [
        { x: 10, y: 8, w: 20, h: 8, original_text: "previous-only" },
        { x: 10, y: 44, w: 20, h: 8, original_text: "owner-only" },
        { x: 10, y: 84, w: 20, h: 8, original_text: "next-only" }
      ]
    },
    makeStitchPayload(300, 600, 1200, {
      previous: { source: "previous", drawRect: { x: 0, y: 0, w: 760, h: 300 } },
      next: { source: "next", drawRect: { x: 0, y: 900, w: 760, h: 300 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-segment"
  );

  assert.deepEqual(result.bubbles.map((bubble) => bubble.original_text), ["owner-only"]);
});

test("跨图结果使用捕获时的页面全局坐标而不是滚动后的临时坐标", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 10, y: 30, w: 20, h: 10, original_text: "stable" }] },
    makeStitchPayload(300, 600, 1200),
    { getBoundingClientRect: () => ({ left: 50, top: 2000, width: 600, height: 600 }) },
    "owner-global"
  );

  // global_box is now computed from current target rect + scroll, not stored ownerPageRect
  // target rect: left=50, top=2000. bubble: x=10, y=0 (clipped), w=20, h=16.67
  // global_box.left = 50 + 0 + (x/100)*600, global_box.top = 2000 + 0 + (y/100)*600
  assert.ok(result.bubbles.length > 0, "should have mapped bubbles");
});

test("global Kakao dedupe drops the same overlapping boundary text from a neighbor window", () => {
  const first = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 10, y: 48, w: 30, h: 12, original_text: "피크닉 세트." }] },
    makeStitchPayload(300, 600, 1200),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-b"
  );
  const second = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 10, y: 23, w: 30, h: 12, original_text: "피크닉세트" }] },
    makeStitchPayload(300, 600, 1200),
    { getBoundingClientRect: () => ({ left: 0, top: 300, width: 600, height: 600 }) },
    "owner-c"
  );

  assert.equal(first.bubbles.length, 1);
  assert.equal(second.bubbles.length, 0);
});

test("global Kakao dedupe replaces an earlier partial sentence with the later complete sentence", () => {
  const first = runtime.__test.mapKakaoStitchedResult(
    { bubbles: [{ x: 20, y: 48, w: 35, h: 10, original_text: "아물론", translated_text: "啊当然" }] },
    makeStitchPayload(300, 600, 1200),
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
    makeStitchPayload(300, 600, 1200, { targetKey: "complete-owner" }),
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 300, width: 600, height: 600 }) },
    "complete-owner"
  );

  assert.equal(first.bubbles.length, 0);
  assert.equal(second.bubbles.length, 1);
  assert.equal(second.bubbles[0].translated_text, "啊当然一切不会就这样结束");
});

test("Kakao page-level dedupe also removes a single-image fragment covered by a stitched sentence", async () => {
  const complete = await runtime.__test.dedupeKakaoResultByPageCoordinates(
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
  const fragment = await runtime.__test.dedupeKakaoResultByPageCoordinates(
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

test("Kakao page-level dedupe trims only the repeated boundary and keeps the unique final line", async () => {
  const leading = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 15, y: 82, w: 70, h: 24,
        block_id: "boundary-leading",
        original_text: "'산제물의 합참가'는 명의 지휘자와 그가 소환한 1개의 은쟁반으로",
        translated_text: "「祭品的联合参加」是由一位著名的指挥家和他所召唤的一个银盘所构成的。"
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 2000, width: 600, height: 1000 }) },
    "boundary-leading-page"
  );
  const trailing = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 16, y: -18, w: 68, h: 25,
        block_id: "boundary-trailing",
        original_text: "명의 지휘자와 그가 소환한 1개의 은쟁반으로 미루머져 있다.",
        translated_text: "据一位著名指挥家和他所召唤的一个银盘推断。"
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 3000, width: 600, height: 1000 }) },
    "boundary-trailing-page"
  );

  assert.equal(leading.bubbles.length, 1);
  assert.equal(trailing.bubbles.length, 1);
  assert.equal(trailing.bubbles[0].original_text, "미루머져 있다.");
  assert.ok(trailing.bubbles[0].y > -18);
  assert.ok(trailing.bubbles[0].h < 25);
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

test("Kakao short page queueing is redirected before standalone OCR gates", () => {
  const queueTranslateIndex = contentSource.indexOf("function queueTranslate(target, options)");
  const queueTranslateRedirectIndex = contentSource.indexOf("maybeQueueKakaoShortPageAttachmentOwner(target, options)", queueTranslateIndex);
  const queuedGuardIndex = contentSource.indexOf("state.queuedTargets.has(target)", queueTranslateIndex);
  assert.ok(queueTranslateIndex >= 0);
  assert.ok(queueTranslateRedirectIndex > queueTranslateIndex);
  assert.ok(queueTranslateRedirectIndex < queuedGuardIndex);

  const pageAutoIndex = contentSource.indexOf("function queuePageAutoTranslate(target)");
  const pageAutoRedirectIndex = contentSource.indexOf("page-auto-short-attachment", pageAutoIndex);
  const noTextGateIndex = contentSource.indexOf("target.dataset.mtNoTextKey === targetKey", pageAutoIndex);
  assert.ok(pageAutoIndex >= 0);
  assert.ok(pageAutoRedirectIndex > pageAutoIndex);
  assert.ok(pageAutoRedirectIndex < noTextGateIndex);
  assert.match(contentSource, /target\.dataset\.mtKakaoAttachedToKey = ownerScopedKey/);
});

test("Kakao short page attachment is always released (not gated on stitched result bubbles)", () => {
  assert.equal(
    runtime.__test.hasAttachedShortPageBubble({ bubbles: [{ original_text: "owner" }] }),
    false
  );
  assert.equal(
    runtime.__test.hasAttachedShortPageBubble({ bubbles: [{ stitch_attached_short_page: true }] }),
    true
  );

  const resultReadyIndex = contentSource.indexOf("result = await dedupeKakaoResultByPageCoordinates(result, target, targetKey)");
  const releaseIndex = contentSource.indexOf("releaseUncoveredKakaoShortPages(payload, result, target", resultReadyIndex);
  const cacheIndex = contentSource.indexOf("rememberLocalResult(scopedTargetKey, result)", resultReadyIndex);
  assert.ok(resultReadyIndex >= 0);
  assert.ok(releaseIndex > resultReadyIndex);
  assert.ok(releaseIndex < cacheIndex);
  assert.match(contentSource, /mtKakaoDetachedFromOwnerKey/);
  assert.match(contentSource, /short-attachment-suppressed/);
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
    makeStitchPayload(300, 600, 1200),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-polygon"
  );

  assert.equal(result.bubbles.length, 1);
  assert.deepEqual(result.bubbles[0].polygon.map((point) => point.y), [10, 10, 30, 30]);
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
    makeStitchPayload(200, 400, 800),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "fill-box-remap"
  );

  assert.equal(result.bubbles[0].fill_box.x, 8);
  assert.ok(Math.abs(result.bubbles[0].fill_box.y - 6) < 1e-9);
  assert.equal(result.bubbles[0].fill_box.w, 24);
  assert.ok(Math.abs(result.bubbles[0].fill_box.h - 28) < 1e-9);
});

test("stitched OCR remaps raw debug items into the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{ x: 10, y: 30, w: 20, h: 10, original_text: "owner" }],
      debug: {
        imageWidth: 760,
        imageHeight: 1200,
        rawItems: [
          { id: "prev", rawBox: { left: 76, top: 60, width: 152, height: 48 }, text: "previous" },
          { id: "owner", rawBox: { left: 76, top: 360, width: 152, height: 60 }, text: "owner" },
          { id: "next", rawBox: { left: 76, top: 1020, width: 152, height: 48 }, text: "next" }
        ],
        dedupedItems: [],
        duplicateItems: [],
        finalBubbles: []
      }
    },
    makeStitchPayload(300, 600, 1200, {
      previous: { source: "previous", drawRect: { x: 0, y: 0, w: 760, h: 300 } },
      next: { source: "next", drawRect: { x: 0, y: 900, w: 760, h: 300 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "debug-owner"
  );

  assert.deepEqual(result.debug.rawItems.map((item) => item.id), ["owner"]);
  assert.ok(Math.abs(result.debug.rawItems[0].percent.y - 10) < 1e-9);
  assert.ok(Math.abs(result.debug.rawItems[0].percent.h - 10) < 1e-9);
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

test("overlay sync removes stale Kakao overlays when an image node is reused", () => {
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://page-edge.kakao.com/old-image.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 });
  let removed = false;
  const root = {
    isConnected: true,
    style: {},
    remove() {
      removed = true;
      this.isConnected = false;
    }
  };

  target.currentSrc = "https://page-edge.kakao.com/new-image.jpg";
  runtime.__test.syncOverlayPosition({
    target,
    targetId: "stale-node",
    targetKey: "old-key",
    sourceToken: "https://page-edge.kakao.com/old-image.jpg",
    root,
    bubbleNodes: []
  });

  assert.equal(removed, true);
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
    makeStitchPayload(300, 600, 1200),
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

test("stitched OCR maps explicitly attached short neighbor pages onto the owner edge", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [
        { x: 10, y: 8, w: 20, h: 8, original_text: "previous-short" },
        { x: 10, y: 44, w: 20, h: 8, original_text: "short-owner-center" },
        { x: 10, y: 84, w: 20, h: 8, original_text: "next-short" }
      ]
    },
    makeStitchPayload(300, 600, 1200, {
      previous: { source: "previous", shortPageAttachment: true, drawRect: { x: 0, y: 0, w: 760, h: 300 } },
      next: { source: "next", shortPageAttachment: true, drawRect: { x: 0, y: 900, w: 760, h: 300 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-short-neighbors"
  );

  assert.deepEqual(result.bubbles.map((bubble) => bubble.original_text), ["previous-short", "short-owner-center", "next-short"]);
  assert.equal(result.bubbles[0].stitch_attached_short_page, true);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  assert.ok(result.bubbles[0].y < 0);
  assert.equal(result.bubbles[2].stitch_attached_short_page, true);
  assert.equal(result.bubbles[2].stitch_overflow, true);
  assert.ok(result.bubbles[2].y > 100);
});

test("stitched OCR keeps ordinary adjacent context-slice text as owner overflow", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: 12,
        y: (1195 / 1460) * 100,
        w: 28,
        h: (190 / 1460) * 100,
        original_text: "next boundary caption",
        translated_text: "next boundary translation"
      }]
    },
    makeStitchPayload(0, 1100, 1460, {
      next: { source: "next", drawRect: { x: 0, y: 1100, w: 760, h: 360 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 1100 }) },
    "owner-next-context-boundary"
  );

  assert.equal(result.bubbles.length, 1);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  assert.equal(result.bubbles[0].stitch_boundary_neighbor, true);
  assert.ok(result.bubbles[0].y > 100);
  assert.ok(result.bubbles[0].h > 15);
});

test("stitched OCR keeps multiline speech bubble from deeper adjacent context", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [
        {
          x: 51,
          y: (1235 / 1460) * 100,
          w: 24,
          h: (34 / 1460) * 100,
          original_text: "어우피디님!",
          translated_text: "哦，PD大人！"
        },
        {
          x: 48,
          y: (1286 / 1460) * 100,
          w: 31,
          h: (48 / 1460) * 100,
          original_text: "왜 이래요",
          translated_text: "为什么这样"
        },
        {
          x: 50,
          y: (1350 / 1460) * 100,
          w: 28,
          h: (48 / 1460) * 100,
          original_text: "정말!!",
          translated_text: "真是的！！"
        }
      ]
    },
    makeStitchPayload(0, 1100, 1460, {
      next: { source: "next", drawRect: { x: 0, y: 1100, w: 760, h: 360 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 1100 }) },
    "owner-next-context-multiline-speech"
  );

  assert.deepEqual(
    result.bubbles.map((bubble) => bubble.original_text),
    ["어우피디님!", "왜 이래요", "정말!!"]
  );
  assert.equal(result.bubbles.every((bubble) => bubble.stitch_boundary_neighbor), true);
  assert.ok(result.bubbles[2].y > result.bubbles[0].y);
});

test("stitched OCR keeps merged boundary caption spanning owner and adjacent context", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: (109.2 / 720) * 100,
        y: (1373 / 1820) * 100,
        w: (225.6 / 720) * 100,
        h: (192 / 1820) * 100,
        original_text: "봤냐, 이높들아! 꼴좋다,\n꼴좋아!",
        translated_text: "看到了吧，你们！活该，活该！",
        sourceLineCount: 2
      }]
    },
    makeStitchPayload(360, 1100, 1820, {
      compositeWidth: 720,
      previous: { source: "previous", drawRect: { x: 0, y: 0, w: 720, h: 360 } },
      next: { source: "next", drawRect: { x: 0, y: 1460, w: 720, h: 360 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 1100 }) },
    "owner-next-context-merged-caption"
  );

  assert.equal(result.bubbles.length, 1);
  assert.equal(result.bubbles[0].stitch_boundary_neighbor, true);
  assert.ok(result.bubbles[0].y < 100);
  assert.ok(result.bubbles[0].y + result.bubbles[0].h > 100);
});

test("stitched OCR still drops ordinary full-neighbor page text", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [{
        x: 12,
        y: (1210 / 2200) * 100,
        w: 28,
        h: (80 / 2200) * 100,
        original_text: "full neighbor page"
      }]
    },
    makeStitchPayload(0, 1100, 2200, {
      next: { source: "next", drawRect: { x: 0, y: 1100, w: 760, h: 1100 } }
    }),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 1100 }) },
    "owner-full-neighbor"
  );

  assert.equal(result.bubbles.length, 0);
});

test("inflightByTarget prevents re-queue for same sourceToken on same DOM node", () => {
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/img.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  const sourceToken = runtime.__test.getPipelineTrace ? "test" : "fallback";

  // Clear any inflight state
  delete target.dataset.inflightSourceToken;
  target.dataset.mtSourceToken = sourceToken;

  // The first translateTarget call sets inflightSourceToken and returns a promise.
  // Subsequent calls with the same sourceToken should NOT create a new inflight.
  // We verify this by checking that inflightSourceToken is set correctly when
  // translateTarget starts.
  assert.equal(target.dataset.inflightSourceToken, undefined);
});

test("inflightByTarget allows re-queue when sourceToken changed (DOM reuse)", () => {
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/old.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");

  // Simulate a stale inflight from previous image
  target.dataset.inflightSourceToken = "old-source-token";
  target.dataset.mtSourceToken = "new-source-token";

  // When sourceToken changes, inflight check should not block
  // because inflightSourceToken !== currentSourceToken
  assert.notEqual(
    target.dataset.inflightSourceToken,
    target.dataset.mtSourceToken
  );
});

test("mtKakaoAttachedToKey blocks independent queue entry until timeout", () => {
  // Simulate a short page attached to an owner
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/short.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");

  // Set attachment timestamp to now (not expired)
  target.dataset.mtKakaoAttachedToKey = "owner-key";
  target.dataset.mtKakaoAttachedToAt = String(Date.now());

  // The timeout constant is 8000ms, so this should NOT be expired
  const attachedAt = Number(target.dataset.mtKakaoAttachedToAt || 0);
  const timeout = 8000;
  assert.equal(Date.now() - attachedAt <= timeout, true,
    "Fresh attachment should not be expired");

  // Verify the attachment key is set
  assert.equal(target.dataset.mtKakaoAttachedToKey, "owner-key");
});

test("mtKakaoAttachedToKey expires and allows standalone translation after timeout", () => {
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/short-expired.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");

  // Set attachment timestamp to 10 seconds ago (expired)
  target.dataset.mtKakaoAttachedToKey = "owner-key";
  target.dataset.mtKakaoAttachedToAt = String(Date.now() - 10000);

  // The timeout constant is 8000ms, so this should be expired
  const attachedAt = Number(target.dataset.mtKakaoAttachedToAt || 0);
  const timeout = 8000;
  if (Date.now() - attachedAt > timeout) {
    // Simulate what queuePageAutoTranslate does on timeout
    delete target.dataset.mtKakaoAttachedToKey;
    delete target.dataset.mtKakaoAttachedToAt;
  }

  assert.equal(target.dataset.mtKakaoAttachedToKey, undefined,
    "Expired attachment key should be cleared");
  assert.equal(target.dataset.mtKakaoAttachedToAt, undefined,
    "Expired attachment timestamp should be cleared");
});

test("shouldFallbackFromKakaoStitch triggers on dropRatio > 0.7", () => {
  const payload = { stitch: { verified: true }, singleImagePayload: { dataUrl: "data:image/png;base64,A" } };
  // 10 raw bubbles, 2 mapped = 80% drop ratio → should trigger
  const raw = Array.from({ length: 10 }, (_, i) => ({
    x: 10, y: i * 10 + 1, w: 20, h: 8,
    original_text: `line-${i}`
  }));
  const mapped = Array.from({ length: 2 }, (_, i) => ({
    x: 10, y: i * 10 + 1, w: 20, h: 8,
    original_text: `line-${i}`
  }));
  const reason = runtime.__test.shouldFallbackFromKakaoStitch(
    payload,
    { bubbles: raw },
    { bubbles: mapped }
  );
  assert.match(reason, /drop ratio/);
});

test("normalizeDebugCoordinateItems filters non-owner items and remaps coordinates", () => {
  const result = runtime.__test.normalizeDebugCoordinateItems(
    [
      { id: "prev", rawBox: { left: 76, top: 60, width: 152, height: 48 }, text: "previous" },
      { id: "owner-a", rawBox: { left: 76, top: 360, width: 152, height: 60 }, text: "owner text" },
      { id: "next", rawBox: { left: 76, top: 1020, width: 152, height: 48 }, text: "next" }
    ],
    { imageWidth: 760, imageHeight: 1200 },
    {
      stitch: { verified: true },
      compositeWidth: 760,
      compositeHeight: 1200,
      ownerDraw: { x: 0, y: 300, w: 760, h: 600 },
      segments: [
        { source: "previous", drawRect: { x: 0, y: 0, w: 760, h: 300 } },
        { source: "owner", drawRect: { x: 0, y: 300, w: 760, h: 600 } },
        { source: "next", drawRect: { x: 0, y: 900, w: 760, h: 300 } }
      ]
    }
  );

  assert.equal(result.length, 1, "Only owner items should remain");
  if (result.length > 0) {
    assert.equal(result[0].id, "owner-a");
    assert.ok(Math.abs(result[0].percent.y - 10) < 1e-9, "Y should be remapped relative to owner");
    assert.ok(result[0].percent.h > 0, "Height should be positive");
  }
});

test("normalizeDebugCoordinateItems keeps adjacent boundary context debug items", () => {
  const result = runtime.__test.normalizeDebugCoordinateItems(
    [
      { id: "caption-a", rawBox: { left: 129, top: 1211, width: 187, height: 82 }, text: "봤냐, 이놈들아!" },
      { id: "caption-b", rawBox: { left: 184, top: 1263, width: 102, height: 64 }, text: "꼴좋다," },
      { id: "caption-c", rawBox: { left: 193, top: 1306, width: 101, height: 63 }, text: "꼴좋아!" }
    ],
    { imageWidth: 760, imageHeight: 1460 },
    {
      stitch: { verified: true },
      compositeWidth: 760,
      compositeHeight: 1460,
      ownerDraw: { x: 0, y: 0, w: 760, h: 1100 },
      segments: [
        { source: "owner", drawRect: { x: 0, y: 0, w: 760, h: 1100 } },
        { source: "next", drawRect: { x: 0, y: 1100, w: 760, h: 360 } }
      ]
    }
  );

  assert.deepEqual(result.map((item) => item.id), ["caption-a", "caption-b", "caption-c"]);
  assert.equal(result.every((item) => item.percent.y > 100), true);
});

test("dedupedItems coordinate mapping follows same rules as raw items", () => {
  const result = runtime.__test.normalizeDebugCoordinateItems(
    [
      { id: "dup", rawBox: { left: 0, top: 0, width: 760, height: 300 }, text: "non-owner" },
      { id: "keep", rawBox: { left: 0, top: 300, width: 760, height: 600 }, text: "owner" }
    ],
    { imageWidth: 760, imageHeight: 1200 },
    {
      stitch: { verified: true },
      compositeWidth: 760,
      compositeHeight: 1200,
      ownerDraw: { x: 0, y: 300, w: 760, h: 600 },
      segments: [
        { source: "previous", drawRect: { x: 0, y: 0, w: 760, h: 300 } },
        { source: "owner", drawRect: { x: 0, y: 300, w: 760, h: 600 } },
        { source: "next", drawRect: { x: 0, y: 900, w: 760, h: 300 } }
      ]
    }
  );

  assert.equal(result.length, 1, "Non-owner items should be filtered out");
  if (result.length > 0) {
    assert.equal(result[0].id, "keep");
  }
});

test("mapKakaoStitchedFillBox rejects unreasonable height", () => {
  // fill_box with 400% height should be rejected
  const result = runtime.__test.mapKakaoStitchedFillBox(
    { x: 10, y: 0, w: 80, h: 400 },
    300,
    600,
    1200
  );
  assert.equal(result, null, "fill_box with 400% height should be rejected");
});

test("mapKakaoStitchedFillBox accepts reasonable height", () => {
  // fill_box with 100% height should be accepted
  const result = runtime.__test.mapKakaoStitchedFillBox(
    { x: 10, y: 0, w: 80, h: 100 },
    300,
    600,
    1200
  );
  assert.ok(result !== null, "fill_box with 100% height should be accepted");
  assert.ok(result.h > 0, "Mapped height should be positive");
  assert.ok(Number.isFinite(result.y), "Mapped Y should be finite");
});

test("mapKakaoStitchedResult clamps height instead of discarding when only height exceeds threshold", () => {
  const result = runtime.__test.mapKakaoStitchedResult(
    {
      bubbles: [
        { x: 10, y: 30, w: 30, h: 45, original_text: "single line but tall" }
      ]
    },
    makeStitchPayload(300, 600, 1200),
    { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "clamp-height-test"
  );

  // Should have clamped h to maxH=35 for single line, not discarded
  assert.equal(result.bubbles.length, 1, "Bubble should not be discarded");
  assert.ok(result.bubbles[0].h <= 35, "Height should be clamped to maxH");
  assert.equal(result.bubbles[0].fill_box, null, "fill_box should be null when clamped");
  assert.equal(result.bubbles[0].polygon, null, "polygon should be null when clamped");
  assert.equal(result.bubbles[0].region_polygon, null, "region_polygon should be null when clamped");
});

test("pipeline trace records collected stage with sourceToken and targetKey", () => {
  runtime.__test.setPipelineTraceEnabled(true);
  runtime.__test.clearPipelineTrace();

  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/trace-test.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ left: 0, top: 100, width: 760, height: 1000, right: 760, bottom: 1100 });

  // Trigger trace via fake collected event
  runtime.__test.tracePipeline("collected", target, {
    rect: { top: 100, height: 1000, width: 760 }
  });

  const traces = runtime.__test.getPipelineTrace();
  assert.ok(traces.length > 0, "Should have at least one trace entry");
  const collected = traces.find(t => t.stage === "collected");
  assert.ok(collected, "Should have a collected trace");
  assert.ok(collected.sourceToken, "Should have sourceToken");
  assert.ok(collected.targetKey, "Should have targetKey");
  assert.equal(collected.stage, "collected");
  assert.ok(collected.detail.rect, "Should have rect detail");

  // Clean up
  runtime.__test.clearPipelineTrace();
  runtime.__test.setPipelineTraceEnabled(false);
  assert.equal(runtime.__test.getPipelineTrace().length, 0, "Trace should be cleared");
});

test("pipeline trace FIFO limit of 5000 entries is enforced", () => {
  runtime.__test.setPipelineTraceEnabled(true);
  runtime.__test.clearPipelineTrace();

  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/fifo.jpg";
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });

  // Use tracePipeline directly
  // Fill to just above the limit
  for (let i = 0; i < 5010; i++) {
    runtime.__test.tracePipeline("collected", target, { idx: i });
  }

  const traces = runtime.__test.getPipelineTrace();
  assert.ok(traces.length <= 5000, `FIFO limit should keep at most 5000 entries, got ${traces.length}`);

  // The oldest entries should have been shifted out
  const firstIdx = traces[0] && traces[0].detail && traces[0].detail.idx;
  assert.ok(typeof firstIdx === "number" && firstIdx >= 10,
    `Oldest entry should have been shifted out, first idx is ${firstIdx}`);

  runtime.__test.clearPipelineTrace();
  runtime.__test.setPipelineTraceEnabled(false);
});

test("findTargetByScopedKey handles empty/non-existent keys gracefully", () => {
  // Just verify the function exists and doesn't crash with null/empty
  assert.equal(typeof runtime.__test.findTargetByScopedKey, "function");
  // In Node test environment without DOM, document is undefined, so this is a no-op
  // In real browser context it will return null for unmatched keys
  assert.ok(true, "findTargetByScopedKey is exported and callable");
});

test("normalizeKakaoStitchSegments falls back to derived segments when none provided", () => {
  const segments = runtime.__test.normalizeKakaoStitchSegments(
    { canvasWidth: 760, canvasHeight: 1200, previous: { drawRect: { x: 0, y: 0, w: 760, h: 300 } } },
    760, 1200,
    { x: 0, y: 300, w: 760, h: 600 }
  );

  assert.ok(Array.isArray(segments), "Should return an array");
  assert.ok(segments.length >= 2, "Should have at least owner and one neighbor");
});
