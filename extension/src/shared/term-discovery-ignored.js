import keys from "./term-discovery-keys.js";
import pendingCore from "./term-discovery-pending.js";

const IGNORED_STORAGE_KEY = "mt_glossary_ignored_v1";

function normalizeIgnoredStore(value) {
  const sources = (value && Array.isArray(value.sources) ? value.sources : []).map(item => {
    const source = keys.normalizeSource(item && item.source);
    return source ? {
      source,
      sourceKey: keys.getSourceKey(source),
      ignoredAt: Math.max(0, Number(item && item.ignoredAt) || 0)
    } : null;
  }).filter(Boolean);
  const deduped = new Map(sources.map(item => [item.sourceKey, item]));
  return {
    version: keys.SCHEMA_VERSION,
    sources: Array.from(deduped.values())
  };
}

function ignoreCandidate({
  store: storeValue,
  ignored: ignoredValue,
  chapterKey,
  source,
  scope,
  now = Date.now()
}) {
  const store = pendingCore.normalizePendingStore(storeValue);
  const ignored = normalizeIgnoredStore(ignoredValue);
  const sourceKey = keys.getSourceKey(source);
  if (!sourceKey) {
    return {
      store,
      ignored
    };
  }
  if (scope === "global") {
    ignored.sources = normalizeIgnoredStore({
      sources: [...ignored.sources, {
        source: keys.normalizeSource(source),
        ignoredAt: now
      }]
    }).sources;
    for (const chapter of store.chapters) {
      chapter.candidates = chapter.candidates.filter(candidate => candidate.sourceKey !== sourceKey);
    }
  } else {
    const chapter = store.chapters.find(item => item.key === chapterKey);
    if (chapter) {
      chapter.ignoredSourceKeys = keys.uniqueStrings([...chapter.ignoredSourceKeys, sourceKey], 500);
      chapter.candidates = chapter.candidates.filter(candidate => candidate.sourceKey !== sourceKey);
    }
  }
  store.updatedAt = now;
  return {
    store,
    ignored
  };
}

function ignoreCandidates({
  store: storeValue,
  ignored: ignoredValue,
  entries,
  scope,
  now = Date.now()
}) {
  let store = pendingCore.normalizePendingStore(storeValue);
  let ignored = normalizeIgnoredStore(ignoredValue);
  let removed = 0;
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const source = keys.normalizeSource(entry && entry.source);
    const sourceKey = keys.getSourceKey(source);
    if (!sourceKey || seen.has(sourceKey)) {
      continue;
    }
    seen.add(sourceKey);
    const chapterKey = String(entry && entry.chapterKey || "");
    const before = pendingCore.getPendingCount(store);
    const next = ignoreCandidate({
      store,
      ignored,
      chapterKey,
      source,
      scope,
      now
    });
    store = next.store;
    ignored = next.ignored;
    removed += before - pendingCore.getPendingCount(store);
  }
  return {
    store,
    ignored,
    removed
  };
}

function restoreIgnoredSource(ignoredValue, source) {
  const ignored = normalizeIgnoredStore(ignoredValue);
  const sourceKey = keys.getSourceKey(source);
  ignored.sources = ignored.sources.filter(item => item.sourceKey !== sourceKey);
  return ignored;
}

export default Object.freeze({
  IGNORED_STORAGE_KEY,
  normalizeIgnoredStore,
  ignoreCandidate,
  ignoreCandidates,
  restoreIgnoredSource
});
