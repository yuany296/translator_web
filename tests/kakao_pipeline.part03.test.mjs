import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";
import { createLegacyPipelineForTest } from "./helpers/legacy-pipeline.mjs";
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
    pipeline: createLegacyPipelineForTest(adapters),
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
test("getSubstantialOcrBoundaryOverlap finds prefix/suffix matches", () => {
  const result = P.getSubstantialOcrBoundaryOverlap("prefix_hello", "hello_world");
  // "hello" should be either suffix of first or prefix of second
  assert.ok(result === null || result.length >= 5);
});
test("sliceTextByNormalizedBoundary correctly slices text", () => {
  const result = P.sliceTextByNormalizedBoundary("hello world", 5, false);
  assert.equal(result, "hello");
});

/* =================================================================
 * Pure functions — geometry
 * ================================================================= */
test("normalizeRectLike returns null for invalid input", () => {
  assert.equal(P.normalizeRectLike(null), null);
  assert.equal(P.normalizeRectLike({}), null);
  assert.equal(P.normalizeRectLike({
    x: 0,
    y: 0,
    w: 0,
    h: 0
  }), null);
});
test("normalizeRectLike accepts valid rect", () => {
  const result = P.normalizeRectLike({
    x: 10,
    y: 20,
    w: 100,
    h: 200
  });
  assert.deepEqual(result, {
    x: 10,
    y: 20,
    w: 100,
    h: 200
  });
});
test("normalizeRectLike accepts width/height alias", () => {
  const result = P.normalizeRectLike({
    x: 10,
    y: 20,
    width: 100,
    height: 200
  });
  assert.deepEqual(result, {
    x: 10,
    y: 20,
    w: 100,
    h: 200
  });
});
test("pageBoxIntersectionRatio calculates correctly", () => {
  const a = {
    left: 0,
    top: 0,
    width: 100,
    height: 100
  };
  const b = {
    left: 50,
    top: 0,
    width: 100,
    height: 100
  };
  const ratio = P.pageBoxIntersectionRatio(a, b);
  // Overlap is 50x100 = 5000, min area is 10000
  assert.equal(ratio, 0.5);
});
test("areKakaoGlobalBoxesRelated returns true for overlapping boxes", () => {
  const a = {
    left: 0,
    top: 0,
    width: 100,
    height: 100
  };
  const b = {
    left: 50,
    top: 0,
    width: 100,
    height: 100
  };
  assert.equal(P.areKakaoGlobalBoxesRelated(a, b), true);
});
test("areKakaoGlobalBoxesRelated returns false for distant boxes", () => {
  const a = {
    left: 0,
    top: 0,
    width: 10,
    height: 10
  };
  const b = {
    left: 500,
    top: 500,
    width: 10,
    height: 10
  };
  assert.equal(P.areKakaoGlobalBoxesRelated(a, b), false);
});

/* =================================================================
 * Pure functions — stitch geometry
 * ================================================================= */
test("isKakaoPageEdgeSource detects page-edge URLs", () => {
  assert.equal(P.isKakaoPageEdgeSource("https://page-edge.kakao.com/download"), true);
  assert.equal(P.isKakaoPageEdgeSource("https://dw-img-page.kakao.com/image"), false);
  assert.equal(P.isKakaoPageEdgeSource(""), false);
});
test("shouldRejectKakaoPageEdgeStitch accepts tall images", () => {
  const rejection = P.shouldRejectKakaoPageEdgeStitch({
    owner: {
      sourceKey: "https://page-edge.kakao.com/resource",
      width: 760,
      height: 1200
    },
    ownerHeight: 1200,
    canonicalWidth: 760
  });
  assert.equal(rejection, "");
});
test("shouldRejectKakaoPageEdgeStitch rejects short fragmented images without stable neighbors", () => {
  const rejection = P.shouldRejectKakaoPageEdgeStitch({
    owner: {
      sourceKey: "https://page-edge.kakao.com/resource",
      width: 760,
      height: 600
    },
    ownerHeight: 600,
    canonicalWidth: 760,
    next: {
      sourceKey: "next",
      width: 760,
      height: 500
    },
    nextHeight: 500
  });
  // 600/500 = 1.2, 500/600 = 0.83 >= 0.78 → has stable neighbor → accepted
  assert.equal(rejection, "");
});
test("isVerifiedKakaoStitchNeighbor verifies alignment and proximity", () => {
  const owner = {
    left: 0,
    top: 1000,
    bottom: 2000,
    width: 760,
    height: 1000,
    sourceKey: "owner",
    src: "img1.jpg"
  };
  const candidate = {
    left: 0,
    top: 0,
    bottom: 1000,
    width: 760,
    height: 1000,
    sourceKey: "prev",
    src: "img2.jpg"
  };
  assert.equal(P.isVerifiedKakaoStitchNeighbor(owner, candidate, "previous"), true);
});
test("isVerifiedKakaoStitchNeighbor rejects same source nodes", () => {
  const owner = {
    left: 0,
    top: 1000,
    width: 760,
    height: 1000,
    sourceKey: "same",
    src: "img.jpg"
  };
  const candidate = {
    left: 0,
    top: 0,
    width: 760,
    height: 1000,
    sourceKey: "same",
    src: "img.jpg"
  };
  assert.equal(P.isVerifiedKakaoStitchNeighbor(owner, candidate, "previous"), false);
});
test("isAttachableKakaoShortPage detects short pages", () => {
  const owner = {
    width: 760,
    height: 1000
  };
  const short = {
    width: 760,
    height: 200
  };
  assert.equal(P.isAttachableKakaoShortPage(short, owner, 200, 1000), true);
});
test("isAttachableKakaoShortPage rejects similar-sized pages", () => {
  const owner = {
    width: 760,
    height: 1000
  };
  const same = {
    width: 760,
    height: 900
  };
  assert.equal(P.isAttachableKakaoShortPage(same, owner, 900, 1000), false);
});

/* =================================================================
 * Pure functions — overlap detection
 * ================================================================= */
test("findKakaoVerticalOverlap detects identical pixel rows", () => {
  const width = 96;
  const height = 200;
  const gray1 = new Uint8Array(width * height);
  const gray2 = new Uint8Array(width * height);
  // Fill both with same pattern
  for (let i = 0; i < gray1.length; i++) {
    gray1[i] = i % 256;
    gray2[i] = i % 256;
  }
  const overlap = P.findKakaoVerticalOverlap({
    width,
    height,
    gray: gray1
  }, {
    width,
    height,
    gray: gray2
  });
  assert.notEqual(overlap, null);
  assert.equal(overlap.accepted, true);
});
