import keys from "./term-discovery-keys.js";
import libraryCore from "./glossary-library.js";

const PENDING_STORAGE_KEY = "mt_glossary_pending_v1";
const MAX_CHAPTERS = 20;
const MAX_CANDIDATES_PER_CHAPTER = 200;
const MAX_CONTEXTS_PER_CANDIDATE = 3;
const MAX_EVIDENCE_IDS_PER_CANDIDATE = 30;
const MAX_PROCESSED_IDS_PER_CHAPTER = 500;

function normalizePendingStore(value) {
  const chapters = (value && Array.isArray(value.chapters) ? value.chapters : []).map(normalizeChapter).filter(Boolean).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_CHAPTERS);
  return {
    version: keys.SCHEMA_VERSION,
    updatedAt: Math.max(0, Number(value && value.updatedAt) || 0),
    chapters
  };
}

/** 章节记忆目标术语库：`libraryId` 为空表示网址未匹配任何库（界面按默认库处理）。 */
function normalizeChapter(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const url = keys.normalizeChapterUrl(value.url || value.key);
  const candidates = (Array.isArray(value.candidates) ? value.candidates : []).map(normalizePendingCandidate).filter(Boolean).slice(0, MAX_CANDIDATES_PER_CHAPTER);
  return {
    key: keys.getChapterKey(url),
    url,
    title: String(value.title || "").trim().slice(0, 200),
    libraryId: libraryCore.normalizeLibraryId(value.libraryId || value.library_id),
    libraryManual: value.libraryManual === true,
    updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    candidates,
    ignoredSourceKeys: keys.uniqueStrings(value.ignoredSourceKeys, 500),
    processedEvidenceIds: keys.uniqueStrings(value.processedEvidenceIds, MAX_PROCESSED_IDS_PER_CHAPTER)
  };
}

function normalizePendingCandidate(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = keys.normalizeSource(value.source);
  if (!source) {
    return null;
  }
  const suggestedTargets = keys.uniqueStrings(value.suggestedTargets, 5).map(item => String(item).trim().slice(0, 120)).filter(Boolean);
  return {
    source,
    sourceKey: keys.getSourceKey(source),
    kind: String(value.kind || "proper_noun").trim().slice(0, 40),
    score: keys.clampNumber(value.score, 0, 1, 0),
    occurrences: Math.max(0, Math.floor(Number(value.occurrences) || 0)),
    evidenceIds: keys.uniqueStrings(value.evidenceIds, MAX_EVIDENCE_IDS_PER_CANDIDATE),
    contexts: (Array.isArray(value.contexts) ? value.contexts : []).map(normalizeContext).filter(Boolean).slice(0, MAX_CONTEXTS_PER_CANDIDATE),
    note: String(value.note || "").trim().slice(0, 240),
    sentenceOnly: value.sentenceOnly === true,
    suggestedTargets,
    suggestedTarget: suggestedTargets.length === 1 ? suggestedTargets[0] : "",
    ambiguous: suggestedTargets.length > 1,
    updatedAt: Math.max(0, Number(value.updatedAt) || 0)
  };
}

function normalizeContext(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const evidenceId = String(value.evidenceId || "").trim().slice(0, 160);
  const originalText = String(value.originalText || "").trim().slice(0, 600);
  if (!evidenceId || !originalText) {
    return null;
  }
  return {
    evidenceId,
    originalText,
    translatedText: String(value.translatedText || "").trim().slice(0, 600)
  };
}

function normalizeBlocks(value, targetKey = "") {
  return (Array.isArray(value) ? value : []).map((block, index) => {
    const originalText = String(block && (block.originalText || block.original_text) || "").trim().slice(0, 600);
    if (!originalText) {
      return null;
    }
    const rawId = String(block && (block.id || block.blockId || block.block_id) || "").trim();
    const evidenceId = rawId || `e-${keys.hashString(`${targetKey}|${index}|${originalText}`)}`;
    return {
      id: evidenceId.slice(0, 160),
      originalText,
      translatedText: String(block && (block.translatedText || block.translated_text) || "").trim().slice(0, 600)
    };
  }).filter(Boolean).slice(0, 500);
}

function getUnprocessedBlocks(storeValue, pageUrl, blocksValue, targetKey = "") {
  const store = normalizePendingStore(storeValue);
  const chapterKey = keys.getChapterKey(pageUrl);
  const chapter = store.chapters.find(item => item.key === chapterKey);
  const processed = new Set(chapter ? chapter.processedEvidenceIds : []);
  return normalizeBlocks(blocksValue, targetKey).filter(block => !processed.has(block.id));
}

function getPendingCount(storeValue) {
  return normalizePendingStore(storeValue).chapters.reduce((total, chapter) => total + chapter.candidates.length, 0);
}

export default Object.freeze({
  PENDING_STORAGE_KEY,
  MAX_CHAPTERS,
  MAX_CANDIDATES_PER_CHAPTER,
  MAX_CONTEXTS_PER_CANDIDATE,
  MAX_EVIDENCE_IDS_PER_CANDIDATE,
  MAX_PROCESSED_IDS_PER_CHAPTER,
  normalizePendingStore,
  normalizeChapter,
  normalizePendingCandidate,
  normalizeBlocks,
  getUnprocessedBlocks,
  getPendingCount
});
