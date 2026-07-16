import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { reconciler as R } from "../extension/src/canonical/reconciler.js";
function page(pageId, index, overrides = {}) {
  return {
    pageId,
    imageRevision: `revision-${pageId}`,
    width: 1000,
    height: 1000,
    readingOrder: index,
    ...overrides
  };
}
function pageObservation(pageValue, text, box, overrides = {}) {
  return R.createObservation({
    provider: "fixture-ocr",
    captureId: `capture:${pageValue.pageId}:${overrides.captureSuffix || text}`,
    sourceType: "page",
    pageIds: [pageValue.pageId],
    imageRevisionByPage: {
      [pageValue.pageId]: pageValue.imageRevision
    },
    pageSpans: [{
      pageId: pageValue.pageId,
      box,
      coordinateSpace: "percent",
      regionType: overrides.regionType || "dialogue",
      overlapRatio: overrides.overlapRatio ?? 1
    }],
    originalText: text,
    confidence: overrides.confidence ?? 0.9,
    visual: {
      regionType: overrides.regionType || "dialogue",
      ...(overrides.visual || {})
    },
    ...overrides.observation
  });
}
function seamObservation(upper, lower, text, upperBox, lowerBox, overrides = {}) {
  return R.createObservation({
    provider: "fixture-ocr",
    captureId: `seam:${upper.pageId}:${lower.pageId}:${overrides.captureSuffix || text}`,
    sourceType: "seam",
    pageIds: [upper.pageId, lower.pageId],
    imageRevisionByPage: {
      [upper.pageId]: upper.imageRevision,
      [lower.pageId]: lower.imageRevision
    },
    pageSpans: [{
      pageId: upper.pageId,
      box: upperBox,
      coordinateSpace: "percent",
      regionType: overrides.regionType || "dialogue",
      overlapRatio: overrides.upperOverlapRatio ?? 0.5
    }, {
      pageId: lower.pageId,
      box: lowerBox,
      coordinateSpace: "percent",
      regionType: overrides.regionType || "dialogue",
      overlapRatio: overrides.lowerOverlapRatio ?? 0.5
    }],
    originalText: text,
    confidence: overrides.confidence ?? 0.96,
    visual: {
      regionType: overrides.regionType || "dialogue",
      ...(overrides.visual || {})
    }
  });
}
function boundaryFixture(textA = "오늘 학교에", textB = "갑니다.") {
  const upper = page("page-a", 0);
  const lower = page("page-b", 1);
  const upperBox = {
    x: 28,
    y: 88,
    w: 44,
    h: 12
  };
  const lowerBox = {
    x: 29,
    y: 0,
    w: 43,
    h: 12
  };
  const first = pageObservation(upper, textA, upperBox);
  const second = pageObservation(lower, textB, lowerBox);
  const seam = seamObservation(upper, lower, `${textA}${textB}`, upperBox, lowerBox);
  return {
    pages: [upper, lower],
    first,
    second,
    seam,
    upperBox,
    lowerBox
  };
}
function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(rest => [value, ...rest]));
}
test("active boundary canonical revision, supersedesId, and projections are invariant to A/B history", () => {
  const fixture = boundaryFixture();
  const forwardInitial = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first]
  });
  const reverseInitial = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.second]
  });
  const finalInput = [fixture.first, fixture.second, fixture.seam];
  const forward = R.reconcile({
    pages: fixture.pages,
    observations: finalInput,
    previousCanonicals: forwardInitial.canonicals
  });
  const reverse = R.reconcile({
    pages: fixture.pages,
    observations: [...finalInput].reverse(),
    previousCanonicals: reverseInitial.canonicals
  });
  assert.deepEqual(forward.canonicals, reverse.canonicals);
  assert.equal(forward.canonicals[0].revision, 3, "three distinct evidence captures define generation 3");
  assert.equal(forward.canonicals[0].supersedesId, reverseInitial.canonicals[0].id);
  const translations = {
    [`${forward.canonicals[0].id}@${forward.canonicals[0].revision}`]: "译文"
  };
  assert.deepEqual(R.buildRenderProjections({
    pages: fixture.pages,
    canonicals: forward.canonicals,
    translations
  }), R.buildRenderProjections({
    pages: fixture.pages,
    canonicals: reverse.canonicals,
    translations
  }));
});
test("a late earlier-page anchor creates a new ID and explicitly supersedes the old canonical", () => {
  const fixture = boundaryFixture();
  const initial = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.second]
  });
  const revised = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first, fixture.second, fixture.seam],
    previousCanonicals: initial.canonicals
  });
  assert.equal(revised.canonicals.length, 1);
  assert.notEqual(revised.canonicals[0].id, initial.canonicals[0].id);
  assert.equal(revised.canonicals[0].supersedesId, initial.canonicals[0].id);
  assert.equal(revised.canonicals[0].revision, 3);
  assert.equal(revised.retiredCanonicals[0].retiredById, revised.canonicals[0].id);
});
test("stale page observations are explicitly filtered and never enter an active canonical", () => {
  const current = page("a", 0, {
    imageRevision: "new-revision"
  });
  const stale = pageObservation({
    ...current,
    imageRevision: "old-revision"
  }, "old text", {
    x: 20,
    y: 20,
    w: 30,
    h: 10
  });
  const fresh = pageObservation(current, "new text", {
    x: 20,
    y: 20,
    w: 30,
    h: 10
  });
  const result = R.reconcile({
    pages: [current],
    observations: [stale, fresh]
  });
  assert.equal(result.ledger[stale.id].resolution, "filtered");
  assert.equal(result.ledger[stale.id].filterReason, "stale_revision");
  assert.equal(result.canonicals.some(canonical => canonical.memberObservationIds.includes(stale.id)), false);
  assert.equal(result.canonicals.some(canonical => canonical.memberObservationIds.includes(fresh.id)), true);
});
test("provider-filtered observations require a reason and satisfy total coverage", () => {
  const current = page("a", 0);
  const active = pageObservation(current, "kept", {
    x: 10,
    y: 20,
    w: 30,
    h: 10
  });
  const filtered = R.createObservation({
    ...pageObservation(current, "noise", {
      x: 60,
      y: 20,
      w: 20,
      h: 10
    }),
    id: undefined,
    captureId: "filtered-noise",
    filterReason: "low_confidence"
  });
  const result = R.reconcile({
    pages: [current],
    observations: [active],
    filteredObservations: [filtered]
  });
  assert.equal(result.ledger[filtered.id].resolution, "filtered");
  assert.equal(result.ledger[filtered.id].filterReason, "low_confidence");
  assert.equal(R.assertCoverageInvariants({
    observations: [active, filtered],
    canonicals: result.canonicals,
    ledger: result.ledger
  }), true);
});
test("render projections choose one visible translation and fail over to the first available standby", () => {
  const pages = [page("a", 0), page("b", 1)];
  const canonical = {
    id: "canonical-1",
    revision: 4,
    originalText: "source",
    geometryByPage: {
      a: [{
        box: {
          x: 20,
          y: 80,
          w: 20,
          h: 10
        },
        coordinateSpace: "percent"
      }],
      b: [{
        box: {
          x: 20,
          y: 0,
          w: 40,
          h: 20
        },
        coordinateSpace: "percent"
      }]
    }
  };
  const translations = {
    "canonical-1@4": {
      translated_text: "译文"
    }
  };
  const normal = R.buildRenderProjections({
    pages,
    canonicals: [canonical],
    translations
  });
  assert.equal(normal.filter(projection => projection.activeText).length, 1);
  assert.equal(normal.find(projection => projection.activeText).pageId, "b");
  assert.equal(normal.find(projection => projection.pageId === "a").coverOnly, true);
  const failedOver = R.buildRenderProjections({
    pages,
    canonicals: [canonical],
    translations,
    availablePageIds: ["a"]
  });
  assert.equal(failedOver.filter(projection => projection.activeText).length, 1);
  assert.equal(failedOver.find(projection => projection.activeText).pageId, "a");
  assert.equal(failedOver.find(projection => projection.activeText).translatedText, "译文");
});
test("render projections accept the pipeline's canonical.translation wire shape", () => {
  const current = page("a", 0);
  const projections = R.buildRenderProjections({
    pages: [current],
    canonicals: [{
      id: "canonical-wire",
      revision: 2,
      originalText: "source",
      translation: {
        translated_text: "管线译文"
      },
      geometryByPage: {
        a: [{
          box: {
            x: 10,
            y: 10,
            w: 30,
            h: 10
          },
          coordinateSpace: "percent"
        }]
      }
    }]
  });
  assert.equal(projections[0].translatedText, "管线译文");
  assert.equal(projections[0].bubble.translated_text, "管线译文");
});
test("highest-quality per-page visual evidence reaches primary, standby, and cover projections", () => {
  const fixture = boundaryFixture();
  const visual = {
    regionType: "dialogue",
    bgType: "solid",
    bgColor: "#fffef8",
    bgConfidence: 0.99,
    fillBox: {
      x: 27,
      y: 87,
      w: 46,
      h: 13
    }
  };
  const first = pageObservation(fixture.pages[0], "first", fixture.upperBox, {
    confidence: 0.99,
    visual
  });
  const second = pageObservation(fixture.pages[1], "second", fixture.lowerBox, {
    confidence: 0.99,
    visual
  });
  const seam = seamObservation(fixture.pages[0], fixture.pages[1], "firstsecond", fixture.upperBox, fixture.lowerBox, {
    confidence: 0.8,
    visual: {
      bgType: "none",
      bgConfidence: 0.1
    }
  });
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [first, second, seam]
  });
  const projections = R.buildRenderProjections({
    pages: fixture.pages,
    canonicals: result.canonicals,
    translations: {
      [`${result.canonicals[0].id}@${result.canonicals[0].revision}`]: "译文"
    }
  });
  assert.deepEqual(new Set(projections.map(projection => projection.role)), new Set(["primary", "cover", "standby"]));
  for (const projection of projections) {
    assert.equal(projection.visual.bgType, "solid");
    assert.equal(projection.bubble.bg_type, "solid");
    assert.deepEqual(projection.bubble.fill_box, visual.fillBox);
  }
});
test("seam-only projections remap geometry-bearing visual fields into each page coordinate space", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const seam = R.createObservation({
    id: "seam-only-coordinate-test",
    sourceType: "seam",
    pageIds: [upper.pageId, lower.pageId],
    imageRevisionByPage: {
      [upper.pageId]: upper.imageRevision,
      [lower.pageId]: lower.imageRevision
    },
    pageSpans: [{
      pageId: upper.pageId,
      box: {
        x: 20,
        y: 90,
        w: 50,
        h: 10
      },
      polygon: [[20, 90], [70, 90], [70, 100], [20, 100]],
      visual: {
        textBox: {
          x: 20,
          y: 90,
          w: 50,
          h: 10
        },
        fillBox: {
          x: 16,
          y: 88,
          w: 58,
          h: 12
        },
        polygon: [[20, 90], [70, 90], [70, 100], [20, 100]],
        regionPolygon: [[16, 88], [74, 88], [74, 100], [16, 100]]
      },
      coordinateSpace: "percent"
    }, {
      pageId: lower.pageId,
      box: {
        x: 25,
        y: 0,
        w: 45,
        h: 12
      },
      polygon: [[25, 0], [70, 0], [70, 12], [25, 12]],
      visual: {
        textBox: {
          x: 25,
          y: 0,
          w: 45,
          h: 12
        },
        fillBox: {
          x: 21,
          y: 0,
          w: 53,
          h: 15
        },
        polygon: [[25, 0], [70, 0], [70, 12], [25, 12]],
        regionPolygon: [[21, 0], [74, 0], [74, 15], [21, 15]]
      },
      coordinateSpace: "percent"
    }],
    originalText: "seam only",
    confidence: 0.99,
    visual: {
      bgType: "solid",
      bgColor: "#ffffff",
      bgConfidence: 0.95,
      fillBox: {
        x: 5,
        y: 40,
        w: 90,
        h: 20
      },
      polygon: [[5, 40], [95, 40], [95, 60], [5, 60]],
      regionPolygon: [[5, 40], [95, 40], [95, 60], [5, 60]]
    }
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [seam]
  });
  const projections = R.buildRenderProjections({
    pages: [upper, lower],
    canonicals: result.canonicals
  });
  for (const projection of projections) {
    const expected = projection.pageId === upper.pageId ? {
      left: 20,
      top: 90,
      width: 50,
      height: 10
    } : {
      left: 25,
      top: 0,
      width: 45,
      height: 12
    };
    const expectedFill = projection.pageId === upper.pageId ? {
      left: 16,
      top: 88,
      width: 58,
      height: 12
    } : {
      left: 21,
      top: 0,
      width: 53,
      height: 15
    };
    assert.deepEqual(projection.visual.fillBox, expectedFill);
    assert.notDeepEqual(projection.visual.fillBox, {
      x: 5,
      y: 40,
      w: 90,
      h: 20
    });
    assert.equal(projection.visual.bgType, "solid");
    assert.deepEqual(projection.visual.polygon[0], {
      x: expected.left,
      y: expected.top
    });
    assert.notDeepEqual(projection.visual.regionPolygon, projection.visual.polygon);
  }
});
test("seam-only secondary geometry does not paint an orphan page cover", () => {
  const upper = page("upper", 0);
  const lower = page("lower", 1);
  const projections = R.buildRenderProjections({
    pages: [upper, lower],
    canonicals: [{
      id: "canonical-seam-secondary",
      revision: 1,
      originalText: "complete dialogue",
      geometryByPage: {
        upper: [{
          observationId: "seam-only-upper",
          sourceType: "seam",
          confidence: 0.95,
          box: { x: 28, y: 97, w: 44, h: 3 },
          coordinateSpace: "percent",
          visual: { bgType: "solid", bgColor: "#ffffff" }
        }],
        lower: [{
          observationId: "page-lower",
          sourceType: "page",
          confidence: 0.98,
          box: { x: 29, y: 0, w: 43, h: 20 },
          coordinateSpace: "percent",
          visual: { bgType: "solid", bgColor: "#ffffff" }
        }]
      }
    }],
    translations: { "canonical-seam-secondary@1": "完整译文" }
  });
  const upperProjections = projections.filter(projection => projection.pageId === "upper");
  assert.deepEqual(upperProjections.map(projection => projection.role), ["standby"]);
  assert.equal(upperProjections[0].coverEligible, false);
  assert.equal(projections.find(projection => projection.pageId === "lower").role, "primary");
});
test("projection area ties select the earlier reading-order page", () => {
  const pages = [page("a", 0), page("b", 1)];
  const projections = R.buildRenderProjections({
    pages,
    canonicals: [{
      id: "canonical-tie",
      revision: 1,
      originalText: "text",
      geometryByPage: {
        a: [{
          box: {
            x: 10,
            y: 80,
            w: 20,
            h: 10
          },
          coordinateSpace: "percent"
        }],
        b: [{
          box: {
            x: 10,
            y: 0,
            w: 20,
            h: 10
          },
          coordinateSpace: "percent"
        }]
      }
    }]
  });
  assert.equal(projections.find(projection => projection.activeText).pageId, "a");
});
test("Canonical Store preserves stale revision evidence, serializes transactions, and merges inflight work", async () => {
  const store = R.createCanonicalStore();
  const oldPage = page("a", 0, {
    imageRevision: "old"
  });
  const newPage = page("a", 0, {
    imageRevision: "new"
  });
  const oldObservation = pageObservation(oldPage, "old", {
    x: 20,
    y: 20,
    w: 30,
    h: 10
  });
  const newObservation = pageObservation(newPage, "new", {
    x: 20,
    y: 20,
    w: 30,
    h: 10
  });
  store.upsertPage(oldPage);
  store.setPageObservations("a", [oldObservation]);
  store.upsertPage(newPage);
  store.setPageObservations("a", [newObservation]);
  const snapshot = store.reconcile();
  assert.equal(snapshot.ledger[oldObservation.id].filterReason, "stale_revision");
  assert.equal(store.getObservations().length, 2);
  const order = [];
  await Promise.all([store.runSerialized(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push("first");
  }), store.runSerialized(async () => {
    order.push("second");
  })]);
  assert.deepEqual(order, ["first", "second"]);
  let calls = 0;
  const first = store.getOrCreateInflight("ocr:a", async () => {
    calls += 1;
    return "ok";
  });
  const second = store.getOrCreateInflight("ocr:a", async () => {
    calls += 1;
    return "duplicate";
  });
  assert.equal(first, second);
  assert.equal(await first, "ok");
  assert.equal(calls, 1);
});
test("final projection arbitration keeps one text layer for related overlapping canonicals", () => {
  const current = page("single", 0);
  const geometry = (observationId, text, box) => ({
    observationId,
    sourceType: "page",
    confidence: 0.95,
    originalText: text,
    box,
    polygon: [],
    overlapRatio: 1,
    coordinateSpace: "percent",
    regionType: "speech_bubble",
    visual: {
      regionId: "region-one",
      regionType: "speech_bubble",
      bgType: "solid"
    }
  });
  const projections = R.buildRenderProjections({
    pages: [current],
    canonicals: [{
      id: "complete",
      revision: 1,
      originalText: "그럼 팍 넣고 다시 입다물어",
      geometryByPage: {
        single: [geometry("complete-page", "그럼 팍 넣고 다시 입다물어", {
          left: 20,
          top: 20,
          width: 55,
          height: 30
        })]
      }
    }, {
      id: "fragment",
      revision: 1,
      originalText: "팍 넣고 다시",
      geometryByPage: {
        single: [geometry("fragment-page", "팍 넣고 다시", {
          left: 25,
          top: 23,
          width: 45,
          height: 24
        })]
      }
    }],
    translations: {
      complete: "那么，放进去后闭嘴",
      fragment: "放进去后"
    }
  });
  assert.equal(projections.filter(projection => projection.activeText).length, 1);
  assert.equal(projections.find(projection => projection.activeText).canonicalId, "complete");
  const cleanup = projections.find(projection => projection.canonicalId === "fragment");
  assert.equal(cleanup.coverOnly, true);
  assert.equal(cleanup.translated_text, "");
});
test("projection arbitration does not merge independent bubbles of the same type", () => {
  const current = page("single-independent", 0);
  const canonical = (id, text, left) => ({
    id,
    revision: 1,
    originalText: text,
    geometryByPage: {
      "single-independent": [{
        observationId: `${id}-page`,
        sourceType: "page",
        confidence: 0.95,
        originalText: text,
        box: {
          left,
          top: 20,
          width: 25,
          height: 12
        },
        polygon: [],
        overlapRatio: 1,
        coordinateSpace: "percent",
        regionType: "speech_bubble",
        visual: {
          regionType: "speech_bubble",
          bgType: "solid"
        }
      }]
    }
  });
  const projections = R.buildRenderProjections({
    pages: [current],
    canonicals: [canonical("left", "기다려", 5), canonical("right", "기다려", 65)],
    translations: {
      left: "等等",
      right: "等等"
    }
  });
  assert.equal(projections.filter(projection => projection.activeText).length, 2);
});
