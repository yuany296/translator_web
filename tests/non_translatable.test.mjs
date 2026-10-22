import assert from "node:assert/strict";
import test from "node:test";
import nonTranslatable from "../extension/src/shared/non-translatable.js";

const isNonTranslatableText = nonTranslatable.isNonTranslatableText;

test("non-translatable: pure quantities, clocks, dates, codes pass through untranslated", () => {
  const nonTranslatable = [
    "", "   ",
    "123", "1,000", "50%", "3.5", "№5", "１２３",
    "12:34", "2024.5.1",
    "https://example.com/a?b=1", "www.example.com", "a@b.com",
    "!?", "……", "——", "「」", "?!……", "😂",
    "R-18", "Vol.3", "ABC123", "Pt.2",
    "A", "I", "ａ"
  ];
  for (const text of nonTranslatable) {
    assert.equal(isNonTranslatableText(text), true, `expected non-translatable: ${JSON.stringify(text)}`);
  }
});

test("non-translatable: real words and all CJK/kana/hangul stay translatable", () => {
  const translatable = [
    "What?", "OK", "Stop!", "hello world", "annyeong",
    "Level 5!", "Chapter 12", "iPhone 15", "404 Not Found",
    "ゴゴゴゴ", "え", "ま", "全部潰してこい", "3人", "50点!",
    "그", "15분", "응?", "A와 B", "翻訳する"
  ];
  for (const text of translatable) {
    assert.equal(isNonTranslatableText(text), false, `expected translatable: ${JSON.stringify(text)}`);
  }
});
