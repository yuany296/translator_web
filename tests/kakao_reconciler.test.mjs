import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

await import("../kakao-reconciler.js");

const R = globalThis.MangaTranslatorKakaoReconciler;

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
    imageRevisionByPage: { [pageValue.pageId]: pageValue.imageRevision },
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
    pageSpans: [
      {
        pageId: upper.pageId,
        box: upperBox,
        coordinateSpace: "percent",
        regionType: overrides.regionType || "dialogue",
        overlapRatio: overrides.upperOverlapRatio ?? 0.5
      },
      {
        pageId: lower.pageId,
        box: lowerBox,
        coordinateSpace: "percent",
        regionType: overrides.regionType || "dialogue",
        overlapRatio: overrides.lowerOverlapRatio ?? 0.5
      }
    ],
    originalText: text,
    confidence: overrides.confidence ?? 0.96,
    visual: { regionType: overrides.regionType || "dialogue", ...(overrides.visual || {}) }
  });
}

function boundaryFixture(textA = "오늘 학교에", textB = "갑니다.") {
  const upper = page("page-a", 0);
  const lower = page("page-b", 1);
  const upperBox = { x: 28, y: 88, w: 44, h: 12 };
  const lowerBox = { x: 29, y: 0, w: 43, h: 12 };
  const first = pageObservation(upper, textA, upperBox);
  const second = pageObservation(lower, textB, lowerBox);
  const seam = seamObservation(upper, lower, `${textA}${textB}`, upperBox, lowerBox);
  return { pages: [upper, lower], first, second, seam, upperBox, lowerBox };
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

test("module is registered before the Kakao pipeline in every injection path", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.content_scripts[0].js,
    ["kakao-reconciler.js", "kakao-pipeline.js", "content.js"]
  );
  const popup = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  assert.match(popup, /Object\.freeze\(\["kakao-reconciler\.js", "kakao-pipeline\.js", "content\.js"\]\)/);
  const build = fs.readFileSync(path.join(root, "scripts", "build-extension.mjs"), "utf8");
  assert.match(build, /"kakao-reconciler\.js"/);
});

test("identity helpers keep chapter query and ignore image signing rotation", () => {
  const chapterA = R.buildChapterId("https://comic.test/chapter/7?quality=high#panel-3");
  const chapterB = R.buildChapterId("https://comic.test/chapter/7?quality=high#panel-9");
  const chapterC = R.buildChapterId("https://comic.test/chapter/7?quality=low");
  assert.equal(chapterA, chapterB);
  assert.notEqual(chapterA, chapterC);

  const sourceA = R.normalizeStableImageSource(
    "https://cdn.test/p/1.jpg?width=1000&signature=old&credential=a&expires=1"
  );
  const sourceB = R.normalizeStableImageSource(
    "https://cdn.test/p/1.jpg?expires=2&credential=b&signature=new&width=1000"
  );
  assert.equal(sourceA, sourceB);
  assert.equal(
    R.normalizeStableImageSource("https://cdn.test/p/1.jpg?width=1000&X-Amz-Date=now&X-Amz-Algorithm=a&X-Amz-SignedHeaders=host"),
    R.normalizeStableImageSource("https://cdn.test/p/1.jpg?width=1000&X-Amz-Date=later&X-Amz-Algorithm=b&X-Amz-SignedHeaders=other")
  );
  assert.equal(
    R.buildPageId({ chapterId: chapterA, source: sourceA, width: 1000, height: 1600 }),
    R.buildPageId({ chapterId: chapterA, source: sourceB, width: 1000, height: 1600 })
  );
});

