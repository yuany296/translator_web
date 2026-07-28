import assert from "node:assert/strict";
import test from "node:test";
import {
  createReconcilerRuntime,
  reconciler as R
} from "../extension/src/canonical/reconciler.js";

function page(pageId, readingOrder) {
  return {
    pageId,
    chapterId: "fragment-group-chapter",
    imageRevision: `revision-${pageId}`,
    width: 1000,
    height: 1000,
    readingOrder
  };
}

function pageObservation(pageValue, text, box, translationRole = "", regionType = "dialogue") {
  return R.createObservation({
    provider: "fixture-ocr",
    captureId: `page:${pageValue.pageId}:${text}:${box.x}`,
    sourceType: "page",
    pageIds: [pageValue.pageId],
    imageRevisionByPage: { [pageValue.pageId]: pageValue.imageRevision },
    pageSpans: [{
      pageId: pageValue.pageId,
      box,
      coordinateSpace: "percent",
      regionType,
      overlapRatio: 1
    }],
    originalText: text,
    confidence: 0.94,
    visual: {
      regionType,
      translationRole
    }
  });
}

function seamObservation(upper, lower, text, upperBox, lowerBox, translationRole = "",
  regionType = "dialogue") {
  return R.createObservation({
    provider: "fixture-ocr",
    captureId: `seam:${upper.pageId}:${lower.pageId}:${text}`,
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
      regionType,
      overlapRatio: 0.4
    }, {
      pageId: lower.pageId,
      box: lowerBox,
      coordinateSpace: "percent",
      regionType,
      overlapRatio: 0.6
    }],
    originalText: text,
    confidence: 0.99,
    visual: {
      regionType,
      translationRole
    }
  });
}

function seamCaptureFragment(upper, lower, captureId, pageValue, text, box, regionId = "") {
  return R.createObservation({
    provider: "fixture-ocr",
    captureId,
    sourceType: "seam",
    pageIds: [upper.pageId, lower.pageId],
    imageRevisionByPage: {
      [upper.pageId]: upper.imageRevision,
      [lower.pageId]: lower.imageRevision
    },
    pageSpans: [{
      pageId: pageValue.pageId,
      box,
      coordinateSpace: "percent",
      regionType: "dialogue",
      overlapRatio: 1
    }],
    originalText: text,
    confidence: 0.98,
    visual: { regionType: "dialogue", regionId }
  });
}

function oneUpperManyLowerFixture() {
  const upper = page("fragment-upper", 0);
  const lower = page("fragment-lower", 1);
  const upperFragment = pageObservation(upper, "키즈쇼의", { x: 36, y: 94, w: 28, h: 6 });
  const lowerFragments = [
    pageObservation(lower, "<화요", { x: 28, y: 0, w: 15.5, h: 3.2 }),
    pageObservation(lower, "퀴즈쇼>의", { x: 43.3, y: 0, w: 28.8, h: 3.2 }),
    pageObservation(lower, "A등급은", { x: 21.5, y: 3.3, w: 25, h: 12.4 }),
    pageObservation(lower, "인정되지 않았습니다.", { x: 45.5, y: 3.5, w: 33, h: 12.4 })
  ];
  const text = "키즈쇼의 <화요 퀴즈쇼>의 A등급은 인정되지 않았습니다.";
  const seam = seamObservation(upper, lower, text, { x: 21, y: 93, w: 58, h: 7 }, { x: 20, y: 0, w: 60, h: 16 });
  return { upper, lower, upperFragment, lowerFragments, seam, text };
}

function reconcileFixture(fixture, observations) {
  return R.reconcile({
    pages: [fixture.upper, fixture.lower],
    observations,
    adjacentPagePairs: [[fixture.upper.pageId, fixture.lower.pageId]]
  });
}

test("one upper fragment and many connected lower fragments form one seam canonical", () => {
  const fixture = oneUpperManyLowerFixture();
  const observations = [fixture.upperFragment, ...fixture.lowerFragments, fixture.seam];
  const result = reconcileFixture(fixture, observations);
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, fixture.text);
  assert.deepEqual(result.canonicals[0].memberObservationIds, observations.map(item => item.id).sort());
  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 1);
  assert.deepEqual(result.diagnostics.acceptedFragmentGroups[0].memberObservationIds,
    [fixture.upperFragment, ...fixture.lowerFragments].map(item => item.id).sort());
  for (const observation of observations) assert.equal(result.ledger[observation.id].resolution, "consumed");
});

