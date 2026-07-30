import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

function readContentModules(pattern) {
  const modulesDir = path.join(projectRoot, "extension", "src", "content", "modules");
  const files = readdirSync(modulesDir).filter((name) => name.endsWith(".js")).sort();
  const sources = files.map((name) => readFileSync(path.join(modulesDir, name), "utf8"));
  const matching = sources.filter((src) => pattern.test(src));
  return matching.length > 0;
}

test("根目录覆盖层的原图模式会彻底隐藏译文及其描边", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const selector = ".mt-overlay-root.mt-show-source .mt-bubble";
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? "";

  assert.match(rule, /color:\s*transparent\s*!important/);
  assert.match(rule, /background:\s*transparent\s*!important/);
  assert.match(rule, /border-color:\s*transparent\s*!important/);
  assert.match(rule, /-webkit-text-stroke:\s*0\s+transparent\s*!important/);
  assert.match(rule, /text-shadow:\s*none\s*!important/);
  assert.match(rule, /opacity:\s*0\s*;/);
});

test("译文框流式出现和悬停时保持固定位置", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const bubbleRule = css.match(/\.mt-bubble\s*\{([^}]+)\}/)?.[1] ?? "";
  const streamRule = css.match(/\.mt-bubble\.mt-stream-enter\s*\{([^}]+)\}/)?.[1] ?? "";
  const enterFrames = css.match(/@keyframes\s+mt-bubble-in\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(bubbleRule, /transform:\s*var\(--mt-base-transform\)/);
  assert.doesNotMatch(bubbleRule, /transition:[^;]*transform/);
  assert.doesNotMatch(streamRule, /transform\s*:/);
  assert.doesNotMatch(enterFrames, /transform\s*:/);
  assert.doesNotMatch(css, /\.mt-bubble:hover\s*\{/);
});

test("OCR 调试框不会参与页面命中测试", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  assert.match(css, /\.mt-debug-box\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(css, /\.mt-debug-raw/);
  assert.match(css, /\.mt-debug-deduped/);
  assert.match(css, /\.mt-debug-block/);
});

test("OCR 原始框与合并框的标签使用独立垂直轨道", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  assert.match(css, /bottom:\s*calc\(100% \+ var\(--mt-debug-label-lane,\s*0px\)\)/);
  assert.match(css, /\.mt-debug-stage-block,[\s\S]*?--mt-debug-label-lane:\s*14px/);
});

test("悬浮球直接显示翻译成功和失败反馈", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  assert.match(css, /\.mt-floating-feedback\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(css, /\.mt-floating-feedback\.mt-error\s*\{/);
  assert.match(css, /\.mt-floating-feedback\.mt-success\s*\{/);
  assert.match(css, /\.mt-floating-feedback\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.mt-novel-progress-panel\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(css, /\.mt-novel-progress-spinner\s*\{[\s\S]*?animation:\s*mt-progress-spin/);
  assert.match(css, /\.mt-novel-progress-fill\s*\{[\s\S]*?transition:\s*width/);
});

test("Kakao 覆盖层使用页面坐标系跟随原图滚动", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const layerRule = css.match(/\.mt-overlay-layer\.mt-overlay-document-flow\s*\{([^}]+)\}/)?.[1] ?? "";
  const rootRule = css.match(/\.mt-overlay-layer\.mt-overlay-document-flow\s+\.mt-overlay-root\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(layerRule, /position:\s*absolute/);
  assert.match(rootRule, /position:\s*absolute/);
});

test("cross-page overlay uses one unclipped reading-area root and segmented covers", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const ruleFor = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, "m"))?.[1] ?? "";
  };
  const rootRule = ruleFor(".mt-overlay-root");
  const crossRootRule = ruleFor(".mt-cross-page-root");
  const overlayRule = ruleFor(".mt-cross-page-overlay");
  const coverRule = ruleFor(".mt-cross-page-overlay .mt-cover-segment");
  const textRule = ruleFor(".mt-cross-page-overlay .mt-cross-page-text");

  assert.match(rootRule, /overflow:\s*visible/);
  assert.match(crossRootRule, /position:\s*absolute/);
  assert.match(crossRootRule, /inset:\s*0/);
  assert.match(crossRootRule, /overflow:\s*visible/);
  assert.doesNotMatch(crossRootRule, /contain:\s*paint|overflow:\s*hidden/);
  assert.match(overlayRule, /overflow:\s*visible/);
  assert.match(coverRule, /position:\s*absolute/);
  assert.match(textRule, /white-space:\s*pre/);
  assert.doesNotMatch(css, /\.mt-seam-window|\.mt-seam-composite/);
});

