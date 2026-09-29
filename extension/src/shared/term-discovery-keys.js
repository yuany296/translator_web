import { hashString36 } from "./stable-hash.js";

const SCHEMA_VERSION = 1;

/** 章节身份：去掉片段但保留查询串（`?episode=9` 属于不同章节）。 */
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
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120);
}

function getSourceKey(value) {
  return normalizeSource(value).toLocaleLowerCase("en-US");
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
  return hashString36(value);
}

export default Object.freeze({
  SCHEMA_VERSION,
  normalizeChapterUrl,
  getChapterKey,
  normalizeSource,
  getSourceKey,
  uniqueStrings,
  clampNumber,
  hashString
});
