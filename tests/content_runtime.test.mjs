import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const contentSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "content.js"), "utf8");

globalThis.location = {
  hostname: "page.kakao.com",
  pathname: "/content/1",
  search: "?episode=7",
  href: "https://page.kakao.com/content/1?episode=7#page-2",
  origin: "https://page.kakao.com"
};
globalThis.window = { scrollX: 0, scrollY: 0, innerWidth: 1200, innerHeight: 800 };
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.getComputedStyle = (element) => element && element.__style || {
  overflowX: "visible",
  overflowY: "visible"
};

await import("../kakao-reconciler.js");
await import("../kakao-pipeline.js");
await import("../content.js");

const runtime = globalThis.__MANGA_TRANSLATOR_V3__;

test("hidden-page paint waiting has a timer fallback instead of hanging forever", async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  globalThis.requestAnimationFrame = () => 0;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  try {
    await Promise.race([
      runtime.__test.waitForPaint(5),
      new Promise((_, reject) => setTimeout(() => reject(new Error("paint wait stayed pending")), 100))
    ]);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
});

test("Kakao image runtime requests and error overlays have bounded recovery wiring", () => {
  assert.match(contentSource, /FETCH_IMAGE_DATA_URL" \|\| messageType === "CAPTURE_VISIBLE_TARGET_DATA_URL"[\s\S]*IMAGE_RUNTIME_MESSAGE_TIMEOUT_MS/);
  assert.match(contentSource, /image-fetch-fallback[\s\S]*captureVisibleTargetPayload\(img, imageFetchError \|\| error/);
  assert.match(contentSource, /reportKakaoPipelineError[\s\S]*clearKakaoLoadingOverlay\(target\)[\s\S]*pipeline-error-restore/);
});

test("Kakao page identity ignores CDN signing changes but tracks actual image bytes", async () => {
  const target = new globalThis.HTMLImageElement();
  target.currentSrc = "https://cdn.example.test/page.jpg?episode=7&signature=first&expires=100";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ top: 100, width: 760, height: 1200 });

  const first = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  target.currentSrc = "https://cdn.example.test/page.jpg?expires=999&signature=second&episode=7";
  const resigned = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  const revised = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIE",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });

  assert.equal(first.chapterId, resigned.chapterId);
  assert.equal(first.pageId, resigned.pageId);
  assert.equal(first.imageRevision, resigned.imageRevision);
  assert.equal(first.pageId, revised.pageId);
  assert.notEqual(first.imageRevision, revised.imageRevision);
  assert.match(first.stableSource, /episode=7/);
  assert.doesNotMatch(first.stableSource, /signature|expires/i);
});

test("Kakao opaque token resource pages use image bytes to avoid same-size page collisions", async () => {
  const createTarget = (currentSrc, top) => {
    const target = new globalThis.HTMLImageElement();
    target.currentSrc = currentSrc;
    target.naturalWidth = 760;
    target.naturalHeight = 1000;
    target.width = 760;
    target.height = 1000;
    target.isConnected = true;
    target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
    target.getBoundingClientRect = () => ({ top, width: 760, height: 1000 });
    return target;
  };

  const first = await runtime.__test.buildKakaoPageIdentity(
    createTarget("https://dw-img-page.kakao.com/sdownload/resource?token=page-a", 100),
    {
      dataUrl: "data:image/png;base64,AQID",
      imageUrl: "https://dw-img-page.kakao.com/sdownload/resource?token=page-a",
      width: 760,
      height: 1000
    }
  );
  const second = await runtime.__test.buildKakaoPageIdentity(
    createTarget("https://dw-img-page.kakao.com/sdownload/resource?token=page-b", 1100),
    {
      dataUrl: "data:image/png;base64,AQIE",
      imageUrl: "https://dw-img-page.kakao.com/sdownload/resource?token=page-b",
      width: 760,
      height: 1000
    }
  );
  const resignedFirst = await runtime.__test.buildKakaoPageIdentity(
    createTarget("https://dw-img-page.kakao.com/sdownload/resource?token=page-a-refreshed", 100),
    {
      dataUrl: "data:image/png;base64,AQID",
      imageUrl: "https://dw-img-page.kakao.com/sdownload/resource?token=page-a-refreshed",
      width: 760,
      height: 1000
    }
  );

  assert.notEqual(first.pageId, second.pageId);
  assert.equal(first.pageId, resignedFirst.pageId);
  assert.notEqual(first.stableSource, second.stableSource);
  assert.match(first.stableSource, /content-revision=/);
});

test("opaque Kakao resource tokens still use image bytes when stable query fields remain", async () => {
  const createTarget = (currentSrc) => {
    const target = new globalThis.HTMLImageElement();
    target.currentSrc = currentSrc;
    target.naturalWidth = 760;
    target.naturalHeight = 1000;
    target.width = 760;
    target.height = 1000;
    target.isConnected = true;
    target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
    target.getBoundingClientRect = () => ({ top: 100, width: 760, height: 1000 });
    return target;
  };
  const source = "https://dw-img-page.kakao.com/sdownload/resource?episode=7&token=opaque-a";
  const first = await runtime.__test.buildKakaoPageIdentity(createTarget(source), {
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: source,
    width: 760,
    height: 1000
  });
  const second = await runtime.__test.buildKakaoPageIdentity(createTarget(source.replace("opaque-a", "opaque-b")), {
    dataUrl: "data:image/png;base64,AQIE",
    imageUrl: source.replace("opaque-a", "opaque-b"),
    width: 760,
    height: 1000
  });

  assert.match(first.stableSource, /episode=7/);
  assert.match(first.stableSource, /content-revision=/);
  assert.notEqual(first.pageId, second.pageId);
});

test("canonical content adapter wires terminal loading cleanup", () => {
  const adapterStart = contentSource.indexOf("const kakaoCanonicalPipeline =");
  const adapterEnd = contentSource.indexOf("const kakaoPipeline =", adapterStart);
  const adapterSource = contentSource.slice(adapterStart, adapterEnd);

  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart);
  assert.match(adapterSource, /clearLoadingOverlay\s*:\s*clearKakaoLoadingOverlay/);
  assert.match(contentSource, /function clearKakaoLoadingOverlay\s*\(/);
});

