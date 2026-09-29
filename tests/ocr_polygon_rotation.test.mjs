import assert from "node:assert/strict";
import test from "node:test";
import { installOcrItemFilter } from "../extension/src/background/modules/ocr-item-filter.js";
import {
  sanitizeRenderRotationDeg, polygonRotationDeg
} from "../extension/src/rendering/cover-geometry.js";

function makeBackgroundRuntime() {
  const runtime = {
    clamp: (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0)),
    normalizeRotationDegrees(value) {
      let angle = Number(value) || 0;
      while (angle >= 90) angle -= 180;
      while (angle < -90) angle += 180;
      return angle;
    }
  };
  installOcrItemFilter(runtime);
  return runtime;
}

// 高而窄的轴对齐框（首边是竖边）：只看首边会报出 ≈±90°，渲染侧就会把横排译文转 90°。
const TALL_AXIS_POLYGON = [{ x: 10, y: 10 }, { x: 10, y: 120 }, { x: 60, y: 120 }, { x: 60, y: 10 }];
const TALL_AXIS_POLYGON_ARRAYS = [[10, 10], [10, 120], [60, 120], [60, 10]];

test("高而窄的轴对齐多边形不再被推断成 ±90° 旋转", () => {
  const background = makeBackgroundRuntime();
  assert.equal(background.inferLocalPaddlePolygonRotation(TALL_AXIS_POLYGON), 0);
  assert.equal(background.inferLocalPaddlePolygonRotation(TALL_AXIS_POLYGON_ARRAYS), 0);
  // 顶点起点/绕向无关：同一个框换个起笔点仍然是 0。
  assert.equal(background.inferLocalPaddlePolygonRotation([[60, 10], [60, 120], [10, 120], [10, 10]]), 0);
  assert.equal(polygonRotationDeg(TALL_AXIS_POLYGON), 0);
});

test("真正倾斜的多边形仍然保留倾角", () => {
  const background = makeBackgroundRuntime();
  const tilted = [{ x: 10, y: 20 }, { x: 145, y: 30 }, { x: 145, y: 50 }, { x: 10, y: 40 }];
  const angle = background.inferLocalPaddlePolygonRotation(tilted);
  assert.ok(Math.abs(angle - 4.09) < 0.6, `expected ≈4.1°, got ${angle}`);
});

test("渲染倾角：宽盒子丢掉近 90° 旋转，窄高盒子保留", () => {
  // 宽 211 × 高 47 的接缝文字带：±90° 会把宽高互换，几何上不可能。
  assert.equal(sanitizeRenderRotationDeg(-89.92667552056055, 211, 47), 0);
  assert.equal(sanitizeRenderRotationDeg(89.9, 400, 60), 0);
  // 真正的竖排列：框高大于宽，旋转量照旧。
  assert.equal(sanitizeRenderRotationDeg(90, 48, 211), 90);
  assert.equal(sanitizeRenderRotationDeg(-89.93, 60, 300), -89.93);
  // 斜排 SFX（|倾角| < 60°）与退化盒子不受影响。
  assert.equal(sanitizeRenderRotationDeg(35, 300, 80), 35);
  assert.equal(sanitizeRenderRotationDeg(-89.93, 0, 0), -89.93);
});
