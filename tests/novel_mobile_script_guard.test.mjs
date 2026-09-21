import assert from "node:assert/strict";
import test from "node:test";
import {
  describeScriptFix,
  findTraditionalChars
} from "../extension/src/novel-mobile/script-guard.js";

// 「简体中文被翻成繁体」是模型侧的漂移：提示词已经收紧，这里负责**认出来**，
// 交给 novel-batch 的定点修正再问一次。判定用「繁体专用字」——这些字在规范简体里不会出现。
test("认得常见的繁体专用字", () => {
  // 「候」不算（简繁同形：時候 → 时候），所以只有这四个
  assert.deepEqual(findTraditionalChars("這個時候他說。"), ["這", "個", "時", "說"]);
  assert.deepEqual(findTraditionalChars("我們後來發現了問題"), ["們", "後", "來", "發", "現", "問", "題"]);
  assert.deepEqual(findTraditionalChars("繁體字與簡體字"), ["體", "與"]);
});

test("规范简体文本一个都不命中（不能误判，误判等于白花一次请求）", () => {
  [
    "这个时候他说。", "我们后来发现了问题", "他喜欢你，可是你不知道。", "她走过去看了看。",
    // 这些字简繁同形/简体里也常用，刻意不收：路 爸 姊 弟 妹 赦 超 血 必 候
    "他骑自行车过马路。", "爸爸和姊妹都在，弟弟妹妹也来了。", "赦免了他，超市里人很多，抽血化验是必须的，时候不早了。"
  ].forEach(text => {
    assert.deepEqual(findTraditionalChars(text), [], `误判了：${text}`);
  });
});

test("指令举出实际出现的繁体字，并要求只改字形", () => {
  const fix = describeScriptFix("這個時候他說。");
  assert.match(fix, /必须全部改用简体中文/u);
  assert.match(fix, /「這」「個」「時」「說」/u);
  assert.match(fix, /只改字形，其它内容一字不动/u);
  assert.equal(describeScriptFix("这个时候他说。"), "", "没有繁体字就不该生成指令");
  assert.equal(describeScriptFix(""), "");
  assert.equal(describeScriptFix(null), "");
});

test("英日韩文本不受影响", () => {
  assert.deepEqual(findTraditionalChars("레오나르도가 말했다."), []);
  assert.deepEqual(findTraditionalChars("彼は行った。"), []);
  assert.deepEqual(findTraditionalChars("He went there."), []);
});
