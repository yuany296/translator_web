import assert from "node:assert/strict";
import test from "node:test";
import libraryCore from "../extension/src/shared/glossary-library.js";

const KAKAO_OVERVIEW = "https://page.kakao.com/content/69299983/";
const KAKAO_CHAPTER = "https://page.kakao.com/content/69299983/viewer/69333586/";

function library(overrides = {}) {
  return {
    id: "novel", name: "骸骨皇女", enabled: true, urls: [KAKAO_OVERVIEW], ...overrides
  };
}

test("library URLs normalize scheme, host case, trailing slash, query and hash", () => {
  assert.equal(libraryCore.normalizeLibraryUrl(KAKAO_OVERVIEW), "https://page.kakao.com/content/69299983");
  assert.equal(
    libraryCore.normalizeLibraryUrl("https://PAGE.kakao.com/content/69299983/?tab=episodes#list"),
    "https://page.kakao.com/content/69299983"
  );
  assert.equal(libraryCore.normalizeLibraryUrl("page.kakao.com/content/69299983"), "https://page.kakao.com/content/69299983");
  assert.equal(libraryCore.normalizeLibraryUrl("https://page.kakao.com:443/"), "https://page.kakao.com");
  assert.equal(libraryCore.normalizeLibraryUrl("ftp://page.kakao.com/content/1"), "");
  assert.equal(libraryCore.normalizeLibraryUrl("   "), "");
  assert.equal(libraryCore.normalizeLibraryUrl("随便写点什么"), "");
});

test("a bound overview URL captures its chapter URLs but not sibling series", () => {
  assert.equal(libraryCore.libraryUrlMatches(KAKAO_CHAPTER, KAKAO_OVERVIEW), true);
  assert.equal(libraryCore.libraryUrlMatches(KAKAO_CHAPTER, "https://page.kakao.com/content/69299983"), true);
  // 路径段边界：不能命中同前缀的另一部作品
  assert.equal(libraryCore.libraryUrlMatches("https://page.kakao.com/content/692999830/viewer/1", KAKAO_OVERVIEW), false);
  // 跨主机、跨协议不命中
  assert.equal(libraryCore.libraryUrlMatches("https://evil.example/content/69299983/viewer/1", KAKAO_OVERVIEW), false);
  assert.equal(libraryCore.libraryUrlMatches("http://page.kakao.com/content/69299983/viewer/1", KAKAO_OVERVIEW), false);
  // 根路径绑定匹配该主机下所有页面
  assert.equal(libraryCore.libraryUrlMatches(KAKAO_CHAPTER, "https://page.kakao.com"), true);
  assert.equal(libraryCore.libraryUrlMatches("https://other.example/x", "https://page.kakao.com"), false);
});

test("matchLibraryByUrl picks the longest enabled pattern and ignores disabled libraries", () => {
  const libraries = [
    library({ id: "site", name: "整站", urls: ["https://page.kakao.com/"] }),
    library({ id: "novel", name: "骸骨皇女" }),
    library({ id: "off", name: "已停用", enabled: false, urls: ["https://page.kakao.com/content/69299983/viewer"] })
  ];

  assert.deepEqual(libraryCore.matchLibraryByUrl(libraries, KAKAO_CHAPTER), {
    libraryId: "novel", pattern: "https://page.kakao.com/content/69299983"
  });
  assert.deepEqual(libraryCore.matchLibraryByUrl(libraries, "https://page.kakao.com/content/1/viewer/2"), {
    libraryId: "site", pattern: "https://page.kakao.com"
  });
  assert.equal(libraryCore.matchLibraryByUrl(libraries, "https://example.com/chapter/1"), null);
  assert.equal(libraryCore.matchLibraryByUrl(libraries, ""), null);
  // 库停用后不再承接新术语
  assert.deepEqual(
    libraryCore.matchLibraryByUrl(libraries.map(item => item.id === "novel" ? { ...item, enabled: false } : item), KAKAO_CHAPTER),
    { libraryId: "site", pattern: "https://page.kakao.com" }
  );
});

test("wildcard patterns normalize like Immersive Translate writes them", () => {
  // 写法原样往返，只做主机小写、去查询串/片段/末尾斜杠
  assert.equal(libraryCore.normalizeLibraryUrl("*.google.com"), "*.google.com");
  assert.equal(libraryCore.normalizeLibraryUrl("google.com/mail/*"), "google.com/mail/*");
  assert.equal(libraryCore.normalizeLibraryUrl("https://www.google.com/*"), "https://www.google.com/*");
  assert.equal(libraryCore.normalizeLibraryUrl("HTTPS://WWW.Google.com/Mail/*?tab=1#top"), "https://www.google.com/Mail/*");
  assert.equal(libraryCore.normalizeLibraryUrl("  *.google.com/  "), "*.google.com");
  // 认得出是通配；乱写的仍然丢掉
  assert.equal(libraryCore.isLibraryUrlPattern("*.google.com"), true);
  assert.equal(libraryCore.isLibraryUrlPattern(KAKAO_OVERVIEW), false);
  assert.equal(libraryCore.normalizeLibraryUrl("随便写*点什么"), "");
  assert.equal(libraryCore.normalizeLibraryUrl("ftp://*.google.com"), "");
});

