import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

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

test("Kakao 覆盖层使用页面坐标系跟随原图滚动", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const layerRule = css.match(/\.mt-overlay-layer\.mt-overlay-document-flow\s*\{([^}]+)\}/)?.[1] ?? "";
  const rootRule = css.match(/\.mt-overlay-layer\.mt-overlay-document-flow\s+\.mt-overlay-root\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(layerRule, /position:\s*absolute/);
  assert.match(rootRule, /position:\s*absolute/);
});

test("seam composite is clipped only by its two page-local windows", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const ruleFor = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, "m"))?.[1] ?? "";
  };
  const rootRule = ruleFor(".mt-overlay-root");
  const windowRule = ruleFor(".mt-seam-window");
  const compositeRule = ruleFor(".mt-seam-composite");
  const noneRule = ruleFor(".mt-seam-composite .mt-seam-bubble.mt-bg-none");
  const sourceRule = ruleFor(".mt-seam-composite.mt-show-source");
  const sourceBubbleRule = ruleFor(".mt-seam-composite.mt-show-source .mt-bubble");

  assert.match(rootRule, /overflow:\s*visible/);
  assert.match(windowRule, /position:\s*absolute/);
  assert.match(windowRule, /inset:\s*0/);
  assert.match(windowRule, /overflow:\s*hidden/);
  assert.match(compositeRule, /position:\s*absolute/);
  assert.match(compositeRule, /transform-origin:\s*0\s+0/);
  assert.match(compositeRule, /background-size:\s*100%\s+100%/);
  assert.match(noneRule, /background-image:\s*none/);
  assert.match(sourceRule, /background-image:\s*none\s*!important/);
  assert.match(sourceBubbleRule, /opacity:\s*0/);
});

test("overlay bubbles support source alignment without clipping long translations", () => {
  const css = readFileSync(path.resolve(projectRoot, "extension", "public", "styles.css"), "utf8");
  const content = readFileSync(path.resolve(projectRoot, "content.js"), "utf8");
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
  assert.match(content, /function applyBubbleAnchorStyle\(/);
  assert.match(content, /shouldUseCenterRotationAnchor/);
  assert.match(content, /translate\(-50%, -50%\) rotate/);
  assert.match(content, /--mt-font-weight/);
  assert.match(content, /rotate\(\$\{angle\.toFixed\(2\)\}deg\)/);
  assert.match(content, /function expandBubbleForTextOverflow\(/);
  assert.match(content, /--mt-fill-width", "100%"/);
  assert.doesNotMatch(content, /text-overflow:\s*ellipsis/);
});
