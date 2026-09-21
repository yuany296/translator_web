import {
  createTranslationRowExtractor, createSseEventReader, readOpenAiChunkText
} from "../../shared/translation-row-stream.js";

/**
 * OpenAI 兼容端点的**流式**批量译文请求。
 *
 * 返回：
 *   - 译文行数组（含只拿到一部分的情况）→ 上层按正常结果处理；
 *   - `null` → 「这条路走不通，请回退到非流式」（服务端忽略 stream 且响应体读不出、
 *      或 4xx 属于 `response_format` 兼容问题）；
 *   - 抛错 → 真正的失败（Key/额度/网络），交给上层报错。
 *
 * 中途断流但已经提取到行时返回已拿到的行：部分译文比整批失败有用得多，缺的项由
 * 上层的逐项补翻兜底。最终结果仍会覆盖一次，所以这里提前渲染的内容不会被留下错的。
 */
export function installTranslationProviderStream(runtime) {
  async function streamCanonicalTranslationBatch(options = {}) {
    const {
      endpoint, apiKey, body, signal = null, onRow = null, timeoutMs = 0
    } = options;
    const totalMs = Math.max(1000, Number(timeoutMs) || runtime.TRANSLATION_REQUEST_TIMEOUT_MS);
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, totalMs);
    const extractor = createTranslationRowExtractor();
    let text = "";
    let raw = "";
    let streamed = false;
    const partialRows = [];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const reason = runtime.getErrorMessage(runtime.toProviderError(
          payload, response.status, response.statusText, "OpenAI-compatible translation API error"
        ));
        if (body.response_format && runtime.shouldRetryWithoutJsonResponseFormat(reason)) return null;
        throw new Error(reason);
      }
      if (!response.body || typeof response.body.getReader !== "function") return null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sse = createSseEventReader();
      for (;;) {
        const { done, value } = await reader.read();
        const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (chunk) raw += chunk;
        for (const payload of sse.push(chunk)) {
          if (payload === "[DONE]") continue;
          let parsed = null;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = readOpenAiChunkText(parsed);
          if (!delta) continue;
          text += delta;
          streamed = true;
          const rows = extractor.push(text);
          if (rows.length) {
            partialRows.push(...rows);
            if (typeof onRow === "function") onRow(rows);
          }
        }
        if (done) break;
      }
    } catch (error) {
      // 用户/任务取消：原样抛出，让上层识别成 cancelled 而不是失败
      if (runtime.isAbortError(error) && !timedOut) throw error;
      if (partialRows.length) return partialRows;
      if (timedOut) throw new Error(`Translation request timed out after ${totalMs}ms`);
      if (raw.trim() || text) return null;
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
    if (!streamed) {
      // 服务端忽略了 stream 并直接回了普通 JSON：就地解析，不再白发一次请求
      let payload = null;
      try {
        payload = raw.trim() ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      if (!payload) return null;
      text = runtime.extractOpenAIMessageText(payload);
      if (!text) return null;
    }
    try {
      const parsed = runtime.parseModelJson(String(text).trim());
      if (parsed && Array.isArray(parsed.translations)) return parsed.translations;
    } catch {
      // 结尾 JSON 被截断：增量提取到的行仍然可用
    }
    return partialRows.length ? partialRows : [];
  }
  runtime.streamCanonicalTranslationBatch = streamCanonicalTranslationBatch;
}