test("Observation IDs are stable, punctuation-sensitive, and independent of provider array IDs", () => {
  const input = {
    provider: "local",
    captureId: "page:stable",
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: { "page-a": "rev-a" },
    pageSpans: [{
      pageId: "page-a",
      box: { x: 10.00001, y: 20, w: 30, h: 10 },
      coordinateSpace: "percent"
    }],
    originalText: "Hello world",
    providerBlockId: "row-1"
  };
  const first = R.createObservation(input);
  const providerReordered = R.createObservation({
    ...input,
    providerBlockId: "row-99",
    pageSpans: [{ ...input.pageSpans[0], box: { x: 10.00002, y: 20, w: 30, h: 10 } }]
  });
  const punctuated = R.createObservation({ ...input, originalText: "Hello world!" });
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
  const upper = page("a", 0, { width: 1200, height: 100 });
  const lower = page("b", 1, { width: 1000, height: 2000 });
  const plan = R.buildSeamPlan(upper, lower, { overlapPx: 25 });
  assert.equal(plan.bandHeight, 96);
  assert.equal(plan.upperCrop.height, 96, "a short page is capped to the configured seam band");
  assert.equal(plan.lowerCrop.height, 96);
  assert.equal(plan.canvasHeight, 167);
  assert.equal(plan.draws[1].destY, 71);
});

test("interior page observations do not trigger seam OCR even when page overlapRatio is 1", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const interior = pageObservation(upper, "interior", { x: 20, y: 30, w: 30, h: 10 }, { overlapRatio: 1 });
  assert.deepEqual(
    R.evaluateSeamEvidence({ pageA: upper, pageB: lower, observations: [interior] }).reasons,
    []
  );
  assert.equal(R.evaluateSeamEvidence({
    pageA: upper,
    pageB: lower,
    edgeSignals: {
      [upper.pageId]: { bottom: { detected: false, visualDetected: false, ids: [] } },
      [lower.pageId]: { top: { detected: false, visualDetected: false, ids: [] } }
    }
  }).shouldRun, false, "a structured false signal must not be truthy merely because it is an object");
});

test("stale edge observations cannot trigger seam OCR for current page revisions", () => {
  const upper = page("a", 0, { imageRevision: "current-a" });
  const lower = page("b", 1, { imageRevision: "current-b" });
  const stale = pageObservation(
    { ...upper, imageRevision: "stale-a" },
    "stale edge",
    { x: 20, y: 90, w: 40, h: 10 }
  );
  assert.equal(R.evaluateSeamEvidence({ pageA: upper, pageB: lower, observations: [stale] }).shouldRun, false);
});

test("seam OCR evidence includes retained/filtered boxes, visual signals, short pages, and overlap risk", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperEdge = pageObservation(upper, "edge", { x: 20, y: 90, w: 30, h: 10 });
  const filteredLower = {
    ...pageObservation(lower, "filtered", { x: 20, y: 0, w: 30, h: 10 }),
    filterReason: "low_confidence"
  };
  const result = R.evaluateSeamEvidence({
    pageA: upper,
    pageB: { ...lower, shortPage: true },
    observations: [upperEdge],
    filteredObservations: [filteredLower],
    edgeSignals: { [lower.pageId]: { top: true } },
    overlapRisk: { detected: true }
  });
  assert.equal(result.shouldRun, true);
  assert.deepEqual(result.reasons, [
    "lower_ocr_edge",
    "lower_visual_edge",
    "pixel_overlap",
    "short_page",
    "upper_ocr_edge"
  ]);
});

test("pair key is idempotent for DOM order but changes with image revision", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  assert.equal(R.buildSeamPairKey(upper, lower), R.buildSeamPairKey(lower, upper));
  assert.notEqual(
    R.buildSeamPairKey(upper, lower),
    R.buildSeamPairKey(upper, { ...lower, imageRevision: "revision-b-2" })
  );
});

test("accepted pixel-overlap detector shapes trigger seam evidence", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  for (const overlapRisk of [
    { accepted: true },
    { risk: true },
    { rows: 12 },
    { rows: [{ mae: 1 }] }
  ]) {
    const result = R.evaluateSeamEvidence({ pageA: upper, pageB: lower, overlapRisk });
    assert.equal(result.shouldRun, true);
    assert.ok(result.reasons.includes("pixel_overlap"));
  }
});

test("independent dialogue remains one canonical per page and every observation is resolved", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const first = pageObservation(upper, "first", { x: 5, y: 40, w: 30, h: 10 });
  const second = pageObservation(lower, "second", { x: 65, y: 40, w: 30, h: 10 });
  const result = R.reconcile({ pages: [upper, lower], observations: [first, second] });
  assert.equal(result.canonicals.length, 2);
  assert.deepEqual(Object.keys(result.ledger).sort(), [first.id, second.id].sort());
  assert.ok(Object.values(result.ledger).every((entry) => entry.resolution === "standalone"));
});

