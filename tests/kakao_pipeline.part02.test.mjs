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
 * Store — serialized dedupe
 * ================================================================= */
test("Store runSerializedDedupe executes the provided function", async () => {
  const store = P.createStore();
  const result = await store.runSerializedDedupe(async ({
    seq,
    store: s
  }) => {
    return {
      seq,
      key: s === store
    };
  });
  assert.equal(result.key, true);
  assert.ok(result.seq >= 1);
});
test("Store runSerializedDedupe serializes concurrent operations", async () => {
  const store = P.createStore();
  const order = [];
  const p1 = store.runSerializedDedupe(async () => {
    await new Promise(r => setTimeout(r, 20));
    order.push("a");
    return "a";
  });
  const p2 = store.runSerializedDedupe(async () => {
    order.push("b");
    return "b";
  });
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1, "a");
  assert.equal(r2, "b");
  // 'a' must finish before 'b' starts (serial)
  assert.deepEqual(order, ["a", "b"]);
});
test("Store runSerializedDedupe provides globalOcrEntries reference", async () => {
  const store = P.createStore();
  store.setEntriesForKey("p1", [{
    text: "existing",
    completeness: 5,
    targetKey: "p1"
  }]);
  const result = await store.runSerializedDedupe(async ({
    globalOcrEntries
  }) => {
    const entries = globalOcrEntries.get("p1");
    return entries && entries.length;
  });
  assert.equal(result, 1);
});
test("Store dedupe queue continues after a rejected transaction", async () => {
  const store = P.createStore();
  await assert.rejects(store.runSerializedDedupe(async () => {
    throw new Error("expected");
  }), /expected/);
  assert.equal(await store.runSerializedDedupe(async () => "recovered"), "recovered");
});

/* =================================================================
 * Store — inflight job merging
 * ================================================================= */
test("Store getOrCreateInflightJob merges duplicate requests", async () => {
  const store = P.createStore();
  let callCount = 0;
  const factory = async () => {
    callCount += 1;
    await new Promise(r => setTimeout(r, 10));
    return "result";
  };
  const p1 = store.getOrCreateInflightJob("job-1", factory);
  const p2 = store.getOrCreateInflightJob("job-1", factory);
  assert.equal(p1, p2); // Same promise reference
  assert.equal(await p1, "result");
  assert.equal(await p2, "result");
  assert.equal(callCount, 1); // Factory called only once
});
test("Store getOrCreateInflightJob creates separate promises for different keys", async () => {
  const store = P.createStore();
  const p1 = store.getOrCreateInflightJob("a", async () => "a");
  const p2 = store.getOrCreateInflightJob("b", async () => "b");
  assert.notEqual(p1, p2);
  assert.equal(await p1, "a");
  assert.equal(await p2, "b");
});
test("Store getOrCreateInflightJob auto-cleans after completion", async () => {
  const store = P.createStore();
  await store.getOrCreateInflightJob("auto-clean", async () => "done");
  // After completion, a new factory should be called
  let callCount = 0;
  const p2 = store.getOrCreateInflightJob("auto-clean", async () => {
    callCount += 1;
    return "new";
  });
  assert.equal(await p2, "new");
  assert.equal(callCount, 1);
});

/* =================================================================
 * Store — reset
 * ================================================================= */
