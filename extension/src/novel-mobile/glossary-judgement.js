/**
 * 手机版：术语「由模型按语境判断要不要用」。
 *
 * 桌面版把术语库当硬约束，而且是**两处**一起执行：
 *   1. shared/glossary.js#buildPrompt 的提示词 —— “Mandatory terminology glossary …
 *      must contain its target string verbatim”，原文出现术语就必须逐字用译名；
 *   2. shared/novel.js#validateTranslations —— 原文命中术语而译文里没有译名时报
 *      glossary_violation，这一段会被丢进逐段重试（novel-translation.js#translatePending），
 *      重试还是不达标才回落保留译文、记一条 glossary_warning。
 *
 * 问题在于「命中」只是字符串匹配，shared/glossary.js#matchesSourceTerm 对韩文术语
 * 还会剥掉助词与称呼后缀：人名 봄（春）会命中「봄이 왔다」（春天来了），
 * 줄（人名）会命中「줄을 서다」（排队），한（人名/姓氏）会命中「한 번」（一次）。
 * 一旦命中，模型既被要求硬套译名，又被校验器判为不合格 → 必然再花一次整块的模型请求
 * 去重试同一段，重试仍然不行才回落。所以这既是「术语在文章里不是那个意思却照样用了」，
 * 也是进度条里「请求次数 > 块数」和「翻译太慢」的一个真实来源。
 *
 * 手机版把这两处的裁决权都交给模型：
 *   - 提示词改成「先从句子判断所指是否同一个，再决定用不用」，并写明「按语境译对了
 *     永远好过为一个错误的一致性改掉句子的意思」；
 *   - 校验器不再把「术语没照用」当错误（于是也就没有那次注定失败的重试），
 *     其余校验（对话引号、韩文残留、缺段、重复段）一条不动；
 *   - 顺带补上另一类**确定性**问题：译文里直接照抄了术语原文拼写（模型没翻这一段）。
 *     这不问模型、就地替换成术语库里的译名 —— 见 term-repair-local.js，而且必须在校验
 *     之前做，否则「≥4 个韩文字符」的残留判定会先把整段丢掉再去重试。
 *
 * 术语仍然只挑**本块真的出现**的词注入提示词（沿用 getRelevantEntries），所以
 * 「该用的时候保持一致」没有丢，丢掉的只是「不管什么语境都必须用」。
 *
 * 两个调用点都是 `runtime.X(...)` 晚绑定，因此只在本文件做覆盖，不触碰桌面版任何文件。
 * 术语指纹（getFingerprint）保持原样，缓存键不变：已经翻过的段落仍走缓存，
 * 想立刻用新规则重译，对本章执行一次「强制重译」即可。
 */
import { repairTermLeftovers } from "./term-repair-local.js";
import { withRequestContext } from "./request-context.js";

const JUDGEMENT_RULES = [
  "Terminology reference — judge each row against this passage before you use it; this is not a search-and-replace table.",
  "Every row maps a source term to its established target rendering, and a note says which entity or sense the row is about.",
  "First decide, from the sentence itself, whether an occurrence of a listed source term really denotes that same thing (the same person, place, organization, technique, item, title or relationship).",
  "These rows were curated by hand for this work, so the default answer is to apply them: skip a row only when the sentence clearly uses another sense, never merely because another meaning is possible somewhere.",
  "If it does denote it, use the row's target string verbatim — no synonym, no alternate spelling, no transliteration, no rendering of your own — and prefer the longest matching source term.",
  "This applies above all to names: when a row gives 莱昂纳多 for 레오나르도, write exactly 莱昂纳多 — never invent your own transliteration (里奥/雷奥/莱昂) and never keep the Korean spelling. A Korean name spelling occurring in the passage is that person unless the sentence clearly proves otherwise.",
  "If the same spelling is instead used with another sense (an ordinary noun or verb, an idiom, an onomatopoeia, a homonym, a different person, or merely part of a longer word or compound), translate that occurrence by its meaning in context and ignore the row for it.",
  "When you apply a row, output its target string as ordinary translated text — never as the source spelling, a quoted original, or a parenthetical gloss.",
  "When you skip a row, still translate that word like any other word: the output must stay entirely in the target language, so never copy the source spelling as a way out.",
  "Never force a row in just because its source string appears: a rendering that fits the sentence always beats a consistency that changes its meaning. Equally, never drop a row that clearly does refer to the same entity.",
  "Only treat a source span as the term when the whole term is there: a trailing Korean particle or honorific suffix (이/가/은/는/을/를/에/도/님/씨 …) attached to the source spelling does not by itself make the occurrence that term.",
  "When a row has a note, it describes the entity (gender, age, role, speech style): use it to choose pronouns and voice for that entity, even in sentences that refer to it only by a pronoun.",
  "Never mention the glossary, the rows, or this reasoning anywhere in the output."
];

/**
 * 与桌面版 buildPrompt 输出形状一致（规则若干行 + 一行 JSON 数组），
 * 只有措辞从「必须逐字使用」换成「先判断再使用」，词条挑选完全沿用 base.getRelevantEntries。
 *
 * 关键：调用方（novel-translation.js）只传了 `{ scopeKey }`，没有 pageUrl；
 * 而 getRelevantEntries 会用 pageUrl 判定库的生效范围 —— 应用网址非空 + 没有 pageUrl
 * 会被判成「不匹配」，整库术语都进不了提示词（见 request-context.js）。
 * 所以这里先用同一个 scopeKey 把请求上下文补回来。
 */
export function buildGlossaryJudgementPrompt(base, value, items, context = null) {
  const entries = base.getRelevantEntries(value, items, withRequestContext(context));
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
  return [...JUDGEMENT_RULES, JSON.stringify(rows)].join("\n");
}

/**
 * 校验器改两处：
 *   1. 第三参数是术语条目 —— 先让 term-repair-local 把「照抄原文的术语」就地换成译名
 *      （确定性修复，不打模型），再校验；
 *   2. 交给 base 时传空条目，等于关掉「术语没照用就报错」这一条，于是也就没有那次
 *      注定失败的重试；其余分支（缺段/重复段/韩文残留/丢引号及其回落）全部走 base 原实现。
 */
export function buildGlossaryJudgementValidator(base) {
  return (items, rows, entries, languages) => base.validateTranslations(
    items, repairTermLeftovers(items, rows, entries), [], languages
  );
}

export function installGlossaryJudgementLocal(runtime, { glossary, novel } = {}) {
  const glossaryBase = glossary || runtime.glossaryCore;
  const novelBase = novel || runtime.novelCore;
  if (glossaryBase && typeof glossaryBase.getRelevantEntries === "function") {
    runtime.glossaryCore = {
      ...glossaryBase,
      buildPrompt: (value, items, context) => buildGlossaryJudgementPrompt(glossaryBase, value, items, context)
    };
  }
  if (novelBase && typeof novelBase.validateTranslations === "function") {
    runtime.novelCore = {
      ...novelBase,
      validateTranslations: buildGlossaryJudgementValidator(novelBase)
    };
  }
  return runtime;
}

export const GLOSSARY_JUDGEMENT_RULES = Object.freeze(JUDGEMENT_RULES);