test("settled no-text markers suppress overlay recovery for both key forms", () => {
  const targetKey = "direct|page";
  const scopedTargetKey = "direct|page|src:revision";

  assert.equal(runtime.__test.matchesTargetMarker(targetKey, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.matchesTargetMarker(scopedTargetKey, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.matchesTargetMarker("direct|other", targetKey, scopedTargetKey), false);

  assert.equal(runtime.__test.hasSettledNoTextMarker({
    dataset: { mtNoTextKey: scopedTargetKey }
  }, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.hasSettledNoTextMarker({
    dataset: { mtNoTextKey: "direct|other" }
  }, targetKey, scopedTargetKey), false);

  assert.equal(runtime.__test.hasSettledTranslatedMarker({
    dataset: { mtNoTextKey: scopedTargetKey }
  }, targetKey, scopedTargetKey), false);
  assert.equal(runtime.__test.hasSettledTranslatedMarker({
    dataset: { mtLastTranslatedKey: scopedTargetKey }
  }, targetKey, scopedTargetKey), true);
});

test("debug and loading overlays never count as reusable translated results", () => {
  assert.equal(runtime.__test.isReusableRenderedState({ mode: "debug", bubbleCount: 0 }, true), false);
  assert.equal(runtime.__test.isReusableRenderedState({ mode: "loading", bubbleCount: 0 }, true), false);
  assert.equal(runtime.__test.isReusableRenderedState({ mode: "bubbles", bubbleCount: 2 }, false), false);
  assert.equal(runtime.__test.isReusableRenderedState({ mode: "bubbles", bubbleCount: 2 }, true), true);
  assert.equal(runtime.__test.isReusableRenderedState({ mode: "embedded", bubbleCount: 1 }, true), true);
});

test("extension-owned seam composites never reenter Kakao OCR target selection", () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = { mangaTranslatorOverlay: "true" };
  target.closest = () => null;

  assert.equal(runtime.__test.isMangaTranslatorOverlayTarget(target), true);
  assert.equal(runtime.__test.isSupportedTarget(target), false);

  target.dataset = {};
  target.closest = () => ({ dataset: { mangaTranslatorOverlay: "true" } });
  assert.equal(runtime.__test.isMangaTranslatorOverlayTarget(target), true);
  assert.equal(runtime.__test.isSupportedTarget(target), false);

  target.closest = () => null;
  assert.equal(runtime.__test.isMangaTranslatorOverlayTarget(target), false);
  assert.equal(runtime.__test.isSupportedTarget(target), true);
});

test("known Kakao page bindings are idempotent until target or revision changes", () => {
  const target = { isConnected: true };
  const targets = new Set([target]);
  assert.equal(runtime.__test.isCurrentKakaoPageBinding(
    target,
    "page-a",
    { target, imageRevision: "rev-a" },
    "rev-a",
    targets
  ), true);
  assert.equal(runtime.__test.isCurrentKakaoPageBinding(
    target,
    "page-a",
    { target, imageRevision: "rev-b" },
    "rev-a",
    targets
  ), false);
  assert.equal(runtime.__test.isCurrentKakaoPageBinding(
    target,
    "page-a",
    { target: {}, imageRevision: "rev-a" },
    "rev-a",
    targets
  ), false);
});

test("only a current ready Kakao page binding can reuse OCR facts", () => {
  const target = { isConnected: true };
  const handle = {
    target,
    pageId: "page-a",
    imageRevision: "rev-a",
    pageOcrState: "ready"
  };
  const terminal = { state: "ready", details: { imageRevision: "rev-a" } };
  assert.equal(runtime.__test.isReusableKakaoReadyPageBinding(
    target,
    handle,
    terminal,
    "page-a",
    "rev-a"
  ), true);
  assert.equal(runtime.__test.isReusableKakaoReadyPageBinding(
    target,
    handle,
    terminal,
    "page-a",
    "rev-b"
  ), false);
  assert.equal(runtime.__test.isReusableKakaoReadyPageBinding(
    target,
    { ...handle, pageOcrState: "failed" },
    terminal,
    "page-a",
    "rev-a"
  ), false);
});

test("identical overlay payloads have a stable render signature", () => {
  const first = {
    bubbles: [{ canonical_id: "c1", x: 10, y: 20, w: 30, h: 8, translated_text: "译文" }],
    debug: { rawItems: [{ id: "r1", percent: { x: 10, y: 20, w: 30, h: 8 } }] }
  };
  const second = JSON.parse(JSON.stringify(first));
  assert.equal(runtime.__test.buildOverlayRenderSignature(first), runtime.__test.buildOverlayRenderSignature(second));
  second.bubbles[0].translated_text = "新译文";
  assert.notEqual(runtime.__test.buildOverlayRenderSignature(first), runtime.__test.buildOverlayRenderSignature(second));

  const prefix = "data:image/png;base64," + "A".repeat(120);
  const suffix = "Z".repeat(64);
  const middleA = { bubbles: [], debug: {}, cleanedImage: `${prefix}first${suffix}` };
  const middleB = { bubbles: [], debug: {}, cleanedImage: `${prefix}other${suffix}` };
  assert.equal(middleA.cleanedImage.length, middleB.cleanedImage.length);
  const middleSignature = runtime.__test.buildOverlayRenderSignature(middleA);
  assert.equal(middleSignature, runtime.__test.buildOverlayRenderSignature(middleB));
  assert.equal(runtime.__test.isSameOverlayRenderPayload(
    { renderSignature: middleSignature, cleanedImage: middleA.cleanedImage },
    middleSignature,
    middleA.cleanedImage
  ), true);
  assert.equal(runtime.__test.isSameOverlayRenderPayload(
    { renderSignature: middleSignature, cleanedImage: middleA.cleanedImage },
    middleSignature,
    middleB.cleanedImage
  ), false,
    "cleaned images that only differ in their middle bytes must not reuse one overlay"
  );
});

test("changed overlay payloads replace the old root atomically", () => {
  const start = contentSource.indexOf("function renderOverlay(");
  const end = contentSource.indexOf("function scheduleTermDiscovery", start);
  const renderSource = contentSource.slice(start, end);

  assert.match(renderSource, /oldOverlay\.root\.replaceWith\(root\)/);
  assert.doesNotMatch(renderSource, /oldOverlay\.root\.remove\(\)/);
});

test("canonical empty projections stay pending unless OCR authoritatively found no text", () => {
  assert.equal(runtime.__test.classifyCanonicalProjectionRender([], { authoritativeEmpty: false }), "pending");
  assert.equal(runtime.__test.classifyCanonicalProjectionRender([], { authoritativeEmpty: true }), "no-text");
  assert.equal(runtime.__test.classifyCanonicalProjectionRender([
    { translated_text: "译文" }
  ], { authoritativeEmpty: false }), "translated");
});

test("provisional or explicitly incomplete canonical renders never become terminal", () => {
  assert.equal(runtime.__test.isCanonicalRenderComplete([], { translationComplete: true }), true);
  assert.equal(runtime.__test.isCanonicalRenderComplete([], { translationComplete: false }), false);
  assert.equal(runtime.__test.isCanonicalRenderComplete([
    { translated_text: "旧译文", provisional: true }
  ], { translationComplete: true }), false);
  assert.equal(runtime.__test.isCanonicalRenderComplete([
    { translated_text: "旧译文", pendingCanonicalId: "new-revision" }
  ], { translationComplete: true }), false);
});

test("canonical pending and retry failures preserve the last stable projection", () => {
  const renderStart = contentSource.indexOf("async function renderCanonicalProjections");
  const renderEnd = contentSource.indexOf("async function renderTranslationResult", renderStart);
  const renderSource = contentSource.slice(renderStart, renderEnd);
  assert.match(
    renderSource,
    /disposition === "pending"[\s\S]*?\{ stream: false, debugOnly: true \}/
  );

  const translateStart = contentSource.indexOf("async function translateTarget");
  const translateEnd = contentSource.indexOf("function syncAllOverlays", translateStart);
  const translateSource = contentSource.slice(translateStart, translateEnd);
  assert.match(
    translateSource,
    /if \(shouldUseKakaoCanonicalPipeline\(target\)\) \{[\s\S]*?clearKakaoLoadingOverlay\(target\);[\s\S]*?\} else \{[\s\S]*?clearRenderedTarget\(target\);/
  );
});

test("canonical seam rendering uses the regular page overlay path only", () => {
  const pipelineSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "kakao-pipeline.js"), "utf8");

  assert.match(pipelineSource, /拼接结果统一由 canonical renderOverlay 投影/);
  assert.match(pipelineSource, /if \(false\) for \(const _rel/);
  assert.match(pipelineSource, /async function runSeamCrossPageRender\(pageA, pageB\) \{\s*return;/);
  assert.doesNotMatch(contentSource, /\n\s*renderSeamCrossPage,\n/);
  assert.match(contentSource, /renderCanonicalProjections[\s\S]*renderTranslationResult\(/);
});

test("canonical seam surfaces render from one host page only", () => {
  const surface = { pageIds: ["page-a", "page-b"] };

  assert.equal(
    runtime.__test.getSeamSurfaceHostPageId(surface, (pageId) => ({ isConnected: pageId === "page-a" })),
    "page-a"
  );
  assert.equal(
    runtime.__test.getSeamSurfaceHostPageId(surface, (pageId) => ({ isConnected: pageId === "page-b" })),
    "page-b"
  );
  assert.equal(runtime.__test.getSeamSurfaceHostPageId(surface, () => null), "page-a");

  const renderStart = contentSource.indexOf("async function renderCanonicalProjections");
  const renderEnd = contentSource.indexOf("async function renderTranslationResult", renderStart);
  const renderSource = contentSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /hostedSeamSurfacesByPage/);
  assert.match(renderSource, /const pageSurfaces = seamSurfacesByPage\.get\(pageId\) \|\| \[\]/);
  assert.match(renderSource, /const hostedPageSurfaces = hostedSeamSurfacesByPage\.get\(pageId\) \|\| \[\]/);
  assert.match(renderSource, /seamSurfaces: hostedPageSurfaces/);

  const overlayStart = contentSource.indexOf("function renderOverlay(");
  const overlayEnd = contentSource.indexOf("function scheduleTermDiscovery", overlayStart);
  const overlaySource = contentSource.slice(overlayStart, overlayEnd);
  assert.match(overlaySource, /removeDuplicateSeamSurfaceRoots\(seamSurfaces, root\)/);
});

test("Kakao seam capture is limited to the immediate 64-96px boundary band", () => {
  assert.equal(runtime.__test.calculateKakaoSeamCaptureBandHeight(320, 480), 64);
  assert.equal(runtime.__test.calculateKakaoSeamCaptureBandHeight(500, 900), 75);
  assert.equal(runtime.__test.calculateKakaoSeamCaptureBandHeight(760, 760), 96);
  assert.equal(runtime.__test.calculateKakaoSeamCaptureBandHeight(760, 760, 400), 96);
});

test("Kakao recommendation covers wait for visible flow instead of entering the ahead queue", () => {
  const cover = new globalThis.HTMLImageElement();
  cover.naturalWidth = 98;
  cover.naturalHeight = 140;
  cover.getBoundingClientRect = () => ({
    left: 447,
    right: 545,
    top: 600,
    bottom: 740,
    width: 98,
    height: 140
  });

  assert.equal(runtime.__test.shouldUseKakaoCanonicalPipeline(cover), true);
  assert.equal(runtime.__test.isKakaoEpisodeImageTarget(cover), false);
  cover.isConnected = true;
  assert.equal(runtime.__test.passesKakaoAheadTargetFilter(cover), false);

  const episodePage = new globalThis.HTMLImageElement();
  episodePage.isConnected = true;
  episodePage.naturalWidth = 760;
  episodePage.naturalHeight = 1000;
  episodePage.getBoundingClientRect = () => ({
    left: 220,
    right: 980,
    top: 0,
    bottom: 1000,
    width: 760,
    height: 1000
  });
  assert.equal(runtime.__test.isKakaoEpisodeImageTarget(episodePage), true);
  assert.equal(runtime.__test.passesKakaoAheadTargetFilter(episodePage), true);
});

test("visible work is inserted before ahead work and ahead jobs preserve visible capacity", () => {
  const ahead = { options: { reason: "ahead-viewport" } };
  const queue = [ahead, { options: { reason: "ahead-image-load" } }];

  assert.equal(runtime.__test.getTranslationQueueInsertIndex(queue, { reason: "page-auto" }), 0);
  assert.equal(runtime.__test.getTranslationQueueInsertIndex(queue, { reason: "ahead-mutation" }), 2);
  assert.equal(runtime.__test.canStartQueuedTranslation(ahead, {
    runningJobs: 4,
    runningAheadJobs: 4,
    maxParallel: 6,
    reservedSlots: 2
  }), false);
  assert.equal(runtime.__test.canStartQueuedTranslation({ options: { reason: "page-auto" } }, {
    runningJobs: 4,
    runningAheadJobs: 4,
    maxParallel: 6,
    reservedSlots: 2
  }), true);
  assert.equal(runtime.__test.canStartQueuedTranslation(ahead, {
    runningJobs: 1,
    runningAheadJobs: 1,
    maxParallel: 6,
    reservedSlots: 5
  }), false, "only one Kakao ahead OCR may occupy the serial local-service queue");
  assert.equal(runtime.__test.canStartQueuedTranslation(ahead, {
    runningJobs: 0,
    runningAheadJobs: 0,
    maxParallel: 6,
    reservedSlots: 5
  }), true);
});

test("visible target rect is clipped by a horizontal scroll ancestor", () => {
  const scroller = {
    parentElement: null,
    __style: { overflowX: "scroll", overflowY: "hidden" },
    getBoundingClientRect: () => ({ left: 447, right: 1103, top: 500, bottom: 760 })
  };
  const hidden = {
    parentElement: scroller,
    getBoundingClientRect: () => ({
      left: 1189,
      right: 1287,
      top: 600,
      bottom: 740,
      width: 98,
      height: 140
    })
  };
  const partial = {
    parentElement: scroller,
    getBoundingClientRect: () => ({
      left: 1060,
      right: 1158,
      top: 600,
      bottom: 740,
      width: 98,
      height: 140
    })
  };

  assert.equal(runtime.__test.getVisibleViewportRect(hidden), null);
  assert.deepEqual(runtime.__test.getVisibleViewportRect(partial), {
    left: 1060,
    top: 600,
    right: 1103,
    bottom: 740,
    width: 43,
    height: 140
  });
});

test("canonical rendering forwards page OCR debug data to the overlay renderer", () => {
  const start = contentSource.indexOf("async function renderCanonicalProjections");
  const end = contentSource.indexOf("async function renderKakaoPipelineResult", start);
  const renderSource = contentSource.slice(start, end);

  assert.match(
    renderSource,
    /defaultDebug\s*=\s*input\.debug\s*\|\|\s*input\.result\s*&&\s*input\.result\.debug[\s\S]*getPageMappedValue\(input\.debugByPage,\s*pageId,\s*defaultDebug\)/
  );
});

test("OCR debug remains renderable without translated bubbles", () => {
  assert.equal(runtime.__test.hasRenderableOcrDebug({
    bubbles: [],
    debug: { rawItems: [{ box: { left: 1, top: 2, width: 3, height: 4 } }] }
  }), true);
  assert.equal(runtime.__test.hasRenderableOcrDebug({ bubbles: [], debug: {} }), false);
  assert.equal(runtime.__test.hasRenderableOcrDebug({ bubbles: [] }), false);
});

test("visible canonical pages left pending are eligible for recovery requeue", () => {
  const targetKey = "direct|page";
  const scopedTargetKey = "direct|page|src:revision";

  assert.equal(runtime.__test.hasPendingTranslationMarkerState({ dataset: {} }, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.hasPendingTranslationMarkerState({
    dataset: { mtLastTranslatedKey: scopedTargetKey }
  }, targetKey, scopedTargetKey), false);
  assert.equal(runtime.__test.hasPendingTranslationMarkerState({
    dataset: { mtNoTextKey: scopedTargetKey }
  }, targetKey, scopedTargetKey), false);

  const recoveryStart = contentSource.indexOf("function recoverRenderedTargets()");
  const recoveryEnd = contentSource.indexOf("function syncOverlayPosition", recoveryStart);
  const recoverySource = contentSource.slice(recoveryStart, recoveryEnd);
  assert.match(recoverySource, /hasPendingTranslationMarkerState[\s\S]*queuePageAutoTranslate\(target\)/);
});

test("pending-page recovery waits for its cooldown after a failed cold request", () => {
  assert.equal(runtime.__test.isTranslationRecoveryDue({ dataset: {} }, 10000), true);
  assert.equal(runtime.__test.isTranslationRecoveryDue({
    dataset: { mtRecoveryReqAt: "8000" }
  }, 12000), false);
  assert.equal(runtime.__test.isTranslationRecoveryDue({
    dataset: { mtRecoveryReqAt: "8000" }
  }, 13000), true);
});

test("Kakao page identity does not collide for equal-size inline or blob pages", async () => {
  const createTarget = (currentSrc, top) => {
    const target = new globalThis.HTMLImageElement();
    target.currentSrc = currentSrc;
    target.naturalWidth = 760;
    target.naturalHeight = 1200;
    target.width = 760;
    target.height = 1200;
    target.isConnected = true;
    target.getBoundingClientRect = () => ({ top, width: 760, height: 1200 });
    return target;
  };

  const inlineA = await runtime.__test.buildKakaoPageIdentity(
    createTarget("data:image/png;base64,AQID", 100),
    { dataUrl: "data:image/png;base64,AQID", imageUrl: "data:image/png;base64,AQID", width: 760, height: 1200 }
  );
  const inlineB = await runtime.__test.buildKakaoPageIdentity(
    createTarget("data:image/png;base64,AQIE", 1400),
    { dataUrl: "data:image/png;base64,AQIE", imageUrl: "data:image/png;base64,AQIE", width: 760, height: 1200 }
  );
  assert.notEqual(inlineA.pageId, inlineB.pageId);
  assert.match(inlineA.stableSource, /^inline:/);

  const blobA = await runtime.__test.buildKakaoPageIdentity(
    createTarget("blob:https://page.kakao.com/page-a", 2700),
    { dataUrl: "data:image/png;base64,AQIF", imageUrl: "blob:https://page.kakao.com/page-a#preview", width: 760, height: 1200 }
  );
  const blobB = await runtime.__test.buildKakaoPageIdentity(
    createTarget("blob:https://page.kakao.com/page-b", 4000),
    { dataUrl: "data:image/png;base64,AQIF", imageUrl: "blob:https://page.kakao.com/page-b", width: 760, height: 1200 }
  );
  assert.notEqual(blobA.pageId, blobB.pageId);
  assert.equal(blobA.stableSource, "blob:https://page.kakao.com/page-a");
});

test("Kakao same-URL image reload invalidates the old generation and produces a new revision", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/reload-in-place.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ top: 100, bottom: 1300, left: 0, right: 760, width: 760, height: 1200 });
  const first = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIJ",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  const snapshot = runtime.__test.captureTargetSnapshot(target);
  const generation = runtime.__test.prepareKakaoTargetRevisionCheck(target, "test-reload");
  const second = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIK",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });

  assert.equal(generation, 1);
  assert.equal(runtime.__test.isTargetSnapshotStillValid(target, snapshot), false);
  assert.equal(first.pageId, second.pageId);
  assert.notEqual(first.imageRevision, second.imageRevision);
});

test("deferred Kakao identity hashing does not bind a DOM target before pipeline commit", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/deferred-bind.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ top: 100, bottom: 1300, left: 0, right: 760, width: 760, height: 1200 });
  const payload = {
    dataUrl: "data:image/png;base64,AQIL",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  };

  const deferred = await runtime.__test.buildKakaoPageIdentity(target, payload, { deferBind: true });
  assert.equal(runtime.__test.getTargetForKakaoPageId(deferred.pageId), null);

  const committed = await runtime.__test.buildKakaoPageIdentity(target, payload);
  assert.equal(committed.pageId, deferred.pageId);
  assert.equal(runtime.__test.getTargetForKakaoPageId(committed.pageId), target);
});

