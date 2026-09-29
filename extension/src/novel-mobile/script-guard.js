/**
 * 手机版：把「模型把简体中文写成繁体」这一段捞出来。
 *
 * 这是模型侧的漂移（韩文小说 → 中文时尤其常见：它会把「时候/这个/为」写成「時候/這個/為」），
 * 提示词层面已经收紧（见 translation-guard-local.js 给每个请求补的目标语言说明），
 * 但提示词只是概率约束，所以再加一道可验证的兜底：这里只负责**认出来**，
 * 由 novel-batch.js 的定点修正流程拿它去重问一次那几段。
 *
 * 字符集本身不在这里：`繁体专用字` 的唯一定义在 shared/traditional-chinese.js
 * （`shared/languages.js` 的 zh-CN / zh-TW 判定用的是同一份，两处不会再给出不同答案）。
 */
import { findTraditionalChars } from "../shared/traditional-chinese.js";

export { findTraditionalChars };

/** 定点修正时用的指令；没有繁体字就返回空串（调用方据此判断这一段要不要修）。 */
export function describeScriptFix(text) {
  const examples = findTraditionalChars(text).slice(0, 4);
  if (!examples.length) return "";
  return `本段必须全部改用简体中文，不要出现任何繁体字（例如「${examples.join("」「")}」）；只改字形，其它内容一字不动`;
}
