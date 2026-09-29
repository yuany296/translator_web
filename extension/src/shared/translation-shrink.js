/**
 * 「自动译文被截断」的两条判据——与 `local-ocr-service/translation_store/shrink_guard.py` 同一套规则。
 *
 * 起因是一次真实事故：漫画翻译走到供应商流式分支后返回被截尾的译文
 * （`好,马上` → `好,`；整句 → `游乐设施`），并覆盖了本来完整的版本。
 *
 * 调用方（background/modules/translation-provider.js）按两条判据分别处置，**效果不同**：
 *   (a) shouldKeepPreviousTranslation 命中 → 当次渲染与缓存都用回旧译文（截尾值不落地）；
 *   (b) isImplausiblyShort 命中 → **只拒绝写缓存**，当次渲染仍然用这个新值
 *       （首次译文没有更好的值可用，是有意的取舍；服务端同样不会把它设为启用版本）。
 *
 * 只拦「自动 + 明显更短/不成比例」：源文或旧译文太短时不做判断（短句本来就容易更短更好）。
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
 * 「长得离谱的原文只回了几个字」判据——**与有没有旧值无关**。
 *
 * 上面的判据只在有旧值时才拦得住，而且旧值本身可能就是上一轮的截尾值。事故里的
 * 第一次写入没有任何旧值可比：37 字符的韩文原句回了 4 个字（`游乐设施`），于是截尾值
 * 被写进缓存与官方库，之后所有基于「旧值」的比较都拦不住它了。所以调用方在判据 (a)
 * 未命中时一律跑这一条；服务端（shrink_guard.py）也是同样的适用范围。
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