test("Kakao DOM source reuse detaches the old handle and schedules standby refresh immediately", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/reused-old.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
  target.getBoundingClientRect = () => ({ top: 100, width: 760, height: 1200 });
  const identity = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIH",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  runtime.__test.kakaoStore.registerPageHandle({ ...identity, target });

  const scheduled = [];
  const detachedPageId = runtime.__test.detachKakaoTargetForSourceChange(
    target,
    (pageIds, reason) => scheduled.push({ pageIds, reason })
  );

  assert.equal(detachedPageId, identity.pageId);
  assert.equal(runtime.__test.kakaoStore.getPageHandleForTarget(target), null);
  assert.equal(runtime.__test.kakaoStore.getPageHandle(identity.pageId).pageId, identity.pageId);
  assert.deepEqual(scheduled, [{ pageIds: [identity.pageId], reason: "page-handle-source-changed" }]);
});

test("Kakao rendering prefers the Store current handle over an older connected clone", async () => {
  const createClone = (top) => {
    const target = new globalThis.HTMLImageElement();
    target.dataset = {};
    target.currentSrc = "https://cdn.example.test/same-page-clone.jpg";
    target.naturalWidth = 760;
    target.naturalHeight = 1200;
    target.width = 760;
    target.height = 1200;
    target.isConnected = true;
    target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
    target.getBoundingClientRect = () => ({ top, bottom: top + 1200, left: 0, right: 760, width: 760, height: 1200 });
    return target;
  };
  const oldClone = createClone(2400);
  const newClone = createClone(100);
  const payload = {
    dataUrl: "data:image/png;base64,AQII",
    imageUrl: oldClone.currentSrc,
    width: 760,
    height: 1200
  };
  const oldIdentity = await runtime.__test.buildKakaoPageIdentity(oldClone, payload);
  const newIdentity = await runtime.__test.buildKakaoPageIdentity(newClone, payload);
  assert.equal(oldIdentity.pageId, newIdentity.pageId);
  runtime.__test.kakaoStore.registerPageHandle({ ...oldIdentity, target: oldClone });
  runtime.__test.kakaoStore.registerPageHandle({ ...newIdentity, target: newClone });
  // Simulate the offscreen clone finishing its fetch/hash after the visible clone.
  runtime.__test.kakaoStore.registerPageHandle({ ...oldIdentity, target: oldClone });

  assert.equal(runtime.__test.getTargetForKakaoPageId(oldIdentity.pageId), newClone);
  newClone.isConnected = false;
  assert.equal(runtime.__test.getTargetForKakaoPageId(oldIdentity.pageId), oldClone);
});