test("a cross-page seam absorbs many lower fragments without an upper page OCR result", () => {
  const fixture = oneUpperManyLowerFixture();
  const observations = [...fixture.lowerFragments, fixture.seam];
  const result = reconcileFixture(fixture, observations);
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, fixture.text);
  assert.deepEqual(result.canonicals[0].memberObservationIds, observations.map(item => item.id).sort());
  assert.deepEqual(Object.keys(result.canonicals[0].geometryByPage), [fixture.upper.pageId, fixture.lower.pageId]);
  assert.deepEqual(result.diagnostics.acceptedFragmentGroups[0].memberObservationIds,
    fixture.lowerFragments.map(item => item.id).sort());
});

test("fragmented seam observations from one capture jointly authorize a lower-page group", () => {
  const upper = page("capture-upper", 0);
  const lower = page("capture-lower", 1);
  const captureId = "seam-capture:fragmented-lower";
  const lowerFragments = [
    pageObservation(lower, "<화요", { x: 28, y: 0, w: 15, h: 3.2 }),
    pageObservation(lower, "귀스쇼의", { x: 43, y: 0, w: 28, h: 3.2 }),
    pageObservation(lower, "A등급 인정되지", { x: 21, y: 3.4, w: 25, h: 12 }),
    pageObservation(lower, "재조정은 않았습니다.", { x: 45, y: 3.5, w: 33, h: 12 })
  ];
  const seamFragments = [
    seamCaptureFragment(upper, lower, captureId, upper, "unrelated upper edge", { x: 5, y: 94, w: 20, h: 6 }),
    ...lowerFragments.map(fragment => seamCaptureFragment(upper, lower, captureId, lower,
      fragment.originalText, fragment.pageSpans[0].box))
  ];
  const result = reconcileFixture({ upper, lower }, [...lowerFragments, ...seamFragments]);
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds,
    [...lowerFragments, ...seamFragments.slice(1)].map(item => item.id).sort());
  assert.equal(result.canonicals[0].originalText, lowerFragments.map(item => item.originalText).join(" "));
  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 1);
  assert.deepEqual(result.diagnostics.acceptedFragmentGroups[0].seamObservationIds,
    seamFragments.slice(1).map(item => item.id).sort());
  assert.equal(result.ledger[seamFragments[0].id].filterReason, "seam_context_only");
  for (const seam of seamFragments.slice(1)) assert.equal(result.ledger[seam.id].resolution, "consumed");
});

test("fragmented seam observations sharing one region link multi-fragment page components", () => {
  const upper = page("capture-both-upper", 0);
  const lower = page("capture-both-lower", 1);
  const captureId = "seam-capture:fragmented-both";
  const upperFragments = [
    pageObservation(upper, "upper left", { x: 28, y: 94, w: 20, h: 6 }),
    pageObservation(upper, "upper right", { x: 47, y: 94, w: 22, h: 6 })
  ];
  const lowerFragments = [
    pageObservation(lower, "lower left", { x: 28, y: 0, w: 20, h: 6 }),
    pageObservation(lower, "lower right", { x: 47, y: 0, w: 22, h: 6 })
  ];
  const seamFragments = [...upperFragments, ...lowerFragments].map(fragment => {
    const pageValue = fragment.pageIds[0] === upper.pageId ? upper : lower;
    return seamCaptureFragment(upper, lower, captureId, pageValue,
      fragment.originalText, fragment.pageSpans[0].box, "shared-bubble-region");
  });
  const result = reconcileFixture({ upper, lower }, [...upperFragments, ...lowerFragments, ...seamFragments]);
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds,
    [...upperFragments, ...lowerFragments, ...seamFragments].map(item => item.id).sort());
  assert.deepEqual(Object.keys(result.canonicals[0].geometryByPage), [upper.pageId, lower.pageId]);
});

