import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";

function candidate(id, box, memberObservationIds = [id]) {
  return {
    canonical: { id, memberObservationIds },
    bubble: {
      ...box,
      original_text: id,
      source_line_count: 1,
      region_type: "speech_bubble"
    }
  };
}

test("seam surface plan uses canonical observation ownership instead of blue-box overlap", () => {
  const large = candidate("large", { x: 10, y: 10, w: 40, h: 30 }, ["shared"]);
  const fragment = candidate("fragment", { x: 80, y: 80, w: 10, h: 8 }, ["shared"]);
  const independent = candidate("independent", { x: 65, y: 65, w: 20, h: 12 });
  const overlapping = candidate("overlapping", { x: 12, y: 12, w: 36, h: 26 });
  const plan = P.resolveSeamSurfaceCandidates([fragment, independent, overlapping, large]);
  assert.deepEqual(plan.selected.map(item => item.canonical.id), ["large", "overlapping", "independent"]);
  assert.deepEqual(plan.suppressed.map(item => [item.candidate.canonical.id, item.winner.canonical.id]), [["fragment", "large"]]);
});

test("solid-only seam surfaces do not consume an unrelated cleaned image", () => {
  assert.equal(P.seamSurfaceRequiresCleanedImage([{ bg_type: "solid" }]), false);
  assert.equal(P.seamSurfaceRequiresCleanedImage([{ bg_type: "solid" }, { bg_type: "none" }]), true);
});

