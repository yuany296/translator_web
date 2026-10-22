import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// ルビ（振り仮名）过滤的现场夹具全部取自真实服务返回：
// `.local-data/debug/result_json`（CMOA《凶乱令嬢ニア・リストン》1080×1536 整页 OCR）里的
// 原始条目坐标 —— 见 operations-log 的取证记录。改判据时这些数字是唯一判准。
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
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__bg = MtBackgroundModule.backgroundRuntime;`, context, { filename: "background.iife.js" });
const rt = context.__bg;

const IMAGE = { width: 1080, height: 1536 };

function word(text, left, top, width, height, confidence = 0.9) {
  return {
    words: text,
    confidence,
    location: { left, top, width, height },
    rawBox: { left, top, width, height }
  };
}

/** 整页正文字号的中位数由这些「普通台词列」定：丢掉它们，中位数会被ルビ拉低而误判。 */
function normalColumns() {
  return [
    word("ところでそれは", 470, 320, 26, 141, 0.99),
    word("いけないから", 620, 700, 32, 158, 0.971),
    word("おきなさい", 120, 900, 32, 139, 0.965),
    word("どうかしら", 260, 400, 30, 126, 0.993),
    word("そうね……", 820, 1100, 31, 126, 0.99)
  ];
}

test("竖排ルビ：贴在含汉字粗列右侧的薄假名列整条丢掉，宿主保留", () => {
  const debug = { filterReasons: [] };
  const words = [
    ...normalColumns(),
    // 実座標：「あしたもと」是 明日(あした)+地元(じもと) 的ルビ，被聚类拼进正文后
    // 译成了「明日元,明天是本地。」
    word("あしたもと", 787, 608, 23, 107, 0.909),
    word("明日地元", 760, 605, 36, 134, 0.982)
  ];
  const kept = rt.filterRubyAnnotationWords(words, IMAGE, debug, "local_paddle");
  assert.equal(kept.length, words.length - 1);
  assert.ok(kept.some(item => item.words === "明日地元"));
  assert.ok(!kept.some(item => item.words === "あしたもと"));
  assert.equal(debug.filterReasons.length, 1);
  assert.equal(debug.filterReasons[0].dropReason, "ruby-annotation");
  assert.equal(debug.filterReasons[0].text, "あしたもと");
  assert.equal(debug.filterReasons[0].rubyHostText, "明日地元");
});

test("manga-ocr 引擎的ルビ阈值放宽到 0.9：paddle 时代靠低分挡住的 ruby 列也能过滤", () => {
  const words = [
    ...normalColumns(),
    // 粗细比 26/31 ≈ 0.84：paddle 阈值 0.8 放行，manga-ocr 阈值 0.9 丢弃——
    // manga-ocr 对 ruby 列也是高置信（paddle 时代靠低分过滤挡住），会活到过滤面前。
    word("ゆうかい", 640, 549, 26, 110, 0.96),
    word("誘拐だが", 600, 545, 40, 130, 0.98)
  ];
  const keptPaddle = rt.filterRubyAnnotationWords(words, IMAGE, { filterReasons: [] }, "local_paddle");
  assert.ok(keptPaddle.some(item => item.words === "ゆうかい"), "paddle 阈值 0.8：0.84 比值的列保留");
  const keptManga = rt.filterRubyAnnotationWords(words, IMAGE, { filterReasons: [] }, "manga_ocr");
  assert.ok(!keptManga.some(item => item.words === "ゆうかい"), "manga-ocr 阈值 0.9：同列被当ルビ丢掉");
  assert.ok(keptManga.some(item => item.words === "誘拐だが"), "含汉字宿主保留");
});

test("ルビ与宿主之间隔着第三列时拒绝配对（そういえば 被大字宿主吸走的真案例）", () => {
  // 実座標：1080×1536 页，そういえば(25px) 与 言っていたな...(46px 大字) 之间隔着
  // ruby 列 いぜん(13px)。间距 629-592=37 ≤ 25×1.6=40，旧逻辑把正文开头列当ルビ丢掉。
  const words = [
    ...normalColumns(),
    word("言っていたな...", 546, 1190, 46, 177, 0.97),
    word("いぜん", 617, 1211, 13, 43, 0.95),
    word("そういえば", 628, 1180, 25, 152, 1.0)
  ];
  const debugWith = { filterReasons: [] };
  const keptWith = rt.filterRubyAnnotationWords(words, IMAGE, debugWith, "manga_ocr");
  assert.ok(keptWith.some(item => item.words === "そういえば"), "中间隔着第三列：正文开头列不能当ルビ丢掉");
  // 对照：去掉中间列（いぜん），同样的宿主几何就恢复ルビ判定。
  const without = words.filter(item => item.words !== "いぜん");
  const debugWithout = { filterReasons: [] };
  const keptWithout = rt.filterRubyAnnotationWords(without, IMAGE, debugWithout, "manga_ocr");
  assert.ok(!keptWithout.some(item => item.words === "そういえば"), "无中间列时紧贴配对仍然成立");
  assert.equal(debugWithout.filterReasons[0].rubyHostText, "言っていたな...");
});

test("竖排ルビ：只注一个词的短ルビ（さかば←その時はこの酒場に）也认得出", () => {
  const debug = { filterReasons: [] };
  const words = [...normalColumns(), word("さかば", 413, 290, 11, 43, 0.578), word("その時はこの酒場に", 386, 142, 29, 218, 0.883)];
  const kept = rt.filterRubyAnnotationWords(words, IMAGE, debug, "local_paddle");
  assert.equal(kept.length, words.length - 1);
  assert.ok(kept.some(item => item.words === "その時はこの酒場に"));
  assert.equal(debug.filterReasons[0].rubyHostText, "その時はこの酒場に");
});

test("同页两条等粗的真台词不能被当成ルビ（それなら / 私王来時）", () => {
  const debug = { filterReasons: [] };
  const words = [...normalColumns(), word("それなら", 902, 346, 30, 102, 0.895), word("私王来時", 858, 339, 55, 252, 0.93)];
  const kept = rt.filterRubyAnnotationWords(words, IMAGE, debug, "local_paddle");
  assert.equal(kept.length, words.length);
  assert.equal(debug.filterReasons.length, 0);
});

test("宿主必须是含汉字的列：假名宿主不认（ルビ不会注在假名上）", () => {
  const debug = { filterReasons: [] };
  const words = [...normalColumns(), word("おれ", 500, 600, 26, 48, 0.891), word("それでいいのか", 470, 598, 40, 60, 0.9)];
  const kept = rt.filterRubyAnnotationWords(words, IMAGE, debug, "local_paddle");
  assert.equal(kept.length, words.length);
});

test("没有邻居、或没粗到该粗的邻居时不丢（拿不准就不动）", () => {
  const debug = { filterReasons: [] };
  const lone = [word("こんばんはいい天気ですね", 400, 300, 24, 200, 0.99), word("うん", 900, 1200, 38, 93, 0.986)];
  assert.equal(rt.filterRubyAnnotationWords(lone, IMAGE, debug, "local_paddle").length, 2);
  // 邻居太细（两条都是细列）→ 认不出宿主
  const thin = [...normalColumns(), word("び", 140, 910, 18, 53, 0.661), word("かけ", 120, 908, 17, 58, 0.43)];
  assert.equal(rt.filterRubyAnnotationWords(thin, IMAGE, debug, "local_paddle").length, thin.length);
});

test("横排ルビ在汉字行的上方；在下方不算", () => {
  const debug = { filterReasons: [] };
  const host = word("漢字の行です", 300, 500, 200, 32, 0.9);
  const above = word("かんじ", 340, 480, 70, 11, 0.62);
  const rows = normalColumns();
  assert.equal(rt.filterRubyAnnotationWords([...rows, host, above], IMAGE, debug, "local_paddle").length, rows.length + 1);
  assert.equal(debug.filterReasons.length, 1);
  assert.equal(debug.filterReasons[0].rubyHostText, "漢字の行です");
  const below = word("かんじ", 340, 534, 70, 11, 0.62);
  const debug2 = { filterReasons: [] };
  assert.equal(rt.filterRubyAnnotationWords([...rows, host, below], IMAGE, debug2, "local_paddle").length, rows.length + 2);
  assert.equal(debug2.filterReasons.length, 0);
});

test("过长的假名列不当注音（ルビ不会长到 12 字以上）", () => {
  const debug = { filterReasons: [] };
  const rows = normalColumns();
  const longKana = word("わからなかったらどうしようかとおもってた", 787, 400, 23, 300, 0.7);
  const kept = rt.filterRubyAnnotationWords([...rows, longKana, word("明日地元", 760, 400, 36, 300, 0.98)], IMAGE, debug, "local_paddle");
  assert.equal(kept.length, rows.length + 2);
});

test("只有假名、没有宿主汉字时整页不动（保守兜底）", () => {
  const debug = { filterReasons: [] };
  const words = [word("あ", 100, 100, 20, 40, 0.9), word("い", 100, 200, 20, 40, 0.9)];
  assert.equal(rt.filterRubyAnnotationWords(words, IMAGE, debug, "local_paddle").length, 2);
});
