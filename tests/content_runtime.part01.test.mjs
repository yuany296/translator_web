import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const contentRoot = path.resolve(import.meta.dirname, "..", "extension", "src", "content");
const contentSource = [fs.readFileSync(path.join(contentRoot, "configure.js"), "utf8"), ...fs.readdirSync(path.join(contentRoot, "modules"), {
  withFileTypes: true
}).filter(entry => entry.isFile() && entry.name.endsWith(".js")).sort((a, b) => a.name.localeCompare(b.name)).map(entry => fs.readFileSync(path.join(contentRoot, "modules", entry.name), "utf8"))].join("\n");
globalThis.location = {
  hostname: "page.kakao.com",
  pathname: "/content/1",
  search: "?episode=7",
  href: "https://page.kakao.com/content/1?episode=7#page-2",
  origin: "https://page.kakao.com"
};
globalThis.window = {
  scrollX: 0,
  scrollY: 0,
  innerWidth: 1200,
  innerHeight: 800
};
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.getComputedStyle = element => element && element.__style || {
  overflowX: "visible",
  overflowY: "visible"
};
await import("../extension/src/content/index.js");
const runtime = globalThis.__MANGA_TRANSLATOR_V3__;
function makeStitchPayload(ownerTop, ownerHeight, compositeHeight, opts = {}) {
  const compositeWidth = opts.compositeWidth || 760;
  const ownerEntry = {
    source: "owner",
    targetKey: opts.targetKey || "test-owner",
    src: opts.src || "owner.jpg",
    drawRect: {
      x: 0,
      y: ownerTop,
      w: compositeWidth,
      h: ownerHeight
    },
    sourceCrop: {
      x: 0,
      y: 0,
      w: compositeWidth,
      h: ownerHeight
    },
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
test("hidden-page paint waiting has a timer fallback instead of hanging forever", async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  globalThis.requestAnimationFrame = () => 0;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  try {
    await Promise.race([runtime.__test.waitForPaint(5), new Promise((_, reject) => setTimeout(() => reject(new Error("paint wait stayed pending")), 100))]);
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
test("content retry scheduler and canonical pipeline share one initialized Store", () => {
  const store = runtime.__test.kakaoStore;
  assert.equal(typeof store?.getRetryState, "function");
  assert.equal(runtime.__test.kakaoCanonicalPipeline.store, store);
  const storeInit = contentSource.indexOf("const kakaoStore =");
  const retryInit = contentSource.indexOf("runtime.KP.createRetryScheduler");
  const pipelineInit = contentSource.indexOf("const kakaoCanonicalPipeline =");
  assert.ok(storeInit >= 0 && storeInit < retryInit && retryInit < pipelineInit);
});
test("rotated aligned bubbles use a center transform anchor without changing text alignment", () => {
  const style = {
    setProperty(name, value) {
      this[name] = value;
    }
  };
  const node = {
    style
  };
  runtime.__test.applyBubbleAnchorStyle(node, {
    alignment: "left",
    x: 10,
    y: 20,
    w: 30,
    h: 12,
    rotation: -18,
    unit: "%"
  });
  assert.equal(node.style.left, "25%");
  assert.equal(node.style.top, "26%");
  assert.equal(node.style.transformOrigin, "center center");
  assert.match(node.style["--mt-base-transform"], /translate\(-50%, -50%\) rotate\(-18\.00deg\)/);
});
test("rotated polygon bubbles use the polygon centroid instead of its axis-aligned corner", () => {
  const style = {
    setProperty(name, value) {
      this[name] = value;
    }
  };
  const node = {
    style
  };
  runtime.__test.applyBubbleAnchorStyle(node, {
    alignment: "left",
    x: 51,
    y: 31,
    w: 32,
    h: 58,
    centerX: 74.7,
    centerY: 64.3,
    rotation: -12.6,
    unit: "%"
  });
  assert.equal(node.style.left, "74.7%");
  assert.equal(node.style.top, "64.3%");
  assert.equal(node.style.transformOrigin, "center center");
});
test("Korean source text stays horizontal after translation even in a tall rotated box", () => {
  const node = {
    dataset: {
      original: "일부러 보라고",
      rotationDeg: "-12.6",
      regionType: "effect_text",
      hPercent: "71.35",
      wPercent: "27.18",
      backgroundTarget: ""
    }
  };
  assert.equal(runtime.__test.shouldUseVerticalJapaneseLayout(node, "这不就是小嘛！"), false);
  node.dataset.rotationDeg = "-89";
  assert.equal(runtime.__test.shouldUseVerticalJapaneseLayout(node, "竖排文字"), false);
});
test("Kakao page identity ignores CDN signing changes but tracks actual image bytes", async () => {
  const target = new globalThis.HTMLImageElement();
  target.currentSrc = "https://cdn.example.test/page.jpg?episode=7&signature=first&expires=100";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    top: 100,
    width: 760,
    height: 1200
  });
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
    target.getAttribute = name => name === "src" ? target.currentSrc : "";
    target.getBoundingClientRect = () => ({
      top,
      width: 760,
      height: 1000
    });
    return target;
  };
  const first = await runtime.__test.buildKakaoPageIdentity(createTarget("https://dw-img-page.kakao.com/sdownload/resource?token=page-a", 100), {
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: "https://dw-img-page.kakao.com/sdownload/resource?token=page-a",
    width: 760,
    height: 1000
  });
  const second = await runtime.__test.buildKakaoPageIdentity(createTarget("https://dw-img-page.kakao.com/sdownload/resource?token=page-b", 1100), {
    dataUrl: "data:image/png;base64,AQIE",
    imageUrl: "https://dw-img-page.kakao.com/sdownload/resource?token=page-b",
    width: 760,
    height: 1000
  });
  const resignedFirst = await runtime.__test.buildKakaoPageIdentity(createTarget("https://dw-img-page.kakao.com/sdownload/resource?token=page-a-refreshed", 100), {
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: "https://dw-img-page.kakao.com/sdownload/resource?token=page-a-refreshed",
    width: 760,
    height: 1000
  });
  assert.notEqual(first.pageId, second.pageId);
  assert.equal(first.pageId, resignedFirst.pageId);
  assert.notEqual(first.stableSource, second.stableSource);
  assert.match(first.stableSource, /content-revision=/);
});
test("opaque Kakao resource tokens still use image bytes when stable query fields remain", async () => {
  const createTarget = currentSrc => {
    const target = new globalThis.HTMLImageElement();
    target.currentSrc = currentSrc;
    target.naturalWidth = 760;
    target.naturalHeight = 1000;
    target.width = 760;
    target.height = 1000;
    target.isConnected = true;
    target.getAttribute = name => name === "src" ? target.currentSrc : "";
    target.getBoundingClientRect = () => ({
      top: 100,
      width: 760,
      height: 1000
    });
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
  assert.match(adapterSource, /clearLoadingOverlay\s*:\s*runtime\.clearKakaoLoadingOverlay/);
  assert.match(contentSource, /function clearKakaoLoadingOverlay\s*\(/);
});
test("settled no-text markers suppress overlay recovery for both key forms", () => {
  const targetKey = "direct|page";
  const scopedTargetKey = "direct|page|src:revision";
  assert.equal(runtime.__test.matchesTargetMarker(targetKey, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.matchesTargetMarker(scopedTargetKey, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.matchesTargetMarker("direct|other", targetKey, scopedTargetKey), false);
  assert.equal(runtime.__test.hasSettledNoTextMarker({
    dataset: {
      mtNoTextKey: scopedTargetKey
    }
  }, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.hasSettledNoTextMarker({
    dataset: {
      mtNoTextKey: "direct|other"
    }
  }, targetKey, scopedTargetKey), false);
  assert.equal(runtime.__test.hasSettledTranslatedMarker({
    dataset: {
      mtNoTextKey: scopedTargetKey
    }
  }, targetKey, scopedTargetKey), false);
  assert.equal(runtime.__test.hasSettledTranslatedMarker({
    dataset: {
      mtLastTranslatedKey: scopedTargetKey
    }
  }, targetKey, scopedTargetKey), true);
});
test("debug and loading overlays never count as reusable translated results", () => {
  assert.equal(runtime.__test.isReusableRenderedState({
    mode: "debug",
    bubbleCount: 0
  }, true), false);
  assert.equal(runtime.__test.isReusableRenderedState({
    mode: "loading",
    bubbleCount: 0
  }, true), false);
  assert.equal(runtime.__test.isReusableRenderedState({
    mode: "bubbles",
    bubbleCount: 2
  }, false), false);
  assert.equal(runtime.__test.isReusableRenderedState({
    mode: "bubbles",
    bubbleCount: 2
  }, true), true);
  assert.equal(runtime.__test.isReusableRenderedState({
    mode: "embedded",
    bubbleCount: 1
  }, true), true);
});
test("loading preserves translated bubbles but replaces a debug-only overlay", () => {
  const targetKey = "direct|page";
  assert.equal(runtime.__test.shouldPreserveOverlayDuringLoading({
    targetKey,
    mode: "bubbles",
    bubbleCount: 2
  }, targetKey), true);
  assert.equal(runtime.__test.shouldPreserveOverlayDuringLoading({
    targetKey,
    mode: "debug",
    bubbleCount: 0
  }, targetKey), false);
  assert.equal(runtime.__test.shouldPreserveOverlayDuringLoading({
    targetKey: "direct|old-page",
    mode: "bubbles",
    bubbleCount: 2
  }, targetKey), false);
  const originalDocument = globalThis.document;
  const root = {
    loadingCard: null,
    querySelector() {
      return this.loadingCard;
    },
    appendChild(node) {
      this.loadingCard = node;
    }
  };
  globalThis.document = {
    createElement() {
      return {
        className: "",
        textContent: "",
        dataset: {},
        classList: {
          add() {}
        }
      };
    }
  };
  try {
    const overlay = {
      root
    };
    const card = runtime.__test.ensureLoadingStatusCard(overlay, "处理跨页...");
    assert.equal(root.loadingCard, card);
    assert.equal(card.textContent, "处理跨页...");
    assert.equal(overlay.loadingCard, card);
    assert.equal(runtime.__test.ensureLoadingStatusCard(overlay, "渲染结果..."), card);
    assert.equal(card.textContent, "渲染结果...");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;else globalThis.document = originalDocument;
  }
});
test("extension-owned seam composites never reenter Kakao OCR target selection", () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {
    mangaTranslatorOverlay: "true"
  };
  target.closest = () => null;
  assert.equal(runtime.__test.isMangaTranslatorOverlayTarget(target), true);
  assert.equal(runtime.__test.isSupportedTarget(target), false);
  target.dataset = {};
  target.closest = () => ({
    dataset: {
      mangaTranslatorOverlay: "true"
    }
  });
  assert.equal(runtime.__test.isMangaTranslatorOverlayTarget(target), true);
  assert.equal(runtime.__test.isSupportedTarget(target), false);
  target.closest = () => null;
  assert.equal(runtime.__test.isMangaTranslatorOverlayTarget(target), false);
  assert.equal(runtime.__test.isSupportedTarget(target), true);
});
test("known Kakao page bindings are idempotent until target or revision changes", () => {
  const target = {
    isConnected: true
  };
  const targets = new Set([target]);
  assert.equal(runtime.__test.isCurrentKakaoPageBinding(target, "page-a", {
    target,
    imageRevision: "rev-a"
  }, "rev-a", targets), true);
  assert.equal(runtime.__test.isCurrentKakaoPageBinding(target, "page-a", {
    target,
    imageRevision: "rev-b"
  }, "rev-a", targets), false);
  assert.equal(runtime.__test.isCurrentKakaoPageBinding(target, "page-a", {
    target: {},
    imageRevision: "rev-a"
  }, "rev-a", targets), false);
});
test("only a current ready Kakao page binding can reuse OCR facts", () => {
  const target = {
    isConnected: true
  };
  const handle = {
    target,
    pageId: "page-a",
    imageRevision: "rev-a",
    pageOcrState: "ready"
  };
  const terminal = {
    state: "ready",
    details: {
      imageRevision: "rev-a"
    }
  };
  assert.equal(runtime.__test.isReusableKakaoReadyPageBinding(target, handle, terminal, "page-a", "rev-a"), true);
  assert.equal(runtime.__test.isReusableKakaoReadyPageBinding(target, handle, terminal, "page-a", "rev-b"), false);
  assert.equal(runtime.__test.isReusableKakaoReadyPageBinding(target, {
    ...handle,
    pageOcrState: "failed"
  }, terminal, "page-a", "rev-a"), false);
});
test("identical overlay payloads have a stable render signature", () => {
  const first = {
    bubbles: [{
      canonical_id: "c1",
      x: 10,
      y: 20,
      w: 30,
      h: 8,
      translated_text: "译文"
    }],
    debug: {
      debugOverlayMode: "raw",
      rawItems: [{
        id: "r1",
        percent: {
          x: 10,
          y: 20,
          w: 30,
          h: 8
        }
      }]
    }
  };
  const second = JSON.parse(JSON.stringify(first));
  assert.equal(runtime.__test.buildOverlayRenderSignature(first), runtime.__test.buildOverlayRenderSignature(second));
  second.debug.rawItems[0].id = "r2";
  assert.equal(runtime.__test.buildOverlayRenderSignature(first), runtime.__test.buildOverlayRenderSignature(second), "debug-only churn must not replace a stable translated overlay");
  assert.notEqual(runtime.__test.buildOverlayDebugRenderSignature(first), runtime.__test.buildOverlayDebugRenderSignature(second));
  second.bubbles[0].translated_text = "新译文";
  assert.notEqual(runtime.__test.buildOverlayRenderSignature(first), runtime.__test.buildOverlayRenderSignature(second));
  const prefix = "data:image/png;base64," + "A".repeat(120);
  const suffix = "Z".repeat(64);
  const middleA = {
    bubbles: [],
    debug: {},
    cleanedImage: `${prefix}first${suffix}`
  };
  const middleB = {
    bubbles: [],
    debug: {},
    cleanedImage: `${prefix}other${suffix}`
  };
  assert.equal(middleA.cleanedImage.length, middleB.cleanedImage.length);
  const middleSignature = runtime.__test.buildOverlayRenderSignature(middleA);
  assert.equal(middleSignature, runtime.__test.buildOverlayRenderSignature(middleB));
  assert.equal(runtime.__test.isSameOverlayRenderPayload({
    renderSignature: middleSignature,
    cleanedImage: middleA.cleanedImage
  }, middleSignature, middleA.cleanedImage), true);
  assert.equal(runtime.__test.isSameOverlayRenderPayload({
    renderSignature: middleSignature,
    cleanedImage: middleA.cleanedImage
  }, middleSignature, middleB.cleanedImage), false, "cleaned images that only differ in their middle bytes must not reuse one overlay");
});
test("changed overlay payloads replace the old root atomically", () => {
  const start = contentSource.indexOf("function renderOverlay(");
  const end = contentSource.indexOf("function scheduleTermDiscovery", start);
  const renderSource = contentSource.slice(start, end);
  assert.match(renderSource, /oldOverlay\.root\.replaceWith\(root\)/);
  assert.doesNotMatch(renderSource, /oldOverlay\.root\.remove\(\)/);
});
test("canonical empty projections stay pending unless OCR authoritatively found no text", () => {
  assert.equal(runtime.__test.classifyCanonicalProjectionRender([], {
    authoritativeEmpty: false
  }), "pending");
  assert.equal(runtime.__test.classifyCanonicalProjectionRender([], {
    authoritativeEmpty: true
  }), "no-text");
  assert.equal(runtime.__test.classifyCanonicalProjectionRender([{
    translated_text: "译文"
  }], {
    authoritativeEmpty: false
  }), "translated");
});
test("provisional or explicitly incomplete canonical renders never become terminal", () => {
  assert.equal(runtime.__test.isCanonicalRenderComplete([], {
    translationComplete: true
  }), true);
  assert.equal(runtime.__test.isCanonicalRenderComplete([], {
    translationComplete: false
  }), false);
  assert.equal(runtime.__test.isCanonicalRenderComplete([{
    translated_text: "旧译文",
    provisional: true
  }], {
    translationComplete: true
  }), false);
  assert.equal(runtime.__test.isCanonicalRenderComplete([{
    translated_text: "旧译文",
    pendingCanonicalId: "new-revision"
  }], {
    translationComplete: true
  }), false);
});
test("canonical pending and retry failures preserve the last stable projection", () => {
  const renderStart = contentSource.indexOf("async function renderCanonicalProjections");
  const renderEnd = contentSource.indexOf("async function renderTranslationResult", renderStart);
  const renderSource = contentSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /disposition === "pending"[\s\S]*?stream:\s*false,[\s\S]*?debugOnly:\s*true/);
  const translateStart = contentSource.indexOf("async function translateTarget");
  const translateEnd = contentSource.indexOf("runtime.translateTarget = translateTarget;", translateStart);
  const translateSource = contentSource.slice(translateStart, translateEnd);
  assert.match(translateSource, /executeCanonicalTarget\(target, options\)\.catch[\s\S]*?runtime\.clearKakaoLoadingOverlay\(target\);/);
  assert.doesNotMatch(translateSource, /executeCanonicalTarget\(target, options\)\.catch[\s\S]*?runtime\.clearRenderedTarget\(target\);/);
});
test("canonical seam rendering uses explicit ESM dependencies and the common projection renderer", () => {
  const pipelineSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "extension", "src", "canonical", "pipeline.js"), "utf8");
  assert.match(pipelineSource, /import \{ reconciler \} from "\.\/reconciler\.js"/);
  assert.doesNotMatch(pipelineSource, /MangaTranslatorKakao/);
  assert.doesNotMatch(contentSource, /\n\s*renderSeamCrossPage,\n/);
  assert.match(contentSource, /renderCanonicalProjections[\s\S]*renderTranslationResult\(/);
});
test("canonical seam surfaces render page-local slices for every page", () => {
  const surface = {
    pageIds: ["page-a", "page-b"]
  };
  assert.equal(runtime.__test.getSeamSurfaceHostPageId(surface, pageId => ({
    isConnected: pageId === "page-a"
  })), "page-a");
  assert.equal(runtime.__test.getSeamSurfaceHostPageId(surface, pageId => ({
    isConnected: pageId === "page-b"
  })), "page-b");
  assert.equal(runtime.__test.getSeamSurfaceHostPageId(surface, () => null), "page-a");
  const renderStart = contentSource.indexOf("async function renderCanonicalProjections");
  const renderEnd = contentSource.indexOf("async function renderTranslationResult", renderStart);
  const renderSource = contentSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /const pageSurfaces = seamSurfacesByPage\.get\(pageId\) \|\| \[\]/);
  assert.doesNotMatch(renderSource, /hostedSeamSurfacesByPage/);
  assert.doesNotMatch(renderSource, /hostedPageSurfaces/);
  assert.match(renderSource, /seamSurfaces: pageSurfaces/);
  const overlayStart = contentSource.indexOf("function renderOverlay(");
  const overlayEnd = contentSource.indexOf("function scheduleTermDiscovery", overlayStart);
  const overlaySource = contentSource.slice(overlayStart, overlayEnd);
  assert.match(overlaySource, /root\.dataset\.seamPageId = seamPageId/);
  assert.match(overlaySource, /root\.dataset\.seamSliceKeys/);
  assert.match(overlaySource, /removeDuplicateSeamSurfaceRoots\(seamSurfaces, root, seamPageId\)/);
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
  const ahead = {
    options: {
      reason: "ahead-viewport"
    }
  };
  const queue = [ahead, {
    options: {
      reason: "ahead-image-load"
    }
  }];
  assert.equal(runtime.__test.getTranslationQueueInsertIndex(queue, {
    reason: "page-auto"
  }), 0);
  assert.equal(runtime.__test.getTranslationQueueInsertIndex(queue, {
    reason: "ahead-mutation"
  }), 2);
  assert.equal(runtime.__test.canStartQueuedTranslation(ahead, {
    runningJobs: 4,
    runningAheadJobs: 4,
    maxParallel: 6,
    reservedSlots: 2
  }), false);
  assert.equal(runtime.__test.canStartQueuedTranslation({
    options: {
      reason: "page-auto"
    }
  }, {
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
    __style: {
      overflowX: "scroll",
      overflowY: "hidden"
    },
    getBoundingClientRect: () => ({
      left: 447,
      right: 1103,
      top: 500,
      bottom: 760
    })
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
