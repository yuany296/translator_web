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
