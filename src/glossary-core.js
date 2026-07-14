(function initializeMangaGlossary(globalScope) {
  "use strict";

  const STORAGE_KEY = "mt_glossary_v1";
  const SCHEMA_VERSION = 1;
  const MAX_ENTRIES = 500;
  const MAX_SOURCE_LENGTH = 120;
  const MAX_TARGET_LENGTH = 120;
  const MAX_NOTE_LENGTH = 240;

  function normalizeGlossary(value) {
    const rawEntries = value && Array.isArray(value.entries)
      ? value.entries
      : Array.isArray(value)
        ? value
        : [];
    const seenSources = new Set();
    const entries = [];

    for (let index = 0; index < rawEntries.length && entries.length < MAX_ENTRIES; index += 1) {
      const entry = normalizeGlossaryEntry(rawEntries[index], index);
      if (!entry || seenSources.has(entry.source)) {
        continue;
      }
      seenSources.add(entry.source);
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

    const fallbackId = `term-${index}-${hashString(`${source}\u0000${target}`)}`;
    return {
      id: normalizeIdentifier(value.id) || fallbackId,
      source,
      target,
      note: normalizeField(value.note, MAX_NOTE_LENGTH),
      enabled: value.enabled !== false
    };
  }

  function normalizeField(value, maxLength) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .trim()
      .slice(0, maxLength);
  }

  function normalizeIdentifier(value) {
    return String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80);
  }

  function getEnabledEntries(value) {
    return normalizeGlossary(value).entries
      .filter((entry) => entry.enabled)
      .sort((left, right) => right.source.length - left.source.length || left.source.localeCompare(right.source));
  }

  function getRelevantEntries(value, items) {
    const sourceText = (Array.isArray(items) ? items : [])
      .map((item) => String(item && (item.original_text || item.text) || ""))
      .join("\n");
    if (!sourceText) {
      return [];
    }
    return getEnabledEntries(value).filter((entry) => sourceText.includes(entry.source));
  }

  function buildPrompt(value, items) {
    const entries = items ? getRelevantEntries(value, items) : getEnabledEntries(value);
    if (entries.length === 0) {
      return "";
    }

    const rows = entries.map((entry) => ({
      source: entry.source,
      target: entry.target,
      ...(entry.note ? { note: entry.note } : {})
    }));

    return [
      "Mandatory terminology glossary:",
      "When the source text contains a listed source term, use its target translation exactly.",
      "Do not replace a glossary target with a synonym, alternate spelling, or transliteration.",
      "Apply the longest matching source term first. The glossary overrides general translation preferences.",
      JSON.stringify(rows)
    ].join("\n");
  }

  function getFingerprint(value) {
    const rows = getEnabledEntries(value).map((entry) => [entry.source, entry.target, entry.note]);
    return `g1-${hashString(JSON.stringify(rows))}`;
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

  globalScope.MangaGlossary = Object.freeze({
    STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_ENTRIES,
    MAX_SOURCE_LENGTH,
    MAX_TARGET_LENGTH,
    MAX_NOTE_LENGTH,
    normalizeGlossary,
    normalizeGlossaryEntry,
    getEnabledEntries,
    getRelevantEntries,
    buildPrompt,
    getFingerprint
  });
})(globalThis);
