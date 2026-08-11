import glossaryCore from "./glossary.js";

const CHUNK_TARGET_CHARS = 1400;
const MAX_PARAGRAPH_CHARS = 12000;

function parseKakaoNovelLocation(url, title = "") {
  const match = String(url || "").match(/\/content\/([^/]+)\/viewer\/([^/?#]+)/u);
  if (!match) return null;
  const orderMatch = String(title || "").match(/(\d+(?:\.\d+)?)\s*화/u);
  return {
    seriesId: match[1],
    chapterId: match[2],
    scopeKey: `kakao:${match[1]}`,
    chapterOrder: orderMatch ? Number(orderMatch[1]) : null,
    chapterTitle: String(title || "").trim()
  };
}

function normalizeParagraph(value, index = 0) {
  const id = String(value && value.id || "").trim().slice(0, 180);
  if (!id) return null;
  return {
    id,
    original_text: String(value.original_text ?? value.text ?? "")
      .replace(/\r\n?/gu, "\n").slice(0, MAX_PARAGRAPH_CHARS),
    index: Number.isFinite(Number(value.index)) ? Number(value.index) : index,
    kind: String(value.kind || "paragraph").slice(0, 40)
  };
}

function buildChunks(items, targetChars = CHUNK_TARGET_CHARS) {
  const chunks = [];
  let current = [];
  let length = 0;
  const limit = Math.max(400, Number(targetChars) || CHUNK_TARGET_CHARS);
  for (let index = 0; index < (Array.isArray(items) ? items.length : 0); index += 1) {
    const item = normalizeParagraph(items[index], index);
    if (!item) continue;
    const size = item.original_text.length;
    if (current.length && length + size > limit) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function validateTranslations(items, rows, glossaryEntries = [], languages = {}) {
  const expected = new Map((Array.isArray(items) ? items : []).map(item => [String(item.id), item]));
  const accepted = [];
  const glossaryFallbacks = [];
  const errors = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row && row.id || "").trim();
    const translatedText = String(row && row.translated_text || "").trim();
    if (!expected.has(id) || !translatedText || seen.has(id)) continue;
    const original = String(expected.get(id).original_text || "");
    const configuredSource = String(languages.sourceLanguage || "auto");
    const sourceLanguage = configuredSource !== "auto" ? configuredSource
      : /[\uac00-\ud7af]/u.test(original) ? "ko"
        : /[\u3040-\u30ff]/u.test(original) ? "ja"
          : /[a-z]/iu.test(original) ? "en" : "auto";
    const targetLanguage = String(languages.targetLanguage || "zh-CN");
    const sourceScript = sourceLanguage === "ko" ? /[\uac00-\ud7af]/gu
      : sourceLanguage === "ja" ? /[\u3040-\u30ff]/gu : null;
    const targetScript = targetLanguage === "ko" ? /[\uac00-\ud7af]/gu
      : targetLanguage === "ja" ? /[\u3040-\u30ff]/gu
        : targetLanguage.startsWith("zh") ? /[\u3400-\u9fff]/gu : /[a-z]/giu;
    const sourceCount = sourceScript ? (translatedText.match(sourceScript) || []).length : 0;
    const originalSourceCount = sourceScript ? (original.match(sourceScript) || []).length : 0;
    const targetCount = (translatedText.match(targetScript) || []).length;
    if (sourceScript && sourceLanguage !== targetLanguage && originalSourceCount > 0
      && sourceCount >= 4 && sourceCount > targetCount) {
      errors.push({ id, code: "source_language_leak" });
      continue;
    }
    const violated = glossaryEntries.filter(term =>
      glossaryCore.matchesSourceTerm(original, term.source) && !translatedText.includes(term.target)
    );
    if (violated.length) {
      const terms = violated.map(term => term.source);
      errors.push({ id, code: "glossary_violation", terms });
      glossaryFallbacks.push({ id, translated_text: translatedText, terms });
      continue;
    }
    seen.add(id);
    accepted.push({ id, translated_text: translatedText });
  }
  for (const id of expected.keys()) {
    if (!seen.has(id) && !errors.some(error => error.id === id)) {
      errors.push({ id, code: "missing_translation" });
    }
  }
  return { accepted, glossaryFallbacks, errors };
}

function summarizeTranslationErrors(errors) {
  const normalized = (Array.isArray(errors) ? errors : []).map(error => ({
    id: String(error && error.id || "").slice(0, 180),
    code: String(error && error.code || (error && error.error ? "request_failed" : "unknown"))
      .slice(0, 80),
    terms: (Array.isArray(error && error.terms) ? error.terms : [])
      .map(term => String(term).slice(0, 120)).slice(0, 20),
    error: String(error && error.error || "").slice(0, 300)
  }));
  const labels = {
    glossary_violation: "术语不一致",
    missing_translation: "响应缺少 ID/译文",
    source_language_leak: "返回内容仍以韩文为主",
    request_failed: "API 请求失败",
    retry_failed: "重试请求失败",
    unknown: "未知错误"
  };
  const counts = new Map();
  normalized.forEach(error => counts.set(error.code, (counts.get(error.code) || 0) + 1));
  const summary = [...counts.entries()].map(([code, count]) => `${labels[code] || code} ${count} 段`);
  return {
    text: summary.join("，"),
    errors: normalized
  };
}

function summarizeTranslationWarnings(warnings) {
  const normalized = summarizeTranslationErrors(warnings).errors;
  const count = new Set(normalized.map(warning => warning.id).filter(Boolean)).size;
  return {
    text: count ? `已保留全部译文，其中 ${count} 段未完全采用术语表指定译名。` : "",
    warnings: normalized
  };
}

export default Object.freeze({
  CHUNK_TARGET_CHARS,
  parseKakaoNovelLocation,
  normalizeParagraph,
  buildChunks,
  validateTranslations,
  summarizeTranslationErrors,
  summarizeTranslationWarnings
});
