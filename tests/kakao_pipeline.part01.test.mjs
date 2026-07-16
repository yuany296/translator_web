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
test("manifest exposes only built entries from dist extension", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "public", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.name, "Manga OCR Translator · Next");
  assert.equal(manifest.action.default_title, "漫画 OCR 翻译器 · Next");
  for (const size of ["16", "32", "48", "128"]) {
    const iconPath = path.join(root, "extension", "public", manifest.icons[size]);
    assert.equal(fs.existsSync(iconPath), true, `missing ${size}px extension icon`);
  }
  const buildSource = fs.readFileSync(path.join(root, "scripts", "build-extension.mjs"), "utf8");
  assert.match(buildSource, /format: "esm"/);
  assert.match(buildSource, /\["content", "popup", "glossary"\]/);
});
test("popup independently saves OCR, translation and runtime settings and keeps manual translation", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const popupSource = fs.readFileSync(path.join(root, "extension", "src", "popup", "controller.js"), "utf8");
  assert.match(popupSource, /SAVE_CONFIGURATION", section, value: collect\(section, configuration\)/);
  assert.match(popupSource, /section === "ocr"/);
  assert.match(popupSource, /section === "translation"/);
  assert.match(popupSource, /TEST_OCR_CONFIGURATION/);
  assert.match(popupSource, /TEST_TRANSLATION_CONFIGURATION/);
  assert.match(popupSource, /type: "MANUAL_TRANSLATE_VISIBLE"/);
  assert.doesNotMatch(popupSource, /TRANSLATE_DATA_URL|baidu_deepseek|local_paddle_deepseek/);
});

/* =================================================================
 * FSM
 * ================================================================= */
test("PagePhase states are frozen and have correct values", () => {
  assert.equal(P.PagePhase.WAITING, "waiting");
  assert.equal(P.PagePhase.FETCHING, "fetching");
  assert.equal(P.PagePhase.FETCHED, "fetched");
  assert.equal(P.PagePhase.STITCHING, "stitching");
  assert.equal(P.PagePhase.STITCHED, "stitched");
  assert.equal(P.PagePhase.RECOGNIZING, "recognizing");
  assert.equal(P.PagePhase.RECOGNIZED, "recognized");
  assert.equal(P.PagePhase.DEDUPING, "deduping");
  assert.equal(P.PagePhase.DEDUPED, "deduped");
  assert.equal(P.PagePhase.RENDERING, "rendering");
  assert.equal(P.PagePhase.RENDERED, "rendered");
  assert.equal(P.PagePhase.CANCELLED, "cancelled");
  assert.equal(P.PagePhase.RETRY_WAIT, "retry_wait");
  assert.equal(P.PagePhase.FAILED, "failed");
});
test("canTransition accepts valid transitions", () => {
  assert.equal(P.canTransition("waiting", "fetching"), true);
  assert.equal(P.canTransition("waiting", "deduping"), true);
  assert.equal(P.canTransition("waiting", "cancelled"), true);
  assert.equal(P.canTransition("fetching", "fetched"), true);
  assert.equal(P.canTransition("fetching", "retry_wait"), true);
  assert.equal(P.canTransition("stitched", "recognizing"), true);
  assert.equal(P.canTransition("recognized", "deduping"), true);
  assert.equal(P.canTransition("deduped", "rendering"), true);
  assert.equal(P.canTransition("rendering", "rendered"), true);
  assert.equal(P.canTransition("retry_wait", "waiting"), true);
  assert.equal(P.canTransition("retry_wait", "failed"), true);
  assert.equal(P.canTransition("failed", "cancelled"), true);
});
test("canTransition rejects invalid transitions", () => {
  // Skipping phases not possible
  assert.equal(P.canTransition("waiting", "rendered"), false);
  assert.equal(P.canTransition("fetching", "rendered"), false);
  assert.equal(P.canTransition("stitched", "waiting"), false);
  // Terminal states have no outgoing
  assert.equal(P.canTransition("rendered", "waiting"), false);
  assert.equal(P.canTransition("rendered", "fetching"), false);
  assert.equal(P.canTransition("cancelled", "fetching"), false);
  assert.equal(P.canTransition("cancelled", "waiting"), false);
  assert.equal(P.canTransition("failed", "waiting"), false);
  assert.equal(P.canTransition("failed", "fetching"), false);
});
test("isActivePhase returns true for intermediate phases", () => {
  assert.equal(P.isActivePhase("fetching"), true);
  assert.equal(P.isActivePhase("stitching"), true);
  assert.equal(P.isActivePhase("recognizing"), true);
  assert.equal(P.isActivePhase("deduping"), true);
  assert.equal(P.isActivePhase("rendering"), true);
});
test("isActivePhase returns false for terminal phases", () => {
  assert.equal(P.isActivePhase("waiting"), false);
  assert.equal(P.isActivePhase("retry_wait"), false);
  assert.equal(P.isActivePhase("cancelled"), false);
  assert.equal(P.isActivePhase("failed"), false);
  assert.equal(P.isActivePhase("rendered"), false);
});
test("isRetryablePhase returns true for retry_wait and waiting", () => {
  assert.equal(P.isRetryablePhase("retry_wait"), true);
  assert.equal(P.isRetryablePhase("waiting"), true);
  assert.equal(P.isRetryablePhase("fetching"), false);
  assert.equal(P.isRetryablePhase("failed"), false);
  assert.equal(P.isRetryablePhase("cancelled"), false);
});

/* =================================================================
 * Store — basic operations
 * ================================================================= */
