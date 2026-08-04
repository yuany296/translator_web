import { createNdjsonParser } from "../../shared/ndjson.js";

export const TRANSLATION_STREAM_PORT = "mt-translation-stream-v1";

export function installTranslationStream(runtime) {
  async function openTranslationStream(request, signal) {
    const configuration = await runtime.loadConfiguration();
    const baseUrl = runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl);
    const sourceLanguage = String(request.sourceLanguage || configuration.translation.sourceLanguage || "auto");
    const targetLanguage = String(request.targetLanguage || configuration.translation.targetLanguage || "zh-CN");
    const glossaryContext = { scopeKey: String(request.scopeKey || ""), sourceLanguage, targetLanguage };
    const glossary = runtime.glossaryCore.getRelevantEntries(
      configuration.glossary,
      (request.items || []).map(item => ({ original_text: item.originalText })),
      glossaryContext
    ).map(item => ({ source: item.source, target: item.target }));
    const body = {
      ...request, sourceLanguage, targetLanguage, glossary,
      upstream: {
        apiKey: configuration.translation.apiKey,
        baseUrl: configuration.translation.baseUrl,
        model: configuration.translation.model
      }
    };
    const options = await runtime.withLocalServiceAuth({
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify(body), signal
    });
    const response = await fetch(`${baseUrl}/translations/stream`, options);
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      throw new Error(String(payload?.detail || `流式接口 HTTP ${response.status}`));
    }
    if (!String(response.headers.get("content-type") || "").includes("application/x-ndjson")) {
      throw new Error("本地服务不支持 NDJSON 流式翻译");
    }
    return response.body;
  }

  async function relayStream(port, request, controller) {
    const taskId = String(request.taskId || "");
    const parser = createNdjsonParser();
    const decoder = new TextDecoder();
    const seen = new Set();
    const body = await openTranslationStream(request, controller.signal);
    const reader = body.getReader();
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        const parsed = parser.feed(done ? decoder.decode() : decoder.decode(value, { stream: true }), done);
        parsed.errors.forEach(error => port.postMessage({
          type: "protocol_error", taskId, error
        }));
        for (const event of parsed.events) {
          if (String(event.taskId || "") !== taskId) continue;
          if (event.type === "paragraph") {
            const identity = `${taskId}:${String(event.paragraphKey || "")}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            if (event.record) await runtime.saveTranslationServiceSnapshots([event.record]);
          }
          port.postMessage(event);
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  function handleTranslationStreamPort(port) {
    if (port.name !== TRANSLATION_STREAM_PORT) return false;
    let controller = null;
    let started = false;
    port.onMessage.addListener(message => {
      if (message?.type === "cancel") {
        controller?.abort();
        return;
      }
      if (message?.type !== "start" || started) return;
      started = true;
      controller = new AbortController();
      relayStream(port, message.request || {}, controller).catch(error => {
        if (controller?.signal.aborted) return;
        port.postMessage({
          type: "stream_error", taskId: String(message.request?.taskId || ""),
          error: runtime.getErrorMessage(error)
        });
      });
    });
    port.onDisconnect.addListener(() => controller?.abort());
    return true;
  }

  runtime.handleTranslationStreamPort = handleTranslationStreamPort;
}
