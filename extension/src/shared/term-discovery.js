import keys from "./term-discovery-keys.js";
import pendingCore from "./term-discovery-pending.js";
import ignoredCore from "./term-discovery-ignored.js";
import libraryCore from "./glossary-library.js";

const KOREAN_JOSA_RE = /[은는이가을를의에와]$/;

function textContainsSource(text, source) {
  const fold = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("en-US");
  const haystack = fold(text);
  const needle = fold(source);
  const stripped = needle.replace(KOREAN_JOSA_RE, "");
  return Boolean(needle) && (haystack.includes(needle) || (stripped.length >= 2 && haystack.includes(stripped)));
}

/**
 * 把一次提取结果并入待确认仓库。`libraryId` 是本次页面网址匹配到的术语库
 * （未匹配时为空），只在新建章节或用户尚未手动指定归属时写入章节。
 */
function mergeDiscoveryResult({
  store: storeValue,
  ignored: ignoredValue,
  glossary,
  pageUrl,
  pageTitle,
  targetKey,
  blocks: blocksValue,
  extractedCandidates,
  libraryId: libraryIdValue,
  now = Date.now()
}) {
  const store = pendingCore.normalizePendingStore(storeValue);
  const ignored = ignoredCore.normalizeIgnoredStore(ignoredValue);
  const libraryId = libraryCore.normalizeLibraryId(libraryIdValue);
  const blocks = pendingCore.normalizeBlocks(blocksValue, targetKey);
  const blockById = new Map(blocks.map(block => [block.id, block]));
  const chapterKey = keys.getChapterKey(pageUrl);
  let chapter = store.chapters.find(item => item.key === chapterKey);
  if (!chapter) {
    chapter = pendingCore.normalizeChapter({
      key: chapterKey,
      url: pageUrl,
      title: pageTitle,
      libraryId,
      updatedAt: now
    });
    store.chapters.push(chapter);
  } else if (!chapter.libraryManual) {
    chapter.libraryId = libraryId;
  }
  chapter.title = String(pageTitle || chapter.title || "").trim().slice(0, 200);
  chapter.updatedAt = now;
  const glossaryKeys = new Set((glossary && Array.isArray(glossary.entries) ? glossary.entries : []).map(entry => keys.getSourceKey(entry && entry.source)).filter(Boolean));
  const globallyIgnored = new Set(ignored.sources.map(item => item.sourceKey));
  const chapterIgnored = new Set(chapter.ignoredSourceKeys);
  const candidateByKey = new Map(chapter.candidates.map(item => [item.sourceKey, item]));
  const blockTexts = blocks.map(block => block.originalText);
  const sourceInBlocks = term => blockTexts.some(text => textContainsSource(text, term));
  for (const rawCandidate of Array.isArray(extractedCandidates) ? extractedCandidates : []) {
    let source = keys.normalizeSource(rawCandidate && rawCandidate.source);
    let suggestedTarget = String(rawCandidate && rawCandidate.suggestedTarget || "").trim().slice(0, 120);
    // 提取器可能把「译文：」行的中文当成 source（或 source/suggestedTarget 填反）：交换修正，不在原文则丢弃。
    if (source && !sourceInBlocks(source) && suggestedTarget && sourceInBlocks(suggestedTarget)) {
      [source, suggestedTarget] = [suggestedTarget, source];
    }
    const sourceKey = keys.getSourceKey(source);
    if (!source || !sourceInBlocks(source) || glossaryKeys.has(sourceKey) || globallyIgnored.has(sourceKey) || chapterIgnored.has(sourceKey)) {
      continue;
    }
    let candidate = candidateByKey.get(sourceKey);
    if (!candidate) {
      candidate = pendingCore.normalizePendingCandidate({
        source,
        kind: rawCandidate.kind,
        score: rawCandidate.score,
        note: rawCandidate.note,
        sentenceOnly: rawCandidate.sentenceOnly,
        suggestedTargets: suggestedTarget ? [suggestedTarget] : [],
        updatedAt: now
      });
      chapter.candidates.push(candidate);
      candidateByKey.set(sourceKey, candidate);
    }
    candidate.score = Math.max(candidate.score, keys.clampNumber(rawCandidate.score, 0, 1, 0));
    candidate.kind = String(rawCandidate.kind || candidate.kind).slice(0, 40);
    candidate.updatedAt = now;
    if (rawCandidate.sentenceOnly === true) {
      candidate.sentenceOnly = true;
    }
    if (String(rawCandidate.note || "").trim() && !String(candidate.note || "").trim()) {
      candidate.note = String(rawCandidate.note).trim().slice(0, 240);
    }
    if (suggestedTarget && !candidate.suggestedTargets.includes(suggestedTarget)) {
      candidate.suggestedTargets.push(suggestedTarget);
      candidate.suggestedTargets = candidate.suggestedTargets.slice(0, 5);
    }
    candidate.suggestedTarget = candidate.suggestedTargets.length === 1 ? candidate.suggestedTargets[0] : "";
    candidate.ambiguous = candidate.suggestedTargets.length > 1;
    for (const evidenceId of keys.uniqueStrings(rawCandidate.evidenceIds, pendingCore.MAX_EVIDENCE_IDS_PER_CANDIDATE)) {
      const block = blockById.get(evidenceId);
      if (!block || candidate.evidenceIds.includes(evidenceId)) {
        continue;
      }
      candidate.evidenceIds.push(evidenceId);
      candidate.evidenceIds = candidate.evidenceIds.slice(-pendingCore.MAX_EVIDENCE_IDS_PER_CANDIDATE);
      candidate.occurrences = candidate.evidenceIds.length;
      if (candidate.contexts.length < pendingCore.MAX_CONTEXTS_PER_CANDIDATE) {
        candidate.contexts.push({
          evidenceId,
          originalText: block.originalText,
          translatedText: block.translatedText
        });
      }
      if (keys.getSourceKey(block.originalText) === sourceKey && block.translatedText && keys.getSourceKey(block.translatedText) !== sourceKey && !candidate.suggestedTargets.includes(block.translatedText)) {
        candidate.suggestedTargets.push(block.translatedText.slice(0, 120));
        candidate.suggestedTargets = candidate.suggestedTargets.slice(0, 5);
      }
    }
    candidate.suggestedTarget = candidate.suggestedTargets.length === 1 ? candidate.suggestedTargets[0] : "";
    candidate.ambiguous = candidate.suggestedTargets.length > 1;
  }
  chapter.processedEvidenceIds = keys.uniqueStrings([...chapter.processedEvidenceIds, ...blocks.map(block => block.id)], pendingCore.MAX_PROCESSED_IDS_PER_CHAPTER);
  chapter.candidates = chapter.candidates.filter(candidate => !glossaryKeys.has(candidate.sourceKey)).sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt).slice(0, pendingCore.MAX_CANDIDATES_PER_CHAPTER);
  store.updatedAt = now;
  store.chapters = store.chapters.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, pendingCore.MAX_CHAPTERS);
  return pendingCore.normalizePendingStore(store);
}

