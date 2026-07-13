import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "term-discovery-core.js"), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(`${source}\nglobalThis.__termDiscoveryTest = MangaTermDiscovery;`, context);
const core = context.__termDiscoveryTest;

test("chapter identity removes hash but keeps query parameters", () => {
  assert.equal(
    core.normalizeChapterUrl("https://example.com/viewer/3?episode=9#page-4"),
    "https://example.com/viewer/3?episode=9"
  );
});

test("discovery keeps full and short names separate and skips existing glossary terms", () => {
  const store = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/1",
    pageTitle: "第 1 话",
    targetKey: "image-1",
    blocks: [
      { id: "full", originalText: "김성현", translatedText: "金成贤" },
      { id: "short", originalText: "성현", translatedText: "成贤" },
      { id: "known", originalText: "서호윤", translatedText: "徐昊允" }
    ],
    extractedCandidates: [
      { source: "김성현", kind: "person", score: 0.94, evidenceIds: ["full"] },
      { source: "성현", kind: "proper_noun", score: 0.9, evidenceIds: ["short"] },
      { source: "서호윤", kind: "person", score: 0.94, evidenceIds: ["known"] }
    ],
    glossary: { entries: [{ source: "서호윤", target: "徐昊允", enabled: true }] }
  });
  const candidates = store.chapters[0].candidates;

  assert.deepEqual(Array.from(candidates, (item) => item.source).sort(), ["김성현", "성현"].sort());
  assert.equal(candidates.find((item) => item.source === "성현").suggestedTarget, "成贤");
});

test("repeated evidence is deduped and conflicting exact-block translations are marked ambiguous", () => {
  const first = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/2",
    targetKey: "image-1",
    blocks: [{ id: "a", originalText: "세진", translatedText: "世镇" }],
    extractedCandidates: [{ source: "세진", kind: "proper_noun", score: 0.9, evidenceIds: ["a"] }]
  });
  const repeated = core.mergeDiscoveryResult({
    store: first,
    pageUrl: "https://example.com/chapter/2",
    targetKey: "image-1",
    blocks: [{ id: "a", originalText: "세진", translatedText: "世镇" }],
    extractedCandidates: [{ source: "세진", kind: "proper_noun", score: 0.9, evidenceIds: ["a"] }]
  });
  const conflicted = core.mergeDiscoveryResult({
    store: repeated,
    pageUrl: "https://example.com/chapter/2",
    targetKey: "image-2",
    blocks: [{ id: "b", originalText: "세진", translatedText: "世振" }],
    extractedCandidates: [{ source: "세진", kind: "proper_noun", score: 0.9, evidenceIds: ["b"] }]
  });
  const candidate = conflicted.chapters[0].candidates[0];

  assert.equal(candidate.occurrences, 2);
  assert.equal(candidate.ambiguous, true);
  assert.equal(candidate.suggestedTarget, "");
});

test("chapter and global ignore scopes remove candidates and global ignore can be restored", () => {
  const discovered = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/3",
    blocks: [{ id: "a", originalText: "THE DAWN", translatedText: "THE DAWN" }],
    extractedCandidates: [{ source: "THE DAWN", kind: "latin_title", score: 0.9, evidenceIds: ["a"] }]
  });
  const ignored = core.ignoreCandidate({
    store: discovered,
    chapterKey: discovered.chapters[0].key,
    source: "THE DAWN",
    scope: "global"
  });

  assert.equal(core.getPendingCount(ignored.store), 0);
  assert.equal(ignored.ignored.sources.length, 1);
  assert.equal(core.restoreIgnoredSource(ignored.ignored, "the dawn").sources.length, 0);
});

test("pending storage keeps only the newest 20 chapters and 200 candidates per chapter", () => {
  const chapters = Array.from({ length: 25 }, (_, chapterIndex) => ({
    key: `https://example.com/chapter/${chapterIndex}`,
    url: `https://example.com/chapter/${chapterIndex}`,
    updatedAt: chapterIndex,
    candidates: Array.from({ length: 220 }, (_, candidateIndex) => ({
      source: `TERM-${chapterIndex}-${candidateIndex}`,
      kind: "latin_name",
      score: 0.8,
      contexts: Array.from({ length: 5 }, (_, contextIndex) => ({
        evidenceId: `e-${contextIndex}`,
        originalText: `TERM-${chapterIndex}-${candidateIndex}`
      }))
    }))
  }));

  const normalized = core.normalizePendingStore({ chapters });

  assert.equal(normalized.chapters.length, 20);
  assert.equal(normalized.chapters[0].key, "https://example.com/chapter/24");
  assert.equal(normalized.chapters[0].candidates.length, 200);
  assert.equal(normalized.chapters[0].candidates[0].contexts.length, 3);
});
