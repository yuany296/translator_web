import assert from "node:assert/strict";
import test from "node:test";
import core from "../extension/src/shared/novel-term-discovery.js";

function makeChapter(paragraphCount) {
  return {
    scopeKey: "kakao:65171279",
    chapterId: "70081892",
    seriesTitle: "달의 끝에서",
    paragraphs: Array.from({ length: paragraphCount }, (_, index) => ({
      id: `p${index}`,
      paragraphKey: `hash-p${index}`,
      index,
      kind: index === 0 ? "title" : "paragraph",
      original_text: `원문 ${index}`
    }))
  };
}

test("sampleTranslatedParagraphs returns all translated blocks when under the cap", () => {
  const chapter = makeChapter(3);
  const translations = new Map([
    ["p0", "月之尽头"],
    ["p1", "译文 1"],
    ["p2", "译文 2"]
  ]);
  const blocks = core.sampleTranslatedParagraphs(chapter, translations);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].id, "hash-p0");
  assert.deepEqual(blocks[0], {
    id: "hash-p0",
    originalText: "원문 0",
    translatedText: "月之尽头"
  });
});

test("sampleTranslatedParagraphs skips paragraphs without translations or empty text", () => {
  const chapter = makeChapter(4);
  const translations = new Map([
    ["p0", "月之尽头"],
    ["p2", ""]
  ]);
  const blocks = core.sampleTranslatedParagraphs(chapter, translations);

  assert.deepEqual(Array.from(blocks, block => block.id), ["hash-p0"]);
});

test("sampleTranslatedParagraphs evenly samples a long chapter and always keeps the first block", () => {
  const chapter = makeChapter(100);
  const translations = new Map(chapter.paragraphs.map(item => [item.id, `译文 ${item.index}`]));
  const blocks = core.sampleTranslatedParagraphs(chapter, translations);

  assert.equal(blocks.length, 60);
  assert.equal(blocks[0].id, "hash-p0");
  const ids = Array.from(blocks, block => block.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids[ids.length - 1].endsWith("-p98"));
});

test("sampleTranslatedParagraphs guards invalid maxBlocks and non-Map translations", () => {
  const chapter = makeChapter(2);
  const blocks = core.sampleTranslatedParagraphs(chapter, null, 0);
  assert.deepEqual(blocks, []);
  const fallback = core.sampleTranslatedParagraphs(chapter, new Map([["p0", "译文 0"]]));
  assert.equal(fallback.length, 1);
});

test("buildNovelDiscoveryMessage carries the novel target key and auto-ignore series title", () => {
  const chapter = makeChapter(2);
  const blocks = [{ id: "hash-p0", originalText: "원문 0", translatedText: "月之尽头" }];
  const message = core.buildNovelDiscoveryMessage(chapter, blocks, "https://page.kakao.com/content/65171279/viewer/70081892", "달의 끝에서 12화");

  assert.equal(message.type, "DISCOVER_TERMS");
  assert.equal(message.targetKey, "novel-kakao:65171279:70081892");
  assert.deepEqual(message.autoIgnoreSources, ["달의 끝에서"]);
  assert.equal(message.blocks, blocks);
  assert.equal(message.pageUrl, "https://page.kakao.com/content/65171279/viewer/70081892");
});

test("buildNovelDiscoveryMessage omits auto-ignore sources when series title is empty", () => {
  const message = core.buildNovelDiscoveryMessage({ scopeKey: "kakao:1", chapterId: "2" }, [], "https://example.test/c", "第 1 话");

  assert.deepEqual(message.autoIgnoreSources, []);
  assert.equal(message.targetKey, "novel-kakao:1:2");
});
