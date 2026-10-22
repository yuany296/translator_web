import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";
import { firstSolidColor, normalizeSolidColor, solidObservationColor } from "../extension/src/shared/solid-color.js";

/** 采样色判据：唯一实现，三处「第一份有效色」共用。 */
test("normalizeSolidColor/firstSolidColor：6 位、3 位缩写、大小写、非法值", () => {
  assert.equal(normalizeSolidColor("#FBFFFF"), "#fbffff");
  assert.equal(normalizeSolidColor("#F6F"), "#ff66ff");
  assert.equal(normalizeSolidColor(" #f4fcfe "), "#f4fcfe");
  assert.equal(normalizeSolidColor(""), "");
  assert.equal(normalizeSolidColor("rgb(1,2,3)"), "");
  assert.equal(normalizeSolidColor("None"), "");
  assert.equal(firstSolidColor(["", "not-a-color", "#F6F", "#ffffff"]), "#ff66ff");
  assert.equal(firstSolidColor([]), "");
});

test("solidObservationColor：只有自身声明实底的观测才提供颜色", () => {
  assert.equal(solidObservationColor({ visual: { bgType: "solid", bgColor: "#fbffff" } }), "#fbffff");
  assert.equal(solidObservationColor({ visual: { bg_type: "solid", bg_color: "#f3fbfd" } }), "#f3fbfd");
  assert.equal(solidObservationColor({ visual: { bgType: "none", bgColor: "#223344" } }), "", "复杂背景的兜底色不给实底盖板上色");
  assert.equal(solidObservationColor(null), "");
});

/** 现场几何（KakaoPage 760×1000 双页 + 96px 接缝带，缩放到 1000×200 便于断言）。 */
const SEGMENTS = [
  {
    pageId: "a", drawRect: { x: 0, y: 0, w: 1000, h: 100 },
    sourceCrop: { x: 0, y: 900, w: 1000, h: 100 },
    naturalWidth: 1000, naturalHeight: 1000
  },
  {
    pageId: "b", drawRect: { x: 0, y: 100, w: 1000, h: 100 },
    sourceCrop: { x: 0, y: 0, w: 1000, h: 100 },
    naturalWidth: 1000, naturalHeight: 1000
  }
];

function seamObservation(visual) {
  return {
    id: "seam", sourceType: "seam", originalText: "여기 마스코트, 정의의 화신처럼 구니까 조심해라.",
    visual: { box: { x: 27.22, y: 9.33, w: 44.91, h: 59.94 }, fillBox: { x: 27.22, y: 9.33, w: 44.91, h: 59.94 }, regionType: "speech_bubble", ...visual },
    pageSpans: [
      { pageId: "a", box: { x: 27.22, y: 92.19, w: 44.91, h: 7.81 }, overlapRatio: 0.678 },
      { pageId: "b", box: { x: 27.22, y: 0, w: 44.91, h: 3.7 }, overlapRatio: 0.322 }
    ]
  };
}

function pageObservation(id, visual) {
  return {
    id, sourceType: "page", originalText: "구니까 조심해라.",
    visual,
    pageSpans: [{ pageId: "b", box: { x: 27.22, y: 0, w: 44.91, h: 3.7 } }]
  };
}

function buildSurface(seam, pages) {
  const observations = new Map([[seam.id, seam], ...pages.map(page => [page.id, page])]);
  const canonical = {
    id: "whole", revision: 1,
    originalText: seam.originalText,
    memberObservationIds: [seam.id, ...pages.map(page => page.id)]
  };
  return P.buildSeamSurfaceBubble(canonical, { translated_text: "这里的吉祥物就像正义的化身，所以要小心。" },
    [seam], 1000, 200, observations, SEGMENTS);
}

test("接缝观测声明实底却没有颜色时，从同一 canonical 的实底页面观测借第一份有效色", () => {
  // 现场：接缝观测 `bg_type=solid` + `bg_color=""`，两条页面观测分别是
  // #fbffff / #f3fbfd —— 渲染侧「没有颜色就透明」，整块盖板透明、原文裸露。
  const bubble = buildSurface(
    seamObservation({ bgType: "solid", bgColor: "" }),
    [pageObservation("page-a", { bgType: "solid", bgColor: "#fbffff" }),
      pageObservation("page-b", { bgType: "solid", bgColor: "#f3fbfd" })]
  );
  assert.ok(bubble);
  assert.equal(bubble.bg_type, "solid", "实底判定不动（不改清理图要求）");
  assert.equal(bubble.bg_color, "#fbffff", "同组第一份有效色（与 translation-coalesce 同口径）");
  assert.equal(bubble.visual.bgColor, "#fbffff");
});

test("自己有色就用自己、大写与 3 位缩写归一；不翻找兄弟", () => {
  const bubble = buildSurface(
    seamObservation({ bgType: "solid", bgColor: "#F6F" }),
    [pageObservation("page-a", { bgType: "solid", bgColor: "#fbffff" })]
  );
  assert.equal(bubble.bg_color, "#ff66ff");
});

test("全组都拿不到颜色时保持空串（渲染侧透明，不兜底纯白）", () => {
  const bubble = buildSurface(
    seamObservation({ bgType: "solid", bgColor: "" }),
    [pageObservation("page-a", { bgType: "solid", bgColor: "" }),
      pageObservation("page-b", { bgType: "solid", bgColor: "not-a-color" })]
  );
  assert.equal(bubble.bg_color, "");
});

test("非实底兄弟观测的颜色不借（复杂背景兜底色不能给实底盖板上色）", () => {
  const bubble = buildSurface(
    seamObservation({ bgType: "solid", bgColor: "" }),
    [pageObservation("page-a", { bgType: "none", bgColor: "#223344" })]
  );
  assert.equal(bubble.bg_color, "");
});

test("非实底的接缝观测保持原有直通行为（仍保留服务端可能给的采样色）", () => {
  const bubble = buildSurface(
    seamObservation({ bgType: "none", bgColor: "#f6fbfe" }),
    [pageObservation("page-a", { bgType: "solid", bgColor: "#fbffff" })]
  );
  assert.equal(bubble.bg_type, "none");
  assert.equal(bubble.bg_color, "#f6fbfe");
});