test("cleanup cover keeps final blue geometry separate from raw text placement", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const lifecycle = readFileSync(path.resolve(projectRoot, "extension", "src", "content", "modules", "lifecycle-bubble.js"), "utf8");
  const overlay = readFileSync(path.resolve(projectRoot, "extension", "src", "content", "modules", "renderer-overlay.js"), "utf8");
  const crossPage = readFileSync(path.resolve(projectRoot, "extension", "src", "content", "modules", "renderer-crosspage.js"), "utf8");

  assert.match(lifecycle, /function createBubbleRenderNodes\(/);
  assert.match(lifecycle, /const coverBox = resolveBubbleCoverBox\(bubble\)/);
  assert.match(lifecycle, /x:\s*coverBox\.x[\s\S]*?y:\s*coverBox\.y[\s\S]*?w:\s*coverBox\.w[\s\S]*?h:\s*coverBox\.h/);
  assert.match(lifecycle, /projection_role:\s*"cover_only"[\s\S]*?fill_box:\s*null[\s\S]*?region_polygon:\s*null/);
  // polygon and rotation_deg are preserved from the original bubble for oriented fill (tilted text)
  assert.match(overlay, /createBubbleRenderNodes\([\s\S]*?appendChild\(coverNode\)[\s\S]*?appendChild\(textNode\)/);
  assert.match(crossPage, /overlay\.appendChild\(coverLayer\)[\s\S]*?overlay\.appendChild\(textNode\)/);
  assert.match(css, /\.mt-bubble\.mt-text-layer\s*\{[\s\S]*?background-image:\s*none\s*!important/);
  assert.match(css, /\.mt-bubble\.mt-text-layer::before\s*\{[\s\S]*?content:\s*none\s*!important/);
});

test("overlay bubbles keep source alignment and restore measured font fitting", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const bubbleRule = css.match(/\.mt-bubble\s*\{([^}]+)\}/)?.[1] ?? "";
  const leftRule = css.match(/\.mt-bubble\.mt-align-left\s*\{([^}]+)\}/)?.[1] ?? "";
  const rightRule = css.match(/\.mt-bubble\.mt-align-right\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(bubbleRule, /overflow:\s*visible/);
  assert.match(bubbleRule, /max-height:\s*none/);
  assert.match(bubbleRule, /font-weight:\s*var\(--mt-font-weight,\s*600\)/);
  assert.match(bubbleRule, /flex-direction:\s*column/);
  assert.match(leftRule, /text-align:\s*left/);
  assert.match(leftRule, /align-items:\s*flex-start/);
  assert.match(rightRule, /text-align:\s*right/);
  assert.match(css, /\.mt-measure-probe\s*\{[\s\S]*?justify-content:\s*flex-start\s*!important/);
  assert.ok(readContentModules(/function applyBubbleAnchorStyle\(/), "applyBubbleAnchorStyle not found in content modules");
  assert.ok(readContentModules(/shouldUseCenterRotationAnchor/), "shouldUseCenterRotationAnchor not found in content modules");
  assert.ok(readContentModules(/translate\(-50%, -50%\) rotate/), "translate(-50%, -50%) rotate not found in content modules");
  assert.ok(readContentModules(/--mt-font-weight/), "--mt-font-weight not found in content modules");
  assert.ok(readContentModules(/rotate\(\$\{angle\.toFixed\(2\)\}deg\)/), "rotate template not found in content modules");
  assert.ok(readContentModules(/function fitBubbleFontSize\(/), "measured font fitting must exist");
  assert.ok(readContentModules(/function expandBubbleForTextOverflow\(/), "overflow recovery must exist");
  assert.ok(readContentModules(/BUBBLE_FONT_ORIGINAL_SCALE/), "source font-height cap must exist");
  const domRenderer = readFileSync(path.resolve(projectRoot, "extension", "src", "rendering", "dom-renderer.js"), "utf8");
  assert.match(domRenderer, /overflow:\s*"hidden"/);
  const sceneBuilder = readFileSync(path.resolve(projectRoot, "extension", "src", "rendering", "scene-builder.js"), "utf8");
  assert.match(sceneBuilder, /layout\.status === "layout_unfit"/);
  assert.ok(!readContentModules(/text-overflow:\s*ellipsis/), "text-overflow:ellipsis should not appear in content modules");
});
