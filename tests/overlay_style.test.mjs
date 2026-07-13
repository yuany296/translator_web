import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("根目录覆盖层的原图模式会彻底隐藏译文及其描边", () => {
  const css = readFileSync(path.resolve(projectRoot, "styles.css"), "utf8");
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
  const css = readFileSync(path.resolve(projectRoot, "styles.css"), "utf8");
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
  const css = readFileSync(path.resolve(projectRoot, "styles.css"), "utf8");
  assert.match(css, /\.mt-debug-box\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(css, /\.mt-debug-raw/);
  assert.match(css, /\.mt-debug-deduped/);
  assert.match(css, /\.mt-debug-block/);
});

test("Kakao 覆盖层使用页面坐标系跟随原图滚动", () => {
  const css = readFileSync(path.resolve(projectRoot, "styles.css"), "utf8");
  const layerRule = css.match(/\.mt-overlay-layer\.mt-overlay-document-flow\s*\{([^}]+)\}/)?.[1] ?? "";
  const rootRule = css.match(/\.mt-overlay-layer\.mt-overlay-document-flow\s+\.mt-overlay-root\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(layerRule, /position:\s*absolute/);
  assert.match(rootRule, /position:\s*absolute/);
});
