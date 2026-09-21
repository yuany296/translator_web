/**
 * 整章提取的**提示词与输出校验**（与 local-ocr-service/term_extractor.py 一一对应）。
 *
 * 单独成文件有两个原因：
 *   1. 这几个函数必须与 Python 保持逐条一致 —— parity 测试盯的就是本文件
 *      （见 tests/term_extractor_parity.test.mjs）；
 *   2. term-extract-llm.js 只负责「怎么发请求、怎么分段续跑」，不再混着提示词。
 */

// 常量与 term_extractor.py 第 16–21、35 行逐一对应。
const LLM_MAX_CHUNK_CHARS = 3000;
const LLM_CHUNK_OVERLAP = 200;
const MAX_SOURCE_LENGTH = 120;
const MAX_NOTE_LENGTH = 240;
const MAX_TARGET_LENGTH = 120;
const DEFAULT_KIND_SCORE = 0.85;
const DEFAULT_MODEL = "qwen2.5:7b";
const VALID_KINDS = new Set(["person", "location", "organization", "title", "group", "latin_name", "latin_title"]);
// Python 的 _kind_score 表；用 Map 免得 "__proto__" 之类的键名命中原型属性。
const KIND_SCORES = new Map([["person", 0.94], ["title", 0.9], ["group", 0.9], ["organization", 0.88], ["location", 0.88], ["latin_name", 0.82], ["latin_title", 0.9]]);
/**
 * 字段名与 kind 取值的容错表。
 *
 * Python 版本是拿本地 Ollama 调出来的严格实现；手机版面对的是各家云模型，实测它们
 * 经常不照抄字段名与英文枚举（中文提示词下尤其明显）：
 *   - kind 写成「人名」→ 严格版本整条丢弃，用户连候选都看不到；
 *   - 译名写成 target / 译名 → 候选在，但译名为空，而确认术语时
 *     term-discovery-messages.js 会 filter(source && target) 把它丢掉，表现就是
 *     「术语加不进去」。
 * 所以这里先归一化再走原来的白名单校验：真正该丢的（动词、普通名词这类）仍然丢。
 */
const FIELD_ALIASES = Object.freeze({
  source: ["source", "term", "name", "原文", "术语", "原文术语"],
  kind: ["kind", "type", "类型", "类别"],
  note: ["note", "备注", "说明", "description"],
  target: ["suggestedTarget", "suggested_target", "target", "translation", "译名", "译文", "中文译名"]
});
const KIND_ALIASES = new Map([
  ["person", "person"], ["人名", "person"], ["人物", "person"], ["角色", "person"], ["姓名", "person"],
  ["location", "location"], ["地名", "location"], ["地点", "location"], ["place", "location"],
  ["organization", "organization"], ["org", "organization"], ["机构", "organization"], ["机构名", "organization"],
  ["组织", "organization"], ["组织名", "organization"],
  ["title", "title"], ["作品名", "title"], ["书名", "title"], ["标题", "title"], ["work", "title"],
  ["group", "group"], ["团体", "group"], ["团体名", "group"], ["组合", "group"], ["队伍", "group"],
  ["latin_name", "latin_name"], ["英文名", "latin_name"], ["拉丁名", "latin_name"], ["英文人名", "latin_name"],
  ["latin_title", "latin_title"], ["英文作品名", "latin_title"], ["英文标题", "latin_title"],
  ["proper_noun", "proper_noun"], ["专有名词", "proper_noun"], ["固有名词", "proper_noun"]
]);
// 明确不是术语的词性：这些必须丢，否则「말했다」这种也会被当成术语塞进候选。
// 与 Python INVALID_KIND_ALIASES 逐键一致（parity 测试会比对）。
const INVALID_KIND_ALIASES = new Set([
  "verb", "noun", "common_noun", "common_noun_phrase", "adjective", "adverb", "particle",
  "pronoun", "phrase", "动词", "名词", "普通名词", "形容词", "副词", "助词", "代词", "短语"
]);
const KOREAN_JOSA_RE = /[은는이가을를의에와]$/;
// Python: re.compile(r"[\[（(【<]\s*image\s*#?\s*\d+\s*[\]）)】>]", re.IGNORECASE)
const MODEL_PLACEHOLDER_RE = /[\[（(【<]\s*image\s*#?\s*\d+\s*[\]）)】>]/gi;
const SYSTEM_MESSAGE = "You are a web-novel terminology extractor. Return strict JSON only.";

/** Python str.casefold() 的近似（ß→ss 等极少数差异忽略）：仓库术语模块统一用 toLocaleLowerCase。 */
function caseFold(value) {
  return String(value || "").toLocaleLowerCase("en-US");
}

/** Python 的 len()/切片按码点算，JS 的 .length/.slice 按 UTF-16 单元算：星形平面字符会差一倍。 */
function codePointLength(value) {
  return Array.from(String(value || "")).length;
}

function truncate(value, maxLength) {
  const chars = Array.from(String(value || ""));
  return chars.length <= maxLength ? chars.join("") : chars.slice(0, maxLength).join("");
}

/** 对齐 Python normalize_text：NFKC → 抹掉图片占位符 → \r 归一为 \n → 折叠空格/制表符 → strip。 */
function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(MODEL_PLACEHOLDER_RE, " ")
    .replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
}

/** 对齐 Python _in_source_text：两边去掉全部空白并折叠大小写，再容忍一个结尾韩语助词。 */
function inSourceText(text, term) {
  const fold = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("en-US");
  const haystack = fold(text);
  const needle = fold(term);
  if (!needle || !haystack) return false;
  if (haystack.includes(needle)) return true;
  const stripped = needle.replace(KOREAN_JOSA_RE, "");
  return stripped.length >= 2 && haystack.includes(stripped);
}

function kindScore(kind) {
  return KIND_SCORES.get(kind) ?? DEFAULT_KIND_SCORE;
}

/** 从多个可能的字段名里取第一个非空字符串值。 */
function pickField(value, aliases) {
  for (const key of aliases) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw;
  }
  return "";
}

