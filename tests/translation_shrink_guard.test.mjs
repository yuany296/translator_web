import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  shouldKeepPreviousTranslation, isImplausiblyShort,
  MIN_PREVIOUS_CHARS, SHRINK_RATIO,
  MIN_SOURCE_FOR_LENGTH_CHECK, SOURCE_LENGTH_RATIO, IMPLAUSIBLE_MAX_CHARS
} from "../extension/src/shared/translation-shrink.js";
import { createTranslationRowExtractor } from "../extension/src/shared/translation-row-stream.js";

// 事故复现：同一条原文，完整译文先有缓存，流式截尾值随后到达。
test("截尾的自动译文不覆盖同源已有的完整译文", () => {
  assert.equal(shouldKeepPreviousTranslation({
    source: "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.",
    candidate: "游乐设施",
    previous: "听说游乐设施指南里包含这个主题公园的相关内容。"
  }), true);

  assert.equal(shouldKeepPreviousTranslation({
    source: "좋아, 바로", candidate: "好,", previous: "好,马上"
  }), true);
});

test("更短但合理的译文、短句、以及没有旧值时都不拦", () => {
  // 长度接近：正常换一次译，允许替换
  assert.equal(shouldKeepPreviousTranslation({
    source: "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.",
    candidate: "游乐设施指南里包含这个主题公园的相关内容",
    previous: "听说游乐设施指南里包含这个主题公园的相关内容。"
  }), false);
  // 短句不判断
  assert.equal(shouldKeepPreviousTranslation({ source: "네", candidate: "是", previous: "是的" }), false);
  // 旧值太短不判断
  assert.equal(shouldKeepPreviousTranslation({
    source: "아주 긴 원문 문장입니다", candidate: "短", previous: "x".repeat(MIN_PREVIOUS_CHARS - 1)
  }), false);
  // 没有候选或旧值
  assert.equal(shouldKeepPreviousTranslation({ source: "아주 긴 원문", candidate: "", previous: "旧译文完整" }), false);
  assert.equal(shouldKeepPreviousTranslation({ source: "아주 긴 원문", candidate: "新", previous: "" }), false);
});

test("阈值与 Python 侧 shrink_guard 保持一致", () => {
  const pythonSource = readFileSync(
    new URL("../local-ocr-service/translation_store/shrink_guard.py", import.meta.url), "utf8"
  );
  assert.equal(SHRINK_RATIO, 0.6);
  assert.match(pythonSource, /MIN_SOURCE_CHARS = 4/u);
  assert.match(pythonSource, /MIN_PREVIOUS_CHARS = 4/u);
  assert.match(pythonSource, /SHRINK_RATIO = 0\.6/u);
  assert.equal(MIN_SOURCE_FOR_LENGTH_CHECK, 12);
  assert.equal(SOURCE_LENGTH_RATIO, 0.15);
  assert.equal(IMPLAUSIBLE_MAX_CHARS, 6);
  assert.match(pythonSource, /MIN_SOURCE_FOR_LENGTH_CHECK = 12/u);
  assert.match(pythonSource, /SOURCE_LENGTH_RATIO = 0\.15/u);
  assert.match(pythonSource, /IMPLAUSIBLE_MAX_CHARS = 6/u);
});

// 首次译文没有旧值可比：37 字符韩文原句回 4 个字，必须按「不成比例」判据拦住。
test("长原文只回几个字的首次译文判为可疑", () => {
  assert.equal(isImplausiblyShort({
    source: "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.", candidate: "游乐设施"
  }), true);
  assert.equal(isImplausiblyShort({
    source: "이 판타지 트레인은 다크라이드입니다.", candidate: "啊"
  }), true);
  // 完整译文、同量级的重译、短原文都不拦
  assert.equal(isImplausiblyShort({
    source: "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.",
    candidate: "听说游乐设施指南里包含这个主题公园的相关内容。"
  }), false);
  assert.equal(isImplausiblyShort({
    source: "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요.", candidate: "游乐设施指南"
  }), false);
  assert.equal(isImplausiblyShort({ source: "안녕하세요", candidate: "你好" }), false);
  assert.equal(isImplausiblyShort({ source: "좋아, 바로", candidate: "好," }), false);
  assert.equal(isImplausiblyShort({ source: "", candidate: "游乐设施" }), false);
  assert.equal(isImplausiblyShort({ source: "아주 긴 원문 문장입니다", candidate: "" }), false);
});

test("canonical 结算路径会拦截尾值", () => {
  const source = readFileSync(
    new URL("../extension/src/background/modules/translation-provider.js", import.meta.url), "utf8"
  );
  assert.match(source, /shouldKeepPreviousTranslation\(/u);
  assert.match(source, /const settledText = keepPrevious \? previous : restored;/u);
  // 首次译文（没有旧值）也要走「不成比例」判据，并且不写缓存
  assert.match(source, /isImplausiblyShort\(/u);
  assert.match(source, /if \(!keepPrevious && !suspectTruncation\)/u);
});

// 并发流式批次曾经共用一把带 g 的正则，互相踩 lastIndex 会导致重复/漏行。
test("两个并发提取器互不影响游标", () => {
  const first = createTranslationRowExtractor();
  const second = createTranslationRowExtractor();
  const rowA = '{"translations":[{"id":"canonical-request-0","translated_text":"甲"}';
  const rowB = '{"translations":[{"id":"canonical-request-0","translated_text":"乙"}';

  assert.deepEqual(first.push(`${rowA}]}`), [{ id: "canonical-request-0", translated_text: "甲" }]);
  // second 从头开始解析同一个形状的文本：共享正则会因为 first 的游标而漏掉这一行
  assert.deepEqual(second.push(`${rowB}]}`), [{ id: "canonical-request-0", translated_text: "乙" }]);
  // 交错继续累积也不会重复吐出旧行
  assert.deepEqual(first.push(`${rowA},{"id":"canonical-request-1","translated_text":"丙"}]}`), [
    { id: "canonical-request-1", translated_text: "丙" }
  ]);
  assert.deepEqual(second.push(`${rowB}]}`), []);
});
