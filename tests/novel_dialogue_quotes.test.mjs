import assert from "node:assert/strict";
import test from "node:test";
import { installTranslationUtils } from "../extension/src/background/modules/translation-utils.js";

const runtime = {};
installTranslationUtils(runtime);
const restore = runtime.restoreDialogueQuotes;
const dropped = runtime.hasDroppedDialogueQuotes;

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

test("restoreDialogueQuotes covers single quotes and every bracket style the sources use", () => {
  // 用户实测那条：韩文弯引号整段被包住，模型只回了没引号的句子
  assert.equal(
    restore("“난 무조건 탈색부터 한다.”", "我不管，肯定要先漂发。"),
    "“我不管，肯定要先漂发。”"
  );
  // 单引号（弯的 / 直的 / 全角 / 收尾号两边都用）
  assert.equal(restore("‘안녕’", "你好"), "‘你好’");
  assert.equal(restore("'안녕'", "你好"), "'你好'");
  assert.equal(restore("＇안녕＇", "你好"), "＇你好＇");
  assert.equal(restore("’안녕’", "你好"), "’你好’");
  // 其它括号风格
  assert.equal(restore("｢안녕｣", "你好"), "｢你好｣");
  assert.equal(restore("«안녕»", "你好"), "«你好»");
  assert.equal(restore("‹안녕›", "你好"), "‹你好›");
  assert.equal(restore("„안녕“", "你好"), "„你好“");
  // 英文缩写里的撇号不会被误判成对话引号（原文不是以 ' 开头）
  assert.equal(restore("Don't stop.", "别停。"), "别停。");
  // 幂等：修过一次之后再修不会变成双重引号
  const once = restore("“안녕”", "你好");
  assert.equal(restore("“안녕”", once), "“你好”");
});

test("hasDroppedDialogueQuotes 只报「原文有引号、译文一个都没有」", () => {
  assert.equal(dropped("“난 무조건 탈색부터 한다.”", "我不管，肯定要先漂发。"), true);
  assert.equal(dropped("“난 무조건 탈색부터 한다.”", "“我不管，肯定要先漂发。”"), false);
  assert.equal(dropped("난 무조건 탈색부터 한다.", "我不管，肯定要先漂发。"), false);
  // 译文换了一种引号风格仍然算"引号还在"，不算丢
  assert.equal(dropped("「안녕」", "“你好”"), false);
});