/**
 * 把模型给的 kind 归一成七个英文白名单值。
 * 返回 "" 表示「不是术语」（动词/普通名词等），返回 undefined 表示「不认识」。
 */
function normalizeKind(raw) {
  const text = String(raw || "").trim();
  if (!text) return undefined;
  const key = text.toLowerCase();
  if (VALID_KINDS.has(key)) return key;
  if (KIND_ALIASES.has(key)) return KIND_ALIASES.get(key);
  if (INVALID_KIND_ALIASES.has(key)) return "";
  return undefined;
}

/** 对齐 Python _split_chunks：只有超长才切，段间保留 overlap 字符重叠。 */
function splitChunks(text, maxChars = LLM_MAX_CHUNK_CHARS, overlap = LLM_CHUNK_OVERLAP) {
  if (text.length <= maxChars) return text.trim() ? [text] : [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start, end - overlap);
  }
  return chunks;
}

/** 对齐 Python _extract_json_array：去围栏 → JSON.parse → 失败则正则取第一个 [...] → 非数组返回 null。 */
function parseJsonArray(content) {
  let text = String(content || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const value = JSON.parse(match[0]);
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
}

/**
 * 数组解析失败后的移动端兜底：请求带了 response_format=json_object 的模型可能把数组包进对象，
 * 而 runtime.parseModelJson 只认顶层 JSON 对象。Python 没有这一步（对象一律返回 None），
 * 只在严格数组解析失败之后才走，属额外宽容。
 */
function parseWrappedArray(runtime, content) {
  if (typeof runtime.parseModelJson !== "function") return null;
  try {
    const parsed = runtime.parseModelJson(content);
    if (!parsed || typeof parsed !== "object") return null;
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) return value;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 对齐 Python _validate_llm_output：丢弃幻觉/越界条目，并纠正模型填反的 source/suggestedTarget。
 *
 * kind 的口径与 Python 完全一致（两边都要对齐，否则同一个模型在两个端上产出不同）：
 *   - 白名单/别名（人名→person、专有名词→proper_noun…）→ 照用；
 *   - 明确的非术语词性（动词/普通名词…）→ 丢弃并计数；
 *   - 完全不认识的取值 → 归一成 proper_noun 保留（宁可让用户自己忽略，也不要静默丢；
 *     「术语老漏」的一大来源就是这里）。
 * `stats` 收集丢弃计数，随 payload 回给后台写进「最近一次提取」。
 */
function validateLlmOutput(runtime, content, sourceText, stats = null) {
  const bump = key => {
    if (stats && typeof stats === "object") stats[key] = (Number(stats[key]) || 0) + 1;
  };
  const values = parseJsonArray(content) ?? parseWrappedArray(runtime, content);
  if (!values) {
    bump("noJson");
    return [];
  }
  const seen = new Set();
  const candidates = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      bump("schema");
      continue;
    }
    let source = pickField(value, FIELD_ALIASES.source).normalize("NFKC").trim();
    const rawKind = pickField(value, FIELD_ALIASES.kind);
    const normalizedKind = normalizeKind(rawKind);
    const note = pickField(value, FIELD_ALIASES.note).trim();
    let target = pickField(value, FIELD_ALIASES.target).trim();
    if (!source || codePointLength(source) > MAX_SOURCE_LENGTH) {
      bump("schema");
      continue;
    }
    if (normalizedKind === "") {
      bump("invalidKind");
      continue;
    }
    if (normalizedKind === undefined) bump("unknownKind");
    const kind = normalizedKind === undefined ? "proper_noun" : normalizedKind;
    // 小模型偶尔把两个字段填反：source 是译文、suggestedTarget 反而是原文。
    if (!inSourceText(sourceText, source) && target && inSourceText(sourceText, target)) {
      const swap = source;
      source = target;
      target = swap;
    }
    // 校验基准只有原文（不含「译文：」行），否则待确认区会出现"原文术语=中文译文"。
    if (!inSourceText(sourceText, source)) {
      bump("notInSource");
      continue;
    }
    const key = caseFold(source);
    if (seen.has(key)) {
      bump("duplicate");
      continue;
    }
    seen.add(key);
    candidates.push({
      source,
      kind,
      note: truncate(note, MAX_NOTE_LENGTH),
      suggestedTarget: truncate(target, MAX_TARGET_LENGTH),
      score: kindScore(kind)
    });
  }
  return candidates;
}

