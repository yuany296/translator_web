import assert from "node:assert/strict";
import test from "node:test";
import scanner from "../extension/src/content/modules/webpage-scanner.js";

test("normalizeCandidateText collapses whitespace but keeps line structure", () => {
  assert.equal(scanner.normalizeCandidateText("  hello   world  "), "hello world");
  assert.equal(scanner.normalizeCandidateText("가\t나\n다"), "가 나\n다");
  assert.equal(scanner.normalizeCandidateText(""), "");
});

test("eligible text: natural language paragraphs pass", () => {
  assert.equal(scanner.isEligibleWebpageText("안녕하세요, 오늘은 좋은 날입니다."), true);
  assert.equal(scanner.isEligibleWebpageText("This is a plain English sentence."), true);
  assert.equal(scanner.isEligibleWebpageText("こんにちは世界"), true);
  assert.equal(scanner.isEligibleWebpageText("   spaced   out   "), true);
});

test("excluded: script, style, form controls and code containers by tag", () => {
  assert.ok(scanner.EXCLUDED_TAGS.has("SCRIPT"));
  assert.ok(scanner.EXCLUDED_TAGS.has("STYLE"));
  assert.ok(scanner.EXCLUDED_TAGS.has("CODE"));
  assert.ok(scanner.EXCLUDED_TAGS.has("PRE"));
  assert.ok(scanner.EXCLUDED_TAGS.has("TEXTAREA"));
  assert.ok(scanner.EXCLUDED_TAGS.has("INPUT"));
  assert.ok(scanner.EXCLUDED_TAGS.has("SELECT"));
  assert.ok(scanner.EXCLUDED_TAGS.has("OPTION"));
  assert.ok(scanner.EXCLUDED_TAGS.has("IFRAME"));
  assert.ok(scanner.EXCLUDED_TAGS.has("SVG"));
  // BUTTON 不在排除列表：普通按钮文本（登录/提交/下一页）应可翻译
  assert.equal(scanner.EXCLUDED_TAGS.has("BUTTON"), false);
});

test("ordinary button text is eligible; icon-only buttons are skipped by rules", () => {
  assert.equal(scanner.isEligibleWebpageText("로그인"), true);
  assert.equal(scanner.isEligibleWebpageText("Submit"), true);
  assert.equal(scanner.isEligibleWebpageText("Read more"), true);
  assert.equal(scanner.isEligibleWebpageText("×"), false);
  assert.equal(scanner.isEligibleWebpageText("→"), false);
  assert.equal(scanner.isEligibleWebpageText("＋"), false);
});

test("excluded: pure punctuation, symbols and whitespace", () => {
  assert.equal(scanner.isEligibleWebpageText("……"), false);
  assert.equal(scanner.isEligibleWebpageText("!?"), false);
  assert.equal(scanner.isEligibleWebpageText("★★★★★"), false);
  assert.equal(scanner.isEligibleWebpageText("   "), false);
  assert.equal(scanner.isEligibleWebpageText("a"), true);
  assert.equal(scanner.isEligibleWebpageText("한"), true);
});

test("single-letter natural language text is eligible regardless of container", () => {
  assert.equal(scanner.isEligibleWebpageText("책"), true);
  assert.equal(scanner.isEligibleWebpageText("本"), true);
  assert.equal(scanner.isEligibleWebpageText("→", { interactive: true }), false);
});

test("excluded: urls, emails and file paths", () => {
  assert.equal(scanner.isEligibleWebpageText("https://example.com/page?a=1"), false);
  assert.equal(scanner.isEligibleWebpageText("www.example.com"), false);
  assert.equal(scanner.isEligibleWebpageText("user@example.com"), false);
  assert.equal(scanner.isEligibleWebpageText("C:\\Users\\name\\file.txt"), false);
  assert.equal(scanner.isEligibleWebpageText("/usr/local/bin/tool"), false);
  assert.equal(scanner.isEligibleWebpageText("./relative/path"), false);
});

test("excluded: obvious code snippets", () => {
  assert.equal(scanner.isEligibleWebpageText("const a = 1; let b = 2;"), false);
  assert.equal(scanner.isEligibleWebpageText("function run() { return true; }"), false);
  assert.equal(scanner.isEligibleWebpageText("for (let i = 0; i < 10; i++) {}"), false);
  assert.equal(scanner.isEligibleWebpageText("var x = fetch(url);"), false);
});

test("language: clearly simplified-Chinese-dominant text is skipped", () => {
  assert.equal(scanner.isEligibleWebpageText("这是简体中文内容。"), false);
  assert.equal(scanner.isEligibleWebpageText("我们在这里等你很久了。"), false);
  assert.equal(scanner.isEligibleWebpageText("请点击这个按钮继续。"), false);
});

test("language: hangul-with-hanja is not mistaken for Simplified Chinese", () => {
  assert.equal(scanner.isEligibleWebpageText("한국어에 漢字가 섞인 문장"), true);
  assert.equal(scanner.isEligibleWebpageText("성현이 中国語를 배운다"), true);
});

test("language: Japanese kanji and kana text is not skipped", () => {
  assert.equal(scanner.isEligibleWebpageText("日本語の漢字は難しいです"), true);
  assert.equal(scanner.isEligibleWebpageText("こんにちは世界"), true);
});

test("language: traditional Chinese triggers translation (product converts to Simplified)", () => {
  assert.equal(scanner.isEligibleWebpageText("我們是好朋友。"), true);
  assert.equal(scanner.isEligibleWebpageText("這是繁體中文內容。"), true);
  assert.equal(scanner.isEligibleWebpageText("請點擊這個按鈕繼續。"), true);
});

test("language: mixed latin+Chinese keeps translating unless clearly simplified", () => {
  assert.equal(scanner.isEligibleWebpageText("Hello 世界"), true);
  assert.equal(scanner.isEligibleWebpageText("안녕 你好"), true);
  assert.equal(scanner.isEligibleWebpageText("Open AI 模型"), true);
  // 明确简体为主的文本（含简体特征字）仍跳过，即使带少量拉丁
  assert.equal(scanner.isEligibleWebpageText("iPhone 15 对比评测"), false);
  assert.equal(scanner.isEligibleWebpageText("Acme 上市了吗"), false);
});

test("excluded: hidden, editable and extension-ui nodes via info flags", () => {
  assert.equal(scanner.isEligibleWebpageText("visible text"), true);
  assert.equal(scanner.isEligibleWebpageText("hidden text", { hidden: true }), false);
  assert.equal(scanner.isEligibleWebpageText("editable text", { editable: true }), false);
  assert.equal(scanner.isEligibleWebpageText("plugin ui", { inExtensionUi: true }), false);
});

test("collectWebpageTextNodes requires a DOM tree walker (guard for non-browser env)", () => {
  assert.deepEqual(scanner.collectWebpageTextNodes(), []);
});
