/**
 * 把「模型没翻、照抄了原文」的术语就地换成术语库里的译名（确定性修复）。
 *
 * 这是**确定性**的一类问题，跟「术语在文章里不是那个意思」是两回事：
 *   - 语境判断（该不该用术语）只有模型知道，只能靠提示词 + 模型自己决定；
 *   - 但「译文里出现了术语的**原文拼写**」是字符串事实 —— 模型这一段就是没翻，
 *     这时术语库里的译名几乎一定是更好的答案，直接替换即可，不需要再打一次模型。
 *
 * 为什么必须放在校验之前（见 shared/novel.js#validateTranslations 与手机版的
 * 校验器覆盖 glossary-judgement.js）：
 *   validateTranslations 的韩文残留判定是「≥4 个韩文字符且多于中文字符」才算泄漏。
 *   一个人名照抄下来（레오나르도가 = 6 个韩文字符）会被判不合格 → 整段丢掉、再花一次
 *   模型请求逐段重试，重试还是照抄 → 这一段最后什么都没翻出来（页面上就是原文）。
 *   先替换再校验，这一整条链路就不用走了。
 *
 * 保守边界（宁可少替换，也不要改坏译文）：
 *   - 只在**原文**真的命中该词（沿用 glossaryCore.matchesSourceTerm 的边界规则）时才动；
 *   - 韩文术语只吃「合法的助词/称呼后缀尾巴」（레오나르도 + 가/는/님…），
 *     尾巴不是助词说明它是更长单词的一部分（줄 → 줄다리기），这时一个字都不动；
 *   - 前面紧挨着韩文字母说明只是更长单词的后半截，也不动；
 *   - 拉丁术语要求词边界（king 不会命中 kingdom），大小写不敏感；
 *   - 译名本身包含原文拼写时（source "Leo" → target "Leonardo"）无法区分
 *     「照抄」和「本来就该这么写」，整条跳过；
 *   - 只处理韩文与拉丁原文：汉字/假名原文与译名同形，无从判断。
 *
 * 手机版与桌面版共用这一份实现（手机版的 term-repair-local.js 只是转出）。
 */
import glossaryCore from "./glossary.js";

const HANGUL_SYLLABLE_RE = /[\uac00-\ud7af]/u;
const HANGUL_TERM_RE = /^[\uac00-\ud7af]+$/u;
const LATIN_LETTER_OR_DIGIT_RE = /[a-z0-9]/iu;

// 与 shared/glossary.js#HANGUL_TAIL_TOKENS 同一份语言事实（常用助词 + 称呼后缀）。
// 测试会拿 glossaryCore.matchesSourceTerm 逐条校验，保证这里不会和共享实现漂移。
const HANGUL_PARTICLE_TAILS = Object.freeze([
  "이라도", "이라고", "이었다", "이고", "이며", "이랑", "이나", "이면", "이야",
  "에서", "에게", "한테", "부터", "까지", "마다", "보다", "처럼", "라도", "밖에",
  "조차", "마저", "커녕", "라고", "였다", "으로", "께서", "하고", "이다",
  "이", "가", "은", "는", "을", "를", "의", "에", "께", "로", "와", "과", "도",
  "만", "나", "면", "랑", "야",
  "님", "씨", "군", "양"
]);

function isHangulLetter(character) {
  return Boolean(character) && HANGUL_SYLLABLE_RE.test(character);
}

/**
 * 替换后如果紧接着一个空格、而空格后面不是拉丁字母/数字，就把这个空格吃掉：
 * 「레오나르도가 说道。」→「莱昂纳多说道。」而不是「莱昂纳多 说道。」
 * （拉丁词之间的空格要留着：莱昂纳多 Smith）。
 */
function skipSpacing(text, index) {
  if (text[index] !== " ") return index;
  const next = text[index + 1];
  return next === undefined || !LATIN_LETTER_OR_DIGIT_RE.test(next) ? index + 1 : index;
}

/** 尾巴能被助词/称呼后缀链完整吃掉才返回长度，否则 -1（更长单词的一部分，不动）。 */
function allowedTailLength(tail) {
  let index = 0;
  while (index < tail.length) {
    const token = HANGUL_PARTICLE_TAILS.find(candidate => tail.startsWith(candidate, index));
    if (!token) return -1;
    index += token.length;
  }
  return index;
}

