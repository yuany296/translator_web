import assert from "node:assert/strict";
import test from "node:test";
import core from "../extension/src/shared/term-discovery.js";

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

test("editing a partial candidate to the full context source reveals its unique translation", () => {
  const contexts = [
    { evidenceId: "a", originalText: "김솔음", translatedText: "金索音" },
    { evidenceId: "b", originalText: "다른 문장", translatedText: "其他句子" }
  ];

  assert.equal(core.getSuggestedTargetForSource("김솔", contexts), "");
  assert.equal(core.getSuggestedTargetForSource(" 김솔음 ", contexts), "金索音");
  assert.equal(
    core.getSuggestedTargetForSource("김솔음", [...contexts, { evidenceId: "c", originalText: "김솔음", translatedText: "金率音" }]),
    ""
  );
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

test("ignoreCandidates chapter scope clears only the target chapter without writing ignored", () => {
  const discovered = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/4",
    blocks: [{ id: "a", originalText: "소설 제목", translatedText: "小说标题" }],
    extractedCandidates: [{ source: "소설 제목", kind: "title", score: 0.9, evidenceIds: ["a"] }]
  });
  const otherChapter = core.mergeDiscoveryResult({
    store: discovered,
    pageUrl: "https://example.com/chapter/5",
    blocks: [{ id: "b", originalText: "작가 이름", translatedText: "作者名" }],
    extractedCandidates: [{ source: "작가 이름", kind: "person", score: 0.94, evidenceIds: ["b"] }]
  });
  const chapterKey = otherChapter.chapters.find(item => item.key === "https://example.com/chapter/4").key;
  const otherKey = otherChapter.chapters.find(item => item.key === "https://example.com/chapter/5").key;
  const result = core.ignoreCandidates({
    store: otherChapter,
    entries: [
      { chapterKey, source: "소설 제목" },
      { chapterKey: otherKey, source: "작가 이름" }
    ],
    scope: "chapter"
  });

  assert.equal(result.removed, 2);
  assert.equal(core.getPendingCount(result.store), 0);
  assert.equal(result.ignored.sources.length, 0);
  const chapter = result.store.chapters.find(item => item.key === chapterKey);
  const other = result.store.chapters.find(item => item.key === otherKey);
  assert.deepEqual(chapter.ignoredSourceKeys, ["소설 제목"]);
  assert.deepEqual(other.ignoredSourceKeys, ["작가 이름"]);
});

test("ignoreCandidates global scope clears every chapter and records ignored sources deduped", () => {
  const discovered = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/6",
    blocks: [{ id: "a", originalText: "BOOK TITLE", translatedText: "BOOK TITLE" }],
    extractedCandidates: [{ source: "BOOK TITLE", kind: "latin_title", score: 0.9, evidenceIds: ["a"] }]
  });
  const withSecond = core.mergeDiscoveryResult({
    store: discovered,
    pageUrl: "https://example.com/chapter/7",
    blocks: [{ id: "b", originalText: "AUTHOR NAME", translatedText: "AUTHOR NAME" }],
    extractedCandidates: [{ source: "AUTHOR NAME", kind: "latin_name", score: 0.82, evidenceIds: ["b"] }]
  });
  const result = core.ignoreCandidates({
    store: withSecond,
    entries: [
      { chapterKey: "", source: "BOOK TITLE" },
      { chapterKey: "", source: "author name" },
      { chapterKey: "", source: "BOOK TITLE" },
      { chapterKey: "", source: "" }
    ],
    scope: "global"
  });

  assert.equal(result.removed, 2);
  assert.equal(core.getPendingCount(result.store), 0);
  // ignored 记录保留传入拼写，按 sourceKey 去重（大小写不敏感）
  assert.deepEqual(Array.from(result.ignored.sources, item => item.sourceKey).sort(), ["author name", "book title"].sort());
});

