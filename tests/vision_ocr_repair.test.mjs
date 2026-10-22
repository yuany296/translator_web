import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// Vision 修复链路的语言分流：这条链路曾经写死韩文（prompt "Read the Korean text" +
// 可用性校验要求 ≥2 个谚文），日漫的修复请求发了也全被丢掉。这里钉住日文分流的
// prompt/触发线/可用性校验，以及韩文默认路径不回归。
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

test("日文 prompt 说明竖排读序且不包含ルビ", () => {
  const prompt = rt.buildVisionCropOcrPrompt("japan");
  assert.match(prompt, /Japanese/);
  assert.match(prompt, /vertically/);
  assert.match(prompt, /right-to-left/);
  assert.match(prompt, /furigana/);
  assert.doesNotMatch(prompt, /Read the Korean/);
});

test("韩文 prompt 保持原文案不回归", () => {
  const prompt = rt.buildVisionCropOcrPrompt("korean");
  assert.match(prompt, /^Read the Korean text in this cropped manga image\./);
});

test("auto（默认本地 OCR 语言）用日韩双语文案", () => {
  const prompt = rt.buildVisionCropOcrPrompt("auto");
  assert.match(prompt, /Japanese or Korean/);
});

test("日文可用性校验：假名/汉字 ≥2 才放行，谚文不算", () => {
  assert.equal(rt.isUsableVisionCropOcrText("スキヤンダルで", "japan"), true);
  assert.equal(rt.isUsableVisionCropOcrText("問う題", "japan"), true);
  assert.equal(rt.isUsableVisionCropOcrText("スキ", "japan"), true);
  assert.equal(rt.isUsableVisionCropOcrText("あ", "japan"), false);
  assert.equal(rt.isUsableVisionCropOcrText("テスト", "korean"), false);
  assert.equal(rt.isUsableVisionCropOcrText("".padEnd(81, "あ"), "japan"), false);
});

test("auto 可用性校验同时接受日文与谚文", () => {
  assert.equal(rt.isUsableVisionCropOcrText("まあ言っちゃえば", "auto"), true);
  assert.equal(rt.isUsableVisionCropOcrText("말해서", "auto"), true);
  assert.equal(rt.isUsableVisionCropOcrText("ab1", "auto"), false);
});

test("日文触发线：低分全假名/汉字词进修复，拉丁碎片必进，韩文触发不受影响", () => {
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("問う題", 0.67, "japan"), true);
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("みさ", 0.712, "japan"), true);
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("スキンダルで", 0.997, "japan"), false);
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("J56", 0.699, "japan"), true);
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("말해서", 0.712, "korean"), true);
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("말해서복수", 0.712, "korean"), false);
});

test("不传 lang 的旧调用保持韩文行为", () => {
  // 旧行为：无谚文/拉丁的文本走 `hangul <= 3`（0 ≤ 3 恒真）→ 进修复。
  assert.equal(rt.shouldRepairLocalPaddleWordWithVision("みさ", 0.712), true);
  assert.equal(rt.isUsableVisionCropOcrText("まあ言っちゃえば"), false);
  assert.equal(rt.isUsableVisionCropOcrText("말해서"), true);
});