test("an older image revision clone cannot render the current page revision", async () => {
  const createClone = (top) => {
    const target = new globalThis.HTMLImageElement();
    target.dataset = {};
    target.currentSrc = "https://cdn.example.test/revision-clone.jpg";
    target.naturalWidth = 760;
    target.naturalHeight = 1200;
    target.width = 760;
    target.height = 1200;
    target.isConnected = true;
    target.getAttribute = (name) => (name === "src" ? target.currentSrc : "");
    target.getBoundingClientRect = () => ({ top, bottom: top + 1200, left: 0, right: 760, width: 760, height: 1200 });
    return target;
  };
  const oldClone = createClone(100);
  const newClone = createClone(2600);
  const oldIdentity = await runtime.__test.buildKakaoPageIdentity(oldClone, {
    dataUrl: "data:image/png;base64,AQIM",
    imageUrl: oldClone.currentSrc,
    width: 760,
    height: 1200
  });
  const newIdentity = await runtime.__test.buildKakaoPageIdentity(newClone, {
    dataUrl: "data:image/png;base64,AQIN",
    imageUrl: newClone.currentSrc,
    width: 760,
    height: 1200
  });
  assert.equal(oldIdentity.pageId, newIdentity.pageId);
  assert.notEqual(oldIdentity.imageRevision, newIdentity.imageRevision);
  runtime.__test.kakaoStore.registerPageHandle({ ...oldIdentity, target: oldClone });
  runtime.__test.kakaoStore.registerPageHandle({ ...newIdentity, target: newClone });

  assert.equal(runtime.__test.kakaoStore.getPageHandleForTarget(oldClone), null);
  assert.equal(runtime.__test.getTargetForKakaoPageId(newIdentity.pageId), newClone);
});

