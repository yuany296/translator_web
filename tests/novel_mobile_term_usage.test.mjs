import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import {
  TERM_USAGE_REASON_TEXT,
  formatTermUsage,
  installTermUsageLocal,
  mergeTermUsage,
  summarizeTermUsage
} from "../extension/src/novel-mobile/term-usage-local.js";

// 「术语为什么没生效」要在手机上直接说出来。这组测试把四种原因逐个造出来，
// 顺带盯住「注入」和「用上」是两件事（模型看到了却没用，必须能单独看出来）。
const PAGE = "https://page.kakao.com/content/69299983/viewer/1";
const ITEMS = [{ id: "p1", original_text: "레오나르도가 말했다." }];
const KO = { sourceLanguage: "ko", targetLanguage: "zh-CN" };

function context(extra = {}) {
  return { scopeKey: "kakao:69299983", pageUrl: PAGE, ...KO, ...extra };
}

function glossaryOf(library, entries) {
  return glossaryCore.normalizeGlossary({ libraries: [library], entries });
}

test("正常情况：注入条数与「用上」条数分开统计", () => {
  const glossary = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: true, urls: [], applyUrls: [] },
    [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  );
  const used = summarizeTermUsage(glossaryCore, glossary, context(), ITEMS,
    [{ id: "p1", translated_text: "莱昂纳多说道。" }]);
  assert.deepEqual(used, { entries: 1, enabled: 1, injected: 1, used: 1, unused: [], reason: "ok" });
  const skipped = summarizeTermUsage(glossaryCore, glossary, context(), ITEMS,
    [{ id: "p1", translated_text: "那个人说道。" }]);
  assert.equal(skipped.injected, 1);
  assert.equal(skipped.used, 0, "注入了但模型没用，必须能单独看出来");
  assert.deepEqual(skipped.unused, [{ id: "p1", source: "레오나르도", target: "莱昂纳多" }],
    "未使用的那一条要带上是哪一段，内容脚本才能定点补翻");
  assert.equal(formatTermUsage(used), "术语用上 1/1");
  assert.equal(formatTermUsage(skipped), "术语用上 0/1");
});

test("术语库为空时不多嘴", () => {
  const empty = glossaryCore.normalizeGlossary(null);
  const usage = summarizeTermUsage(glossaryCore, empty, context(), ITEMS, [{ id: "p1", translated_text: "他说道。" }]);
  assert.equal(usage.entries, 0);
  assert.equal(usage.reason, "empty");
  assert.equal(formatTermUsage(usage), "", "没有术语库就别在进度行上占地方");
});

test("原因一：库被停用", () => {
  const glossary = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: false, urls: [], applyUrls: [] },
    [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  );
  const usage = summarizeTermUsage(glossaryCore, glossary, context(), ITEMS, [{ id: "p1", translated_text: "他说道。" }]);
  assert.equal(usage.enabled, 0);
  assert.equal(usage.reason, "disabled");
  assert.match(formatTermUsage(usage), /术语库已停用/u);
});

test("原因二：本页不在应用网址内（绑定网址只归集，不生效）", () => {
  const glossary = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: true, urls: [PAGE], applyUrls: ["https://page.kakao.com/content/11111111/*"] },
    [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  );
  const usage = summarizeTermUsage(glossaryCore, glossary, context(), ITEMS, [{ id: "p1", translated_text: "他说道。" }]);
  assert.equal(usage.enabled, 0);
  assert.equal(usage.reason, "page");
  assert.match(formatTermUsage(usage), /一键加入应用/u);
  // 点过「一键加入应用」之后：应用网址包含本页，立刻就说 ok
  const fixed = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: true, urls: [PAGE], applyUrls: [PAGE] },
    [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  );
  assert.equal(summarizeTermUsage(glossaryCore, fixed, context(), ITEMS, [{ id: "p1", translated_text: "他说道。" }]).reason, "ok");
});

