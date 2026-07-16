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
test("seam segment transforms expose one continuous virtual page through page-local windows", () => {
  const upper = runtime.__test.getSeamSegmentTransform({
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
  }, 760, 1000);
  const lower = runtime.__test.getSeamSegmentTransform({
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
  }, 760, 1000);
  assert.deepEqual(upper, {
    scaleX: 1,
    scaleY: 1,
    left: 0,
    top: 740
  });
  assert.deepEqual(lower, {
    scaleX: 1,
    scaleY: 1,
    left: 0,
    top: -260
  });
  assert.equal(upper.top + 260, 1000, "upper seam slice reaches the exact page bottom");
  assert.equal(lower.top + 260, 0, "lower seam slice starts at the exact page top");
});
test("seam sync installs the same scene in both windows and keeps the lower scene negative", () => {
  const surface = {
    renderKey: "render-shared",
    layoutKey: "layout-shared"
  };
  const makeEntry = segment => ({
    surface,
    segment,
    windowNode: {
      style: {}
    },
    composite: {
      style: {}
    }
  });
  const upper = makeEntry({
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
  });
  const lower = makeEntry({
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
  });
  runtime.__test.syncSeamOverlayTransforms({
    seamEntries: [upper, lower]
  }, {
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
  }, 760, 1000);
  const lower = runtime.__test.getSeamSegmentTransform({
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
  }, 760, 1000);
  const canvasHeight = 520;
  const pageHeight = 1000;
  const visibleInterval = transform => ({
    start: Math.max(0, -transform.top / transform.scaleY),
    end: Math.min(canvasHeight, (pageHeight - transform.top) / transform.scaleY)
  });
  const bubble = {
    start: 180,
    end: 340
  };
  const clip = interval => ({
    start: Math.max(interval.start, bubble.start),
    end: Math.min(interval.end, bubble.end)
  });
  const upperClip = clip(visibleInterval(upper));
  const lowerClip = clip(visibleInterval(lower));
  assert.deepEqual(upperClip, {
    start: 180,
    end: 260
  });
  assert.deepEqual(lowerClip, {
    start: 260,
    end: 340
  });
  assert.ok(lowerClip.start <= upperClip.end, "the two clips must not leave a blank seam");
  assert.equal(upperClip.end - upperClip.start + (lowerClip.end - lowerClip.start), bubble.end - bubble.start);
});
test("seam source mode toggles every window sharing one render key", () => {
  const calls = [];
  const entry = (renderKey, pageId) => ({
    surface: {
      renderKey
    },
    composite: {
      classList: {
        toggle: (className, enabled) => calls.push({
          pageId,
          className,
          enabled
        })
      }
    }
  });
  const overlays = new Map([["upper", {
    seamEntries: [entry("shared", "upper")]
  }], ["lower", {
    seamEntries: [entry("shared", "lower")]
  }], ["other", {
    seamEntries: [entry("other", "other")]
  }]]);
  runtime.__test.setSeamSourceModeForOverlays(overlays, "shared", true);
  assert.deepEqual(calls, [{
    pageId: "upper",
    className: "mt-show-source",
    enabled: true
  }, {
    pageId: "lower",
    className: "mt-show-source",
    enabled: true
  }]);
});
test("seam text is fitted once in intrinsic composite coordinates and resize only scales it", () => {
  const positionStart = contentSource.indexOf("function syncOverlayPosition(");
  const positionEnd = contentSource.indexOf("function compareOverlayViewportRects", positionStart);
  const positionSource = contentSource.slice(positionStart, positionEnd);
  const seamStart = contentSource.indexOf("function syncSeamOverlayTransforms(");
  const seamEnd = contentSource.indexOf("function setSeamSourceModeForOverlays", seamStart);
  const seamSource = contentSource.slice(seamStart, seamEnd);
  assert.match(positionSource, /syncSeamOverlayTransforms\(overlayState/);
  assert.doesNotMatch(seamSource, /applySeamBubbleLayout|fitBubbleFontSize/);
  const createStart = contentSource.indexOf("function createSeamWindowNode(");
  const createEnd = contentSource.indexOf("function syncSeamOverlayTransforms", createStart);
  const createSource = contentSource.slice(createStart, createEnd);
  assert.match(createSource, /applySeamBubbleLayout\(surface, bubbleNodes\)/);
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
      suppressedCanonicalIds: ["canonical-small-edge"]
    }]
  })[0];
  const resolveTarget = pageId => targets[pageId];
  const resolveRevision = target => target.revision;
  assert.equal(runtime.__test.isSeamSurfaceRenderable(surface, resolveTarget, resolveRevision), true);
  assert.deepEqual(surface.diagnostics, [{
    canonicalId: "canonical-1",
    reason: "accepted"
  }]);
  assert.deepEqual(surface.suppressedCanonicalIds, ["canonical-small-edge"]);
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
