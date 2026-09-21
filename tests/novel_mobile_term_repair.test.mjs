import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import novelCore from "../extension/src/shared/novel.js";
import {
  TERM_REPAIR_TAILS,
  repairTermLeftovers
} from "../extension/src/novel-mobile/term-repair-local.js";
import { installGlossaryJudgementLocal } from "../extension/src/novel-mobile/glossary-judgement.js";

// 「术语照抄了原文」是字符串事实，不需要再打一次模型：就地换成术语库里的译名。
// 这组测试盯两件事：该换的换掉（含助词尾巴、拉丁词边界），不该换的一个字都不动。
const LANGUAGES = { sourceLanguage: "ko", targetLanguage: "zh-CN" };

function glossaryOf(...pairs) {
  return glossaryCore.normalizeGlossary({ entries: pairs.map(([source, target, note]) => ({ source, target, note })) });
}

function repaired(original, translated, glossary) {
  const items = [{ id: "p1", original_text: original }];
  const rows = [{ id: "p1", translated_text: translated }];
  const entries = glossaryCore.getRelevantEntries(glossary, items, { scopeKey: "" });
  return repairTermLeftovers(items, rows, entries)[0].translated_text;
}

test("人名照抄 + 助词尾巴：一起换成译名（中文没有助词）", () => {
  assert.equal(repaired("레오나르도가 말했다.", "레오나르도가 说道。", glossaryOf(["레오나르도", "莱昂纳多"])), "莱昂纳多说道。");
  assert.equal(repaired("레오나르도는 웃었다.", "레오나르도는笑了。", glossaryOf(["레오나르도", "莱昂纳多"])), "莱昂纳多笑了。");
  assert.equal(repaired("봄이 왔다.", "봄이来了。", glossaryOf(["봄", "春"])), "春来了。");
  assert.equal(repaired("봄이 왔다.", "봄来了。", glossaryOf(["봄", "春"])), "春来了。");
});

test("尾巴不是助词说明只是更长单词的前半截：一个字都不动", () => {
  // 줄다리기（拔河）不是「줄」+助词，替换会把它拆坏
  assert.equal(repaired("줄다리기를 했다.", "줄다리기를 玩了。", glossaryOf(["줄", "朱尔"])), "줄다리기를 玩了。");
  // 前面紧挨着韩文字母 = 更长单词的后半截
  assert.equal(repaired("가봄이 왔다.", "가봄이来了。", glossaryOf(["봄", "春"])), "가봄이来了。");
});

test("拉丁术语按词边界替换，大小写不敏感", () => {
  assert.equal(repaired("Leonardo smiled.", "他叫leonardo。", glossaryOf(["Leonardo", "莱昂纳多"])), "他叫莱昂纳多。");
  assert.equal(repaired("Leonardo smiled.", "Leonardos 都在。", glossaryOf(["Leonardo", "莱昂纳多"])), "Leonardos 都在。");
  // 替换后紧跟的空格在中文前吃掉，在两个拉丁词之间留着
  assert.equal(repaired("Leonardo smiled.", "Leonardo 笑了。", glossaryOf(["Leonardo", "莱昂纳多"])), "莱昂纳多笑了。");
  assert.equal(repaired("Leonardo smiled.", "Leonardo Smith 来了。", glossaryOf(["Leonardo", "莱昂纳多"])), "莱昂纳多 Smith 来了。");
  // 汉字原文与译名同形，无从判断，不动
  assert.equal(repaired("東京へ行く。", "東京へ行く。", glossaryOf(["東京", "东京"])), "東京へ行く。");
});

test("译名里本来就含原文拼写（Leo → Leonardo）时整条跳过", () => {
  assert.equal(repaired("Leo smiled.", "他叫Leo。", glossaryOf(["Leo", "Leonardo"])), "他叫Leo。");
  const same = glossaryOf(["Leonardo", "Leonardo"]);
  assert.equal(repaired("Leonardo smiled.", "他叫Leonardo。", same), "他叫Leonardo。");
});

test("原文没出现该词就不替换（术语库很大也不会误伤）", () => {
  assert.equal(repaired("전혀 다른 문장입니다.", "봄이来了。", glossaryOf(["봄", "春"])), "봄이来了。");
});

test("长词优先：短词不会先吃掉长词的一部分", () => {
  const glossary = glossaryOf(["레오", "莱奥"], ["레오나르도", "莱昂纳多"]);
  assert.equal(repaired("레오나르도가 말했다.", "레오나르도가 说道。", glossary), "莱昂纳多说道。");
});

test("没有改动的行原样透传（下游不该被误判为变更）", () => {
  const items = [{ id: "p1", original_text: "봄이 왔다." }];
  const rows = [{ id: "p1", translated_text: "春天来了。" }];
  const result = repairTermLeftovers(items, rows, glossaryCore.getRelevantEntries(glossaryOf(["봄", "春"]), items, {}));
  assert.equal(result[0], rows[0], "同一个对象引用");
  assert.equal(repairTermLeftovers(items, rows, []), rows);
  assert.equal(repairTermLeftovers(items, null, []), null);
});

test("助词表与共享实现同源：每条尾巴都能被 matchesSourceTerm 认下来", () => {
  TERM_REPAIR_TAILS.forEach(tail => {
    assert.ok(glossaryCore.matchesSourceTerm(`레오나르도${tail} 말했다.`, "레오나르도"),
      `共享匹配器不认「${tail}」：这张表已经和 shared/glossary.js 漂移了`);
  });
});

test("替换发生在校验之前：韩文残留判定因此不再把整段丢掉", () => {
  const glossary = glossaryOf(["레오나르도", "莱昂纳多"]);
  const items = [{ id: "p1", original_text: "레오나르도가 말했다." }];
  const rows = [{ id: "p1", translated_text: "레오나르도가 说道。" }];
  const entries = glossaryCore.getRelevantEntries(glossary, items, { scopeKey: "" });
  // 现在两条链路都先替换再校验：6 个韩文字符不再触发「仍是韩文」，整段直接合格。
  // （这段修复原先只在手机版做，桌面版会整段丢掉再去逐段重试。）
  const desktop = novelCore.validateTranslations(items, rows, entries, LANGUAGES);
  assert.deepEqual(desktop.errors, []);
  assert.deepEqual(desktop.accepted, [{ id: "p1", translated_text: "莱昂纳多说道。" }]);
  // 手机版的校验器覆盖（术语改成「模型判断」）同样在替换之后跑，结果一致
  const runtime = { glossaryCore, novelCore };
  installGlossaryJudgementLocal(runtime);
  const mobile = runtime.novelCore.validateTranslations(items, rows, entries, LANGUAGES);
  assert.deepEqual(mobile.errors, []);
  assert.deepEqual(mobile.accepted, [{ id: "p1", translated_text: "莱昂纳多说道。" }]);
});

test("替换是幂等的：同一段校验两次结果一样", () => {
  const glossary = glossaryOf(["레오나르도", "莱昂纳多"]);
  const items = [{ id: "p1", original_text: "레오나르도가 말했다." }];
  const entries = glossaryCore.getRelevantEntries(glossary, items, { scopeKey: "" });
  const first = repairTermLeftovers(items, [{ id: "p1", translated_text: "레오나르도가 说道。" }], entries);
  const second = repairTermLeftovers(items, first, entries);
  assert.deepEqual(second, first);
});