test("seam rendering rejects a canonical whose page text extends beyond the capture band", () => {
  const segments = [
    { pageId: "a", sourceCrop: { x: 0, y: 900, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000 },
    { pageId: "b", sourceCrop: { x: 0, y: 0, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000 }
  ];
  const observations = new Map([
    ["seam", { id: "seam", sourceType: "seam", pageSpans: [] }],
    ["top", { id: "top", sourceType: "page", pageSpans: [{ pageId: "b", box: { x: 20, y: 1, w: 30, h: 5 } }] }],
    ["body", { id: "body", sourceType: "page", pageSpans: [{ pageId: "b", box: { x: 18, y: 12, w: 40, h: 16 } }] }]
  ]);
  const outside = P.inspectCanonicalSeamGeometry({ memberObservationIds: ["seam", "top", "body"] }, observations, segments);
  const inside = P.inspectCanonicalSeamGeometry({ memberObservationIds: ["seam", "top"] }, observations, segments);
  assert.equal(outside.represented, false);
  assert.deepEqual(outside.outsideObservationIds, ["body"]);
  assert.equal(inside.represented, true);
});

test("seam rendering accepts an edge fragment that extends beyond the capture band and keeps its full page box", () => {
  const segments = [
    { pageId: "a", sourceCrop: { x: 0, y: 900, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000 },
    { pageId: "b", sourceCrop: { x: 0, y: 0, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000 }
  ];
  const observations = new Map([
    ["seam", {
      id: "seam", sourceType: "seam", visual: { box: { x: 20, y: 40, w: 60, h: 20 }, bgType: "solid" },
      pageSpans: [
        { pageId: "a", box: { x: 20, y: 94, w: 60, h: 6 }, overlapRatio: 0.3 },
        { pageId: "b", box: { x: 20, y: 0, w: 60, h: 8 }, overlapRatio: 0.7 }
      ]
    }],
    ["lower", {
      id: "lower", sourceType: "page",
      pageSpans: [{ pageId: "b", box: { x: 18, y: 0, w: 64, h: 16.32 } }]
    }]
  ]);
  const canonical = { id: "whole", revision: 1, originalText: "whole", memberObservationIds: ["lower", "seam"] };
  const inspection = P.inspectCanonicalSeamGeometry(canonical, observations, segments);
  assert.equal(inspection.represented, true);
  const pageBoxes = P.canonicalSeamPageBoxes(canonical, observations, segments);
  assert.deepEqual(pageBoxes.text.map(item => item.pageId), ["a", "b"]);
  assert.equal(Math.round(pageBoxes.text[1].h * 100) / 100, 16.32);
  const bubble = P.buildSeamSurfaceBubble(canonical, { translated_text: "完整译文" }, [observations.get("seam")], 1000, 200, observations, segments);
  assert.equal(Math.round(bubble.page_text_boxes[1].h * 100) / 100, 16.32);
  assert.equal(bubble.page_cover_boxes.length, 2);
});

test("a filtered seam witness rebuilds the surface box from trusted page rows", () => {
  const segments = [
    {
      pageId: "a", drawRect: { x: 0, y: 0, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 800, w: 1000, h: 200 },
      naturalWidth: 1000, naturalHeight: 1000
    },
    {
      pageId: "b", drawRect: { x: 0, y: 100, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 0, w: 1000, h: 200 },
      naturalWidth: 1000, naturalHeight: 1000
    }
  ];
  const observations = new Map([
    ["upper-lines", {
      id: "upper-lines", sourceType: "page",
      pageSpans: [{ pageId: "a", box: { x: 27.18, y: 85.25, w: 46.04, h: 12.1 } }]
    }],
    ["clipped", {
      id: "clipped", sourceType: "page",
      pageSpans: [{ pageId: "a", box: { x: 40.33, y: 97.5, w: 18.16, h: 2.5 } }]
    }],
    ["complete", {
      id: "complete", sourceType: "page",
      pageSpans: [{ pageId: "b", box: { x: 39.47, y: 0, w: 20.27, h: 3.4 } }]
    }],
    ["filtered-seam", {
      id: "filtered-seam", sourceType: "seam",
      visual: { box: { x: 27.18, y: 44, w: 46.04, h: 8 }, bgType: "solid" },
      pageSpans: [
        { pageId: "a", box: { x: 27.18, y: 91.2, w: 46.04, h: 6.9 }, overlapRatio: 0.5 },
        { pageId: "b", box: { x: 39.47, y: 0, w: 20.27, h: 3.4 }, overlapRatio: 0.5 }
      ]
    }]
  ]);
  const canonical = {
    id: "three-lines",
    revision: 1,
    originalText: "그렇다면 여기서 의문점이 생긴다.",
    memberObservationIds: ["upper-lines", "clipped", "complete"],
    seamWitnessObservationIds: ["filtered-seam"],
    seamDiscardedObservationIds: ["clipped"]
  };

  const bubble = P.buildSeamSurfaceBubble(
    canonical, { translated_text: "那么，这里就产生了疑问。" },
    [observations.get("filtered-seam")], 1000, 200, observations, segments
  );

  assert.ok(bubble);
  assert.equal(Math.round(bubble.y * 100) / 100, 13.13);
  assert.equal(Math.round(bubble.h * 100) / 100, 45.38);
  assert.equal(bubble.original_text, canonical.originalText);
});

test("a completed pair witness builds a surface without a retained seam OCR box", () => {
  const segments = [
    {
      pageId: "a", drawRect: { x: 0, y: 0, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 800, w: 1000, h: 200 },
      naturalWidth: 1000, naturalHeight: 1000
    },
    {
      pageId: "b", drawRect: { x: 0, y: 100, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 0, w: 1000, h: 200 },
      naturalWidth: 1000, naturalHeight: 1000
    }
  ];
  const observations = new Map([
    ["upper-lines", {
      id: "upper-lines", sourceType: "page", visual: { bgType: "solid" },
      pageSpans: [{ pageId: "a", box: { x: 27.18, y: 85.25, w: 46.04, h: 12.1 } }]
    }],
    ["clipped", {
      id: "clipped", sourceType: "page",
      pageSpans: [{ pageId: "a", box: { x: 40.33, y: 97.5, w: 18.16, h: 2.5 } }]
    }],
    ["complete", {
      id: "complete", sourceType: "page",
      pageSpans: [{ pageId: "b", box: { x: 39.47, y: 0, w: 20.27, h: 3.4 } }]
    }]
  ]);
  const canonical = {
    id: "three-lines",
    revision: 1,
    originalText: "그렇다면 여기서 의문점이 생긴다.",
    memberObservationIds: ["upper-lines", "clipped", "complete"],
    seamWitnessPairKeys: ["pair"],
    seamDiscardedObservationIds: ["clipped"]
  };

  const bubble = P.buildSeamSurfaceBubble(
    canonical, { translated_text: "那么，这里就有了疑问。" },
    [], 1000, 200, observations, segments
  );

  assert.ok(bubble);
  assert.equal(bubble.original_text, canonical.originalText);
  assert.equal(Math.round(bubble.y * 100) / 100, 13.13);
  assert.equal(Math.round(bubble.h * 100) / 100, 45.38);
  assert.equal(bubble.source_line_count, 2);
});

test("seam surface estimates source rows from text height when one OCR witness undercounts them", () => {
  const segments = [{
    pageId: "a",
    drawRect: { x: 0, y: 0, w: 1000, h: 100 },
    sourceCrop: { x: 0, y: 900, w: 1000, h: 100 },
    naturalWidth: 1000,
    naturalHeight: 1000
  }, {
    pageId: "b",
    drawRect: { x: 0, y: 100, w: 1000, h: 100 },
    sourceCrop: { x: 0, y: 0, w: 1000, h: 100 },
    naturalWidth: 1000,
    naturalHeight: 1000
  }];
  const seam = {
    id: "seam",
    sourceType: "seam",
    originalText: "three source rows",
    visual: {
      box: { x: 20, y: 18, w: 60, h: 64 },
      bgType: "solid",
      sourceLineCount: 1,
      fontHeightPercent: 18
    },
    pageSpans: [{
      pageId: "a", box: { x: 20, y: 96, w: 60, h: 4 }
    }, {
      pageId: "b", box: { x: 20, y: 0, w: 60, h: 9 }
    }]
  };
  const observations = new Map([[seam.id, seam]]);
  const canonical = {
    id: "geometry-lines",
    revision: 1,
    originalText: seam.originalText,
    memberObservationIds: [seam.id]
  };
  const bubble = P.buildSeamSurfaceBubble(canonical,
    { translated_text: "三行译文" }, [seam], 1000, 200, observations, segments);
  assert.equal(bubble.source_line_count, 3);
});

test("surface index accepts a canonical linked only by completed pair evidence", () => {
  const pageIds = ["a", "b"];
  const revisions = { a: "rev-a", b: "rev-b" };
  const segments = [
    {
      pageId: "a", drawRect: { x: 0, y: 0, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 800, w: 1000, h: 200 },
      naturalWidth: 1000, naturalHeight: 1000
    },
    {
      pageId: "b", drawRect: { x: 0, y: 100, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 0, w: 1000, h: 200 },
      naturalWidth: 1000, naturalHeight: 1000
    }
  ];
  const observations = [
    {
      id: "upper-lines", sourceType: "page", pageIds: ["a"],
      pageSpans: [{ pageId: "a", box: { x: 27.18, y: 85.25, w: 46.04, h: 12.1 } }]
    },
    {
      id: "clipped", sourceType: "page", pageIds: ["a"],
      pageSpans: [{ pageId: "a", box: { x: 40.33, y: 97.5, w: 18.16, h: 2.5 } }]
    },
    {
      id: "complete", sourceType: "page", pageIds: ["b"],
      pageSpans: [{ pageId: "b", box: { x: 39.47, y: 0, w: 20.27, h: 3.4 } }]
    }
  ];
  const canonical = {
    id: "three-lines", revision: 1,
    originalText: "그렇다면 여기서 의문점이 생긴다.",
    memberObservationIds: observations.map(item => item.id),
    seamWitnessPairKeys: ["pair"],
    seamDiscardedObservationIds: ["clipped"],
    geometryByPage: { a: [{}], b: [{}] },
    status: "ready"
  };
  const handles = new Map(pageIds.map(pageId => [pageId, {
    pageId, imageRevision: revisions[pageId],
    width: 1000, height: 1000
  }]));
  const store = {
    getCanonicalSnapshot: () => [canonical],
    getRetiredCanonicals: () => [],
    getObservations: () => observations,
    getSeamStates: () => [{
      status: "completed", pairKey: "pair", pageIds,
      imageRevisionByPage: revisions,
      canvasWidth: 1000, canvasHeight: 200, segments,
      observationIds: [], observations: [], filteredObservations: [],
      cleanedImage: "data:image/png;base64,AA==",
      cleanedImageToken: "fixture-cleaned"
    }],
    getPageHandle: pageId => handles.get(pageId),
    getPageTerminal: pageId => ({
      state: "ready", details: { imageRevision: revisions[pageId] }
    }),
    getCoverageLedger: () => new Map(),
    getTranslation: () => ({ translated_text: "那么，这里就有了疑问。" })
  };

  const index = P.buildSeamRenderSurfaceIndex(store);

  assert.equal(index.surfaces.length, 1);
  assert.deepEqual(index.surfaces[0].handledCanonicalIds, ["three-lines"]);
  assert.equal(index.surfaces[0].bubbles[0].original_text,
    canonical.originalText);
});

test("final debug follows the selected seam box and hides duplicate page final boxes", () => {
  const bubble = { x: 10, y: 50, w: 40, h: 20, original_text: "whole", translated_text: "完整" };
  const surface = {
    canvasWidth: 100,
    canvasHeight: 100,
    pageIds: ["a", "b"],
    segments: [{
      pageId: "b",
      drawRect: { x: 0, y: 50, w: 100, h: 50 },
      sourceCrop: { x: 0, y: 0, w: 100, h: 50 },
      naturalWidth: 100,
      naturalHeight: 50
    }],
    bubbles: [bubble],
    absorbedObservationIds: ["duplicate"]
  };
  const seamDebug = P.buildSeamSurfaceDebug({ rawItems: [{ id: "raw" }] }, [bubble]);
  assert.deepEqual(seamDebug.finalBubbles.map(item => item.percent), [{ x: 10, y: 50, w: 40, h: 20 }]);
  assert.deepEqual(P.buildSeamSurfaceDebug({ finalBubbles: [{ id: "stale" }] }, []).finalBubbles, []);
  const pageDebug = P.resolvePageDebugForSeamSurfaces({
    imageWidth: 100,
    imageHeight: 50,
    finalBubbles: [{ id: "duplicate", percent: { x: 10, y: 0, w: 40, h: 40 } }, { id: "other", percent: { x: 70, y: 50, w: 20, h: 20 } }]
  }, [surface], "b");
  assert.deepEqual(pageDebug.finalBubbles.map(item => item.id), ["other"]);
});

test("a seam surface absorbs strongly covered text fragments but keeps unrelated edge text", () => {
  const segments = [
    { pageId: "a", sourceCrop: { x: 0, y: 900, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000 },
    { pageId: "b", sourceCrop: { x: 0, y: 0, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000 }
  ];
  const pageObservation = (id, text, box, role = "") => [id, {
    id, originalText: text, visual: { translationRole: role },
    pageSpans: [{ pageId: "a", box }]
  }];
  const observations = new Map([
    pageObservation("winner-a", "이렇게", { x: 45, y: 95, w: 35, h: 5 }),
    pageObservation("winner-b", "먹어보는 게 얼마 만이더라.", { x: 45, y: 0, w: 35, h: 8 }),
    pageObservation("heart", "마음", { x: 46, y: 96, w: 14, h: 4 }),
    pageObservation("comfort", "펴히", { x: 62, y: 96, w: 13, h: 4 }),
    pageObservation("unrelated", "외부", { x: 62, y: 96, w: 13, h: 4 }),
    pageObservation("far", "마음", { x: 10, y: 96, w: 12, h: 4 }),
    ["seam", { id: "seam", originalText: "이렇게 마음 편히 먹어보는 게",
      visual: { translationRole: "" }, pageSpans: [] }]
  ]);
  const winner = {
    canonical: {
      id: "whole", originalText: "이렇게 마음 편히 먹어보는 게 얼마 만이더라.",
      memberObservationIds: ["winner-a", "winner-b", "seam"]
    },
    bubble: {
      page_text_boxes: [
        { pageId: "a", x: 45, y: 95, w: 35, h: 5 },
        { pageId: "b", x: 45, y: 0, w: 35, h: 8 }
      ]
    }
  };
  const residual = (id, memberId = id) => ({
    id, originalText: observations.get(memberId).originalText, memberObservationIds: [memberId]
  });
  const canonicals = [
    winner.canonical,
    residual("canonical-heart", "heart"),
    residual("canonical-comfort", "comfort"),
    residual("canonical-unrelated", "unrelated"),
    residual("canonical-far", "far")
  ];
  const covered = P.findSeamCoveredResidualCanonicals([winner], canonicals, observations, segments);
  assert.deepEqual(covered.map(item => item.canonical.id), ["canonical-comfort", "canonical-heart"]);
  assert.ok(covered.every(item => item.overlap >= 0.72 && item.captureCoverage >= 0.72));
});

test("surface ownership publishes covered residual canonicals to projection suppression", () => {
  const pageIds = ["a", "b"];
  const revisions = { a: "rev-a", b: "rev-b" };
  const segments = [
    {
      pageId: "a", drawRect: { x: 0, y: 0, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 900, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000
    },
    {
      pageId: "b", drawRect: { x: 0, y: 100, w: 1000, h: 100 },
      sourceCrop: { x: 0, y: 0, w: 1000, h: 100 }, naturalWidth: 1000, naturalHeight: 1000
    }
  ];
  const observation = (id, text, pageId, box) => ({
    id, sourceType: "page", pageIds: [pageId], originalText: text,
    imageRevisionByPage: { [pageId]: revisions[pageId] },
    visual: { translationRole: "" },
    pageSpans: [{ pageId, box, overlapRatio: 1 }]
  });
  const observations = [
    observation("upper", "이렇게", "a", { x: 45, y: 95, w: 35, h: 5 }),
    observation("lower", "먹어보는 게 얼마 만이더라.", "b", { x: 45, y: 0, w: 35, h: 8 }),
    observation("heart", "마음", "a", { x: 46, y: 96, w: 14, h: 4 }),
    observation("comfort", "펴히", "a", { x: 62, y: 96, w: 13, h: 4 })
  ];
  const seam = {
    id: "seam", sourceType: "seam", pageIds, imageRevisionByPage: revisions,
    originalText: "이렇게 마음 편히 먹어보는 게",
    visual: { box: { x: 45, y: 40, w: 35, h: 120 }, bgType: "solid", translationRole: "" },
    pageSpans: [
      { pageId: "a", box: { x: 45, y: 95, w: 35, h: 5 }, overlapRatio: 0.4 },
      { pageId: "b", box: { x: 45, y: 0, w: 35, h: 8 }, overlapRatio: 0.6 }
    ]
  };
  observations.push(seam);
  const whole = {
    id: "whole", revision: 1, originalText: "이렇게 마음 편히 먹어보는 게 얼마 만이더라.",
    memberObservationIds: ["upper", "lower", "seam"],
    geometryByPage: { a: [{}], b: [{}] }, status: "ready"
  };
  const residual = (id, memberId) => ({
    id, revision: 1, originalText: observations.find(item => item.id === memberId).originalText,
    memberObservationIds: [memberId], geometryByPage: { a: [{}] }, status: "ready"
  });
  const canonicals = [whole, residual("canonical-heart", "heart"), residual("canonical-comfort", "comfort")];
  const handles = new Map(pageIds.map(pageId => [pageId, {
    pageId, imageRevision: revisions[pageId], width: 1000, height: 1000
  }]));
  const store = {
    getCanonicalSnapshot: () => canonicals,
    getRetiredCanonicals: () => [],
    getObservations: () => observations,
    getSeamStates: () => [{
      status: "completed", pairKey: "pair", pageIds, imageRevisionByPage: revisions,
      canvasWidth: 1000, canvasHeight: 200, segments, observationIds: ["seam"],
      observations: [seam], filteredObservations: []
    }],
    getPageHandle: pageId => handles.get(pageId),
    getPageTerminal: pageId => ({ state: "ready", details: { imageRevision: revisions[pageId] } }),
    getCoverageLedger: () => new Map(),
    getTranslation: id => id === "whole" ? { translated_text: "完整译文" } : null
  };
  const index = P.buildSeamRenderSurfaceIndex(store);
  assert.equal(index.surfaces.length, 1);
  assert.deepEqual(index.surfaces[0].absorbedCanonicalIds,
    ["canonical-comfort", "canonical-heart", "whole"]);
  assert.deepEqual(index.surfaces[0].diagnostics.filter(item => item.reason === "covered_text_fragment")
    .map(item => item.canonicalId), ["canonical-comfort", "canonical-heart"]);
});

test("projection plan removes only explicitly absorbed canonical ids", () => {
  const index = {
    handledCanonicalIds: new Set(["whole"]),
    absorbedCanonicalIds: new Set(["whole", "retired-fragment"]),
    surfaces: []
  };
  const calls = [];
  const plan = P.resolveSeamProjectionPlan(index, owned => {
    calls.push([...owned].sort());
    return new Map();
  });
  assert.deepEqual([...plan.handledCanonicalIds].sort(), ["retired-fragment", "whole"]);
  assert.deepEqual(calls, [["retired-fragment", "whole"]]);
});

test("cleaned artifact plan requests only page cover boxes outside the seam capture", () => {
  const index = {
    surfaces: [{
      segments: [{
        pageId: "upper",
        sourceCrop: { x: 0, y: 900, w: 1000, h: 100 },
        naturalWidth: 1000,
        naturalHeight: 1000
      }, {
        pageId: "lower",
        sourceCrop: { x: 0, y: 0, w: 1000, h: 100 },
        naturalWidth: 1000,
        naturalHeight: 1000
      }],
      bubbles: [{
        canonicalId: "whole",
        bg_type: "none",
        page_cover_boxes: [
          { pageId: "upper", x: 20, y: 95, w: 60, h: 5 },
          { pageId: "lower", x: 20, y: 0, w: 60, h: 16 }
        ]
      }]
    }]
  };
  const plan = P.buildCleanedArtifactProjectionPlan(new Map(), index);
  assert.equal(plan.has("upper"), false, "the composite already owns the complete upper cover");
  assert.deepEqual(P.buildCanonicalCleanMasks(plan.get("lower")), [{
    coordinateSpace: "percent",
    box: { x: 20, y: 0, w: 60, h: 16 }
  }]);
});
