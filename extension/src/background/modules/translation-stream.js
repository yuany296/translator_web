import { createNdjsonParser } from "../../shared/ndjson.js";
import thinkingMode from "../../shared/thinking-mode.js";

export const TRANSLATION_STREAM_PORT = "mt-translation-stream-v1";

/**
 * 流式链路的术语校验。
 *
 * 小批链路(novel-translation.js)会逐段核对术语、违反就带纠正意见重试,流式链路
 * 此前只把术语发进提示词就完事:模型漏用/自己发挥时事件照样落库、照样渲染,用户
 * 看到的就是「术语有时候不正确」—— 而且库里是不是全站生效完全不影响这一点。
 * 这里复用同一套校验(novelCore.validateTranslations,内部按 matchesSourceTerm
 * 判断该段是否真的命中术语),把漏用术语的段落挡在渲染之外:该事件不转发,内容侧
 * 于是仍视其为未翻译,随后由渐进小批链路按术语重译 —— 那条链路自带重试与
 * 「术语违规保留译文 + 警告」回落,不会把整段译文弄丢。
 */
export function buildStreamGlossaryGuard(runtime, glossary, languages = {}) {
  const entries = Array.isArray(glossary) ? glossary : [];
  if (!entries.length || typeof runtime.novelCore?.validateTranslations !== "function") return null;
  return (originalText, translatedText, terms = null) => {
    const checked = runtime.novelCore.validateTranslations(
      [{ id: "stream-guard", original_text: String(originalText || "") }],
      [{
        id: "stream-guard",
        translated_text: String(translatedText || ""),
        // 模型自己交代的术语账（used / skipped+理由）。没给就交给校验器退回字符串硬校验。
        ...(terms && typeof terms === "object" ? { terms } : {})
      }],
      entries,
      {
        sourceLanguage: String(languages.sourceLanguage || "auto"),
        targetLanguage: String(languages.targetLanguage || "zh-CN")
      }
    );
    // glossary_violation:命中却没用(或声称用了却没有) —— 确定性违规。
    // glossary_unaccounted:既没用也没交代 —— 静默漏用(用户说的「术语有时候不生效」)。
    // 两者都交给小批链路重译;模型写明「这次语境不是它」的条目在这里就已经被放行了。
    return (checked.errors || []).filter(error =>
      ["glossary_violation", "glossary_unaccounted"].includes(error.code));
  };
}

export function installTranslationStream(runtime) {
  async function openTranslationStream(request, signal) {
    const configuration = await runtime.loadConfiguration();
    const baseUrl = runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl);
    const sourceLanguage = String(request.sourceLanguage || configuration.translation.sourceLanguage || "auto");
    const targetLanguage = String(request.targetLanguage || configuration.translation.targetLanguage || "zh-CN");
    const glossaryContext = {
      scopeKey: String(request.scopeKey || ""),
      sourceLanguage,
      targetLanguage,
      pageUrl: String(request.pageUrl || "")
    };
    // note 是角色备注(性别/年龄/身份/语气),小批链路一直带着它;流式链路此前只发
    // source/target,于是同一批术语在两条链路上给出的效果并不一致。
    const glossary = runtime.glossaryCore.getRelevantEntries(
      configuration.glossary,
      (request.items || []).map(item => ({ original_text: item.originalText })),
      glossaryContext
    ).map(item => ({
      source: item.source,
      target: item.target,
      ...(item.note ? { note: item.note } : {})
    }));
    const body = {
      ...request, sourceLanguage, targetLanguage, glossary,
      upstream: {
        apiKey: configuration.translation.apiKey,
        baseUrl: configuration.translation.baseUrl,
        model: configuration.translation.model,
        // 思考字段在扩展侧就算好（shared/thinking-mode.js 是唯一定义处），本地服务只把它
        // 原样拼进上游请求体 —— 两边各维护一份「哪个服务商认哪个参数名」的映射迟早会漂。
        thinking: thinkingMode.thinkingBodyFields(
          configuration.translation.thinkingMode, configuration.translation.provider
        )
      }
    };
    const response = await fetch(`${baseUrl}/translations/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify(body), signal
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      throw new Error(String(payload?.detail || `流式接口 HTTP ${response.status}`));
    }
    if (!String(response.headers.get("content-type") || "").includes("application/x-ndjson")) {
      throw new Error("本地服务不支持 NDJSON 流式翻译");
    }
    return {
      body: response.body,
      glossary,
      guard: buildStreamGlossaryGuard(runtime, glossary, { sourceLanguage, targetLanguage })
    };
  }

  async function relayStream(port, request, controller) {
    const taskId = String(request.taskId || "");
    const parser = createNdjsonParser();
    const decoder = new TextDecoder();
    const seen = new Set();
    // 流式路径的提示词在本地服务侧（translation_stream.py），它只管逐段 JSON，
    // 不做任何格式兜底；模型把对话引号当格式丢掉时，事件里就是没引号的译文。
    // 这里按原文引号对做确定性修复，同时改写快照里的译文 —— 否则存进正式译文库的
    // 也是没引号的那一版（用户实测：`"난 무조건 탈색부터 한다."` -> `我不管，肯定要先漂发。`）。
    const originalByParagraph = new Map((request.items || []).map(item => [
      String(item && item.paragraphKey || ""),
      String(item && item.originalText || "")
    ]));
    const repairQuotes = event => {
      const original = originalByParagraph.get(String(event.paragraphKey || ""));
      if (!original) return;
      const current = String(event.translation || "");
      const repaired = runtime.restoreDialogueQuotes(original, current);
      if (repaired === current) return;
      event.translation = repaired;
      const active = event.record && event.record.activeVersion;
      if (active && typeof active === "object") active.translatedText = repaired;
    };
    // 译文里照抄了术语的原文拼写 = 这一段就是没翻:就地换成术语库里的译名（确定性修复，
    // 不打模型）。必须在校验之前做,否则韩文残留判定会先把整段丢掉再逐段重试。
    const repairTerms = event => {
      const original = originalByParagraph.get(String(event.paragraphKey || ""));
      if (!original || !Array.isArray(opened.glossary) || !opened.glossary.length) return;
      const repaired = runtime.novelCore.repairTermLeftovers?.(
        [{ id: "stream-repair", original_text: original }],
        [{ id: "stream-repair", translated_text: String(event.translation || "") }],
        opened.glossary
      );
      const text = String(repaired && repaired[0] && repaired[0].translated_text || "");
      if (!text || text === event.translation) return;
      event.translation = text;
      const active = event.record && event.record.activeVersion;
      if (active && typeof active === "object") active.translatedText = text;
    };
    const opened = await openTranslationStream(request, controller.signal);
    const reader = opened.body.getReader();
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
            repairQuotes(event);
            repairTerms(event);
            const original = originalByParagraph.get(String(event.paragraphKey || ""));
            const violations = opened.guard && original
              ? opened.guard(original, String(event.translation || ""), event.terms)
              : [];
            if (violations.length) {
              // 术语没照用:不转发、也不写进译文库缓存镜像,交给渐进小批链路
              // 按术语重译(它会重试,失败也只会保留译文并出警告)。
              port.postMessage({
                type: "glossary_rejected", taskId,
                paragraphKey: String(event.paragraphKey || ""),
                terms: violations.flatMap(violation => violation.terms || [])
              });
              continue;
            }
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
