import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";

// 长条章节的渲染跳过：
//  整章每次 refresh 都会走 renderAllCanonicalPages。输入签名没变、且上一轮画好的
//  覆盖层仍在 DOM 上时不再重画（否则每翻一片都要把已处理的所有分片重画一遍）。
//  判据是可选适配器 isPageRenderStillApplied —— 没接它的宿主保持改造前行为。
function makeObservation(pageId, revision, id, text) {
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
        y: 40,
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
function createHarness({ withAdapter }) {
  const store = P.createStore();
  const renders = [];
  let stillApplied = true;
  const targets = {
    a: {
      name: "a",
      sourceToken: "source-a",
      generation: 0,
      isConnected: true,
      dataset: {}
    },
    b: {
      name: "b",
      sourceToken: "source-b",
      generation: 0,
      isConnected: true,
      dataset: {}
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
  const observations = {
    a: [makeObservation("page-a", "rev-a", "obs-a", "hello a")],
    b: [makeObservation("page-b", "rev-b", "obs-b", "hello b")]
  };
  const adapters = {
    store,
    computeTargetKey: target => `target-${target.name}`,
    getQuickSourceToken: target => target.sourceToken,
    getTargetGeneration: target => target.generation,
    buildTargetSourceCacheKey: (targetKey, sourceToken) => `${targetKey}|${sourceToken}`,
    extractTargetPayload: async target => ({
      dataUrl: `data:image/png;base64,${target.name}`,
      width: 800,
      height: 2000
    }),
    buildPageIdentity: async target => ({
      ...identities[target.name]
    }),
    requestOcrForPayload: async (_payload, meta) => {
      const targetName = meta.pageIds[0] === "page-a" ? "a" : "b";
      return {
        ok: true,
        result: {
          observations: observations[targetName] || [],
          filteredObservations: [],
          edgeSignals: {}
        }
      };
    },
    requestCanonicalTranslations: async items => ({
      ok: true,
      result: {
        translations: items.map(item => ({
          id: item.id,
          revision: item.revision,
          translated_text: `ZH:${item.original_text}`
        }))
      }
    }),
    renderCanonicalProjections: async input => {
      const pageIds = input.projectionsByPage instanceof Map
        ? [...input.projectionsByPage.keys()]
        : [input.pageId];
      renders.push({
        pageIds: pageIds.map(String),
        reason: String(input.reason || "")
      });
    },
    requestTranslationForPayload: async () => ({ ok: true, result: { bubbles: [] } }),
    renderTranslationResult: async () => undefined,
    clearRenderedTarget: () => undefined,
    renderOverlay: () => undefined,
    shouldUseKakaoStitchedOcr: () => false,
    buildKakaoStitchedPayload: async (_target, payload) => payload,
    findAdjacentKakaoPageTargets: () => ({}),
    getTargetForKakaoPageId: pageId => pageId === "page-a" ? targets.a : pageId === "page-b" ? targets.b : null,
    captureTargetSnapshot: target => ({
      sourceToken: target.sourceToken
    }),
    isTargetSnapshotStillValid: (target, snapshot) => target.sourceToken === snapshot.sourceToken,
    renderLoadingOverlay: () => {},
    clearLoadingOverlay: () => {},
    tracePipeline: () => {},
    scheduleAutoTranslateRetry: () => {},
    now: () => 1000,
    setTimer: () => null,
    clearTimer: () => {},
    edgeWaitTimeoutMs: 3000,
    ...(withAdapter ? {
      isPageRenderStillApplied: () => stillApplied
    } : {})
  };
  return {
    pipeline: P.createCanonicalPipeline(adapters),
    targets,
    renders,
    setStillApplied: value => {
      stillApplied = value === true;
    }
  };
}
const renderPageIdsOf = renders => renders.flatMap(entry => entry.pageIds);

test("unchanged page is not re-rendered when its overlay is still applied", async () => {
  const harness = createHarness({
    withAdapter: true
  });
  await harness.pipeline.run(harness.targets.a);
  const rendersAfterFirstRun = harness.renders.length;
  assert.ok(rendersAfterFirstRun >= 1, "first run must render page-a");
  assert.ok(renderPageIdsOf(harness.renders).includes("page-a"));
  await harness.pipeline.refresh({
    reason: "repeat",
    focusPageIds: ["page-a"]
  });
  assert.equal(harness.renders.length, rendersAfterFirstRun, "identical refresh must not re-render");
});

test("a missing overlay forces a re-render even when the inputs are unchanged", async () => {
  const harness = createHarness({
    withAdapter: true
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.refresh({
    reason: "repeat",
    focusPageIds: ["page-a"]
  });
  const settledRenders = harness.renders.length;
  harness.setStillApplied(false);
  await harness.pipeline.refresh({
    reason: "overlay-gone",
    focusPageIds: ["page-a"]
  });
  assert.equal(harness.renders.length, settledRenders + 1, "dropped overlay must re-render page-a");
  assert.ok(renderPageIdsOf(harness.renders.slice(settledRenders)).includes("page-a"));
});

test("a page whose inputs changed is still re-rendered", async () => {
  const harness = createHarness({
    withAdapter: true
  });
  await harness.pipeline.run(harness.targets.a);
  await harness.pipeline.refresh({
    reason: "repeat",
    focusPageIds: ["page-a"]
  });
  const settledRenders = harness.renders.length;
  await harness.pipeline.run(harness.targets.b);
  const newRenders = harness.renders.slice(settledRenders);
  assert.ok(renderPageIdsOf(newRenders).includes("page-b"), "new page must render");
});

test("hosts without the still-applied adapter keep the old always-render behavior", async () => {
  const harness = createHarness({
    withAdapter: false
  });
  await harness.pipeline.run(harness.targets.a);
  const rendersAfterFirstRun = harness.renders.length;
  await harness.pipeline.refresh({
    reason: "repeat",
    focusPageIds: ["page-a"]
  });
  assert.ok(harness.renders.length > rendersAfterFirstRun, "without adapter nothing may be skipped");
});
