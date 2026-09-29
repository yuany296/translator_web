import {
  createTranslationRowExtractor, createSseEventReader, readOpenAiChunkText
} from "../../shared/translation-row-stream.js";

const SNAPSHOT_TEXT_LIMIT = 6000;

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
 *
 * 每次调用都会把「原始 SSE 文本 / 累积文本 / 逐行提取 / 最终解析 / finish_reason」记进
 * 快照（`runtime.recordTranslationSnapshot`），供 `__mtTranslationSnapshots()` 与
 * `__mtStreamAb()` 取证——上一次截尾事故只能靠猜，这次要有原始数据。
 */
export function installTranslationProviderStream(runtime) {
  function createSnapshot(options) {
    let host = "";
    try {
      host = new URL(String(options.endpoint || "")).host;
    } catch {
      host = String(options.endpoint || "").slice(0, 80);
    }
    return {
      at: Date.now(),
      kind: "stream",
      endpointHost: host,
      model: String(options.body && options.body.model || ""),
      streamed: false,
      finishReason: "",
      rawLength: 0,
      textLength: 0,
      raw: "",
      text: "",
      partialRows: 0,
      returnedRows: 0,
      parsedOk: false,
      outcome: "unknown",
      error: "",
      durationMs: 0,
      startedAt: Date.now()
    };
  }

  function finalizeSnapshot(snapshot) {
    snapshot.durationMs = Date.now() - snapshot.startedAt;
    delete snapshot.startedAt;
    snapshot.rawLength = snapshot.raw.length;
    snapshot.textLength = snapshot.text.length;
    snapshot.raw = snapshot.raw.slice(-SNAPSHOT_TEXT_LIMIT);
    snapshot.text = snapshot.text.slice(-SNAPSHOT_TEXT_LIMIT);
    return snapshot;
  }

  async function streamCanonicalTranslationBatch(options = {}) {
    const snapshot = createSnapshot(options);
    try {
      return await runStream(options, snapshot);
    } catch (error) {
      snapshot.outcome = runtime.isAbortError(error) ? "aborted" : "error";
      snapshot.error = String(error && error.message || error).slice(0, 300);
      throw error;
    } finally {
      runtime.recordTranslationSnapshot?.(finalizeSnapshot(snapshot));
    }
  }

  async function runStream(options, snapshot) {
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
    const syncSnapshot = () => {
      snapshot.raw = raw;
      snapshot.text = text;
      snapshot.streamed = streamed;
      snapshot.partialRows = partialRows.length;
    };
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
        if (body.response_format && runtime.shouldRetryWithoutJsonResponseFormat(reason)) {
          snapshot.outcome = "fallback-response-format";
          return null;
        }
        snapshot.outcome = "http-error";
        snapshot.error = reason.slice(0, 300);
        throw new Error(reason);
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        snapshot.outcome = "fallback-no-body";
        return null;
      }
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
          const reason = readOpenAiFinishReason(parsed);
          if (reason) snapshot.finishReason = reason;
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
      syncSnapshot();
      // 用户/任务取消：原样抛出，让上层识别成 cancelled 而不是失败
      if (runtime.isAbortError(error) && !timedOut) {
        snapshot.outcome = "aborted";
        throw error;
      }
      if (partialRows.length) {
        snapshot.outcome = "partial-after-error";
        snapshot.error = String(error && error.message || error).slice(0, 300);
        snapshot.returnedRows = partialRows.length;
        return partialRows;
      }
      if (timedOut) {
        snapshot.outcome = "timeout";
        throw new Error(`Translation request timed out after ${totalMs}ms`);
      }
      if (raw.trim() || text) {
        snapshot.outcome = "fallback-broken-stream";
        return null;
      }
      snapshot.outcome = "error";
      snapshot.error = String(error && error.message || error).slice(0, 300);
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
    syncSnapshot();
    if (!streamed) {
      // 服务端忽略了 stream 并直接回了普通 JSON：就地解析，不再白发一次请求
      let payload = null;
      try {
        payload = raw.trim() ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      if (!payload) {
        snapshot.outcome = "fallback-not-json";
        return null;
      }
      text = runtime.extractOpenAIMessageText(payload);
      if (!text) {
        snapshot.outcome = "fallback-no-text";
        return null;
      }
      syncSnapshot();
    }
    try {
      const parsed = runtime.parseModelJson(String(text).trim());
      if (parsed && Array.isArray(parsed.translations)) {
        snapshot.parsedOk = true;
        snapshot.outcome = "parsed";
        snapshot.returnedRows = parsed.translations.length;
        return parsed.translations;
      }
    } catch {
      // 结尾 JSON 被截断：增量提取到的行仍然可用
    }
    syncSnapshot();
    snapshot.outcome = partialRows.length ? "partial-parse-failed" : "empty-parse";
    snapshot.returnedRows = partialRows.length;
    return partialRows.length ? partialRows : [];
  }
  runtime.streamCanonicalTranslationBatch = streamCanonicalTranslationBatch;

  /** 流式分片里的 finish_reason（`length` 是最重要的截尾信号）。 */
  function readOpenAiFinishReason(payload) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    return String(choice && choice.finish_reason || "").slice(0, 40);
  }
  runtime.readOpenAiFinishReason = readOpenAiFinishReason;
}
