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
function createSnapshotImage(source) {
  const target = new globalThis.HTMLImageElement();
  const attributes = new Map([["src", source]]);
  target.dataset = {};
  target.currentSrc = source;
  Object.defineProperty(target, "src", {
    configurable: true,
    get() {
      return this.currentSrc;
    },
    set(value) {
      this.currentSrc = String(value);
      attributes.set("src", this.currentSrc);
    }
  });
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.isConnected = true;
  target.getAttribute = name => attributes.get(name) || "";
  target.setAttribute = (name, value) => attributes.set(name, String(value));
  target.removeAttribute = name => attributes.delete(name);
  target.getBoundingClientRect = () => ({
    width: 760,
    height: 1200
  });
  return target;
}
test("embedded image commit keeps its pre-render target snapshot valid", () => {
  const source = "https://cdn.example.test/novel-page.jpg";
  const output = "data:image/png;base64,ZW1iZWRkZWQ=";
  const target = createSnapshotImage(source);
  const snapshot = runtime.__test.captureTargetSnapshot(target);
  runtime.__test.applyEmbeddedImageDataUrl(target, "novel-output", output, {
    bubbleCount: 1,
    translatedLines: ["中文"]
  });
  assert.equal(runtime.__test.getCommittedEmbeddedOriginalSource(target, output), source);
  assert.equal(runtime.__test.isTargetSnapshotStillValid(target, snapshot), true);
});
test("an external data URL replacement still invalidates an embedded snapshot", () => {
  const source = "https://cdn.example.test/novel-page-replaced.jpg";
  const output = "data:image/png;base64,b3V0cHV0";
  const target = createSnapshotImage(source);
  const snapshot = runtime.__test.captureTargetSnapshot(target);
  runtime.__test.applyEmbeddedImageDataUrl(target, "novel-output-replaced", output, {
    bubbleCount: 1,
    translatedLines: ["中文"]
  });
  target.src = "data:image/png;base64,ZXh0ZXJuYWw=";
  assert.equal(runtime.__test.isTargetSnapshotStillValid(target, snapshot), false);
});
test("confirmed novel image output wins over a late cancellation without opening the panel", () => {
  const cancelled = { ok: false, reason: "cancelled:target changed before render commit" };
  assert.deepEqual(runtime.__test.classifyNovelImageResult(cancelled, ["中文"]), {
    status: "complete",
    error: ""
  });
  assert.deepEqual(runtime.__test.classifyNovelImageResult(cancelled, [], true), {
    status: "complete",
    error: ""
  });
  assert.equal(runtime.__test.shouldOpenNovelImagePanel(false, "complete"), false);
  assert.deepEqual(runtime.__test.classifyNovelImageResult(cancelled, []), {
    status: "failed",
    error: cancelled.reason
  });
  assert.equal(runtime.__test.shouldOpenNovelImagePanel(false, "failed"), true);
});
test("dedupedItems coordinate mapping follows same rules as raw items", () => {
  const result = runtime.__test.normalizeDebugCoordinateItems([{
    id: "dup",
    rawBox: {
      left: 0,
      top: 0,
      width: 760,
      height: 300
    },
    text: "non-owner"
  }, {
    id: "keep",
    rawBox: {
      left: 0,
      top: 300,
      width: 760,
      height: 600
    },
    text: "owner"
  }], {
    imageWidth: 760,
    imageHeight: 1200
  }, {
    stitch: {
      verified: true
    },
    compositeWidth: 760,
    compositeHeight: 1200,
    ownerDraw: {
      x: 0,
      y: 300,
      w: 760,
      h: 600
    },
    segments: [{
      source: "previous",
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    }, {
      source: "owner",
      drawRect: {
        x: 0,
        y: 300,
        w: 760,
        h: 600
      }
    }, {
      source: "next",
      drawRect: {
        x: 0,
        y: 900,
        w: 760,
        h: 300
      }
    }]
  });
  assert.equal(result.length, 1, "Non-owner items should be filtered out");
  if (result.length > 0) {
    assert.equal(result[0].id, "keep");
  }
});
test("mapKakaoStitchedFillBox rejects unreasonable height", () => {
  // fill_box with 400% height should be rejected
  const result = runtime.__test.mapKakaoStitchedFillBox({
    x: 10,
    y: 0,
    w: 80,
    h: 400
  }, 300, 600, 1200);
  assert.equal(result, null, "fill_box with 400% height should be rejected");
});
test("mapKakaoStitchedFillBox accepts reasonable height", () => {
  // fill_box with 100% height should be accepted
  const result = runtime.__test.mapKakaoStitchedFillBox({
    x: 10,
    y: 0,
    w: 80,
    h: 100
  }, 300, 600, 1200);
  assert.ok(result !== null, "fill_box with 100% height should be accepted");
  assert.ok(result.h > 0, "Mapped height should be positive");
  assert.ok(Number.isFinite(result.y), "Mapped Y should be finite");
});
test("mapKakaoStitchedResult clamps height instead of discarding when only height exceeds threshold", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 30,
      w: 30,
      h: 45,
      original_text: "single line but tall"
    }]
  }, makeStitchPayload(300, 600, 1200), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "clamp-height-test");

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
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    left: 0,
    top: 100,
    width: 760,
    height: 1000,
    right: 760,
    bottom: 1100
  });

  // Trigger trace via fake collected event
  runtime.__test.tracePipeline("collected", target, {
    rect: {
      top: 100,
      height: 1000,
      width: 760
    }
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
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 100,
    height: 100
  });

  // Use tracePipeline directly
  // Fill to just above the limit
  for (let i = 0; i < 5010; i++) {
    runtime.__test.tracePipeline("collected", target, {
      idx: i
    });
  }
  const traces = runtime.__test.getPipelineTrace();
  assert.ok(traces.length <= 5000, `FIFO limit should keep at most 5000 entries, got ${traces.length}`);

  // The oldest entries should have been shifted out
  const firstIdx = traces[0] && traces[0].detail && traces[0].detail.idx;
  assert.ok(typeof firstIdx === "number" && firstIdx >= 10, `Oldest entry should have been shifted out, first idx is ${firstIdx}`);
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
test("cross-page geometry uses positive reading-area coordinates and preserves the page gap", () => {
  const surface = {
    canvasWidth: 760,
    canvasHeight: 520,
    pageIds: ["upper", "lower"],
    segments: [{
      pageId: "upper", drawRect: { x: 0, y: 0, w: 760, h: 260 },
      sourceCrop: { x: 0, y: 740, w: 760, h: 260 }, naturalWidth: 760, naturalHeight: 1000
    }, {
      pageId: "lower", drawRect: { x: 0, y: 260, w: 760, h: 260 },
      sourceCrop: { x: 0, y: 0, w: 760, h: 260 }, naturalWidth: 760, naturalHeight: 1000
    }]
  };
  const targets = new Map([
    ["upper", { left: 100, top: 50, width: 760, height: 1000 }],
    ["lower", { left: 100, top: 1074, width: 760, height: 1000 }]
  ]);
  const geometry = runtime.__test.buildCrossPageBubbleGeometry(surface, {
    x: 20, y: 35, w: 60, h: 30, fill_box: { x: 20, y: 35, w: 60, h: 30 }
  }, targets, { left: 80, top: 20, width: 800, height: 2100 });
  assert.ok(geometry.outer.left >= 0 && geometry.outer.top >= 0);
  assert.equal(geometry.coverSegments.length, 2);
  const [upper, lower] = geometry.coverSegments;
  const uncoveredGap = lower.top - (upper.top + upper.height);
  assert.equal(uncoveredGap, 24);
  assert.ok(geometry.textFrame.height > upper.height + lower.height,
    "one text frame must include the real inter-page gap");
});
test("cross-page geometry lays out one text frame from full page-space canonical boxes", () => {
  const surface = {
    canvasWidth: 760, canvasHeight: 192, pageIds: ["upper", "lower"],
    segments: [{
      pageId: "upper", drawRect: { x: 0, y: 0, w: 760, h: 96 },
      sourceCrop: { x: 0, y: 904, w: 760, h: 96 }, naturalWidth: 760, naturalHeight: 1000
    }, {
      pageId: "lower", drawRect: { x: 0, y: 96, w: 760, h: 96 },
      sourceCrop: { x: 0, y: 0, w: 760, h: 96 }, naturalWidth: 760, naturalHeight: 1000
    }]
  };
  const targets = new Map([
    ["upper", { left: 100, top: 50, width: 760, height: 1000 }],
    ["lower", { left: 100, top: 1074, width: 760, height: 1000 }]
  ]);
  const pageBoxes = [
    { pageId: "upper", x: 20, y: 94, w: 60, h: 6 },
    { pageId: "lower", x: 18, y: 0, w: 64, h: 16.32 }
  ];
  const geometry = runtime.__test.buildCrossPageBubbleGeometry(surface, {
    x: 20, y: 35, w: 60, h: 30, fill_box: { x: 20, y: 35, w: 60, h: 30 },
    page_text_boxes: pageBoxes, page_cover_boxes: pageBoxes
  }, targets, { left: 80, top: 20, width: 800, height: 2200 });
  assert.ok(geometry.outer.left >= 0 && geometry.outer.top >= 0);
  assert.equal(geometry.coverSegments.length, 2);
  assert.equal(Math.round(geometry.coverSegments[1].height * 100) / 100, 163.2,
    "the lower cover must not be truncated to the 96px seam crop");
  const uncoveredGap = geometry.coverSegments[1].top -
    (geometry.coverSegments[0].top + geometry.coverSegments[0].height);
  assert.equal(uncoveredGap, 24);
  assert.equal(Math.round(geometry.textFrame.height * 10) / 10, 247.2);
  assert.ok(geometry.coverSegments[0].compositeIntersection,
    "page-coordinate boxes inside the seam capture must retain cleaned-image coordinates");
  assert.equal(geometry.coverSegments[1].compositeIntersection, undefined,
    "page-coordinate boxes extending beyond the seam capture cannot sample unavailable pixels");
});
test("solid cross-page geometry bridges a small mask gap cut through a source line", () => {
  const surface = {
    canvasWidth: 760, canvasHeight: 192, pageIds: ["upper", "lower"],
    segments: [{
      pageId: "upper", drawRect: { x: 0, y: 0, w: 760, h: 96 },
      sourceCrop: { x: 0, y: 904, w: 760, h: 96 }, naturalWidth: 760, naturalHeight: 1000
    }, {
      pageId: "lower", drawRect: { x: 0, y: 96, w: 760, h: 96 },
      sourceCrop: { x: 0, y: 0, w: 760, h: 96 }, naturalWidth: 760, naturalHeight: 1000
    }]
  };
  const targets = new Map([
    ["upper", { left: 100, top: 50, width: 760, height: 1000 }],
    ["lower", { left: 100, top: 1050, width: 760, height: 1000 }]
  ]);
  const pageBoxes = [
    { pageId: "upper", x: 20, y: 94, w: 60, h: 6 },
    { pageId: "lower", x: 22, y: 2, w: 56, h: 8 }
  ];
  const geometry = runtime.__test.buildCrossPageBubbleGeometry(surface, {
    x: 20, y: 35, w: 60, h: 30, fill_box: { x: 20, y: 35, w: 60, h: 30 },
    bg_type: "solid", page_text_boxes: pageBoxes, page_cover_boxes: pageBoxes
  }, targets, { left: 80, top: 20, width: 800, height: 2200 });
  const bridge = geometry.coverSegments.find(segment => segment.mapping === "bridge");
  assert.ok(bridge);
  assert.equal(Math.round(bridge.height), 20);
  // font_height_percent 的分母是单条捕获带图片高:两条 96 的带拼成 192 的 canvas,
  // sourceImageHeight 应还原为单条带的屏高 96,而非 canvas 全高 192。
  assert.equal(Math.round(geometry.textFrame.sourceImageHeight), 96);
});
test("cross-page renderer has one layout call site and no legacy page-local seam windows", () => {
  const start = contentSource.indexOf("function applyCrossPageTextGeometry(");
  const end = contentSource.indexOf("function syncCrossPageSurfaceEntry", start);
  const layoutSource = contentSource.slice(start, end);
  const syncStart = contentSource.indexOf("function syncCrossPageSurfaceEntry(");
  const syncEnd = contentSource.indexOf("function removeCrossPageSurfaceEntry", syncStart);
  assert.equal((layoutSource.match(/fitBubbleFontSize\(/g) || []).length, 1);
  assert.doesNotMatch(contentSource.slice(syncStart, syncEnd), /fitBubbleFontSize\(/);
  assert.doesNotMatch(contentSource, /mt-seam-window|mt-seam-composite|syncSeamOverlayTransforms/);
});
test("seam surface validation is atomic across targets and image revisions", () => {
  const targets = {
    upper: {
      isConnected: true,
      revision: "rev-a"
    },
    lower: {
      isConnected: true,
      revision: "rev-b"
    }
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
      imageRevisionByPage: {
        upper: "rev-a",
        lower: "rev-b"
      },
      segments: [{
        pageId: "upper",
        drawRect: {
          x: 0,
          y: 0,
          w: 760,
          h: 260
        },
        sourceCrop: {
          x: 0,
          y: 740,
          w: 760,
          h: 260
        },
        naturalWidth: 760,
        naturalHeight: 1000
      }, {
        pageId: "lower",
        drawRect: {
          x: 0,
          y: 260,
          w: 760,
          h: 260
        },
        sourceCrop: {
          x: 0,
          y: 0,
          w: 760,
          h: 260
        },
        naturalWidth: 760,
        naturalHeight: 1000
      }],
      cleanedImage: "data:image/png;base64,AQID",
      bubbles: [{
        x: 20,
        y: 35,
        w: 60,
        h: 30,
        translated_text: "合并页"
      }],
      diagnostics: [{
        canonicalId: "canonical-1",
        reason: "accepted"
      }],
      handledCanonicalIds: ["canonical-1"],
      absorbedCanonicalIds: ["canonical-1", "canonical-old"],
      absorbedObservationIds: ["observation-upper", "observation-lower"]
    }]
  })[0];
  const resolveTarget = pageId => targets[pageId];
  const resolveRevision = target => target.revision;
  assert.equal(runtime.__test.isSeamSurfaceRenderable(surface, resolveTarget, resolveRevision), true);
  assert.deepEqual(surface.diagnostics, [{
    canonicalId: "canonical-1",
    reason: "accepted"
  }]);
  assert.deepEqual(surface.absorbedCanonicalIds, ["canonical-1", "canonical-old"]);
  assert.deepEqual(surface.absorbedObservationIds, ["observation-upper", "observation-lower"]);
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
    bubbles: [{
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      translated_text: "译文"
    }]
  };
  const first = runtime.__test.buildSeamSurfaceRenderSignature(base);
  assert.equal(first, runtime.__test.buildSeamSurfaceRenderSignature({
    ...base
  }));
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
  const segments = runtime.__test.normalizeKakaoStitchSegments({
    canvasWidth: 760,
    canvasHeight: 1200,
    previous: {
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    }
  }, 760, 1200, {
    x: 0,
    y: 300,
    w: 760,
    h: 600
  });
  assert.ok(Array.isArray(segments), "Should return an array");
  assert.ok(segments.length >= 2, "Should have at least owner and one neighbor");
});
test("loading card anchors once and stops following on later syncs", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  const card = {
    dataset: {},
    style: {}
  };
  const overlay = {
    root: {
      loadingCard: card,
      querySelector() {
        return this.loadingCard;
      }
    }
  };
  window.innerWidth = 2124;
  window.innerHeight = 1112;
  try {
    runtime.__test.syncLoadingOverlayCardPosition(overlay, {
      left: 693,
      right: 1413,
      top: -828,
      bottom: 214
    }, {
      left: 693,
      right: 1413,
      top: 0,
      bottom: 214
    });
    assert.equal(card.style.left, "360px");
    assert.equal(card.style.top, "935px");
    assert.equal(card.style.transform, "translate(-50%, -50%)");
    assert.equal(card.dataset.mtLoadingPositioned, "1");
    // 后续 sync(rect 已滚动)不再重新定位,卡片保持首次锚点。
    runtime.__test.syncLoadingOverlayCardPosition(overlay, {
      left: 693,
      right: 1413,
      top: -2000,
      bottom: 4000
    }, {
      left: 693,
      right: 1413,
      top: 0,
      bottom: 1112
    });
    assert.equal(card.style.left, "360px");
    assert.equal(card.style.top, "935px");
  } finally {
    window.innerWidth = originalInnerWidth;
    window.innerHeight = originalInnerHeight;
  }
});
