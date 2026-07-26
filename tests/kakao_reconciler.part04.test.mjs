import assert from "node:assert/strict";
import test from "node:test";
import { reconciler as R } from "../extension/src/canonical/reconciler.js";

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

function pageObservation(pageValue, text, box, translationRole = "") {
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
      regionType: "dialogue",
      overlapRatio: 1
    }],
    originalText: text,
    confidence: 0.94,
    visual: {
      regionType: "dialogue",
      translationRole
    }
  });
}

function seamObservation(upper, lower, text, upperBox, lowerBox, translationRole = "") {
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
      regionType: "dialogue",
      overlapRatio: 0.4
    }, {
      pageId: lower.pageId,
      box: lowerBox,
      coordinateSpace: "percent",
      regionType: "dialogue",
      overlapRatio: 0.6
    }],
    originalText: text,
    confidence: 0.99,
    visual: {
      regionType: "dialogue",
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