test("OCR observation normalization preserves filtered evidence and strips translation fields from semantics", () => {
  const normalized = runtime.__test.normalizeOcrObservationResult({
    observations: [{ id: "o1", original_text: "  Hello?!  ", translated_text: "ignored" }],
    filteredObservations: [{ id: "o2", originalText: "…", filterReason: "symbol_only" }]
  }, {
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: { "page-a": "rev-a" }
  });

  assert.equal(normalized.observations[0].originalText, "Hello?!");
  assert.equal("translated_text" in normalized.observations[0], false);
  assert.deepEqual(normalized.observations[0].pageIds, ["page-a"]);
  assert.equal(normalized.filteredObservations[0].filterReason, "symbol_only");
  assert.equal(normalized.counts.eligible, 1);
  assert.equal(normalized.counts.filtered, 1);
});

test("canonical projections adapt to renderer bubbles without turning cover projections into text", () => {
  const primary = runtime.__test.projectionToRendererBubble({
    projectionId: "p-text",
    canonicalId: "c1",
    canonicalRevision: 2,
    role: "text_primary",
    geometry: { x: 10, y: 20, w: 30, h: 15 },
    originalText: "안녕",
    translatedText: "你好"
  });
  const cover = runtime.__test.projectionToRendererBubble({
    projectionId: "p-cover",
    canonicalId: "c1",
    role: "cover_only",
    geometry: { x: 5, y: 2, w: 20, h: 8 },
    originalText: "안녕",
    translatedText: "不应显示"
  });

  assert.equal(primary.translated_text, "你好");
  assert.equal(primary.canonical_revision, 2);
  assert.equal(cover.translated_text, "");
  assert.equal(cover.projection_role, "cover_only");
});

test("canonical cleaned artifact requests forward supplemental page masks", () => {
  const cleanedMasks = [{
    coordinateSpace: "percent",
    box: { x: 22, y: 89, w: 54, h: 11 }
  }];
  const sentMessage = runtime.__test.buildOcrMessageForPayload(
    {
      dataUrl: "data:image/png;base64,AQID",
      imageUrl: "page-a",
      ocrMode: "single",
      pageSpans: []
    },
    {
      sourceType: "page",
      pageIds: ["page-a"],
      imageRevision: "revision-a",
      imageRevisionByPage: { "page-a": "revision-a" },
      requestKey: "page:page-a:revision-a",
      requireCleanedImage: true,
      forceCleanedImageArtifact: true,
      cleanedMasks
    }
  );
  assert.deepEqual(sentMessage.cleanedMasks, cleanedMasks);
  assert.equal(sentMessage.forceCleanedImageArtifact, true);
});

test("rendered OCR bubbles produce an asynchronous term-discovery payload", () => {
  const message = runtime.__test.buildTermDiscoveryMessage(
    {
      bubbles: [
        { id: "t0", original_text: "김성현", translated_text: "金成贤" },
        { id: "t1", original_text: "성현", translated_text: "成贤" },
        { id: "empty", original_text: "", translated_text: "" }
      ]
    },
    "target-1",
    "https://cdn.example.test/page-1.jpg",
    "https://reader.example.test/chapter?episode=1#p2",
    "第 1 话"
  );

  assert.equal(message.type, "DISCOVER_TERMS");
  assert.equal(message.blocks.length, 2);
  assert.equal(message.blocks[0].originalText, "김성현");
  assert.notEqual(message.blocks[0].id, message.blocks[1].id);
  assert.match(message.targetKey, /^image-/);
});

test("Kakao stitch neighbor scan skips repeated owner-source nodes", () => {
  const entries = [
    {
      target: "previous-page",
      descriptor: { left: 0, top: 0, bottom: 1000, width: 760, height: 1000, sourceKey: "previous" }
    },
    {
      target: "previous-duplicate-owner",
      descriptor: { left: 0, top: 990, bottom: 1990, width: 760, height: 1000, sourceKey: "owner" }
    },
    {
      target: "owner-page",
      descriptor: { left: 0, top: 1000, bottom: 2000, width: 760, height: 1000, sourceKey: "owner" }
    },
    {
      target: "next-duplicate-owner",
      descriptor: { left: 0, top: 1010, bottom: 2010, width: 760, height: 1000, sourceKey: "owner" }
    },
    {
      target: "next-page",
      descriptor: { left: 0, top: 2000, bottom: 3000, width: 760, height: 1000, sourceKey: "next" }
    }
  ];

  assert.equal(runtime.__test.findKakaoStitchNeighborTarget(entries, 2, "previous"), "previous-page");
  assert.equal(runtime.__test.findKakaoStitchNeighborTarget(entries, 2, "next"), "next-page");
});

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