test("`*.google.com` covers subdomains (both schemes) but not the bare domain", () => {
  assert.equal(libraryCore.libraryUrlMatches("https://mail.google.com/mail/u/0", "*.google.com"), true);
  assert.equal(libraryCore.libraryUrlMatches("http://www.google.com/", "*.google.com"), true, "不写协议时 http 也算");
  assert.equal(libraryCore.libraryUrlMatches("https://a.b.google.com/x", "*.google.com"), true, "多层子域也算");
  assert.equal(libraryCore.libraryUrlMatches("https://google.com/", "*.google.com"), false, "裸域不算子域");
  assert.equal(libraryCore.libraryUrlMatches("https://notgoogle.com/", "*.google.com"), false);
  assert.equal(libraryCore.libraryUrlMatches("https://google.com.evil.net/", "*.google.com"), false);
});

test("`google.com/mail/*` and `https://www.google.com/*` match like the reference", () => {
  // 路径里的 * 可以跨 /
  assert.equal(libraryCore.libraryUrlMatches("https://google.com/mail/u/0/inbox", "google.com/mail/*"), true);
  assert.equal(libraryCore.libraryUrlMatches("http://google.com/mail/", "google.com/mail/*"), true);
  assert.equal(libraryCore.libraryUrlMatches("https://google.com/mailbox", "google.com/mail/*"), false);
  assert.equal(libraryCore.libraryUrlMatches("https://google.com/maps/x", "google.com/mail/*"), false);
  // 整站任意页面
  assert.equal(libraryCore.libraryUrlMatches("https://www.google.com/search?q=1", "https://www.google.com/*"), true);
  assert.equal(libraryCore.libraryUrlMatches("https://www.google.com", "https://www.google.com/*"), true);
  assert.equal(libraryCore.libraryUrlMatches("https://www.google.com.evil.net/x", "https://www.google.com/*"), false);
  assert.equal(libraryCore.libraryUrlMatches("https://other.com/x", "https://www.google.com/*"), false);
  // 带协议就只管那个协议（老写法一致）
  assert.equal(libraryCore.libraryUrlMatches("http://www.google.com/x", "https://www.google.com/*"), false);
  // 通配主机 + 不带 * 的路径：仍按段边界前缀（绑定总览页照样接住章节页）
  assert.equal(libraryCore.libraryUrlMatches("https://a.google.com/mail/u/0", "*.google.com/mail"), true);
  assert.equal(libraryCore.libraryUrlMatches("https://a.google.com/mailbox", "*.google.com/mail"), false);
});

test("matchLibraryByUrl prefers the most specific binding when wildcards are in play", () => {
  const libraries = [
    library({ id: "site", name: "整个 Google", urls: ["*.google.com"] }),
    library({ id: "mail", name: "Gmail", urls: ["google.com/mail/*"] }),
    library({ id: "inbox", name: "收件箱", urls: ["https://mail.google.com/mail/u/0"] })
  ];
  assert.deepEqual(libraryCore.matchLibraryByUrl(libraries, "https://mail.google.com/mail/u/0/inbox"), {
    libraryId: "inbox", pattern: "https://mail.google.com/mail/u/0"
  });
  assert.deepEqual(libraryCore.matchLibraryByUrl(libraries, "https://google.com/mail/u/1"), {
    libraryId: "mail", pattern: "google.com/mail/*"
  });
  // 主机写成精确域名就管不到子域（要管子域得写 *.google.com）——与沉浸式翻译一致
  assert.deepEqual(libraryCore.matchLibraryByUrl(libraries, "https://mail.google.com/mail/u/1"), {
    libraryId: "site", pattern: "*.google.com"
  });
  assert.deepEqual(libraryCore.matchLibraryByUrl(libraries, "https://docs.google.com/document/d/1"), {
    libraryId: "site", pattern: "*.google.com"
  });
  assert.equal(libraryCore.matchLibraryByUrl(libraries, "https://example.com/"), null);
});

test("normalizeLibraries always keeps a default library first and dedupes URLs", () => {
  const libraries = libraryCore.normalizeLibraries([
    { id: "novel", name: "骸骨皇女", urls: [KAKAO_OVERVIEW, KAKAO_OVERVIEW, "  ", "not a url"] },
    { id: "novel", name: "重复 id 被丢弃" },
    { id: "default", name: "", enabled: false }
  ]);

  assert.deepEqual(libraries.map(item => item.id), ["novel", "default"]);
  assert.deepEqual(libraries[0].urls, ["https://page.kakao.com/content/69299983"]);
  assert.equal(libraries[1].name, "术语库 3");
  assert.equal(libraries[1].enabled, false);

  const empty = libraryCore.normalizeLibraries(undefined);
  assert.deepEqual(empty.map(item => item.id), ["default"]);
  assert.equal(empty[0].name, libraryCore.DEFAULT_LIBRARY_NAME);
  assert.equal(empty[0].enabled, true);
});

test("library lookup falls back to the default library for unknown ids", () => {
  const libraries = libraryCore.normalizeLibraries([library()]);

  assert.equal(libraryCore.getLibrary(libraries, "novel").name, "骸骨皇女");
  assert.equal(libraryCore.getLibrary(libraries, "nope").id, "default");
  assert.equal(libraryCore.getLibrary(libraries, "").id, "default");
  assert.equal(libraryCore.getLibraryName(libraries, "nope"), libraryCore.DEFAULT_LIBRARY_NAME);
  assert.equal(libraryCore.isLibraryEnabled(libraries, "novel"), true);
  assert.equal(libraryCore.isLibraryEnabled(libraries, "nope"), true);
  assert.equal(
    libraryCore.isLibraryEnabled(libraries.map(item => ({ ...item, enabled: false })), "novel"),
    false
  );
});