test("duplicate boundary OCR merges and chooses the highest quality complete page text", () => {
  const fixture = boundaryFixture("오늘은 맑음", "오늘은 맑음.");
  const result = R.reconcile({
    pages: fixture.pages,
    observations: [
      pageObservation(fixture.pages[0], "오늘은 맑음", fixture.upperBox, { confidence: 0.72 }),
      pageObservation(fixture.pages[1], "오늘은 맑음.", fixture.lowerBox, { confidence: 0.98 }),
      seamObservation(fixture.pages[0], fixture.pages[1], "오늘은 맑음.", fixture.upperBox, fixture.lowerBox)
    ]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "오늘은 맑음.");
  assert.equal(result.diagnostics.acceptedEdges[0].type, "duplicate");
});

test("duplicate classification may still choose a more complete cross-page seam text", () => {
  const fixture = boundaryFixture("Hello worl", "Hello worl");
  const completeSeam = seamObservation(
    fixture.pages[0],
    fixture.pages[1],
    "Hello world!",
    fixture.upperBox,
    fixture.lowerBox,
    { confidence: 0.999 }
  );
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
  const result = R.reconcile({ pages: fixture.pages, observations: [fixture.first, fixture.second, fixture.seam] });
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

test("same text in different horizontal positions is never merged", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const first = pageObservation(upper, "same", { x: 2, y: 90, w: 18, h: 10 });
  const second = pageObservation(lower, "same", { x: 80, y: 0, w: 18, h: 10 });
  const seam = seamObservation(
    upper,
    lower,
    "same",
    { x: 2, y: 90, w: 18, h: 10 },
    { x: 80, y: 0, w: 18, h: 10 }
  );
  const result = R.reconcile({ pages: [upper, lower], observations: [first, second, seam] });
  assert.equal(result.canonicals.filter((canonical) => canonical.memberObservationIds.includes(first.id)).length, 1);
  assert.equal(result.canonicals.filter((canonical) => canonical.memberObservationIds.includes(second.id)).length, 1);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});

test("same-page equal text at different positions remains two authoritative canonicals", () => {
  const current = page("a", 0);
  const first = pageObservation(current, "repeat", { x: 10, y: 25, w: 25, h: 10 }, { captureSuffix: "left" });
  const second = pageObservation(current, "repeat", { x: 65, y: 60, w: 25, h: 10 }, { captureSuffix: "right" });
  const result = R.reconcile({ pages: [current], observations: [second, first] });
  assert.equal(result.canonicals.length, 2);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});

test("different visual regions remain a hard constraint without strong seam evidence", () => {
  const fixture = boundaryFixture("part one", "part two");
  const first = pageObservation(fixture.pages[0], "part one", fixture.upperBox, { regionType: "dialogue" });
  const second = pageObservation(fixture.pages[1], "part two", fixture.lowerBox, { regionType: "effect_text" });
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
  const visual = { regionHash: "same-region", meanLuma: 250 };
  const first = pageObservation(firstPage, "duplicate", { x: 30, y: 90, w: 40, h: 10 }, { visual });
  const third = pageObservation(thirdPage, "duplicate", { x: 30, y: 0, w: 40, h: 10 }, { visual });
  const unconfirmed = R.reconcile({ pages: [firstPage, thirdPage], observations: [first, third] });
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
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
  const authoritative = pageObservation(upper, "foo", upperBox);
  const unrelatedSeam = seamObservation(upper, lower, "completely unrelated", upperBox, lowerBox);
  const result = R.reconcile({ pages: [upper, lower], observations: [authoritative, unrelatedSeam] });
  assert.equal(result.canonicals.length, 2);
  assert.equal(result.ledger[authoritative.id].resolution, "standalone");
  assert.equal(result.ledger[unrelatedSeam.id].resolution, "standalone");
  assert.notEqual(result.ledger[authoritative.id].canonicalId, result.ledger[unrelatedSeam.id].canonicalId);
});

test("an unrelated aligned seam cannot supply the 25% support needed to merge page halves", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
  const first = pageObservation(upper, "foo", upperBox);
  const second = pageObservation(lower, "bar", lowerBox);
  const unrelatedSeam = seamObservation(upper, lower, "totally unrelated evidence", upperBox, lowerBox);
  const result = R.reconcile({ pages: [upper, lower], observations: [first, second, unrelatedSeam] });
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.equal(result.ledger[unrelatedSeam.id].resolution, "standalone");
});

test("capture-local regionId equality cannot masquerade as shared visual evidence", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
  const visual = { regionId: "region-1", meanLuma: 250 };
  const first = pageObservation(upper, "alpha", upperBox, { visual });
  const second = pageObservation(lower, "omega", lowerBox, { visual });
  const seam = seamObservation(upper, lower, "unrelated", upperBox, lowerBox, { visual });
  const result = R.reconcile({ pages: [upper, lower], observations: [first, second, seam] });

  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});

