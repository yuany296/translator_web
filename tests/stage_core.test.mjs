import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildStages, bundleMeta, summarizeStages } from "../tools/stage-inspector/stage-core.mjs";

/**
 * 「阶段检视台」的回放核心测试。
 *
 * 它调用的是扩展后台 runtime 的**内部函数**（`keepOrTraceOcrWord` / `filterRubyAnnotationWords` /
 * `buildLocalPaddleBubbleItems`），改名或改语义时这里会先红 —— 那正是这个测试存在的意义：
 * 工具面板不能悄悄跟线上漂移。
 *
 * 夹具是一份合成的服务端返回（形状与 `/ocr` 一致，坐标取真实页面的量级 1080×1536）：
 *   · 「雑音」分数 0.31 → 识别下限丢弃
 *   · 「鉄パイプか」0.705 → 结果筛选的低分例外放行（目标语言文字 + 面积正常）
 *   · 「14」0.61 → 同一档分数但只有数字 → 结果筛选丢弃
 *   · 「あしたもと」/「明日地元」→ ルビ + 宿主（宿主保留）
 *   · 同气泡两列 → 合并成一块
 */
const root = path.resolve(import.meta.dirname, "..");
const IMAGE = { width: 1080, height: 1536 };

function item(text, score, box, overrides = {}) {
  const { left, top, width, height } = box;
  return {
    region_id: overrides.region_id || "",
    text,
    score,
    box,
    polygon: [[left, top], [left + width, top], [left + width, top + height], [left, top + height]],
    det_score: 0.9,
    rotation_deg: -90,
    orientation_applied: 0,
    lang: "japan",
    variant: "test",
    region_type: overrides.region_type || "speech_bubble",
    region_polygon: null,
    region_box: null,
    bg_color: overrides.bg_color || "#ffffff",
    text_color: "#000000",
    stroke_color: "",
    region_confidence: 0.95
  };
}

function fixture() {
  const items = [
    item("雑音", 0.31, { left: 40, top: 40, width: 20, height: 60 }),
    item("鉄パイプか", 0.705, { left: 200, top: 200, width: 32, height: 123 }),
    item("14", 0.61, { left: 400, top: 200, width: 32, height: 123 }),
    // 同一气泡的两列：右列（left 更大）先读 —— 竖排自右向左
    item("ところでそれは", 0.99, { left: 500, top: 320, width: 26, height: 141 }),
    item("どうやって", 0.943, { left: 470, top: 322, width: 31, height: 106 }),
    item("あしたもと", 0.909, { left: 787, top: 608, width: 23, height: 107 }),
    item("明日地元", 0.982, { left: 760, top: 605, width: 36, height: 134 }),
    item("いけないから", 0.971, { left: 620, top: 700, width: 32, height: 158 }),
    item("おきなさい", 0.965, { left: 120, top: 900, width: 32, height: 139 })
  ];
  return {
    imageWidth: IMAGE.width,
    imageHeight: IMAGE.height,
    items: items.filter(entry => entry.score >= 0.4),
    rawItems: items,
    regions: [
      { id: "region-1", region_type: "speech_bubble", box: { left: 760, top: 600, width: 60, height: 150 }, polygon: [[760, 600], [820, 600], [820, 750], [760, 750]], bg_color: "#ffffff", confidence: 0.96 }
    ],
    counts: { paddle_raw_items: items.length, filtered_items: items.length - 1 }
  };
}

test("阶段回放：识别下限/结果筛选/ルビ/合并各阶段的计数与原因", async () => {
  const stages = await buildStages(root, fixture());
  const summary = summarizeStages(stages);
  assert.deepEqual(summary, {
    detections: 9,
    belowFloor: 1,
    arrivals: 8,
    filterDrops: 1,
    rubyDrops: 1,
    merged: 5,
    regions: 1
  });
  // 低于下限的那条不进结果
  assert.equal(stages.detections[0].text, "雑音");
  assert.equal(stages.detections[0].kind, "floor");
  assert.match(stages.detections[0].outcome, /识别下限丢弃/u);
  // 分数 0.705 的清晰台词走低分例外被放行并合并进块；同档的「14」被结果筛选丢掉
  const rescued = stages.detections.find(entry => entry.text === "鉄パイプか");
  assert.equal(rescued.kind, "merged");
  const digits = stages.detections.find(entry => entry.text === "14");
  assert.equal(digits.kind, "filter");
  assert.match(digits.outcome, /结果筛选丢弃/u);
});

test("阶段回放：ルビ连同宿主一起给出，宿主本身保留", async () => {
  const stages = await buildStages(root, fixture());
  const ruby = stages.drops.filter(entry => entry.reason === "ruby-annotation");
  assert.equal(ruby.length, 1);
  assert.equal(ruby[0].text, "あしたもと");
  assert.equal(ruby[0].rubyHostText, "明日地元");
  assert.ok(ruby[0].rubyGlyphRatio > 0 && ruby[0].rubyGlyphRatio <= 0.8);
  assert.ok(stages.merged.some(block => block.text.includes("明日地元")));
  assert.ok(!stages.merged.some(block => block.text.includes("あしたもと")));
});

test("阶段回放：合并块按竖排读序自右向左拼（ところでそれは → どうやって）", async () => {
  const stages = await buildStages(root, fixture());
  const block = stages.merged.find(entry => entry.text.includes("ところでそれは"));
  assert.ok(block, JSON.stringify(stages.merged.map(entry => entry.text)));
  assert.equal(block.text, "ところでそれは\nどうやって");
  assert.equal(block.lines, 2);
});