test("discovery drops sources taken from translated text and swaps reversed source/target", () => {
  const store = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/8",
    targetKey: "image-1",
    blocks: [
      { id: "a", originalText: "정다준이 말했다.", translatedText: "郑多俊说道。" },
      { id: "b", originalText: "김성현이 웃었다.", translatedText: "金成贤笑了。" }
    ],
    extractedCandidates: [
      // 模型从译文行抓词：source 是中文译文 —— 必须丢弃，不能进入待确认区
      { source: "郑多俊", kind: "person", score: 0.9, suggestedTarget: "郑多俊", evidenceIds: ["a"] },
      // source/suggestedTarget 填反：交换后按原文收录
      { source: "金成贤", kind: "person", score: 0.9, suggestedTarget: "김성현", evidenceIds: ["b"] }
    ]
  });
  const candidates = store.chapters[0].candidates;

  assert.deepEqual(Array.from(candidates, (item) => item.source), ["김성현"]);
  assert.equal(candidates[0].suggestedTarget, "金成贤");
  assert.equal(candidates[0].suggestedTargets.includes("김성현"), false);
});

test("textContainsSource tolerates whitespace, case and a trailing josa", () => {
  assert.equal(core.textContainsSource("정다준이 말했다.", "정다준"), true);
  assert.equal(core.textContainsSource("정다준이 말했다.", "정다준이"), true);
  assert.equal(core.textContainsSource("THE DAWN 무대", "the dawn"), true);
  assert.equal(core.textContainsSource("김성현", "즈"), false);
  assert.equal(core.textContainsSource("정다준이 말했다.", "郑多俊"), false);
  assert.equal(core.textContainsSource("다 준 이 말", "다준"), true);
});

test("discovery stamps the URL-matched library on the chapter and keeps manual choices", () => {
  const first = core.mergeDiscoveryResult({
    pageUrl: "https://page.kakao.com/content/69299983/viewer/1",
    libraryId: "kakao-novel",
    blocks: [{ id: "a", originalText: "성현이 말했다", translatedText: "成贤说道" }],
    extractedCandidates: [{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["a"] }]
  });
  assert.equal(first.chapters[0].libraryId, "kakao-novel");
  assert.equal(first.chapters[0].libraryManual, false);

  // 网址重新匹配（例如用户改了绑定）会更新自动归属
  const rematched = core.mergeDiscoveryResult({
    store: first,
    pageUrl: "https://page.kakao.com/content/69299983/viewer/1",
    libraryId: "other-library",
    blocks: [{ id: "b", originalText: "왕국이 무너졌다", translatedText: "王国崩塌了" }],
    extractedCandidates: [{ source: "왕국", kind: "proper_noun", score: 0.8, evidenceIds: ["b"] }]
  });
  assert.equal(rematched.chapters[0].libraryId, "other-library");

  // 用户在界面上手动指定过归属后，后续重新匹配不得覆盖
  const manual = core.normalizePendingStore({
    chapters: [{ ...rematched.chapters[0], libraryId: "manual-choice", libraryManual: true }]
  });
  const kept = core.mergeDiscoveryResult({
    store: manual,
    pageUrl: "https://page.kakao.com/content/69299983/viewer/1",
    libraryId: "auto-library",
    blocks: [{ id: "c", originalText: "마법을 쓰다", translatedText: "使用魔法" }],
    extractedCandidates: [{ source: "마법", kind: "proper_noun", score: 0.8, evidenceIds: ["c"] }]
  });
  assert.equal(kept.chapters[0].libraryId, "manual-choice");
  assert.equal(kept.chapters[0].libraryManual, true);
});

test("chapters without a matched library keep an empty libraryId", () => {
  const store = core.mergeDiscoveryResult({
    pageUrl: "https://example.com/chapter/9",
    blocks: [{ id: "a", originalText: "성현이 말했다", translatedText: "成贤说道" }],
    extractedCandidates: [{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["a"] }]
  });
  assert.equal(store.chapters[0].libraryId, "");
  assert.equal(store.chapters[0].libraryManual, false);
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
