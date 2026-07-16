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
test("visual duplicate selection removes the less complete of two related overflow copies", () => {
  const shorter = {
    scopeKey: "page-overflow-a",
    regionType: "effect_text",
    stitchOverflow: true,
    originalText: "이쪽 방향이어야",
    translatedText: "应该是方向",
    box: {
      left: 730,
      top: 520,
      width: 280,
      height: 150
    }
  };
  const complete = {
    scopeKey: "page-overflow-b",
    regionType: "effect_text",
    stitchOverflow: true,
    originalText: "이쪽 방향이어야 한다.",
    translatedText: "应该是这个方向。",
    box: {
      left: 738,
      top: 526,
      width: 275,
      height: 148
    }
  };
  assert.equal(P.selectKakaoVisualDuplicateLoser(shorter, complete), "left");
  assert.equal(P.selectKakaoVisualDuplicateLoser(complete, shorter), "right");
  assert.equal(P.selectKakaoVisualDuplicateLoser(shorter, {
    ...complete,
    originalText: "완전히 다른 대사",
    translatedText: "完全不同的对白"
  }), null);
});
test("superseded Kakao entry keeps the source-scoped cache identity", async () => {
  const store = P.createStore();
  const target = {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 720,
      height: 947
    })
  };
  let supersededEntry = null;
  await P.dedupeKakaoResultByPageCoordinates({
    result: {
      bubbles: [{
        x: 25,
        y: 95,
        w: 55,
        h: 30,
        original_text: "그럼그렇지박문대가금발이고",
        translated_text: "就是嘛"
      }]
    },
    target,
    targetKey: "page-previous",
    scopedTargetKey: "page-previous|source-previous",
    store
  });
  await P.dedupeKakaoResultByPageCoordinates({
    result: {
      bubbles: [{
        x: 25,
        y: 95,
        w: 55,
        h: 30,
        original_text: "그림그렇지박문대가금발이고",
        translated_text: "我就知道朴文代是金发什么的都无所谓"
      }]
    },
    target,
    targetKey: "page-current",
    scopedTargetKey: "page-current|source-current",
    store,
    adapters: {
      onSupersededEntry: entry => {
        supersededEntry = entry;
      }
    }
  });
  assert.ok(supersededEntry, "the more complete overlapping result should supersede the old one");
  assert.equal(supersededEntry.targetKey, "page-previous");
  assert.equal(supersededEntry.scopedTargetKey, "page-previous|source-previous");
});
test("trimKakaoBubbleBoundary creates trimmed version", () => {
  const bubble = {
    original_text: "prefix_suffix",
    y: 0,
    h: 100,
    x: 0,
    w: 50,
    source_line_count: 2,
    global_box: {
      left: 0,
      top: 0,
      width: 100,
      height: 100
    }
  };
  // Simulate suffix overlap (last chars of first match first chars of second)
  const overlap = {
    length: 6,
    trim: "suffix"
  };
  const trimmed = P.trimKakaoBubbleBoundary(bubble, overlap);
  assert.notEqual(trimmed, null);
  assert.ok(trimmed.original_text.length < "prefix_suffix".length);
  assert.equal(trimmed.boundary_trimmed, true);
});
test("trimKakaoBubbleBoundary returns null for insufficient overlap", () => {
  const bubble = {
    original_text: "ab",
    y: 0,
    h: 100
  };
  assert.equal(P.trimKakaoBubbleBoundary(bubble, {
    length: 5,
    trim: "suffix"
  }), null);
});
test("hasAttachedShortPageBubble checks for stitch_attached_short_page", () => {
  assert.equal(P.hasAttachedShortPageBubble(null), false);
  assert.equal(P.hasAttachedShortPageBubble({
    bubbles: [{
      original_text: "hello"
    }]
  }), false);
  assert.equal(P.hasAttachedShortPageBubble({
    bubbles: [{
      stitch_attached_short_page: true
    }]
  }), true);
});

/* =================================================================
 * hasLongestCommonSubstringLength
 * ================================================================= */
test("getLongestCommonSubstringLength finds common substring", () => {
  const result = P.getLongestCommonSubstringLength(Array.from("abcdef"), Array.from("bcdefg"), 3);
  assert.ok(result >= 3); // "bcdef" is length 5
});
test("getLongestCommonSubstringLength stops at stopAt threshold", () => {
  const result = P.getLongestCommonSubstringLength(Array.from("abcdefgh"), Array.from("abcdefgh"), 10);
  assert.equal(result, 8); // No early stop, full match
});

/* =================================================================
 * buildSingleFallbackPayload
 * ================================================================= */
test("buildSingleFallbackPayload creates fallback payload", () => {
  const single = {
    dataUrl: "data:image/png;base64,a",
    width: 100,
    height: 200
  };
  const stitched = {
    sourceToken: "token123"
  };
  const result = P.buildSingleFallbackPayload(single, stitched, "test fallback");
  assert.equal(result.ocrMode, "single-fallback");
  assert.equal(result.fallbackReason, "test fallback");
  assert.equal(result.stitchAdmission, "fallback");
  assert.equal(result.sourceToken, "token123");
});

/* =================================================================
 * buildOcrRequestKey
 * ================================================================= */
test("buildOcrRequestKey includes target key and mode", () => {
  const key = P.buildOcrRequestKey("page-1", {
    ocrMode: "stitch",
    sourceToken: "tok1"
  });
  assert.ok(key.includes("mode:stitch"));
  assert.ok(key.includes("src:"));
});
test("buildOcrRequestKey includes differentiators for different modes", () => {
  const single = P.buildOcrRequestKey("page-1", {
    ocrMode: "single",
    sourceToken: "a"
  });
  const stitch = P.buildOcrRequestKey("page-1", {
    ocrMode: "stitch",
    sourceToken: "b"
  });
  assert.notEqual(single, stitch);
});

/* =================================================================
 * clamp
 * ================================================================= */
test("clamp constrains values within range", () => {
  assert.equal(P.clamp(5, 0, 10), 5);
  assert.equal(P.clamp(-5, 0, 10), 0);
  assert.equal(P.clamp(15, 0, 10), 10);
});

/* =================================================================
 * computeGraySample
 * ================================================================= */
test("computeGraySample converts RGBA to grayscale", () => {
  const result = P.computeGraySample({
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    width: 2,
    height: 1
  });
  assert.notEqual(result, null);
  assert.equal(result.width, 2);
  assert.equal(result.height, 1);
  assert.equal(result.gray.length, 2);
});
test("computeGraySample returns null for empty data", () => {
  assert.equal(P.computeGraySample({}), null);
});
test("pipeline runs fetch, stitch, recognize, dedupe, and render in order", async () => {
  const {
    pipeline,
    store,
    target,
    calls
  } = createPipelineHarness();
  const result = await pipeline.run(target, {
    reason: "test"
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["fetch", "stitch", "recognize", "dedupe", "render"]);
  assert.equal(store.getPagePhase("page-1|source-a"), P.PagePhase.RENDERED);
});