test("原因三/四：作用域与语言对不匹配", () => {
  const scoped = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: true, urls: [], applyUrls: [] },
    [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1", scope: "work", workId: "kakao:11111111" }]
  );
  assert.equal(summarizeTermUsage(glossaryCore, scoped, context(), ITEMS, []).reason, "scope");
  const english = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: true, urls: [], applyUrls: [] },
    [{ source: "레오나르도", target: "Leonardo", libraryId: "lib-1", sourceLanguage: "en" }]
  );
  assert.equal(summarizeTermUsage(glossaryCore, english, context(), ITEMS, []).reason, "language");
  assert.ok(Object.values(TERM_USAGE_REASON_TEXT).every(text => text.includes("术语未生效")));
});

test("合并多块：计数相加，未使用术语去重，原因取第一个非 ok 的", () => {
  const first = { entries: 3, enabled: 3, injected: 2, used: 1, unused: [{ id: "p1", source: "봄", target: "春" }], reason: "ok" };
  const second = { entries: 3, enabled: 3, injected: 1, used: 0, unused: [{ id: "p1", source: "봄", target: "春" }], reason: "ok" };
  assert.deepEqual(mergeTermUsage(first, second), {
    entries: 3, enabled: 3, injected: 3, used: 1,
    unused: [{ id: "p1", source: "봄", target: "春" }], reason: "ok"
  });
  const other = { entries: 3, enabled: 0, injected: 0, used: 0, unused: [{ id: "p2", source: "봄", target: "春" }], reason: "page" };
  const merged = mergeTermUsage(first, other);
  assert.equal(merged.reason, "page");
  assert.deepEqual(merged.unused.map(entry => entry.id), ["p1", "p2"]);
  assert.deepEqual(mergeTermUsage(null, first), first);
  assert.equal(mergeTermUsage(first, null).used, 1);
});

test("未使用术语最多回传 10 条：内容脚本只用它决定补哪几段", () => {
  const glossary = glossaryCore.normalizeGlossary({
    entries: Array.from({ length: 15 }, (_, index) => ({ source: `이름${index}`, target: `名字${index}` }))
  });
  const items = Array.from({ length: 15 }, (_, index) => ({ id: `p${index}`, original_text: `이름${index}가 왔다.` }));
  const usage = summarizeTermUsage(glossaryCore, glossary, context(), items,
    items.map(item => ({ id: item.id, translated_text: "他来了。" })));
  assert.equal(usage.injected, 15);
  assert.equal(usage.used, 0);
  assert.equal(usage.unused.length, 10, "回传列表要有上限");
  assert.deepEqual(usage.unused[0], { id: "p0", source: "이름0", target: "名字0" });
});

test("响应带上 termUsage，装载失败也不影响译文", async () => {
  const glossary = glossaryOf(
    { id: "lib-1", name: "骸骨皇女", enabled: true, urls: [], applyUrls: [] },
    [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  );
  const runtime = {
    glossaryCore,
    getErrorMessage: error => String(error && error.message || error || ""),
    loadConfiguration: async () => ({ translation: { sourceLanguage: "ko", targetLanguage: "zh-CN" }, glossary }),
    handleTranslateNovelChunk: async () => ({
      ok: true, translations: [{ id: "p1", translated_text: "莱昂纳多说道。" }], diagnostics: []
    })
  };
  installTermUsageLocal(runtime);
  const result = await runtime.handleTranslateNovelChunk({ items: ITEMS, pageUrl: PAGE, scopeKey: "kakao:69299983" }, {});
  assert.deepEqual(result.termUsage, { entries: 1, enabled: 1, injected: 1, used: 1, unused: [], reason: "ok" });
  // 统计炸了也不许动译文
  runtime.loadConfiguration = async () => { throw new Error("storage down"); };
  const fallback = await runtime.handleTranslateNovelChunk({ items: ITEMS, pageUrl: PAGE }, {});
  assert.equal(fallback.termUsage, undefined);
  assert.equal(fallback.translations.length, 1);
});

test("失败的响应不统计（没有译文可统计）", async () => {
  const runtime = {
    glossaryCore,
    loadConfiguration: async () => ({ translation: {}, glossary: null }),
    handleTranslateNovelChunk: async () => ({ ok: false, error: "boom" })
  };
  installTermUsageLocal(runtime);
  assert.deepEqual(await runtime.handleTranslateNovelChunk({}, {}), { ok: false, error: "boom" });
  assert.deepEqual(installTermUsageLocal({}), {}, "没有处理器时安装器不报错");
});
