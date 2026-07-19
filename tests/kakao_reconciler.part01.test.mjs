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
test("extension builds one bundled content entry and an ESM service worker", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "public", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
  assert.equal(manifest.background.type, "module");
  const build = fs.readFileSync(path.join(root, "scripts", "build-extension.mjs"), "utf8");
  assert.match(build, /from "esbuild"/);
  assert.match(build, /dist["'], "extension/);
});
test("identity helpers keep chapter query and ignore image signing rotation", () => {
  const chapterA = R.buildChapterId("https://comic.test/chapter/7?quality=high#panel-3");
  const chapterB = R.buildChapterId("https://comic.test/chapter/7?quality=high#panel-9");
  const chapterC = R.buildChapterId("https://comic.test/chapter/7?quality=low");
  assert.equal(chapterA, chapterB);
  assert.notEqual(chapterA, chapterC);
  const sourceA = R.normalizeStableImageSource("https://cdn.test/p/1.jpg?width=1000&signature=old&credential=a&expires=1");
  const sourceB = R.normalizeStableImageSource("https://cdn.test/p/1.jpg?expires=2&credential=b&signature=new&width=1000");
  assert.equal(sourceA, sourceB);
  assert.equal(R.normalizeStableImageSource("https://cdn.test/p/1.jpg?width=1000&X-Amz-Date=now&X-Amz-Algorithm=a&X-Amz-SignedHeaders=host"), R.normalizeStableImageSource("https://cdn.test/p/1.jpg?width=1000&X-Amz-Date=later&X-Amz-Algorithm=b&X-Amz-SignedHeaders=other"));
  assert.equal(R.buildPageId({
    chapterId: chapterA,
    source: sourceA,
    width: 1000,
    height: 1600
  }), R.buildPageId({
    chapterId: chapterA,
    source: sourceB,
    width: 1000,
    height: 1600
  }));
});
test("Observation IDs are stable, punctuation-sensitive, and independent of provider array IDs", () => {
  const input = {
    provider: "local",
    captureId: "page:stable",
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: {
      "page-a": "rev-a"
    },
    pageSpans: [{
      pageId: "page-a",
      box: {
        x: 10.00001,
        y: 20,
        w: 30,
        h: 10
      },
      coordinateSpace: "percent"
    }],
    originalText: "Hello world",
    providerBlockId: "row-1"
  };
  const first = R.createObservation(input);
  const providerReordered = R.createObservation({
    ...input,
    providerBlockId: "row-99",
    pageSpans: [{
      ...input.pageSpans[0],
      box: {
        x: 10.00002,
        y: 20,
        w: 30,
        h: 10
      }
    }]
  });
  const punctuated = R.createObservation({
    ...input,
    originalText: "Hello world!"
  });
  assert.equal(first.id, providerReordered.id);
  assert.notEqual(first.id, punctuated.id);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.pageSpans[0]), true);
});
test("seam band stays narrow so complete page text never becomes seam OCR input", () => {
  assert.equal(R.calculateSeamBandHeight(500, 900), 75);
  assert.equal(R.calculateSeamBandHeight(760, 760), 96);
  assert.equal(R.calculateSeamBandHeight(2000, 2400), 96);
  assert.equal(R.calculateSeamBandHeight(4000, 5000), 96);
});
test("seam plan crops only the two edge bands and collapses detected overlap on its canvas", () => {
  const upper = page("a", 0, {
    width: 1200,
    height: 100
  });
  const lower = page("b", 1, {
    width: 1000,
    height: 2000
  });
  const plan = R.buildSeamPlan(upper, lower, {
    overlapPx: 25
  });
  assert.equal(plan.bandHeight, 96);
  assert.equal(plan.upperCrop.height, 96, "a short page is capped to the configured seam band");
  assert.equal(plan.lowerCrop.height, 96);
  assert.equal(plan.canvasHeight, 167);
  assert.equal(plan.draws[1].destY, 71);
});
test("interior page observations do not trigger seam OCR even when page overlapRatio is 1", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const interior = pageObservation(upper, "interior", {
    x: 20,
    y: 30,
    w: 30,
    h: 10
  }, {
    overlapRatio: 1
  });
  assert.deepEqual(R.evaluateSeamEvidence({
    pageA: upper,
    pageB: lower,
    observations: [interior]
  }).reasons, []);
  assert.equal(R.evaluateSeamEvidence({
    pageA: upper,
    pageB: lower,
    edgeSignals: {
      [upper.pageId]: {
        bottom: {
          detected: false,
          visualDetected: false,
          ids: []
        }
      },
      [lower.pageId]: {
        top: {
          detected: false,
          visualDetected: false,
          ids: []
        }
      }
    }
  }).shouldRun, false, "a structured false signal must not be truthy merely because it is an object");
});
test("stale edge observations cannot trigger seam OCR for current page revisions", () => {
  const upper = page("a", 0, {
    imageRevision: "current-a"
  });
  const lower = page("b", 1, {
    imageRevision: "current-b"
  });
  const stale = pageObservation({
    ...upper,
    imageRevision: "stale-a"
  }, "stale edge", {
    x: 20,
    y: 90,
    w: 40,
    h: 10
  });
  assert.equal(R.evaluateSeamEvidence({
    pageA: upper,
    pageB: lower,
    observations: [stale]
  }).shouldRun, false);
});
test("seam OCR evidence includes retained/filtered boxes, visual signals, short pages, and overlap risk", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperEdge = pageObservation(upper, "edge", {
    x: 20,
    y: 90,
    w: 30,
    h: 10
  });
  const filteredLower = {
    ...pageObservation(lower, "filtered", {
      x: 20,
      y: 0,
      w: 30,
      h: 10
    }),
    filterReason: "low_confidence"
  };
  const result = R.evaluateSeamEvidence({
    pageA: upper,
    pageB: {
      ...lower,
      shortPage: true
    },
    observations: [upperEdge],
    filteredObservations: [filteredLower],
    edgeSignals: {
      [lower.pageId]: {
        top: true
      }
    },
    overlapRisk: {
      detected: true
    }
  });
  assert.equal(result.shouldRun, true);
  assert.deepEqual(result.reasons, ["lower_ocr_edge", "lower_visual_edge", "pixel_overlap", "short_page", "upper_ocr_edge"]);
});
test("pair key is idempotent for DOM order but changes with image revision", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  assert.equal(R.buildSeamPairKey(upper, lower), R.buildSeamPairKey(lower, upper));
  assert.notEqual(R.buildSeamPairKey(upper, lower), R.buildSeamPairKey(upper, {
    ...lower,
    imageRevision: "revision-b-2"
  }));
});
test("accepted pixel-overlap detector shapes trigger seam evidence", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  for (const overlapRisk of [{
    accepted: true
  }, {
    risk: true
  }, {
    rows: 12
  }, {
    rows: [{
      mae: 1
    }]
  }]) {
    const result = R.evaluateSeamEvidence({
      pageA: upper,
      pageB: lower,
      overlapRisk
    });
    assert.equal(result.shouldRun, true);
    assert.ok(result.reasons.includes("pixel_overlap"));
  }
});
test("independent dialogue remains one canonical per page and every observation is resolved", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const first = pageObservation(upper, "first", {
    x: 5,
    y: 40,
    w: 30,
    h: 10
  });
  const second = pageObservation(lower, "second", {
    x: 65,
    y: 40,
    w: 30,
    h: 10
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second]
  });
  assert.equal(result.canonicals.length, 2);
  assert.deepEqual(Object.keys(result.ledger).sort(), [first.id, second.id].sort());
  assert.ok(Object.values(result.ledger).every(entry => entry.resolution === "standalone"));
});
test("duplicate boundary OCR merges and chooses the highest quality complete page text", () => {
  const fixture = boundaryFixture("오늘은 맑음", "오늘은 맑음.");
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [pageObservation(fixture.pages[0], "오늘은 맑음", fixture.upperBox, {
      confidence: 0.72
    }), pageObservation(fixture.pages[1], "오늘은 맑음.", fixture.lowerBox, {
      confidence: 0.98
    }), seamObservation(fixture.pages[0], fixture.pages[1], "오늘은 맑음.", fixture.upperBox, fixture.lowerBox)]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "오늘은 맑음.");
  assert.equal(result.diagnostics.acceptedEdges[0].type, "duplicate");
});
test("duplicate classification may still choose a more complete cross-page seam text", () => {
  const fixture = boundaryFixture("Hello worl", "Hello worl");
  const completeSeam = seamObservation(fixture.pages[0], fixture.pages[1], "Hello world!", fixture.upperBox, fixture.lowerBox, {
    confidence: 0.999
  });
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first, fixture.second, completeSeam]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.diagnostics.acceptedEdges[0].type, "duplicate");
  assert.equal(result.canonicals[0].originalText, "Hello world!");
});
test("continuation prefers a true cross-page seam observation", () => {
  const fixture = boundaryFixture("오늘 학교에", "갑니다.");
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [fixture.first, fixture.second, fixture.seam]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "오늘 학교에갑니다.");
  assert.equal(result.diagnostics.acceptedEdges[0].type, "continuation");
  assert.equal(new Set(result.canonicals[0].memberObservationIds).size, 3);
});
test("continuation concatenation trims an exact suffix/prefix overlap", () => {
  assert.equal(R.joinContinuationText("abcdef", "defghi"), "abcdefghi");
  assert.equal(R.joinContinuationText("hello", "hello"), "hello");
  assert.equal(R.joinContinuationText("", "next"), "next");
});
test("standalone seam prefix joins the longer lower-page continuation", () => {
  const upper = page("seam-prefix-upper", 0);
  const lower = page("seam-prefix-lower", 1);
  const upperBox = { x: 37, y: 97, w: 24, h: 3 };
  const lowerFragmentBox = { x: 40, y: 0, w: 20, h: 7 };
  const lowerSentenceBox = { x: 30, y: 3, w: 40, h: 23 };
  const seam = seamObservation(upper, lower, "김솔음이 개빡센", upperBox, lowerFragmentBox);
  const lowerSentence = pageObservation(lower, "개빡센 입사이틀을 보낸다음날,", lowerSentenceBox);
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [seam, lowerSentence]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "김솔음이 개빡센 입사이틀을 보낸다음날,");
  assert.deepEqual(result.canonicals[0].memberObservationIds, [lowerSentence.id, seam.id].sort());
  assert.ok(Object.values(result.ledger).every(entry => entry.resolution === "consumed"));
});
test("upper-page sentence absorbs a seam suffix instead of rendering two translations", () => {
  const upper = page("seam-suffix-upper", 0);
  const lower = page("seam-suffix-lower", 1);
  const upperSentence = pageObservation(upper, "담당자 실수로 <화요 퀴즈쇼>가 중복 배정되었다고", {
    x: 20.39,
    y: 80,
    w: 43.82,
    h: 16.3
  });
  const seam = seamObservation(upper, lower, "중복 배정되었다고 합니다.", {
    x: 20.66,
    y: 90,
    w: 43.29,
    h: 10
  }, {
    x: 20.66,
    y: 0,
    w: 43.29,
    h: 6
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperSentence, seam]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "담당자 실수로 <화요 퀴즈쇼>가 중복 배정되었다고 합니다.");
  assert.deepEqual(result.canonicals[0].memberObservationIds, [upperSentence.id, seam.id].sort());
  assert.ok(Object.values(result.ledger).every(entry => entry.resolution === "consumed"));
});
test("geometrically overlapping seam and page texts stay separate without a meaningful boundary overlap", () => {
  const upper = page("seam-unrelated-upper", 0);
  const lower = page("seam-unrelated-lower", 1);
  const seam = seamObservation(upper, lower, "첫 번째 말풍선", { x: 35, y: 96, w: 30, h: 4 }, { x: 35, y: 0, w: 30, h: 8 });
  const unrelated = pageObservation(lower, "완전히 다른 문장", { x: 30, y: 3, w: 40, h: 24 });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [seam, unrelated]
  });
  assert.equal(result.canonicals.length, 2);
  assert.notEqual(result.ledger[seam.id].canonicalId, result.ledger[unrelated.id].canonicalId);
});
test("same text in different horizontal positions is never merged", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const first = pageObservation(upper, "same", {
    x: 2,
    y: 90,
    w: 18,
    h: 10
  });
  const second = pageObservation(lower, "same", {
    x: 80,
    y: 0,
    w: 18,
    h: 10
  });
  const seam = seamObservation(upper, lower, "same", {
    x: 2,
    y: 90,
    w: 18,
    h: 10
  }, {
    x: 80,
    y: 0,
    w: 18,
    h: 10
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, seam]
  });
  assert.equal(result.canonicals.filter(canonical => canonical.memberObservationIds.includes(first.id)).length, 1);
  assert.equal(result.canonicals.filter(canonical => canonical.memberObservationIds.includes(second.id)).length, 1);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});
