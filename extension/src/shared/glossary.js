const STORAGE_KEY = "mt_glossary_v2";
const LEGACY_STORAGE_KEY = "mt_glossary_v1";
const SCHEMA_VERSION = 2;
const MAX_ENTRIES = 500;
const MAX_SOURCE_LENGTH = 120;
const MAX_TARGET_LENGTH = 120;
const MAX_NOTE_LENGTH = 240;
const HANGUL_SYLLABLE_RE = /[\uac00-\ud7af]/u;
const HANGUL_TERM_RE = /^[\uac00-\ud7af]+$/u;
const HANGUL_PARTICLE_RE = /^(?:이|가|은|는|을|를|의|에|에서|에게|한테|께|으로|로|와|과|도|만|부터|까지|마다|보다|처럼|이나|나|이라도|라도|밖에|조차|마저|커녕|이고|이며|이랑|랑|이라고|라고|이면|면|이다|이었다|였다|이야|야)?$/u;
function normalizeGlossary(value) {
  const rawEntries = value && Array.isArray(value.entries) ? value.entries : Array.isArray(value) ? value : [];
  const seenSources = new Set();
  const entries = [];
  for (let index = 0; index < rawEntries.length && entries.length < MAX_ENTRIES; index += 1) {
    const entry = normalizeGlossaryEntry(rawEntries[index], index);
    if (!entry) {
      continue;
    }
    const dedupeKey = `${entry.scope}\u0000${entry.scopeKey}\u0000${entry.source}`;
    if (seenSources.has(dedupeKey)) {
      continue;
    }
    seenSources.add(dedupeKey);
    entries.push(entry);
  }
  return {
    version: SCHEMA_VERSION,
    revision: Math.max(0, Math.floor(Number(value && value.revision) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(value && value.updatedAt) || 0)),
    entries
  };
}
function normalizeGlossaryEntry(value, index = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = normalizeField(value.source, MAX_SOURCE_LENGTH);
  const target = normalizeField(value.target, MAX_TARGET_LENGTH);
  if (!source || !target) {
    return null;
  }
  const scopeKey = normalizeScopeKey(value.scopeKey);
  const scope = value.scope === "series" && scopeKey ? "series" : "global";
  const fallbackId = `term-${index}-${hashString(`${scope}\u0000${scopeKey}\u0000${source}\u0000${target}`)}`;
  return {
    id: normalizeIdentifier(value.id) || fallbackId,
    source,
    target,
    note: normalizeField(value.note, MAX_NOTE_LENGTH),
    enabled: value.enabled !== false,
    scope,
    scopeKey: scope === "series" ? scopeKey : "",
    scopeLabel: scope === "series" ? normalizeField(value.scopeLabel, MAX_NOTE_LENGTH) : ""
  };
}
function normalizeField(value, maxLength) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, maxLength);
}
function normalizeIdentifier(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}
function normalizeScopeKey(value) {
  return String(value || "").trim().replace(/[^\w:.-]/gu, "").slice(0, 160);
}
function getEnabledEntries(value, context = null) {
  const scopeKey = normalizeScopeKey(context && context.scopeKey);
  const entries = normalizeGlossary(value).entries.filter(entry => entry.enabled && (
    entry.scope === "global" || scopeKey && entry.scope === "series" && entry.scopeKey === scopeKey
  ));
  const effective = new Map();
  entries.filter(entry => entry.scope === "global").forEach(entry => effective.set(entry.source, entry));
  entries.filter(entry => entry.scope === "series").forEach(entry => effective.set(entry.source, entry));
  return [...effective.values()].sort((left, right) => right.source.length - left.source.length || left.source.localeCompare(right.source));
}
function matchesSourceTerm(sourceText, sourceTerm) {
  const text = String(sourceText || "");
  const term = String(sourceTerm || "");
  if (!text || !term) return false;
  if (!HANGUL_TERM_RE.test(term)) return text.includes(term);
  // 韩文术语允许紧跟常见助词，但不能只是更长单词或复合词中的子串。
  let offset = text.indexOf(term);
  while (offset >= 0) {
    const previous = text[offset - 1] || "";
    if (!HANGUL_SYLLABLE_RE.test(previous)) {
      let end = offset + term.length;
      while (end < text.length && HANGUL_SYLLABLE_RE.test(text[end])) end += 1;
      if (HANGUL_PARTICLE_RE.test(text.slice(offset + term.length, end))) return true;
    }
    offset = text.indexOf(term, offset + term.length);
  }
  return false;
}
function getRelevantEntries(value, items, context = null) {
  const sourceText = (Array.isArray(items) ? items : []).map(item => String(item && (item.original_text || item.text) || "")).join("\n");
  if (!sourceText) {
    return [];
  }
  return getEnabledEntries(value, context).filter(entry => matchesSourceTerm(sourceText, entry.source));
}
function buildPrompt(value, items, context = null) {
  const entries = items ? getRelevantEntries(value, items, context) : getEnabledEntries(value, context);
  if (entries.length === 0) {
    return "";
  }
  const rows = entries.map(entry => ({
    source: entry.source,
    target: entry.target,
    ...(entry.note ? {
      note: entry.note
    } : {})
  }));
  return ["Mandatory terminology glossary:", "When the source text contains a listed source term, use its target translation exactly.", "Do not replace a glossary target with a synonym, alternate spelling, or transliteration.", "Apply the longest matching source term first. The glossary overrides general translation preferences.", JSON.stringify(rows)].join("\n");
}
function getFingerprint(value, context = null) {
  const rows = getEnabledEntries(value, context).map(entry => [entry.scope, entry.scopeKey, entry.source, entry.target, entry.note]);
  return `g2-${hashString(JSON.stringify(rows))}`;
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
export default Object.freeze({
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  SCHEMA_VERSION,
  MAX_ENTRIES,
  MAX_SOURCE_LENGTH,
  MAX_TARGET_LENGTH,
  MAX_NOTE_LENGTH,
  normalizeGlossary,
  normalizeGlossaryEntry,
  normalizeScopeKey,
  getEnabledEntries,
  matchesSourceTerm,
  getRelevantEntries,
  buildPrompt,
  getFingerprint
});