test("a strong cross-page seam joins fragments despite per-page region classifier drift", () => {
  const upper = page("title-upper", 0, { width: 760 });
  const lower = page("title-lower", 1, { width: 760 });
  const upperFragment = pageObservation(
    upper,
    "신입사원",
    { x: 29.7, y: 87, w: 41.4, h: 9.5 },
    { regionType: "effect_text", confidence: 0.95 }
  );
  const lowerFragment = pageObservation(
    lower,
    "수급기간의 시작이다.",
    { x: 22.7, y: 0, w: 55.8, h: 15.3 },
    { regionType: "caption_panel", confidence: 0.95 }
  );
  const completeSeam = seamObservation(
    upper,
    lower,
    "신입사원 수습기간의 시작이다.",
    { x: 22.6, y: 86.8, w: 55, h: 13.2 },
    { x: 22.6, y: 0, w: 55, h: 15.4 },
    {
      regionType: "caption_panel",
      upperOverlapRatio: 0.462,
      lowerOverlapRatio: 0.538,
      confidence: 0.99
    }
  );

  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperFragment, lowerFragment, completeSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });

  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds, [
    completeSeam.id,
    lowerFragment.id,
    upperFragment.id
  ].sort());
  assert.equal(result.canonicals[0].originalText, "신입사원 수습기간의 시작이다.");
  for (const observation of [upperFragment, lowerFragment, completeSeam]) {
    assert.equal(result.ledger[observation.id].resolution, "consumed");
  }
});

test("a cross-page seam joins a geometrically aligned fragment with one OCR substitution", () => {
  const upper = page("effect-upper", 0, { width: 760 });
  const lower = page("effect-lower", 1, { width: 760 });
  const upperFragment = pageObservation(
    upper,
    "저것이",
    { x: 36.97, y: 89, w: 25.53, h: 8.2 },
    { regionType: "effect_text", confidence: 0.99 }
  );
  const noisyLowerFragment = pageObservation(
    lower,
    "오럽자의'말로.",
    { x: 22.63, y: 0.1, w: 53.82, h: 4.1 },
    { regionType: "effect_text", confidence: 0.745 }
  );
  const correctedSeam = seamObservation(
    upper,
    lower,
    "저것이 오답자의말로.",
    { x: 22.37, y: 89, w: 54.34, h: 11 },
    { x: 22.37, y: 0, w: 54.34, h: 4.4 },
    {
      regionType: "effect_text",
      upperOverlapRatio: 0.714,
      lowerOverlapRatio: 0.286,
      confidence: 0.99
    }
  );

  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperFragment, noisyLowerFragment, correctedSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });

  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "저것이 오답자의말로.");
  assert.deepEqual(result.canonicals[0].memberObservationIds, [
    correctedSeam.id,
    noisyLowerFragment.id,
    upperFragment.id
  ].sort());
});

