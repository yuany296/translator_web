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
test("Kakao page-level dedupe trims only the repeated boundary and keeps the unique final line", async () => {
  const leading = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 15,
      y: 82,
      w: 70,
      h: 24,
      block_id: "boundary-leading",
      original_text: "'산제물의 합참가'는 명의 지휘자와 그가 소환한 1개의 은쟁반으로",
      translated_text: "「祭品的联合参加」是由一位著名的指挥家和他所召唤的一个银盘所构成的。"
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 2000,
      width: 600,
      height: 1000
    })
  }, "boundary-leading-page");
  const trailing = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 16,
      y: -18,
      w: 68,
      h: 25,
      block_id: "boundary-trailing",
      original_text: "명의 지휘자와 그가 소환한 1개의 은쟁반으로 미루머져 있다.",
      translated_text: "据一位著名指挥家和他所召唤的一个银盘推断。"
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 3000,
      width: 600,
      height: 1000
    })
  }, "boundary-trailing-page");
  assert.equal(leading.bubbles.length, 1);
  assert.equal(trailing.bubbles.length, 1);
  assert.equal(trailing.bubbles[0].original_text, "미루머져 있다.");
  assert.ok(trailing.bubbles[0].y > -18);
  assert.ok(trailing.bubbles[0].h < 25);
});
test("cross-page dedupe removes superseded bubbles from the source-scoped cache", () => {
  assert.match(contentSource, /function dedupeKakaoResultByPageCoordinates\(result, target, targetKey, scopedTargetKey = targetKey\)/);
  assert.match(contentSource, /\n\s*scopedTargetKey,\r?\n\s*store:/);
  assert.match(contentSource, /const cacheKey = entry\.scopedTargetKey \|\| entry\.targetKey;[\s\S]*state\.localResultCache\.get\(cacheKey\)/);
});
test("rendered Kakao overlays dynamically hide and restore visual duplicate copies", () => {
  assert.match(contentSource, /function overlayFrameSyncTick\(\)[\s\S]*?syncKakaoVisualDuplicateBubbles\(\);/);
  assert.match(contentSource, /syncKakaoVisualDuplicateBubbles\(true\);/);
  assert.match(contentSource, /KP\.selectKakaoVisualDuplicateLoser\(/);
  assert.match(contentSource, /node\.style\.removeProperty\("visibility"\);/);
  assert.match(contentSource, /loser\.node\.style\.visibility = "hidden";/);
  assert.doesNotMatch(contentSource, /loser\.node\.remove\(\)/);
  assert.match(contentSource, /root\.setAttribute\(runtime\.RUNTIME_FEATURE_ATTRIBUTE, runtime\.RUNTIME_FEATURE_VERSION\)/);
});
test("pretranslation mode defaults to manual", () => {
  assert.equal(runtime.__test.normalizePretranslateMode("ahead"), "ahead");
  assert.equal(runtime.__test.normalizePretranslateMode("continuous"), "continuous");
  assert.equal(runtime.__test.isAutomaticPretranslateMode("ahead"), true);
  assert.equal(runtime.__test.isAutomaticPretranslateMode("continuous"), true);
  assert.equal(runtime.__test.normalizePretranslateMode("unexpected"), "manual");
});
test("pretranslation requires explicit activation in the current page", () => {
  assert.equal(runtime.__test.shouldSchedulePagePretranslation({
    enabled: true,
    pageEnabled: false,
    mode: "continuous",
    invalidated: false
  }), false);
  assert.equal(runtime.__test.shouldSchedulePagePretranslation({
    enabled: true,
    pageEnabled: true,
    mode: "continuous",
    invalidated: false
  }), true);
});
test("page translation toggle does not persist activation globally", () => {
  assert.equal(/storageSet\(\{\s*mt_pretranslate_mode\s*:/.test(contentSource), false);
});
test("floating ball click follows configured pretranslation mode before manual viewport translation", () => {
  assert.match(contentSource, /ball\.addEventListener\("click", async event => \{[\s\S]*?runtime\.state\.autoTranslatePageEnabled[\s\S]*?runtime\.togglePageAutoTranslate\(false\)[\s\S]*?runtime\.isAutomaticPretranslateMode\(runtime\.state\.pretranslateMode\)[\s\S]*?runtime\.togglePageAutoTranslate\(true\)[\s\S]*?await runtime\.manualTranslateVisible\(\);[\s\S]*?\}\);/);
  assert.doesNotMatch(contentSource, /runtime\.togglePageAutoTranslate\(!runtime\.state\.autoTranslatePageEnabled\)/);
  assert.match(contentSource, /runtime\.state\.autoTranslatePageEnabled && runtime\.state\.enabled/);
});
test("page auto toggle queues visible and ahead targets without blocking on manual OCR", () => {
  const match = contentSource.match(/async function togglePageAutoTranslate\(enabled\) \{[\s\S]*?\n  function getPageAutoTranslateStatus\(\)/);
  assert.ok(match, "togglePageAutoTranslate source should be present");
  assert.match(match[0], /const visibleCount = runtime\.queueVisiblePageAutoTargets\(\);[\s\S]*?runtime\.scheduleAheadPretranslation\("page-auto-start"\);/);
  assert.doesNotMatch(match[0], /manualTranslateVisible\(\)/);
  assert.match(contentSource, /function queueVisiblePageAutoTargets\(\) \{[\s\S]*?return targets\.length;/);
});
test("translation queue pump coalesces microtasks without recursive drain alias", () => {
  const queueTranslateMatch = contentSource.match(/function queueTranslate\(target, options\) \{[\s\S]*?\n  function isCanonicalRevisionCheckOptions/);
  assert.ok(queueTranslateMatch, "queueTranslate source should be present");
  assert.match(queueTranslateMatch[0], /pumpQueue\(\);/);
  assert.doesNotMatch(queueTranslateMatch[0], /queueMicrotask[\s\S]*drainTranslationQueue\(\)/);
  assert.equal((contentSource.match(/function drainTranslationQueue\(/g) || []).length, 0);
  const pumpMatch = contentSource.match(/function pumpQueue\(\) \{[\s\S]*?\n  function processTranslationQueue\(\)/);
  assert.ok(pumpMatch, "pumpQueue and processTranslationQueue should be adjacent");
  assert.match(pumpMatch[0], /state\.queueDrainScheduled/);
  assert.match(pumpMatch[0], /queueMicrotask\(\(\) => \{[\s\S]*processTranslationQueue\(\);/);
});
test("overlay movement updates position without triggering text layout", () => {
  assert.deepEqual({
    ...runtime.__test.compareOverlayViewportRects({
      left: 10,
      top: 20,
      width: 600,
      height: 900
    }, {
      left: 10,
      top: -80,
      width: 600,
      height: 900
    })
  }, {
    positionChanged: true,
    sizeChanged: false
  });
});
test("Kakao overlays keep a stable document position while the page scrolls", () => {
  const before = runtime.__test.getOverlayPositionRect({
    left: 20,
    top: 100,
    width: 600,
    height: 800
  }, true, 12, 500);
  const after = runtime.__test.getOverlayPositionRect({
    left: 20,
    top: -140,
    width: 600,
    height: 800
  }, true, 12, 740);
  assert.deepEqual(before, {
    left: 32,
    top: 600,
    width: 600,
    height: 800
  });
  assert.deepEqual(after, before);
  assert.deepEqual(runtime.__test.getOverlayPositionRect({
    left: 20,
    top: -140,
    width: 600,
    height: 800
  }, false, 12, 740), {
    left: 20,
    top: -140,
    width: 600,
    height: 800
  });
  assert.equal(runtime.__test.shouldHideOverlayRoot({
    width: 600,
    height: 800
  }, false, true), false);
  assert.equal(runtime.__test.shouldHideOverlayRoot({
    width: 600,
    height: 800
  }, false, false), true);
  assert.equal(runtime.__test.shouldHideOverlayRoot({
    width: 1,
    height: 800
  }, true, true), true);
});
test("overlay resize triggers text layout", () => {
  assert.deepEqual({
    ...runtime.__test.compareOverlayViewportRects({
      left: 10,
      top: 20,
      width: 600,
      height: 900
    }, {
      left: 10,
      top: 20,
      width: 720,
      height: 1080
    })
  }, {
    positionChanged: false,
    sizeChanged: true
  });
});
test("ahead translation keeps relaxed filtering through execution", () => {
  assert.deepEqual({
    ...runtime.__test.buildAheadTranslationOptions("viewport")
  }, {
    manual: true,
    relaxed: true,
    allowOffscreen: true,
    reason: "ahead-viewport"
  });
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
    comicPage.getBoundingClientRect = () => ({
      left: 300,
      right: 900,
      top: 100,
      bottom: 1100,
      width: 600,
      height: 1000
    });
    const recommendationCover = new globalThis.HTMLImageElement();
    recommendationCover.currentSrc = "https://dn-img-page.kakao.com/download/resource?kid=recommendation";
    recommendationCover.getBoundingClientRect = () => ({
      left: 100,
      right: 280,
      top: 1400,
      bottom: 1660,
      width: 180,
      height: 260
    });
    assert.equal(runtime.__test.isKakaoReaderContentTarget(comicPage), true);
    assert.equal(runtime.__test.isKakaoReaderContentTarget(recommendationCover), false);
  } finally {
    window.innerWidth = originalWidth;
  }
});
test("Kakao translation queue selects visible content before ahead and previous pages", () => {
  const targetAt = rect => ({
    getBoundingClientRect: () => rect
  });
  const visible = {
    target: targetAt({
      left: 300,
      right: 900,
      top: 160,
      bottom: 760,
      width: 600,
      height: 600
    })
  };
  const ahead = {
    target: targetAt({
      left: 300,
      right: 900,
      top: 900,
      bottom: 1900,
      width: 600,
      height: 1000
    })
  };
  const previous = {
    target: targetAt({
      left: 300,
      right: 900,
      top: -1100,
      bottom: -100,
      width: 600,
      height: 1000
    })
  };
  const queue = [ahead, previous, visible];
  assert.equal(runtime.__test.takeNextKakaoTranslationQueueItem(queue, 800), visible);
  assert.equal(runtime.__test.takeNextKakaoTranslationQueueItem(queue, 800), ahead);
  assert.deepEqual(queue, [previous]);
  assert.equal(runtime.__test.canStartKakaoTranslationQueueItem(visible, 5, 6, 800), true);
  assert.equal(runtime.__test.canStartKakaoTranslationQueueItem(ahead, 5, 6, 800), false);
  assert.match(contentSource, /queueMicrotask[\s\S]*processTranslationQueue\(\)/);
});
test("Kakao render debug logs are gated by pipeline trace", () => {
  const renderMatch = contentSource.match(/async function renderTranslationResult\(target, targetKey, result, payload, options = \{\}\) \{[\s\S]*?\n  function isKakaopageTargetStillRenderable/);
  assert.ok(renderMatch, "renderTranslationResult source should be present");
  assert.match(renderMatch[0], /if \(runtime\.ENABLE_PIPELINE_TRACE && runtime\.IS_KAKAOPAGE_READER\)/);
  const debugMatch = contentSource.match(/function logOcrDebugMapping\(overlayState, result\) \{[\s\S]*?\n  function normalizeResult/);
  assert.ok(debugMatch, "logOcrDebugMapping source should be present");
  assert.match(debugMatch[0], /if \(!runtime\.ENABLE_PIPELINE_TRACE\)[\s\S]*?return/);
});
test("Kakao strip screenshot waits until a useful target area is visible", () => {
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect(null), false);
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect({
    width: 760,
    height: 179
  }), false);
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect({
    width: 179,
    height: 800
  }), false);
  assert.equal(runtime.__test.hasUsableKakaoStripCaptureRect({
    width: 180,
    height: 180
  }), true);
  assert.equal(contentSource.includes("Kakao target looks like a small lazy-loaded strip, skip OCR"), false);
  assert.match(contentSource, /isScreenshotTargetNotVisibleError\(reason\)[\s\S]*scheduleAutoTranslateRetry\(target\)/);
});
test("ahead window refills after completed images when the reader scrolls forward", () => {
  const candidates = Array.from({
    length: 12
  }, (_, index) => ({
    index,
    done: index < 7,
    getBoundingClientRect: () => ({
      bottom: (index + 1) * 100
    })
  }));
  const pending = runtime.__test.selectPendingAheadCandidates(candidates, 35, candidate => !candidate.done, 6);
  assert.deepEqual(pending.map(candidate => candidate.index), [7, 8, 9, 10, 11]);
});
test("a new content runtime takes ownership and removes stale extension UI", () => {
  assert.match(contentSource, /runtime\.claimRuntimeOwnership\(\);[\s\S]*await runtime\.loadLocalSettings\(\)/);
  assert.match(contentSource, /\.mt-overlay-layer, \.mt-floating-ball-wrap, \.mt-measure-probe/);
  assert.match(contentSource, /if \(!runtime\.isCurrentRuntimeOwner\(\)\)\s*\{\s*runtime\.destroy\(\)/);
  assert.match(contentSource, /delete target\.dataset\.mtLastTranslatedKey/);
  assert.match(contentSource, /delete target\.dataset\.mtNoTextKey/);
});
test("OCR capture and rendering are isolated from extension-owned overlays", () => {
  assert.match(contentSource, /withOverlayLayerHidden[\s\S]*overlayLayer\.style\.visibility = "hidden"/);
  assert.match(contentSource, /node\.closest\("\[data-manga-translator-overlay\]"\)/);
  assert.match(contentSource, /mutationInsideOverlay[\s\S]*continue/);
  assert.match(contentSource, /oldOverlay\.root\.remove\(\)/);
  assert.match(contentSource, /expectedSourceImageId[\s\S]*getSourceImageIdForTarget\(target\)\s*!==\s*expectedSourceImageId/);
});
test("debug overlay exposes raw, deduped, duplicate, and block boxes", () => {
  assert.match(contentSource, /name: "raw",[\s\S]*?items: debug\.rawItems/);
  assert.match(contentSource, /name: "duplicate",[\s\S]*?items: debug\.duplicateItems/);
  assert.match(contentSource, /name: "deduped",[\s\S]*?items: debug\.dedupedItems/);
  assert.match(contentSource, /name: "block",[\s\S]*?items: debug\.finalBubbles/);
  assert.match(contentSource, /node\.dataset\.blockId/);
});
test("ahead window contains the current image and the next six images", () => {
  const candidates = Array.from({
    length: 12
  }, (_, index) => ({
    index,
    getBoundingClientRect: () => ({
      bottom: (index - 2) * 100
    })
  }));
  const pending = runtime.__test.selectPendingAheadCandidates(candidates, 35, () => true, 6);
  assert.deepEqual(pending.map(candidate => candidate.index), [3, 4, 5, 6, 7, 8, 9]);
});
test("continuous window contains every pending image from the current position", () => {
  const candidates = Array.from({
    length: 12
  }, (_, index) => ({
    index,
    done: index === 5,
    getBoundingClientRect: () => ({
      bottom: (index - 2) * 100
    })
  }));
  const pending = runtime.__test.selectPendingContinuousCandidates(candidates, 35, candidate => !candidate.done);
  assert.deepEqual(pending.map(candidate => candidate.index), [3, 4, 6, 7, 8, 9, 10, 11]);
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
  assert.match(contentSource, /runtime\.KP\.attachShortPageIfAllowed\(runtime\.state\.kakaoStore, target, ownerScopedKey\)/);
});
test("Kakao short page attachment release is gated on stitched result coverage", () => {
  assert.equal(runtime.__test.hasAttachedShortPageBubble({
    bubbles: [{
      original_text: "owner"
    }]
  }), false);
  assert.equal(runtime.__test.hasAttachedShortPageBubble({
    bubbles: [{
      stitch_attached_short_page: true
    }]
  }), true);
  const renderStageIndex = contentSource.indexOf("async function renderKakaoPipelineResult");
  const releaseIndex = contentSource.indexOf("releaseUncoveredKakaoShortPages(", renderStageIndex);
  const cacheIndex = contentSource.indexOf("rememberLocalResult(scopedTargetKey, result)", renderStageIndex);
  assert.ok(renderStageIndex >= 0);
  assert.ok(releaseIndex > renderStageIndex);
  assert.ok(releaseIndex < cacheIndex);
  assert.match(contentSource, /runtime\.KP\.releaseShortPagesForOwner\(runtime\.state\.kakaoStore/);
  assert.match(contentSource, /short-attachment-suppressed/);
});
test("stitched OCR remaps polygon points into the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 30,
      w: 20,
      h: 10,
      original_text: "rotated",
      polygon: [{
        x: 10,
        y: 30
      }, {
        x: 30,
        y: 30
      }, {
        x: 30,
        y: 40
      }, {
        x: 10,
        y: 40
      }]
    }]
  }, makeStitchPayload(300, 600, 1200), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "owner-polygon");
  assert.equal(result.bubbles.length, 1);
  assert.deepEqual(result.bubbles[0].polygon.map(point => point.y), [10, 10, 30, 30]);
});
test("stitched OCR remaps the solid fill box into the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 30,
      w: 20,
      h: 10,
      fill_box: {
        x: 8,
        y: 28,
        w: 24,
        h: 14
      },
      original_text: "source",
      translated_text: "translated",
      bg_type: "solid"
    }]
  }, makeStitchPayload(200, 400, 800), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "fill-box-remap");
  assert.equal(result.bubbles[0].fill_box.x, 8);
  assert.ok(Math.abs(result.bubbles[0].fill_box.y - 6) < 1e-9);
  assert.equal(result.bubbles[0].fill_box.w, 24);
  assert.ok(Math.abs(result.bubbles[0].fill_box.h - 28) < 1e-9);
});
test("stitched OCR remaps raw debug items into the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 30,
      w: 20,
      h: 10,
      original_text: "owner"
    }],
    debug: {
      imageWidth: 760,
      imageHeight: 1200,
      rawItems: [{
        id: "prev",
        rawBox: {
          left: 76,
          top: 60,
          width: 152,
          height: 48
        },
        text: "previous"
      }, {
        id: "owner",
        rawBox: {
          left: 76,
          top: 360,
          width: 152,
          height: 60
        },
        text: "owner"
      }, {
        id: "next",
        rawBox: {
          left: 76,
          top: 1020,
          width: 152,
          height: 48
        },
        text: "next"
      }],
      dedupedItems: [],
      duplicateItems: [],
      finalBubbles: []
    }
  }, makeStitchPayload(300, 600, 1200, {
    previous: {
      source: "previous",
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    },
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 900,
        w: 760,
        h: 300
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "debug-owner");
  assert.deepEqual(result.debug.rawItems.map(item => item.id), ["owner"]);
  assert.ok(Math.abs(result.debug.rawItems[0].percent.y - 10) < 1e-9);
  assert.ok(Math.abs(result.debug.rawItems[0].percent.h - 10) < 1e-9);
});
test("solid background covers both the original fill and translated text boxes", () => {
  assert.deepEqual({
    ...runtime.__test.buildSolidBackgroundBox({
      x: 20,
      y: 20,
      w: 30,
      h: 20
    }, {
      x: 10,
      y: 15,
      w: 25,
      h: 12
    })
  }, {
    x: 10,
    y: 15,
    w: 40,
    h: 25
  });
  assert.deepEqual({
    ...runtime.__test.buildSolidBackgroundBox({
      x: 20,
      y: 20,
      w: 30,
      h: 20
    }, null)
  }, {
    x: 20,
    y: 20,
    w: 30,
    h: 20
  });
});
test("stitched solid background can extend upward into the previous page", () => {
  assert.deepEqual({
    ...runtime.__test.buildSolidBackgroundBox({
      x: 20,
      y: -12,
      w: 50,
      h: 28
    }, {
      x: 18,
      y: -15,
      w: 54,
      h: 32
    }, true)
  }, {
    x: 18,
    y: -15,
    w: 54,
    h: 32
  });
});
test("overlay visibility includes stitched content crossing into the previous page", () => {
  const rect = runtime.__test.getOverlayVisibilityRect({
    bubbleNodes: [{
      dataset: {
        stitchOverflow: "true",
        yPercent: "-30",
        hPercent: "20"
      }
    }]
  }, {
    left: 0,
    right: 600,
    top: 900,
    bottom: 1500,
    width: 600,
    height: 600
  });
  assert.deepEqual(rect, {
    left: 0,
    right: 600,
    top: 720,
    bottom: 1500,
    width: 600,
    height: 780
  });
});
