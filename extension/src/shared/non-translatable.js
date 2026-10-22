/**
 * 不可翻译文本判定（保守口径）：纯数字、时钟、日期、URL、邮箱、纯符号、字母数字编码
 * 这类文本调翻译 API 只会得到原样回声，在翻译管道里统一标 non_translate 直通显示原文。
 *
 * 底线：含任何 CJK/假名/谚文的文本一律可翻译——拟声词（ゴゴゴ）和汉字数字（三、百）
 * 都是内容，误杀真台词比漏掉一个页码贵得多。脚本区间必须与 shared/languages.js 的
 * 文本判定保持同一组 Unicode 范围。
 */
const SCRIPT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const DIGIT_PATTERN = /[0-9\uFF10-\uFF19]/u;
const URL_PATTERN = /^(https?:\/\/|www\.)\S+$/iu;
const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+\.[\w.-]+$/u;

function isNonTranslatableText(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  if (SCRIPT_PATTERN.test(text)) return false;
  if (URL_PATTERN.test(text) || EMAIL_PATTERN.test(text)) return true;
  const letters = text.replace(/[^A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]/gu, "");
  if (!DIGIT_PATTERN.test(text)) {
    // 无数字：纯符号（含 emoji）与单个字母直通；其余（拉丁单词等）交给模型。
    const withoutSymbols = text.replace(/[\p{P}\p{S}\p{Zs}\p{C}]/gu, "");
    return !withoutSymbols || withoutSymbols.length <= 1;
  }
  // 含数字：一个字母都不剩的是纯数量（1,000、50%、12:34、2024.5.1）；不含空白且
  // 字母 ≤4 的是编码（R-18、Vol.3、ABC123）——翻译都是原样回声。带空格的
  // （Level 5、Chapter 12）保留给模型。
  return letters.length === 0 || !/\s/u.test(text) && letters.length <= 4;
}

export default Object.freeze({ isNonTranslatableText });
