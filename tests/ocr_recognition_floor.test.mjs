import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * 识别分数门槛这条线的行为冻结。
 *
 * 真机背景（CMOA《凶乱令嬢ニア・リストン》整页 OCR）：竖排漫画台词带ルビ时，整行的
 * **平均**识别分会被ルビ拖低 —— 同一页不带ルビ的行是 0.92~0.99，而「鉄パイプか」0.705、
 * 「帰ないと」0.711，两条正文都清清楚楚。默认结果阈值 0.72 本来就有「文本完整就放行」
 * 的例外，但这个阈值以前**同时**被当成识别阶段的硬切发给本地服务
 * （`text_rec_score_thresh`），服务端 `crop_recognition` 先把它们删了，例外根本没机会
 * 生效 —— 症状就是用户说的「明明看起来挺清晰，却没被翻译」。
 */
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
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, { filename: "background.iife.js" });
const background = context.__backgroundTest;

const IMAGE = { width: 1080, height: 1536 };

function word(text, confidence, width = 32, height = 137) {
  const location = { left: 100, top: 100, width, height };
  return { words: text, confidence, location, rawBox: { ...location } };
}

const tuning = { ...background.getDefaultOcrTuning(), confidenceThreshold: 0.72 };

test("本地 OCR 的识别阈值传的是硬下限，不是用户的结果筛选阈值", () => {
  assert.equal(background.getLocalOcrParams({ ocrConfidenceThreshold: 0.72 }).text_rec_score_thresh, 0.4);
  // 用户显式设得比硬下限还低时按用户的来（他要的就是更多原始结果）
  assert.equal(background.getLocalOcrParams({ ocrConfidenceThreshold: 0.2 }).text_rec_score_thresh, 0.2);
  // 用户设 0（不筛）时保持不筛：硬下限只负责「不把用户阈值当成识别阶段的硬切」
  assert.equal(background.getLocalOcrParams({ ocrConfidenceThreshold: 0 }).text_rec_score_thresh, 0);
});

test("低分例外只放行目标语言文字：数字/拉丁碎片仍丢，短台词不按字数误删", () => {
  assert.equal(background.getOcrWordDropReason(word("鉄パイプか", 0.705), IMAGE, tuning), "");
  assert.equal(background.getOcrWordDropReason(word("帰ないと", 0.711), IMAGE, tuning), "");
  assert.equal(background.getOcrWordDropReason(word("14", 0.653), IMAGE, tuning), "low-confidence");
  assert.equal(background.getOcrWordDropReason(word("2el", 0.448), IMAGE, tuning), "low-confidence");
  // 韩文单音节台词本来就是一整行（background_runtime.part07 钉过），不能按字数丢。
  // 盒子取 43×50 只是为了让面积门槛（相对这张 1080×1536 的整页图）先通过，测的是文字类型那一条。
  assert.equal(background.getOcrWordDropReason(word("그", 0.672, 43, 50), IMAGE, tuning), "");
  // 低于识别硬下限的一律丢（连识别本身都不可信）
  assert.equal(background.getOcrWordDropReason(word("鉄パイプか", 0.31), IMAGE, tuning), "low-confidence");
  // 面积相对整图太小的也不算「行是完整的」
  assert.equal(background.getOcrWordDropReason(word("鉄パイプか", 0.705, 12, 20), IMAGE, tuning), "low-confidence");
});

test("分数达标时不受低分例外影响（短台词、拉丁词照旧保留）", () => {
  assert.equal(background.getOcrWordDropReason(word("お", 0.887), IMAGE, tuning), "");
  assert.equal(background.getOcrWordDropReason(word("OK", 0.9, 40, 30), IMAGE, tuning), "");
});