/**
 * 对齐 Python _llm_extract_chunk 里的 prompt，另加三条约束。
 *
 * Python 那份是给本地 Ollama 用的；换成云模型后实测两类偏差会让人名收不到：
 *   - 中文提示词下模型把字段名也写成中文、或把 kind 写成「人名」；
 *   - 音译不好定，就把 suggestedTarget 留空 —— 而确认术语时会 filter(source && target)，
 *     留空等于这条候选根本加不进去。
 * 所以额外点明：字段名必须用英文、kind 只能从七个英文值里选、译名必须给（不许留空/照抄原文）。
 */
function buildChunkPrompt(chunk, targetLanguage) {
  return [
    "你是网络小说/漫画术语提取助手。从下面的源语言文本中提取所有专有名词与人名：",
    "- 人名（含姓氏的完整写法）、地名、机构名、作品名、团体名、英文/外来专名；不要提取普通名词、动词、助词或描述性短语",
    "- 文本可能是韩语、日语、英语、中文或其他语言，按文本实际语言提取；同一实体有多种写法时使用最完整写法",
    "- 每段原文后可能带一行「译文：xxx」参考译文，suggestedTarget 必须从参考译文对应处得出并填写；没有参考译文（没有「译文：」行）时才可留空",
    `- 目标语言为 ${targetLanguage}`,
    "输出 JSON 数组，每项格式：",
    '{"source": "原文术语", "kind": "person|location|organization|title|group|latin_name|latin_title", "note": "目标语言简短说明，无把握则留空", "suggestedTarget": "建议的目标语言译文；有参考译文时不得留空"}',
    "字段名必须是这四个英文名：source、kind、note、suggestedTarget，不要用中文或其它拼写。",
    "kind 只能填这七个英文单词之一：person、location、organization、title、group、latin_name、latin_title（人名用 person），不要填中文。",
    "suggestedTarget 必须给出目标语言译法：人名按目标语言常见音译写；有「译文：」参考译文的，必须与参考译文里的写法一致。不要留空，也不要把原文照抄一遍。",
    "只输出 JSON 数组本身，不要 Markdown 代码块、不要多余解释。",
    `源文本：\n${chunk}`
  ].join("\n");
}

/** 对齐 Python _is_local_url：只有本机地址才允许退到本地 Ollama 默认模型。 */
function isLocalUrl(url) {
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(String(url || "")).hostname);
  } catch {
    return false;
  }
}

/**
 * 整章提取用哪个模型（对齐 Python _resolve_model）。
 *
 * 以前模型为空时一律退到 `qwen2.5:7b` —— 那个名字只对本地 Ollama 有意义。配置里没填
 * model 时，云端接口会拿一个不存在的模型名去请求：提取静默失败，而翻译照常
 * （翻译自己有默认模型）。所以：本机地址才兜底，其余情况直接报错说清原因。
 */
function resolveModel(baseUrl, model) {
  const name = String(model || "").trim();
  if (name) return name;
  if (isLocalUrl(baseUrl)) return DEFAULT_MODEL;
  throw new Error("未配置术语提取模型：请在设置页「翻译服务」里为整章术语提取选择带 model 的配置");
}

/** Python 比的是码点，JS 的 < 比的是 UTF-16 单元：星形平面字符的字典序会不同。 */
function compareCodePoints(left, right) {
  const a = Array.from(String(left || ""));
  const b = Array.from(String(right || ""));
  const size = Math.min(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const diff = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return a.length - b.length;
}

/** 对齐 Python 的 sorted：-score → source 更长的在前 → 字典序。 */
function sortCandidates(candidates) {
  return candidates.slice().sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const lengthDiff = codePointLength(right.source) - codePointLength(left.source);
    return lengthDiff !== 0 ? lengthDiff : compareCodePoints(left.source, right.source);
  });
}

export {
  LLM_MAX_CHUNK_CHARS, LLM_CHUNK_OVERLAP, MAX_SOURCE_LENGTH, MAX_NOTE_LENGTH, MAX_TARGET_LENGTH,
  DEFAULT_KIND_SCORE, DEFAULT_MODEL, VALID_KINDS, KIND_SCORES, FIELD_ALIASES, KIND_ALIASES,
  INVALID_KIND_ALIASES, SYSTEM_MESSAGE,
  caseFold, codePointLength, truncate, normalizeText, inSourceText, kindScore, pickField, normalizeKind,
  splitChunks, parseJsonArray, parseWrappedArray, validateLlmOutput, buildChunkPrompt, sortCandidates,
  isLocalUrl, resolveModel
};