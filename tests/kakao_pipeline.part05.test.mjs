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
/* =================================================================
 * Debug coordinate mapping
 * ================================================================= */
test("normalizeDebugCoordinateItems returns items as-is without stitch context", () => {
  const items = [{
    percent: {
      x: 10,
      y: 10,
      w: 20,
      h: 20
    }
  }];
  const result = P.normalizeDebugCoordinateItems(items, {}, null);
  assert.deepEqual(result, items);
});
test("normalizeDebugCoordinateItems handles empty array", () => {
  assert.deepEqual(P.normalizeDebugCoordinateItems([], {}, null), []);
});
test("getDebugItemPercent extracts percent from item", () => {
  const item = {
    percent: {
      x: 10,
      y: 20,
      w: 30,
      h: 40
    }
  };
  const result = P.getDebugItemPercent(item, 100, 200);
  assert.deepEqual(result, {
    x: 10,
    y: 20,
    w: 30,
    h: 40
  });
});
test("getDebugItemPercent computes from rawBox", () => {
  const item = {
    rawBox: {
      left: 10,
      top: 20,
      width: 30,
      height: 40
    }
  };
  const result = P.getDebugItemPercent(item, 100, 200);
  assert.deepEqual(result, {
    x: 10,
    y: 10,
    w: 30,
    h: 20
  });
});

/* =================================================================
 * Debug bubble filtering
 * ================================================================= */
test("filterOcrDebugFinalBubbles returns debug as-is when not an object", () => {
  assert.equal(P.filterOcrDebugFinalBubbles(null, []), null);
  assert.equal(P.filterOcrDebugFinalBubbles(undefined, []), undefined);
});
test("filterOcrDebugFinalBubbles keeps only bubbles whose IDs exist", () => {
  const debug = {
    finalBubbles: [{
      blockId: "1",
      text: "keep"
    }, {
      blockId: "2",
      text: "drop"
    }],
    items: []
  };
  const bubbles = [{
    block_id: "1"
  }];
  const result = P.filterOcrDebugFinalBubbles(debug, bubbles);
  assert.equal(result.finalBubbles.length, 1);
  assert.equal(result.finalBubbles[0].text, "keep");
});
test("syncOcrDebugFinalBubbles enriches finalBubbles with bubble data", () => {
  const debug = {
    finalBubbles: [{
      blockId: "1"
    }],
    items: []
  };
  const bubbles = [{
    block_id: "1",
    original_text: "hello",
    translated_text: "world",
    x: 10,
    y: 20,
    w: 30,
    h: 40
  }];
  const result = P.syncOcrDebugFinalBubbles(debug, bubbles);
  assert.equal(result.finalBubbles[0].text, "hello");
  assert.equal(result.finalBubbles[0].translatedText, "world");
});

/* =================================================================
 * Dedupe helpers
 * ================================================================= */
test("isKakaoBoundaryNeighborBubble checks stitch_boundary_neighbor flag", () => {
  assert.equal(P.isKakaoBoundaryNeighborBubble({
    stitch_boundary_neighbor: true
  }), true);
  assert.equal(P.isKakaoBoundaryNeighborBubble({}), false);
  assert.equal(P.isKakaoBoundaryNeighborBubble(null), false);
});
test("isKakaoGlobalDuplicateCandidate detects duplicate from overlapping box + similar text", () => {
  const candidate = {
    box: {
      left: 0,
      top: 0,
      width: 100,
      height: 100
    },
    text: "hello world",
    translatedText: "你好世界",
    bubble: {}
  };
  const entry = {
    box: {
      left: 10,
      top: 10,
      width: 80,
      height: 80
    },
    text: "hello world",
    translatedText: "你好世界",
    completeness: 10
  };
  // Boxes overlap, texts identical
  assert.equal(P.isKakaoGlobalDuplicateCandidate(candidate, entry), true);
});
test("cross-page overflow dedupe uses strong geometry when OCR texts disagree", () => {
  const ownerEntry = {
    box: {
      left: 697.98,
      top: 320.79,
      width: 449.71,
      height: 291.9
    },
    text: "꼬를존풍하지않는행동시퇴깡조시됩니다",
    translatedText: "不尊重规则者将被驱逐",
    targetKey: "page-owner",
    bubble: {
      region_type: "caption_panel"
    }
  };
  const overflowCandidate = {
    box: {
      left: 719.41,
      top: 432.48,
      width: 415.15,
      height: 176.54
    },
    text: "퇴깡않는행동께꼬끼됩니다",
    translatedText: "因为你不肯罢休事情变得棘手了",
    targetKey: "page-overflow",
    bubble: {
      region_type: "caption_panel",
      stitch_overflow: true
    }
  };
  assert.equal(P.isKakaoGlobalDuplicateCandidate(overflowCandidate, ownerEntry), true);
});
test("geometry-only overflow dedupe keeps same-page and different-region bubbles", () => {
  const box = {
    left: 100,
    top: 200,
    width: 300,
    height: 180
  };
  const candidate = {
    box,
    text: "완전히다른문장",
    translatedText: "完全不同的句子",
    targetKey: "page-a",
    bubble: {
      region_type: "caption_panel",
      stitch_overflow: true
    }
  };
  const samePage = {
    box,
    text: "겹치지만별개문장",
    translatedText: "重叠但独立的句子",
    targetKey: "page-a",
    bubble: {
      region_type: "caption_panel"
    }
  };
  const differentRegion = {
    ...samePage,
    targetKey: "page-b",
    bubble: {
      region_type: "effect_text"
    }
  };
  assert.equal(P.isKakaoGlobalDuplicateCandidate(candidate, samePage), false);
  assert.equal(P.isKakaoGlobalDuplicateCandidate(candidate, differentRegion), false);
});
test("visual duplicate selection keeps the owner box over an overflow copy", () => {
  const owner = {
    scopeKey: "page-owner",
    regionType: "caption_panel",
    stitchOverflow: false,
    box: {
      left: 697.98,
      top: 543.77,
      width: 449.71,
      height: 291.9
    }
  };
  const overflow = {
    scopeKey: "page-overflow",
    regionType: "caption_panel",
    stitchOverflow: true,
    box: {
      left: 719.41,
      top: 654.47,
      width: 415.15,
      height: 176.54
    }
  };
  assert.equal(P.selectKakaoVisualDuplicateLoser(owner, overflow), "right");
  assert.equal(P.selectKakaoVisualDuplicateLoser(overflow, owner), "left");
  assert.equal(P.selectKakaoVisualDuplicateLoser(owner, {
    ...overflow,
    scopeKey: owner.scopeKey
  }), null);
  assert.equal(P.selectKakaoVisualDuplicateLoser(owner, {
    ...overflow,
    regionType: "effect_text"
  }), null);
});