test("Store reset clears all state", () => {
  const store = P.createStore();
  store.setEntriesForKey("p1", [{
    text: "a",
    completeness: 1
  }]);
  store.transitionPagePhase("p1", "fetching");
  store.getOrCreateInflightJob("j1", async () => "x");
  store.reset();
  assert.deepEqual(store.getGlobalEntries(), []);
  assert.equal(store.getPagePhase("p1"), "waiting");
});
test("Store owns short-page attachment state and expires it through the gate", () => {
  const store = P.createStore();
  const target = {};
  store.attachShortPage(target, "owner", 1000);
  assert.deepEqual(P.getShortPageAttachmentGate(store, target, 2000), {
    blocked: true,
    timedOut: false,
    ownerKey: "owner"
  });
  assert.deepEqual(P.getShortPageAttachmentGate(store, target, 10000), {
    blocked: false,
    timedOut: true,
    ownerKey: "owner"
  });
  assert.equal(store.getShortPageAttachment(target).ownerKey, "");
});
test("retry scheduler stores timers and coalesces duplicate schedules", () => {
  const store = P.createStore();
  const target = {
    isConnected: true,
    ready: true
  };
  let callback = null;
  let readyCount = 0;
  const scheduler = P.createRetryScheduler({
    store,
    setTimer: fn => {
      callback = fn;
      return 42;
    },
    clearTimer: () => undefined,
    isPlaceholder: () => false,
    isTargetUsable: value => value.isConnected,
    isTargetReady: value => value.ready,
    onReady: () => {
      readyCount += 1;
    }
  });
  assert.equal(scheduler.schedule(target), true);
  assert.equal(scheduler.schedule(target), false);
  assert.equal(store.getRetryState(target).timer, 42);
  callback();
  assert.equal(readyCount, 1);
  assert.equal(store.getRetryState(target), null);
});
test("buildKakaoStitchedPayload composes verified owner and neighbor slices", async () => {
  const owner = {
    sourceKey: "owner",
    left: 0,
    top: 0,
    bottom: 1000,
    width: 760,
    height: 1000
  };
  const next = {
    sourceKey: "next",
    left: 0,
    top: 1000,
    bottom: 2000,
    width: 760,
    height: 1000
  };
  const draws = [];
  const result = await P.buildKakaoStitchedPayload(owner, {
    dataUrl: "owner-data",
    width: 760,
    height: 1000
  }, {
    collectCandidates: () => [owner, next],
    isReadyImageTarget: () => true,
    describeTarget: target => target,
    extractAdjacentPayload: async () => ({
      dataUrl: "next-data",
      width: 760,
      height: 1000
    }),
    loadImage: async () => ({
      naturalWidth: 760,
      naturalHeight: 1000
    }),
    createCanvas: (width, height) => ({
      width,
      height,
      getContext: () => ({
        drawImage: (...args) => draws.push(args)
      }),
      toDataURL: () => "data:image/jpeg;base64,stitched"
    }),
    imageMaxSide: 1536,
    imageJpegQuality: 0.82,
    computeTargetKey: target => target.sourceKey,
    getQuickSourceToken: target => target.sourceKey,
    buildTargetSourceCacheKey: (key, source) => `${key}|${source}`
  });
  assert.equal(result.stitchAdmission, "accepted");
  assert.equal(result.stitch.owner.source, "owner");
  assert.equal(result.stitch.next.source, "next");
  assert.equal(result.stitch.segments.length, 2);
  assert.equal(draws.length, 2);
});

/* =================================================================
 * Pure functions — text utilities
 * ================================================================= */
test("normalizeOcrSimilarityText normalizes and strips non-letter chars", () => {
  assert.equal(P.normalizeOcrSimilarityText("Hello World"), "helloworld");
  assert.equal(P.normalizeOcrSimilarityText("日本語！"), "日本語");
  assert.equal(P.normalizeOcrSimilarityText(""), "");
  assert.equal(P.normalizeOcrSimilarityText(null), "");
  assert.equal(P.normalizeOcrSimilarityText(undefined), "");
});
test("textSimilarity returns 1 for identical strings", () => {
  assert.equal(P.textSimilarity("hello", "hello"), 1);
});
test("textSimilarity returns 0 for null/empty comparisons", () => {
  assert.equal(P.textSimilarity("", "hello"), 0);
  assert.equal(P.textSimilarity(null, "hello"), 0);
});
test("areOcrTextsDuplicateOrContained detects high similarity", () => {
  assert.equal(P.areOcrTextsDuplicateOrContained("hello", "hello"), true);
  assert.equal(P.areOcrTextsDuplicateOrContained("hello world", "hello"), true);
  assert.equal(P.areOcrTextsDuplicateOrContained("abc", "def"), false);
});
