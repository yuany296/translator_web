import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import novelCore from "../extension/src/shared/novel.js";
import {
  GLOSSARY_JUDGEMENT_RULES,
  buildGlossaryJudgementPrompt,
  buildGlossaryJudgementValidator,
  installGlossaryJudgementLocal
} from "../extension/src/novel-mobile/glossary-judgement.js";

// 手机版「术语由模型按语境判断」的两半：提示词 + 校验器。
// 每个关键结论都配一个**桌面版对照组**：不做对照的话，两边同为空的用例会假装通过。
const LANGUAGES = { sourceLanguage: "ko", targetLanguage: "zh-CN" };

function makeGlossary() {
  return glossaryCore.normalizeGlossary({
    entries: [
      { source: "봄", target: "春", note: "女主角，17 岁" },
      { source: "줄", target: "朱尔" }
    ]
  });
}

function makeRuntime() {
  const runtime = { glossaryCore, novelCore };
  installGlossaryJudgementLocal(runtime);
  return runtime;
}

function relevant(glossary, items) {
  return glossaryCore.getRelevantEntries(glossary, items, { scopeKey: "" });
}

test("提示词把决定权交给模型：不再出现 mandatory / 必须逐字使用", () => {
  const glossary = makeGlossary();
  const items = [{ id: "p1", original_text: "봄이 왔다." }];
  const mobile = buildGlossaryJudgementPrompt(glossaryCore, glossary, items, { scopeKey: "" });
  const desktop = glossaryCore.buildPrompt(glossary, items, { scopeKey: "" });
  assert.ok(mobile.length > 0, "命中术语时必须给出词条");
  // 桌面版那条硬规则仍在（对照组）：说明这两句确实是本次替换掉的东西
  assert.match(desktop, /must contain its target string verbatim/u);
  assert.doesNotMatch(mobile, /mandatory/iu);
  assert.doesNotMatch(mobile, /must contain its target string verbatim/u);
  // 手机版必须明确要求「先按句子判断所指」，并且把「按语境译」排在「一致性」前面
  assert.match(mobile, /judge each row against this passage/u);
  assert.match(mobile, /another sense/u);
  assert.match(mobile, /beats a consistency that changes its meaning/u);
  // 两个分支都不许「照抄原文」：用词条时给译名，跳过词条时按意思翻
  assert.match(mobile, /never as the source spelling, a quoted original, or a parenthetical gloss/u);
  assert.match(mobile, /never copy the source spelling as a way out/u);
  // 人名必须用给定译名，不许自己发挥（这是「有些人名是自己发挥的」的直接约束）
  assert.match(mobile, /never invent your own transliteration/u);
  GLOSSARY_JUDGEMENT_RULES.forEach(rule => assert.ok(mobile.includes(rule), `规则缺失：${rule}`));
});

test("词条照旧只挑本块真的出现的：来源、译名、备注都还在", () => {
  const glossary = makeGlossary();
  const items = [{ id: "p1", original_text: "봄이 왔다." }];
  const mobile = buildGlossaryJudgementPrompt(glossaryCore, glossary, items, { scopeKey: "" });
  assert.ok(mobile.includes(JSON.stringify([{ source: "봄", target: "春", note: "女主角，17 岁" }])),
    "只该注入命中的那一条，且带上备注");
  assert.ok(!mobile.includes("朱尔"), "没出现的术语不该进提示词");
});

test("本块没有命中任何术语时仍然是空提示词（不要塞一段无用的规则）", () => {
  const glossary = makeGlossary();
  const items = [{ id: "p1", original_text: "별이 빛난다." }];
  assert.equal(buildGlossaryJudgementPrompt(glossaryCore, glossary, items, { scopeKey: "" }), "");
  assert.equal(glossaryCore.buildPrompt(glossary, items, { scopeKey: "" }), "", "对照组");
});

test("只换掉 buildPrompt 与术语校验：术语指纹与其它函数原样保留", () => {
  const runtime = makeRuntime();
  const glossary = makeGlossary();
  assert.notEqual(runtime.glossaryCore, glossaryCore);
  assert.notEqual(runtime.novelCore, novelCore);
  assert.equal(runtime.glossaryCore.STORAGE_KEY, glossaryCore.STORAGE_KEY);
  assert.equal(runtime.glossaryCore.getLibraryName(glossary, "default"),
    glossaryCore.getLibraryName(glossary, "default"));
  // 指纹没变 → 缓存键没变：已经译好的段落不会因为这次改动全部作废
  assert.equal(runtime.glossaryCore.getFingerprint(glossary), glossaryCore.getFingerprint(glossary));
  assert.equal(runtime.novelCore.buildChunks, novelCore.buildChunks);
  assert.equal(runtime.novelCore.parseKakaoNovelLocation, novelCore.parseKakaoNovelLocation);
});