function removeSourcesFromPending(storeValue, sources) {
  const sourceKeys = new Set((Array.isArray(sources) ? sources : []).map(keys.getSourceKey).filter(Boolean));
  const store = pendingCore.normalizePendingStore(storeValue);
  for (const chapter of store.chapters) {
    chapter.candidates = chapter.candidates.filter(candidate => !sourceKeys.has(candidate.sourceKey));
  }
  store.chapters = store.chapters.filter(chapter => chapter.candidates.length > 0 || chapter.processedEvidenceIds.length > 0);
  store.updatedAt = Date.now();
  return store;
}

function getSuggestedTargetForSource(sourceValue, contextsValue) {
  const sourceKey = keys.getSourceKey(sourceValue);
  if (!sourceKey) {
    return "";
  }
  const targets = keys.uniqueStrings((Array.isArray(contextsValue) ? contextsValue : []).filter(context => keys.getSourceKey(context && context.originalText) === sourceKey).map(context => String(context && context.translatedText || "").trim()).filter(target => target && keys.getSourceKey(target) !== sourceKey), 5);
  return targets.length === 1 ? targets[0].slice(0, 120) : "";
}

export default Object.freeze({
  PENDING_STORAGE_KEY: pendingCore.PENDING_STORAGE_KEY,
  IGNORED_STORAGE_KEY: ignoredCore.IGNORED_STORAGE_KEY,
  SCHEMA_VERSION: keys.SCHEMA_VERSION,
  MAX_CHAPTERS: pendingCore.MAX_CHAPTERS,
  MAX_CANDIDATES_PER_CHAPTER: pendingCore.MAX_CANDIDATES_PER_CHAPTER,
  normalizeChapterUrl: keys.normalizeChapterUrl,
  getChapterKey: keys.getChapterKey,
  normalizeSource: keys.normalizeSource,
  getSourceKey: keys.getSourceKey,
  normalizePendingStore: pendingCore.normalizePendingStore,
  normalizeChapter: pendingCore.normalizeChapter,
  normalizeIgnoredStore: ignoredCore.normalizeIgnoredStore,
  normalizeBlocks: pendingCore.normalizeBlocks,
  getUnprocessedBlocks: pendingCore.getUnprocessedBlocks,
  textContainsSource,
  mergeDiscoveryResult,
  removeSourcesFromPending,
  ignoreCandidate: ignoredCore.ignoreCandidate,
  ignoreCandidates: ignoredCore.ignoreCandidates,
  restoreIgnoredSource: ignoredCore.restoreIgnoredSource,
  getPendingCount: pendingCore.getPendingCount,
  getSuggestedTargetForSource
});
