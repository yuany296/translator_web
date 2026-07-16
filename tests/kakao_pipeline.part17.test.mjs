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
test("late seam evidence supersedes an edge-timeout translation with a new revision", async () => {
  const seamObservation = {
    id: "seam-ab",
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
    providerBlockId: "seam-ab"
  };
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [{
        ...makeCanonicalObservation("page-a", "rev-a", "late-a", 94, "A tail"),
        visual: {
          regionType: "speech",
          regionHash: "same",
          bgType: "solid"
        }
      }],
      b: [{
        ...makeCanonicalObservation("page-b", "rev-b", "late-b", 0, "B head"),
        visual: {
          regionType: "speech",
          regionHash: "same",
          bgType: "solid"
        }
      }]
    },
    seamObservations: [seamObservation]
  });
  await harness.pipeline.run(harness.targets.a);
  harness.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const timeoutCanonical = harness.store.getCanonicalSnapshot().find(item => item.memberObservationIds.includes("late-a"));
  assert.equal(timeoutCanonical.revision, 1);
  assert.ok(harness.store.getTranslation(timeoutCanonical.id, 1));
  await harness.pipeline.run(harness.targets.b);
  const merged = harness.store.getCanonicalSnapshot().find(item => item.memberObservationIds.includes("late-a") && item.memberObservationIds.includes("late-b"));
  assert.ok(merged, "late seam should merge the two edge observations");
  assert.equal(merged.id, timeoutCanonical.id);
  assert.ok(merged.revision > timeoutCanonical.revision);
  assert.ok(harness.store.getTranslation(merged.id, merged.revision));
  assert.equal(harness.store.getProjections("page-a").filter(item => item.activeText).length, 1);
  assert.equal(harness.store.getProjections("page-b").filter(item => item.activeText).length, 0);
  assert.equal(harness.store.getProjections("page-b").filter(item => item.role === "cover").length, 1);
});
test("partial translation for a new revision keeps exactly one prior visible projection", async () => {
  await runFailedRevisionFallbackScenario({
    reverse: false,
    throwError: false
  });
});
test("a mixed partial response settles successful items and immediately retries only missing canonicals", async () => {
  const requestedIds = [];
  const harness = createCanonicalHarness({
    pageObservations: {
      a: [makeCanonicalObservation("page-a", "rev-a", "mixed-a-1", 30, "first line"), makeCanonicalObservation("page-a", "rev-a", "mixed-a-2", 60, "second line")],
      b: []
    },
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      })
    },
    translateDeferred: async items => {
      requestedIds.push(items.map(item => item.id));
      const translatedItems = requestedIds.length === 1 ? items.slice(0, 1) : items;
      return {
        ok: true,
        result: {
          translations: translatedItems.map(item => ({
            id: item.id,
            revision: item.revision,
            translated_text: `ZH:${item.original_text}`
          })),
          partial: translatedItems.length !== items.length
        }
      };
    }
  });
  const first = await harness.pipeline.run(harness.targets.a);
  assert.equal(first.ok, true);
  assert.equal(requestedIds[0].length, 2);
  assert.equal(requestedIds[1].length, 1, "only the missing canonical should be retried");
  assert.equal(harness.store.getCanonicalSnapshot().filter(canonical => harness.store.getTranslation(canonical.id, canonical.revision)).length, 2);
  assert.equal(harness.calls.filter(call => call === "ocr:page:page-a").length, 1, "the retry must not repeat authoritative OCR");
  assert.equal(harness.renderInputs.findLast(input => input.pageId === "page-a").translationComplete, true);
});
test("thrown translation after an anchor supersession keeps exactly one prior visible projection", async () => {
  await runFailedRevisionFallbackScenario({
    reverse: true,
    throwError: true
  });
});
test("a permanently pending page extraction times out, releases inflight, and retries", async () => {
  const never = new Promise(() => {});
  let extractionAttempts = 0;
  let clearedLoading = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      extractTimeoutMs: 5,
      extractTargetPayload: async target => {
        extractionAttempts += 1;
        if (extractionAttempts === 1) return never;
        return {
          dataUrl: `data:image/png;base64,${target.name}`,
          width: 800,
          height: 2000
        };
      },
      clearLoadingOverlay: () => {
        clearedLoading += 1;
      }
    }
  });
  const failed = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /page fetch timed out/i);
  assert.equal(clearedLoading, 1);
  assert.equal(harness.calls.filter(call => call === "retry").length, 1);
  const retried = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(retried.ok, true);
  assert.equal(extractionAttempts, 2);
});
test("a permanently pending page identity digest times out without committing late facts", async () => {
  const never = new Promise(() => {});
  let identityAttempts = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      identityTimeoutMs: 5,
      buildPageIdentity: async target => {
        identityAttempts += 1;
        if (identityAttempts === 1) return never;
        return {
          ...harness.identities[target.name]
        };
      }
    }
  });
  const failed = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /page identity timed out/i);
  assert.equal(harness.store.getPageHandles().length, 0);
  const retried = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(retried.ok, true);
  assert.equal(identityAttempts, 2);
});
test("a permanently pending page OCR times out and the same revision can retry", async () => {
  const never = new Promise(() => {});
  let pageOcrAttempts = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({}),
      pageOcrTimeoutMs: 5,
      requestOcrForPayload: async (_payload, meta) => {
        if (meta.sourceType !== "page") {
          return {
            ok: true,
            result: {
              observations: [],
              filteredObservations: [],
              edgeSignals: {}
            }
          };
        }
        pageOcrAttempts += 1;
        if (pageOcrAttempts === 1) return never;
        const pageId = meta.pageIds[0];
        const revision = meta.imageRevisionByPage[pageId];
        return {
          ok: true,
          result: {
            observations: [makeCanonicalObservation(pageId, revision, "retry-ocr", 40, "retry OCR")],
            filteredObservations: [],
            edgeSignals: {}
          }
        };
      }
    }
  });
  const failed = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /page OCR timed out/i);
  assert.equal(harness.store.getPageTerminal("page-a").state, "failed");
  const retried = await settleWithin(harness.pipeline.run(harness.targets.a));
  assert.equal(retried.ok, true);
  assert.equal(pageOcrAttempts, 2);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
});
