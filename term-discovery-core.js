(function initializeTermDiscovery(globalScope) {
  "use strict";

  const PENDING_STORAGE_KEY = "mt_glossary_pending_v1";
  const IGNORED_STORAGE_KEY = "mt_glossary_ignored_v1";
  const ENABLED_STORAGE_KEY = "mt_term_discovery_enabled";
  const SCHEMA_VERSION = 1;
  const MAX_CHAPTERS = 20;
  const MAX_CANDIDATES_PER_CHAPTER = 200;
  const MAX_CONTEXTS_PER_CANDIDATE = 3;
  const MAX_EVIDENCE_IDS_PER_CANDIDATE = 30;
  const MAX_PROCESSED_IDS_PER_CHAPTER = 500;

  function normalizeChapterUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "unknown-chapter";
    }
    try {
      const url = new URL(raw);
      url.hash = "";
      return url.href;
    } catch {
      return raw.replace(/#.*$/, "") || "unknown-chapter";
    }
  }

  function getChapterKey(value) {
    return normalizeChapterUrl(value);
  }

  function normalizeSource(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function getSourceKey(value) {
    return normalizeSource(value).toLocaleLowerCase("en-US");
  }

  function normalizePendingStore(value) {
    const chapters = (value && Array.isArray(value.chapters) ? value.chapters : [])
      .map(normalizeChapter)
      .filter(Boolean)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_CHAPTERS);
    return {
      version: SCHEMA_VERSION,
      updatedAt: Math.max(0, Number(value && value.updatedAt) || 0),
      chapters
    };
  }

  function normalizeChapter(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const url = normalizeChapterUrl(value.url || value.key);
    const candidates = (Array.isArray(value.candidates) ? value.candidates : [])
      .map(normalizePendingCandidate)
      .filter(Boolean)
      .slice(0, MAX_CANDIDATES_PER_CHAPTER);
    return {
      key: getChapterKey(url),
      url,
      title: String(value.title || "").trim().slice(0, 200),
      updatedAt: Math.max(0, Number(value.updatedAt) || 0),
      candidates,
      ignoredSourceKeys: uniqueStrings(value.ignoredSourceKeys, 500),
      processedEvidenceIds: uniqueStrings(value.processedEvidenceIds, MAX_PROCESSED_IDS_PER_CHAPTER)
    };
  }

  function normalizePendingCandidate(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const source = normalizeSource(value.source);
    if (!source) {
      return null;
    }
    const suggestedTargets = uniqueStrings(value.suggestedTargets, 5)
      .map((item) => String(item).trim().slice(0, 120))
      .filter(Boolean);
    return {
      source,
      sourceKey: getSourceKey(source),
      kind: String(value.kind || "proper_noun").trim().slice(0, 40),
      score: clampNumber(value.score, 0, 1, 0),
      occurrences: Math.max(0, Math.floor(Number(value.occurrences) || 0)),
      evidenceIds: uniqueStrings(value.evidenceIds, MAX_EVIDENCE_IDS_PER_CANDIDATE),
      contexts: (Array.isArray(value.contexts) ? value.contexts : [])
        .map(normalizeContext)
        .filter(Boolean)
        .slice(0, MAX_CONTEXTS_PER_CANDIDATE),
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

  function normalizeIgnoredStore(value) {
    const sources = (value && Array.isArray(value.sources) ? value.sources : [])
      .map((item) => {
        const source = normalizeSource(item && item.source);
        return source
          ? {
              source,
              sourceKey: getSourceKey(source),
              ignoredAt: Math.max(0, Number(item && item.ignoredAt) || 0)
            }
          : null;
      })
      .filter(Boolean);
    const deduped = new Map(sources.map((item) => [item.sourceKey, item]));
    return { version: SCHEMA_VERSION, sources: Array.from(deduped.values()) };
  }

  function normalizeBlocks(value, targetKey = "") {
    return (Array.isArray(value) ? value : [])
      .map((block, index) => {
        const originalText = String(block && (block.originalText || block.original_text) || "").trim().slice(0, 600);
        if (!originalText) {
          return null;
        }
        const rawId = String(block && (block.id || block.blockId || block.block_id) || "").trim();
        const evidenceId = rawId || `e-${hashString(`${targetKey}|${index}|${originalText}`)}`;
        return {
          id: evidenceId.slice(0, 160),
          originalText,
          translatedText: String(block && (block.translatedText || block.translated_text) || "").trim().slice(0, 600)
        };
      })
      .filter(Boolean)
      .slice(0, 200);
  }

  function getUnprocessedBlocks(storeValue, pageUrl, blocksValue, targetKey = "") {
    const store = normalizePendingStore(storeValue);
    const chapterKey = getChapterKey(pageUrl);
    const chapter = store.chapters.find((item) => item.key === chapterKey);
    const processed = new Set(chapter ? chapter.processedEvidenceIds : []);
    return normalizeBlocks(blocksValue, targetKey).filter((block) => !processed.has(block.id));
  }

  function mergeDiscoveryResult({
    store: storeValue,
    ignored: ignoredValue,
    glossary,
    pageUrl,
    pageTitle,
    targetKey,
    blocks: blocksValue,
    extractedCandidates,
    now = Date.now()
  }) {
    const store = normalizePendingStore(storeValue);
    const ignored = normalizeIgnoredStore(ignoredValue);
    const blocks = normalizeBlocks(blocksValue, targetKey);
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    const chapterKey = getChapterKey(pageUrl);
    let chapter = store.chapters.find((item) => item.key === chapterKey);
    if (!chapter) {
      chapter = normalizeChapter({ key: chapterKey, url: pageUrl, title: pageTitle, updatedAt: now });
      store.chapters.push(chapter);
    }
    chapter.title = String(pageTitle || chapter.title || "").trim().slice(0, 200);
    chapter.updatedAt = now;

    const glossaryKeys = new Set(
      (glossary && Array.isArray(glossary.entries) ? glossary.entries : [])
        .map((entry) => getSourceKey(entry && entry.source))
        .filter(Boolean)
    );
    const globallyIgnored = new Set(ignored.sources.map((item) => item.sourceKey));
    const chapterIgnored = new Set(chapter.ignoredSourceKeys);
    const candidateByKey = new Map(chapter.candidates.map((item) => [item.sourceKey, item]));

    for (const rawCandidate of Array.isArray(extractedCandidates) ? extractedCandidates : []) {
      const source = normalizeSource(rawCandidate && rawCandidate.source);
      const sourceKey = getSourceKey(source);
      if (!source || glossaryKeys.has(sourceKey) || globallyIgnored.has(sourceKey) || chapterIgnored.has(sourceKey)) {
        continue;
      }
      let candidate = candidateByKey.get(sourceKey);
      if (!candidate) {
        candidate = normalizePendingCandidate({
          source,
          kind: rawCandidate.kind,
          score: rawCandidate.score,
          updatedAt: now
        });
        chapter.candidates.push(candidate);
        candidateByKey.set(sourceKey, candidate);
      }
      candidate.score = Math.max(candidate.score, clampNumber(rawCandidate.score, 0, 1, 0));
      candidate.kind = String(rawCandidate.kind || candidate.kind).slice(0, 40);
      candidate.updatedAt = now;

      for (const evidenceId of uniqueStrings(rawCandidate.evidenceIds, MAX_EVIDENCE_IDS_PER_CANDIDATE)) {
        const block = blockById.get(evidenceId);
        if (!block || candidate.evidenceIds.includes(evidenceId)) {
          continue;
        }
        candidate.evidenceIds.push(evidenceId);
        candidate.evidenceIds = candidate.evidenceIds.slice(-MAX_EVIDENCE_IDS_PER_CANDIDATE);
        candidate.occurrences = candidate.evidenceIds.length;
        if (candidate.contexts.length < MAX_CONTEXTS_PER_CANDIDATE) {
          candidate.contexts.push({
            evidenceId,
            originalText: block.originalText,
            translatedText: block.translatedText
          });
        }
        if (
          getSourceKey(block.originalText) === sourceKey &&
          block.translatedText &&
          getSourceKey(block.translatedText) !== sourceKey &&
          !candidate.suggestedTargets.includes(block.translatedText)
        ) {
          candidate.suggestedTargets.push(block.translatedText.slice(0, 120));
          candidate.suggestedTargets = candidate.suggestedTargets.slice(0, 5);
        }
      }
      candidate.suggestedTarget = candidate.suggestedTargets.length === 1 ? candidate.suggestedTargets[0] : "";
      candidate.ambiguous = candidate.suggestedTargets.length > 1;
    }

    chapter.processedEvidenceIds = uniqueStrings(
      [...chapter.processedEvidenceIds, ...blocks.map((block) => block.id)],
      MAX_PROCESSED_IDS_PER_CHAPTER
    );
    chapter.candidates = chapter.candidates
      .filter((candidate) => !glossaryKeys.has(candidate.sourceKey))
      .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt)
      .slice(0, MAX_CANDIDATES_PER_CHAPTER);
    store.updatedAt = now;
    store.chapters = store.chapters
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_CHAPTERS);
    return normalizePendingStore(store);
  }

  function removeSourcesFromPending(storeValue, sources) {
    const keys = new Set((Array.isArray(sources) ? sources : []).map(getSourceKey).filter(Boolean));
    const store = normalizePendingStore(storeValue);
    for (const chapter of store.chapters) {
      chapter.candidates = chapter.candidates.filter((candidate) => !keys.has(candidate.sourceKey));
    }
    store.chapters = store.chapters.filter((chapter) => chapter.candidates.length > 0 || chapter.processedEvidenceIds.length > 0);
    store.updatedAt = Date.now();
    return store;
  }

  function ignoreCandidate({ store: storeValue, ignored: ignoredValue, chapterKey, source, scope, now = Date.now() }) {
    const store = normalizePendingStore(storeValue);
    const ignored = normalizeIgnoredStore(ignoredValue);
    const sourceKey = getSourceKey(source);
    if (!sourceKey) {
      return { store, ignored };
    }
    if (scope === "global") {
      ignored.sources = normalizeIgnoredStore({
        sources: [...ignored.sources, { source: normalizeSource(source), ignoredAt: now }]
      }).sources;
      for (const chapter of store.chapters) {
        chapter.candidates = chapter.candidates.filter((candidate) => candidate.sourceKey !== sourceKey);
      }
    } else {
      const chapter = store.chapters.find((item) => item.key === chapterKey);
      if (chapter) {
        chapter.ignoredSourceKeys = uniqueStrings([...chapter.ignoredSourceKeys, sourceKey], 500);
        chapter.candidates = chapter.candidates.filter((candidate) => candidate.sourceKey !== sourceKey);
      }
    }
    store.updatedAt = now;
    return { store, ignored };
  }

  function restoreIgnoredSource(ignoredValue, source) {
    const ignored = normalizeIgnoredStore(ignoredValue);
    const sourceKey = getSourceKey(source);
    ignored.sources = ignored.sources.filter((item) => item.sourceKey !== sourceKey);
    return ignored;
  }

  function getPendingCount(storeValue) {
    return normalizePendingStore(storeValue).chapters.reduce(
      (total, chapter) => total + chapter.candidates.length,
      0
    );
  }

  function getSuggestedTargetForSource(sourceValue, contextsValue) {
    const sourceKey = getSourceKey(sourceValue);
    if (!sourceKey) {
      return "";
    }
    const targets = uniqueStrings(
      (Array.isArray(contextsValue) ? contextsValue : [])
        .filter((context) => getSourceKey(context && context.originalText) === sourceKey)
        .map((context) => String(context && context.translatedText || "").trim())
        .filter((target) => target && getSourceKey(target) !== sourceKey),
      5
    );
    return targets.length === 1 ? targets[0].slice(0, 120) : "";
  }

  function uniqueStrings(value, limit) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(value) ? value : []) {
      const text = String(item || "").trim();
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      result.push(text);
    }
    return result.slice(Math.max(0, result.length - limit));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function hashString(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  globalScope.MangaTermDiscovery = Object.freeze({
    PENDING_STORAGE_KEY,
    IGNORED_STORAGE_KEY,
    ENABLED_STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_CHAPTERS,
    MAX_CANDIDATES_PER_CHAPTER,
    normalizeChapterUrl,
    getChapterKey,
    normalizeSource,
    getSourceKey,
    normalizePendingStore,
    normalizeIgnoredStore,
    normalizeBlocks,
    getUnprocessedBlocks,
    mergeDiscoveryResult,
    removeSourcesFromPending,
    ignoreCandidate,
    restoreIgnoredSource,
    getPendingCount,
    getSuggestedTargetForSource
  });
})(globalThis);
