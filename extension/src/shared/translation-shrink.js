/**
 * 「明显变短的自动译文」判据——与 `local-ocr-service/translation_store/shrink_guard.py` 同一套规则。
 *
 * 起因是一次真实事故：漫画翻译走到供应商流式分支后返回被截尾的译文
 * （`好,马上` → `好,`；整句 → `游乐设施`），并覆盖了本来完整的版本。
 * 服务端会在官方译文库里拦一道；这里再拦一道，保证当次渲染也不会用上被截尾的值。
 *
 * 只拦「自动 + 明显更短」：源文或旧译文太短时不做判断（短句本来就容易更短更好）。
 */

export const MIN_SOURCE_CHARS = 4;
export const MIN_PREVIOUS_CHARS = 4;
export const SHRINK_RATIO = 0.6;

export function shouldKeepPreviousTranslation({ source = "", candidate = "", previous = "" } = {}) {
  const candidateText = String(candidate || "");
  const previousText = String(previous || "");
  if (!previousText || !candidateText) return false;
  if (String(source || "").length < MIN_SOURCE_CHARS) return false;
  if (previousText.length < MIN_PREVIOUS_CHARS) return false;
  return candidateText.length < previousText.length * SHRINK_RATIO;
}

/**
 * 「长得离谱的原文只回了几个字」判据——用于**没有旧值可比**的首次译文。
 *
 * 上面的判据只在有旧值时才拦得住。事故里的第一次写入没有任何旧值可比：
 * 37 字符的韩文原句回了 4 个字（`游乐设施`），于是截尾值被写进缓存与官方库，
 * 之后所有基于「旧值」的比较都拦不住它了。
 *
 * 绝对上限 6 个字很关键：长原文的合理短译（「嗯」「好。」）不会超过这个量级，
 * 因此既拦住截尾，又不会把正常短译判成可疑。
 */
export const MIN_SOURCE_FOR_LENGTH_CHECK = 12;
export const SOURCE_LENGTH_RATIO = 0.15;
export const IMPLAUSIBLE_MAX_CHARS = 6;

export function isImplausiblyShort({ source = "", candidate = "" } = {}) {
  const candidateText = String(candidate || "").trim();
  const sourceText = String(source || "").trim();
  if (!candidateText || !sourceText) return false;
  if (sourceText.length < MIN_SOURCE_FOR_LENGTH_CHECK) return false;
  const threshold = Math.min(IMPLAUSIBLE_MAX_CHARS, Math.max(2, Math.floor(sourceText.length * SOURCE_LENGTH_RATIO)));
  return candidateText.length <= threshold;
}

export default Object.freeze({
  shouldKeepPreviousTranslation,
  isImplausiblyShort,
  MIN_SOURCE_CHARS,
  MIN_PREVIOUS_CHARS,
  SHRINK_RATIO,
  MIN_SOURCE_FOR_LENGTH_CHECK,
  SOURCE_LENGTH_RATIO,
  IMPLAUSIBLE_MAX_CHARS
});
