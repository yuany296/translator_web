import glossaryCore from "./glossary.js";
import termRepair from "./term-repair.js";
import sharedUtils from "./utils.js";
import { NOVEL_SPEED_DEFAULTS } from "./novel-speed.js";

// 切块字数默认值来自 shared/novel-speed.js：桌面设置页可以改（novelChunkChars），
// 这里只保留「没人传参时用多少」的兜底，两处不会再各写一个数字。
const CHUNK_TARGET_CHARS = NOVEL_SPEED_DEFAULTS.chunkChars;
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

// 判重用归一化：去掉所有空白与中英文标点，避免句读差异掩盖"两段译文完全相同"。
const DUPLICATE_MIN_CHARS = 4;

function normalizeComparableText(text) {
  return String(text || "")
    .replace(/\s+/gu, "")
    .replace(/[，。！？!?.,;；:："'“”‘’()\[\]（）【】、…·]/gu, "");
}

function dedupeAcceptedTranslations(expected, accepted, errors) {
  // 模型偶发把相邻两段合并后用同一译文回给两个 id：归一化译文相同且原文不同时,
  // 只保留先出现的一行,后一行报 duplicate_translation 走逐段补翻。
  const kept = [];
  const seenTexts = new Map();
  for (const row of accepted) {
    const translatedKey = normalizeComparableText(row.translated_text);
    const item = expected.get(row.id);
    const originalKey = normalizeComparableText(item ? item.original_text : "");
    const previous = seenTexts.get(translatedKey);
    if (previous && previous.originalKey !== originalKey
      && translatedKey.length >= DUPLICATE_MIN_CHARS) {
      errors.push({ id: row.id, code: "duplicate_translation" });
      continue;
    }
    if (!previous) seenTexts.set(translatedKey, { id: row.id, originalKey });
    kept.push(row);
  }
  return kept;
}

/**
 * 模型对术语的交代：`used` 是「这些行照用了」，`skipped` 是「这次语境不是它 + 理由」。
 *
 * 为什么要有这一层：字符串命中（glossary.js#matchesSourceTerm）经常不是那个意思
 * （봄 = 春天 / 人名，줄 = 排队 / 人名），所以硬校验「命中就必须逐字用」会把句子改坏 ——
 * 手机版当年为此去掉了术语校验。但去掉校验之后模型可以**默默不用**注入的术语，
 * 于是表现为「术语有时候就是不生效」。现在裁决权仍然在模型手里，只是它必须交代:
 * 命中的每一条要么用上、要么写一条带理由的 skipped；两者都没有 = 静默漏用。
 *
 * 模型没按新 schema 回（旧缓存响应、老模型）时返回 null，调用方退回旧的字符串硬校验。
 */
function normalizeTermAccounting(row) {
  const terms = row && row.terms;
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) return null;
  const used = (Array.isArray(terms.used) ? terms.used : [])
    .map(value => String(value || "")).filter(Boolean);
  const skipped = (Array.isArray(terms.skipped) ? terms.skipped : [])
    .map(entry => ({
      source: String(entry && (entry.source ?? entry.term) || ""),
      reason: String(entry && (entry.reason ?? entry.why) || "").trim()
    }))
    .filter(entry => entry.source && entry.reason);
  return { used, skipped };
}

function validateTranslations(items, rows, glossaryEntries = [], languages = {}) {
  const expected = new Map((Array.isArray(items) ? items : []).map(item => [String(item.id), item]));
  // 「译文里照抄了术语原文拼写」是字符串事实不是判断,先就地换成译名再校验:
  // 否则韩文残留判定会先把整段丢掉、再花一次模型请求重试(见 shared/term-repair.js)。
  const repairedRows = (Array.isArray(glossaryEntries) && glossaryEntries.length)
    ? termRepair.repairTermLeftovers(items, rows, glossaryEntries)
    : rows;
  const accepted = [];
  const glossaryFallbacks = [];
  const quoteFallbacks = [];
  const errors = [];
  const seen = new Set();
  for (const row of Array.isArray(repairedRows) ? repairedRows : []) {
    const id = String(row && row.id || "").trim();
    if (!expected.has(id) || seen.has(id)) continue;
    const original = String(expected.get(id).original_text || "");
    // 先做确定性修复再校验:模型整段丢掉对话引号是最常见的形态,
    // 修得回来的不该再占用一次重试(见 shared/utils.js#restoreDialogueQuotes)。
    const translatedText = sharedUtils.restoreDialogueQuotes(
      original,
      String(row && row.translated_text || "").trim()
    );
    if (!translatedText) continue;
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
    const translatedFolded = translatedText.toLocaleLowerCase();
    const accounting = normalizeTermAccounting(row);
    const matched = glossaryEntries.filter(term => glossaryCore.matchesSourceTerm(original, term.source));
    const violated = [];
    const unaccounted = [];
    for (const term of matched) {
      if (translatedFolded.includes(term.target.toLocaleLowerCase())) continue;
      if (!accounting) {
        // 旧响应:退回字符串硬校验(命中却没用 = 违规),重试时会点名要求补交代。
        violated.push(term.source);
        continue;
      }
      // 说了「用了」但译文里没有 → 确定性违规;说了「这次不是它」→ 尊重模型判断。
      if (accounting.used.includes(term.source)) {
        violated.push(term.source);
        continue;
      }
      if (accounting.skipped.some(entry => entry.source === term.source)) continue;
      unaccounted.push(term.source);
    }
    if (violated.length || unaccounted.length) {
      if (violated.length) errors.push({ id, code: "glossary_violation", terms: violated });
      if (unaccounted.length) errors.push({ id, code: "glossary_unaccounted", terms: unaccounted });
      glossaryFallbacks.push({ id, translated_text: translatedText, terms: [...violated, ...unaccounted] });
      continue;
    }
    // 整段包裹修不回来(原文不是整段被引号包住,例如 `"어쩌고" 그가 말했다.`)时
    // 只有模型能修:报错让这一段走逐段重试,重试仍失败就保留译文并出警告 —— 见
    // novel-translation.js 的 quoteFallbacks 回落,绝不因为格式问题丢掉整段译文。
    if (sharedUtils.hasDroppedDialogueQuotes(original, translatedText)) {
      errors.push({ id, code: "dialogue_quote_missing" });
      quoteFallbacks.push({ id, translated_text: translatedText });
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
  const deduped = dedupeAcceptedTranslations(expected, accepted, errors);
  return { accepted: deduped, glossaryFallbacks, quoteFallbacks, errors };
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
    glossary_unaccounted: "术语既没用也没交代",
    missing_translation: "响应缺少 ID/译文",
    duplicate_translation: "与相邻段落译文重复",
    source_language_leak: "返回内容仍以韩文为主",
    dialogue_quote_missing: "原文的对话引号被丢掉",
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
  const codes = new Set(normalized.map(warning => warning.code));
  const reasons = [];
  if (codes.has("glossary_warning")) reasons.push("未完全采用术语表指定译名");
  // 引号警告 = 模型把引号丢了、逐段重试也拿不回来，且原文不是整段被引号包住
  // （那种已在校验前被确定性修复）。这种只有人工确认，但译文必须保留。
  if (codes.has("dialogue_quote_warning")) reasons.push("原文的对话引号没能保住");
  return {
    text: count ? `已保留全部译文，其中 ${count} 段${reasons.join("、") || "需要确认"}。` : "",
    warnings: normalized
  };
}

export default Object.freeze({
  CHUNK_TARGET_CHARS,
  parseKakaoNovelLocation,
  normalizeParagraph,
  buildChunks,
  validateTranslations,
  // 流式链路要在转发前就地修掉「译文里照抄术语原文拼写」的段落（见 translation-stream.js）。
  repairTermLeftovers: termRepair.repairTermLeftovers,
  summarizeTranslationErrors,
  summarizeTranslationWarnings
});