test("fuzzy seam fragments preserve semantic symbols instead of erasing them", () => {
  const upper = page("symbol-upper", 0);
  const lower = page("symbol-lower", 1);
  const upperBox = { x: 25, y: 89, w: 50, h: 10 };
  const lowerBox = { x: 25, y: 0, w: 50, h: 10 };
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
  const upper = page("two-errors-upper", 0, { width: 760 });
  const lower = page("two-errors-lower", 1, { width: 760 });
  const upperFragment = pageObservation(
    upper,
    "저것이",
    { x: 36.97, y: 89, w: 25.53, h: 8.2 },
    { regionType: "effect_text" }
  );
  const noisyLowerFragment = pageObservation(
    lower,
    "오럽자의말로.",
    { x: 22.63, y: 0.1, w: 53.82, h: 4.1 },
    { regionType: "effect_text" }
  );
  const unrelatedSeam = seamObservation(
    upper,
    lower,
    "저것이 오답자의길로.",
    { x: 22.37, y: 89, w: 54.34, h: 11 },
    { x: 22.37, y: 0, w: 54.34, h: 4.4 },
    {
      regionType: "effect_text",
      upperOverlapRatio: 0.714,
      lowerOverlapRatio: 0.286
    }
  );
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
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
  const first = pageObservation(upper, "foo", upperBox);
  const second = pageObservation(lower, "bar", lowerBox);
  const seam = seamObservation(upper, lower, "foo", upperBox, lowerBox);
  const result = R.reconcile({ pages: [upper, lower], observations: [first, second, seam] });

  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.notEqual(result.ledger[first.id].canonicalId, result.ledger[second.id].canonicalId);
});

test("a one-percent seam spill is not treated as true cross-page evidence", () => {
  const upper = page("a", 0);
  const lower = page("b", 1);
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
  const first = pageObservation(upper, "foo", upperBox);
  const second = pageObservation(lower, "bar", lowerBox);
  const seam = seamObservation(upper, lower, "foobar", upperBox, lowerBox, {
    upperOverlapRatio: 0.99,
    lowerOverlapRatio: 0.01
  });
  const result = R.reconcile({ pages: [upper, lower], observations: [first, second, seam] });

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
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
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
  const authoritative = pageObservation(
    lower,
    "천장에서 뭐가 흘러내려!",
    { x: 35, y: 6.5, w: 30, h: 20.7 }
  );
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
      box: { x: 35, y: 6.2, w: 30, h: 9.8 },
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
  const seam = seamObservation(
    upper,
    lower,
    "진짜跨页대사",
    { x: 30, y: 88, w: 40, h: 12 },
    { x: 30, y: 0, w: 40, h: 12 },
    { upperOverlapRatio: 0.45, lowerOverlapRatio: 0.55 }
  );
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
  const oldA = page("old-a", 0, { chapterId: "old" });
  const newA = page("new-a", 10, { chapterId: "new" });
  const oldB = page("old-b", 100, { chapterId: "old" });
  const newB = page("new-b", 110, { chapterId: "new" });
  const upperBox = { x: 30, y: 90, w: 40, h: 10 };
  const lowerBox = { x: 30, y: 0, w: 40, h: 10 };
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
  const result = R.reconcile({ pages: fixture.pages, observations: [fixture.first, fixture.second] });
  assert.equal(result.canonicals.length, 2);
  assert.equal(result.diagnostics.acceptedEdges.length, 0);
  assert.equal(result.diagnostics.needsReview.length, 1);
  assert.ok(result.diagnostics.needsReview[0].score >= 0.60);
  assert.ok(result.diagnostics.needsReview[0].score < 0.75);
  assert.ok(result.canonicals.every((canonical) => canonical.status === "needs_review"));
});

test("a short middle page may form a deterministic three-page component", () => {
  const firstPage = page("a", 0);
  const middlePage = page("b", 1, { height: 180, shortPage: true });
  const lastPage = page("c", 2);
  const first = pageObservation(firstPage, "one", { x: 30, y: 88, w: 40, h: 12 });
  const middle = pageObservation(middlePage, "two", { x: 30, y: 0, w: 40, h: 100 });
  const last = pageObservation(lastPage, "three", { x: 30, y: 0, w: 40, h: 12 });
  const seamAB = seamObservation(firstPage, middlePage, "onetwo", { x: 30, y: 88, w: 40, h: 12 }, { x: 30, y: 0, w: 40, h: 100 });
  const seamBC = seamObservation(middlePage, lastPage, "twothree", { x: 30, y: 0, w: 40, h: 100 }, { x: 30, y: 0, w: 40, h: 12 });
  const result = R.reconcile({
    pages: [firstPage, middlePage, lastPage],
    observations: [first, middle, last, seamAB, seamBC]
  });
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(Object.keys(result.canonicals[0].geometryByPage), ["a", "b", "c"]);
});

