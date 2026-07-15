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
test("pipeline merges duplicate requests for the same page identity", async () => {
  let resolveRequest;
  const request = new Promise(resolve => {
    resolveRequest = resolve;
  });
  const harness = createPipelineHarness({
    requestTranslationForPayload: () => request
  });
  const first = harness.pipeline.run(harness.target, {
    reason: "first"
  });
  const second = harness.pipeline.run(harness.target, {
    reason: "second"
  });
  assert.equal(first, second);
  resolveRequest({
    ok: true,
    result: {
      bubbles: []
    }
  });
  assert.equal((await first).ok, true);
});
test("cached pipeline follows dedupe and render without fetch or recognize", async () => {
  const harness = createPipelineHarness({
    renderCachedPipelineResult: async () => {
      harness.calls.push("cached-render");
    }
  });
  const result = await harness.pipeline.runCached(harness.target, {
    bubbles: [{
      original_text: "cached",
      x: 1,
      y: 1,
      w: 10,
      h: 10
    }]
  }, {
    reason: "cache"
  });
  assert.equal(result.reused, true);
  assert.deepEqual(harness.calls, ["dedupe", "cached-render"]);
  assert.equal(harness.store.getPagePhase("page-1|source-a"), P.PagePhase.RENDERED);
});
test("pipeline cancels a late result after the source token changes", async () => {
  let resolveRequest;
  const request = new Promise(resolve => {
    resolveRequest = resolve;
  });
  const harness = createPipelineHarness({
    requestTranslationForPayload: () => request
  });
  const pending = harness.pipeline.run(harness.target, {
    reason: "stale"
  });
  await Promise.resolve();
  harness.target.sourceToken = "source-b";
  resolveRequest({
    ok: true,
    result: {
      bubbles: []
    }
  });
  const result = await pending;
  assert.equal(result.skipped, true);
  assert.match(result.reason, /cancelled:sourceChanged/);
  assert.equal(harness.calls.includes("render"), false);
  assert.equal(harness.store.getPagePhase("page-1|source-a"), P.PagePhase.CANCELLED);
});
test("pipeline failure moves the page to failed without leaking an inflight job", async () => {
  const harness = createPipelineHarness({
    requestTranslationForPayload: async () => {
      throw new Error("network failed");
    }
  });
  const result = await harness.pipeline.run(harness.target, {
    reason: "error"
  });
  assert.equal(result.ok, false);
  assert.equal(harness.store.getPagePhase("page-1|source-a"), P.PagePhase.FAILED);
  harness.adapters.requestTranslationForPayload = async () => ({
    ok: true,
    result: {
      bubbles: []
    }
  });
  const retried = await harness.pipeline.run(harness.target, {
    reason: "retry"
  });
  assert.equal(retried.ok, true);
});
test("ready page OCR debug is rendered before translation settles", async () => {
  let releaseTranslation;
  const translationGate = new Promise(resolve => {
    releaseTranslation = resolve;
  });
  const harness = createCanonicalHarness({
    pageDebug: {
      a: {
        rawItems: [{
          text: "inside A",
          box: {
            left: 1,
            top: 2,
            width: 3,
            height: 4
          }
        }]
      }
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      }),
      requestCanonicalTranslations: async items => {
        harness.calls.push(`translate:${items.map(item => item.id).join(",")}`);
        return translationGate;
      }
    }
  });
  const pending = harness.pipeline.run(harness.targets.a);
  for (let index = 0; index < 20 && !harness.calls.some(item => item.startsWith("translate:")); index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(harness.calls.some(item => item.startsWith("translate:")));
  const debugRender = harness.renderInputs.find(input => input.pageId === "page-a" && input.projections.length === 0 && input.debug);
  assert.ok(debugRender);
  assert.deepEqual(debugRender.debug, {
    rawItems: [{
      text: "inside A",
      box: {
        left: 1,
        top: 2,
        width: 3,
        height: 4
      }
    }]
  });
  releaseTranslation({
    ok: true,
    result: {
      translations: harness.store.getCanonicalSnapshot().map(item => ({
        id: item.id,
        revision: item.revision,
        translated_text: `ZH:${item.originalText}`
      }))
    }
  });
  const result = await pending;
  assert.equal(result.ok, true);
});
test("debug-only refresh does not redraw an already translated neighbor", async () => {
  const harness = createCanonicalHarness({
    pageDebug: {
      a: {
        rawItems: [{
          text: "A",
          box: {
            left: 1,
            top: 2,
            width: 3,
            height: 4
          }
        }]
      },
      b: {
        rawItems: [{
          text: "B",
          box: {
            left: 5,
            top: 6,
            width: 7,
            height: 8
          }
        }]
      }
    }
  });
  await harness.pipeline.run(harness.targets.a);
  harness.renderInputs.length = 0;
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.renderInputs.some(input => input.pageId === "page-a" && input.debugOnly === true), false);
  assert.equal(harness.renderInputs.some(input => input.pageId === "page-b" && input.debugOnly === true && input.projections.length === 0), true);
});
test("a configured page resolver is authoritative when an old handle target remains", async () => {
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      }),
      getTargetForKakaoPageId: () => null
    }
  });
  const result = await harness.pipeline.run(harness.targets.a);
  assert.equal(result.ok, true);
  assert.equal(harness.renderInputs.length, 0);
});
test("canonical pipeline uses page OCR stages and never calls legacy stitch/dedupe hooks", async () => {
  let legacyCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      shouldUseKakaoStitchedOcr: () => {
        legacyCalls += 1;
        return true;
      },
      buildKakaoStitchedPayload: () => {
        legacyCalls += 1;
      },
      dedupeResult: () => {
        legacyCalls += 1;
      }
    }
  });
  const result = await harness.pipeline.run(harness.targets.a, {
    reason: "canonical"
  });
  assert.equal(result.ok, true);
  assert.equal(legacyCalls, 0);
  assert.equal(harness.calls.filter(call => call === "ocr:page:page-a").length, 1);
  const stages = harness.traces.map(item => item.event);
  for (const stage of ["canonical:fetch", "canonical:page-ocr", "canonical:observe", "canonical:reconcile", "canonical:translate", "canonical:project", "canonical:render"]) {
    assert.ok(stages.includes(stage), `missing stage ${stage}`);
  }
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);
  assert.deepEqual(harness.loadingClears, ["a"]);
});
