import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  looksLikeContinuation, findSeamSplitPairs, geometryYBounds
} from "../extension/src/canonical/modules/split-detector.js";

function canonical(id, originalText, geometryByPage, status = "ready") {
  return { id, originalText, geometryByPage, status, memberObservationIds: [`obs-${id}`] };
}

// 真实事故：同一句 `다크라이드는 보통 테마파크의 테마를 설명합니다.` 被切片边界劈成两条。
const UPPER = "canonical_fb1d132cbfd52e5268e5998357136072";
const LOWER = "canonical_d8546d94dc0f06b525d5651ff6ae63d8";

test("真实事故：上片半句 + 下片半句被判为漏合并", () => {
  const canonicals = [
    canonical(UPPER, "다크라이드는 보통", { p1: [{ top: 900, height: 60 }] }),
    canonical(LOWER, "테마파크의 테마를 설명합니다.", { p2: [{ top: 10, height: 60 }] })
  ];

  const splits = findSeamSplitPairs({ canonicals, pairs: [{ upperPageId: "p1", lowerPageId: "p2" }] });

  assert.equal(splits.length, 1);
  assert.equal(splits[0].previous.id, UPPER);
  assert.equal(splits[0].next.id, LOWER);
});

test("已经结句的独立气泡不算漏合并", () => {
  const canonicals = [
    canonical("c1", "저거 빼곤.", { p1: [{ top: 900, height: 60 }] }),
    canonical("c2", "그런 것 같습니다.", { p2: [{ top: 10, height: 60 }] })
  ];

  assert.deepEqual(findSeamSplitPairs({ canonicals, pairs: [{ upperPageId: "p1", lowerPageId: "p2" }] }), []);
});

test("下片第一句以引号开头时不算续句", () => {
  const canonicals = [
    canonical("c1", "그가 말했다", { p1: [{ top: 900, height: 60 }] }),
    canonical("c2", "“괜찮아.”", { p2: [{ top: 10, height: 60 }] })
  ];

  assert.deepEqual(findSeamSplitPairs({ canonicals, pairs: [{ upperPageId: "p1", lowerPageId: "p2" }] }), []);
});

test("已经跨片合并的 canonical 不再报漏合并", () => {
  const canonicals = [
    canonical("merged", "다크라이드는 보통 테마파크의 테마를 설명합니다.", {
      p1: [{ top: 900, height: 60 }],
      p2: [{ top: 10, height: 60 }]
    })
  ];

  assert.deepEqual(findSeamSplitPairs({ canonicals, pairs: [{ upperPageId: "p1", lowerPageId: "p2" }] }), []);
});

test("取上片最靠下的一条与下片最靠上的一条比较", () => {
  const canonicals = [
    canonical("upper-high", "위쪽 문장", { p1: [{ top: 100, height: 40 }] }),
    canonical("upper-low", "아래쪽 미완", { p1: [{ top: 900, height: 40 }] }),
    canonical("lower-low", "아래 문장입니다.", { p2: [{ top: 400, height: 40 }] }),
    canonical("lower-high", "이어지는 말", { p2: [{ top: 20, height: 40 }] })
  ];

  const splits = findSeamSplitPairs({ canonicals, pairs: [{ upperPageId: "p1", lowerPageId: "p2" }] });

  assert.equal(splits.length, 1);
  assert.equal(splits[0].previous.id, "upper-low");
  assert.equal(splits[0].next.id, "lower-high");
});

test("多边形几何也能算出纵向范围；未知形状返回 null", () => {
  assert.deepEqual(geometryYBounds(
    canonical("c", "문장", { p1: [{ polygon: [{ x: 0, y: 30 }, { x: 10, y: 50 }] }] }), "p1"
  ), { top: 30, bottom: 50 });
  assert.equal(geometryYBounds(canonical("c", "문장", { p1: [{ note: "no geometry" }] }), "p1"), null);
});

test("结句判据本身：短碎片与结句标点都不算续句", () => {
  assert.equal(looksLikeContinuation("다크라이드는 보통", "테마파크의 테마를 설명합니다."), true);
  assert.equal(looksLikeContinuation("", "다음 문장"), false);
  assert.equal(looksLikeContinuation("짧음", "다음 문장"), false);
  assert.equal(looksLikeContinuation("문장이 끝났습니다!", "다음 문장"), false);
  assert.equal(looksLikeContinuation("문장이 끝났습니다…", "다음 문장"), false);
  assert.equal(looksLikeContinuation("이어지는 말", "(괄호로 시작)"), false);
});

test("接缝管线把漏合并上报接了起来", () => {
  const seamSource = readFileSync(
    new URL("../extension/src/canonical/canonical-pipeline-factory/canonical-seam-ocr.js", import.meta.url), "utf8"
  );
  const bridgeSource = readFileSync(
    new URL("../extension/src/canonical/modules/canonical-bridge.js", import.meta.url), "utf8"
  );
  assert.match(seamSource, /scope\.reportSeamSplits\?\.\(\{/u);
  assert.match(bridgeSource, /installCanonicalSplitReport/u);
});
