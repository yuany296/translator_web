/**
 * 流式译文行的增量解析。
 *
 * 批量翻译把一整批文本交给模型，模型按
 * `{"translations":[{"id":"..","translated_text":".."}]}` 返回 JSON。非流式必须等整批
 * 生成完（慢模型 20~30s）才能显示第一个字；流式则可以在模型每写完一行时就先把那一行
 * 交给渲染层——用户看到的是「译文陆续出现」，而不是「等半天后一次出现」。
 *
 * 这里只做两件纯事（不碰 DOM、不碰网络，便于单测）：
 *   1. SSE 事件切分：把被网络分片切开的 `data: {...}` 行重新拼成完整负载；
 *   2. 从**尚未闭合**的 JSON 文本里安全地提取已经完整的译文行 —— 未闭合的那一行必须
 *      等下一段，绝不能猜（猜错会显示错误译文）。
 */

/**
 * 一行译文必须「成对出现且紧跟右花括号」才算完整：
 *   `...,"translated_text":"abc"}` —— 只写到 `"abc` 的残行不匹配，
 * 否则会把下一行的开头误当成本行译文。两种键序都接受。
 */
const ROW_PATTERN = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"translated_text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}|"translated_text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/gu;

/** 还原 JSON 字符串里的转义（\n、\" 等）；解析失败时退回原样。 */
export function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value);
  }
}

/**
 * 增量提取器：`push(累积文本)` 返回**这次新完整**的译文行，同一行只会返回一次。
 * 传入的必须是「从头到当前的完整累积文本」（不是增量片段）。
 */
export function createTranslationRowExtractor() {
  let cursor = 0;
  return {
    get cursor() {
      return cursor;
    },
    push(text) {
      const source = String(text || "");
      const rows = [];
      ROW_PATTERN.lastIndex = cursor;
      let match = ROW_PATTERN.exec(source);
      while (match) {
        const idFirst = match[1] !== undefined;
        rows.push({
          id: decodeJsonString(idFirst ? match[1] : match[4]),
          translated_text: decodeJsonString(idFirst ? match[2] : match[3])
        });
        cursor = match.index + match[0].length;
        ROW_PATTERN.lastIndex = cursor;
        match = ROW_PATTERN.exec(source);
      }
      return rows;
    }
  };
}

/** SSE 事件读取器：逐块喂入，返回这一块里完整的 `data:` 负载（不含前缀）。 */
export function createSseEventReader() {
  let buffer = "";
  return {
    push(chunkText) {
      buffer += String(chunkText || "");
      const payloads = [];
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/u, "");
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) payloads.push(payload);
        }
        index = buffer.indexOf("\n");
      }
      return payloads;
    }
  };
}

/** 取 OpenAI 兼容流式分片里的增量文本（delta.content，兼容 message.content）。 */
export function readOpenAiChunkText(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const part = choice && (choice.delta || choice.message) || null;
  const content = part && part.content;
  return typeof content === "string" ? content : "";
}

export default Object.freeze({
  decodeJsonString,
  createTranslationRowExtractor,
  createSseEventReader,
  readOpenAiChunkText
});
