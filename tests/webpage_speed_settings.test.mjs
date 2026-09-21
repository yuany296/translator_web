import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from "../extension/src/config/schema.js";
import {
  WEBPAGE_SPEED_DEFAULTS, WEBPAGE_SPEED_LIMITS, WEBPAGE_SPEED_PRESETS, WEBPAGE_SPEED_STATE_KEYS,
  clampWebpageSpeed, describeWebpageSpeed, isWebpageFastMode
} from "../extension/src/shared/webpage-speed.js";

// 网页翻译速度参数从「快捷弹窗的高级参数」搬到「设置页 → 阅读与显示」：
// 默认值与档位必须与搬走之前逐个相等，否则不动设置的老用户也会被改行为。
const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("默认值与搬走前弹窗的两档完全一致", () => {
  assert.deepEqual({ ...WEBPAGE_SPEED_DEFAULTS }, { concurrency: 5, batchItems: 32, batchChars: 3200 });
  // 旧 quick-popup/controller.js 的 FAST_MODE / NORMAL_MODE
  assert.deepEqual({ ...WEBPAGE_SPEED_PRESETS.fast }, { concurrency: 5, batchItems: 32, batchChars: 3200 });
  assert.deepEqual({ ...WEBPAGE_SPEED_PRESETS.normal }, { concurrency: 3, batchItems: 24, batchChars: 1600 });
  assert.equal(DEFAULT_RUNTIME_CONFIG.webpageConcurrency, 5);
  assert.equal(DEFAULT_RUNTIME_CONFIG.webpageBatchItems, 32);
  assert.equal(DEFAULT_RUNTIME_CONFIG.webpageBatchChars, 3200);
});

test("runtime.state 字段名与 schema 键名一致，不新开存储键", () => {
  assert.deepEqual({ ...WEBPAGE_SPEED_STATE_KEYS }, {
    concurrency: "webpageConcurrency", batchItems: "webpageBatchItems", batchChars: "webpageBatchChars"
  });
  for (const key of Object.values(WEBPAGE_SPEED_STATE_KEYS)) {
    assert.equal(Object.hasOwn(DEFAULT_RUNTIME_CONFIG, key), true, `${key} 必须仍是 runtime 配置键`);
  }
});

test("脏数据一律收敛：空值回默认、越界夹边界、绝不被当成 0", () => {
  for (const key of Object.keys(WEBPAGE_SPEED_DEFAULTS)) {
    const fallback = WEBPAGE_SPEED_DEFAULTS[key];
    for (const empty of [null, undefined, "", "   "]) {
      assert.equal(clampWebpageSpeed(key, empty), fallback, `${key} 的 ${JSON.stringify(empty)} 应该回默认值`);
    }
    assert.equal(clampWebpageSpeed(key, "abc"), fallback, `${key} 的非数字字符串回默认值`);
    assert.equal(clampWebpageSpeed(key, 0), WEBPAGE_SPEED_LIMITS[key].min, `${key} 的 0 夹到下限`);
    assert.equal(clampWebpageSpeed(key, 1e6), WEBPAGE_SPEED_LIMITS[key].max, `${key} 的超大值夹到上限`);
  }
  // 设置页 <input> 给到的是字符串，必须能用
  assert.equal(clampWebpageSpeed("batchChars", "900"), 900);
  assert.equal(clampWebpageSpeed("concurrency", "6"), 6);
  assert.equal(clampWebpageSpeed("batchItems", "24.4"), 24);
});

test("normalizeRuntimeConfig 接住新规则：空值回默认，越界夹紧", () => {
  const config = normalizeRuntimeConfig({});
  assert.equal(config.webpageConcurrency, 5);
  assert.equal(config.webpageBatchItems, 32);
  assert.equal(config.webpageBatchChars, 3200);
  // 旧配置（搬走之前保存的）读出来必须还是老行为
  const legacy = normalizeRuntimeConfig({ displayMode: "translated" });
  assert.equal(legacy.webpageConcurrency, 5);
  assert.equal(legacy.webpageBatchChars, 3200);
  assert.equal(normalizeRuntimeConfig({ webpageBatchChars: "" }).webpageBatchChars, 3200,
    "空输入框当「没填」，不再被 numberIn 夹成 400");
  assert.equal(normalizeRuntimeConfig({ webpageConcurrency: 99 }).webpageConcurrency, 8);
  assert.equal(normalizeRuntimeConfig({ webpageBatchItems: 0 }).webpageBatchItems, 4);
  assert.equal(normalizeRuntimeConfig({ webpageBatchChars: 99999 }).webpageBatchChars, 8000);
  assert.equal(normalizeRuntimeConfig({ webpageBatchItems: "40" }).webpageBatchItems, 40);
});

