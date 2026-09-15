import assert from "node:assert/strict";
import test from "node:test";
import { installTranslationUtils } from "../extension/src/background/modules/translation-utils.js";

const runtime = {};
installTranslationUtils(runtime);
const restore = runtime.restoreDialogueQuotes;

test("restoreDialogueQuotes re-adds only the quotes the model dropped", () => {
  // 模型丢掉了整对引号 → 按原文引号对补回
  assert.equal(
    restore("“근데 토할 때 그만 토껴, 알겠지?”", "但是，要吐的话就痛快吐出来，知道了吗？"),
    "“但是，要吐的话就痛快吐出来，知道了吗？”"
  );
  assert.equal(restore("「안녕」", "你好"), "「你好」");
  assert.equal(restore("『안녕』", "你好"), "『你好』");
  // 译文已带引号(任意风格) → 原样保留,绝不双重包裹
  assert.equal(restore("“안녕”", "“你好”"), "“你好”");
  assert.equal(restore("“안녕”", "「你好」"), "「你好」");
  assert.equal(restore("“안녕”", "他问“你好”"), "他问“你好”");
  // 原文没有成对引号或译文为空 → 原样返回
  assert.equal(restore("안녕", "你好"), "你好");
  assert.equal(restore("“안녕”", ""), "");
  assert.equal(restore("", "你好"), "你好");
});
