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
test("a cross-page seam joins a geometrically aligned fragment with one OCR substitution", () => {
  const upper = page("effect-upper", 0, {
    width: 760
  });
  const lower = page("effect-lower", 1, {
    width: 760
  });
  const upperFragment = pageObservation(upper, "저것이", {
    x: 36.97,
    y: 89,
    w: 25.53,
    h: 8.2
  }, {
    regionType: "effect_text",
    confidence: 0.99
  });
  const noisyLowerFragment = pageObservation(lower, "오럽자의'말로.", {
    x: 22.63,
    y: 0.1,
    w: 53.82,
    h: 4.1
  }, {
    regionType: "effect_text",
    confidence: 0.745
  });
  const correctedSeam = seamObservation(upper, lower, "저것이 오답자의말로.", {
    x: 22.37,
    y: 89,
    w: 54.34,
    h: 11
  }, {
    x: 22.37,
    y: 0,
    w: 54.34,
    h: 4.4
  }, {
    regionType: "effect_text",
    upperOverlapRatio: 0.714,
    lowerOverlapRatio: 0.286,
    confidence: 0.99
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperFragment, noisyLowerFragment, correctedSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "저것이 오답자의말로.");
  assert.deepEqual(result.canonicals[0].memberObservationIds, [correctedSeam.id, noisyLowerFragment.id, upperFragment.id].sort());
});
test("a corrected seam supersedes page-edge Hangul final-consonant crop errors", () => {
  const upper = page("cropped-upper", 0, {
    width: 760
  });
  const lower = page("cropped-lower", 1, {
    width: 760
  });
  const upperText = pageObservation(upper, "그럼 0.5초 만에 팍넣고 다시", {
    x: 16,
    y: 84,
    w: 60,
    h: 16
  }, {
    regionType: "speech_bubble",
    confidence: 0.98
  });
  const badCrop = pageObservation(lower, "인다문어", {
    x: 18,
    y: 0,
    w: 42,
    h: 10
  }, {
    regionType: "speech_bubble",
    confidence: 0.71
  });
  const correctedSeam = seamObservation(upper, lower, "딱넣고 다시 입다물어", {
    x: 17,
    y: 88,
    w: 56,
    h: 12
  }, {
    x: 18,
    y: 0,
    w: 45,
    h: 12
  }, {
    regionType: "speech_bubble",
    upperOverlapRatio: 0.55,
    lowerOverlapRatio: 0.45,
    confidence: 0.99
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperText, badCrop, correctedSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.match(result.canonicals[0].originalText, /입다물어/);
  assert.doesNotMatch(result.canonicals[0].originalText, /인다문어/);
});
test("fuzzy seam fragments preserve semantic symbols instead of erasing them", () => {
  const upper = page("symbol-upper", 0);
  const lower = page("symbol-lower", 1);
  const upperBox = {
    x: 25,
    y: 89,
    w: 50,
    h: 10
  };
  const lowerBox = {
    x: 25,
    y: 0,
    w: 50,
    h: 10
  };
  const first = pageObservation(upper, "A+B+C+D+E", upperBox);
  const second = pageObservation(lower, "F+G+H+I+J", lowerBox);
  const seam = seamObservation(upper, lower, "ABCDEFGHIJ", upperBox, lowerBox, {
    upperOverlapRatio: 0.5,
    lowerOverlapRatio: 0.5
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, seam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});
test("two OCR substitutions are not accepted as one fuzzy seam fragment", () => {
  const upper = page("two-errors-upper", 0, {
    width: 760
  });
  const lower = page("two-errors-lower", 1, {
    width: 760
  });
  const upperFragment = pageObservation(upper, "저것이", {
    x: 36.97,
    y: 89,
    w: 25.53,
    h: 8.2
  }, {
    regionType: "effect_text"
  });
  const noisyLowerFragment = pageObservation(lower, "오럽자의말로.", {
    x: 22.63,
    y: 0.1,
    w: 53.82,
    h: 4.1
  }, {
    regionType: "effect_text"
  });
  const unrelatedSeam = seamObservation(upper, lower, "저것이 오답자의길로.", {
    x: 22.37,
    y: 89,
    w: 54.34,
    h: 11
  }, {
    x: 22.37,
    y: 0,
    w: 54.34,
    h: 4.4
  }, {
    regionType: "effect_text",
    upperOverlapRatio: 0.714,
    lowerOverlapRatio: 0.286
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperFragment, noisyLowerFragment, unrelatedSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[upperFragment.id].canonicalId, result.ledger[noisyLowerFragment.id].canonicalId);
});
test("a seam that only repeats the upper page cannot support a cross-page merge", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperBox = {
    x: 30,
    y: 90,
    w: 40,
    h: 10
  };
  const lowerBox = {
    x: 30,
    y: 0,
    w: 40,
    h: 10
  };
  const first = pageObservation(upper, "foo", upperBox);
  const second = pageObservation(lower, "bar", lowerBox);
  const seam = seamObservation(upper, lower, "foo", upperBox, lowerBox);
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, seam]
  });
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});
test("a one-percent seam spill is not treated as true cross-page evidence", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperBox = {
    x: 30,
    y: 90,
    w: 40,
    h: 10
  };
  const lowerBox = {
    x: 30,
    y: 0,
    w: 40,
    h: 10
  };
  const first = pageObservation(upper, "foo", upperBox);
  const second = pageObservation(lower, "bar", lowerBox);
  const seam = seamObservation(upper, lower, "foobar", upperBox, lowerBox, {
    upperOverlapRatio: 0.99,
    lowerOverlapRatio: 0.01
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, seam]
  });
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
  assert.deepEqual(result.ledger[seam.id], {
    resolution: "filtered",
    filterReason: "seam_context_only"
  });
  assert.equal(result.canonicals.length, 2);
});
test("explicit zero-overlap seam spans never fall back to positive box-area evidence", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperBox = {
    x: 30,
    y: 90,
    w: 40,
    h: 10
  };
  const lowerBox = {
    x: 30,
    y: 0,
    w: 40,
    h: 10
  };
  const first = pageObservation(upper, "오늘 학교에", upperBox);
  const second = pageObservation(lower, "갑니다.", lowerBox);
  const seam = seamObservation(upper, lower, "오늘 학교에갑니다.", upperBox, lowerBox, {
    upperOverlapRatio: 0,
    lowerOverlapRatio: 0
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, seam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
  assert.deepEqual(result.ledger[seam.id], {
    resolution: "filtered",
    filterReason: "seam_context_only"
  });
});
test("a seam OCR fragment that contributes to only one page is filtered as context", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const authoritative = pageObservation(lower, "천장에서 뭐가 흘러내려!", {
    x: 35,
    y: 6.5,
    w: 30,
    h: 20.7
  });
  const clippedContext = R.createObservation({
    provider: "fixture-ocr",
    captureId: "seam:a:b:clipped-context",
    sourceType: "seam",
    pageIds: [upper.pageId, lower.pageId],
    imageRevisionByPage: {
      [upper.pageId]: upper.imageRevision,
      [lower.pageId]: lower.imageRevision
    },
    pageSpans: [{
      pageId: lower.pageId,
      box: {
        x: 35,
        y: 6.2,
        w: 30,
        h: 9.8
      },
      coordinateSpace: "percent",
      regionType: "dialogue",
      overlapRatio: 1
    }],
    originalText: "천장에서 모기",
    confidence: 0.99
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [authoritative, clippedContext],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds, [authoritative.id]);
  assert.deepEqual(result.ledger[clippedContext.id], {
    resolution: "filtered",
    filterReason: "seam_context_only"
  });
});
test("a seam-only observation with meaningful contributions from both pages remains canonical", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const seam = seamObservation(upper, lower, "진짜跨页대사", {
    x: 30,
    y: 88,
    w: 40,
    h: 12
  }, {
    x: 30,
    y: 0,
    w: 40,
    h: 12
  }, {
    upperOverlapRatio: 0.45,
    lowerOverlapRatio: 0.55
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [seam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds, [seam.id]);
  assert.deepEqual(Object.keys(result.canonicals[0].geometryByPage), [upper.pageId, lower.pageId]);
  assert.equal(result.ledger[seam.id].resolution, "standalone");
});
test("candidate enumeration is chapter-partitioned and does not lose a true pair interleaved with retained SPA pages", () => {
  const oldA = page("old-a", 0, {
    chapterId: "old"
  });
  const newA = page("new-a", 10, {
    chapterId: "new"
  });
  const oldB = page("old-b", 100, {
    chapterId: "old"
  });
  const newB = page("new-b", 110, {
    chapterId: "new"
  });
  const upperBox = {
    x: 30,
    y: 90,
    w: 40,
    h: 10
  };
  const lowerBox = {
    x: 30,
    y: 0,
    w: 40,
    h: 10
  };
  const first = pageObservation(newA, "new chapter", upperBox);
  const second = pageObservation(newB, "continues", lowerBox);
  const seam = seamObservation(newA, newB, "new chaptercontinues", upperBox, lowerBox);
  const result = R.reconcile({
    pages: [oldA, newA, oldB, newB],
    observations: [first, second, seam],
    adjacentPagePairs: [[newA.pageId, newB.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds, [first.id, second.id, seam.id].sort());
  assert.deepEqual(Object.keys(result.canonicals[0].geometryByPage), [newA.pageId, newB.pageId]);
});
test("0.60–0.75 candidates are diagnostic-only and emit conservative needs_review canonicals", () => {
  const fixture = boundaryFixture("same sentence", "same sentence");
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first, fixture.second]
  });
  assert.equal(result.canonicals.length, 2);
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.equal(result.diagnostics.needsReview.length, 1);
  assert.ok(result.diagnostics.needsReview[0].score >= 0.60);
  assert.ok(result.diagnostics.needsReview[0].score < 0.75);
  assert.ok(result.canonicals.every(canonical => canonical.status === "needs_review"));
});
test("a short middle page may form a deterministic three-page component", () => {
  const firstPage = page("a", 0);
  const middlePage = page("b", 1, {
    height: 180,
    shortPage: true
  });
  const lastPage = page("c", 2);
  const first = pageObservation(firstPage, "one", {
    x: 30,
    y: 88,
    w: 40,
    h: 12
  });
  const middle = pageObservation(middlePage, "two", {
    x: 30,
    y: 0,
    w: 40,
    h: 100
  });
  const last = pageObservation(lastPage, "three", {
    x: 30,
    y: 0,
    w: 40,
    h: 12
  });
  const seamAB = seamObservation(firstPage, middlePage, "onetwo", {
    x: 30,
    y: 88,
    w: 40,
    h: 12
  }, {
    x: 30,
    y: 0,
    w: 40,
    h: 100
  });
  const seamBC = seamObservation(middlePage, lastPage, "twothree", {
    x: 30,
    y: 0,
    w: 40,
    h: 100
  }, {
    x: 30,
    y: 0,
    w: 40,
    h: 12
  });
  const result = R.reconcile({
    pages: [firstPage, middlePage, lastPage],
    observations: [first, middle, last, seamAB, seamBC]
  });
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(Object.keys(result.canonicals[0].geometryByPage), ["a", "b", "c"]);
});
test("union-find never cascades one canonical across four pages", () => {
  const pages = [page("a", 0), page("b", 1, {
    height: 180,
    shortPage: true
  }), page("c", 2, {
    height: 180,
    shortPage: true
  }), page("d", 3)];
  const observations = pages.map((current, index) => pageObservation(current, String(index), index === 0 ? {
    x: 30,
    y: 88,
    w: 40,
    h: 12
  } : index === pages.length - 1 ? {
    x: 30,
    y: 0,
    w: 40,
    h: 12
  } : {
    x: 30,
    y: 0,
    w: 40,
    h: 100
  }));
  for (let index = 0; index < pages.length - 1; index += 1) {
    observations.push(seamObservation(pages[index], pages[index + 1], `${index}${index + 1}`, index === 0 ? {
      x: 30,
      y: 88,
      w: 40,
      h: 12
    } : {
      x: 30,
      y: 0,
      w: 40,
      h: 100
    }, index + 1 === pages.length - 1 ? {
      x: 30,
      y: 0,
      w: 40,
      h: 12
    } : {
      x: 30,
      y: 0,
      w: 40,
      h: 100
    }));
  }
  const result = R.reconcile({
    pages,
    observations
  });
  assert.ok(result.canonicals.length >= 2);
  assert.ok(result.canonicals.every(canonical => Object.keys(canonical.geometryByPage).length <= 3));
});
test("reconciliation is idempotent and independent of OCR completion order", () => {
  const fixture = boundaryFixture();
  const inputs = [fixture.first, fixture.second, fixture.seam];
  const expected = R.reconcile({
    pages: fixture.pages,
    observations: inputs
  });
  for (const order of permutations(inputs)) {
    const actual = R.reconcile({
      pages: [...fixture.pages].reverse(),
      observations: order
    });
    assert.deepEqual(actual, expected);
  }
  const repeated = R.reconcile({
    pages: fixture.pages,
    observations: inputs,
    previousCanonicals: expected.canonicals
  });
  assert.deepEqual(repeated.canonicals, expected.canonicals);
});
test("fixed random input perturbations produce the same canonical and ledger snapshots", () => {
  const fixture = boundaryFixture();
  const independent = pageObservation(fixture.pages[0], "independent", {
    x: 75,
    y: 40,
    w: 20,
    h: 8
  });
  const values = [fixture.first, fixture.second, fixture.seam, independent];
  const expected = R.reconcile({
    pages: fixture.pages,
    observations: values
  });
  let state = 0x12345678;
  function random() {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 0x100000000;
  }
  for (let run = 0; run < 30; run += 1) {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    assert.deepEqual(R.reconcile({
      pages: fixture.pages,
      observations: shuffled
    }), expected);
  }
});
test("versioned anonymous adjacent-page OCR golden reconciles to the locked semantic groups", () => {
  const fixturePath = path.resolve(import.meta.dirname, "fixtures", "kakao-canonical", "ocr-golden.json");
  const golden = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const pages = golden.pages.map((value, readingOrder) => ({
    ...value,
    readingOrder
  }));
  const observations = [...golden.ocr.page.flatMap(item => item.observations), ...golden.ocr.seam.observations];
  const filteredObservations = [...golden.ocr.page.flatMap(item => item.filteredObservations), ...golden.ocr.seam.filteredObservations];
  const result = R.reconcile({
    pages,
    observations,
    filteredObservations
  });
  assert.equal(result.canonicals.length, 3);
  const boundaryIds = ["obs-page-a-bottom-half", "obs-page-b-top-half", "obs-seam-complete"].sort();
  const boundary = result.canonicals.find(canonical => canonical.memberObservationIds.length === boundaryIds.length && canonical.memberObservationIds.every((id, index) => id === boundaryIds[index]));
  assert.ok(boundary, "the two authoritative halves and seam evidence must form one canonical");
  assert.equal(boundary.originalText, golden.ocr.seam.observations[0].originalText);
  assert.equal(result.ledger["obs-page-a-filtered-noise"].resolution, "filtered");
  assert.equal(result.ledger["obs-page-a-filtered-noise"].filterReason, "meaningless-alphabetic-final");
  assert.deepEqual(R.reconcile({
    pages: [...pages].reverse(),
    observations: [...observations].reverse(),
    filteredObservations: [...filteredObservations].reverse()
  }), result);
});
test("late evidence preserves a canonical ID and increments revision exactly once", () => {
  const fixture = boundaryFixture();
  const initial = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first]
  });
  const revised = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first, fixture.seam],
    previousCanonicals: initial.canonicals
  });
  assert.equal(revised.canonicals[0].id, initial.canonicals[0].id);
  assert.equal(revised.canonicals[0].revision, initial.canonicals[0].revision + 1);
  const replay = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.seam, fixture.first],
    previousCanonicals: revised.canonicals
  });
  assert.equal(replay.canonicals[0].revision, revised.canonicals[0].revision);
});