test("union-find never cascades one canonical across four pages", () => {
  const pages = [
    page("a", 0),
    page("b", 1, { height: 180, shortPage: true }),
    page("c", 2, { height: 180, shortPage: true }),
    page("d", 3)
  ];
  const observations = pages.map((current, index) => pageObservation(
    current,
    String(index),
    index === 0 ? { x: 30, y: 88, w: 40, h: 12 }
      : index === pages.length - 1 ? { x: 30, y: 0, w: 40, h: 12 }
        : { x: 30, y: 0, w: 40, h: 100 }
  ));
  for (let index = 0; index < pages.length - 1; index += 1) {
    observations.push(seamObservation(
      pages[index],
      pages[index + 1],
      `${index}${index + 1}`,
      index === 0 ? { x: 30, y: 88, w: 40, h: 12 } : { x: 30, y: 0, w: 40, h: 100 },
      index + 1 === pages.length - 1 ? { x: 30, y: 0, w: 40, h: 12 } : { x: 30, y: 0, w: 40, h: 100 }
    ));
  }
  const result = R.reconcile({ pages, observations });
  assert.ok(result.canonicals.length >= 2);
  assert.ok(result.canonicals.every((canonical) => Object.keys(canonical.geometryByPage).length <= 3));
});

test("reconciliation is idempotent and independent of OCR completion order", () => {
  const fixture = boundaryFixture();
  const inputs = [fixture.first, fixture.second, fixture.seam];
  const expected = R.reconcile({ pages: fixture.pages, observations: inputs });
  for (const order of permutations(inputs)) {
    const actual = R.reconcile({ pages: [...fixture.pages].reverse(), observations: order });
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
  const independent = pageObservation(fixture.pages[0], "independent", { x: 75, y: 40, w: 20, h: 8 });
  const values = [fixture.first, fixture.second, fixture.seam, independent];
  const expected = R.reconcile({ pages: fixture.pages, observations: values });
  let state = 0x12345678;
  function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  }
  for (let run = 0; run < 30; run += 1) {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    assert.deepEqual(R.reconcile({ pages: fixture.pages, observations: shuffled }), expected);
  }
});

test("versioned anonymous adjacent-page OCR golden reconciles to the locked semantic groups", () => {
  const fixturePath = path.resolve(import.meta.dirname, "fixtures", "kakao-canonical", "ocr-golden.json");
  const golden = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const pages = golden.pages.map((value, readingOrder) => ({ ...value, readingOrder }));
  const observations = [
    ...golden.ocr.page.flatMap((item) => item.observations),
    ...golden.ocr.seam.observations
  ];
  const filteredObservations = [
    ...golden.ocr.page.flatMap((item) => item.filteredObservations),
    ...golden.ocr.seam.filteredObservations
  ];
  const result = R.reconcile({ pages, observations, filteredObservations });
  assert.equal(result.canonicals.length, 3);
  const boundaryIds = [
    "obs-page-a-bottom-half",
    "obs-page-b-top-half",
    "obs-seam-complete"
  ].sort();
  const boundary = result.canonicals.find((canonical) =>
    canonical.memberObservationIds.length === boundaryIds.length
    && canonical.memberObservationIds.every((id, index) => id === boundaryIds[index]));
  assert.ok(boundary, "the two authoritative halves and seam evidence must form one canonical");
  assert.equal(boundary.originalText, golden.ocr.seam.observations[0].originalText);
  assert.equal(result.ledger["obs-page-a-filtered-noise"].resolution, "filtered");
  assert.equal(
    result.ledger["obs-page-a-filtered-noise"].filterReason,
    "meaningless-alphabetic-final"
  );
  assert.deepEqual(
    R.reconcile({
      pages: [...pages].reverse(),
      observations: [...observations].reverse(),
      filteredObservations: [...filteredObservations].reverse()
    }),
    result
  );
});

