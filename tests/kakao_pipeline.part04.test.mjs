import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";
function createPipelineHarness(overrides = {}) {
  const calls = [];
  const store = P.createStore();
  const target = {
    isConnected: true,
    dataset: {},
    sourceToken: "source-a",
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: 760,
        height: 1000
      };
    }
  };
  const adapters = {
    store,
    computeTargetKey: () => "page-1",
    getQuickSourceToken: value => value.sourceToken,
    buildTargetSourceCacheKey: (key, source) => `${key}|${source}`,
    captureTargetSnapshot: value => ({
      sourceToken: value.sourceToken
    }),
    isTargetSnapshotStillValid: (value, snapshot) => value.sourceToken === snapshot.sourceToken,
    extractTargetPayload: async () => {
      calls.push("fetch");
      return {
        dataUrl: "data:image/png;base64,A",
        sourceToken: "source-a"
      };
    },
    shouldUseKakaoStitchedOcr: () => true,
    buildKakaoStitchedPayload: async (_target, payload) => {
      calls.push("stitch");
      return {
        ...payload,
        stitch: {
          canvasWidth: 760,
          canvasHeight: 1000,
          owner: {
            drawRect: {
              x: 0,
              y: 0,
              w: 760,
              h: 1000
            }
          },
          segments: [{
            source: "owner",
            drawRect: {
              x: 0,
              y: 0,
              w: 760,
              h: 1000
            }
          }]
        },
        singleImagePayload: payload
      };
    },
    requestTranslationForPayload: async () => {
      calls.push("recognize");
      return {
        ok: true,
        result: {
          bubbles: [{
            original_text: "hello",
            x: 10,
            y: 10,
            w: 20,
            h: 10
          }]
        }
      };
    },
    mapStitchedResult: result => result,
    dedupeResult: async result => {
      calls.push("dedupe");
      return result;
    },
    renderPipelineResult: async () => {
      calls.push("render");
    },
    renderTranslationResult: async () => undefined,
    clearRenderedTarget: () => undefined,
    renderOverlay: () => undefined,
    renderLoadingOverlay: () => undefined,
    tracePipeline: () => undefined,
    scheduleAutoTranslateRetry: () => calls.push("retry"),
    reportPipelineError: async () => undefined,
    ...overrides
  };
  return {
    pipeline: P.createPipeline(adapters),
    store,
    target,
    calls,
    adapters
  };
}
/* =================================================================
 * Authoritative page OCR + canonical pipeline
 * ================================================================= */

