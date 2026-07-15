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
test("a stale OCR rejection cannot fail or retry the current generation", async () => {
  let rejectOldOcr;
  let releaseNewOcr;
  let markOldOcr;
  let markNewOcr;
  const oldOcrStarted = new Promise(resolve => {
    markOldOcr = resolve;
  });
  const newOcrStarted = new Promise(resolve => {
    markNewOcr = resolve;
  });
  const oldOcrGate = new Promise((_resolve, reject) => {
    rejectOldOcr = reject;
  });
  const newOcrGate = new Promise(resolve => {
    releaseNewOcr = resolve;
  });
  let ocrCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      }),
      buildPageIdentity: async target => ({
        chapterId: "chapter",
        pageId: "page-a",
        imageRevision: `rev-${target.generation}`,
        width: 800,
        height: 2000,
        readingOrder: 1
      }),
      requestOcrForPayload: async (_payload, meta) => {
        ocrCalls += 1;
        if (ocrCalls === 1) {
          markOldOcr();
          await oldOcrGate;
        } else {
          markNewOcr();
          await newOcrGate;
        }
        const revision = meta.imageRevisionByPage["page-a"];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, revision)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });
  const oldRun = harness.pipeline.run(harness.targets.a);
  await oldOcrStarted;
  harness.targets.a.generation = 1;
  const newRun = harness.pipeline.run(harness.targets.a);
  await newOcrStarted;
  rejectOldOcr(new Error("late old failure"));
  const oldResult = await oldRun;
  assert.equal(oldResult.skipped, true);
  assert.equal(harness.calls.includes("retry"), false);
  releaseNewOcr();
  const newResult = await newRun;
  assert.equal(newResult.ok, true);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.calls.includes("retry"), false);
});
test("an older clone OCR failure cannot overwrite a newer revision terminal", async () => {
  let rejectOldOcr;
  let markOldOcr;
  const oldOcrStarted = new Promise(resolve => {
    markOldOcr = resolve;
  });
  const oldOcrGate = new Promise((_resolve, reject) => {
    rejectOldOcr = reject;
  });
  const oldClone = {
    name: "a",
    sourceToken: "clone-old",
    generation: 0,
    revision: "rev-old",
    isConnected: true
  };
  const newClone = {
    name: "a",
    sourceToken: "clone-new",
    generation: 0,
    revision: "rev-new",
    isConnected: true
  };
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      }),
      getTargetForKakaoPageId: () => newClone,
      buildPageIdentity: async target => ({
        chapterId: "chapter",
        pageId: "page-a",
        imageRevision: target.revision,
        width: 800,
        height: 2000,
        readingOrder: 1
      }),
      requestOcrForPayload: async (_payload, meta) => {
        const revision = meta.imageRevisionByPage["page-a"];
        if (revision === "rev-old") {
          markOldOcr();
          await oldOcrGate;
        }
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation("page-a", revision, `obs-${revision}`, 40, revision)],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });
  const oldRun = harness.pipeline.run(oldClone);
  await oldOcrStarted;
  const newResult = await harness.pipeline.run(newClone);
  rejectOldOcr(new Error("old clone failed late"));
  const oldResult = await oldRun;
  assert.equal(newResult.ok, true);
  assert.equal(oldResult.skipped, true);
  assert.equal(harness.store.getPageHandle("page-a").imageRevision, "rev-new");
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getPageTerminal("page-a").details.imageRevision, "rev-new");
  assert.equal(harness.calls.includes("retry"), false);
});
test("an old ready terminal cannot make a new running revision seam-ready", async () => {
  let releaseNewRevisionOcr;
  let markNewRevisionOcr;
  const newRevisionOcrStarted = new Promise(resolve => {
    markNewRevisionOcr = resolve;
  });
  const newRevisionGate = new Promise(resolve => {
    releaseNewRevisionOcr = resolve;
  });
  let pageAOcrCalls = 0;
  let seamCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      buildPageIdentity: async target => ({
        chapterId: "chapter",
        pageId: `page-${target.name}`,
        imageRevision: `rev-${target.name}-${target.generation}`,
        width: 800,
        height: 2000,
        readingOrder: target.name === "a" ? 1 : 2
      }),
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType === "seam") {
          seamCalls += 1;
          return {
            ok: true,
            result: {
              observations: [],
              filteredObservations: [],
              edgeSignals: {}
            }
          };
        }
        const pageId = meta.pageIds[0];
        const revision = meta.imageRevisionByPage[pageId];
        if (pageId === "page-a") {
          pageAOcrCalls += 1;
          if (pageAOcrCalls === 2) {
            markNewRevisionOcr();
            await newRevisionGate;
          }
        }
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation(pageId, revision, `obs-${revision}`, pageId === "page-a" ? 94 : 0, pageId === "page-a" ? "upper" : "lower")],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });
  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  harness.targets.a.generation = 1;
  const newRevisionRun = harness.pipeline.run(harness.targets.a);
  await newRevisionOcrStarted;
  const neighborResult = await harness.pipeline.run(harness.targets.b);
  assert.equal(neighborResult.ok, true);
  assert.equal(seamCalls, 0, "the neighbor must wait for the current page revision OCR");
  releaseNewRevisionOcr();
  const newRevisionResult = await newRevisionRun;
  assert.equal(newRevisionResult.ok, true);
  assert.equal(seamCalls, 1);
});
test("same-page same-revision OCR recapture atomically replaces the prior capture", async () => {
  const pageObservations = {
    a: [makeCanonicalObservation("page-a", "rev-a", "capture-old", 40, "old OCR text")],
    b: []
  };
  const harness = createCanonicalHarness({
    pageObservations
  });
  await harness.pipeline.run(harness.targets.a, {
    reason: "first-capture"
  });
  pageObservations.a = [makeCanonicalObservation("page-a", "rev-a", "capture-new", 40, "corrected OCR text")];
  await harness.pipeline.run(harness.targets.a, {
    reason: "recapture"
  });
  const observations = harness.store.getObservationsForPage("page-a", {
    includeFiltered: true
  });
  const canonicals = harness.store.getCanonicalSnapshot();
  assert.deepEqual(observations.map(item => item.id), ["capture-new"]);
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0].originalText, "corrected OCR text");
  assert.deepEqual(canonicals[0].memberObservationIds, ["capture-new"]);
  assert.equal(harness.store.getCoverageLedger().has("capture-old"), false);
});
