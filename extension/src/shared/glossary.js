import libraryCore from "./glossary-library.js";
import languages from "./languages.js";
import { hashString36 } from "./stable-hash.js";

const STORAGE_KEY = "mt_glossary_v2";
const LEGACY_STORAGE_KEY = "mt_glossary_v1";
const SCHEMA_VERSION = 4;
const MAX_ENTRIES_PER_LIBRARY = 500;
const MAX_ENTRIES = MAX_ENTRIES_PER_LIBRARY;
const MAX_TOTAL_ENTRIES = 2000;
const MAX_SOURCE_LENGTH = 120;
const MAX_TARGET_LENGTH = 120;
const MAX_NOTE_LENGTH = 240;
const HANGUL_SYLLABLE_RE = /[\uac00-\ud7af]/u;
const HANGUL_TERM_RE = /^[\uac00-\ud7af]+$/u;
// 韩文术语后允许跟随的成分：常见助词 + 姓名称呼后缀(님/씨/군/양/께서)。
// 匹配时链式剥离(如 님이、씨는、양이)，长 token 优先，防止"이"抢先吃掉"이었다"。
// **这份数据是唯一定义**：shared/term-repair.js 直接复用它（不要在那里再抄一份）。
export const HANGUL_TAIL_TOKENS = Object.freeze([
  "이라도", "이라고", "이었다", "이고", "이며", "이랑", "이나", "이면", "이야",
  "에서", "에게", "한테", "부터", "까지", "마다", "보다", "처럼", "라도", "밖에",
  "조차", "마저", "커녕", "라고", "였다", "으로", "께서", "하고", "이다",
  "이", "가", "은", "는", "을", "를", "의", "에", "께", "로", "와", "과", "도",
  "만", "나", "면", "랑", "야",
  "님", "씨", "군", "양"
]);
function normalizeGlossary(value) {
  const rawEntries = value && Array.isArray(value.entries) ? value.entries : Array.isArray(value) ? value : [];
  const libraries = libraryCore.normalizeLibraries(value && value.libraries);
  const seenSources = new Set();
  const countsByLibrary = new Map();
  const entries = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = normalizeGlossaryEntry(rawEntries[index], index, libraries);
    if (!entry) {
      continue;
    }
    const dedupeKey = `${entry.libraryId}\u0000${entry.sourceLanguage}\u0000${entry.targetLanguage}\u0000${entry.scope}\u0000${entry.scopeKey}\u0000${entry.source.toLocaleLowerCase()}`;
    if (seenSources.has(dedupeKey)) {
      continue;
    }
    const used = countsByLibrary.get(entry.libraryId) || 0;
    if (used >= MAX_ENTRIES_PER_LIBRARY || entries.length >= MAX_TOTAL_ENTRIES) {
      continue;
    }
    countsByLibrary.set(entry.libraryId, used + 1);
    seenSources.add(dedupeKey);
    entries.push(entry);
  }
  return {
    version: SCHEMA_VERSION,
    revision: Math.max(0, Math.floor(Number(value && value.revision) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(value && value.updatedAt) || 0)),
    libraries,
    entries
  };
}
function normalizeGlossaryEntry(value, index = 0, libraries = null) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = normalizeField(value.source, MAX_SOURCE_LENGTH);
  const target = normalizeField(value.target, MAX_TARGET_LENGTH);
  if (!source || !target) {
    return null;
  }
  const scopeKey = normalizeScopeKey(value.workId || value.scopeKey);
  const scope = ["work", "series"].includes(value.scope) && scopeKey ? "work" : "global";
  // 语言码一律折回规范短码：本地服务会把 `ja` 升格成 `ja-JP` 落库并原样回传，
  // 不折回来就会在 getEnabledEntries 的严格相等比较里把整库词条滤掉。
  const sourceLanguage = languages.canonicalSourceLanguage(
    String(value.sourceLanguage || value.src_lng || "ko")
  ).slice(0, 24) || "ko";
  const targetLanguage = languages.canonicalTargetLanguage(
    String(value.targetLanguage || value.tgtLng || value.tgt_lng || "zh-CN")
  ).slice(0, 24) || "zh-CN";
  const libraryId = resolveLibraryId(value, libraries);
  const fallbackId = `term-${index}-${hashString(`${sourceLanguage}\u0000${targetLanguage}\u0000${libraryId}\u0000${scope}\u0000${scopeKey}\u0000${source}\u0000${target}`)}`;
  return {
    id: normalizeIdentifier(value.id) || fallbackId,
    source,
    target,
    sourceLanguage,
    targetLanguage,
    note: normalizeField(value.note, MAX_NOTE_LENGTH),
    enabled: value.enabled !== false,
    libraryId,
    scope,
    workId: scope === "work" ? scopeKey : "",
    scopeKey: scope === "work" ? scopeKey : "",
    scopeLabel: scope === "work" ? normalizeField(value.scopeLabel, MAX_NOTE_LENGTH) : ""
  };
}
/** 库 id 缺失或指向已不存在的库时归入默认库，保证条目不会变成无主孤儿。 */
function resolveLibraryId(value, libraries = null) {
  const requested = libraryCore.normalizeLibraryId(value.libraryId || value.library_id);
  if (!requested) {
    return libraryCore.DEFAULT_LIBRARY_ID;
  }
  if (!Array.isArray(libraries)) {
    return requested;
  }
  return libraries.some(library => library.id === requested) ? requested : libraryCore.DEFAULT_LIBRARY_ID;
}
function normalizeField(value, maxLength) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, maxLength);
}
/**
 * 条目 id 必须与本地服务 SQLite 里的主键逐字一致，否则「删除」会打空。
 * 服务端自己生成的 id 带小数点（`term-<时间戳>-<哈希>` / `batch-<时间戳>-<序号>`），
 * 旧版这里把 `.` 当非法字符抹掉，于是本地 id 与服务端主键不再相等：
 * DELETE /glossary/{id} 命中 404（被当成「已删除」忽略），词条留在库里，
 * 下一次 loadGlossaryFromServer 又把它拉回来 —— 表现为「清理后又重新出现」。
 * 只做长度与首尾空白处理，其余字符原样保留。
 */