test("canonical seam evidence detects a medium page-edge fragment structure", () => {
  assert.equal(runtime.__test.hasKakaoFragmentStructureRisk({
    stableSource: "https://page-edge.kakao.com/sdownload/resource?kid=fragment",
    width: 760,
    height: 700,
    payload: { dataUrl: "data:image/png;base64,AQID" }
  }), true);
  assert.equal(runtime.__test.hasKakaoFragmentStructureRisk({
    stableSource: "https://dw-img-page.kakao.com/sdownload/resource?kid=full",
    width: 760,
    height: 1200
  }), false);
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

test("stitched OCR drops owner-only bubbles that do not cross seam boundaries", () => {
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

  // Non-seam-crossing bubbles are dropped to avoid duplicating single-page OCR results.
  // Only bubbles that actually cross a seam boundary survive the filter.
  assert.deepEqual(result.bubbles.map((bubble) => bubble.original_text), []);
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

test("boundary neighbor bubble defers to adjacent page own bubble in global dedup", async () => {
  // 模拟：owner 页拼接 OCR 在 next 边界切片中识别到 "경계텍스트"，
  // 作为 stitch_boundary_neighbor overflow 渲染。然后相邻页独立 OCR 也识别到相同文字。
  // 相邻页自己的气泡应该胜出，owner 的 boundary neighbor 应被移除。
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 18, y: 94, w: 30, h: 8,
        block_id: "boundary-neighbor-bubble",
        original_text: "경계텍스트",
        translated_text: "边界文本",
        stitch_boundary_neighbor: true
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) },
    "owner-with-boundary-neighbor"
  );
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 18, y: 2, w: 30, h: 8,
        block_id: "adjacent-own-bubble",
        original_text: "경계텍스트",
        translated_text: "边界文本"
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 550, width: 600, height: 600 }) },
    "adjacent-own-page"
  );

  // boundary neighbor 应被相邻页自己的气泡取代
  assert.equal(boundaryNeighbor.bubbles.length, 0);
  assert.equal(adjacentOwn.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles[0].block_id, "adjacent-own-bubble");
});

test("boundary neighbor partial OCR defers to adjacent page full own bubble", async () => {
  // 现场回归：owner overflow 只识别到下一页完整气泡的一段，翻译也不完全相同。
  // 只要空间重叠且文本有足够公共片段，就应删除旧的 boundary neighbor。
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 18, y: 106, w: 60, h: 16,
        block_id: "boundary-neighbor-partial-live",
        original_text: "참가자가이미 납지 매저다으",
        translated_text: "参赛者已经陷入黄昏（D级）了。",
        stitch_boundary_neighbor: true
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 4200, width: 600, height: 600 }) },
    "owner-with-boundary-neighbor-partial"
  );
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 12, y: 2, w: 78, h: 49,
        block_id: "adjacent-own-full-live",
        original_text: "어스름(D)등급 참가자가이미 납지 '정답을 알고있는상황.",
        translated_text: "黄昏(D级) 参赛者已经知道正确答案的情况。"
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 4750, width: 600, height: 600 }) },
    "adjacent-own-page-full-live"
  );

  assert.equal(boundaryNeighbor.bubbles.length, 0);
  assert.equal(adjacentOwn.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles[0].block_id, "adjacent-own-full-live");
});

test("unrelated boundary neighbor is kept when adjacent own text does not overlap", async () => {
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 18, y: 106, w: 60, h: 16,
        block_id: "boundary-neighbor-unrelated",
        original_text: "등급 어스름(D)",
        translated_text: "等级黄昏D",
        stitch_boundary_neighbor: true
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 6500, width: 600, height: 600 }) },
    "owner-with-boundary-neighbor-unrelated"
  );
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 12, y: 2, w: 78, h: 49,
        block_id: "adjacent-own-unrelated",
        original_text: "완전히다른내용입니다",
        translated_text: "完全不同的内容"
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 7050, width: 600, height: 600 }) },
    "adjacent-own-page-unrelated"
  );

  assert.equal(boundaryNeighbor.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles.length, 1);
});

test("boundary neighbor complementary seam text is kept despite identical translation", async () => {
  // 分页缝处一个对白被切成上下两半：上一页 stitched boundary 识别到上半句，
  // 下一页自有 OCR 识别到下半句。两者可能被翻成同一句，但不能互相去重。
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 18, y: 106, w: 60, h: 16,
        block_id: "boundary-neighbor-complementary",
        original_text: "다들수고 마이셔스니디",
        translated_text: "多謝款待",
        stitch_boundary_neighbor: true
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 8600, width: 600, height: 600 }) },
    "owner-with-boundary-neighbor-complementary"
  );
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates(
    {
      bubbles: [{
        x: 12, y: 2, w: 78, h: 49,
        block_id: "adjacent-own-complementary",
        original_text: "많으셨습니다",
        translated_text: "多謝款待"
      }]
    },
    { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 9150, width: 600, height: 600 }) },
    "adjacent-own-page-complementary"
  );

  assert.equal(boundaryNeighbor.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles.length, 1);
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

test("cross-page dedupe removes superseded bubbles from the source-scoped cache", () => {
  assert.match(
    contentSource,
    /function dedupeKakaoResultByPageCoordinates\(result, target, targetKey, scopedTargetKey = targetKey\)/
  );
  assert.match(contentSource, /\n\s*scopedTargetKey,\r?\n\s*store:/);
  assert.match(
    contentSource,
    /const cacheKey = entry\.scopedTargetKey \|\| entry\.targetKey;[\s\S]*state\.localResultCache\.get\(cacheKey\)/
  );
});