test("late evidence preserves a canonical ID and increments revision exactly once", () => {
  const fixture = boundaryFixture();
  const initial = R.reconcile({ pages: fixture.pages, observations: [fixture.first] });
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

test("active boundary canonical revision, supersedesId, and projections are invariant to A/B history", () => {
  const fixture = boundaryFixture();
  const forwardInitial = R.reconcile({ pages: fixture.pages, observations: [fixture.first] });
  const reverseInitial = R.reconcile({ pages: fixture.pages, observations: [fixture.second] });
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
  assert.deepEqual(
    R.buildRenderProjections({ pages: fixture.pages, canonicals: forward.canonicals, translations }),
    R.buildRenderProjections({ pages: fixture.pages, canonicals: reverse.canonicals, translations })
  );
});

test("a late earlier-page anchor creates a new ID and explicitly supersedes the old canonical", () => {
  const fixture = boundaryFixture();
  const initial = R.reconcile({ pages: fixture.pages, observations: [fixture.second] });
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
  const current = page("a", 0, { imageRevision: "new-revision" });
  const stale = pageObservation({ ...current, imageRevision: "old-revision" }, "old text", { x: 20, y: 20, w: 30, h: 10 });
  const fresh = pageObservation(current, "new text", { x: 20, y: 20, w: 30, h: 10 });
  const result = R.reconcile({ pages: [current], observations: [stale, fresh] });
  assert.equal(result.ledger[stale.id].resolution, "filtered");
  assert.equal(result.ledger[stale.id].filterReason, "stale_revision");
  assert.equal(result.canonicals.some((canonical) => canonical.memberObservationIds.includes(stale.id)), false);
  assert.equal(result.canonicals.some((canonical) => canonical.memberObservationIds.includes(fresh.id)), true);
});

test("provider-filtered observations require a reason and satisfy total coverage", () => {
  const current = page("a", 0);
  const active = pageObservation(current, "kept", { x: 10, y: 20, w: 30, h: 10 });
  const filtered = R.createObservation({
    ...pageObservation(current, "noise", { x: 60, y: 20, w: 20, h: 10 }),
    id: undefined,
    captureId: "filtered-noise",
    filterReason: "low_confidence"
  });
  const result = R.reconcile({ pages: [current], observations: [active], filteredObservations: [filtered] });
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
      a: [{ box: { x: 20, y: 80, w: 20, h: 10 }, coordinateSpace: "percent" }],
      b: [{ box: { x: 20, y: 0, w: 40, h: 20 }, coordinateSpace: "percent" }]
    }
  };
  const translations = { "canonical-1@4": { translated_text: "译文" } };
  const normal = R.buildRenderProjections({ pages, canonicals: [canonical], translations });
  assert.equal(normal.filter((projection) => projection.activeText).length, 1);
  assert.equal(normal.find((projection) => projection.activeText).pageId, "b");
  assert.equal(normal.find((projection) => projection.pageId === "a").coverOnly, true);

  const failedOver = R.buildRenderProjections({
    pages,
    canonicals: [canonical],
    translations,
    availablePageIds: ["a"]
  });
  assert.equal(failedOver.filter((projection) => projection.activeText).length, 1);
  assert.equal(failedOver.find((projection) => projection.activeText).pageId, "a");
  assert.equal(failedOver.find((projection) => projection.activeText).translatedText, "译文");
});