/** 韩文术语：整词替换，并连同后面的助词/称呼后缀一起吃掉（中文没有这些成分）。 */
function replaceHangulTerm(text, source, target) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf(source, index);
    if (at < 0) break;
    if (isHangulLetter(text[at - 1])) {
      // 前面紧挨着韩文字母：只是更长单词的后半截
      output += text.slice(index, at + source.length);
      index = at + source.length;
      continue;
    }
    let runEnd = at + source.length;
    while (isHangulLetter(text[runEnd])) runEnd += 1;
    const tailLength = allowedTailLength(text.slice(at + source.length, runEnd));
    if (tailLength < 0) {
      output += text.slice(index, at + source.length);
      index = at + source.length;
      continue;
    }
    output += text.slice(index, at) + target;
    index = skipSpacing(text, runEnd);
  }
  return output + text.slice(index);
}

/** 拉丁术语：词边界替换，大小写不敏感。 */
function replaceLatinTerm(text, source, target) {
  const haystack = text.toLocaleLowerCase();
  const needle = source.toLocaleLowerCase();
  let output = "";
  let index = 0;
  while (index < text.length) {
    const at = haystack.indexOf(needle, index);
    if (at < 0) break;
    const previous = at > 0 ? text[at - 1] : "";
    const next = at + source.length < text.length ? text[at + source.length] : "";
    if (LATIN_LETTER_OR_DIGIT_RE.test(previous) || LATIN_LETTER_OR_DIGIT_RE.test(next)) {
      output += text.slice(index, at + source.length);
      index = at + source.length;
      continue;
    }
    output += text.slice(index, at) + target;
    index = skipSpacing(text, at + source.length);
  }
  return output + text.slice(index);
}

function replaceSpelling(text, source, target) {
  if (HANGUL_TERM_RE.test(source)) return replaceHangulTerm(text, source, target);
  if (source.split("").every(character => !LATIN_LETTER_OR_DIGIT_RE.test(character))) return text;
  return replaceLatinTerm(text, source, target);
}

function foldsEqual(left, right) {
  return String(left).toLocaleLowerCase() === String(right).toLocaleLowerCase();
}

/** 能安全替换的词条：译名里本来就含原文拼写的（Leo → Leonardo）无法区分照抄，跳过。 */
function isRepairableEntry(entry) {
  const source = String(entry && entry.source || "").trim();
  const target = String(entry && entry.target || "").trim();
  if (!source || !target || foldsEqual(source, target)) return false;
  return !target.toLocaleLowerCase().includes(source.toLocaleLowerCase());
}

/**
 * 返回**新的** rows 数组；只有真的改了内容的行才换对象，其余原样透传（省得下游误判为变更）。
 */
export function repairTermLeftovers(items, rows, entries) {
  if (!Array.isArray(rows)) return rows;
  const repairable = (Array.isArray(entries) ? entries : [])
    .filter(isRepairableEntry)
    // 长词优先：否则短词会先吃掉长词的一部分
    .sort((left, right) => String(right.source).length - String(left.source).length);
  if (!repairable.length) return rows;
  const originals = new Map((Array.isArray(items) ? items : [])
    .map(item => [String(item && item.id || ""), String(item && item.original_text || "")]));
  return rows.map(row => {
    const text = String(row && row.translated_text || "");
    const original = originals.get(String(row && row.id || ""));
    if (!text || !original) return row;
    let repaired = text;
    for (const entry of repairable) {
      // 原文里根本没有这个词，就绝不在译文里替换
      if (!glossaryCore.matchesSourceTerm(original, entry.source)) continue;
      repaired = replaceSpelling(repaired, String(entry.source).trim(), String(entry.target).trim());
    }
    return repaired === text ? row : { ...row, translated_text: repaired };
  });
}

export { HANGUL_PARTICLE_TAILS as TERM_REPAIR_TAILS };
export default Object.freeze({ repairTermLeftovers, TERM_REPAIR_TAILS: HANGUL_PARTICLE_TAILS });