test("术语在文章里不是那个意思：桌面版判违规并丢掉译文，手机版原样接受", () => {
  const glossary = makeGlossary();
  // 줄 是人名「朱尔」，这里的意思是「排队」——字符串命中，语境不匹配
  const items = [{ id: "p1", original_text: "사람들이 줄을 섰다." }];
  const rows = [{ id: "p1", translated_text: "人们排起了队。" }];
  const entries = relevant(glossary, items);
  assert.equal(entries.length, 1, "匹配本身没有变：字符串层面仍然命中");
  const desktop = novelCore.validateTranslations(items, rows, entries, LANGUAGES);
  assert.deepEqual(desktop.errors.map(error => error.code), ["glossary_violation"]);
  assert.equal(desktop.accepted.length, 0, "桌面版这一段会被丢掉并去重试");
  assert.equal(desktop.glossaryFallbacks.length, 1);
  const mobile = makeRuntime().novelCore.validateTranslations(items, rows, entries, LANGUAGES);
  assert.deepEqual(mobile.errors, [], "手机版不再因为术语判错而重试");
  assert.deepEqual(mobile.accepted, [{ id: "p1", translated_text: "人们排起了队。" }]);
  assert.deepEqual(mobile.glossaryFallbacks, []);
});

test("术语确实指同一个人的时候两边都接受（放掉的只有「按语境判断」这一条）", () => {
  const glossary = makeGlossary();
  const items = [{ id: "p1", original_text: "봄이 웃었다." }];
  const rows = [{ id: "p1", translated_text: "春笑了。" }];
  const entries = relevant(glossary, items);
  const desktop = novelCore.validateTranslations(items, rows, entries, LANGUAGES);
  const mobile = makeRuntime().novelCore.validateTranslations(items, rows, entries, LANGUAGES);
  assert.deepEqual(desktop.errors, []);
  assert.deepEqual(mobile.errors, []);
  assert.deepEqual(mobile.accepted, desktop.accepted);
});

test("手机版仍然拦下缺段、韩文残留与重复译文：只放掉术语这一条", () => {
  const runtime = makeRuntime();
  const missing = runtime.novelCore.validateTranslations(
    [{ id: "p1", original_text: "봄이 왔다." }], [], [], LANGUAGES
  );
  assert.deepEqual(missing.errors.map(error => error.code), ["missing_translation"]);
  const leaked = runtime.novelCore.validateTranslations(
    [{ id: "p1", original_text: "안녕하세요 여러분 반갑습니다" }],
    [{ id: "p1", translated_text: "안녕하세요 여러분" }], [], LANGUAGES
  );
  assert.deepEqual(leaked.errors.map(error => error.code), ["source_language_leak"]);
  const duplicated = runtime.novelCore.validateTranslations(
    [{ id: "p1", original_text: "첫 번째 문장입니다" }, { id: "p2", original_text: "두 번째 문장입니다" }],
    [{ id: "p1", translated_text: "他转身就走了。" }, { id: "p2", translated_text: "他转身就走了。" }], [], LANGUAGES
  );
  assert.deepEqual(duplicated.errors.map(error => error.code), ["duplicate_translation"]);
  assert.deepEqual(duplicated.accepted.map(row => row.id), ["p1"]);
});

test("校验函数本身不含术语逻辑：传空条目就是纯放行，其它参数照旧透传", () => {
  const validate = buildGlossaryJudgementValidator(novelCore);
  const glossary = makeGlossary();
  const items = [{ id: "p1", original_text: "봄이 왔다." }];
  const rows = [{ id: "p1", translated_text: "春天来了。" }];
  assert.deepEqual(validate(items, rows, relevant(glossary, items), LANGUAGES),
    novelCore.validateTranslations(items, rows, [], LANGUAGES));
});

test("运行时缺少术语/小说核心时安装器不报错（页面被单独加载也不会炸）", () => {
  const runtime = {};
  installGlossaryJudgementLocal(runtime);
  assert.deepEqual(Object.keys(runtime), []);
});
