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
  const loadings = [];
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
    renderLoadingOverlay: (target, targetKey, text) => loadings.push({
      target: target.name,
      targetKey,
      text
    }),
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
    loadings,
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
test("accepted pixel-overlap risk triggers seam OCR even without edge text", async () => {
  const harness = createCanonicalHarness({
    pixelRisk: {
      accepted: true,
      overlapRatio: 0.3,
      rows: 40,
      currentRows: 200
    }
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:seam:")).length, 1);
  assert.equal(harness.store.getSeamStates()[0].status, "completed");
});
test("fragmented page structure triggers seam OCR without edge text or pixel overlap", async () => {
  const harness = createCanonicalHarness({
    pixelRisk: {
      risk: true,
      fragmentRisk: true
    }
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:seam:")).length, 1);
  assert.deepEqual(harness.store.getSeamStates()[0].reasons, ["fragment_structure"]);
});
test("a multi-fragment seam requests one canonical translation", async () => {
  const upper = makeCanonicalObservation("page-a", "rev-a", "multi-upper", 94, "키즈쇼의");
  upper.pageSpans[0].box = { x: 25, y: 94, w: 50, h: 6 };
  const lower = [
    makeCanonicalObservation("page-b", "rev-b", "multi-lower-1", 0, "<화요"),
    makeCanonicalObservation("page-b", "rev-b", "multi-lower-2", 0, "퀴즈쇼>의"),
    makeCanonicalObservation("page-b", "rev-b", "multi-lower-3", 3, "A등급은 인정되지 않았습니다.")
  ];
  lower[0].pageSpans[0].box = { x: 25, y: 0, w: 25, h: 4 };
  lower[1].pageSpans[0].box = { x: 49, y: 0, w: 26, h: 4 };
  lower[2].pageSpans[0].box = { x: 25, y: 3, w: 50, h: 8 };
  const fullText = "키즈쇼의 <화요 퀴즈쇼>의 A등급은 인정되지 않았습니다.";
  const harness = createCanonicalHarness({
    pageObservations: { a: [upper], b: lower },
    seamObservations: [{
      id: "multi-seam",
      sourceType: "seam",
      pageIds: ["page-a", "page-b"],
      imageRevisionByPage: { "page-a": "rev-a", "page-b": "rev-b" },
      pageSpans: [{
        pageId: "page-a",
        box: { x: 25, y: 93, w: 50, h: 7 },
        overlapRatio: 0.4
      }, {
        pageId: "page-b",
        box: { x: 25, y: 0, w: 50, h: 11 },
        overlapRatio: 0.6
      }],
      originalText: fullText,
      confidence: 0.99,
      visual: { regionType: "speech", bgType: "solid" }
    }]
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  const canonicals = harness.store.getCanonicalSnapshot();
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0].originalText, fullText);
  const translationCalls = harness.calls.filter(call => call.startsWith("translate:"));
  assert.equal(translationCalls.length, 1);
  assert.match(translationCalls[0], new RegExp(`:${fullText}$`, "u"));
});
test("structured negative edge signals do not create a false edge wait", () => {
  const record = {
    pageId: "page-a",
    imageRevision: "rev-a",
    width: 800,
    height: 2000
  };
  const interior = makeCanonicalObservation("page-a", "rev-a", "interior-negative", 40, "inside");
  const sides = P.collectPageEdgeSides(record, [interior], [], {
    top: {
      detected: false,
      retainedObservationIds: [],
      filteredObservationIds: [],
      visualDetected: false
    },
    bottom: {
      detected: false,
      retainedObservationIds: [],
      filteredObservationIds: [],
      visualDetected: false
    },
    hasAny: false
  });
  assert.deepEqual(sides, []);
});
test("an old revision edge timer cannot release a newer page revision", async () => {
  const pageObservations = {
    a: [makeCanonicalObservation("page-a", "rev-a", "edge-rev-a", 96, "old edge")],
    b: []
  };
  const harness = createCanonicalHarness({
    pageObservations
  });
  await harness.pipeline.run(harness.targets.a);
  const oldTimer = harness.timers[0];
  harness.identities.a.imageRevision = "rev-a-2";
  pageObservations.a = [makeCanonicalObservation("page-a", "rev-a-2", "edge-rev-a-2", 96, "new edge")];
  await harness.pipeline.run(harness.targets.a);
  assert.equal(oldTimer.cleared, true);
  assert.equal(harness.store.getEdgeWait("page-a").imageRevision, "rev-a-2");
  oldTimer.callback();
  assert.equal(harness.store.getEdgeWait("page-a").timedOut, false);
});
test("a stale edge observation cannot trigger seam OCR for an interior-only new revision", async () => {
  const pageObservations = {
    a: [makeCanonicalObservation("page-a", "rev-a", "stale-edge", 96, "old edge")],
    b: [makeCanonicalObservation("page-b", "rev-b", "stable-interior", 40, "inside B")]
  };
  const harness = createCanonicalHarness({
    pageObservations
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:seam:")).length, 1);
  harness.identities.a.imageRevision = "rev-a-2";
  pageObservations.a = [makeCanonicalObservation("page-a", "rev-a-2", "fresh-interior", 40, "inside A")];
  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.calls.filter(call => call.startsWith("ocr:seam:")).length, 1);
  const states = harness.store.getSeamStates();
  assert.equal(states.some(state => state.status === "skipped" && state.imageRevisionByPage["page-a"] === "rev-a-2"), true);
});
test("an edge waits for a late DOM neighbor discovered within the 8 second window", async () => {
  let neighborVisible = false;
  const harness = createCanonicalHarness({
    seamFailure: true,
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "late-neighbor-a", 96, "A waits")],
      b: [makeCanonicalObservation("page-b", "rev-b", "late-neighbor-b", 0, "B arrives")]
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: target => {
        if (!neighborVisible) return {
          previous: null,
          next: null
        };
        return target.name === "a" ? {
          next: harness.targets.b
        } : {
          previous: harness.targets.a
        };
      }
    }
  });
  await harness.pipeline.run(harness.targets.a);
  assert.equal(harness.store.getEdgeWait("page-a").timedOut, false);
  assert.equal(harness.calls.some(call => call.includes(":A waits")), false);
  neighborVisible = true;
  await harness.pipeline.run(harness.targets.b);
  assert.equal(harness.store.getEdgeWait("page-a"), null);
  assert.ok(harness.calls.some(call => call.includes(":A waits")));
  assert.ok(harness.calls.some(call => call.includes(":B arrives")));
});
test("onAdjacent records confirmed revisioned adjacency even when seam OCR returns zero observations", async () => {
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [],
      b: []
    },
    seamObservations: [],
    pixelRisk: {
      accepted: true,
      overlapRatio: 0.25
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      })
    }
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  harness.loadings.length = 0;
  harness.loadingClears.length = 0;
  const result = await harness.pipeline.onAdjacentTargetAvailable(harness.targets.a, harness.targets.b);
  assert.equal(result.ok, true);
  assert.deepEqual(harness.loadings, [{
    target: "a",
    targetKey: "target-a",
    text: "处理跨页..."
  }, {
    target: "b",
    targetKey: "target-b",
    text: "处理跨页..."
  }, {
    target: "a",
    targetKey: "target-a",
    text: "渲染结果..."
  }, {
    target: "b",
    targetKey: "target-b",
    text: "渲染结果..."
  }]);
  assert.deepEqual(harness.loadingClears, ["a", "b"]);
  assert.equal(harness.store.getPageHandle("page-a").nextPageId, "page-b");
  assert.equal(harness.store.getPageHandle("page-b").previousPageId, "page-a");
  const pairs = P.buildConfirmedAdjacentPagePairs(harness.store.getPageHandles());
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].imageRevisionByPage, {
    "page-a": "rev-a",
    "page-b": "rev-b"
  });
  assert.equal(harness.store.getSeamStates()[0].status, "completed");
  const evidencedPairs = P.buildConfirmedAdjacentPagePairs(
    harness.store.getPageHandles(), harness.store.getSeamStates()
  );
  assert.equal(evidencedPairs[0].seamEvidence.status, "completed");
  assert.deepEqual(evidencedPairs[0].seamEvidence.observationIds, []);
  assert.deepEqual(evidencedPairs[0].seamEvidence.imageRevisionByPage, {
    "page-a": "rev-a",
    "page-b": "rev-b"
  });
  assert.deepEqual(harness.store.getCanonicalSnapshot(), []);
});
test("page-ready adjacency notification runs after the ready terminal and before page projection", async () => {
  const events = [];
  let harness;
  harness = createCanonicalHarness({
    adapterOverrides: {
      notifyCanonicalPageReady: async (target, record) => {
        const terminal = harness.store.getPageTerminal(record.pageId);
        events.push(`ready:${target.name}:${terminal && terminal.state}`);
        harness.calls.push(`notify-ready:${target.name}`);
      }
    }
  });
  await harness.pipeline.run(harness.targets.a);
  assert.deepEqual(events, ["ready:a:ready"]);
  const notifyIndex = harness.calls.indexOf("notify-ready:a");
  const renderIndex = harness.calls.findIndex(item => item.startsWith("render:page-a:"));
  assert.ok(notifyIndex >= 0 && renderIndex > notifyIndex);
});
test("onAdjacent rejects retained SPA pages from another chapter before recording adjacency", async () => {
  const harness = createCanonicalHarness({
    pixelRisk: {
      accepted: true,
      overlapRatio: 0.25
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      })
    }
  });
  harness.identities.b.chapterId = "another-chapter";
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.run(harness.targets.b);
  const result = await harness.pipeline.onAdjacentTargetAvailable(harness.targets.a, harness.targets.b);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "chapter-mismatch");
  assert.equal(harness.store.getPageHandle("page-a").nextPageId || "", "");
  assert.equal(harness.store.getPageHandle("page-b").previousPageId || "", "");
  assert.equal(harness.store.getSeamStates().length, 0);
});
test("canonical store serializes reconciliation and keeps semantic facts after DOM unbind", async () => {
  const store = P.createStore();
  const target = {
    isConnected: true
  };
  store.registerPageHandle({
    pageId: "p",
    imageRevision: "r",
    target,
    width: 800,
    height: 1000
  });
  store.upsertObservations([makeCanonicalObservation("p", "r", "o")]);
  const order = [];
  const first = store.runSerializedReconcile(async () => {
    order.push("a-start");
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push("a-end");
  });
  const second = store.runSerializedReconcile(async () => order.push("b"));
  await Promise.all([first, second]);
  store.unbindPageTarget(target);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
  assert.equal(store.getPageHandle("p").target, null);
  assert.equal(store.getObservationsForPage("p").length, 1);
});