test("isWebpageFastMode 只在三值全等快速档时为真", () => {
  assert.equal(isWebpageFastMode(WEBPAGE_SPEED_PRESETS.fast), true);
  assert.equal(isWebpageFastMode({ concurrency: "5", batchItems: "32", batchChars: "3200" }), true,
    "设置页 <input> 给的是字符串，也要认");
  assert.equal(isWebpageFastMode({ ...WEBPAGE_SPEED_PRESETS.fast, batchChars: 3199 }), false);
  assert.equal(isWebpageFastMode(WEBPAGE_SPEED_PRESETS.normal), false);
  assert.equal(isWebpageFastMode({}), false, "缺字段不算快速档（不能因为回默认值就算命中）");
  assert.equal(isWebpageFastMode({ concurrency: "", batchItems: "", batchChars: "" }), false, "空输入框不算快速档");
  assert.equal(isWebpageFastMode({ webpageConcurrency: 5, webpageBatchItems: 32, webpageBatchChars: 3200 }), false,
    "认的是 concurrency/batchItems/batchChars 这三个短键，不是 runtime.state 的键名");
  assert.equal(isWebpageFastMode(), false);
});

test("describeWebpageSpeed 说清「一批多大」，脏值不产生 NaN", () => {
  const text = describeWebpageSpeed({ concurrency: 5, batchItems: 32, batchChars: 3200 });
  assert.match(text, /并发 5 批/u);
  assert.match(text, /每批最多 32 段/u);
  assert.match(text, /3200 字/u);
  assert.match(text, /先到者为准/u);
  assert.doesNotMatch(describeWebpageSpeed({}), /NaN|undefined/u);
  assert.match(describeWebpageSpeed({ concurrency: 99, batchItems: "abc" }), /并发 8 批 · 每批最多 32 段/u);
});

test("设置页「网页翻译速度」卡：三格带范围与逐条说明，另有快速模式与提示行", () => {
  const html = read("extension", "public", "settings.html");
  assert.match(html, /id="webpageConcurrency" type="number" min="1" max="8"/u);
  assert.match(html, /id="webpageBatchItems" type="number" min="4" max="96"/u);
  assert.match(html, /id="webpageBatchChars" type="number" min="400" max="8000"/u);
  assert.match(html, /id="webpageSpeedHint"/u);
  assert.match(html, /id="webpageFastMode" type="checkbox"/u);
  // 每个参数都要有一句作用说明（用户要求「解释每个参数的作用」）
  for (const hint of [
    /同时进行的网页翻译请求数/u,
    /一个请求最多合并多少段网页文字/u,
    /一批文字的字符上限/u,
    /一键用更快的一档/u
  ]) {
    assert.match(html, hint);
  }
  // 卡片落在「阅读与显示」面板里，且排在小说速度卡之后
  const reading = html.match(/data-panel="reading"[\s\S]*?<\/section>/u)[0];
  assert.match(reading, /id="webpageSpeedHint"/u);
  assert.ok(reading.indexOf("webpageSpeedHint") > reading.indexOf("novelSpeedHint"), "网页速度卡挨着小说速度卡");
});

test("设置页控制器：读进来要回填、保存要写回、输入时实时更新提示并同步快速模式", () => {
  const controller = read("extension", "src", "settings", "controller.js");
  for (const id of ["webpageConcurrency", "webpageBatchItems", "webpageBatchChars"]) {
    assert.match(controller, new RegExp(`${id}: numberValue\\("${id}"\\)`, "u"), `${id} 保存时要写回`);
    assert.match(controller, new RegExp(`\\["${id}", runtime\\.${id}\\]`, "u"), `${id} 打开设置页要回填`);
  }
  assert.match(controller, /syncWebpageFastMode\(\);/u, "打开设置页要按回填后的三格推勾选状态");
  assert.match(controller, /byId\("webpageFastMode"\)\.checked = isWebpageFastMode\(readWebpageSpeedInputs\(\)\)/u);
  assert.match(controller, /updateWebpageSpeedHint/u);
  assert.match(controller, /describeWebpageSpeed/u);
  assert.match(controller, /WEBPAGE_SPEED_PRESETS/u);
  assert.match(controller, /syncWebpageFastMode/u);
});

test("反向断言：快捷弹窗不再有任何网页速度控件（避免两处调同一个键）", () => {
  const popupHtml = read("extension", "public", "quick-popup.html");
  const popupSource = read("extension", "src", "quick-popup", "controller.js");
  assert.doesNotMatch(popupHtml, /webpageConcurrency|webpageBatchItems|webpageBatchChars|webpageFastMode|speedAdvanced/u);
  assert.doesNotMatch(popupHtml, /type="number"/u, "弹窗里不该再有数字输入框");
  assert.match(popupHtml, /id="debugHeading"/u);
  assert.match(popupHtml, /网页翻译速度在「完整设置 → 阅读与显示」里调整/u);
  assert.doesNotMatch(popupSource, /webpageConcurrency|webpageBatchItems|webpageBatchChars/u);
  assert.doesNotMatch(popupSource, /FAST_MODE|NORMAL_MODE/u);
  assert.doesNotMatch(popupSource, /webpageFastMode|speedHeading|speedAdvanced/u);
  // 弹窗仍旧只负责高频开关
  assert.match(popupSource, /enabled: byId\("runtimeEnabled"\)\.checked/u);
  assert.match(popupSource, /displayMode: displayMode\(\)/u);
});
