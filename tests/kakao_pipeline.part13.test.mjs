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
test("seam composite is cleaned once and atomically replaces both page projections", async () => {
  const options = boundaryMergeHarnessOptions();
  options.seamObservations[0].visual = {
    ...options.seamObservations[0].visual,
    bgType: "solid",
    fillBox: {
      x: 24,
      y: 42,
      w: 52,
      h: 20
    },
    box: {
      x: 24,
      y: 42,
      w: 52,
      h: 20
    },
    regionPolygon: [{
      x: 18,
      y: 38
    }, {
      x: 82,
      y: 38
    }, {
      x: 82,
      y: 66
    }, {
      x: 18,
      y: 66
    }],
    sourceLineCount: 3
  };
  options.seamCleanedImage = "data:image/png;base64,c2VhbS1jbGVhbg==";
  options.seamCleanedImageToken = "seam-artifact-token";
  options.seamDebug = {
    imageWidth: 800,
    imageHeight: 600,
    rawItems: [{
      id: "raw-seam",
      box: {
        left: 160,
        top: 228,
        width: 480,
        height: 168
      }
    }]
  };
  options.seamPayload = {
    dataUrl: "data:image/png;base64,c2VhbQ==",
    width: 800,
    height: 600,
    coordinateSpace: "kakao-seam-v1",
    seam: {
      canvasWidth: 800,
      canvasHeight: 600,
      alignedOverlap: 0,
      segments: [{
        pageId: "page-a",
        drawRect: {
          x: 0,
          y: 0,
          w: 800,
          h: 300
        },
        sourceCrop: {
          x: 0,
          y: 1700,
          w: 800,
          h: 300
        },
        naturalWidth: 800,
        naturalHeight: 2000
      }, {
        pageId: "page-b",
        drawRect: {
          x: 0,
          y: 300,
          w: 800,
          h: 300
        },
        sourceCrop: {
          x: 0,
          y: 0,
          w: 800,
          h: 300
        },
        naturalWidth: 800,
        naturalHeight: 2000
      }]
    }
  };
  const harness = createCanonicalHarness(options);
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  const seamRequests = harness.ocrMetas.filter(meta => meta.sourceType === "seam");
  assert.equal(seamRequests.length, 1);
  assert.equal(seamRequests[0].requireCleanedImage, true);
  assert.equal(seamRequests[0].forceCleanedImageArtifact, true);
  assert.equal(harness.ocrMetas.filter(meta => meta.sourceType === "page" && meta.forceCleanedImageArtifact).length, 0, "a usable composite artifact must suppress per-page cleaned artifacts");
  const seamState = harness.store.getSeamStates().find(state => state.status === "completed");
  assert.ok(seamState);
  assert.equal(seamState.cleanedImage, options.seamCleanedImage);
  assert.equal(seamState.cleanedImageToken, options.seamCleanedImageToken);
  assert.equal(seamState.canvasWidth, 800);
  assert.equal(seamState.canvasHeight, 600);
  assert.deepEqual(seamState.segments, options.seamPayload.seam.segments);
  assert.ok(Object.isFrozen(seamState));
  assert.ok(Object.isFrozen(seamState.segments));
  const debugOnlyBatch = harness.renderInputs.find(input => input.debugOnly === true && input.projectionsByPage instanceof Map && input.seamSurfaces?.some(surface => surface.bubbles.length === 0 && surface.debug));
  assert.ok(debugOnlyBatch, "seam debug must render atomically before translation is available");
  assert.deepEqual([...debugOnlyBatch.projectionsByPage.keys()].sort(), ["page-a", "page-b"]);
  assert.ok(debugOnlyBatch.seamSurfaces.some(surface => surface.diagnostics.some(item => item.reason === "missing_translation")));
  const atomic = harness.renderInputs.findLast(input => input.projectionsByPage instanceof Map && input.seamSurfaces?.some(surface => surface.bubbles.length === 1));
  assert.ok(atomic, "both seam windows should be submitted in one renderer call");
  assert.deepEqual([...atomic.projectionsByPage.keys()].sort(), ["page-a", "page-b"]);
  assert.deepEqual([...atomic.payloadByPage.keys()].sort(), ["page-a", "page-b"]);
  assert.deepEqual([...atomic.debugByPage.keys()].sort(), ["page-a", "page-b"]);
  const [surface] = atomic.seamSurfaces;
  assert.equal(surface.cleanedImage, options.seamCleanedImage);
  assert.equal(surface.cleanedImageToken, options.seamCleanedImageToken);
  assert.equal(surface.artifactFingerprint, options.seamCleanedImageToken);
  assert.equal(surface.bubbles.length, 1);
  assert.ok(surface.diagnostics.some(item => item.reason === "accepted"));
  assert.deepEqual({
    x: surface.bubbles[0].x,
    y: surface.bubbles[0].y,
    w: surface.bubbles[0].w,
    h: surface.bubbles[0].h
  }, {
    x: 18,
    y: 38,
    w: 64,
    h: 28
  }, "solid captions must use the full region polygon instead of the inner OCR text union");
  assert.ok(surface.bubbles[0].y < 50 && surface.bubbles[0].y + surface.bubbles[0].h > 50);
  assert.deepEqual(surface.handledCanonicalIds, Object.keys(surface.canonicalRevisionById));
  for (const projections of atomic.projectionsByPage.values()) {
    assert.equal(projections.some(projection => surface.handledCanonicalIds.includes(projection.canonicalId)), false, "normal page cover/text projections must not coexist with the seam surface");
  }
  const beforeRefresh = {
    renderKey: surface.renderKey,
    layoutKey: surface.layoutKey,
    seamRequests: seamRequests.length
  };
  await harness.pipeline.runCached(harness.targets.a, null, {
    reason: "stable-seam-refresh"
  });
  const refreshed = harness.renderInputs.findLast(input => input.seamSurfaces?.some(item => item.bubbles.length === 1)).seamSurfaces[0];
  assert.equal(refreshed.renderKey, beforeRefresh.renderKey);
  assert.equal(refreshed.layoutKey, beforeRefresh.layoutKey);
  assert.equal(harness.ocrMetas.filter(meta => meta.sourceType === "seam").length, beforeRefresh.seamRequests);
});
test("translated seam geometry suppresses a smaller conflicting page-edge projection", () => {
  const surface = {
    renderKey: "live-seam",
    canvasWidth: 720,
    canvasHeight: 192,
    pageIds: ["page-a", "page-b"],
    segments: [{
      pageId: "page-a",
      drawRect: {
        x: 0,
        y: 0,
        w: 720,
        h: 96
      },
      sourceCrop: {
        x: 0,
        y: 1004,
        w: 720,
        h: 96
      },
      naturalWidth: 720,
      naturalHeight: 1100
    }, {
      pageId: "page-b",
      drawRect: {
        x: 0,
        y: 96,
        w: 720,
        h: 96
      },
      sourceCrop: {
        x: 0,
        y: 0,
        w: 720,
        h: 96
      },
      naturalWidth: 720,
      naturalHeight: 1100
    }],
    bubbles: [{
      x: 7.52,
      y: 37.13,
      w: 57.05,
      h: 28.88,
      region_type: "speech_bubble",
      original_text: "다준이ㅋㅋㅋㅋ작곡 잘하네",
      translated_text: "多俊哈哈哈哈，作曲得真好"
    }],
    handledCanonicalIds: ["canonical-seam"]
  };
  const projections = new Map([["page-a", [{
    canonicalId: "canonical-small-wrong",
    role: "primary",
    activeText: true,
    geometry: {
      left: 36.91,
      top: 98.45,
      width: 26.88,
      height: 1.55
    },
    bubble: {
      region_type: "caption_panel"
    },
    original_text: "그자고자하니는",
    translated_text: "那个想睡觉的人"
  }]]]);
  assert.deepEqual([...P.collectSeamSuppressedCanonicalIds(surface, projections)], ["canonical-small-wrong"]);
});
test("canonical pipeline translates interior observations while edge candidates wait", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "inside", 40, "interior"), makeCanonicalObservation("page-a", "rev-a", "edge", 96, "edge")],
      b: []
    }
  });
  const result = await harness.pipeline.run(harness.targets.a);
  assert.equal(result.ok, true);
  assert.equal(result.pendingEdge, true);
  const translateCalls = harness.calls.filter(call => call.startsWith("translate:"));
  assert.equal(translateCalls.length, 1);
  assert.match(translateCalls[0], /:interior/);
  assert.doesNotMatch(translateCalls[0], /:edge(?:,|$)/);
  assert.equal(harness.timers[0].delay, 8000);
});