test("multiple connected fragments on both pages are merged atomically", () => {
  const upper = page("both-upper", 0);
  const lower = page("both-lower", 1);
  const pageFragments = [
    pageObservation(upper, "첫 번째", { x: 27, y: 93, w: 24, h: 7 }),
    pageObservation(upper, "윗부분", { x: 50, y: 93, w: 23, h: 7 }),
    pageObservation(lower, "두 번째", { x: 26, y: 0, w: 24, h: 7 }),
    pageObservation(lower, "아랫부분", { x: 49, y: 0, w: 25, h: 7 })
  ];
  const seam = seamObservation(upper, lower, "첫 번째 윗부분 두 번째 아랫부분",
    { x: 25, y: 92, w: 50, h: 8 }, { x: 25, y: 0, w: 50, h: 8 });
  const result = reconcileFixture({ upper, lower }, [...pageFragments, seam]);
  assert.equal(result.canonicals.length, 1);
  assert.deepEqual(result.canonicals[0].memberObservationIds, [...pageFragments, seam].map(item => item.id).sort());
  assert.equal(result.diagnostics.acceptedFragmentGroups[0].memberObservationIds.length, 4);
});

test("fragment grouping is deterministic across observation input order", () => {
  const fixture = oneUpperManyLowerFixture();
  const observations = [fixture.upperFragment, ...fixture.lowerFragments, fixture.seam];
  const expected = reconcileFixture(fixture, observations);
  for (const reordered of [
    [...observations].reverse(),
    [fixture.lowerFragments[2], fixture.seam, fixture.lowerFragments[0], fixture.upperFragment,
      fixture.lowerFragments[3], fixture.lowerFragments[1]]
  ]) {
    const actual = reconcileFixture(fixture, reordered);
    assert.deepEqual(actual.canonicals, expected.canonicals);
    assert.deepEqual(actual.ledger, expected.ledger);
    assert.deepEqual(actual.diagnostics.acceptedFragmentGroups, expected.diagnostics.acceptedFragmentGroups);
  }
});

test("a disconnected edge fragment is not absorbed by the selected seam group", () => {
  const fixture = oneUpperManyLowerFixture();
  const disconnected = pageObservation(fixture.lower, "<화요", { x: 88, y: 0, w: 10, h: 3.2 });
  const result = reconcileFixture(fixture,
    [fixture.upperFragment, ...fixture.lowerFragments, disconnected, fixture.seam]);
  assert.equal(result.canonicals.length, 2);
  const grouped = result.canonicals.find(item => item.memberObservationIds.includes(fixture.seam.id));
  assert.ok(grouped);
  assert.equal(grouped.memberObservationIds.includes(disconnected.id), false);
  assert.notEqual(result.ledger[disconnected.id].canonicalId, result.ledger[fixture.seam.id].canonicalId);
});

test("explicit forum roles remain hard boundaries at a page seam", () => {
  const upper = page("forum-upper", 0);
  const lower = page("forum-lower", 1);
  const nickname = pageObservation(upper, "김민수", { x: 34, y: 94, w: 20, h: 6 }, "chat_nickname");
  const timestamp = pageObservation(lower, "오후 7:30", { x: 34, y: 0, w: 20, h: 6 }, "chat_time");
  const seam = seamObservation(upper, lower, "김민수 오후 7:30",
    { x: 30, y: 93, w: 30, h: 7 }, { x: 30, y: 0, w: 30, h: 7 });
  const result = reconcileFixture({ upper, lower }, [nickname, timestamp, seam]);
  assert.notEqual(result.ledger[nickname.id].canonicalId, result.ledger[timestamp.id].canonicalId);
  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 0);
  assert.equal(result.diagnostics.rejectedFragmentGroups[0].reason, "fragment_group_not_coherent");
});

