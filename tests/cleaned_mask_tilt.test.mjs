import assert from "node:assert/strict";
import test from "node:test";
import { installCleanMasks } from "../extension/src/canonical/modules/clean-masks.js";
import { polygonRotationDeg, polygonTiltDeg, resolveCoverQuad } from "../extension/src/rendering/cover-geometry.js";

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

test("rotation_deg 的亚度级噪声不得把遮罩当成斜排（跨页遮罩被裁成横带的根源）", () => {
  // 现场（Lezhin 跨页气泡）：rotation_deg = -0.6° 纯属识别噪声 —— 0.6° 在 122px 高的框上
  // 只挪动约 1px，却让 rotationTilted 成立 → 跨页遮罩走「按字形四边形裁剪」，而接缝复合图
  // 只读到气泡的一部分，上页那段遮罩于是被裁成一条横带（56.8% 以下），气泡第一行原文直接
  // 露在译文下面。亚度级角度一律按轴对齐处理。
  const box = { x: 20, y: 12, w: 50, h: 8 };
  const noise = resolveCoverQuad({ polygon: AXIS_POLYGON, rotationDeg: -0.6, box, padding: 0.2 });
  assert.equal(noise.tilted, false, "亚度级角度是噪声，不是斜排");
  assert.ok(Math.abs(noise.bounds.w - 50) < 2 && Math.abs(noise.bounds.h - 8) < 2,
    `噪声角度下遮罩仍应是原框，实际 ${noise.bounds.w.toFixed(2)}x${noise.bounds.h.toFixed(2)}`);
  assert.equal(resolveCoverQuad({ polygon: AXIS_POLYGON, rotationDeg: -12, box, padding: 0.2 }).tilted, true,
    "真正的斜排（12°）不受影响");
});

test("百分比空间的各向异性不得把亚度级像素微倾抬成斜排（跨页遮罩只遮住顶部 ~18% 的根源）", () => {
  // 现场（Lezhin 53 话跨页气泡，拼接图 1280×192）：服务端返回的文字框在像素空间只歪
  // 0.2°（visual.rotationDeg=-0.2，rawBox 299.6×69.1，顶点 (674.8,77)(955,76)(955.3,140)
  // (675,141)），而百分比空间把"横边的微倾"放大 6.7 倍 → 1.36° → 越过 0.5° 阈值 →
  // 整个气泡被当成斜排 SFX，页面遮罩按"接缝带里那一行"的四边形裁剪：下页 OCR 读到 4 行、
  // 高 258px 的遮罩被裁到只剩顶部 ~26px（用户症状「下面那页只有一部分背景」）。
  // 判定「歪没歪」必须带着坐标空间的真实长宽做（scaleX/scaleY），见 polygonTiltDeg 注释。
  const polygon = [
    { x: 52.72, y: 40.1 }, { x: 74.61, y: 39.58 },
    { x: 74.63, y: 72.92 }, { x: 52.73, y: 73.44 }
  ];
  assert.ok(polygonTiltDeg(polygon) > 0.5, "不带长宽（旧口径）时 1.36° 会被当成斜排");
  assert.ok(polygonTiltDeg(polygon, 1280, 192) < 0.3, "像素空间里它只是 0.2° 的噪声");
  const box = { x: 51.97, y: 38.25, w: 23.41, h: 36 };
  const aware = resolveCoverQuad({
    polygon, rotationDeg: 89.9656294105337, box, padding: 0.2, scaleX: 1280, scaleY: 192
  });
  assert.equal(aware.tilted, false, "亚度级像素微倾不得按斜排裁剪遮罩");
  // 真正的斜排（既有夹具）不受影响：带不带长宽都必须判成斜排。
  const tilted = resolveCoverQuad({
    polygon: TILTED_POLYGON, rotationDeg: -35, box, padding: 0.2, scaleX: 1280, scaleY: 192
  });
  assert.equal(tilted.tilted, true, "12° 级别的斜排仍要裁剪");
});
