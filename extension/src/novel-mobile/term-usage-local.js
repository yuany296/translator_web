/**
 * 手机版：在页面上直接说清「术语为什么没生效」。
 *
 * 手机上（Kiwi / Edge Canary 等）没有 DevTools，术语没生效时用户只能猜：是术语库停用了？
 * 是这一页不在「应用网址」范围里（绑定网址只负责归集，真正决定生效的是应用网址）？
 * 是作用域/语言对不上？还是模型看到了术语却没用？这几种原因的修法完全不同，
 * 所以这里把判断做在后台、把结论随译文一起回给内容脚本，显示在进度行上。
 *
 * 术语生效要同时过三关（见 shared/glossary.js#getEnabledEntries）：
 *   库启用 → 本页命中该库的 applyUrls（空 = 全站生效）→ 作用域/语言对匹配；
 * 再过一关才有内容注入提示词：本块原文真的出现了这个词（getRelevantEntries）。
 * 「注入」和「用上」是两件事：注入了但模型没用，那是模型/提示词的问题，这一层要能分开报。
 *
 * 与校验器无关：这里只统计、不拦截，也不产生重试。
 */
import glossaryLibrary from "../shared/glossary-library.js";
import { rememberRequestContext } from "./request-context.js";

const REASON_TEXT = Object.freeze({
  disabled: "术语未生效：术语库已停用",
  page: "术语未生效：本页不在应用网址内（去术语库点「一键加入应用」）",
  scope: "术语未生效：术语是按别的作品存的",
  language: "术语未生效：源/目标语言与当前设置不一致"
});

function foldedIncludes(haystack, needle) {
  return String(haystack || "").toLocaleLowerCase().includes(String(needle || "").toLocaleLowerCase());
}

/** 一次请求里最多回传多少条未使用术语：内容脚本要拿它去补翻，不需要无穷长。 */
const MAX_UNUSED = 10;

/**
 * 逐段找出「原文命中、译文里却没有给出译名」的词条。
 * 这就是「有些人名是模型自己发挥的」：术语注入了，但这段译文没用它给的写法。
 * 返回值直接给内容脚本去做定点补翻（见 novel-batch.js 的术语一致性补齐）。
 */
function collectUnused(base, injected, itemsById, translations) {
  const rows = Array.isArray(translations) ? translations : [];
  const unused = [];
  for (const row of rows) {
    const id = String(row && row.id || "");
    const text = String(row && row.translated_text || "");
    const original = itemsById.get(id);
    if (!text || !original) continue;
    for (const entry of injected) {
      if (unused.length >= MAX_UNUSED) return unused;
      if (!base.matchesSourceTerm(original, entry.source)) continue;
      if (foldedIncludes(text, entry.target)) continue;
      unused.push({ id, source: entry.source, target: entry.target });
    }
  }
  return unused;
}

/** 注入了 m 条，其中译名真的出现在译文里的有 n 条 —— n 远小于 m 就是「模型没用术语」。 */
function countUsed(entries, translations) {
  const texts = (Array.isArray(translations) ? translations : [])
    .map(row => String(row && row.translated_text || ""))
    .filter(Boolean);
  if (!texts.length) return 0;
  return entries.filter(entry => texts.some(text => foldedIncludes(text, entry.target))).length;
}

/**
 * 术语为什么一条都没生效。库和网址都过关时，剩下的只能是作用域或语言对不匹配 ——
 * 这两条都由 getEnabledEntries 的过滤条件唯一决定，所以不会误报。
 */
function classifyReason(glossary, context, pageUrl) {
  if (!glossary.entries.length) return "empty";
  const usedLibraries = new Set(glossary.entries.map(entry => entry.libraryId));
  const candidate = glossary.libraries.filter(library => usedLibraries.has(library.id));
  if (!candidate.some(library => library.enabled !== false)) return "disabled";
  const active = candidate.filter(library => library.enabled !== false);
  if (!active.some(library => glossaryLibrary.libraryApplyUrlMatches(pageUrl, library.applyUrls))) return "page";
  if (glossary.entries.some(entry => entry.scope === "work"
    && entry.scopeKey !== String(context && context.scopeKey || ""))) return "scope";
  return "language";
}

