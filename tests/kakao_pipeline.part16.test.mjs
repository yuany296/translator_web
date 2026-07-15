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
test("render projections select one active text page and allow standby takeover", () => {
  const pages = [{
    pageId: "a",
    readingOrder: 1
  }, {
    pageId: "b",
    readingOrder: 2
  }];
  const canonical = {
    id: "c",
    revision: 1,
    originalText: "hello",
    geometryByPage: {
      a: [{
        x: 0,
        y: 90,
        w: 20,
        h: 8
      }],
      b: [{
        x: 0,
        y: 0,
        w: 20,
        h: 4
      }]
    },
    translation: {
      translated_text: "你好"
    }
  };
  const primaryPresent = P.fallbackBuildRenderProjections({
    pages,
    canonicals: [canonical],
    availablePageIds: ["a", "b"]
  });
  const primaryAbsent = P.fallbackBuildRenderProjections({
    pages,
    canonicals: [canonical],
    availablePageIds: ["b"]
  });
  assert.equal(primaryPresent.filter(item => item.activeText).length, 1);
  assert.equal(primaryPresent.find(item => item.activeText).pageId, "a");
  assert.equal(primaryAbsent.filter(item => item.activeText).length, 1);
  assert.equal(primaryAbsent.find(item => item.activeText).pageId, "b");
});
test("a non-primary cross-page projection keeps standby metadata and adds a cover", () => {
  const standby = {
    id: "projection-b",
    canonicalId: "canonical",
    pageId: "b",
    role: "standby",
    activeText: false,
    translated_text: "不应显示",
    visual: {
      regionHash: "preserved"
    },
    bubble: {
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      translated_text: "不应显示"
    }
  };
  const [cover] = P.buildStandbyCoverProjections(standby);
  assert.equal(standby.role, "standby");
  assert.equal(cover.role, "cover");
  assert.equal(cover.activeText, false);
  assert.equal(cover.coverOnly, true);
  assert.deepEqual(cover.visual, standby.visual);
  assert.equal(cover.bubble.translated_text, "");
  assert.equal(cover.bubble.projection_role, "cover_only");
});
test("A/B page OCR completion order does not change canonical or projection sets", async () => {
  const forward = createCanonicalHarness();
  await forward.pipeline.run(forward.targets.a);
  await forward.pipeline.run(forward.targets.b);
  const reverse = createCanonicalHarness();
  await reverse.pipeline.run(reverse.targets.b);
  await reverse.pipeline.run(reverse.targets.a);
  const canonicalShape = store => store.getCanonicalSnapshot().map(item => ({
    id: item.id,
    revision: item.revision,
    members: item.memberObservationIds,
    text: item.originalText
  }));
  const projectionShape = store => [...store.getAllProjections().entries()].sort(([left], [right]) => left.localeCompare(right)).map(([pageId, items]) => [pageId, items.map(item => ({
    canonicalId: item.canonicalId,
    revision: item.canonicalRevision || item.revision,
    role: item.role,
    activeText: item.activeText
  }))]);
  assert.deepEqual(canonicalShape(forward.store), canonicalShape(reverse.store));
  assert.deepEqual(projectionShape(forward.store), projectionShape(reverse.store));
});
test("merged boundary canonical identity and projections are invariant to A/B OCR order", async () => {
  const forward = createCanonicalHarness(boundaryMergeHarnessOptions());
  await forward.pipeline.run(forward.targets.a);
  await forward.pipeline.run(forward.targets.b);
  const reverse = createCanonicalHarness(boundaryMergeHarnessOptions());
  await reverse.pipeline.run(reverse.targets.b);
  await reverse.pipeline.run(reverse.targets.a);
  const mergedShape = store => {
    const canonical = store.getCanonicalSnapshot().find(item => item.memberObservationIds.includes("merge-a") && item.memberObservationIds.includes("merge-b"));
    assert.ok(canonical, "boundary evidence should reconcile into one canonical");
    return {
      id: canonical.id,
      revision: canonical.revision,
      supersedesId: canonical.supersedesId || null,
      members: canonical.memberObservationIds,
      text: canonical.originalText,
      projections: [...store.getAllProjections().entries()].sort(([left], [right]) => left.localeCompare(right)).map(([pageId, items]) => [pageId, items.map(item => ({
        id: item.projectionId || item.id,
        canonicalId: item.canonicalId,
        revision: item.canonicalRevision || item.revision,
        role: item.role,
        activeText: item.activeText
      }))])
    };
  };
  assert.deepEqual(mergedShape(forward.store), mergedShape(reverse.store));
});
test("one page OCR failure does not clear another page canonical projection", async () => {
  const harness = createCanonicalHarness({
    pageFailure: "b"
  });
  const first = await harness.pipeline.run(harness.targets.a);
  const before = harness.store.getProjections("page-a");
  const second = await harness.pipeline.run(harness.targets.b);
  const after = harness.store.getProjections("page-a");
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.ok(before.some(item => item.activeText));
  assert.deepEqual(after, before);
  assert.equal(harness.store.getPageTerminal("page-b").state, "failed");
});
test("a whole canonical translation failure can recover on the same revision", async () => {
  let translationCalls = 0;
  const harness = createCanonicalHarness({
    adapterOverrides: {
      findAdjacentKakaoPageTargets: () => ({
        previous: null,
        next: null
      }),
      requestCanonicalTranslations: async items => {
        translationCalls += 1;
        if (translationCalls === 1) {
          return {
            ok: false,
            error: "temporary translation timeout"
          };
        }
        return {
          ok: true,
          result: {
            translations: items.map(item => ({
              id: item.id,
              revision: item.revision,
              translated_text: `ZH:${item.original_text}`
            }))
          }
        };
      }
    }
  });
  const first = await harness.pipeline.run(harness.targets.a);
  const second = await harness.pipeline.run(harness.targets.a, {
    reason: "same-revision-retry"
  });
  assert.equal(first.ok, false);
  assert.match(first.error, /temporary translation timeout/);
  assert.equal(second.ok, true);
  assert.equal(translationCalls, 2);
  assert.equal(harness.store.getPageTerminal("page-a").state, "ready");
  assert.equal(harness.store.getCanonicalPagePhase("page-a"), P.CanonicalPhase.RENDERED);
  assert.equal(harness.store.getProjections("page-a").some(item => item.activeText), true);
  assert.ok(harness.calls.includes("retry"));
});
test("late translation is rejected when canonical revision has advanced", () => {
  const store = P.createStore();
  const geometryByPage = {
    p: [{
      box: {
        left: 1,
        top: 1,
        width: 2,
        height: 2
      }
    }]
  };
  store.setCanonicalSnapshot([{
    id: "canonical",
    revision: 1,
    memberObservationIds: ["o1"],
    originalText: "first",
    geometryByPage,
    status: "ready"
  }]);
  const [claimed] = store.claimTranslations([{
    id: "canonical",
    revision: 1,
    original_text: "first"
  }]);
  store.setCanonicalSnapshot([{
    id: "canonical",
    revision: 2,
    memberObservationIds: ["o1", "o2"],
    originalText: "first second",
    geometryByPage,
    status: "ready"
  }]);
  assert.equal(store.settleTranslation(claimed, {
    translated_text: "stale"
  }), false);
  assert.equal(store.getTranslation("canonical", 1), null);
});
test("a canonical revision prevents concurrent claims but permits released retries", () => {
  const store = P.createStore();
  const item = {
    id: "canonical",
    revision: 1,
    original_text: "source"
  };
  assert.equal(store.claimTranslations([item]).length, 1);
  assert.equal(store.claimTranslations([item]).length, 0);
  store.releaseTranslationClaims([item]);
  assert.equal(store.claimTranslations([item]).length, 1);
  store.releaseTranslationClaims([item]);
  assert.equal(store.claimTranslations([{
    ...item,
    revision: 2
  }]).length, 1);
});