test("same-page equal text at different positions remains two authoritative canonicals", () => {
  const current = page("a", 0);
  const first = pageObservation(current, "repeat", {
    x: 10,
    y: 25,
    w: 25,
    h: 10
  }, {
    captureSuffix: "left"
  });
  const second = pageObservation(current, "repeat", {
    x: 65,
    y: 60,
    w: 25,
    h: 10
  }, {
    captureSuffix: "right"
  });
  const result = R.reconcile({
    pages: [current],
    observations: [second, first]
  });
  assert.equal(result.canonicals.length, 2);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});
test("different visual regions remain a hard constraint without strong seam evidence", () => {
  const fixture = boundaryFixture("part one", "part two");
  const first = pageObservation(fixture.pages[0], "part one", fixture.upperBox, {
    regionType: "dialogue"
  });
  const second = pageObservation(fixture.pages[1], "part two", fixture.lowerBox, {
    regionType: "effect_text"
  });
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [first, second],
    adjacentPagePairs: [[fixture.pages[0].pageId, fixture.pages[1].pageId]]
  });
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});
test("registered-order neighbors cannot merge without a confirmed real adjacency", () => {
  const firstPage = page("a", 0);
  const thirdPage = page("c", 2);
  const visual = {
    regionHash: "same-region",
    meanLuma: 250
  };
  const first = pageObservation(firstPage, "duplicate", {
    x: 30,
    y: 90,
    w: 40,
    h: 10
  }, {
    visual
  });
  const third = pageObservation(thirdPage, "duplicate", {
    x: 30,
    y: 0,
    w: 40,
    h: 10
  }, {
    visual
  });
  const unconfirmed = R.reconcile({
    pages: [firstPage, thirdPage],
    observations: [first, third]
  });
  assert.equal(unconfirmed.canonicals.length, 2);
  assert.equal(unconfirmed.diagnostics.needsReview[0].reason, "unconfirmed_adjacency");
  const explicitlyAdjacent = R.reconcile({
    pages: [firstPage, thirdPage],
    observations: [first, third],
    adjacentPagePairs: [[firstPage.pageId, thirdPage.pageId]]
  });
  assert.equal(explicitlyAdjacent.canonicals.length, 1);
});
test("an unrelated aligned seam remains standalone instead of replacing a singleton page authority", () => {
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
  const authoritative = pageObservation(upper, "foo", upperBox);
  const unrelatedSeam = seamObservation(upper, lower, "completely unrelated", upperBox, lowerBox);
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [authoritative, unrelatedSeam]
  });
  assert.equal(result.canonicals.length, 2);
  assert.equal(result.ledger[authoritative.id].resolution, "standalone");
  assert.equal(result.ledger[unrelatedSeam.id].resolution, "standalone");
  assert.notEqual(result.ledger[authoritative.id].canonicalId, result.ledger[unrelatedSeam.id].canonicalId);
});
test("a late unrelated seam cannot steal the stable ID of an existing page canonical", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const clippedPageBox = {
    x: 36.91,
    y: 98.45,
    w: 26.88,
    h: 1.55
  };
  const seamUpperBox = {
    x: 8.75,
    y: 98.55,
    w: 54.58,
    h: 1.45
  };
  const seamLowerBox = {
    x: 8.75,
    y: 0,
    w: 54.58,
    h: 2
  };
  const authoritative = pageObservation(upper, "그자고자하니는", clippedPageBox);
  const completeSeam = seamObservation(upper, lower, "다준이ㅋㅋㅋㅋ작곡 잘하네", seamUpperBox, seamLowerBox, {
    confidence: 0.99
  });
  const initial = R.reconcile({
    pages: [upper, lower],
    observations: [authoritative]
  });
  const revised = R.reconcile({
    pages: [upper, lower],
    observations: [authoritative, completeSeam],
    previousCanonicals: initial.canonicals
  });
  assert.equal(revised.canonicals.length, 2);
  assert.equal(new Set(revised.canonicals.map(canonical => canonical.id)).size, 2);
  assert.equal(revised.canonicals.find(canonical => canonical.memberObservationIds.includes(authoritative.id)).id, initial.canonicals[0].id);
  assert.notEqual(revised.ledger[authoritative.id].canonicalId, revised.ledger[completeSeam.id].canonicalId);
});
test("an unrelated aligned seam cannot supply the 25% support needed to merge page halves", () => {
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
  const unrelatedSeam = seamObservation(upper, lower, "totally unrelated evidence", upperBox, lowerBox);
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, unrelatedSeam]
  });
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.equal(result.ledger[unrelatedSeam.id].resolution, "standalone");
});
test("capture-local regionId equality cannot masquerade as shared visual evidence", () => {
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
  const visual = {
    regionId: "region-1",
    meanLuma: 250
  };
  const first = pageObservation(upper, "alpha", upperBox, {
    visual
  });
  const second = pageObservation(lower, "omega", lowerBox, {
    visual
  });
  const seam = seamObservation(upper, lower, "unrelated", upperBox, lowerBox, {
    visual
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [first, second, seam]
  });
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});
test("a strong cross-page seam joins fragments despite per-page region classifier drift", () => {
  const upper = page("title-upper", 0, {
    width: 760
  });
  const lower = page("title-lower", 1, {
    width: 760
  });
  const upperFragment = pageObservation(upper, "신입사원", {
    x: 29.7,
    y: 87,
    w: 41.4,
    h: 9.5
  }, {
    regionType: "effect_text",
    confidence: 0.95
  });
  const lowerFragment = pageObservation(lower, "수급기간의 시작이다.", {
    x: 22.7,
    y: 0,
    w: 55.8,
    h: 15.3
  }, {
    regionType: "caption_panel",
    confidence: 0.95
  });
  const completeSeam = seamObservation(upper, lower, "신입사원 수습기간의 시작이다.", {
    x: 22.6,
    y: 86.8,
    w: 55,
    h: 13.2
  }, {
    x: 22.6,
    y: 0,
    w: 55,
    h: 15.4
  }, {
    regionType: "caption_panel",
    upperOverlapRatio: 0.462,
    lowerOverlapRatio: 0.538,
    confidence: 0.99
  });
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperFragment, lowerFragment, completeSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds, [completeSeam.id, lowerFragment.id, upperFragment.id].sort());
  assert.equal(result.canonicals[0].originalText, "신입사원 수습기간의 시작이다.");
  for (const observation of [upperFragment, lowerFragment, completeSeam]) {
    assert.equal(result.ledger[observation.id].resolution, "consumed");
  }
});