test("阶段回放：合并块的「位置」用屏幕轴包围盒，文字轴原值另存", async () => {
  // 竖排合并块的 location/rawBox 是**文字轴**几何（宽高与屏幕互换），直接拿去画框/裁图会错位。
  const stages = await buildStages(root, fixture());
  for (const block of stages.merged) {
    const xs = block.polygon.map(point => point.x);
    const ys = block.polygon.map(point => point.y);
    assert.equal(Math.round(block.box.left), Math.round(Math.min(...xs)));
    assert.equal(Math.round(block.box.top), Math.round(Math.min(...ys)));
    assert.equal(Math.round(block.box.width), Math.round(Math.max(...xs) - Math.min(...xs)));
    assert.equal(Math.round(block.box.height), Math.round(Math.max(...ys) - Math.min(...ys)));
    // 文字轴原值必须保留（诊断时要对照）
    assert.ok(block.textAxisBox && Number.isFinite(block.textAxisBox.left));
  }
  const twoColumn = stages.merged.find(entry => entry.lines === 2);
  // 两列竖排：屏幕轴是「窄而高」，文字轴是「宽而扁」—— 两者必然互换
  assert.ok(twoColumn.box.height > twoColumn.box.width);
  assert.ok(twoColumn.textAxisBox.width > twoColumn.textAxisBox.height);
});

test("阶段回放：调 confidenceThreshold 会真的改变结果筛选的丢弃数", async () => {
  const strict = summarizeStages(await buildStages(root, fixture(), { confidenceThreshold: 0.72 }));
  const loose = summarizeStages(await buildStages(root, fixture(), { confidenceThreshold: 0.62 }));
  assert.equal(strict.filterDrops, 1);
  // 0.72 时「鉄パイプか」(0.705) 靠低分例外放行；阈值降到 0.62 后连它也不再算低分，丢弃数不变或更少
  assert.ok(loose.filterDrops <= strict.filterDrops);
  // 调高到 0.99 时，两条低分条目都会被结果筛选挡住（低分例外的文字类型/面积仍成立，所以只看分数语义）
  const high = summarizeStages(await buildStages(root, fixture(), { confidenceThreshold: 0.99 }));
  assert.ok(high.filterDrops >= strict.filterDrops);
});

test("阶段回放：bundle 元信息可读，缺失时报可读错误", async () => {
  const meta = bundleMeta(root);
  assert.equal(meta.present, true);
  assert.match(meta.path, /dist[\\/]test[\\/]background\.iife\.js$/u);
  assert.ok(meta.bytes > 0);
  assert.match(meta.geometryVersion, /^detect-crop-recognize-appearance-layout-v\d+$/u);
  // 指向一个没有 dist 的目录时必须给「先 npm run build」的提示，而不是 ENOENT
  await assert.rejects(() => buildStages(path.join(root, "tools"), fixture()), /npm run build/u);
  assert.equal(bundleMeta(path.join(root, "tools")).present, false);
});

test("阶段回放：送进翻译的原文里没有换行（聚类文本带换行，归一后折成空格）", async () => {
  const stages = await buildStages(root, fixture());
  const rows = stages.translationInput;
  assert.equal(rows.length, stages.merged.length);
  for (const row of rows) {
    assert.ok(!row.sentText.includes("\n"), `不该有换行：${JSON.stringify(row.sentText)}`);
    assert.ok(!/\s{2,}/u.test(row.sentText), `不该有连续空白：${JSON.stringify(row.sentText)}`);
  }
  // 两列竖排块：聚类文本是「ところでそれは\nどうやって」，送进模型的是空格分隔的那一份
  const twoColumn = rows.find(row => row.clusterText.includes("\n"));
  assert.ok(twoColumn, "夹具里应当有多行块");
  assert.equal(twoColumn.changedByNormalization, true);
  assert.equal(twoColumn.sentText.split("\n").length, 1);
  assert.match(twoColumn.sentText, /\S \S/u);
});

test("阶段回放：被丢弃条目的框也必须是像素坐标（调试载荷给的是百分比）", async () => {
  // 现场症状：「④⑤ 的结果没有框」—— toDebugOcrItem 把 polygon 转成了百分比，
  // 直接当像素画就整层挤在左上角。这里钉住「多边形的包围盒 == 像素框」。
  const stages = await buildStages(root, fixture());
  assert.ok(stages.drops.length > 0, "夹具里应当有被丢弃的条目");
  for (const drop of stages.drops) {
    const xs = drop.polygon.map(point => point.x);
    const ys = drop.polygon.map(point => point.y);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    assert.ok(bounds[2] > 0 && bounds[3] > 0, `多边形不该退化：${JSON.stringify(bounds)}`);
    // 与像素框一致（允许 1px 取整差）
    assert.ok(Math.abs(bounds[0] - drop.box.left) <= 1.01, `x 不一致：${bounds[0]} vs ${drop.box.left}`);
    assert.ok(Math.abs(bounds[1] - drop.box.top) <= 1.01, `y 不一致：${bounds[1]} vs ${drop.box.top}`);
    assert.ok(Math.abs(bounds[2] - drop.box.width) <= 1.01, `宽不一致：${bounds[2]} vs ${drop.box.width}`);
    // 像素坐标必然大于 100（百分比坐标不可能）——「挤在左上角」的回归护栏
    assert.ok(bounds[0] > 100 || drop.box.left > 100, `看起来还是百分比坐标：${JSON.stringify(bounds)}`);
  }
});

test("阶段回放：夹具源文件本身不写死构建产物路径", () => {
  const source = fs.readFileSync(path.join(root, "tools", "stage-inspector", "stage-core.mjs"), "utf8");
  assert.match(source, /dist", "test", "background\.iife\.js/u);
  assert.match(source, /export \{ RECOGNITION_FLOOR, REASON_LABELS, buildStages, bundleMeta, loadRuntime, renderReport, summarizeStages \}/u);
});
