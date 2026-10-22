import assert from "node:assert/strict";
import test from "node:test";
import { installTranslationCoalesce } from "../extension/src/background/modules/translation-coalesce.js";

/** mergeOcrCandidateGroup 需要的最小 runtime。 */
function createRuntime() {
  const runtime = {
    CHAT_TRANSLATION_ROLE_RE: /^chat_/u,
    normalizeBgType(value) {
      const text = String(value || "").trim().toLowerCase();
      return text === "solid" || text === "transparent" || text === "none" ? text : "solid";
    },
    normalizeChatTranslationRole: () => "",
    inferOcrCandidateGroupFontWeight: () => 0,
    inferOcrCandidateGroupTranslationRole: () => "",
    inferOcrCandidateGroupAlignment: () => "center",
    getPercentBubbleGroupBox: () => ({ left: 10, top: 10, width: 40, height: 20 }),
    mergePercentFillBoxes: () => ({ x: 10, y: 10, w: 40, h: 20 }),
    medianRotation: () => 0,
    mergePercentPolygons: () => null,
    summarizeOcrConfidence: () => ({}),
    normalizeOcrTextAlignment: value => String(value || "center"),
    normalizeRotationDegrees: value => Number(value) || 0,
    inferTextAlignmentFromBoxes: () => "center",
    normalizeOcrFontWeight: value => Number(value) || 0,
    getChatRoleFontWeight: () => 0,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    getPercentBubbleBox: item => {
      const box = item && item.box || {};
      const left = Number((item && item.x) ?? box.left) || 0;
      const top = Number((item && item.y) ?? box.top) || 0;
      const width = Number((item && item.w) ?? box.width) || 0;
      const height = Number((item && item.h) ?? box.height) || 0;
      return { left, top, right: left + width, bottom: top + height, width, height, centerX: left + width / 2, centerY: top + height / 2 };
    }
  };
  installTranslationCoalesce(runtime);
  // 排序只是为了让合并有确定顺序：单测里原样返回，避免依赖投影读序的整套桩。
  runtime.sortOcrCandidatesByReadingOrder = items => [...items];
  return runtime;
}

function item(overrides = {}) {
  return {
    original_text: overrides.original_text || "本文",
    rawBox: { left: 100, top: 100, width: 200, height: 40 },
    x: 10, y: 10, w: 40, h: 10,
    bg_type: "solid",
    bg_color: "",
    fill_box: { x: 10, y: 10, w: 40, h: 10 },
    text_color: "#111111",
    stroke_color: "#ffffff",
    ...overrides
  };
}

test("区域组合并的背景色取整组第一份有效值（不能只看第一行）", () => {
  // 现场（KakaoPage 跨页气泡「여기 마스코트, 정의의 화신처럼 구니까 조심해라.」）：
  // 区域组里第一项没采到色、同行另一项采到 #f4fcfe，旧实现只取 sorted[0].bg_color
  // → 合并候选 `bg_type=solid` + `bg_color=""` → 跨页遮罩整块透明、原文裸露。
  const runtime = createRuntime();
  const merged = runtime.mergeOcrCandidateGroup([
    item({ original_text: "第一行", bg_color: "" }),
    item({ original_text: "第二行", bg_color: "#f4fcfe" })
  ], 0);
  assert.equal(merged.bg_type, "solid");
  assert.equal(merged.bg_color, "#f4fcfe", "整组里第一份有效的 #rrggbb 才是答案");
});

test("整组都没有有效背景色时仍然留空（渲染侧保持透明，不兜底纯白）", () => {
  const runtime = createRuntime();
  const merged = runtime.mergeOcrCandidateGroup([
    item({ original_text: "第一行", bg_color: "" }),
    item({ original_text: "第二行", bg_color: "not-a-color" })
  ], 0);
  assert.equal(merged.bg_color, "");
});

test("非实底的组同样保留采样到的背景色（清理图缺位时的兜底与文字配色都要用）", () => {
  const runtime = createRuntime();
  const merged = runtime.mergeOcrCandidateGroup([
    item({ original_text: "旁白", bg_type: "none", bg_color: "", fill_box: null }),
    item({ original_text: "旁白二", bg_type: "none", bg_color: "#223344", fill_box: null })
  ], 0);
  assert.equal(merged.bg_type, "none");
  assert.equal(merged.bg_color, "#223344");
});

test("背景色与文字色同用采样色判据：3 位缩写归一、非法值跳过", () => {
  const runtime = createRuntime();
  const merged = runtime.mergeOcrCandidateGroup([
    item({ original_text: "第一行", bg_color: "None" }),
    item({ original_text: "第二行", bg_color: "#F4F" })
  ], 0);
  assert.equal(merged.bg_color, "#ff44ff");
});