function normalizeIdentifier(value) {
  return String(value || "").trim().slice(0, 160);
}
function normalizeScopeKey(value) {
  return String(value || "").trim().replace(/[^\w:.-]/gu, "").slice(0, 160);
}
function getLibraryOrder(value) {
  const order = new Map();
  const libraries = libraryCore.normalizeLibraries(value && value.libraries);
  libraries.forEach((library, index) => order.set(library.id, index));
  return { libraries, order };
}
function getEnabledEntries(value, context = null) {
  const scopeKey = normalizeScopeKey(context && context.scopeKey);
  // 两侧都折回规范短码再比较：词条侧走 normalizeEntry 已折过一次，这里再折一次是
  // 兜底（历史存档、服务端直接塞进来的行都可能在 entries 之外绕过 normalizeEntry）。
  const sourceLanguage = languages.canonicalSourceLanguage(context && context.sourceLanguage || "");
  const targetLanguage = languages.canonicalTargetLanguage(context && context.targetLanguage || "");
  const pageUrl = String(context && context.pageUrl || "");
  const normalized = normalizeGlossary(value);
  const enabledLibraries = new Set(
    normalized.libraries.filter(library =>
      library.enabled !== false && libraryCore.libraryApplyUrlMatches(pageUrl, library.applyUrls)
    ).map(library => library.id)
  );
  const order = new Map(normalized.libraries.map((library, index) => [library.id, index]));
  const entries = normalized.entries.filter(entry => entry.enabled
    && enabledLibraries.has(entry.libraryId)
    && (entry.scope === "global" || scopeKey && entry.scope === "work" && entry.scopeKey === scopeKey)
    && (!sourceLanguage || sourceLanguage === "auto"
      || languages.canonicalSourceLanguage(entry.sourceLanguage) === sourceLanguage)
    && (!targetLanguage
      || languages.canonicalTargetLanguage(entry.targetLanguage) === targetLanguage));
  const effective = new Map();
  // 同级术语按库顺序决定优先级：靠前的库覆盖靠后的库，所以先写入靠后的库。
  const ranked = [...entries].sort((left, right) =>
    (order.get(right.libraryId) ?? 0) - (order.get(left.libraryId) ?? 0));
  ranked.filter(entry => entry.scope === "global").forEach(entry => effective.set(entry.source, entry));
  ranked.filter(entry => entry.scope === "work").forEach(entry => effective.set(entry.source, entry));
  return [...effective.values()].sort((left, right) => right.source.length - left.source.length || left.source.localeCompare(right.source));
}
function isLatinLetterOrDigit(char) {
  const code = char ? char.charCodeAt(0) : NaN;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 192 && code <= 383);
}
function isLatinTerm(term) {
  for (let index = 0; index < term.length; index += 1) {
    const code = term.charCodeAt(index);
    if (code !== 32 && code !== 45 && code !== 39 && !isLatinLetterOrDigit(term[index])) {
      return false;
    }
  }
  return true;
}
/** 术语后的韩文尾巴必须是助词/称呼后缀的合法组合（链式剥离，如 님이、씨는、양이）。 */
function isAllowedHangulTail(tail) {
  let rest = tail;
  while (rest) {
    const token = HANGUL_TAIL_TOKENS.find(candidate => rest.startsWith(candidate));
    if (!token) {
      return false;
    }
    rest = rest.slice(token.length);
  }
  return true;
}
function matchesSourceTerm(sourceText, sourceTerm) {
  const text = String(sourceText || "").toLocaleLowerCase();
  const term = String(sourceTerm || "").toLocaleLowerCase();
  if (!text || !term) return false;
  if (!HANGUL_TERM_RE.test(term)) {
    // 拉丁术语大小写不敏感且要求词边界，避免 "the" 命中 "other"、"king" 命中 "kingdom"。
    if (!isLatinTerm(term)) return text.includes(term);
    let offset = text.indexOf(term);
    while (offset >= 0) {
      const previous = offset > 0 ? text[offset - 1] : "";
      const next = offset + term.length < text.length ? text[offset + term.length] : "";
      if (!isLatinLetterOrDigit(previous) && !isLatinLetterOrDigit(next)) {
        return true;
      }
      offset = text.indexOf(term, offset + term.length);
    }
    return false;
  }
  // 韩文术语允许紧跟常见助词或称呼后缀(씨/님/군/양)，但不能只是更长单词或复合词中的子串。
  let offset = text.indexOf(term);
  while (offset >= 0) {
    const previous = text[offset - 1] || "";
    if (!HANGUL_SYLLABLE_RE.test(previous)) {
      let end = offset + term.length;
      while (end < text.length && HANGUL_SYLLABLE_RE.test(text[end])) end += 1;
      if (isAllowedHangulTail(text.slice(offset + term.length, end))) return true;
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
  return ["Mandatory terminology glossary:", "When the source text contains a listed source term, the translated text must contain its target string verbatim.", "Never replace a glossary target with a synonym, alternate spelling, transliteration, or your own rendering of the term.", "Apply the longest matching source term first. The glossary overrides general translation preferences.", "Entry notes describe the character (gender, age, role, speech style). Use notes to choose pronouns and voice for that character, even in sentences that refer to them only by a pronoun.", JSON.stringify(rows)].join("\n");
}
function getFingerprint(value, context = null) {
  const rows = getEnabledEntries(value, context).map(entry => [
    entry.libraryId, entry.sourceLanguage, entry.targetLanguage, entry.scope, entry.scopeKey,
    entry.source, entry.target, entry.note
  ]);
  return `g4-${hashString(JSON.stringify(rows))}`;
}
function hashString(value) {
  return hashString36(value);
}
export default Object.freeze({
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  SCHEMA_VERSION,
  MAX_ENTRIES,
  MAX_ENTRIES_PER_LIBRARY,
  MAX_TOTAL_ENTRIES,
  MAX_SOURCE_LENGTH,
  MAX_TARGET_LENGTH,
  MAX_NOTE_LENGTH,
  HANGUL_TAIL_TOKENS,
  DEFAULT_LIBRARY_ID: libraryCore.DEFAULT_LIBRARY_ID,
  MAX_LIBRARIES: libraryCore.MAX_LIBRARIES,
  normalizeGlossary,
  normalizeGlossaryEntry,
  normalizeScopeKey,
  normalizeLibraryId: libraryCore.normalizeLibraryId,
  normalizeLibraryName: libraryCore.normalizeLibraryName,
  normalizeLibraryUrl: libraryCore.normalizeLibraryUrl,
  normalizeLibrary: libraryCore.normalizeLibrary,
  normalizeLibraries: libraryCore.normalizeLibraries,
  createDefaultLibrary: libraryCore.createDefaultLibrary,
  getLibrary: (value, libraryId) => libraryCore.getLibrary(
    Array.isArray(value) ? value : Array.isArray(value && value.libraries) ? value.libraries : [],
    libraryId
  ),
  getLibraryName: (value, libraryId) => libraryCore.getLibraryName(
    Array.isArray(value) ? value : Array.isArray(value && value.libraries) ? value.libraries : [],
    libraryId
  ),
  getLibraryOrder,
  matchLibraryByUrl: libraryCore.matchLibraryByUrl,
  libraryUrlMatches: libraryCore.libraryUrlMatches,
  getEnabledEntries,
  matchesSourceTerm,
  getRelevantEntries,
  buildPrompt,
  getFingerprint
});