test("an atomic multi-line owner may absorb a cross-page continuation", () => {
  const runtime = createReconcilerRuntime();
  const upper = page("continuation-upper", 0);
  const lower = page("continuation-lower", 1);
  const upperLines = [
    pageObservation(upper, "이렇게", { x: 60, y: 90, w: 25, h: 4 }),
    pageObservation(upper, "마음 편히", { x: 60, y: 94, w: 25, h: 4 })
  ];
  const lowerSentence = pageObservation(lower, "먹어보는 게 얼마 만이더라.",
    { x: 22, y: 0, w: 56, h: 14 });
  const seam = seamObservation(upper, lower, "이렇게 마음 편히 먹어보는 게",
    { x: 58, y: 89, w: 30, h: 10 }, { x: 22, y: 0, w: 56, h: 8 });
  const pageObservations = [...upperLines, lowerSentence];
  const observationById = new Map(pageObservations.map(item => [item.id, item]));
  const pageById = new Map([[upper.pageId, upper], [lower.pageId, lower]]);
  const unionFind = runtime.createUnionFind(pageObservations);
  unionFind.union(upperLines[0].id, upperLines[1].id);
  const ownerRoot = unionFind.find(upperLines[0].id);

  assert.equal(runtime.canUnionComponents(
    unionFind, ownerRoot, lowerSentence.id, observationById, pageById
  ), false);
  assert.equal(runtime.canUnionContinuationBridge(
    unionFind, ownerRoot, lowerSentence.id, observationById, pageById
  ), true);
  const bridges = runtime.bridgeOwnedSeamContinuations(
    unionFind, pageObservations, [seam], new Map([[seam.id, ownerRoot]]),
    observationById, pageById
  );
  assert.equal(bridges.length, 1);
  assert.equal(unionFind.find(upperLines[0].id), unionFind.find(lowerSentence.id));
  assert.equal(runtime.expandSeamText(seam, pageObservations, pageById),
    "이렇게 마음 편히 먹어보는 게 얼마 만이더라.");
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [...pageObservations, seam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText,
    "이렇게 마음 편히 먹어보는 게 얼마 만이더라.");
  assert.equal(result.diagnostics.acceptedContinuationBridges.length, 1);
  const repeated = R.reconcile({
    pages: [upper, lower],
    observations: [...pageObservations, seam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]],
    previousCanonicals: result.canonicals
  });
  assert.deepEqual(repeated.canonicals, result.canonicals);
});

test("a strongly covered short Hangul OCR correction joins its seam group", () => {
  const upper = page("corrected-short-upper", 0);
  const lower = page("corrected-short-lower", 1);
  const upperFragments = [
    pageObservation(upper, "마음", { x: 60, y: 94, w: 12, h: 4 }, "", "speech_bubble"),
    pageObservation(upper, "펴히", { x: 71, y: 94, w: 14, h: 4 }, "", "speech_bubble")
  ];
  const lowerSentence = pageObservation(lower, "먹어보는 게 얼마 만이더라.",
    { x: 22, y: 0, w: 56, h: 14 }, "", "caption_panel");
  const seam = seamObservation(upper, lower, "이렇게 마음 편히 먹어보는 게",
    { x: 58, y: 89, w: 30, h: 10 }, { x: 22, y: 0, w: 56, h: 8 }, "", "effect_text");
  const runtime = createReconcilerRuntime();
  const farCorrection = pageObservation(upper, "펴히", { x: 20, y: 94, w: 14, h: 4 },
    "", "speech_bubble");
  const unrelatedShort = pageObservation(upper, "외부", { x: 71, y: 94, w: 14, h: 4 },
    "", "speech_bubble");

  assert.equal(runtime.fuzzyFragmentSimilarity(seam.originalText, "펴히"), 0);
  assert.equal(runtime.fuzzyFragmentSimilarity(seam.originalText, "펴히", 4), 0.8);
  assert.equal(runtime.textSimilarity(seam.originalText, "마음펴히"), 1 / 7);
  assert.equal(runtime.fuzzyFragmentSimilarity(seam.originalText, "마음펴히"), 0.9);
  assert.ok(runtime.seamFragmentSupport(seam, upperFragments[1], upper, "bottom"));
  assert.equal(runtime.seamFragmentSupport(seam, farCorrection, upper, "bottom"), null);
  assert.equal(runtime.seamFragmentSupport(seam, unrelatedShort, upper, "bottom"), null);
  const result = R.reconcile({
    pages: [upper, lower],
    observations: [...upperFragments, lowerSentence, seam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });
  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText,
    "이렇게 마음 편히 먹어보는 게 얼마 만이더라.");
  assert.deepEqual(result.canonicals[0].memberObservationIds,
    [...upperFragments, lowerSentence, seam].map(item => item.id).sort());
  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 1);
  assert.ok(result.diagnostics.acceptedFragmentGroups[0].scores.text >= 0.9);
  assert.equal(result.diagnostics.acceptedContinuationBridges.length, 1);
  assert.ok(Object.values(result.ledger).every(entry => entry.resolution === "consumed"));
});

