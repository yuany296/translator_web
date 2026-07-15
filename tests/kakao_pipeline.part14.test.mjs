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
test("edge timeout releases authoritative page observation without seam evidence", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "edge-timeout", 96, "late edge")],
      b: []
    }
  });
  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.calls.some(call => call.startsWith("translate:")), false);
  harness.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.calls.some(call => call.includes(":late edge")));
  assert.equal(harness.store.getEdgeWait("page-a").timedOut, true);
});
test("seam OCR failure is isolated and both page observations still translate", async () => {
  const harness = createCanonicalHarness({
    seamFailure: true,
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "edge-a", 96, "A tail")],
      b: [makeCanonicalObservation("page-b", "rev-b", "edge-b", 0, "B head")]
    }
  });
  const first = await harness.pipeline.run(harness.targets.a);
  const second = await harness.pipeline.run(harness.targets.b);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:page:")).length, 2);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:seam:")).length, 1);
  assert.equal(harness.store.getObservations().filter(item => item.sourceType === "page").length, 2);
  assert.ok(harness.store.getCanonicalSnapshot().length >= 2);
  assert.ok(harness.calls.some(call => call.includes(":A tail")));
  assert.ok(harness.calls.some(call => call.includes(":B head")));
  const seamState = harness.store.getSeamStates()[0];
  assert.equal(seamState.status, "failed");
});
test("seam evidence decision failure cannot fail either authoritative page", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "edge-a", 94, "upper")],
      b: [makeCanonicalObservation("page-b", "rev-b", "edge-b", 0, "lower")]
    }
  });
  const first = await harness.pipeline.run(harness.targets.a);
  const originalGetObservationsForPage = harness.store.getObservationsForPage.bind(harness.store);
  let throwOnce = true;
  harness.store.getObservationsForPage = (...args) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("seam decision unavailable");
    }
    return originalGetObservationsForPage(...args);
  };
  const second = await harness.pipeline.run(harness.targets.b);
  const seamState = harness.store.getSeamStates().find(item => item.pageIds.includes("page-a"));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(seamState.status, "failed");
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getPageTerminal("page-b").state, "ready");
  assert.equal(harness.calls.includes("retry"), false);
});
test("a concurrent seam caller joins the running revisioned pair", async () => {
  let releaseSeamPayload;
  let markSeamPayload;
  const seamPayloadStarted = new Promise(resolve => {
    markSeamPayload = resolve;
  });
  const seamPayloadGate = new Promise(resolve => {
    releaseSeamPayload = resolve;
  });
  let payloadCalls = 0;
  const harness = createCanonicalHarness({
    pixelRisk: {
      accepted: true,
      overlapRatio: 0.3
    },
    adapterOverrides: {
      buildKakaoSeamPayload: async () => {
        payloadCalls += 1;
        markSeamPayload();
        await seamPayloadGate;
        return {
          dataUrl: "data:image/png;base64,seam",
          width: 800,
          height: 320
        };
      }
    }
  });
  const pageA = harness.store.registerPageHandle({
    ...harness.identities.a,
    target: harness.targets.a,
    payload: {
      dataUrl: "data:image/png;base64,a"
    },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  const pageB = harness.store.registerPageHandle({
    ...harness.identities.b,
    target: harness.targets.b,
    payload: {
      dataUrl: "data:image/png;base64,b"
    },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  const first = harness.pipeline.processSeamPair(pageA, pageB);
  await seamPayloadStarted;
  let secondResolved = false;
  const second = harness.pipeline.processSeamPair(pageA, pageB).then(value => {
    secondResolved = true;
    return value;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondResolved, false, "running seam state must join the inflight promise");
  releaseSeamPayload();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "completed");
  assert.equal(secondResult.status, "completed");
  assert.equal(payloadCalls, 1);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:seam:")).length, 1);
});
test("completed seam evidence publishes a canonical refresh without its initiating page job", async () => {
  const pageAObservation = {
    ...makeCanonicalObservation("page-a", "rev-a", "orphan-a", 94, "A tail"),
    visual: {
      regionType: "speech",
      regionHash: "same",
      bgType: "solid"
    }
  };
  const pageBObservation = {
    ...makeCanonicalObservation("page-b", "rev-b", "orphan-b", 0, "B head"),
    visual: {
      regionType: "speech",
      regionHash: "same",
      bgType: "solid"
    }
  };
  const seamObservation = {
    id: "orphan-seam",
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
      overlapRatio: 0.5
    }, {
      pageId: "page-b",
      box: {
        x: 20,
        y: 0,
        w: 20,
        h: 6
      },
      overlapRatio: 0.5
    }],
    originalText: "A tail B head",
    confidence: 0.99,
    visual: {
      regionType: "speech",
      regionHash: "same",
      bgType: "solid"
    },
    providerBlockId: "orphan-seam"
  };
  const harness = createCanonicalHarness({
    pixelRisk: {
      accepted: true,
      overlapRatio: 0.3
    },
    seamObservations: [seamObservation]
  });
  const pageA = harness.store.registerPageHandle({
    ...harness.identities.a,
    target: harness.targets.a,
    payload: {
      dataUrl: "data:image/png;base64,a"
    },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  const pageB = harness.store.registerPageHandle({
    ...harness.identities.b,
    target: harness.targets.b,
    payload: {
      dataUrl: "data:image/png;base64,b"
    },
    pageOcrState: "ready",
    edgeSides: Object.freeze([]),
    adjacentTargets: Object.freeze([])
  });
  harness.store.markPageTerminal("page-a", "ready", {
    imageRevision: "rev-a"
  });
  harness.store.markPageTerminal("page-b", "ready", {
    imageRevision: "rev-b"
  });
  harness.store.upsertObservations([pageAObservation, pageBObservation]);
  const terminal = await harness.pipeline.processSeamPair(pageA, pageB);
  assert.equal(terminal.status, "completed");
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const merged = harness.store.getCanonicalSnapshot().find(canonical => canonical.memberObservationIds.includes("orphan-a") && canonical.memberObservationIds.includes("orphan-b") && canonical.memberObservationIds.includes("orphan-seam"));
  assert.ok(merged, "seam terminal must independently publish its new semantic evidence");
  assert.ok(harness.store.getTranslation(merged.id, merged.revision));
});
test("seam OCR is evidence-triggered and skipped for ordinary interior pages", async () => {
  const harness = createCanonicalHarness();
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.calls.some(call => call.startsWith("seam-payload:")), false);
  assert.equal(harness.calls.some(call => call.startsWith("ocr:seam:")), false);
  assert.equal(harness.store.getSeamStates()[0].status, "skipped");
});
