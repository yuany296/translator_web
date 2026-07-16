import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";

function candidate(id, box, regionType = "speech_bubble") {
  return {
    canonical: { id },
    bubble: {
      ...box,
      original_text: id,
      source_line_count: 1,
      region_type: regionType
    }
  };
}

test("seam surface plan keeps the largest overlapping blue box and independent boxes", () => {
  const large = candidate("large", { x: 10, y: 10, w: 40, h: 30 });
  const fragment = candidate("fragment", { x: 18, y: 16, w: 20, h: 10 });
  const independent = candidate("independent", { x: 65, y: 65, w: 20, h: 12 });
  const effect = candidate("effect", { x: 20, y: 18, w: 15, h: 8 }, "effect_text");
  const plan = P.resolveSeamSurfaceCandidates([fragment, independent, effect, large]);
  assert.deepEqual(plan.selected.map(item => item.canonical.id), ["large", "effect", "independent"]);
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
    bubbles: [bubble]
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

test("interior seam box suppresses only the page projection it substantially covers", () => {
  const surface = {
    canvasWidth: 100,
    canvasHeight: 200,
    pageIds: ["a", "b"],
    segments: [{
      pageId: "b",
      drawRect: { x: 0, y: 100, w: 100, h: 100 },
      sourceCrop: { x: 0, y: 0, w: 100, h: 100 },
      naturalWidth: 100,
      naturalHeight: 100
    }],
    bubbles: [{ x: 20, y: 55, w: 60, h: 35, region_type: "comment_panel" }],
    handledCanonicalIds: ["whole"]
  };
  const projections = new Map([["b", [{
    canonicalId: "independent",
    role: "primary",
    activeText: true,
    geometry: { left: 20, top: 0, width: 60, height: 8 },
    bubble: { region_type: "comment_panel" }
  }, {
    canonicalId: "fragment",
    role: "primary",
    activeText: true,
    geometry: { left: 22, top: 18, width: 56, height: 20 },
    bubble: { region_type: "comment_panel" }
  }]]]);
  assert.deepEqual([...P.collectSeamSuppressedCanonicalIds(surface, projections)], ["fragment"]);
});
