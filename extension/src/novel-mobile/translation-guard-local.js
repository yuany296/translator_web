/**
 * 手机版：给「小说翻译」请求补一条语言纯洁性规则。
 *
 * 现象：偶尔译文里夹着**没翻译的原文**（韩文名字 / 术语照抄一遍），段落看着像翻了一半。
 * 原因有两个，都不在术语判断这一层：
 *   1. 通用指令（novel-translation.js#buildPrompt）里只写了「翻成目标语言」，
 *      没有一句明确禁止「把原文拼写原样留在译文里」；
 *   2. 校验器 shared/novel.js#validateTranslations 的韩文残留判定是「≥4 个韩文字符
 *      且多于中文字符」才算泄漏 —— 一个 2–3 字的人名、术语照抄下来根本不触发，
 *      于是它被当成合格译文缓存下来，一直显示原文。
 *
 * 通用指令在 novel-translation.js 里是模块私有函数，手机版不能（也不该）改那个文件，
 * 所以这里在**请求出口**补规则：`runtime.sendOpenAICompatibleTranslationRequest` 是晚绑定
 * 调用点，拦一层、只在「小说翻译」的请求体上加一句，其它请求（漫画 OCR、网页翻译）原样放行。
 *
 * 规则是纯追加、幂等的，且对所有小说请求逐字相同 —— 前缀缓存第一轮之后照样命中，
 * 不会因为这一句变慢。
 *
 * 另外补上**目标语言的字形约束**：novel-translation.js 的提示词只写了
 * `into ${targetLanguage}`，也就是一个 `zh-CN` 这样的代码，模型偶尔会把它当成
 * 「中文（不限字形）」而输出繁体（韓文小说尤其常见）。这里从请求里读出目标语言，
 * 用 shared/languages.js 的描述补一句明确的「简体 / 繁体」要求。
 * 提示词只是概率约束，所以 content 侧还有一道可验证的兜底（script-guard.js）。
 */
import languages from "../shared/languages.js";

/** 识别「这条请求是小说翻译」的标记：novel-translation.js 的 system 提示词。 */
export const NOVEL_SYSTEM_MARKER = "web-novel literary translator";

/** 从 user 提示词里取出目标语言（模板是 `... into ${targetLanguage}.`）。 */
const TARGET_LANGUAGE_RE = /into\s+([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)\s*\./u;

/** 简体/繁体必须写清：只给 "zh-CN" 这种代码时，模型偶尔会漂到繁体。 */
const SCRIPT_RULE = Object.freeze({
  "zh-CN": "Target language: Simplified Chinese (简体中文). Use Mainland Simplified characters and vocabulary throughout"
    + " — never Traditional characters (繁體字), and never Taiwan/Hong Kong wording.",
  "zh-TW": "Target language: Traditional Chinese (繁體中文). Use Traditional characters throughout"
    + " — never Simplified characters (简体字)."
});

export function targetLanguageOf(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const content = String(message && message.content || "");
    const match = TARGET_LANGUAGE_RE.exec(content);
    if (match) return languages.normalizeTargetLanguage(match[1]);
  }
  return "";
}

/** 追加在 system 提示词后面的规则（追加在末尾，是为了不打断前缀里已经稳定的部分）。 */
export const LANGUAGE_PURITY_RULE = [
  "Language rule: write the entire translation in the target language.",
  "Never leave source-language spelling inside the output: do not copy Hangul, kana or a Latin name into the target text, and never return an input unchanged.",
  "When a name or term has no established rendering yet, transliterate it into the target language instead of copying the source.",
  "Every input id must come back with a real translation; an empty translation or a source-language one counts as a failure."
].join(" ");

function rulesFor(body) {
  const target = targetLanguageOf(body);
  const scriptRule = SCRIPT_RULE[target];
  return scriptRule ? `${scriptRule} ${LANGUAGE_PURITY_RULE}` : LANGUAGE_PURITY_RULE;
}

function findSystemMessage(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return null;
  return messages.find(message => message && message.role === "system"
    && typeof message.content === "string") || null;
}

/** 只有小说翻译的请求体需要这条规则；其它调用保持原样（漫画/网页翻译有自己的提示词）。 */
export function isNovelTranslationBody(body) {
  const system = findSystemMessage(body);
  return Boolean(system && system.content.includes(NOVEL_SYSTEM_MARKER));
}

/** 幂等追加：重复调用（例如带/不带 response_format 的两次尝试）只加一句；非小说请求原样返回。 */
export function withLanguagePurityRule(body) {
  if (!isNovelTranslationBody(body)) {
    return body;
  }
  const system = findSystemMessage(body);
  const rules = rulesFor(body);
  if (system.content.includes(rules)) {
    return body;
  }
  if (system.content.includes(LANGUAGE_PURITY_RULE)) {
    // 之前只补过通用规则：这次把字形约束插在它前面，保持幂等
    system.content = system.content.replace(LANGUAGE_PURITY_RULE, rules);
    return body;
  }
  system.content = `${system.content} ${rules}`;
  return body;
}

export function installTranslationGuardLocal(runtime) {
  const send = runtime && runtime.sendOpenAICompatibleTranslationRequest;
  if (typeof send !== "function") {
    return runtime;
  }
  runtime.sendOpenAICompatibleTranslationRequest = (endpoint, apiKey, body, timeoutMs, options) => send(
    endpoint, apiKey, withLanguagePurityRule(body), timeoutMs, options
  );
  return runtime;
}