/** 一次请求的术语使用情况：entries 是术语库总量，injected 是本块真正命中并注入提示词的条数。 */
export function summarizeTermUsage(base, value, context, items, translations) {
  const glossary = base.normalizeGlossary(value);
  const pageUrl = String(context && context.pageUrl || "");
  const enabled = base.getEnabledEntries(glossary, context);
  const injected = base.getRelevantEntries(glossary, items, context);
  const itemsById = new Map((Array.isArray(items) ? items : [])
    .map(item => [String(item && item.id || ""), String(item && (item.original_text ?? item.text) || "")]));
  return {
    entries: glossary.entries.length,
    enabled: enabled.length,
    injected: injected.length,
    used: countUsed(injected, translations),
    unused: collectUnused(base, injected, itemsById, translations),
    reason: enabled.length ? "ok" : classifyReason(glossary, context, pageUrl)
  };
}

/** 合并多块（含逐段补齐）的统计：计数相加，未使用术语按「段落 + 原文」去重，原因取第一个非 ok 的。 */
export function mergeTermUsage(current, next) {
  if (!next) return current || null;
  if (!current) return { ...next, unused: [...(next.unused || [])] };
  const seen = new Set((current.unused || []).map(entry => `${entry.id}\u0000${entry.source}`));
  const unused = [...(current.unused || [])];
  for (const entry of next.unused || []) {
    const key = `${entry.id}\u0000${entry.source}`;
    if (seen.has(key) || unused.length >= MAX_UNUSED) continue;
    seen.add(key);
    unused.push(entry);
  }
  return {
    entries: next.entries,
    enabled: next.enabled,
    injected: current.injected + next.injected,
    used: current.used + next.used,
    unused,
    reason: current.reason && current.reason !== "ok" ? current.reason : next.reason
  };
}

/**
 * 进度行上的后缀。术语库为空时说空话更没用，所以只在两种情况出现：
 * 一条都没生效（给出可执行的原因），或本屏有术语命中（给出「用上/注入」）。
 */
export function formatTermUsage(usage) {
  if (!usage || !usage.entries || usage.reason === "empty") return "";
  if (usage.reason && usage.reason !== "ok") return REASON_TEXT[usage.reason] || "术语未生效";
  if (!usage.injected) return "";
  return `术语用上 ${usage.used}/${usage.injected}`;
}

/** 这次请求是哪一页 / 什么语言：术语前言构造器只拿到 scopeKey，得靠这里补（见 request-context.js）。 */
function requestContext(runtime, message, sender, configuration = null) {
  const translation = configuration && configuration.translation || {};
  return {
    scopeKey: String(message.scopeKey || ""),
    pageUrl: String(message.pageUrl || sender && sender.tab && sender.tab.url || ""),
    sourceLanguage: String(message.sourceLanguage || translation.sourceLanguage || "auto"),
    targetLanguage: String(message.targetLanguage || translation.targetLanguage || "zh-CN")
  };
}

async function collectTermUsage(runtime, message, sender, result) {
  const configuration = await runtime.loadConfiguration();
  const context = requestContext(runtime, message, sender, configuration);
  return summarizeTermUsage(
    runtime.glossaryCore, configuration.glossary, context,
    Array.isArray(message.items) ? message.items : [], result.translations
  );
}

/**
 * 包在 TRANSLATE_NOVEL_CHUNK 的处理器外面（messages.js 里是 `runtime.handleTranslateNovelChunk(...)`
 * 晚绑定调用）：
 *   1. 处理之前先把本次请求的 pageUrl 记下来 —— 里面的 buildPrompt 只有 scopeKey，
 *      应用网址非空时会把整库术语判成「本页不生效」而丢掉（详见 request-context.js）；
 *   2. 处理之后把术语使用情况附在同一个响应上（见 summarizeTermUsage），统计失败绝不影响译文。
 */
export function installTermUsageLocal(runtime) {
  const handler = runtime.handleTranslateNovelChunk;
  if (typeof handler !== "function") {
    return runtime;
  }
  runtime.handleTranslateNovelChunk = async (message = {}, sender = {}) => {
    rememberRequestContext(message.scopeKey, requestContext(runtime, message, sender));
    const result = await handler(message, sender);
    if (!result || result.ok !== true || !Array.isArray(result.translations)) {
      return result;
    }
    try {
      return { ...result, termUsage: await collectTermUsage(runtime, message, sender, result) };
    } catch (error) {
      console.warn("[MangaTranslator] 术语使用统计不可用", runtime.getErrorMessage?.(error) || error);
      return result;
    }
  };
  return runtime;
}

export const TERM_USAGE_REASON_TEXT = REASON_TEXT;
