import assert from "node:assert/strict";
import test from "node:test";
import { installSeamHandling } from "../extension/src/background/modules/seam-handling.js";

/** buildSeamCrossPairCandidate 需要的最小 runtime：常量 + 文本归一化。 */
function createRuntime() {
  const runtime = {
    SEAM_CROSS_MIN_HORIZONTAL_OVERLAP: 0.45,
    SEAM_CROSS_MIN_HEIGHT_RATIO: 0.25,
    SEAM_CROSS_MAX_ROTATION_DELTA_DEG: 8,
    SEAM_CROSS_PAIR_MAX_GAP_PX: 24,
    normalizeTranslationSourceText: value => String(value || "").replace(/\s+/gu, " ").trim()
  };
  installSeamHandling(runtime);
  return runtime;
}

function makeSide(text, rawBox, overrides = {}) {
  return {
    candidate: {
      id: `c-${text}`,
      original_text: text,
      confidence: 0.9,
      rotation_deg: 0,
      region_type: "speech_bubble",
      region_id: "region-1",
      source_line_count: 1,
      ...overrides
    },
    rawBox
  };
}

const IMAGE = { width: 760, height: 192 };
const UPPER_BOX = { left: 200, top: 60, width: 240, height: 36 };
const LOWER_BOX = { left: 205, top: 98, width: 240, height: 36 };

test("接缝配对只要求两半都是实底：采样色差 1~2 级也要保留（现场 #f6fbfe / #f4fcfe）", () => {
  // 现场（KakaoPage「여기 마스코트, 정의의 화신처럼 구니까 조심해라.」）：
  // 同一个白气泡的上下两半各自采样，颜色是 #f6fbfe 与 #f4fcfe —— 以前要求
  // 逐字符相同，于是 bg_type=solid 却 bg_color=""，跨页遮罩整块透明、原文裸露。
  const runtime = createRuntime();
  const pair = runtime.buildSeamCrossPairCandidate(
    makeSide("여기 마스코트, 정의의 화신처럼", UPPER_BOX, { bg_type: "solid", bg_color: "#f6fbfe" }),
    makeSide("구니까 조심해라.", LOWER_BOX, { bg_type: "solid", bg_color: "#f4fcfe" }),
    IMAGE,
    200
  );
  assert.ok(pair && pair.candidate, "跨页配对应当成立");
  assert.equal(pair.candidate.bg_type, "solid");
  assert.equal(pair.candidate.bg_color, "#f6fbfe", "取上半的采样色（与页面级合并的「第一份有效颜色」同口径）");
  assert.ok(pair.candidate.fill_box, "实底才给填充盒");
});

test("上半没采到色时用下半的颜色；两半都没有才留空（渲染侧保持透明，不兜底纯白）", () => {
  const runtime = createRuntime();
  const lowerOnly = runtime.buildSeamCrossPairCandidate(
    makeSide("前", UPPER_BOX, { bg_type: "solid", bg_color: "" }),
    makeSide("后", LOWER_BOX, { bg_type: "solid", bg_color: "#ffffff" }),
    IMAGE,
    200
  );
  assert.equal(lowerOnly.candidate.bg_color, "#ffffff");

  const none = runtime.buildSeamCrossPairCandidate(
    makeSide("前", UPPER_BOX, { bg_type: "solid", bg_color: "" }),
    makeSide("后", LOWER_BOX, { bg_type: "solid", bg_color: "not-a-color" }),
    IMAGE,
    200
  );
  assert.equal(none.candidate.bg_type, "solid");
  assert.equal(none.candidate.bg_color, "", "只有合法采样色才算采到颜色");
});

test("3 位缩写采样色与 6 位同一把尺子（#F6F → #ff66ff）", () => {
  const runtime = createRuntime();
  const pair = runtime.buildSeamCrossPairCandidate(
    makeSide("前", UPPER_BOX, { bg_type: "solid", bg_color: "#F6F" }),
    makeSide("后", LOWER_BOX, { bg_type: "solid", bg_color: "" }),
    IMAGE,
    200
  );
  assert.equal(pair.candidate.bg_color, "#ff66ff");
});

test("两半不都是实底时不借用对方颜色（保持 bg_type=none 的清理图路径）", () => {
  const runtime = createRuntime();
  const pair = runtime.buildSeamCrossPairCandidate(
    makeSide("前", UPPER_BOX, { bg_type: "none", bg_color: "#ffffff" }),
    makeSide("后", LOWER_BOX, { bg_type: "solid", bg_color: "#ffffff" }),
    IMAGE,
    200
  );
  assert.equal(pair.candidate.bg_type, "none");
  assert.equal(pair.candidate.bg_color, "");
  assert.equal(pair.candidate.fill_box, null);
});