test("a truncated overlap rebuilds three lines from page OCR when seam text crosses the wrong rows", () => {
  const upper = page("truncated-overlap-upper", 0);
  const lower = page("truncated-overlap-lower", 1);
  const upperLines = pageObservation(upper, "그렇다면 여기서 의문점이",
    { x: 27.18, y: 85.25, w: 46.04, h: 12.1 }, "", "caption_panel");
  const clippedThirdLine = pageObservation(upper, "새기",
    { x: 40.33, y: 97.5, w: 18.16, h: 2.5 }, "", "caption_panel");
  const completeThirdLine = pageObservation(lower, "생긴다.",
    { x: 39.47, y: 0, w: 20.27, h: 3.4 }, "", "caption_panel");
  const wrongRowSeam = seamObservation(upper, lower, "여기성원무적이",
    { x: 27.18, y: 91.2, w: 46.04, h: 6.9 },
    { x: 39.47, y: 0, w: 20.27, h: 3.4 }, "", "caption_panel");

  const result = reconcileFixture({ upper, lower },
    [upperLines, clippedThirdLine, completeThirdLine, wrongRowSeam]);

  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "그렇다면 여기서 의문점이 생긴다.");
  assert.deepEqual(result.canonicals[0].memberObservationIds,
    [upperLines, clippedThirdLine, completeThirdLine, wrongRowSeam]
      .map(item => item.id).sort());
  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 1);
  assert.equal(result.diagnostics.acceptedFragmentGroups[0].structuralFallback, true);
  assert.deepEqual(result.diagnostics.acceptedFragmentGroups[0].discardedObservationIds,
    [clippedThirdLine.id]);
  assert.ok(Object.values(result.ledger).every(entry => entry.resolution === "consumed"));
});

test("a filtered wrong-row seam remains a geometry witness without contributing text", () => {
  const upper = page("filtered-overlap-upper", 0);
  const lower = page("filtered-overlap-lower", 1);
  const upperLines = pageObservation(upper, "그렇다면 여기서 의문점이",
    { x: 27.18, y: 85.25, w: 46.04, h: 12.1 }, "", "caption_panel");
  const clippedThirdLine = pageObservation(upper, "새기",
    { x: 40.33, y: 97.5, w: 18.16, h: 2.5 }, "", "caption_panel");
  const completeThirdLine = pageObservation(lower, "생긴다.",
    { x: 39.47, y: 0, w: 20.27, h: 3.4 }, "", "caption_panel");
  const wrongRowSeam = seamObservation(upper, lower, "여기성원무적이",
    { x: 27.18, y: 91.2, w: 46.04, h: 6.9 },
    { x: 39.47, y: 0, w: 20.27, h: 3.4 }, "", "caption_panel");

  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperLines, clippedThirdLine, completeThirdLine],
    filteredObservations: [wrongRowSeam],
    adjacentPagePairs: [[upper.pageId, lower.pageId]]
  });

  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText, "그렇다면 여기서 의문점이 생긴다.");
  assert.deepEqual(result.canonicals[0].memberObservationIds,
    [upperLines, clippedThirdLine, completeThirdLine].map(item => item.id).sort());
  assert.deepEqual(result.canonicals[0].seamWitnessObservationIds, [wrongRowSeam.id]);
  assert.deepEqual(result.canonicals[0].seamDiscardedObservationIds,
    [clippedThirdLine.id]);
  assert.equal(result.ledger[wrongRowSeam.id].resolution, "filtered");
  assert.equal(result.ledger[wrongRowSeam.id].filterReason, "provider_filtered");
  assert.equal(result.diagnostics.acceptedFragmentGroups[0].structuralFallback, true);
});