test("render projections accept the pipeline's canonical.translation wire shape", () => {
  const current = page("a", 0);
  const projections = R.buildRenderProjections({
    pages: [current],
    canonicals: [{
      id: "canonical-wire",
      revision: 2,
      originalText: "source",
      translation: { translated_text: "管线译文" },
      geometryByPage: {
        a: [{ box: { x: 10, y: 10, w: 30, h: 10 }, coordinateSpace: "percent" }]
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
    fillBox: { x: 27, y: 87, w: 46, h: 13 }
  };
  const first = pageObservation(fixture.pages[0], "first", fixture.upperBox, { confidence: 0.99, visual });
  const second = pageObservation(fixture.pages[1], "second", fixture.lowerBox, { confidence: 0.99, visual });
  const seam = seamObservation(fixture.pages[0], fixture.pages[1], "firstsecond", fixture.upperBox, fixture.lowerBox, {
    confidence: 0.8,
    visual: { bgType: "none", bgConfidence: 0.1 }
  });
  const result = R.reconcile({ pages: fixture.pages, observations: [first, second, seam] });
  const projections = R.buildRenderProjections({
    pages: fixture.pages,
    canonicals: result.canonicals,
    translations: { [`${result.canonicals[0].id}@${result.canonicals[0].revision}`]: "译文" }
  });
  assert.deepEqual(new Set(projections.map((projection) => projection.role)), new Set(["primary", "cover", "standby"]));
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
    pageSpans: [
      {
        pageId: upper.pageId,
        box: { x: 20, y: 90, w: 50, h: 10 },
        polygon: [[20, 90], [70, 90], [70, 100], [20, 100]],
        coordinateSpace: "percent"
      },
      {
        pageId: lower.pageId,
        box: { x: 25, y: 0, w: 45, h: 12 },
        polygon: [[25, 0], [70, 0], [70, 12], [25, 12]],
        coordinateSpace: "percent"
      }
    ],
    originalText: "seam only",
    confidence: 0.99,
    visual: {
      bgType: "solid",
      bgColor: "#ffffff",
      bgConfidence: 0.95,
      fillBox: { x: 5, y: 40, w: 90, h: 20 },
      polygon: [[5, 40], [95, 40], [95, 60], [5, 60]],
      regionPolygon: [[5, 40], [95, 40], [95, 60], [5, 60]]
    }
  });
  const result = R.reconcile({ pages: [upper, lower], observations: [seam] });
  const projections = R.buildRenderProjections({ pages: [upper, lower], canonicals: result.canonicals });
  for (const projection of projections) {
    const expected = projection.pageId === upper.pageId
      ? { left: 20, top: 90, width: 50, height: 10 }
      : { left: 25, top: 0, width: 45, height: 12 };
    assert.deepEqual(projection.visual.fillBox, expected);
    assert.notDeepEqual(projection.visual.fillBox, { x: 5, y: 40, w: 90, h: 20 });
    assert.equal(projection.visual.bgType, "solid");
    assert.deepEqual(projection.visual.polygon[0], { x: expected.left, y: expected.top });
  }
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
        a: [{ box: { x: 10, y: 80, w: 20, h: 10 }, coordinateSpace: "percent" }],
        b: [{ box: { x: 10, y: 0, w: 20, h: 10 }, coordinateSpace: "percent" }]
      }
    }]
  });
  assert.equal(projections.find((projection) => projection.activeText).pageId, "a");
});

test("Canonical Store preserves stale revision evidence, serializes transactions, and merges inflight work", async () => {
  const store = R.createCanonicalStore();
  const oldPage = page("a", 0, { imageRevision: "old" });
  const newPage = page("a", 0, { imageRevision: "new" });
  const oldObservation = pageObservation(oldPage, "old", { x: 20, y: 20, w: 30, h: 10 });
  const newObservation = pageObservation(newPage, "new", { x: 20, y: 20, w: 30, h: 10 });
  store.upsertPage(oldPage);
  store.setPageObservations("a", [oldObservation]);
  store.upsertPage(newPage);
  store.setPageObservations("a", [newObservation]);
  const snapshot = store.reconcile();
  assert.equal(snapshot.ledger[oldObservation.id].filterReason, "stale_revision");
  assert.equal(store.getObservations().length, 2);

  const order = [];
  await Promise.all([
    store.runSerialized(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); order.push("first"); }),
    store.runSerialized(async () => { order.push("second"); })
  ]);
  assert.deepEqual(order, ["first", "second"]);

  let calls = 0;
  const first = store.getOrCreateInflight("ocr:a", async () => { calls += 1; return "ok"; });
  const second = store.getOrCreateInflight("ocr:a", async () => { calls += 1; return "duplicate"; });
  assert.equal(first, second);
  assert.equal(await first, "ok");
  assert.equal(calls, 1);
});
