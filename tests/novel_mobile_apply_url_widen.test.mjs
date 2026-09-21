import assert from "node:assert/strict";
import test from "node:test";
import glossaryCore from "../extension/src/shared/glossary.js";
import {
  installApplyUrlWidening,
  widenApplyUrl,
  widenBoundUrlFields
} from "../extension/src/novel-mobile/apply-url-widen.js";

// 用户报的现象：「一键加入应用」之后术语就不生效了。
// 原因：绑定网址常是章节级的（…/content/{作品}/viewer/{章节}），复制进应用网址之后，
// 应用范围从「空 = 全站生效」变成「只有那一章」。这里既测放宽函数，也用真实的
// getEnabledEntries 把「换一章就不生效」和「放宽后恢复生效」都固定下来。
const CHAPTER_1 = "https://page.kakao.com/content/69299983/viewer/11111111";
const CHAPTER_2 = "https://page.kakao.com/content/69299983/viewer/22222222";
const SERIES = "https://page.kakao.com/content/69299983";

function glossaryWithApplyUrls(applyUrls) {
  return glossaryCore.normalizeGlossary({
    libraries: [{ id: "lib-1", name: "骸骨皇女", enabled: true, urls: [CHAPTER_1], applyUrls }],
    entries: [{ source: "레오나르도", target: "莱昂纳多", libraryId: "lib-1" }]
  });
}

function effectiveCount(applyUrls, pageUrl) {
  return glossaryCore.getEnabledEntries(glossaryWithApplyUrls(applyUrls), {
    scopeKey: "kakao:69299983", pageUrl, sourceLanguage: "ko", targetLanguage: "zh-CN"
  }).length;
}

test("这就是报的那个 bug：加入章节地址后，换一章术语就不生效了", () => {
  assert.equal(effectiveCount([], CHAPTER_2), 1, "应用名单为空 = 全站生效");
  assert.equal(effectiveCount([CHAPTER_1], CHAPTER_1), 1, "本来的那一章仍然生效");
  assert.equal(effectiveCount([CHAPTER_1], CHAPTER_2), 0, "换一章就没了 —— 用户看到的「不生效」");
});

test("放宽成作品地址之后，整个作品的章节都生效", () => {
  const widened = widenApplyUrl(CHAPTER_1);
  assert.equal(widened, "https://page.kakao.com/content/69299983/*");
  assert.equal(effectiveCount([widened], CHAPTER_1), 1);
  assert.equal(effectiveCount([widened], CHAPTER_2), 1);
  assert.equal(effectiveCount([widened], SERIES), 1, "作品页也该生效");
  assert.equal(effectiveCount([widened], "https://page.kakao.com/content/12345678/viewer/1"), 0,
    "别的小说不许被串进来");
});

test("只放宽阅读器地址，其它地址一个字不动", () => {
  assert.equal(widenApplyUrl(""), "");
  assert.equal(widenApplyUrl("   "), "");
  assert.equal(widenApplyUrl(SERIES), SERIES, "已经是作品级");
  assert.equal(widenApplyUrl(`${SERIES}/*`), `${SERIES}/*`, "幂等");
  assert.equal(widenApplyUrl("https://comic.naver.com/webtoon/list?titleId=123456"), "https://comic.naver.com/webtoon/list?titleId=123456");
  assert.equal(widenApplyUrl("page.kakao.com/content/69299983/viewer/11111111"),
    "page.kakao.com/content/69299983/*", "没有协议也要放宽");
  assert.equal(widenApplyUrl(`${CHAPTER_1}?continue=1#top`), "https://page.kakao.com/content/69299983/*",
    "带查询串也要放宽（后续 normalizeLibraryUrl 本来也会去掉查询串）");
  assert.equal(widenApplyUrl("https://page.kakao.com/content/69299983/viewer"), "https://page.kakao.com/content/69299983/viewer",
    "没有章节标识就不是章节地址");
});

test("点击时先放宽绑定网址输入框，批量态也一样", () => {
  const handlers = [];
  const rows = [
    { value: CHAPTER_1 },
    { value: SERIES },
    { value: "" }
  ];
  const bulk = { value: `${CHAPTER_1}\n${SERIES}` };
  const doc = {
    getElementById: id => (id === "libraryUrlsInput" ? bulk : id === "libraryApplyAllBtn" ? button : null),
    querySelectorAll: selector => (selector === "#libraryUrlList input[data-action='edit-url']" ? rows : [])
  };
  const button = { addEventListener: (type, handler, capture) => handlers.push({ type, handler, capture }) };
  assert.equal(widenBoundUrlFields(doc), true);
  assert.deepEqual(rows.map(row => row.value), ["https://page.kakao.com/content/69299983/*", SERIES, ""]);
  assert.equal(bulk.value, "https://page.kakao.com/content/69299983/*\nhttps://page.kakao.com/content/69299983");
  // 已经放宽过就什么都不改
  assert.equal(widenBoundUrlFields(doc), false);
  installApplyUrlWidening({ applySingleUrl: undefined }, doc);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].capture, true, "必须在原处理器之前跑（原处理器是模块私有的）");
});

test("行内「应用」按钮（晚绑定）拿到的也是放宽后的地址", async () => {
  const seen = [];
  const runtime = { applySingleUrl: async url => seen.push(url) };
  installApplyUrlWidening(runtime, { getElementById: () => null, querySelectorAll: () => [] });
  await runtime.applySingleUrl(CHAPTER_1);
  await runtime.applySingleUrl(SERIES);
  assert.deepEqual(seen, ["https://page.kakao.com/content/69299983/*", SERIES]);
});

test("页面上找不到按钮时安装器不报错", () => {
  const runtime = { applySingleUrl: async () => {} };
  assert.equal(installApplyUrlWidening(runtime, {
    getElementById: () => null, querySelectorAll: () => []
  }), runtime);
});