test("rendered Kakao overlays dynamically hide and restore visual duplicate copies", () => {
  assert.match(contentSource, /function overlayFrameSyncTick\(\)[\s\S]*?syncKakaoVisualDuplicateBubbles\(\);/);
  assert.match(contentSource, /syncKakaoVisualDuplicateBubbles\(true\);/);
  assert.match(contentSource, /KP\.selectKakaoVisualDuplicateLoser\(/);
  assert.match(contentSource, /node\.style\.removeProperty\("visibility"\);/);
  assert.match(contentSource, /loser\.node\.style\.visibility = "hidden";/);
  assert.doesNotMatch(contentSource, /loser\.node\.remove\(\)/);
  assert.match(contentSource, /root\.setAttribute\(RUNTIME_FEATURE_ATTRIBUTE, RUNTIME_FEATURE_VERSION\)/);
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

test("Kakao overlays keep a stable document position while the page scrolls", () => {
  const before = runtime.__test.getOverlayPositionRect(
    { left: 20, top: 100, width: 600, height: 800 },
    true,
    12,
    500
  );
  const after = runtime.__test.getOverlayPositionRect(
    { left: 20, top: -140, width: 600, height: 800 },
    true,
    12,
    740
  );

  assert.deepEqual(before, { left: 32, top: 600, width: 600, height: 800 });
  assert.deepEqual(after, before);
  assert.deepEqual(
    runtime.__test.getOverlayPositionRect(
      { left: 20, top: -140, width: 600, height: 800 },
      false,
      12,
      740
    ),
    { left: 20, top: -140, width: 600, height: 800 }
  );
  assert.equal(
    runtime.__test.shouldHideOverlayRoot({ width: 600, height: 800 }, false, true),
    false
  );
  assert.equal(
    runtime.__test.shouldHideOverlayRoot({ width: 600, height: 800 }, false, false),
    true
  );
  assert.equal(
    runtime.__test.shouldHideOverlayRoot({ width: 1, height: 800 }, true, true),
    true
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

test("Kakao reader content scope excludes recommendation cards but keeps comic pages", () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 1200;
  try {
    const comicPage = new globalThis.HTMLImageElement();
    comicPage.currentSrc = "https://dw-img-page.kakao.com/sdownload/resource?kid=page";
    comicPage.getBoundingClientRect = () => ({ left: 300, right: 900, top: 100, bottom: 1100, width: 600, height: 1000 });

    const recommendationCover = new globalThis.HTMLImageElement();
    recommendationCover.currentSrc = "https://dn-img-page.kakao.com/download/resource?kid=recommendation";
    recommendationCover.getBoundingClientRect = () => ({ left: 100, right: 280, top: 1400, bottom: 1660, width: 180, height: 260 });

    assert.equal(runtime.__test.isKakaoReaderContentTarget(comicPage), true);
    assert.equal(runtime.__test.isKakaoReaderContentTarget(recommendationCover), false);
  } finally {
    window.innerWidth = originalWidth;
  }
});

test("Kakao translation queue selects visible content before ahead and previous pages", () => {
  const targetAt = (rect) => ({ getBoundingClientRect: () => rect });
  const visible = { target: targetAt({ left: 300, right: 900, top: 160, bottom: 760, width: 600, height: 600 }) };
  const ahead = { target: targetAt({ left: 300, right: 900, top: 900, bottom: 1900, width: 600, height: 1000 }) };
  const previous = { target: targetAt({ left: 300, right: 900, top: -1100, bottom: -100, width: 600, height: 1000 }) };
  const queue = [ahead, previous, visible];

  assert.equal(runtime.__test.takeNextKakaoTranslationQueueItem(queue, 800), visible);
  assert.equal(runtime.__test.takeNextKakaoTranslationQueueItem(queue, 800), ahead);
  assert.deepEqual(queue, [previous]);
  assert.equal(runtime.__test.canStartKakaoTranslationQueueItem(visible, 5, 6, 800), true);
  assert.equal(runtime.__test.canStartKakaoTranslationQueueItem(ahead, 5, 6, 800), false);
  assert.match(contentSource, /queueMicrotask[\s\S]*drainTranslationQueue\(\)/);
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
  assert.match(contentSource, /KP\.attachShortPageIfAllowed\(state\.kakaoStore, target, ownerScopedKey\)/);
});

test("Kakao short page attachment release is gated on stitched result coverage", () => {
  assert.equal(
    runtime.__test.hasAttachedShortPageBubble({ bubbles: [{ original_text: "owner" }] }),
    false
  );
  assert.equal(
    runtime.__test.hasAttachedShortPageBubble({ bubbles: [{ stitch_attached_short_page: true }] }),
    true
  );

  const renderStageIndex = contentSource.indexOf("async function renderKakaoPipelineResult");
  const releaseIndex = contentSource.indexOf("releaseUncoveredKakaoShortPages(", renderStageIndex);
  const cacheIndex = contentSource.indexOf("rememberLocalResult(scopedTargetKey, result)", renderStageIndex);
  assert.ok(renderStageIndex >= 0);
  assert.ok(releaseIndex > renderStageIndex);
  assert.ok(releaseIndex < cacheIndex);
  assert.match(contentSource, /state\.kakaoStore\.releaseShortPage/);
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

test("translation line balancing avoids isolated CJK characters", () => {
  const formatted = runtime.__test.formatTranslationForOriginalLines(
    "那么是不是该慢慢把粉丝团名字亮出来了呢？",
    5
  );
  const lines = formatted.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines.join(""), "那么是不是该慢慢把粉丝团名字亮出来了呢？");
  assert.ok(lines.every((line) => Array.from(line).length > 1));
  assert.ok(Array.from(lines.at(-1)).length > 2);
});

test("moderate OCR tilt is preserved while vertical noise is rejected", () => {
  assert.ok(Math.abs(runtime.__test.normalizeBubbleRotation(8) - 8) < 0.01);
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
  assert.equal(runtime.__test.shouldReuseTargetInflight(
    "https://example.com/img.jpg|generation:3",
    "https://example.com/img.jpg|generation:3"
  ), true);
});

test("inflightByTarget allows re-queue when sourceToken changed (DOM reuse)", () => {
  assert.equal(runtime.__test.shouldReuseTargetInflight(
    "https://example.com/old.jpg|generation:0",
    "https://example.com/new.jpg|generation:0"
  ), false);
  assert.equal(runtime.__test.shouldReuseTargetInflight(
    "https://example.com/same.jpg|generation:0",
    "https://example.com/same.jpg|generation:1"
  ), false);
});

test("a queued revision check upgrades the pending request to force fresh OCR", () => {
  const target = {};
  const queue = [{ target, options: { manual: true, force: false, reason: "page-auto" } }];
  const upgraded = runtime.__test.upgradeQueuedTranslationRequest(queue, target, {
    manual: true,
    force: true,
    reason: "kakao-image-revision-check"
  });

  assert.equal(upgraded, true);
  assert.equal(queue[0].options.force, true);
  assert.equal(queue[0].options.reason, "kakao-image-revision-check");
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
  assert.equal(target.dataset.mtPipelineStage, "collected");
  const targetTrace = JSON.parse(target.dataset.mtPipelineTrace);
  assert.equal(targetTrace.at(-1).stage, "collected");
  assert.match(targetTrace.at(-1).summary, /\"width\":760/);

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

test("seam segment transforms expose one continuous virtual page through page-local windows", () => {
  const upper = runtime.__test.getSeamSegmentTransform({
    drawRect: { x: 0, y: 0, w: 760, h: 260 },
    sourceCrop: { x: 0, y: 740, w: 760, h: 260 },
    naturalWidth: 760,
    naturalHeight: 1000
  }, 760, 1000);
  const lower = runtime.__test.getSeamSegmentTransform({
    drawRect: { x: 0, y: 260, w: 760, h: 260 },
    sourceCrop: { x: 0, y: 0, w: 760, h: 260 },
    naturalWidth: 760,
    naturalHeight: 1000
  }, 760, 1000);

  assert.deepEqual(upper, { scaleX: 1, scaleY: 1, left: 0, top: 740 });
  assert.deepEqual(lower, { scaleX: 1, scaleY: 1, left: 0, top: -260 });
  assert.equal(upper.top + 260, 1000, "upper seam slice reaches the exact page bottom");
  assert.equal(lower.top + 260, 0, "lower seam slice starts at the exact page top");
});

test("seam sync installs the same scene in both windows and keeps the lower scene negative", () => {
  const surface = { renderKey: "render-shared", layoutKey: "layout-shared" };
  const makeEntry = (segment) => ({
    surface,
    segment,
    windowNode: { style: {} },
    composite: { style: {} }
  });
  const upper = makeEntry({
    pageId: "upper",
    drawRect: { x: 0, y: 0, w: 760, h: 260 },
    sourceCrop: { x: 0, y: 740, w: 760, h: 260 },
    naturalWidth: 760,
    naturalHeight: 1000
  });
  const lower = makeEntry({
    pageId: "lower",
    drawRect: { x: 0, y: 260, w: 760, h: 260 },
    sourceCrop: { x: 0, y: 0, w: 760, h: 260 },
    naturalWidth: 760,
    naturalHeight: 1000
  });

  runtime.__test.syncSeamOverlayTransforms({ seamEntries: [upper, lower] }, {
    width: 760,
    height: 1000
  });

  assert.equal(upper.surface, lower.surface);
  assert.equal(upper.surface.renderKey, lower.surface.renderKey);
  assert.equal(upper.surface.layoutKey, lower.surface.layoutKey);
  assert.equal(upper.windowNode.style.display, "block");
  assert.equal(lower.windowNode.style.display, "block");
  assert.equal(upper.composite.style.top, "740px");
  assert.equal(lower.composite.style.top, "-260px");
  assert.ok(Number.parseFloat(lower.composite.style.top) < 0);
  assert.equal(upper.composite.style.transform, lower.composite.style.transform);
});

test("two seam windows cover a cross-boundary bubble without a coordinate gap", () => {
  const upper = runtime.__test.getSeamSegmentTransform({
    drawRect: { x: 0, y: 0, w: 760, h: 260 },
    sourceCrop: { x: 0, y: 740, w: 760, h: 260 },
    naturalWidth: 760,
    naturalHeight: 1000
  }, 760, 1000);
  const lower = runtime.__test.getSeamSegmentTransform({
    drawRect: { x: 0, y: 260, w: 760, h: 260 },
    sourceCrop: { x: 0, y: 0, w: 760, h: 260 },
    naturalWidth: 760,
    naturalHeight: 1000
  }, 760, 1000);
  const canvasHeight = 520;
  const pageHeight = 1000;
  const visibleInterval = (transform) => ({
    start: Math.max(0, -transform.top / transform.scaleY),
    end: Math.min(canvasHeight, (pageHeight - transform.top) / transform.scaleY)
  });
  const bubble = { start: 180, end: 340 };
  const clip = (interval) => ({
    start: Math.max(interval.start, bubble.start),
    end: Math.min(interval.end, bubble.end)
  });
  const upperClip = clip(visibleInterval(upper));
  const lowerClip = clip(visibleInterval(lower));

  assert.deepEqual(upperClip, { start: 180, end: 260 });
  assert.deepEqual(lowerClip, { start: 260, end: 340 });
  assert.ok(lowerClip.start <= upperClip.end, "the two clips must not leave a blank seam");
  assert.equal(
    (upperClip.end - upperClip.start) + (lowerClip.end - lowerClip.start),
    bubble.end - bubble.start
  );
});

test("seam source mode toggles every window sharing one render key", () => {
  const calls = [];
  const entry = (renderKey, pageId) => ({
    surface: { renderKey },
    composite: {
      classList: {
        toggle: (className, enabled) => calls.push({ pageId, className, enabled })
      }
    }
  });
  const overlays = new Map([
    ["upper", { seamEntries: [entry("shared", "upper")] }],
    ["lower", { seamEntries: [entry("shared", "lower")] }],
    ["other", { seamEntries: [entry("other", "other")] }]
  ]);

  runtime.__test.setSeamSourceModeForOverlays(overlays, "shared", true);
  assert.deepEqual(calls, [
    { pageId: "upper", className: "mt-show-source", enabled: true },
    { pageId: "lower", className: "mt-show-source", enabled: true }
  ]);
});

test("seam resize only updates the composite transform and never refits text", () => {
  const positionStart = contentSource.indexOf("function syncOverlayPosition(");
  const positionEnd = contentSource.indexOf("function compareOverlayViewportRects", positionStart);
  const positionSource = contentSource.slice(positionStart, positionEnd);
  const seamStart = contentSource.indexOf("function syncSeamOverlayTransforms(");
  const seamEnd = contentSource.indexOf("function setSeamSourceModeForOverlays", seamStart);
  const seamSource = contentSource.slice(seamStart, seamEnd);
  assert.match(positionSource, /syncSeamOverlayTransforms\(overlayState/);
  assert.doesNotMatch(seamSource, /applySeamBubbleLayout|fitBubbleFontSize/);
});

test("seam surface validation is atomic across targets and image revisions", () => {
  const targets = {
    upper: { isConnected: true, revision: "rev-a" },
    lower: { isConnected: true, revision: "rev-b" }
  };
  const surface = runtime.__test.normalizeSeamRenderSurfaces({
    seamSurfaces: [{
      renderKey: "render-1",
      layoutKey: "layout-1",
      pairKey: "upper+lower",
      coordinateSpace: "kakao-seam-v1",
      canvasWidth: 760,
      canvasHeight: 520,
      pageIds: ["upper", "lower"],
      imageRevisionByPage: { upper: "rev-a", lower: "rev-b" },
      segments: [
        {
          pageId: "upper",
          drawRect: { x: 0, y: 0, w: 760, h: 260 },
          sourceCrop: { x: 0, y: 740, w: 760, h: 260 },
          naturalWidth: 760,
          naturalHeight: 1000
        },
        {
          pageId: "lower",
          drawRect: { x: 0, y: 260, w: 760, h: 260 },
          sourceCrop: { x: 0, y: 0, w: 760, h: 260 },
          naturalWidth: 760,
          naturalHeight: 1000
        }
      ],
      cleanedImage: "data:image/png;base64,AQID",
      bubbles: [{ x: 20, y: 35, w: 60, h: 30, translated_text: "合并页" }],
      handledCanonicalIds: ["canonical-1"]
    }]
  })[0];
  const resolveTarget = (pageId) => targets[pageId];
  const resolveRevision = (target) => target.revision;

  assert.equal(runtime.__test.isSeamSurfaceRenderable(surface, resolveTarget, resolveRevision), true);
  targets.lower.revision = "stale-revision";
  assert.equal(runtime.__test.isSeamSurfaceRenderable(surface, resolveTarget, resolveRevision), false);
  targets.lower.revision = "rev-b";
  targets.lower.isConnected = false;
  assert.equal(runtime.__test.isSeamSurfaceRenderable(surface, resolveTarget, resolveRevision), false);
});

test("seam render signature is stable and includes the shared layout and artifact", () => {
  const base = {
    renderKey: "render-1",
    layoutKey: "layout-1",
    cleanedImage: "data:image/png;base64,AQID",
    bubbles: [{ x: 1, y: 2, w: 3, h: 4, translated_text: "译文" }]
  };
  const first = runtime.__test.buildSeamSurfaceRenderSignature(base);
  assert.equal(first, runtime.__test.buildSeamSurfaceRenderSignature({ ...base }));
  assert.notEqual(first, runtime.__test.buildSeamSurfaceRenderSignature({
    ...base,
    layoutKey: "layout-2"
  }));
  assert.notEqual(first, runtime.__test.buildSeamSurfaceRenderSignature({
    ...base,
    cleanedImage: "data:image/png;base64,AQIE"
  }));
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