test("a completed overlap state rebuilds edge rows when seam OCR has no usable box", () => {
  const upper = page("state-overlap-upper", 0);
  const lower = page("state-overlap-lower", 1);
  const upperLines = pageObservation(upper, "그렇다면 여기서 의문점이",
    { x: 27.18, y: 85.25, w: 46.04, h: 12.1 }, "", "caption_panel");
  const clippedThirdLine = pageObservation(upper, "새기",
    { x: 40.33, y: 97.5, w: 18.16, h: 2.5 }, "", "caption_panel");
  const completeThirdLine = pageObservation(lower, "생긴다.",
    { x: 39.47, y: 0, w: 20.27, h: 3.4 }, "", "caption_panel");
  const wrongSeamRow = seamCaptureFragment(
    upper, lower, "state-overlap-capture", upper,
    "여기성원무적이", { x: 27.18, y: 91.2, w: 46.04, h: 6.9 }
  );
  const pairKey = "state-overlap-pair";

  const result = R.reconcile({
    pages: [upper, lower],
    observations: [upperLines, clippedThirdLine, completeThirdLine, wrongSeamRow],
    adjacentPagePairs: [{
      pageIds: [upper.pageId, lower.pageId],
      seamEvidence: {
        pairKey,
        status: "completed",
        reasons: ["lower_ocr_edge", "pixel_overlap", "upper_ocr_edge"],
        observationIds: [wrongSeamRow.id],
        imageRevisionByPage: {
          [upper.pageId]: upper.imageRevision,
          [lower.pageId]: lower.imageRevision
        }
      }
    }]
  });

  assert.equal(result.canonicals.length, 1);
  assert.equal(result.canonicals[0].originalText,
    "그렇다면 여기서 의문점이 생긴다.");
  assert.deepEqual(result.canonicals[0].memberObservationIds,
    [upperLines, clippedThirdLine, completeThirdLine, wrongSeamRow]
      .map(item => item.id).sort());
  assert.deepEqual(result.canonicals[0].seamWitnessPairKeys, [pairKey]);
  assert.deepEqual(result.canonicals[0].seamDiscardedObservationIds,
    [clippedThirdLine.id]);
  assert.equal(result.diagnostics.acceptedFragmentGroups[0].structuralStateFallback,
    true);
  assert.equal(result.ledger[wrongSeamRow.id].resolution, "consumed");
});

test("edge rows stay separate when a completed seam has no overlap evidence", () => {
  const upper = page("state-no-overlap-upper", 0);
  const lower = page("state-no-overlap-lower", 1);
  const observations = [
    pageObservation(upper, "그렇다면 여기서 의문점이",
      { x: 27.18, y: 85.25, w: 46.04, h: 12.1 }, "", "caption_panel"),
    pageObservation(upper, "새기",
      { x: 40.33, y: 97.5, w: 18.16, h: 2.5 }, "", "caption_panel"),
    pageObservation(lower, "생긴다.",
      { x: 39.47, y: 0, w: 20.27, h: 3.4 }, "", "caption_panel")
  ];

  const result = R.reconcile({
    pages: [upper, lower],
    observations,
    adjacentPagePairs: [{
      pageIds: [upper.pageId, lower.pageId],
      seamEvidence: {
        pairKey: "state-no-overlap-pair",
        status: "completed",
        reasons: ["lower_ocr_edge", "upper_ocr_edge"],
        imageRevisionByPage: {
          [upper.pageId]: upper.imageRevision,
          [lower.pageId]: lower.imageRevision
        }
      }
    }]
  });

  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 0);
  assert.equal(new Set(observations.map(item =>
    result.ledger[item.id].canonicalId)).size, 3);
});

test("an unrelated seam cannot merge three aligned edge blocks without a duplicate boundary line", () => {
  const upper = page("no-overlap-repair-upper", 0);
  const lower = page("no-overlap-repair-lower", 1);
  const observations = [
    pageObservation(upper, "첫 번째 줄", { x: 30, y: 86, w: 40, h: 8 }),
    pageObservation(upper, "두 번째 줄", { x: 30, y: 94, w: 40, h: 6 }),
    pageObservation(lower, "별개의 문장", { x: 30, y: 0, w: 40, h: 7 })
  ];
  const unrelated = seamObservation(upper, lower, "잘못 읽은 접합부",
    { x: 30, y: 88, w: 40, h: 12 }, { x: 30, y: 0, w: 40, h: 7 });

  const result = reconcileFixture({ upper, lower }, [...observations, unrelated]);

  assert.equal(result.diagnostics.acceptedFragmentGroups.length, 0);
  assert.equal(new Set(observations.map(item => result.ledger[item.id].canonicalId)).size, 3);
  assert.equal(result.ledger[unrelated.id].resolution, "standalone");
});
