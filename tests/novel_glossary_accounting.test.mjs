import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import novelCore from "../extension/src/shared/novel.js";

/**
 * 术语：裁决权留给模型，但模型必须逐条交代。
 *
 * 背景（用户实测）：去掉术语硬校验是因为字符串命中经常不是那个意思 —— 봄 = 春天 / 人名，
 * 줄 = 排队 / 人名，硬套会把句子改坏；但完全不校验，模型又可以**默默不用**注入的术语，
 * 于是表现为「术语有时候就是不生效」。
 *
 * 现在的口径：
 *   ① 用上了（译文含译名）→ 通过；
 *   ② 没用，但写明了「这次语境不是它」+ 理由 → 通过（尊重模型判断）；
 *   ③ 用了却说用了（译名不在译文里）→ glossary_violation，点名重试；
 *   ④ 既没用也没交代 → glossary_unaccounted，点名重试；
 *   ⑤ 模型整条响应没按新 schema 回（旧缓存 / 老模型）→ 退回旧字符串硬校验，
 *      而不是把所有命中的术语都判成「没交代」而后整章重试；
 *   ⑥ 无论哪种失败，译文都留在 glossaryFallbacks 里 —— 不给格式问题丢段落。
 */

const LANGUAGES = { sourceLanguage: "ko", targetLanguage: "zh-CN" };

function entriesFor(original, source, target) {
  return glossaryCore.getRelevantEntries(
    { libraries: [{ id: "default", name: "默认术语库", enabled: true, urls: [], applyUrls: [] }],
      entries: [{ id: "t1", source, target, libraryId: "default" }] },
    [{ id: "p1", original_text: original }],
    { scopeKey: "" }
  );
}

function check(original, translated, terms, source = "봄", target = "春", requireMatch = true) {
  const entries = entriesFor(original, source, target);
  if (requireMatch) assert.equal(entries.length, 1, `测试前提：术语 ${source} 必须命中原文`);
  return novelCore.validateTranslations(
    [{ id: "p1", original_text: original }],
    [{ id: "p1", translated_text: translated, ...(terms === undefined ? {} : { terms }) }],
    entries,
    LANGUAGES
  );
}

test("① 译名逐字用上：通过", () => {
  const checked = check("봄이 왔다.", "春天来了。", { used: ["봄"], skipped: [] });
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.accepted, [{ id: "p1", translated_text: "春天来了。" }]);
});

test("② 模型判定「这次不是它」并给出理由：放行，不硬套", () => {
  // 译文里没有「春」：只有模型写明语境不符才该放行
  const checked = check("봄이 왔다.", "寒冬总算过去了。", {
    used: [], skipped: [{ source: "봄", reason: "봄 = 春天（季节），不是角色名" }]
  });
  assert.deepEqual(checked.errors, [], "模型说清了语境，就不该再被判违规");
  assert.equal(checked.accepted.length, 1);
});

test("②b 理由为空不算交代（防模型顺手把每条都跳过）", () => {
  const checked = check("봄이 왔다.", "寒冬总算过去了。", { used: [], skipped: [{ source: "봄", reason: "  " }] });
  assert.deepEqual(checked.errors.map(error => error.code), ["glossary_unaccounted"]);
});

test("③ 声称用上、译文里却没有：glossary_violation，点名重试", () => {
  const checked = check("레오나르도가 말했다.", "列奥纳多说道。", { used: ["레오나르도"], skipped: [] },
    "레오나르도", "莱昂纳多");
  assert.deepEqual(checked.errors.map(error => error.code), ["glossary_violation"]);
  assert.deepEqual(checked.errors[0].terms, ["레오나르도"]);
  assert.equal(checked.accepted.length, 0);
  assert.equal(checked.glossaryFallbacks.length, 1, "重试仍失败时要能把译文留住");
});

test("④ 既没用也没交代：glossary_unaccounted（这就是「术语有时候不生效」）", () => {
  const checked = check("레오나르도가 말했다.", "列奥纳多说道。", { used: [], skipped: [] },
    "레오나르도", "莱昂纳多");
  assert.deepEqual(checked.errors.map(error => error.code), ["glossary_unaccounted"]);
  assert.deepEqual(checked.errors[0].terms, ["레오나르도"]);
  assert.equal(checked.accepted.length, 0);
  assert.deepEqual(checked.glossaryFallbacks[0].terms, ["레오나르도"]);
});

test("⑤ 旧响应没有 terms 字段：退回旧字符串硬校验，不当成「全都没交代」", () => {
  const violated = check("레오나르도가 말했다.", "列奥纳多说道。", undefined, "레오나르도", "莱昂纳多");
  assert.deepEqual(violated.errors.map(error => error.code), ["glossary_violation"]);
  const ok = check("레오나르도가 말했다.", "莱昂纳多说道。", undefined, "레오나르도", "莱昂纳多");
  assert.deepEqual(ok.errors, []);
});

test("⑥ 原文没命中术语的段落，有没有交代都不受影响", () => {
  const checked = check("그는 조용히 고개를 끄덕였다.", "他默默点了点头。", { used: [], skipped: [] },
    "레오나르도", "莱昂纳多", false);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.accepted.length, 1);
});

test("⑦ 汇总文案能区分「不一致」和「既没用也没交代」", () => {
  const accounted = novelCore.summarizeTranslationErrors([{ id: "a", code: "glossary_unaccounted" }]);
  assert.match(accounted.text, /术语既没用也没交代 1 段/u);
  const violated = novelCore.summarizeTranslationErrors([{ id: "a", code: "glossary_violation" }]);
  assert.match(violated.text, /术语不一致 1 段/u);
});