test("createStore returns a store object with required methods", () => {
  const store = P.createStore();
  const methods = ["getGlobalEntries", "getEntriesForKey", "setEntriesForKey", "deleteEntriesForKey", "removeEntryFromKey", "runSerializedDedupe", "getPagePhase", "transitionPagePhase", "transitionIfCurrentPhase", "resetPagePhase", "deletePagePhase", "isPageActive", "getOrCreateInflightJob", "beginPageJob", "isCurrentPageJob", "finishPageJob", "cancelPageJob", "getShortPageAttachment", "attachShortPage", "releaseShortPage", "clearShortPage", "getRetryState", "setRetryState", "clearRetryState", "clearRetryStates", "registerPageHandle", "getPageHandle", "getPageHandleForTarget", "unbindPageTarget", "upsertObservations", "getObservations", "markPageTerminal", "getPageTerminal", "runSerializedReconcile", "setCanonicalSnapshot", "getCanonicalSnapshot", "getRetiredCanonicals", "setReconcileDiagnostics", "getReconcileDiagnostics", "setCoverageLedger", "getCoverageLedger", "setProjections", "getProjections", "claimTranslations", "settleTranslation", "setEdgeWait", "getEdgeWait", "clearEdgeWait", "reset"];
  for (const m of methods) {
    assert.equal(typeof store[m], "function", `Store missing method: ${m}`);
  }
});
test("Store starts empty", () => {
  const store = P.createStore();
  assert.deepEqual(store.getGlobalEntries(), []);
  assert.deepEqual(store.getEntriesForKey("nonexistent"), []);
  assert.equal(store.isPageActive("nonexistent"), false);
});
test("Store setEntriesForKey and getEntriesForKey round-trip", () => {
  const store = P.createStore();
  const entry = {
    box: {
      left: 0,
      top: 0,
      width: 100,
      height: 100
    },
    text: "hello",
    completeness: 5
  };
  store.setEntriesForKey("page-1", [entry]);
  const retrieved = store.getEntriesForKey("page-1");
  assert.equal(retrieved.length, 1);
  assert.equal(retrieved[0].text, "hello");
  // Should return a copy
  assert.notEqual(retrieved[0], entry);
});
test("Store deleteEntriesForKey removes entries", () => {
  const store = P.createStore();
  store.setEntriesForKey("page-1", [{
    text: "hello",
    completeness: 1
  }]);
  store.deleteEntriesForKey("page-1");
  assert.deepEqual(store.getEntriesForKey("page-1"), []);
});
test("Store removeEntryFromKey removes specific entry reference", () => {
  const store = P.createStore();
  const entryA = {
    text: "A",
    completeness: 1
  };
  const entryB = {
    text: "B",
    completeness: 2
  };
  store.setEntriesForKey("page-1", [entryA, entryB]);
  store.removeEntryFromKey("page-1", entryA);
  const entries = store.getEntriesForKey("page-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "B");
});
test("Store getGlobalEntries returns flattened snapshot of all entries", () => {
  const store = P.createStore();
  store.setEntriesForKey("p1", [{
    text: "a",
    completeness: 1,
    targetKey: "p1"
  }]);
  store.setEntriesForKey("p2", [{
    text: "b",
    completeness: 2,
    targetKey: "p2"
  }]);
  const all = store.getGlobalEntries();
  assert.equal(all.length, 2);
  const texts = all.map(e => e.text).sort();
  assert.deepEqual(texts, ["a", "b"]);
});

/* =================================================================
 * Store — page phase FSM
 * ================================================================= */
test("Store transitionPagePhase follows valid transitions", () => {
  const store = P.createStore();
  assert.equal(store.transitionPagePhase("page-1", "fetching"), true);
  assert.equal(store.getPagePhase("page-1"), "fetching");
  assert.equal(store.transitionPagePhase("page-1", "fetched"), true);
  assert.equal(store.getPagePhase("page-1"), "fetched");
});
test("Store transitionPagePhase rejects illegal transitions", () => {
  const store = P.createStore();
  // Can't go directly to rendered from waiting
  assert.equal(store.transitionPagePhase("page-1", "rendered"), false);
  assert.equal(store.getPagePhase("page-1"), "waiting");
});
test("Store transitionIfCurrentPhase only transitions when at expected phase", () => {
  const store = P.createStore();
  // Start at waiting
  assert.equal(store.transitionIfCurrentPhase("page-1", "waiting", "fetching"), true);
  assert.equal(store.getPagePhase("page-1"), "fetching");
  // Attempt to transition from waiting (wrong current phase) should fail
  assert.equal(store.transitionIfCurrentPhase("page-1", "waiting", "fetched"), false);
  assert.equal(store.getPagePhase("page-1"), "fetching");
});
test("Store resetPagePhase resets to waiting", () => {
  const store = P.createStore();
  store.transitionPagePhase("page-1", "fetching");
  store.resetPagePhase("page-1");
  assert.equal(store.getPagePhase("page-1"), "waiting");
});
test("Store deletePagePhase removes phase entry", () => {
  const store = P.createStore();
  store.transitionPagePhase("page-1", "fetching");
  store.deletePagePhase("page-1");
  assert.equal(store.getPagePhase("page-1"), "waiting"); // default
});
test("Store isPageActive reflects phase correctly", () => {
  const store = P.createStore();
  assert.equal(store.isPageActive("page-1"), false);
  // Walk valid path: waiting → deduping → deduped → rendering → rendered
  store.transitionPagePhase("page-1", "deduping");
  store.transitionPagePhase("page-1", "deduped");
  store.transitionPagePhase("page-1", "rendering");
  store.transitionPagePhase("page-1", "rendered");
  assert.equal(store.isPageActive("page-1"), false);
  store.resetPagePhase("page-1");
  assert.equal(store.isPageActive("page-1"), false);
});

/* =================================================================
 * Store — serialized dedupe
 * ================================================================= */
