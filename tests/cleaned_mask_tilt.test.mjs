import assert from "node:assert/strict";
import test from "node:test";
import { installCleanMasks } from "../extension/src/canonical/modules/clean-masks.js";
import { polygonRotationDeg, resolveCoverQuad } from "../extension/src/rendering/cover-geometry.js";

// 用户缺陷「覆盖层没有根据倾斜的文本进行倾斜」的另一半：清理图（嵌入式小说正文图片的底图）
// 才是用户看到的覆盖层。遮罩若按轴对齐蓝框清理，斜排原文的位置会留下一块水平补丁。
const runtime = { clamp: (value, min, max) => Math.max(min, Math.min(max, value)) };
installCleanMasks(runtime);

const TILTED_POLYGON = [{ x: 30, y: 12.1 }, { x: 75.56, y: 36.32 }, { x: 70.79, y: 41.5 }, { x: 25.23, y: 17.28 }];
const AXIS_POLYGON = [{ x: 20, y: 12 }, { x: 70, y: 12 }, { x: 70, y: 20 }, { x: 20, y: 20 }];

function projection(visual, geometry) {
  return {
    canonicalId: "c1",
    canonicalRevision: 1,
    pageId: "p1",
    role: "primary",
    activeText: true,
    translatedText: "译文",
    geometry,
    box: geometry,
    visual,
    bubble: {
      canonical_id: "c1",
      x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h,
      polygon: visual.polygon || null,
      region_polygon: visual.regionPolygon || null
    }
  };
}

test("斜排投影的清理遮罩跟着倾角走，不再用轴对齐蓝框", () => {
  const box = { x: 25.23, y: 12.1, w: 50.33, h: 29.4 };
  const [mask] = runtime.buildCanonicalCleanMasks([
    projection({ polygon: TILTED_POLYGON, rotationDeg: -35, bgType: "none", regionType: "effect_text" }, box)
  ]);
  assert.ok(mask, "应产出清理遮罩");
  assert.equal(mask.coordinateSpace, "percent");
  assert.ok(Array.isArray(mask.polygon) && mask.polygon.length === 4, "斜排遮罩必须是四边形而不是 box");
  assert.equal(mask.box, undefined, "斜排遮罩不能再带轴对齐 box（下游会优先选 box）");

  // 四边形确实倾斜：上边两角 y 不同，且与渲染遮罩同源。
  assert.notEqual(mask.polygon[0].y, mask.polygon[1].y);
  const expected = resolveCoverQuad({ polygon: TILTED_POLYGON, rotationDeg: -35, box, padding: 0.2 });
  for (const [index, point] of expected.quad.entries()) {
    assert.ok(Math.abs(mask.polygon[index].x - point.x) < 0.02, `角点 ${index} x 应一致`);
    assert.ok(Math.abs(mask.polygon[index].y - point.y) < 0.02, `角点 ${index} y 应一致`);
  }
});

test("只有 rotation_deg（polygon 轴对齐或缺席）时，清理遮罩按倾角旋转外接框", () => {
  const box = { x: 20, y: 12, w: 50, h: 8 };
  for (const visual of [
    { polygon: AXIS_POLYGON, rotationDeg: -12, bgType: "none" },
    { rotationDeg: -12, bgType: "none" },
    { polygon: null, rotation_deg: -12, bgType: "none" }
  ]) {
    const [mask] = runtime.buildCanonicalCleanMasks([projection(visual, box)]);
    assert.ok(mask && Array.isArray(mask.polygon), `应产出倾斜四边形：${JSON.stringify(visual)}`);
    const tilt = polygonRotationDeg(mask.polygon);
    assert.ok(Math.abs(Math.abs(tilt) - 12) < 1, `四边形倾角应约 12°，实际 ${tilt}`);
  }
});

test("轴对齐文字仍走原来的蓝框遮罩（行为不变）", () => {
  const box = { x: 20, y: 12, w: 50, h: 8 };
  const [mask] = runtime.buildCanonicalCleanMasks([
    projection({ polygon: AXIS_POLYGON, rotationDeg: 0, bgType: "none", regionType: "speech_bubble" }, box)
  ]);
  assert.deepEqual(mask, { coordinateSpace: "percent", box: { x: 20, y: 12, w: 50, h: 8 } });
});

