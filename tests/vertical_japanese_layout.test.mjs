import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { resolveBubbleScreenBox, sanitizeRenderRotationDeg } from "../extension/src/rendering/cover-geometry.js";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  atob,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
const background = context.__backgroundTest;

/* ---------------------------------------------------------------------------
 * 一、竖排译文盒子的屏幕尺寸
 *
 * 现场（CMOA「追放された転生重騎士」第一页）：日文竖排台词的 polygon 是
 * 30×104 的竖长框，但渲染出来的气泡是 104×30 的横长框 —— 104px 长的字列被
 * 塞进 30px 高的盒子，`writing-mode: vertical-rl` 只能排出 2~3 字一列的碎列，
 * 溢出到相邻分格。
 * ------------------------------------------------------------------------- */

test("竖排：沿文字轴量出来的宽高必须换回屏幕轴，且不再叠 ±90° 旋转", () => {
  // polygon 四点按文字行进方向排列 → width=字列长度(104)、height=字列厚度(30)。
  const box = resolveBubbleScreenBox({
    widthAxis: 103.8, heightAxis: 30.1, declaredRotation: -90, verticalWriting: true
  });
  assert.deepEqual([box.width, box.height], [30.1, 103.8], "竖排盒子必须是竖长的：高 = 字列长度");
  assert.equal(box.rotation, 0, "朝向由 writing-mode 承担，再叠一次 ±90° 会把文字转回横排");
  // 没有倾角声明（percent 路径）时同样要换轴，否则盒子又变回横长。
  const percentBox = resolveBubbleScreenBox({ widthAxis: 109, heightAxis: 33, verticalWriting: true });
  assert.deepEqual([percentBox.width, percentBox.height], [33, 109]);
  assert.equal(percentBox.rotation, 0);
});

test("横排（含斜排 SFX）行为逐字不变", () => {
  // 宽盒子 + 近 90° 倾角 = OCR 把高而窄的横排框误判成竖排 → 丢倾角（原有自洽检查）。
  assert.deepEqual(
    resolveBubbleScreenBox({ widthAxis: 211, heightAxis: 47, declaredRotation: -89.93 }),
    { width: 211, height: 47, rotation: 0 }
  );
  // 真正的斜排 SFX：尺寸不换轴，倾角照旧。
  assert.deepEqual(
    resolveBubbleScreenBox({ widthAxis: 300, heightAxis: 80, declaredRotation: 35 }),
    { width: 300, height: 80, rotation: 35 }
  );
  // 窄高盒子 + 近 90°：原有行为（保留倾角）不变。
  assert.equal(sanitizeRenderRotationDeg(-89.93, 60, 300), -89.93);
  assert.deepEqual(
    resolveBubbleScreenBox({ widthAxis: 60, heightAxis: 300, declaredRotation: -89.93 }),
    { width: 60, height: 300, rotation: -89.93 }
  );
});

/* ---------------------------------------------------------------------------
 * 二、日文竖排的合并读序
 *
 * 现场（同一页）：OCR 把每一列切成了几段，composeRotatedClusterWords 把整句
 * 拼成了反序 —— 「ボクも《加護の儀》を / 受けることに / なってるんだけど」
 * 被拼成「なてるんだけど 受けることに ボクも<加護の儀を」，
 * 「彼女はエドヴァン家の / 分家の子女 / 名前をマリスという」被拼成
 * 「名前をマリスという 分家の子女 彼女はエドヴァン家の」。
 * ------------------------------------------------------------------------- */

function box(left, top, width, height) {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    centerX: left + width / 2, centerY: top + height / 2
  };
}

/** 一列竖排文字的一段（box 高而窄，polygon 与 box 同形）。 */
function verticalFragment(left, top, width, height, text) {
  return {
    text,
    rotation: -90,
    box: box(left, top, width, height),
    item: {
      words: text,
      polygon: [
        { x: left, y: top }, { x: left, y: top + height },
        { x: left + width, y: top + height }, { x: left + width, y: top }
      ]
    }
  };
}

test("竖排：列序自右向左、列内自上而下", () => {
  // 图像 1127x536（CMOA 一条瓦片）；两列各被切成上下两段。
  const rightTop = verticalFragment(800, 100, 30, 120, "うえ");
  const rightBottom = verticalFragment(800, 220, 30, 120, "した");
  const leftColumn = verticalFragment(760, 150, 30, 200, "ひだり");
  const composed = background.composeRotatedClusterWords([leftColumn, rightBottom, rightTop], -90);
  assert.equal(composed, "うえ した\nひだり",
    "右列（x 大）必须排在左列前面，列内必须自上而下");
});

test("竖排：三列台词按自右向左还原成原句", () => {
  const columnAt = (left, text) => verticalFragment(left, 100, 30, 300, text);
  const composed = background.composeRotatedClusterWords([
    columnAt(884, "名前をマリスという"),
    columnAt(964, "彼女はエドヴァン家の"),
    columnAt(924, "分家の子女")
  ], -90);
  assert.equal(composed, "彼女はエドヴァン家の\n分家の子女\n名前をマリスという");
});

test("竖排：列距被压紧时相邻两列不得并成一行（真实一页的几何）", () => {
  // 现场（CMOA 同一页，原图 924x1314 上的像素坐标）：一个气泡的三列台词
  // 「早く / 加護の儀を / 始めろ」被 OCR 读成三条竖排框，列距 16/26 而字宽 22~29 ——
  // 列距只有字宽的 0.67 倍，沿用横排的 0.7 倍分「行」容差会把右边两列并成一行，
  // 拼出来是「始めろ 加護の儀を」。竖排必须收紧容差。
  const fast = verticalFragment(657, 708, 18, 41, "早く");
  const rite = verticalFragment(631, 705, 29, 104, "加護の儀を");
  const begin = verticalFragment(615, 708, 22, 53, "始めろ");
  assert.equal(background.estimateRotatedClusterLineCount([begin, rite, fast], -90), 3, "三列必须是三行");
  assert.equal(background.composeRotatedClusterWords([begin, rite, fast], -90), "早く\n加護の儀を\n始めろ");
});

test("横排倾斜文字仍按自左向右 / 自上而下", () => {
  // 与 background_runtime.part01 同一组真实多边形（斜排韩文两行）：行高必须按
  // polygon 的法向厚度算，否则两行会被并成一行。
  const upper = {
    text: "일부러 보라고",
    rotation: -13.36,
    box: box(448, 61, 170, 79),
    item: {
      words: "일부러 보라고",
      polygon: [{ x: 448, y: 99 }, { x: 608, y: 61 }, { x: 618, y: 102 }, { x: 458, y: 140 }]
    }
  };
  const lower = {
    text: "저런 거잖아!!",
    rotation: -12.6,
    box: box(457, 106, 172, 80),
    item: {
      words: "저런 거잖아!!",
      polygon: [{ x: 457, y: 142 }, { x: 618, y: 106 }, { x: 629, y: 150 }, { x: 467, y: 186 }]
    }
  };
  assert.equal(background.isVerticalReadingRotation(-12.6), false);
  assert.equal(background.isVerticalReadingRotation(-90), true);
  assert.equal(background.estimateRotatedClusterLineCount([lower, upper], -12.6), 2);
  assert.equal(background.composeRotatedClusterWords([lower, upper], -12.6), "일부러 보라고\n저런 거잖아!!");
});