function makeCanonicalObservation(pageId, revision, id, y = 40, text = id) {
  return {
    id,
    sourceType: "page",
    pageIds: [pageId],
    imageRevisionByPage: {
      [pageId]: revision
    },
    pageSpans: [{
      pageId,
      box: {
        x: 20,
        y,
        w: 20,
        h: 6
      },
      overlapRatio: 1
    }],
    originalText: text,
    confidence: 0.95,
    visual: {
      regionType: "speech",
      bgType: "solid"
    },
    providerBlockId: id
  };
}
function createCanonicalHarness(options = {}) {
  const calls = [];
  const traces = [];
  const timers = [];
  const ocrMetas = [];
  const renderInputs = [];
  const targets = {
    a: {
      name: "a",
      sourceToken: "source-a",
      generation: 0,
      isConnected: true
    },
    b: {
      name: "b",
      sourceToken: "source-b",
      generation: 0,
      isConnected: true
    }
  };
  const identities = {
    a: {
      chapterId: "chapter",
      pageId: "page-a",
      imageRevision: "rev-a",
      width: 800,
      height: 2000,
      readingOrder: 1
    },
    b: {
      chapterId: "chapter",
      pageId: "page-b",
      imageRevision: "rev-b",
      width: 800,
      height: 2000,
      readingOrder: 2
    }
  };
  const pageObservations = options.pageObservations || {
    a: [makeCanonicalObservation("page-a", "rev-a", "obs-a", 40, "inside A")],
    b: [makeCanonicalObservation("page-b", "rev-b", "obs-b", 40, "inside B")]
  };
  const store = P.createStore();
  const loadingClears = [];
  const adapters = {
    store,
    computeTargetKey: target => `target-${target.name}`,
    getQuickSourceToken: target => target.sourceToken,
    getTargetGeneration: target => target.generation,
    buildTargetSourceCacheKey: (targetKey, sourceToken) => `${targetKey}|${sourceToken}`,
    extractTargetPayload: async target => {
      calls.push(`fetch:${target.name}`);
      return {
        dataUrl: `data:image/png;base64,${target.name}`,
        width: 800,
        height: 2000
      };
    },
    buildPageIdentity: async target => ({
      ...identities[target.name]
    }),
    requestOcrForPayload: async (_payload, meta) => {
      ocrMetas.push({
        ...meta
      });
      calls.push(`ocr:${meta.sourceType}:${meta.pageIds.join("+")}`);
      if (meta.sourceType === "seam") {
        if (options.seamFailure) throw new Error("seam unavailable");
        return {
          ok: true,
          result: {
            observations: options.seamObservations || [],
            filteredObservations: [],
            edgeSignals: {},
            ...(options.seamCleanedImage ? {
              cleanedImage: options.seamCleanedImage
            } : {}),
            ...(options.seamCleanedImageToken ? {
              cleanedImageToken: options.seamCleanedImageToken
            } : {}),
            ...(options.seamDebug ? {
              debug: options.seamDebug
            } : {})
          }
        };
      }
      const targetName = meta.pageIds[0] === "page-a" ? "a" : "b";
      if (options.pageFailure === targetName) throw new Error(`page ${targetName} failed`);
      return {
        ok: true,
        result: {
          observations: pageObservations[targetName] || [],
          filteredObservations: options.filteredObservations && options.filteredObservations[targetName] || [],
          edgeSignals: options.edgeSignals && options.edgeSignals[targetName] || {},
          ...(options.pageDebug && options.pageDebug[targetName] ? {
            debug: options.pageDebug[targetName]
          } : {}),
          ...(meta.forceCleanedImageArtifact && options.artifactCleanedImage ? {
            cleanedImage: options.artifactCleanedImage,
            debug: {
              artifact: true
            }
          } : {})
        }
      };
    },
    requestCanonicalTranslations: async items => {
      calls.push(`translate:${items.map(item => `${item.id}@${item.revision}:${item.original_text}`).join(",")}`);
      if (options.translateDeferred) return options.translateDeferred(items);
      return {
        ok: true,
        result: {
          translations: items.map(item => ({
            id: item.id,
            revision: item.revision,
            translated_text: `ZH:${item.original_text}`,
            translationFingerprint: `fp:${item.original_text}`,
            cached: false
          }))
        }
      };
    },
    renderCanonicalProjections: async input => {
      const {
        pageId,
        projections
      } = input;
      renderInputs.push(input);
      calls.push(`render:${pageId}:${projections.filter(item => item.activeText).length}`);
    },
    findAdjacentKakaoPageTargets: target => target.name === "a" ? {
      next: targets.b
    } : {
      previous: targets.a
    },
    buildKakaoSeamPayload: async (_pageA, _pageB, plan) => {
      calls.push(`seam-payload:${plan.bandHeight}`);
      return options.seamPayload || {
        dataUrl: "data:image/png;base64,seam",
        width: 800,
        height: plan.bandHeight * 2
      };
    },
    detectAdjacentKakaoPixelRisk: async () => options.pixelRisk || null,
    getTargetForKakaoPageId: pageId => pageId === "page-a" ? targets.a : pageId === "page-b" ? targets.b : null,
    captureTargetSnapshot: target => ({
      sourceToken: target.sourceToken
    }),
    isTargetSnapshotStillValid: (target, snapshot) => target.sourceToken === snapshot.sourceToken,
    renderLoadingOverlay: () => {},
    clearLoadingOverlay: target => loadingClears.push(target.name),
    tracePipeline: (event, _target, details) => traces.push({
      event,
      details
    }),
    scheduleAutoTranslateRetry: () => calls.push("retry"),
    setTimer: (callback, delay) => {
      const timer = {
        callback,
        delay,
        cleared: false
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => {
      timer.cleared = true;
    },
    now: () => 1000,
    edgeWaitTimeoutMs: options.edgeWaitTimeoutMs ?? 8000,
    ...options.adapterOverrides
  };
  return {
    pipeline: P.createCanonicalPipeline(adapters),
    adapters,
    store,
    targets,
    calls,
    traces,
    timers,
    ocrMetas,
    renderInputs,
    loadingClears,
    identities
  };
}
function boundaryMergeHarnessOptions() {
  return {
    pageObservations: {
      a: [{
        ...makeCanonicalObservation("page-a", "rev-a", "merge-a", 94, "A tail"),
        visual: {
          regionType: "speech",
          regionHash: "same",
          bgType: "solid"
        }
      }],
      b: [{
        ...makeCanonicalObservation("page-b", "rev-b", "merge-b", 0, "B head"),
        visual: {
          regionType: "speech",
          regionHash: "same",
          bgType: "solid"
        }
      }]
    },
    seamObservations: [{
      id: "merge-seam",
      sourceType: "seam",
      pageIds: ["page-a", "page-b"],
      imageRevisionByPage: {
        "page-a": "rev-a",
        "page-b": "rev-b"
      },
      pageSpans: [{
        pageId: "page-a",
        box: {
          x: 20,
          y: 94,
          w: 20,
          h: 6
        },
        overlapRatio: 1
      }, {
        pageId: "page-b",
        box: {
          x: 20,
          y: 0,
          w: 20,
          h: 6
        },
        overlapRatio: 1
      }],
      originalText: "A tail B head",
      confidence: 0.99,
      visual: {
        regionType: "speech",
        regionHash: "same",
        bgType: "solid"
      },
      providerBlockId: "merge-seam"
    }]
  };
}
async function runFailedRevisionFallbackScenario({
  reverse = false,
  throwError = false
}) {
  let translationRequestCount = 0;
  const harness = createCanonicalHarness({
    ...boundaryMergeHarnessOptions(),
    translateDeferred: async items => {
      translationRequestCount += 1;
      if (translationRequestCount === 1) {
        return {
          ok: true,
          result: {
            translations: items.map(item => ({
              id: item.id,
              revision: item.revision,
              translated_text: `OLD:${item.original_text}`
            }))
          }
        };
      }
      if (throwError) throw new Error("translation unavailable");
      return {
        ok: true,
        result: {
          translations: [],
          errors: items.map(item => ({
            id: item.id,
            revision: item.revision,
            error: "missing"
          })),
          partial: true
        }
      };
    }
  });
  const firstTarget = reverse ? harness.targets.b : harness.targets.a;
  const secondTarget = reverse ? harness.targets.a : harness.targets.b;
  await harness.pipeline.run(firstTarget);
  harness.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const oldCanonical = harness.store.getCanonicalSnapshot()[0];
  assert.ok(harness.store.getTranslation(oldCanonical.id, oldCanonical.revision));
  await harness.pipeline.run(secondTarget);
  const current = harness.store.getCanonicalSnapshot().find(item => item.memberObservationIds.includes("merge-a") && item.memberObservationIds.includes("merge-b"));
  assert.ok(current);
  assert.equal(harness.store.getTranslation(current.id, current.revision), null);
  const visible = [...harness.store.getAllProjections().values()].flat().filter(projection => projection.activeText && projection.translated_text);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].canonicalId, oldCanonical.id);
  assert.equal(visible[0].provisional, true);
  assert.equal(visible[0].pendingCanonicalId, current.id);
  const requestsBeforeRefresh = translationRequestCount;
  const refresh = () => harness.pipeline.refresh({
    reason: "retry-render",
    focusPageIds: ["page-a", "page-b"]
  });
  if (throwError) {
    await assert.rejects(refresh, /translation unavailable/);
  } else {
    await assert.rejects(refresh, /Translation response omitted 1 canonical item/);
  }
  assert.equal(translationRequestCount, requestsBeforeRefresh + (throwError ? 1 : 2), "a failed revision must be retryable while retaining the prior visible projection");
  const visibleAfter = [...harness.store.getAllProjections().values()].flat().filter(projection => projection.activeText && projection.translated_text);
  assert.equal(visibleAfter.length, 1);
  assert.equal(visibleAfter[0].canonicalId, oldCanonical.id);
  const fallbackRender = harness.renderInputs.findLast(input => String(input.reason || "").includes("translation-fallback") && input.projections.some(projection => projection.provisional === true));
  assert.ok(fallbackRender, "the previous visible projection should be rendered as a fallback");
  assert.equal(fallbackRender.translationComplete, false);
}
async function settleWithin(promise, timeoutMs = 250) {
  let timer = null;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`test operation did not settle within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
test("findKakaoVerticalOverlap returns null for different widths", () => {
  const w1 = {
    width: 96,
    height: 100,
    gray: new Uint8Array(9600)
  };
  const w2 = {
    width: 80,
    height: 100,
    gray: new Uint8Array(8000)
  };
  assert.equal(P.findKakaoVerticalOverlap(w1, w2), null);
});
test("findKakaoVerticalOverlap rejects sparse text mismatches on white panels", () => {
  const width = 96;
  const height = 200;
  const previous = new Uint8Array(width * height).fill(255);
  const current = new Uint8Array(width * height).fill(255);
  const drawTextStroke = (pixels, row, left, right) => {
    for (let y = row; y < row + 2; y += 1) {
      for (let x = left; x < right; x += 1) {
        pixels[y * width + x] = 20;
      }
    }
  };
  [[44, 8, 42], [84, 18, 58], [124, 28, 72], [164, 10, 66]].forEach(([row, left, right]) => drawTextStroke(previous, row, left, right));
  [[30, 35, 82], [70, 5, 30], [110, 42, 90], [150, 20, 48]].forEach(([row, left, right]) => drawTextStroke(current, row, left, right));
  const overlap = P.findKakaoVerticalOverlap({
    width,
    height,
    gray: previous
  }, {
    width,
    height,
    gray: current
  });
  assert.notEqual(overlap, null);
  assert.equal(overlap.accepted, false, JSON.stringify(overlap));
});
test("findKakaoVerticalOverlap accepts matching sparse text on white panels", () => {
  const width = 96;
  const height = 200;
  const previous = new Uint8Array(width * height).fill(255);
  const current = new Uint8Array(width * height).fill(255);
  const drawTextStroke = (pixels, row) => {
    for (let y = row; y < row + 2; y += 1) {
      for (let x = 12; x < 52; x += 1) {
        pixels[y * width + x] = 20;
      }
    }
  };
  [90, 130, 170].forEach(row => drawTextStroke(previous, row));
  [10, 50, 90].forEach(row => drawTextStroke(current, row));
  const overlap = P.findKakaoVerticalOverlap({
    width,
    height,
    gray: previous
  }, {
    width,
    height,
    gray: current
  });
  assert.notEqual(overlap, null);
  assert.equal(overlap.accepted, true);
  assert.ok(overlap.informativeMae <= 1);
});
test("hasUsableKakaoStripCaptureRect validates minimum dimensions", () => {
  assert.equal(P.hasUsableKakaoStripCaptureRect(null), false);
  assert.equal(P.hasUsableKakaoStripCaptureRect({
    width: 100,
    height: 100
  }), false);
  assert.equal(P.hasUsableKakaoStripCaptureRect({
    width: 180,
    height: 180
  }), true);
  assert.equal(P.hasUsableKakaoStripCaptureRect({
    width: 760,
    height: 200
  }), true);
});
test("overlap crop cannot complete a full page from a tiny unique suffix", () => {
  assert.equal(P.hasUsefulKakaoOverlapCrop(857, 143, 1000), false);
  assert.equal(P.hasUsefulKakaoOverlapCrop(750, 250, 1000), true);
  assert.equal(P.hasUsefulKakaoOverlapCrop(100, 120, 500), false);
});

/* =================================================================
 * Pure functions — bubble mapping
 * ================================================================= */
test("mapKakaoStitchedFillBox handles valid input", () => {
  const result = P.mapKakaoStitchedFillBox({
    x: 10,
    y: 20,
    w: 50,
    h: 30
  }, 100, 200, 500);
  assert.notEqual(result, null);
  assert.ok(result.y >= 0);
  assert.ok(result.h > 0);
});
test("mapKakaoStitchedFillBox rejects null", () => {
  assert.equal(P.mapKakaoStitchedFillBox(null, 0, 100, 500), null);
});
test("mapKakaoStitchedFillBox rejects unreasonable height", () => {
  // Height > 300% of owner should be rejected
  const result = P.mapKakaoStitchedFillBox({
    x: 10,
    y: 20,
    w: 50,
    h: 600
  }, 100, 200, 500);
  assert.equal(result, null);
});
test("mapKakaoStitchedPolygon maps points into owner space", () => {
  const points = [{
    x: 10,
    y: 20
  }, {
    x: 20,
    y: 30
  }];
  const result = P.mapKakaoStitchedPolygon(points, 100, 200, 500);
  assert.notEqual(result, null);
  assert.equal(result.length, 2);
});
test("mapKakaoStitchedPolygon handles empty array", () => {
  assert.equal(P.mapKakaoStitchedPolygon([], 0, 100, 500), null);
});
test("computeKakaoGlobalBox computes page-level coordinates", () => {
  const bubble = {
    x: 25,
    y: 50,
    w: 20,
    h: 10
  };
  const rect = {
    left: 100,
    top: 200,
    width: 400,
    height: 800
  };
  const box = P.computeKakaoGlobalBox(bubble, 0, 0, rect);
  assert.notEqual(box, null);
  assert.equal(box.left, 100 + 25 / 100 * 400);
  assert.equal(box.top, 200 + 50 / 100 * 800);
  assert.equal(box.width, 20 / 100 * 400);
  assert.equal(box.height, 10 / 100 * 800);
});
test("computeKakaoGlobalBox handles scroll offset", () => {
  const bubble = {
    x: 0,
    y: 0,
    w: 100,
    h: 100
  };
  const rect = {
    left: 0,
    top: 0,
    width: 100,
    height: 100
  };
  const box = P.computeKakaoGlobalBox(bubble, 500, 300, rect);
  assert.equal(box.left, 500);
  assert.equal(box.top, 300);
});
test("normalizeKakaoStitchSegments derives from provided segments", () => {
  const stitch = {
    segments: [{
      source: "owner",
      drawRect: {
        x: 0,
        y: 50,
        w: 760,
        h: 200
      }
    }]
  };
  const segments = P.normalizeKakaoStitchSegments(stitch, 760, 300, null);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].source, "owner");
});
test("normalizeKakaoStitchSegments falls back to derived segments", () => {
  const stitch = {
    canvasWidth: 760,
    canvasHeight: 400,
    previousSlice: 60,
    nextSlice: 40
  };
  const segments = P.normalizeKakaoStitchSegments(stitch, 760, 400, null);
  assert.ok(segments.length >= 1);
});
test("shouldFallbackFromKakaoStitch requires stitch payload", () => {
  assert.equal(P.shouldFallbackFromKakaoStitch({}, null, null), "");
});
test("shouldFallbackFromKakaoStitch returns reason when no owner text", () => {
  const payload = {
    stitch: true,
    singleImagePayload: {
      dataUrl: "data:,"
    }
  };
  assert.match(P.shouldFallbackFromKakaoStitch(payload, {
    bubbles: []
  }, {
    bubbles: []
  }), /no owner text/);
});
test("shouldFallbackFromKakaoStitch checks drop ratio > 70%", () => {
  const payload = {
    stitch: true,
    singleImagePayload: {
      dataUrl: "data:,"
    }
  };
  const raw = {
    bubbles: [{
      x: 0,
      y: 0,
      w: 10,
      h: 10
    }]
  };
  assert.match(P.shouldFallbackFromKakaoStitch(payload, raw, {
    bubbles: []
  }), /dropped all/);
});

/* =================================================================
 * Debug coordinate mapping
 * ================================================================= */