test("竖排投影（rotation_deg=±90）的清理遮罩必须竖长：±90° 是竖排方向，不是倾斜", () => {
  // 现场（CMOA 一页）：竖排台词每一列的 item box 都是高而窄的框，服务端
  // polygon_rotation_deg 一律给 ±90°，而文字四边形本身是轴对齐的竖列 —— 它就是
  // 那一列的准确范围。以前 ±90° 走「rotation_deg 与 polygon 冲突就旋转外接框」那条路，
  // 把 96x225 的竖列转成 225x96 的横条：清理图擦掉的是横跨页面的一条，真正的竖排原文
  // 只被擦掉一小截（用户看到「清理图只覆盖了一部分、日文还露着」）。
  const textAxisBox = { x: 40, y: 46.7, w: 24.55, h: 6.55 }; // projection.geometry（百分比，沿文字轴）
  // 同一气泡在**屏幕轴**上的文字四边形：8.89 宽 × 14.66 高（现场 dataset.polygon 的外接框）。
  const verticalPolygon = [
    { x: 47.85, y: 57.33 }, { x: 47.85, y: 42.67 }, { x: 56.74, y: 42.67 }, { x: 56.74, y: 57.33 }
  ];
  const [mask] = runtime.buildCanonicalCleanMasks([
    projection({ polygon: verticalPolygon, rotationDeg: -90, bgType: "none", regionType: "effect_text" }, textAxisBox)
  ]);
  assert.ok(mask, "应产出清理遮罩");
  const points = mask.polygon || [
    { x: mask.box.x, y: mask.box.y }, { x: mask.box.x + mask.box.w, y: mask.box.y },
    { x: mask.box.x + mask.box.w, y: mask.box.y + mask.box.h }, { x: mask.box.x, y: mask.box.y + mask.box.h }
  ];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(height > width * 1.5, `竖排遮罩必须高大于宽，实际 ${width.toFixed(0)}x${height.toFixed(0)}`);

  // 与渲染侧遮罩同源（清理范围必须和画上去的遮罩是同一个四边形）。
  const expected = resolveCoverQuad({ polygon: verticalPolygon, rotationDeg: -90, box: textAxisBox, padding: 0.2 });
  assert.ok(Math.abs(width - expected.bounds.w) < 0.5, "宽度应与渲染遮罩一致");
  assert.ok(Math.abs(height - expected.bounds.h) < 0.5, "高度应与渲染遮罩一致");
  assert.equal(expected.tilted, false, "竖排不是倾斜：不应再按 90° 旋转");
});

test("竖排但没有 polygon 时，仍按 ±90° 把文字轴蓝框转成屏幕竖框", () => {
  // 没有多边形时 box 就是文字轴几何，旋转 ±90° 恰好得到屏幕盒子 —— 这条路必须保留。
  const textAxisBox = { x: 40, y: 46.7, w: 24.55, h: 6.55 };
  const [mask] = runtime.buildCanonicalCleanMasks([
    projection({ rotationDeg: -90, bgType: "none" }, textAxisBox)
  ]);
  const expected = resolveCoverQuad({ rotationDeg: -90, box: textAxisBox, padding: 0.2 });
  assert.ok(mask.polygon, "没有 polygon 时按倾角旋转外接框，产出四边形");
  assert.ok(Math.abs(expected.bounds.h - textAxisBox.w) < 1 && Math.abs(expected.bounds.w - textAxisBox.h) < 1,
    `旋转后应是约 6.55x24.55 的竖框，实际 ${expected.bounds.w.toFixed(2)}x${expected.bounds.h.toFixed(2)}`);
});

test("实心背景与未激活的投影不需要清理图，不产出遮罩", () => {
  const box = { x: 20, y: 12, w: 50, h: 8 };
  const solid = projection({ polygon: TILTED_POLYGON, rotationDeg: -35, bgType: "solid" }, box);
  const inactive = projection({ polygon: TILTED_POLYGON, rotationDeg: -35, bgType: "none" }, box);
  inactive.activeText = false;
  assert.deepEqual(runtime.buildCanonicalCleanMasks([solid, inactive]), []);
});
